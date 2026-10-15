'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureWorkerBuilt, exeFile, resolveExeFile } = require('./native-uia/build-worker.js');

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
     * Launch an authorized Windows application with strict validation and outcome verification.
     * @param {string} exeTarget - Application identifier or executable path
     * @param {string|Array<string>} rawArgs - Optional application arguments
     * @returns {Promise<Object>} Process and window launch result
     */
    async launchApp(exeTarget, rawArgs = '') {
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

        this.trackedApps.set(result.appId, {
            pid: result.pid,
            exe: validation.resolvedPath,
            windowTitle: result.windowTitle || '',
            launchedAt: new Date().toISOString()
        });

        return {
            ok: true,
            status: 'launched',
            appId: result.appId,
            pid: result.pid,
            exe: validation.resolvedPath,
            windowTitle: result.windowTitle || '',
            verification: {
                verified: true,
                method: 'process_and_window_verification'
            }
        };
    }

    /**
     * Inspect the UI Automation accessibility tree of an application.
     */
    async inspectUI(target, options = {}) {
        const payload = this._resolveTargetPayload(target);
        payload.maxDepth = options.maxDepth || 3;

        return await this.sendCommand('inspect_ui', payload);
    }

    /**
     * Find a specific UI control by accessible name, automationId, or controlType.
     */
    async findElement(target, query = {}) {
        const payload = this._resolveTargetPayload(target);
        if (query.name) payload.name = query.name;
        if (query.automationId) payload.automationId = query.automationId;
        if (query.controlType) payload.controlType = query.controlType;

        return await this.sendCommand('find_element', payload);
    }

    /**
     * Type text into an editable Document or Edit control, verifying result.
     */
    async typeText(target, text, options = {}) {
        if (typeof text !== 'string') {
            throw new Error('Text parameter must be a string');
        }

        const payload = this._resolveTargetPayload(target);
        payload.text = text;

        const result = await this.sendCommand('type_text', payload);
        return {
            success: Boolean(result && result.verified),
            verified: Boolean(result && result.verified),
            readText: result?.readText || '',
            controlName: result?.controlName || '',
            controlType: result?.controlType || '',
            method: result?.method || 'ValuePattern'
        };
    }

    /**
     * Click or invoke an accessible UI control.
     */
    async clickElement(target, query = {}, options = {}) {
        const payload = this._resolveTargetPayload(target);
        if (query.name) payload.name = query.name;
        if (query.automationId) payload.automationId = query.automationId;

        const result = await this.sendCommand('click_element', payload);
        return {
            success: Boolean(result && result.verified),
            verified: Boolean(result && result.verified),
            action: result?.action || 'invoked',
            name: result?.name || '',
            controlType: result?.controlType || ''
        };
    }

    /**
     * Take a screenshot of the target application window.
     */
    async takeScreenshot(target, options = {}) {
        const payload = this._resolveTargetPayload(target);
        return await this.sendCommand('take_screenshot', payload);
    }

    /**
     * Gracefully close a target application with optional modal save dialog resolution.
     * @param {string|number|Object} target - App identifier, PID, or title
     * @param {Object} [options]
     * @param {'dont_save'|'save'|'cancel'|'ask'} [options.savePolicy] - Policy for handling unsaved confirmation dialogs
     */
    async closeApp(target, options = {}) {
        const payload = this._resolveTargetPayload(target);
        if (options.savePolicy) {
            payload.savePolicy = options.savePolicy;
        } else if (options.dialogAction) {
            payload.savePolicy = options.dialogAction;
        }

        const result = await this.sendCommand('close_app', payload);

        if (result && result.closed && payload.appId) {
            this.trackedApps.delete(payload.appId);
        }

        return result;
    }

    /**
     * Detect if a modal confirmation dialog is currently active for an application.
     */
    async detectDialog(target) {
        const payload = this._resolveTargetPayload(target);
        return await this.sendCommand('detect_dialog', payload);
    }

    /**
     * Handle an active modal dialog by invoking the specified action.
     * @param {string|number|Object} target
     * @param {'save'|'dont_save'|'cancel'} action
     */
    async handleDialog(target, action, options = {}) {
        if (!action || !['save', 'dont_save', 'cancel'].includes(action.toLowerCase())) {
            throw new Error(`Invalid dialog action: '${action}'. Must be one of: save, dont_save, cancel`);
        }
        const payload = this._resolveTargetPayload(target);
        payload.action = action.toLowerCase();
        const result = await this.sendCommand('handle_dialog', payload);
        if (result && result.processExited && payload.appId) {
            this.trackedApps.delete(payload.appId);
        }
        return result;
    }

    /**
     * Close the currently active tab in an application (via Ctrl+W shortcut).
     */
    async closeTab(target) {
        const payload = this._resolveTargetPayload(target);
        return await this.sendCommand('close_tab', payload);
    }

    /**
     * Clean up and destroy the manager.
     */
    cleanup() {
        this.isDestroyed = true;
        if (this.proc) {
            try {
                this.proc.stdin.write(JSON.stringify({ id: 9999, cmd: 'exit' }) + '\n');
            } catch (_) {}
            setTimeout(() => {
                if (this.proc && !this.proc.killed) {
                    try { this.proc.kill(); } catch (_) {}
                }
            }, 300);
        }
    }

    _resolveTargetPayload(target) {
        if (!target) {
            throw new Error('A target appId, processId, or window title must be specified');
        }

        if (typeof target === 'number') {
            return { pid: target };
        }

        if (typeof target === 'string') {
            if (target.startsWith('app_')) {
                return { appId: target };
            }
            // Check if it matches a tracked appId
            if (this.trackedApps.has(target)) {
                return { appId: target };
            }
            // Treat as window title match
            return { title: target };
        }

        if (typeof target === 'object') {
            const out = {};
            if (target.appId) out.appId = target.appId;
            if (target.pid) out.pid = target.pid;
            if (target.title) out.title = target.title;
            if (target.windowHandle) out.windowHandle = target.windowHandle;
            return out;
        }

        throw new Error(`Unsupported target specification: ${JSON.stringify(target)}`);
    }
}

module.exports = {
    DesktopAutomationManager,
    SAFE_APP_ALLOWLIST
};
