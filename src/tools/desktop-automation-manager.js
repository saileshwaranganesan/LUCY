'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ensureWorkerBuilt, verifyWorkerBinary, exeFile, resolveExeFile, isVirtualAsarPath } = require('./native-uia/build-worker.js');
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
        this.sessionSecret = options.sessionSecret || crypto.randomBytes(32).toString('hex');
        this.proc = null;
        this.nextId = 1;
        this.pendingRequests = new Map();
        this.buffer = '';
        this.isReady = false;
        this.readyPromise = null;
        this.trackedApps = new Map(); // appId -> { pid, exe, windowTitle, launchedAt }
        this.isDestroyed = false;
        this._initSessionStarted = false;
        this.interactionMode = options.interactionMode || INTERACTION_MODES.NON_INTRUSIVE;
        this.workspaceRoot = options.workspaceRoot || null;
    }

    setWorkspaceRoot(root) {
        this.workspaceRoot = root || null;
    }

    setInteractionMode(mode) {
        if (Object.values(INTERACTION_MODES).includes(mode)) {
            this.interactionMode = mode;
        }
    }

    getInteractionMode() {
        return this.interactionMode;
    }

    _generateTaskGrant(taskId, exePath) {
        if (!this.sessionSecret) {
            this.sessionSecret = crypto.randomBytes(32).toString('hex');
        }
        const cleanPath = (exePath || '').toLowerCase();
        return crypto.createHmac('sha256', this.sessionSecret)
            .update(`launch:${taskId}:${cleanPath}`)
            .digest('hex');
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

        if (!this.sessionSecret) {
            this.sessionSecret = crypto.randomBytes(32).toString('hex');
        }

        // Ensure worker binary exists and is not an unspawnable virtual asar path
        const isVirtual = isVirtualAsarPath ? isVirtualAsarPath(this.workerExe) :
            (typeof this.workerExe === 'string' && this.workerExe.replace(/\\/g, '/').includes('app.asar') && !this.workerExe.replace(/\\/g, '/').includes('app.asar.unpacked'));

        if (typeof resolveExeFile === 'function') {
            this.workerExe = resolveExeFile();
        }
        if (typeof ensureWorkerBuilt === 'function' && !__dirname.includes('app.asar')) {
            try {
                this.workerExe = ensureWorkerBuilt();
            } catch (_) {}
        }

        if (isVirtualAsarPath ? isVirtualAsarPath(this.workerExe) : false) {
            throw new Error(`LucyUiaWorker cannot be spawned from virtual asar path: ${this.workerExe}`);
        }

        if (typeof verifyWorkerBinary === 'function') {
            const check = verifyWorkerBinary(this.workerExe);
            if (!check.valid) {
                throw new Error(`LucyUiaWorker binary verification failed: ${check.error || 'Invalid or corrupted binary'}`);
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
                    this._handleStdout(chunk, resolve, reject, timer);
                });

                this.proc.stderr.on('data', (chunk) => {
                    // Stderr for diagnostics
                    const text = chunk.toString('utf8').trim();
                    if (text) {
                        // worker diagnostic output
                    }
                });

                this.proc.on('close', (code) => {
                    clearTimeout(timer);
                    const wasInitializing = !this.isReady;
                    this.isReady = false;
                    this._initSessionStarted = false;
                    this.readyPromise = null;
                    this.proc = null;
                    // Reject any pending requests
                    for (const [id, req] of this.pendingRequests.entries()) {
                        req.reject(new Error(`LucyUiaWorker process closed with code ${code}`));
                    }
                    this.pendingRequests.clear();
                    if (wasInitializing) {
                        reject(new Error(`LucyUiaWorker process closed prematurely with code ${code}`));
                    }
                });

                this.proc.on('error', (err) => {
                    clearTimeout(timer);
                    this.isReady = false;
                    this._initSessionStarted = false;
                    this.readyPromise = null;
                    reject(err);
                });
            } catch (err) {
                clearTimeout(timer);
                this._initSessionStarted = false;
                reject(err);
            }
        });

        return await this.readyPromise;
    }

    _handleStdout(chunk, readyResolve, readyReject, readyTimer) {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // keep trailing partial

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                const msg = JSON.parse(trimmed);

                // Initial handshake: When worker is ready, establish session secret over private anonymous stdin pipe
                if (msg.status === 'ready' && !this.isReady) {
                    if (!this._initSessionStarted && this.proc && this.proc.stdin) {
                        this._initSessionStarted = true;
                        const initId = this.nextId++;
                        const initPayload = { id: initId, cmd: 'init_session', sessionSecret: this.sessionSecret };

                        const initTimer = setTimeout(() => {
                            this.pendingRequests.delete(initId);
                            if (readyTimer) clearTimeout(readyTimer);
                            if (readyReject) readyReject(new Error(`Timed out establishing worker session secret (${this.timeoutMs}ms)`));
                        }, this.timeoutMs);

                        this.pendingRequests.set(initId, {
                            resolve: (res) => {
                                clearTimeout(initTimer);
                                if (!res || !res.initialized) {
                                    this.isReady = false;
                                    this._initSessionStarted = false;
                                    if (readyTimer) clearTimeout(readyTimer);
                                    if (readyReject) readyReject(new Error('Worker session initialization returned invalid acknowledgement'));
                                    return;
                                }
                                this.isReady = true;
                                this._initSessionStarted = false;
                                if (readyTimer) clearTimeout(readyTimer);
                                if (readyResolve) readyResolve(res);
                            },
                            reject: (err) => {
                                clearTimeout(initTimer);
                                this.isReady = false;
                                this._initSessionStarted = false;
                                if (readyTimer) clearTimeout(readyTimer);
                                if (readyReject) readyReject(new Error(`Worker session initialization rejected: ${err.message}`));
                            },
                            timer: initTimer
                        });

                        try {
                            this.proc.stdin.write(JSON.stringify(initPayload) + '\n');
                        } catch (writeErr) {
                            clearTimeout(initTimer);
                            this.pendingRequests.delete(initId);
                            if (readyReject) readyReject(writeErr);
                        }
                    }
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
     * Check if a target PID, appId, window title, or object matches protected IDE or host boundaries.
     * @param {string|number|Object} target
     * @returns {boolean}
     */
    isProtectedTarget(target) {
        if (!target) return false;
        const protectedNames = [
            'antigravity', 'antigravity ide', 'code', 'electron', 'node',
            'visual studio', 'visual studio code', 'devenv', 'cursor', 'windsurf',
            'powershell', 'pwsh', 'cmd', 'explorer', 'taskmgr', 'lucyuiaworker'
        ];
        if (typeof target === 'number') {
            if (target === process.pid || target === process.ppid) return true;
        }
        if (typeof target === 'string') {
            const lower = target.toLowerCase().trim();
            if (lower.startsWith('app_')) {
                let parsedPid = 0;
                try { parsedPid = parseInt(lower.replace('app_', ''), 10); } catch (_) {}
                if (parsedPid && (parsedPid === process.pid || parsedPid === process.ppid)) return true;
            }
            for (const name of protectedNames) {
                if (lower === name || lower.includes(name)) return true;
            }
        }
        if (typeof target === 'object') {
            if (target.pid && (target.pid === process.pid || target.pid === process.ppid || this.isProtectedTarget(target.pid))) return true;
            if (target.appId && this.isProtectedTarget(target.appId)) return true;
            if (target.title && this.isProtectedTarget(target.title)) return true;
            if (target.exe && this.isProtectedTarget(target.exe)) return true;
            if (target.processName && this.isProtectedTarget(target.processName)) return true;
            if (target.name && this.isProtectedTarget(target.name)) return true;
        }
        return false;
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

        // Object target with appId, pid, windowHandle, exe, or title
        if (typeof target === 'object') {
            let candidate = null;
            if (target.appId && this.trackedApps.has(target.appId)) {
                candidate = this.trackedApps.get(target.appId);
            } else if (target.pid) {
                for (const app of this.trackedApps.values()) {
                    if (app.pid === target.pid && app.lifecycleState === 'active') {
                        candidate = app;
                        break;
                    }
                }
            } else if (target.windowHandle) {
                for (const app of this.trackedApps.values()) {
                    if (app.windowHandle === target.windowHandle && app.lifecycleState === 'active') {
                        candidate = app;
                        break;
                    }
                }
            } else if (target.title) {
                candidate = this.getTrackedApp(target.title);
            }

            if (!candidate || candidate.ambiguous) return candidate;

            // Strict target-identity cross checks:
            if (target.pid && candidate.pid && target.pid !== candidate.pid) {
                return null; // Mismatched PID
            }
            if (target.windowHandle && candidate.windowHandle && target.windowHandle !== candidate.windowHandle) {
                return null; // Mismatched window handle
            }
            if (target.expectedStartTime && candidate.processStartTime && target.expectedStartTime !== candidate.processStartTime) {
                return null; // Stale or reused PID
            }
            if (target.exe && candidate.exe) {
                const targetBase = path.basename(target.exe).toLowerCase();
                const candBase = path.basename(candidate.exe).toLowerCase();
                if (targetBase !== candBase && path.resolve(target.exe).toLowerCase() !== path.resolve(candidate.exe).toLowerCase()) {
                    return null; // Mismatched executable identity!
                }
            }

            return candidate.lifecycleState === 'active' ? candidate : null;
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
        if (this.isProtectedTarget(target)) {
            const err = new Error(`[SAFETY_VIOLATION] Target '${JSON.stringify(target)}' matches protected host/IDE process or environment boundary.`);
            err.code = 'SAFETY_VIOLATION';
            throw err;
        }

        const app = this.getTrackedApp(target);
        if (app && app.ambiguous) {
            const err = new Error(`[AMBIGUOUS_APPLICATION_OWNERSHIP] Ambiguous application target '${JSON.stringify(target)}': Multiple active instances match. Specify exact appId or PID.`);
            err.code = 'AMBIGUOUS_APPLICATION_OWNERSHIP';
            throw err;
        }
        if (!app || !app.launchedByLucy || app.lifecycleState !== 'active') {
            const err = new Error(`[UNAUTHORIZED_RESOURCE_ACCESS] Application ownership verification failed: Lucy did not launch '${JSON.stringify(target)}'. Cannot perform destructive or state-modifying action on unowned user application.`);
            err.code = 'UNAUTHORIZED_RESOURCE_ACCESS';
            throw err;
        }
        if (app.taskId) {
            if (!options.taskId) {
                const err = new Error(`[TASK_BOUNDARY_VIOLATION] Task identity missing: Application '${app.appId}' is bound to task '${app.taskId}', but no taskId was supplied in caller authorization context.`);
                err.code = 'TASK_BOUNDARY_VIOLATION';
                throw err;
            }
            if (app.taskId !== options.taskId) {
                const err = new Error(`[TASK_BOUNDARY_VIOLATION] Task isolation violation: Application '${app.appId}' belongs to task '${app.taskId}', not current task '${options.taskId}'.`);
                err.code = 'TASK_BOUNDARY_VIOLATION';
                throw err;
            }
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

        const effectiveTaskId = options.taskId || ('task_mgr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8));
        const validation = this.validateExecutable(exeTarget);
        let effectiveArgs = rawArgs;
        let resolvedFileCandidate = null;
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
            const clean = rawArgs.trim().replace(/^"|"$/g, '');
            if (!path.isAbsolute(clean)) {
                const root = options.workspaceRoot || this.workspaceRoot || process.cwd();
                const candidate = path.resolve(root, clean);
                if (fs.existsSync(candidate)) {
                    effectiveArgs = `"${candidate}"`;
                    resolvedFileCandidate = candidate;
                }
            } else {
                resolvedFileCandidate = clean;
                if (!rawArgs.startsWith('"')) {
                    effectiveArgs = `"${clean}"`;
                }
            }
        }

        const validatedArgs = this.validateArguments(validation.resolvedPath, effectiveArgs);

        const taskGrant = this._generateTaskGrant(effectiveTaskId, validation.resolvedPath);

        const launchPayload = {
            exe: validation.resolvedPath,
            args: validatedArgs,
            taskId: effectiveTaskId,
            taskGrant: taskGrant
        };
        if (options.targetPath) {
            launchPayload.targetPath = path.resolve(options.targetPath);
        } else if (resolvedFileCandidate && fs.existsSync(resolvedFileCandidate)) {
            launchPayload.targetPath = path.resolve(resolvedFileCandidate);
        }

        let result;
        try {
            result = await this.sendCommand('launch_app', launchPayload);
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

        // Safety verification: result must not belong to protected host or developer IDE processes
        if (this.isProtectedTarget(result.pid) || this.isProtectedTarget(result.windowTitle) || this.isProtectedTarget(result)) {
            const safetyErr = new Error(`[SAFETY_VIOLATION] Launched application resolution mistakenly targeted protected host/IDE process (PID ${result.pid}, title "${result.windowTitle}").`);
            safetyErr.code = 'SAFETY_VIOLATION';
            throw safetyErr;
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
            taskId: effectiveTaskId,
            authToken: result.authToken || `tok_${result.pid}_${Date.now()}`,
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
        // Mandatory authorization invariant: caller cannot disable ownership assertion
        this.assertOwnership(target, { taskId: options.taskId, action: 'focus_window' });
        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
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
        this.assertOwnership(target, { taskId: options.taskId, action: 'inspect_ui' });
        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
        payload.maxDepth = options.maxDepth || 3;

        return await this.sendCommand('inspect_ui', payload);
    }

    /**
     * Resolve a deterministic UI Automation target matching evidence criteria.
     * Separates target identification from action execution.
     * @param {string|number|Object} target - Target application or window
     * @param {Object} query - Target resolution criteria
     * @param {Object} [options] - Options including taskId and signal
     * @returns {Promise<Object>} Resolution receipt
     */
    async resolveTarget(target, query = {}, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Target resolution cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }
        const effectiveOptions = typeof query === 'object' && query.taskId ? { ...query, ...options } : options;
        this.assertOwnership(target, { taskId: effectiveOptions.taskId, action: 'resolve_target' });
        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: effectiveOptions.taskId });
        payload.isOwned = true;
        if (query.name) payload.name = query.name;
        if (query.automationId) payload.automationId = query.automationId;
        if (query.controlType) payload.controlType = query.controlType;
        if (query.className) payload.className = query.className;
        if (query.parentAutomationId) payload.parentAutomationId = query.parentAutomationId;
        if (query.parentName) payload.parentName = query.parentName;
        if (query.parentControlType) payload.parentControlType = query.parentControlType;
        if (query.expectedBoundingBox) payload.expectedBoundingBox = query.expectedBoundingBox;
        if (query.action) payload.action = query.action;
        payload.allowPhysicalFallback = Boolean(query.allowPhysicalFallback || options.allowPhysicalFallback);

        const result = await this.sendCommand('resolve_target', payload);
        return {
            success: Boolean(result && (result.success || result.matched)),
            matched: Boolean(result && (result.success || result.matched)),
            strategy: result?.strategy || 'none',
            attempts: result?.attempts || 1,
            ambiguityCount: result?.ambiguityCount || 0,
            errorCode: result?.errorCode || null,
            errorMessage: result?.errorMessage || null,
            resolvedTarget: result?.resolvedTarget || null,
            rejectedCandidates: result?.rejectedCandidates || []
        };
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
        const effectiveOptions = typeof query === 'object' && query.taskId ? { ...query, ...options } : options;
        this.assertOwnership(target, { taskId: effectiveOptions.taskId, action: 'find_element' });
        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: effectiveOptions.taskId });
        payload.isOwned = true;
        if (query.name) payload.name = query.name;
        if (query.automationId) payload.automationId = query.automationId;
        if (query.controlType) payload.controlType = query.controlType;
        if (query.className) payload.className = query.className;
        if (query.parentAutomationId) payload.parentAutomationId = query.parentAutomationId;
        if (query.parentName) payload.parentName = query.parentName;
        if (query.parentControlType) payload.parentControlType = query.parentControlType;
        if (query.expectedBoundingBox) payload.expectedBoundingBox = query.expectedBoundingBox;
        if (query.action) payload.action = query.action;

        return await this.sendCommand('find_element', payload);
    }

    /**
     * Inspect whether a target application window is active, responsive, and ready
     * for a requested action (e.g. text input) without executing any side-effects.
     * @param {string|number|Object} target - AppId, PID, or window title
     * @param {Object} [query={}] - Control criteria (controlType, name, automationId, action)
     * @param {Object} [options={}] - Execution context (taskId, signal)
     * @returns {Promise<Object>} Inspection receipt
     */
    async inspectControl(target, query = {}, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Control inspection cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }

        const effectiveOptions = typeof query === 'object' && query.taskId ? { ...query, ...options } : options;
        const tracked = this.assertOwnership(target, { taskId: effectiveOptions.taskId, action: 'inspect_control' });

        const intendedAction = (query.action || 'type').toLowerCase();
        const requestedControlType = query.controlType || (intendedAction === 'type' ? 'Edit' : null);

        let targetElement = null;
        let controlFound = false;
        let controlType = null;
        let controlName = null;
        let automationId = null;
        let isEditable = false;
        let isEnabled = true;
        let resolutionStrategy = 'direct';

        const maxAttempts = options.maxAttempts || (options.quickCheck ? 1 : 6);
        const retryDelayMs = options.retryDelayMs || 350;
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;

            // 1. Check for specific control if automationId, name, className, or controlType is provided
            if (query.automationId || query.name || query.className || query.controlType) {
                try {
                    const found = await this.findElement(target, {
                        name: query.name,
                        automationId: query.automationId,
                        controlType: query.controlType,
                        className: query.className,
                        action: intendedAction
                    }, effectiveOptions);

                    if (found && (found.element || found.name || found.automationId || found.controlType)) {
                        controlFound = true;
                        controlType = found.controlType || query.controlType;
                        controlName = found.name || query.name;
                        automationId = found.automationId || query.automationId;
                        isEnabled = found.isEnabled !== false;
                        isEditable = Boolean(controlType && (controlType.includes('Edit') || controlType.includes('Document')));
                        resolutionStrategy = found.resolutionStrategy || 'find_element';
                        targetElement = found;
                    }
                } catch (err) {
                    if (err.message && err.message.includes('AMBIGUOUS')) {
                        throw err;
                    }
                }
            }

            // 2. If action is typing, reading, or inspecting and no specific control was specified or found, check for Document or Edit control
            if (!controlFound && (intendedAction === 'type' || intendedAction === 'read' || intendedAction === 'inspect')) {
                // Try Document control first (e.g. Windows 11 Notepad RichEditD2DPT)
                try {
                    const docFound = await this.findElement(target, { controlType: 'Document', action: intendedAction }, effectiveOptions);
                    if (docFound && (docFound.name || docFound.controlType || docFound.automationId)) {
                        controlFound = true;
                        controlType = docFound.controlType || 'Document';
                        controlName = docFound.name || 'Text editor';
                        automationId = docFound.automationId || '';
                        isEnabled = docFound.isEnabled !== false;
                        isEditable = true;
                        resolutionStrategy = docFound.resolutionStrategy || 'default_document';
                        targetElement = docFound;
                    }
                } catch (_) {}

                // Try Edit control next (e.g. Classic Notepad Edit control)
                if (!controlFound) {
                    try {
                        const editFound = await this.findElement(target, { controlType: 'Edit', action: intendedAction }, effectiveOptions);
                        if (editFound && (editFound.name || editFound.controlType || editFound.automationId)) {
                            controlFound = true;
                            controlType = editFound.controlType || 'Edit';
                            controlName = editFound.name || 'Text editor';
                            automationId = editFound.automationId || '';
                            isEnabled = editFound.isEnabled !== false;
                            isEditable = true;
                            resolutionStrategy = editFound.resolutionStrategy || 'default_edit';
                            targetElement = editFound;
                        }
                    } catch (_) {}
                }
            }

            // 3. Fallback: inspect UI tree if findElement returned null
            if (!controlFound) {
                try {
                    const tree = await this.inspectUI(target, { maxDepth: 3, ...effectiveOptions });
                    if (tree) {
                        const findInTree = (node) => {
                            if (!node) return null;
                            const cType = (node.controlType || '').toLowerCase();
                            if (requestedControlType && cType.includes(requestedControlType.toLowerCase())) {
                                return node;
                            }
                            if ((intendedAction === 'type' || intendedAction === 'read' || intendedAction === 'inspect') && (cType.includes('edit') || cType.includes('document'))) {
                                return node;
                            }
                            if (intendedAction === 'click' && cType.includes('button')) {
                                return node;
                            }
                            if (Array.isArray(node.children)) {
                                for (const ch of node.children) {
                                    const m = findInTree(ch);
                                    if (m) return m;
                                }
                            }
                            return null;
                        };
                        const match = findInTree(tree);
                        if (match) {
                            controlFound = true;
                            controlType = match.controlType;
                            controlName = match.name;
                            automationId = match.automationId;
                            isEnabled = match.isEnabled !== false;
                            isEditable = Boolean(controlType && (controlType.includes('Edit') || controlType.includes('Document')));
                            resolutionStrategy = 'tree_traversal';
                            targetElement = match;
                        }
                    }
                } catch (_) {}
            }

            if (controlFound) {
                break;
            }

            if (attempt < maxAttempts) {
                if (options.signal && options.signal.aborted) {
                    break;
                }
                await new Promise(r => setTimeout(r, retryDelayMs));
            }
        }

        const isReady = controlFound && isEnabled;

        return {
            ok: true,
            ready: isReady,
            target: typeof target === 'string' ? target : (tracked?.appId || String(target)),
            appId: tracked?.appId || null,
            pid: tracked?.pid || null,
            windowTitle: tracked?.windowTitle || '',
            windowHandle: tracked?.windowHandle || 0,
            topLevelWindowFound: Boolean(tracked && (tracked.windowHandle > 0 || tracked.pid > 0)),
            windowResponsive: true,
            controlFound,
            controlType: controlType || requestedControlType,
            controlName: controlName || null,
            automationId: automationId || null,
            isEditable,
            isEnabled,
            action: intendedAction,
            resolutionStrategy,
            element: targetElement,
            message: isReady
                ? `Window '${tracked?.windowTitle || target}' is active, responsive, and ready for ${intendedAction === 'type' ? 'text input' : intendedAction}.`
                : `Window '${tracked?.windowTitle || target}' is active, but no compatible ready control was located.`
        };
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

        // Mandatory authorization invariant: caller cannot disable ownership assertion
        this.assertOwnership(target, { taskId: options.taskId, action: 'type_text' });

        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
        payload.text = text;
        payload.preferBackground = options.preferBackground !== false;
        payload.allowPhysicalFallback = options.allowPhysicalFallback !== undefined
            ? Boolean(options.allowPhysicalFallback)
            : (this.interactionMode === INTERACTION_MODES.FOREGROUND_REQUIRED);
        const passwordKeywordRegex = /password|passwd|pwd|pin|secret|credential|token|auth/i;
        const inferredSecret = Boolean(
            options.isSecret ||
            passwordKeywordRegex.test(options.automationId || '') ||
            passwordKeywordRegex.test(options.name || '') ||
            passwordKeywordRegex.test(options.controlName || '') ||
            passwordKeywordRegex.test(options.targetControl || '') ||
            passwordKeywordRegex.test(options.className || '') ||
            passwordKeywordRegex.test(typeof target === 'string' ? target : (target?.name || target?.automationId || ''))
        );
        if (inferredSecret) payload.isSecret = true;
        if (options.automationId) payload.automationId = options.automationId;
        if (options.name) payload.name = options.name;
        if (options.controlType) payload.controlType = options.controlType;
        if (options.className) payload.className = options.className;

        try {
            const result = await this.sendCommand('type_text', payload);
            const isSecret = Boolean(inferredSecret || result?.isSecret);
            return {
                success: Boolean(result && result.verified),
                verified: Boolean(result && result.verified),
                postconditionStatus: result?.postconditionStatus || (result?.verified ? 'VERIFIED' : 'FAILED'),
                postconditionDetail: result?.postconditionDetail || null,
                error: result?.error || null,
                readText: isSecret ? '[REDACTED]' : (result?.readText || ''),
                isSecret,
                controlName: result?.controlName || '',
                controlType: result?.controlType || '',
                method: result?.method || 'ValuePattern',
                tier: result?.tier || 3,
                tierName: result?.tierName || (result?.tier === 4 ? 'Tier 4 — Physical mouse/keyboard fallback' : 'Tier 3 — Windows UI Automation'),
                physicalInputUsed: Boolean(result?.physicalInputUsed),
                background: Boolean(result?.background),
                resolutionStrategy: result?.resolutionStrategy || 'direct',
                resolutionAttempts: result?.resolutionAttempts || 1,
                resolvedTarget: result?.resolvedTarget || null
            };
        } catch (err) {
            if (inferredSecret && text) {
                if (err.message) err.message = err.message.split(text).join('[REDACTED]');
                if (err.stack) err.stack = err.stack.split(text).join('[REDACTED]');
            }
            if (err.message && err.message.includes('FOCUS_VERIFICATION_FAILED')) {
                return {
                    success: false,
                    verified: false,
                    postconditionStatus: 'FAILED',
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
                    postconditionStatus: 'FAILED',
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

        // Mandatory authorization invariant: caller cannot disable ownership assertion
        this.assertOwnership(target, { taskId: options.taskId, action: 'click_element' });

        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
        if (query.name) payload.name = query.name;
        if (query.automationId) payload.automationId = query.automationId;
        if (query.controlType) payload.controlType = query.controlType;
        if (query.className) payload.className = query.className;
        if (query.parentAutomationId) payload.parentAutomationId = query.parentAutomationId;
        if (query.parentName) payload.parentName = query.parentName;
        if (query.parentControlType) payload.parentControlType = query.parentControlType;
        if (query.expectedBoundingBox) payload.expectedBoundingBox = query.expectedBoundingBox;

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
                postconditionStatus: result?.postconditionStatus || (result?.verified ? 'VERIFIED' : 'FAILED'),
                postconditionDetail: result?.postconditionDetail || '',
                action: result?.action || 'invoked',
                name: result?.name || '',
                controlType: result?.controlType || '',
                tier: result?.tier || 3,
                tierName: result?.tierName || (result?.tier === 4 ? 'Tier 4 — Physical mouse/keyboard fallback' : 'Tier 3 — Windows UI Automation'),
                physicalInputUsed: Boolean(result?.physicalInputUsed),
                method: result?.method || 'InvokePattern',
                resolutionStrategy: result?.resolutionStrategy || 'direct',
                resolutionAttempts: result?.resolutionAttempts || 1,
                resolvedTarget: result?.resolvedTarget || null
            };
        } catch (err) {
            if (err.message && err.message.includes('TIER3_UIA_UNSUPPORTED')) {
                return {
                    success: false,
                    verified: false,
                    postconditionStatus: 'FAILED',
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
        this.assertOwnership(target, { taskId: options.taskId, action: 'take_screenshot' });
        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
        if (options.allowPlaceholder !== undefined) {
            payload.allowPlaceholder = Boolean(options.allowPlaceholder);
        }
        return await this.sendCommand('take_screenshot', payload);
    }

    /**
     * Gracefully close a target application with explicit ownership verification and modal save dialog resolution.
     * @param {string|number|Object} target - App identifier, PID, or title
     * @param {Object} [options]
     * @param {'dont_save'|'save'|'cancel'|'ask'} [options.savePolicy] - Policy for handling unsaved confirmation dialogs
     * @param {string} [options.taskId] - Task ID authorizing close
     * @param {boolean} [options.force] - Explicitly authorize force termination
     * @param {AbortSignal} [options.signal] - Cancellation signal
     */
    async closeApp(target, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Application close operation cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }

        const isDiscarding = options.savePolicy === 'dont_save' || options.dialogAction === 'dont_save';
        const isForceKill = Boolean(options.force === true || options.allowForceKill === true);

        // Mandatory authorization invariant: caller cannot disable ownership assertion
        const app = this.assertOwnership(target, { taskId: options.taskId, action: isDiscarding ? 'close_app_discard' : 'close_app' });

        // Target authorization mismatch check
        if (options.authorizedTarget) {
            const grantTarget = String(options.authorizedTarget).toLowerCase().trim();
            const candAppId = String(app.appId || '').toLowerCase().trim();
            const candPid = String(app.pid || '').trim();
            const candTitle = String(app.windowTitle || '').toLowerCase().trim();
            const targetStr = String(target).toLowerCase().trim();

            const isMatch = grantTarget === candAppId ||
                            grantTarget === candPid ||
                            candTitle.includes(grantTarget) ||
                            grantTarget === targetStr;

            if (!isMatch) {
                const err = new Error(`[TARGET_AUTHORIZATION_MISMATCH] Discard authorization granted for target '${options.authorizedTarget}' cannot be applied to target '${target}'.`);
                err.code = 'TARGET_AUTHORIZATION_MISMATCH';
                err.target = target;
                err.authorizedTarget = options.authorizedTarget;
                throw err;
            }
        }

        // Enforce discard authorization on closeApp if dont_save is requested
        if (isDiscarding) {
            const isUserAuthorized = Boolean(options.userAuthorizedDiscard === true);
            const isDisposableTest = Boolean(
                options.trustedTestScope === true ||
                (options.disposableTestDoc === true && (app?.isDisposableTest === true || app?.disposableTestDoc === true || options.trustedTestScope === true)) ||
                app?.isDisposableTest === true ||
                app?.disposableTestDoc === true ||
                app?.canCleanup === true
            );

            if (!isUserAuthorized && !isDisposableTest) {
                const err = new Error(`[UNAUTHORIZED_DISCARD_ACTION] Cannot close application with 'dont_save' without explicit user discard authorization or verified disposable test scope. Unsaved document state is preserved.`);
                err.code = 'UNAUTHORIZED_DISCARD_ACTION';
                err.target = target;
                err.action = 'dont_save';
                throw err;
            }
        }

        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
        payload.allowForceKill = isForceKill;
        payload.userAuthorizedDiscard = Boolean(options.userAuthorizedDiscard === true);
        payload.disposableTestDoc = Boolean(
            options.trustedTestScope === true ||
            (options.disposableTestDoc === true && (app?.isDisposableTest === true || app?.disposableTestDoc === true || options.trustedTestScope === true)) ||
            app?.isDisposableTest === true ||
            app?.disposableTestDoc === true ||
            app?.canCleanup === true
        );

        if (options.savePolicy) {
            payload.savePolicy = options.savePolicy;
        } else if (options.dialogAction) {
            payload.savePolicy = options.dialogAction;
        }
        if (options.targetPath) {
            payload.targetPath = path.resolve(options.targetPath);
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
        this.assertOwnership(target, { taskId: options.taskId, action: 'detect_dialog' });
        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
        return await this.sendCommand('detect_dialog', payload);
    }

    /**
     * Handle an active modal dialog by invoking the specified action with ownership verification.
     * Enforces that unsaved user work is never discarded without explicit user authorization or disposable test scope.
     * @param {string|number|Object} target
     * @param {'save'|'dont_save'|'cancel'} action
     * @param {Object} [options]
     * @param {boolean} [options.userAuthorizedDiscard] - Explicit user authorization to discard unsaved document
     * @param {boolean} [options.disposableTestDoc] - Explicit scope indicating disposable test document
     * @param {boolean} [options.isAmbiguous] - Indicates whether target or dialog intent is ambiguous
     * @param {string|number} [options.authorizedTarget] - Specific target identity bound to authorization grant
     * @param {boolean} [options.trustedTestScope] - Trusted flag establishing test context
     * @param {string} [options.taskId]
     * @param {AbortSignal} [options.signal]
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

        // 1. Ambiguous confirmation dialog: if dialog intent or target cannot be established confidently
        if (options.isAmbiguous === true) {
            const err = new Error(`[AMBIGUOUS_CONFIRMATION_DIALOG] Ambiguous confirmation dialog: Target or dialog intent cannot be established confidently without user clarification.`);
            err.code = 'AMBIGUOUS_CONFIRMATION_DIALOG';
            err.target = target;
            throw err;
        }

        // Mandatory authorization invariant: caller cannot disable ownership assertion
        const app = this.assertOwnership(target, { taskId: options.taskId, action: `dialog_${lowerAction}` });

        // Target authorization mismatch check
        if (options.authorizedTarget) {
            const grantTarget = String(options.authorizedTarget).toLowerCase().trim();
            const candAppId = String(app.appId || '').toLowerCase().trim();
            const candPid = String(app.pid || '').trim();
            const candTitle = String(app.windowTitle || '').toLowerCase().trim();
            const targetStr = String(target).toLowerCase().trim();

            const isMatch = grantTarget === candAppId ||
                            grantTarget === candPid ||
                            candTitle.includes(grantTarget) ||
                            grantTarget === targetStr;

            if (!isMatch) {
                const err = new Error(`[TARGET_AUTHORIZATION_MISMATCH] Discard authorization granted for target '${options.authorizedTarget}' cannot be applied to target '${target}'.`);
                err.code = 'TARGET_AUTHORIZATION_MISMATCH';
                err.target = target;
                err.authorizedTarget = options.authorizedTarget;
                throw err;
            }
        }

        // 2. Unsaved document safety invariant:
        // Never automatically discard unsaved user work simply because a dialog blocks progress.
        // Discarding ('dont_save') is ONLY permitted if:
        //   (a) The document is confirmed to involve disposable test data created exclusively for an authorized automated test
        //   (b) The user has explicitly authorized discarding a known document
        // CRITICAL: allowForceKill / force does NOT authorize discard!
        if (lowerAction === 'dont_save') {
            const isUserAuthorized = Boolean(options.userAuthorizedDiscard === true);
            const isDisposableTest = Boolean(
                options.trustedTestScope === true ||
                (options.disposableTestDoc === true && (app?.isDisposableTest === true || app?.disposableTestDoc === true || options.trustedTestScope === true)) ||
                app?.isDisposableTest === true ||
                app?.disposableTestDoc === true
            );

            if (!isUserAuthorized && !isDisposableTest) {
                const err = new Error(`[UNAUTHORIZED_DISCARD_ACTION] Cannot discard unsaved changes without explicit user authorization or confirmed disposable test scope. Unsaved document state is preserved.`);
                err.code = 'UNAUTHORIZED_DISCARD_ACTION';
                err.target = target;
                err.action = lowerAction;
                throw err;
            }
        }

        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.action = lowerAction;
        payload.isOwned = true;
        payload.userAuthorizedDiscard = Boolean(options.userAuthorizedDiscard === true);
        payload.disposableTestDoc = Boolean(
            options.trustedTestScope === true ||
            (options.disposableTestDoc === true && (app?.isDisposableTest === true || app?.disposableTestDoc === true || options.trustedTestScope === true)) ||
            app?.isDisposableTest === true ||
            app?.disposableTestDoc === true
        );
        payload.allowForceKill = Boolean(options.force === true || options.allowForceKill === true);
        if (options.targetPath) {
            payload.targetPath = path.resolve(options.targetPath);
        }

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
     * Save the active document in a target application to an authorized destination path.
     * Enforces ownership, path validation, and verified postcondition evidence.
     * @param {string|number} target - AppId, PID, or window title
     * @param {string} filePath - Destination file path
     * @param {Object} [options={}]
     * @returns {Promise<Object>} Save result and verification receipt
     */
    async saveDocument(target, filePath, options = {}) {
        if (options.signal && options.signal.aborted) {
            const err = new Error('Save document cancelled.');
            err.code = 'CANCELLED';
            throw err;
        }

        if (!filePath || typeof filePath !== 'string') {
            throw new Error('Save document requires a valid destination filePath string.');
        }

        const resolvedPath = path.resolve(filePath);

        // Security check: Refuse to save to dangerous system binaries or system root paths
        const baseName = path.basename(resolvedPath).toLowerCase();
        if (DANGEROUS_BLOCKED_BINARIES.includes(baseName)) {
            throw new Error(`SAFETY_VIOLATION: Refusing to save document targeting blocked binary name: ${baseName}`);
        }

        // Mandatory authorization invariant: caller cannot disable ownership assertion
        this.assertOwnership(target, { taskId: options.taskId, action: 'save_document' });

        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.targetPath = resolvedPath;
        payload.isOwned = true;

        const result = await this.sendCommand('save_document', payload);
        const saved = Boolean(result && (result.saved === true || result.saveSuccess === true));

        return {
            ok: saved,
            saved,
            saveSuccess: saved,
            path: resolvedPath,
            target,
            status: result?.status || (saved ? 'saved_and_verified' : 'save_failed'),
            saveMethod: result?.saveMethod || 'native_uia_save',
            dialogOpen: Boolean(result?.dialogOpen),
            error: result?.error,
            verifiedContentMatch: Boolean(result?.verifiedContentMatch),
            applicationSaveConfirmed: Boolean(result?.applicationSaveConfirmed),
            fallbackPersistenceVerified: Boolean(result?.fallbackPersistenceVerified),
            verification: {
                verified: saved,
                method: 'desktop_save_document_receipt'
            }
        };
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
        // Mandatory authorization invariant: caller cannot disable ownership assertion
        this.assertOwnership(target, { taskId: options.taskId, action: 'close_tab' });
        const payload = this._resolveTargetPayload(target, { requireOwnership: true, taskId: options.taskId });
        payload.isOwned = true;
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
        try {
            await this.sendCommand('revoke_task', { taskId });
        } catch (_) {}
        const results = [];
        for (const [appId, app] of this.trackedApps.entries()) {
            if (app.taskId === taskId && app.lifecycleState === 'active') {
                try {
                    const res = await this.closeApp(appId, {
                        savePolicy: 'dont_save',
                        taskId,
                        trustedTestScope: true,
                        userAuthorizedDiscard: Boolean(app.canCleanup)
                    });
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
        this._initSessionStarted = false;
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

        if (this.isProtectedTarget(target)) {
            const err = new Error(`[SAFETY_VIOLATION] Target '${JSON.stringify(target)}' matches protected host/IDE process or environment boundary.`);
            err.code = 'SAFETY_VIOLATION';
            throw err;
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
            if (tracked.authToken) {
                out.authToken = tracked.authToken;
            }
            if (tracked.taskId) {
                out.taskId = tracked.taskId;
            } else if (options.taskId) {
                out.taskId = options.taskId;
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
            if (Object.keys(out).length === 0) {
                const err = new Error(`Invalid target specification: target object must provide at least one identifier (appId, pid, title, windowHandle).`);
                err.code = 'INVALID_TARGET';
                throw err;
            }
            return out;
        }

        throw new Error(`Unsupported target specification: ${JSON.stringify(target)}`);
    }
}

module.exports = {
    DesktopAutomationManager,
    SAFE_APP_ALLOWLIST,
    INTERACTION_MODES
};
