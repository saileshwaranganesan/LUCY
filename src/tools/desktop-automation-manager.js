'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureWorkerBuilt, exeFile, resolveExeFile } = require('./native-uia/build-worker.js');
const { AUTOMATION_TIERS, INTERACTION_MODES, getActionCapability } = require('./automation-tier-policy.js');

/**
 * Standard safe executable allowlist for desktop automation.
 * Applications on this list are considered standard safe utilities for user interaction.
 */
const SAFE_APP_ALLOWLIST = Object.freeze([
    // Core built-in utilities
    'notepad',
    'notepad.exe',
    'calc',
    'calc.exe',
    'calculator',
    'calculator.exe',
    'mspaint',
    'mspaint.exe',
    'write',
    'write.exe',
    'wordpad',
    'wordpad.exe',
    'explorer',
    'explorer.exe',
    // Browsers
    'chrome',
    'chrome.exe',
    'msedge',
    'msedge.exe',
    'firefox',
    'firefox.exe',
    'brave',
    'brave.exe',
    // Developer & Shell tools
    'code',
    'code.exe',
    'wt',
    'wt.exe',
    'windowsterminal',
    'windowsterminal.exe',
    'powershell',
    'powershell.exe',
    'cmd',
    'cmd.exe',
    // System Utilities & Productivity
    'taskmgr',
    'taskmgr.exe',
    'snippingtool',
    'snippingtool.exe',
    'vlc',
    'vlc.exe',
    'spotify',
    'spotify.exe'
]);

/**
 * Administrative, elevation, or destructive system executables strictly blocked from execution.
 */
const DANGEROUS_BLOCKED_BINARIES = Object.freeze([
    'regedit.exe',
    'reg.exe',
    'format.com',
    'diskpart.exe',
    'bcdedit.exe',
    'vssadmin.exe',
    'icacls.exe',
    'takeown.exe',
    'net.exe',
    'net1.exe',
    'secpol.msc',
    'gpedit.msc',
    'rundll32.exe',
    'mshta.exe',
    'wscript.exe',
    'cscript.exe',
    'certutil.exe',
    'bitsadmin.exe'
]);

/**
 * Trusted application identifier resolution mappings.
 * Maps friendly names and aliases to explicit, trusted executable binaries.
 */
const TRUSTED_APPLICATION_MAPPINGS = Object.freeze({
    'notepad': 'notepad.exe',
    'notepad.exe': 'notepad.exe',
    'text editor': 'notepad.exe',
    'calc': 'calc.exe',
    'calc.exe': 'calc.exe',
    'calculator': 'calc.exe',
    'calculator.exe': 'calc.exe',
    'mspaint': 'mspaint.exe',
    'mspaint.exe': 'mspaint.exe',
    'paint': 'mspaint.exe',
    'explorer': 'explorer.exe',
    'explorer.exe': 'explorer.exe',
    'file explorer': 'explorer.exe',
    'chrome': 'chrome.exe',
    'chrome.exe': 'chrome.exe',
    'google chrome': 'chrome.exe',
    'msedge': 'msedge.exe',
    'msedge.exe': 'msedge.exe',
    'edge': 'msedge.exe',
    'microsoft edge': 'msedge.exe',
    'firefox': 'firefox.exe',
    'firefox.exe': 'firefox.exe',
    'brave': 'brave.exe',
    'brave.exe': 'brave.exe',
    'code': 'code.exe',
    'code.exe': 'code.exe',
    'vs code': 'code.exe',
    'vscode': 'code.exe',
    'wt': 'wt.exe',
    'wt.exe': 'wt.exe',
    'terminal': 'wt.exe',
    'windows terminal': 'wt.exe',
    'taskmgr': 'taskmgr.exe',
    'taskmgr.exe': 'taskmgr.exe',
    'task manager': 'taskmgr.exe',
    'snippingtool': 'snippingtool.exe',
    'snippingtool.exe': 'snippingtool.exe',
    'snipping tool': 'snippingtool.exe',
    'vlc': 'vlc.exe',
    'vlc.exe': 'vlc.exe',
    'spotify': 'spotify.exe',
    'spotify.exe': 'spotify.exe',
    'powershell': 'powershell.exe',
    'powershell.exe': 'powershell.exe',
    'cmd': 'cmd.exe',
    'cmd.exe': 'cmd.exe'
});

