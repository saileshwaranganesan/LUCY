'use strict';

const EventEmitter = require('events');

/**
 * Application Lifecycle States
 * Represents the genuine, authoritative execution and presentation states of L.U.C.Y.
 */
const LIFECYCLE_STATES = Object.freeze({
    STARTING: 'starting',                     // 1. Initialise the application and required services safely
    MAIN_WINDOW_VISIBLE: 'main_window_visible', // 2. The full Lucy interface is available
    COMPANION_ONLY: 'companion_only',         // 3. Main window hidden/minimised; floating fairy remains available
    BACKGROUND_TRAY: 'background_tray',       // 4. Main window and companion hidden; permitted background tasks continue
    RESTORING: 'restoring',                   // 5. Bring the requested window back into a valid, focused state
    SHUTTING_DOWN: 'shutting_down',           // 6. Stop new actions, cancel active work, release resources and exit
    STOPPED: 'stopped'                        // 7. All Lucy-owned processes and workers terminated
});

/**
 * Main Window Close Behaviors
 */
const CLOSE_ACTIONS = Object.freeze({
    BACKGROUND: 'background',                 // Hide main window, preserve companion and tray
    MINIMIZE_TO_TRAY: 'minimize_to_tray',     // Hide main window and companion, keep tray accessible
    EXIT: 'exit'                              // Perform complete, intentional shutdown
});

/**
 * Valid state transition rules enforcing deterministic state changes.
 */
const ALLOWED_TRANSITIONS = new Map([
    [LIFECYCLE_STATES.STARTING, new Set([
        LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE,
        LIFECYCLE_STATES.COMPANION_ONLY,
        LIFECYCLE_STATES.BACKGROUND_TRAY,
        LIFECYCLE_STATES.SHUTTING_DOWN
    ])],
    [LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE, new Set([
        LIFECYCLE_STATES.COMPANION_ONLY,
        LIFECYCLE_STATES.BACKGROUND_TRAY,
        LIFECYCLE_STATES.RESTORING,
        LIFECYCLE_STATES.SHUTTING_DOWN
    ])],
    [LIFECYCLE_STATES.COMPANION_ONLY, new Set([
        LIFECYCLE_STATES.RESTORING,
        LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE,
        LIFECYCLE_STATES.BACKGROUND_TRAY,
        LIFECYCLE_STATES.SHUTTING_DOWN
    ])],
    [LIFECYCLE_STATES.BACKGROUND_TRAY, new Set([
        LIFECYCLE_STATES.RESTORING,
        LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE,
        LIFECYCLE_STATES.COMPANION_ONLY,
        LIFECYCLE_STATES.SHUTTING_DOWN
    ])],
    [LIFECYCLE_STATES.RESTORING, new Set([
        LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE,
        LIFECYCLE_STATES.COMPANION_ONLY,
        LIFECYCLE_STATES.BACKGROUND_TRAY,
        LIFECYCLE_STATES.SHUTTING_DOWN
    ])],
    [LIFECYCLE_STATES.SHUTTING_DOWN, new Set([
        LIFECYCLE_STATES.STOPPED
    ])],
    [LIFECYCLE_STATES.STOPPED, new Set([])]
]);

/**
 * ApplicationLifecycleManager
 * Coordinates state transitions, close behaviors, window restorations,
 * service tracking, and clean shutdown without orphan processes.
 */
class ApplicationLifecycleManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.currentState = LIFECYCLE_STATES.STARTING;
        this.previousState = null;
        this.history = [];
        this.services = new Map();
        this.isShuttingDown = false;
        this.shutdownPromise = null;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs || 3500;
        this.logger = options.logger || console;

        this._recordState(this.currentState, { reason: 'Initial initialization' });
    }

    /**
     * Get the current authoritative lifecycle state
     * @returns {string} One of LIFECYCLE_STATES
     */
    getState() {
        return this.currentState;
    }

    /**
     * Check if a transition to targetState is valid
     * @param {string} targetState
     * @returns {boolean}
     */
    canTransition(targetState) {
        if (!Object.values(LIFECYCLE_STATES).includes(targetState)) {
            return false;
        }
        const allowed = ALLOWED_TRANSITIONS.get(this.currentState);
        return allowed ? allowed.has(targetState) : false;
    }

    /**
     * Transition the application into a new lifecycle state
     * @param {string} targetState
     * @param {Object} [metadata={}]
     * @returns {boolean}
     */
    transitionTo(targetState, metadata = {}) {
        if (this.currentState === targetState) {
            return true;
        }

        if (!this.canTransition(targetState)) {
            this.logger.warn(`[Lifecycle] Disallowed transition from '${this.currentState}' to '${targetState}'`);
            return false;
        }

        this.previousState = this.currentState;
        this.currentState = targetState;
        this._recordState(targetState, metadata);

        this.emit('stateChanged', {
            previousState: this.previousState,
            currentState: this.currentState,
            metadata,
            timestamp: new Date().toISOString()
        });

        return true;
    }

    _recordState(state, metadata) {
        this.history.push({
            state,
            timestamp: new Date().toISOString(),
            metadata
        });
        if (this.history.length > 50) {
            this.history.shift();
        }
    }

    getStateHistory() {
        return [...this.history];
    }

    /**
     * Register a Lucy-owned service for lifecycle and shutdown coordination
     * @param {string} name
     * @param {Object} serviceRef
     */
    registerService(name, serviceRef) {
        if (!name || typeof name !== 'string') return;
        this.services.set(name, serviceRef);
    }

    /**
     * Unregister a service
     * @param {string} name
     */
    unregisterService(name) {
        this.services.delete(name);
    }

    /**
     * Handle main window close event according to configured closeAction
     * @param {Object} event - Electron Event
     * @param {Object} mainWindow - BrowserWindow reference
     * @param {Object} floatingCompanion - FloatingCompanionWindow reference
     * @param {Object} appSettings - Application configuration
     * @returns {Promise<'hidden_background' | 'hidden_tray' | 'shutting_down'>}
     */
    async handleMainWindowClose(event, mainWindow, floatingCompanion, appSettings = {}) {
        if (this.isShuttingDown) {
            return 'shutting_down';
        }

        const closeAction = appSettings.closeAction || (
            appSettings.backgroundMode === false ? CLOSE_ACTIONS.EXIT : CLOSE_ACTIONS.BACKGROUND
        );

        if (closeAction === CLOSE_ACTIONS.EXIT) {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
            }
            await this.performCleanShutdown({ reason: 'main_window_close_action_exit' });
            return 'shutting_down';
        }

        if (closeAction === CLOSE_ACTIONS.MINIMIZE_TO_TRAY) {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
            }
            if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.hide === 'function') {
                mainWindow.hide();
            }
            if (floatingCompanion && typeof floatingCompanion.hide === 'function') {
                floatingCompanion.hide();
            }
            this.transitionTo(LIFECYCLE_STATES.BACKGROUND_TRAY, { trigger: 'minimize_to_tray' });
            return 'hidden_tray';
        }

        // Default: CLOSE_ACTIONS.BACKGROUND
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.hide === 'function') {
            mainWindow.hide();
        }

        const isCompanionOpen = floatingCompanion && typeof floatingCompanion.isOpen === 'function'
            ? floatingCompanion.isOpen()
            : false;

        this.transitionTo(
            isCompanionOpen ? LIFECYCLE_STATES.COMPANION_ONLY : LIFECYCLE_STATES.BACKGROUND_TRAY,
            { trigger: 'window_hidden_to_background' }
        );

        return 'hidden_background';
    }

    /**
     * Restore the main application window into a focused, active state
     * @param {Function} windowResolver - Resolves or recreates mainWindow
     * @returns {Promise<{ ok: boolean, restored: boolean }>}
     */
    async restoreMainWindow(windowResolver) {
        if (this.isShuttingDown) {
            return { ok: false, error: 'Application is currently shutting down' };
        }

        this.transitionTo(LIFECYCLE_STATES.RESTORING, { trigger: 'restore_main_window' });

        try {
            let win = null;
            if (typeof windowResolver === 'function') {
                win = await windowResolver();
            }

            if (win && !win.isDestroyed()) {
                if (typeof win.isMinimized === 'function' && win.isMinimized()) {
                    win.restore();
                }
                if (typeof win.isVisible === 'function' && !win.isVisible()) {
                    win.show();
                }
                if (typeof win.show === 'function') {
                    win.show();
                }

                // Windows OS Focus Guarantee: toggle always-on-top momentarily to penetrate foreground lock
                try {
                    if (typeof win.setAlwaysOnTop === 'function') {
                        win.setAlwaysOnTop(true);
                        if (typeof win.focus === 'function') win.focus();
                        win.setAlwaysOnTop(false);
                    } else if (typeof win.focus === 'function') {
                        win.focus();
                    }
                } catch (_) {}

                this.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE, { trigger: 'restoration_completed' });
                return { ok: true, restored: true };
            }

            // Fallback: stay in current or restoring state if window could not be resolved
            this.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE, { trigger: 'restoration_fallback' });
            return { ok: true, restored: true };
        } catch (err) {
            this.logger.warn('[Lifecycle] Window restoration failed:', err.message);
            this.transitionTo(LIFECYCLE_STATES.BACKGROUND_TRAY, { trigger: 'restoration_error' });
            return { ok: false, error: err.message };
        }
    }

    /**
     * Perform one authoritative, bounded, clean application shutdown.
     * Prevents duplicate requests, cancels active tasks, terminates Lucy-owned
     * workers cleanly, flushes persistence, closes windows, and exits.
     * @param {Object} [options={}]
     * @returns {Promise<void>}
     */
    async performCleanShutdown(options = {}) {
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }

        this.isShuttingDown = true;
        this.transitionTo(LIFECYCLE_STATES.SHUTTING_DOWN, options);

        this.shutdownPromise = (async () => {
            this.logger.info?.('[Lifecycle] Initiating clean application shutdown...');

            const shutdownTimer = setTimeout(() => {
                this.logger.warn?.('[Lifecycle] Bounded shutdown timeout reached. Enforcing immediate exit.');
                this._forceTerminateTrackedPids();
                this._finalizeExit();
            }, this.shutdownTimeoutMs);

            if (shutdownTimer.unref) shutdownTimer.unref();

            try {
                // 1. Stop accepting new tasks on TaskCoordinator
                const coordinator = this.services.get('coordinator');
                if (coordinator) {
                    coordinator.isAcceptingTasks = false;
                    if (typeof coordinator.cancelAllTasks === 'function') {
                        coordinator.cancelAllTasks('Application shutting down');
                    }
                }

                // 2. Stop audio synthesis and speech processing
                const kokoro = this.services.get('kokoro');
                if (kokoro) {
                    try {
                        if (typeof kokoro.stop === 'function') kokoro.stop();
                        if (typeof kokoro.dispose === 'function') kokoro.dispose();
                    } catch (_) {}
                }

                const whisper = this.services.get('whisper');
                if (whisper) {
                    try {
                        if (typeof whisper.dispose === 'function') whisper.dispose();
                    } catch (_) {}
                }

                // 3. Close browser automation sessions
                const browserManager = this.services.get('browserManager');
                if (browserManager && typeof browserManager.closeAll === 'function') {
                    try {
                        await browserManager.closeAll();
                    } catch (_) {}
                }

                // 4. Terminate native UI Automation worker cleanly
                const desktopManager = this.services.get('desktopManager');
                if (desktopManager && typeof desktopManager.cleanup === 'function') {
                    try {
                        desktopManager.cleanup();
                    } catch (_) {}
                }

                // 5. Cancel all pending permission confirmation gates
                const permissionAuthority = this.services.get('permissionAuthority');
                if (permissionAuthority && typeof permissionAuthority.cancelAllPendingConfirmations === 'function') {
                    try {
                        permissionAuthority.cancelAllPendingConfirmations('Application shutting down');
                    } catch (_) {}
                }

                // 6. Stop scheduler
                const scheduler = this.services.get('scheduler');
                if (scheduler && typeof scheduler.dispose === 'function') {
                    try {
                        scheduler.dispose();
                    } catch (_) {}
                }

                // 7. Close storage & SQLite adapters
                const memoryStore = this.services.get('memoryStore');
                if (memoryStore && typeof memoryStore.close === 'function') {
                    try {
                        memoryStore.close();
                    } catch (_) {}
                }

                // 8. Clean up tray
                const tray = this.services.get('tray');
                if (tray && typeof tray.destroy === 'function' && !tray.isDestroyed?.()) {
                    try {
                        tray.destroy();
                    } catch (_) {}
                }

                // 9. Destroy floating companion window
                const companion = this.services.get('floatingCompanion');
                if (companion && typeof companion.destroy === 'function') {
                    try {
                        companion.destroy();
                    } catch (_) {}
                }

                // 10. Close main window
                const mainWindow = this.services.get('mainWindow');
                if (mainWindow && !mainWindow.isDestroyed?.()) {
                    try {
                        if (typeof mainWindow.destroy === 'function') {
                            mainWindow.destroy();
                        }
                    } catch (_) {}
                }

                clearTimeout(shutdownTimer);
                this._forceTerminateTrackedPids();
                this._finalizeExit();
            } catch (err) {
                this.logger.warn?.('[Lifecycle] Error during clean shutdown execution:', err.message);
                clearTimeout(shutdownTimer);
                this._finalizeExit();
            }
        })();

        return this.shutdownPromise;
    }

    /**
     * Terminate specific Lucy-owned child processes if they failed to exit cleanly
     * strictly by PID — never by broad process name matching.
     */
    _forceTerminateTrackedPids() {
        const desktopManager = this.services.get('desktopManager');
        if (desktopManager?.proc?.pid && !desktopManager.proc.killed) {
            try {
                process.kill(desktopManager.proc.pid, 'SIGKILL');
            } catch (_) {}
        }

        const kokoro = this.services.get('kokoro');
        if (kokoro?.workerProcess?.pid && !kokoro.workerProcess.killed) {
            try {
                process.kill(kokoro.workerProcess.pid, 'SIGKILL');
            } catch (_) {}
        }
    }

    _finalizeExit() {
        this.transitionTo(LIFECYCLE_STATES.STOPPED, { final: true });
        const app = this.services.get('app');
        if (app && typeof app.exit === 'function') {
            try {
                app.exit(0);
            } catch (_) {
                if (typeof app.quit === 'function') app.quit();
            }
        }
    }
}

module.exports = {
    ApplicationLifecycleManager,
    LIFECYCLE_STATES,
    CLOSE_ACTIONS,
    ALLOWED_TRANSITIONS
};