/**
 * DesktopAutomationManager
 * Manages native Windows UI Automation through LucyUiaWorker.
 * Provides accessible element inspection, text entry, button clicks, and outcome verification.
 */
class DesktopAutomationManager {
    constructor(options = {}) {
        this.workerExe = options.workerExe || (resolveExeFile ? resolveExeFile() : exeFile);
        this.timeoutMs = options.timeoutMs || 25000;
        this.proc = null;
        this.nextId = 1;
        this.pendingRequests = new Map();
        this.buffer = '';
        this.isReady = false;
        this.readyPromise = null;
        this.trackedApps = new Map(); // appId -> { pid, exe, windowTitle, launchedAt }
        this.isDestroyed = false;
        this.interactionMode = options.interactionMode || INTERACTION_MODES.NON_INTRUSIVE;
    }

    setInteractionMode(mode) {
        if (Object.values(INTERACTION_MODES).includes(mode)) {
            this.interactionMode = mode;
        }
    }

    getInteractionMode() {
        return this.interactionMode;
    }

    /**
     * Ensure the worker process is running and connected.
     */
    async ensureWorker() {
        if (this.isDestroyed) {
            throw new Error('DesktopAutomationManager has been destroyed');
        }

        if (this.proc && this.isReady) {
            return;
        }

        if (this.readyPromise) {
            return await this.readyPromise;
        }

        // Ensure worker binary exists
        if (!fs.existsSync(this.workerExe)) {
            this.workerExe = resolveExeFile ? resolveExeFile() : this.workerExe;
            if (!fs.existsSync(this.workerExe)) {
                ensureWorkerBuilt();
            }
        }

        this.readyPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timed out waiting for LucyUiaWorker initialization (${this.timeoutMs}ms)`));
            }, this.timeoutMs);

            try {
                this.proc = spawn(this.workerExe, [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });

                this.proc.stdout.on('data', (chunk) => {
                    this._handleStdout(chunk, resolve, timer);
                });

                this.proc.stderr.on('data', (chunk) => {
                    // Stderr for diagnostics
                    const text = chunk.toString('utf8').trim();
                    if (text) {
                        // worker diagnostic output
                    }
                });

                this.proc.on('close', (code) => {
                    this.isReady = false;
                    this.readyPromise = null;
                    this.proc = null;
                    // Reject any pending requests
                    for (const [id, req] of this.pendingRequests.entries()) {
                        req.reject(new Error(`LucyUiaWorker process closed with code ${code}`));
                    }
                    this.pendingRequests.clear();
                });

                this.proc.on('error', (err) => {
                    clearTimeout(timer);
                    this.isReady = false;
                    this.readyPromise = null;
                    reject(err);
                });
            } catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        });

        return await this.readyPromise;
    }

    _handleStdout(chunk, readyResolve, readyTimer) {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // keep trailing partial

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                const msg = JSON.parse(trimmed);

                // Initial handshake
                if (msg.status === 'ready' && !this.isReady) {
                    this.isReady = true;
                    if (readyTimer) clearTimeout(readyTimer);
                    if (readyResolve) readyResolve(msg);
                    continue;
                }

                // Response matching
                if (typeof msg.id !== 'undefined' && this.pendingRequests.has(msg.id)) {
                    const req = this.pendingRequests.get(msg.id);
                    this.pendingRequests.delete(msg.id);
                    clearTimeout(req.timer);

                    if (msg.ok) {
                        req.resolve(msg.result);
                    } else {
                        req.reject(new Error(msg.error || 'Desktop worker operation failed'));
                    }
                }
            } catch (err) {
                // Non-JSON line ignored
            }
        }
    }

    /**
     * Send a low-level command to the native worker.
     */
    async sendCommand(cmd, payload = {}) {
        await this.ensureWorker();

        const id = this.nextId++;
        const message = { id, cmd, ...payload };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Command '${cmd}' timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timer });

            try {
                this.proc.stdin.write(JSON.stringify(message) + '\n');
            } catch (err) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(err);
            }
        });
    }

    /**
     * Discover and list running applications with interactive top-level windows.
     */
    async listApps() {
        const apps = await this.sendCommand('list_apps');
        return Array.isArray(apps) ? apps : [];
    }

    /**
     * Validate an executable target against safe allowlist or boundary.
     * @param {string} exeTarget - Application identifier or path
     * @returns {{ safe: boolean, isAllowlisted: boolean, resolvedPath: string }}
     */
    validateExecutable(exeTarget) {
        if (!exeTarget || typeof exeTarget !== 'string' || !exeTarget.trim()) {
            const err = new Error('Executable path cannot be empty (must be a valid non-empty string).');
            err.code = 'INVALID_REQUEST';
            throw err;
        }

        const trimmed = exeTarget.trim();

        // Reject null bytes, control characters, command chaining, or shell redirection
        if (/[\r\n\0;&|`$<>]/.test(trimmed)) {
            const err = new Error('Malicious characters or command chaining detected in executable target.');
            err.code = 'INVALID_ARGUMENTS';
            throw err;
        }

        const normalized = path.normalize(trimmed);
        const baseName = path.basename(normalized).toLowerCase();

        // 1. Reject explicitly blocked administrative, elevation, or destructive system binaries
        if (DANGEROUS_BLOCKED_BINARIES.includes(baseName)) {
            const err = new Error(`Execution of administrative/elevation binary '${baseName}' is strictly prohibited.`);
            err.code = 'APP_NOT_ALLOWLISTED';
            throw err;
        }

        // 2. Resolve via trusted application mappings
        const lookup = trimmed.toLowerCase();
        const resolvedFromMapping = TRUSTED_APPLICATION_MAPPINGS[lookup] || TRUSTED_APPLICATION_MAPPINGS[baseName];
        if (resolvedFromMapping) {
            return {
                safe: true,
                isAllowlisted: true,
                resolvedPath: resolvedFromMapping
            };
        }

        // 3. Check curated safe allowlist
        if (SAFE_APP_ALLOWLIST.includes(baseName) || SAFE_APP_ALLOWLIST.includes(lookup)) {
            return {
                safe: true,
                isAllowlisted: true,
                resolvedPath: trimmed.includes('\\') || trimmed.includes('/') ? normalized : baseName
            };
        }

        // 4. Custom absolute path validation (must exist on disk and possess an allowed executable extension)
        if (path.isAbsolute(normalized)) {
            if (!fs.existsSync(normalized)) {
                const err = new Error(`Executable file '${normalized}' does not exist on disk.`);
                err.code = 'EXECUTABLE_UNAVAILABLE';
                throw err;
            }
            const ext = path.extname(normalized).toLowerCase();
            if (!['.exe', '.cmd', '.bat'].includes(ext)) {
                const err = new Error(`File '${baseName}' is not a valid executable binary (unsupported extension: ${ext}).`);
                err.code = 'INVALID_REQUEST';
                throw err;
            }
            return {
                safe: true,
                isAllowlisted: false,
                resolvedPath: normalized
            };
        }

        const err = new Error(`Executable '${exeTarget}' is not in the curated allowlist and is neither in the safe allowlist nor an existing absolute executable path.`);
        err.code = 'APP_NOT_ALLOWLISTED';
        throw err;
    }

    /**
     * Validate command-line arguments to prevent shell injection, command chaining, or arbitrary execution.
     * @param {string} exeTarget - Resolved executable binary path
     * @param {string|Array<string>} rawArgs - Command line arguments
     * @returns {string} Safe formatted argument string
     */
    validateArguments(exeTarget, rawArgs = '') {
        if (rawArgs === undefined || rawArgs === null || rawArgs === '') {
            return '';
        }

        if (typeof rawArgs !== 'string' && !Array.isArray(rawArgs)) {
            const err = new Error('Invalid application arguments: arguments must be a string or array of strings.');
            err.code = 'INVALID_ARGUMENTS';
            throw err;
        }

        let argList = [];
        if (Array.isArray(rawArgs)) {
            for (const a of rawArgs) {
                if (typeof a !== 'string') {
                    const err = new Error('Invalid application argument: each argument in array must be a string.');
                    err.code = 'INVALID_ARGUMENTS';
                    throw err;
                }
                argList.push(a);
            }
        } else {
            const trimmedArgs = rawArgs.trim();
            if (!trimmedArgs) return '';
            argList = [trimmedArgs];
        }

        const safeFormatted = [];
        for (const arg of argList) {
            // Reject null bytes, control characters, or command injection metacharacters
            if (/[\r\n\0;&|`$<>]/.test(arg)) {
                const err = new Error('Shell-command injection characters detected in application arguments.');
                err.code = 'INVALID_ARGUMENTS';
                throw err;
            }

            // For shell binaries (cmd.exe, powershell.exe), strictly reject switches that execute arbitrary commands
            const exeBase = path.basename(String(exeTarget || '')).toLowerCase();
            if (['cmd.exe', 'cmd', 'powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'].includes(exeBase)) {
                const lowerArg = arg.toLowerCase().trim();
                const forbiddenShellSwitches = [
                    '/c', '/k', '/r',
                    '-c', '-command',
                    '-e', '-enc', '-encodedcommand',
                    '-file',
                    '-executionpolicy'
                ];
                for (const sw of forbiddenShellSwitches) {
                    if (lowerArg === sw || lowerArg.startsWith(sw + ' ') || lowerArg.startsWith(sw + ':')) {
                        const err = new Error('Arbitrary shell command execution via shell switches is strictly prohibited.');
                        err.code = 'INVALID_ARGUMENTS';
                        throw err;
                    }
                }
            }

            // Format argument safely (wrap with quotes if it contains spaces and is not already quoted)
            if (arg.includes(' ') && !arg.startsWith('"')) {
                safeFormatted.push(`"${arg.replace(/"/g, '\\"')}"`);
            } else {
                safeFormatted.push(arg);
            }
        }

        return safeFormatted.join(' ');
    }

    /**
     * Look up an explicitly tracked application by target specifier (appId, PID, window handle, or unique name).
     * @param {string|number|Object} target
     * @returns {Object|null|{ambiguous: boolean, matches: Array}}
     */
    getTrackedApp(target) {
        if (!target) return null;

        // Direct appId match in Map
        if (typeof target === 'string' && this.trackedApps.has(target)) {
            const app = this.trackedApps.get(target);
            return app.lifecycleState === 'active' ? app : null;
        }

        // Numeric PID match
        if (typeof target === 'number') {
            for (const app of this.trackedApps.values()) {
                if (app.pid === target && app.lifecycleState === 'active') {
                    return app;
                }
            }
            return null;
        }

        // Object target with appId, pid, or windowHandle
        if (typeof target === 'object') {
            if (target.appId && this.trackedApps.has(target.appId)) {
                const app = this.trackedApps.get(target.appId);
                return app.lifecycleState === 'active' ? app : null;
            }
            if (target.pid) {
                for (const app of this.trackedApps.values()) {
                    if (app.pid === target.pid && app.lifecycleState === 'active') {
                        return app;
                    }
                }
            }
            if (target.windowHandle) {
                for (const app of this.trackedApps.values()) {
                    if (app.windowHandle === target.windowHandle && app.lifecycleState === 'active') {
                        return app;
                    }
                }
            }
            return null;
        }

        // String name, executable, or window title match
        if (typeof target === 'string') {
            const clean = target.toLowerCase().trim();
            const matching = [];
            for (const app of this.trackedApps.values()) {
                if (app.lifecycleState !== 'active') continue;
                const exeBase = path.basename(app.exe || '').toLowerCase();
                const title = (app.windowTitle || '').toLowerCase();
                if (app.appId.toLowerCase() === clean ||
                    exeBase.replace(/\.exe$/, '') === clean.replace(/\.exe$/, '') ||
                    exeBase === clean ||
                    title.includes(clean)) {
                    matching.push(app);
                }
            }
            if (matching.length === 1) {
                return matching[0];
            }
            if (matching.length > 1) {
                return { ambiguous: true, matches: matching };
            }
        }

        return null;
    }

    /**
     * Determine if an application was launched by Lucy and is owned by the current task/session.
     * @param {string|number|Object} target
     * @param {string} [taskId]
     * @returns {boolean}
     */
    isOwnedByLucy(target, taskId = null) {
        const app = this.getTrackedApp(target);
        if (!app || app.ambiguous || !app.launchedByLucy || app.lifecycleState !== 'active') {
            return false;
        }
        if (taskId && app.taskId && app.taskId !== taskId) {
            return false;
        }
        return true;
    }

    /**
     * Assert that Lucy owns the specified application before authorizing destructive or state-modifying actions.
     * @param {string|number|Object} target
     * @param {Object} [options]
     * @param {string} [options.taskId]
     * @param {string} [options.action]
     * @returns {Object} Verified tracked application record
     */
    assertOwnership(target, options = {}) {
        const app = this.getTrackedApp(target);
        if (app && app.ambiguous) {
            const err = new Error(`Ambiguous application target '${JSON.stringify(target)}': Multiple active instances match. Specify exact appId or PID.`);
            err.code = 'AMBIGUOUS_APPLICATION_OWNERSHIP';
            throw err;
        }
        if (!app || !app.launchedByLucy || app.lifecycleState !== 'active') {
            const err = new Error(`Application ownership verification failed: Lucy did not launch '${JSON.stringify(target)}'. Cannot perform destructive or state-modifying action on unowned user application.`);
            err.code = 'UNAUTHORIZED_RESOURCE_ACCESS';
            throw err;
        }
        if (options.taskId && app.taskId && app.taskId !== options.taskId) {
            const err = new Error(`Task isolation violation: Application '${app.appId}' belongs to task '${app.taskId}', not current task '${options.taskId}'.`);
            err.code = 'TASK_BOUNDARY_VIOLATION';
            throw err;
        }
        return app;
    }

    /**
     * Launch an authorized Windows application with strict validation and outcome verification.
     * @param {string} exeTarget - Application identifier or executable path
     * @param {string|Array<string>} rawArgs - Optional application arguments
     * @param {Object} [options]
     * @param {string} [options.taskId] - Task or execution ID owning this application
     * @param {AbortSignal} [options.signal] - Optional cancellation signal
     * @returns {Promise<Object>} Process and window launch result
     */
    async launchApp(exeTarget, rawArgs = '', options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Application launch cancelled before process creation.');
            err.code = 'CANCELLED';
            throw err;
        }

        const validation = this.validateExecutable(exeTarget);
        const validatedArgs = this.validateArguments(validation.resolvedPath, rawArgs);

        let result;
        try {
            result = await this.sendCommand('launch_app', {
                exe: validation.resolvedPath,
                args: validatedArgs
            });
        } catch (err) {
            const isUnavailable = err.message.includes('Win32 Error 2') ||
                                  err.message.toLowerCase().includes('not found') ||
                                  err.message.toLowerCase().includes('cannot find');
            const launchErr = new Error(`Failed to launch application '${exeTarget}': ${err.message}`);
            launchErr.code = isUnavailable ? 'EXECUTABLE_UNAVAILABLE' : 'LAUNCH_FAILED';
            throw launchErr;
        }

        if (!result || !result.appId) {
            const launchErr = new Error(`Failed to launch application '${exeTarget}': Process did not initialize or window was not detected.`);
            launchErr.code = 'LAUNCH_FAILED';
            throw launchErr;
        }

        const trackedRecord = {
            resourceId: `res_${result.pid}_${Date.now()}`,
            appId: result.appId,
            pid: result.pid,
            processStartTime: result.processStartTime || null,
            windowHandle: result.windowHandle || 0,
            exe: validation.resolvedPath,
            windowTitle: result.windowTitle || '',
            launchedByLucy: true,
            ownershipState: 'OWNED',
            taskId: options.taskId || null,
            canCleanup: true,
            launchedAt: new Date().toISOString(),
            lifecycleState: 'active'
        };

        this.trackedApps.set(result.appId, trackedRecord);

        return {
            ok: true,
            status: 'launched',
            appId: result.appId,
            pid: result.pid,
            exe: validation.resolvedPath,
            windowTitle: result.windowTitle || '',
            windowHandle: result.windowHandle || 0,
            processStartTime: result.processStartTime || null,
            taskId: trackedRecord.taskId,
            ownership: 'OWNED',
            verification: {
                verified: true,
                method: 'process_and_window_verification'
            }
        };
    }

    /**
     * Bring an existing application window into focus and restore it to foreground.
     */
    async focusWindow(target, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Window focus operation cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }
        const payload = this._resolveTargetPayload(target);
        return await this.sendCommand('focus_window', payload);
    }

    /**
     * Inspect the UI Automation accessibility tree of an application.
     */
    async inspectUI(target, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('UI inspection cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }
        const payload = this._resolveTargetPayload(target);
        payload.maxDepth = options.maxDepth || 3;

        return await this.sendCommand('inspect_ui', payload);
    }

    /**
     * Find a specific UI control by accessible name, automationId, or controlType.
     */
    async findElement(target, query = {}, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Element search cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }
        const payload = this._resolveTargetPayload(target);
        if (query.name) payload.name = query.name;
        if (query.automationId) payload.automationId = query.automationId;
        if (query.controlType) payload.controlType = query.controlType;

        return await this.sendCommand('find_element', payload);
    }

    /**
     * Type text into an editable Document or Edit control, verifying result and preventing focus hijacking.
     */
    async typeText(target, text, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Text input cancelled before execution.');
            err.code = 'CANCELLED';
            throw err;
        }

        if (typeof text !== 'string') {
            throw new Error('Text parameter must be a string');
        }

        const payload = this._resolveTargetPayload(target);
        payload.text = text;
        payload.preferBackground = options.preferBackground !== false;
        payload.allowPhysicalFallback = options.allowPhysicalFallback !== undefined
            ? Boolean(options.allowPhysicalFallback)
            : (this.interactionMode === INTERACTION_MODES.FOREGROUND_REQUIRED);

        try {
            const result = await this.sendCommand('type_text', payload);
            return {
                success: Boolean(result && result.verified),
                verified: Boolean(result && result.verified),
                readText: result?.readText || '',
                controlName: result?.controlName || '',
                controlType: result?.controlType || '',
                method: result?.method || 'ValuePattern',
                tier: result?.tier || 3,
                tierName: result?.tierName || (result?.tier === 4 ? 'Tier 4 — Physical mouse/keyboard fallback' : 'Tier 3 — Windows UI Automation'),
                physicalInputUsed: Boolean(result?.physicalInputUsed),
                background: Boolean(result?.background)
            };
        } catch (err) {
            if (err.message && err.message.includes('FOCUS_VERIFICATION_FAILED')) {
                return {
                    success: false,
                    verified: false,
                    error: err.message,
                    reason: 'TARGET_FOCUS_LOST',
                    tier: 4,
                    tierName: 'Tier 4 — Physical mouse/keyboard fallback',
                    physicalInputUsed: false
                };
            }
            if (err.message && err.message.includes('TIER3_UIA_UNSUPPORTED')) {
                return {
                    success: false,
                    verified: false,
                    error: err.message,
                    reason: 'TIER3_UIA_UNSUPPORTED',
                    tier: 3,
                    tierName: 'Tier 3 — Windows UI Automation',
                    physicalInputUsed: false
                };
            }
            throw err;
        }
    }

    /**
     * Click or invoke an accessible UI control.
     */
    async clickElement(target, query = {}, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Element click cancelled before execution.');
            err.code = 'CANCELLED';
            throw err;
        }

        const payload = this._resolveTargetPayload(target);
        if (query.name) payload.name = query.name;
        if (query.automationId) payload.automationId = query.automationId;
        payload.allowPhysicalFallback = (options.allowPhysicalFallback !== undefined)
            ? Boolean(options.allowPhysicalFallback)
            : (query.allowPhysicalFallback !== undefined
                ? Boolean(query.allowPhysicalFallback)
                : (this.interactionMode === INTERACTION_MODES.FOREGROUND_REQUIRED));

        try {
            const result = await this.sendCommand('click_element', payload);
            return {
                success: Boolean(result && result.verified),
                verified: Boolean(result && result.verified),
                action: result?.action || 'invoked',
                name: result?.name || '',
                controlType: result?.controlType || '',
                tier: result?.tier || 3,
                tierName: result?.tierName || (result?.tier === 4 ? 'Tier 4 — Physical mouse/keyboard fallback' : 'Tier 3 — Windows UI Automation'),
                physicalInputUsed: Boolean(result?.physicalInputUsed),
                method: result?.method || 'InvokePattern'
            };
        } catch (err) {
            if (err.message && err.message.includes('TIER3_UIA_UNSUPPORTED')) {
                return {
                    success: false,
                    verified: false,
                    error: err.message,
                    reason: 'TIER3_UIA_UNSUPPORTED',
                    tier: 3,
                    tierName: 'Tier 3 — Windows UI Automation',
                    physicalInputUsed: false
                };
            }
            throw err;
        }
    }

    /**
     * Take a screenshot of the target application window.
     */
    async takeScreenshot(target, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Screenshot cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }
        const payload = this._resolveTargetPayload(target);
        return await this.sendCommand('take_screenshot', payload);
    }

    /**
     * Gracefully close a target application with explicit ownership verification and modal save dialog resolution.
     * @param {string|number|Object} target - App identifier, PID, or title
     * @param {Object} [options]
     * @param {'dont_save'|'save'|'cancel'|'ask'} [options.savePolicy] - Policy for handling unsaved confirmation dialogs
     * @param {string} [options.taskId] - Task ID authorizing close
     * @param {AbortSignal} [options.signal] - Cancellation signal
     */
    async closeApp(target, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Application close operation cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }

        const isDiscarding = options.savePolicy === 'dont_save' || options.dialogAction === 'dont_save' || options.force === true;

        if (isDiscarding) {
            // STRICT SAFETY: Discarding unsaved changes is ONLY allowed on Lucy-owned applications!
            this.assertOwnership(target, { taskId: options.taskId, action: 'close_app_discard' });
        }

        const payload = this._resolveTargetPayload(target, { requireOwnership: isDiscarding });
        if (options.savePolicy) {
            payload.savePolicy = options.savePolicy;
        } else if (options.dialogAction) {
            payload.savePolicy = options.dialogAction;
        }

        const result = await this.sendCommand('close_app', payload);

        if (result && result.closed) {
            const tracked = this.getTrackedApp(target);
            if (tracked && tracked.appId) {
                tracked.lifecycleState = 'closed';
                this.trackedApps.delete(tracked.appId);
            }
        }

        return result;
    }

    /**
     * Detect if a modal confirmation dialog is currently active for an application.
     */
    async detectDialog(target, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Dialog detection cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }
        const payload = this._resolveTargetPayload(target);
        return await this.sendCommand('detect_dialog', payload);
    }

    /**
     * Handle an active modal dialog by invoking the specified action with ownership verification.
     * @param {string|number|Object} target
     * @param {'save'|'dont_save'|'cancel'} action
     * @param {Object} [options]
     */
    async handleDialog(target, action, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Dialog handling cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }

        if (!action || !['save', 'dont_save', 'cancel'].includes(action.toLowerCase())) {
            throw new Error(`Invalid dialog action: '${action}'. Must be one of: save, dont_save, cancel`);
        }

        const lowerAction = action.toLowerCase();
        if (lowerAction === 'dont_save') {
            // Require Lucy ownership before discarding dialog changes
            this.assertOwnership(target, { taskId: options.taskId, action: 'dialog_discard' });
        }

        const payload = this._resolveTargetPayload(target, { requireOwnership: lowerAction === 'dont_save' });
        payload.action = lowerAction;

        const result = await this.sendCommand('handle_dialog', payload);
        if (result && result.processExited) {
            const tracked = this.getTrackedApp(target);
            if (tracked && tracked.appId) {
                tracked.lifecycleState = 'closed';
                this.trackedApps.delete(tracked.appId);
            }
        }
        return result;
    }

    /**
     * Close the currently active tab in an application (via Ctrl+W shortcut).
     */
    async closeTab(target, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Close tab cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }
        const payload = this._resolveTargetPayload(target);
        return await this.sendCommand('close_tab', payload);
    }

    /**
     * Safely terminate or close only applications launched for a specific task.
     * Leaves user applications and other tasks untouched.
     * @param {string} taskId
     * @returns {Promise<Array>} Array of cleanup results
     */
    async cleanupTaskResources(taskId) {
        if (!taskId) return [];
        const results = [];
        for (const [appId, app] of this.trackedApps.entries()) {
            if (app.taskId === taskId && app.lifecycleState === 'active') {
                try {
                    const res = await this.closeApp(appId, { savePolicy: 'dont_save', taskId });
                    results.push({ appId, pid: app.pid, closed: true, res });
                } catch (err) {
                    results.push({ appId, pid: app.pid, closed: false, error: err.message });
                }
            }
        }
        return results;
    }

    /**
     * Clean up and destroy the manager.
     */
    cleanup() {
        this.isDestroyed = true;
        this.isReady = false;
        if (this.proc) {
            try {
                this.proc.stdin.write(JSON.stringify({ id: 9999, cmd: 'exit' }) + '\n');
            } catch (_) {}
            const procToKill = this.proc;
            this.proc = null;
            setTimeout(() => {
                if (procToKill && !procToKill.killed) {
                    try { procToKill.kill(); } catch (_) {}
                }
            }, 300);
        }
    }

    _resolveTargetPayload(target, options = {}) {
        if (!target) {
            throw new Error('A target appId, processId, or window title must be specified');
        }

        const tracked = this.getTrackedApp(target);
        if (tracked && tracked.ambiguous) {
            const err = new Error(`Ambiguous application target '${JSON.stringify(target)}': Multiple tracked instances match.`);
            err.code = 'AMBIGUOUS_APPLICATION_OWNERSHIP';
            throw err;
        }

        if (options.requireOwnership && !tracked) {
            const err = new Error(`Ownership verification failed: Target '${JSON.stringify(target)}' is not owned by Lucy.`);
            err.code = 'UNAUTHORIZED_RESOURCE_ACCESS';
            throw err;
        }

        if (tracked) {
            const out = {
                appId: tracked.appId,
                pid: tracked.pid,
                expectedStartTime: tracked.processStartTime || null
            };
            if (tracked.windowHandle) {
                out.windowHandle = tracked.windowHandle;
            }
            if (typeof target === 'string' && !target.startsWith('app_')) {
                out.title = target;
            }
            return out;
        }

        if (typeof target === 'number') {
            return { pid: target };
        }

        if (typeof target === 'string') {
            if (target.startsWith('app_')) {
                let pidVal = 0;
                try { pidVal = parseInt(target.replace('app_', ''), 10); } catch (_) {}
                return { appId: target, pid: pidVal || undefined };
            }
            return { title: target };
        }

        if (typeof target === 'object') {
            const out = {};
            if (target.appId) out.appId = target.appId;
            if (target.pid) out.pid = target.pid;
            if (target.title) out.title = target.title;
            if (target.windowHandle) out.windowHandle = target.windowHandle;
            if (target.expectedStartTime) out.expectedStartTime = target.expectedStartTime;
            return out;
        }

        throw new Error(`Unsupported target specification: ${JSON.stringify(target)}`);
    }
}

module.exports = {
    DesktopAutomationManager,
    SAFE_APP_ALLOWLIST
};
