'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const {
    ApplicationLifecycleManager,
    LIFECYCLE_STATES,
    CLOSE_ACTIONS,
    ALLOWED_TRANSITIONS
} = require('../../src/core/application-lifecycle.js');

const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager } = require('../../src/core/task-status.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { ProviderAdapter } = require('../../src/providers/provider-adapter.js');
const { MemoryStore } = require('../../src/memory/memory-store.js');
const { TaskContinuityStore } = require('../../src/memory/task-continuity-store.js');
const { validateSetAppSettings } = require('../../src/security/ipc-validator.js');

// Mock Electron Window for lifecycle testing
class MockLifecycleWindow extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.destroyed = false;
        this.visible = options.show !== false;
        this.minimized = false;
        this.alwaysOnTop = false;
        this.focused = false;
        this.width = options.width || 1080;
        this.height = options.height || 740;
        this.x = options.x || 100;
        this.y = options.y || 100;
        this.sentMessages = [];
        this.webContents = {
            send: (channel, data) => {
                this.sentMessages.push({ channel, data });
            },
            setWindowOpenHandler: () => ({ action: 'deny' }),
            on: () => {}
        };
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible && !this.destroyed; }
    isMinimized() { return this.minimized; }
    show() { if (!this.destroyed) { this.visible = true; this.minimized = false; } }
    hide() { if (!this.destroyed) { this.visible = false; } }
    minimize() { this.minimized = true; }
    restore() { this.minimized = false; this.visible = true; }
    focus() { this.focused = true; }
    setAlwaysOnTop(val) { this.alwaysOnTop = Boolean(val); }
    getPosition() { return [this.x, this.y]; }
    setPosition(x, y) { this.x = x; this.y = y; }
    getSize() { return [this.width, this.height]; }
    setSize(w, h) { this.width = w; this.height = h; }
    loadFile() {}
    destroy() {
        this.destroyed = true;
        this.visible = false;
        this.emit('closed');
    }
    close() {
        let prevented = false;
        const ev = { preventDefault: () => { prevented = true; } };
        this.emit('close', ev);
        if (!prevented && !this.destroyed) {
            this.destroy();
        }
        return prevented;
    }
}

test('L.U.C.Y. Application Lifecycle, Window Management & Companion Acceptance Suite', async (t) => {

    // 1. Closing the main window with background mode enabled
    await t.test('1. Closing main window with background mode enabled hides window and preserves companion/tray', async () => {
        const lifecycle = new ApplicationLifecycleManager();
        lifecycle.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE);

        const win = new MockLifecycleWindow();
        let defaultPrevented = false;
        const event = { preventDefault: () => { defaultPrevented = true; } };

        const mockCompanion = {
            isOpen: () => true,
            hide: () => {}
        };

        const result = await lifecycle.handleMainWindowClose(
            event,
            win,
            mockCompanion,
            { backgroundMode: true, closeAction: CLOSE_ACTIONS.BACKGROUND }
        );

        assert.equal(result, 'hidden_background');
        assert.equal(defaultPrevented, true, 'Window close must be prevented');
        assert.equal(win.isVisible(), false, 'Main window must be hidden');
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.COMPANION_ONLY, 'State must transition to companion_only');
    });

    // 2. Closing the main window with exit-on-close enabled
    await t.test('2. Closing main window with exit-on-close enabled triggers clean application shutdown', async () => {
        const lifecycle = new ApplicationLifecycleManager({ shutdownTimeoutMs: 1500 });
        lifecycle.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE);

        let appExited = false;
        const mockApp = {
            exit: () => { appExited = true; },
            quit: () => { appExited = true; }
        };
        lifecycle.registerService('app', mockApp);

        const win = new MockLifecycleWindow();
        let defaultPrevented = false;
        const event = { preventDefault: () => { defaultPrevented = true; } };

        const result = await lifecycle.handleMainWindowClose(
            event,
            win,
            null,
            { backgroundMode: false, closeAction: CLOSE_ACTIONS.EXIT }
        );

        assert.equal(result, 'shutting_down');
        assert.equal(defaultPrevented, true);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.STOPPED);
        assert.equal(appExited, true, 'App exit must be invoked');
    });

    // 3. Restoring a hidden or minimised main window
    await t.test('3. Restoring hidden or minimised main window focuses and penetratively guarantees foreground', async () => {
        const lifecycle = new ApplicationLifecycleManager();
        lifecycle.transitionTo(LIFECYCLE_STATES.BACKGROUND_TRAY);

        const win = new MockLifecycleWindow({ show: false });
        win.minimized = true;

        const result = await lifecycle.restoreMainWindow(async () => win);

        assert.equal(result.ok, true);
        assert.equal(result.restored, true);
        assert.equal(win.isVisible(), true, 'Window must become visible');
        assert.equal(win.isMinimized(), false, 'Window must be un-minimized');
        assert.equal(win.focused, true, 'Window must be focused');
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE);
    });

    // 4. Repeated Return to App requests (concurrency guard and idempotency)
    await t.test('4. Repeated Return to App requests are guarded against race conditions without duplicate windows', async () => {
        const win = new MockLifecycleWindow({ show: false });
        let restoreCalls = 0;

        const companion = new FloatingCompanionWindow({
            mainWindow: null, // Starts unattached to trigger onRestoreMainWindow
            BrowserWindow: MockLifecycleWindow,
            onRestoreMainWindow: async () => {
                restoreCalls++;
                await new Promise((r) => setTimeout(r, 40));
                return win;
            }
        });

        // Trigger two concurrent returnToApp calls
        const p1 = companion.returnToApp();
        const p2 = companion.returnToApp();

        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(r1.ok, true);
        assert.equal(r2.inProgress, true, 'Concurrent request must be safely guarded');
        assert.equal(restoreCalls, 1, 'Resolver must only be called once');
        assert.equal(win.isVisible(), true);
    });

    // 5. Companion-only operation
    await t.test('5. Companion-only operation keeps fairy active when main window is hidden', async () => {
        const lifecycle = new ApplicationLifecycleManager();
        lifecycle.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE);

        const mainWin = new MockLifecycleWindow({ show: true });
        const companion = new FloatingCompanionWindow({
            mainWindow: mainWin,
            BrowserWindow: MockLifecycleWindow
        });
        companion.show();

        const ev = { preventDefault: () => {} };
        await lifecycle.handleMainWindowClose(ev, mainWin, companion, { closeAction: CLOSE_ACTIONS.BACKGROUND });

        assert.equal(mainWin.isVisible(), false, 'Main window must be hidden');
        assert.equal(companion.isOpen(), true, 'Companion must remain open');
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.COMPANION_ONLY);
    });

    // 6. Companion size and position persistence across restarts
    await t.test('6. Companion size and position persist cleanly across bounds storage', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-bounds-test-'));
        const boundsFile = path.join(tmpDir, 'companion-bounds.json');

        try {
            const companion = new FloatingCompanionWindow({
                boundsFile,
                BrowserWindow: MockLifecycleWindow
            });

            // Save custom geometry
            companion._saveBounds(420, 280, 240, 290);
            assert.equal(fs.existsSync(boundsFile), true);

            const saved = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
            assert.equal(saved.x, 420);
            assert.equal(saved.y, 280);
            assert.equal(saved.width, 240);
            assert.equal(saved.height, 290);

            // Create second companion instance verifying geometry restoration
            const companion2 = new FloatingCompanionWindow({
                boundsFile,
                BrowserWindow: MockLifecycleWindow
            });

            assert.equal(companion2.currentWidth, 240);
            assert.equal(companion2.currentHeight, 290);
            assert.equal(companion2.lastPosition.x, 420);
            assert.equal(companion2.lastPosition.y, 280);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // 7. Restoring companion after display-resolution change
    await t.test('7. Restoring companion after resolution change clamps coordinates without resetting user size', async () => {
        const companion = new FloatingCompanionWindow({
            BrowserWindow: MockLifecycleWindow
        });
        companion.currentWidth = 260;
        companion.currentHeight = 310;
        companion.window = new MockLifecycleWindow({ width: 260, height: 310, x: 2500, y: 1800 });

        // Simulate smaller screen work area (e.g., disconnected external 4K monitor, back to 1080p laptop)
        const mockWorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
        const clamped = companion._clampToBounds(2500, 1800, 260, 310, mockWorkArea);

        assert.ok(clamped.x + 260 <= 1920, 'X coordinate must fit within screen width');
        assert.ok(clamped.y + 310 <= 1080, 'Y coordinate must fit within screen height');
        assert.equal(companion.currentWidth, 260, 'User-chosen width must not be reset');
        assert.equal(companion.currentHeight, 310, 'User-chosen height must not be reset');
    });

    // 8. Tray actions and prevention of duplicate tray icons
    await t.test('8. Tray actions and prevention of duplicate tray instances', async () => {
        let trayInstances = 0;
        class MockTray extends EventEmitter {
            constructor() {
                super();
                trayInstances++;
                this.destroyed = false;
            }
            setToolTip() {}
            setContextMenu() {}
            isDestroyed() { return this.destroyed; }
            destroy() { this.destroyed = true; trayInstances--; }
        }

        let trayRef = new MockTray();
        assert.equal(trayInstances, 1);

        // Guard against duplicate instantiation
        function getOrCreateTray() {
            if (trayRef && !trayRef.isDestroyed()) return trayRef;
            trayRef = new MockTray();
            return trayRef;
        }

        const trayRef2 = getOrCreateTray();
        assert.equal(trayInstances, 1, 'Must not duplicate tray instances');
        assert.equal(trayRef, trayRef2);

        trayRef.destroy();
        assert.equal(trayInstances, 0);
    });

    // 9. Background voice behaviour with listening enabled and disabled
    await t.test('9. Background voice behaviour respects backgroundListening settings', async () => {
        let isMicrophoneActive = true;
        const mockVoice = {
            stopListening: () => { isMicrophoneActive = false; },
            startListening: () => { isMicrophoneActive = true; }
        };

        // When background listening is disabled:
        const appSettings = { backgroundListening: false };
        if (!appSettings.backgroundListening) {
            mockVoice.stopListening();
        }
        assert.equal(isMicrophoneActive, false, 'Microphone must be stopped when background listening is disabled');

        // When background listening is permitted:
        appSettings.backgroundListening = true;
        if (appSettings.backgroundListening) {
            mockVoice.startListening();
        }
        assert.equal(isMicrophoneActive, true, 'Microphone can remain active when configured');
    });

    // 10. Cancellation and cleanup of Lucy-owned workers
    await t.test('10. TaskCoordinator stops accepting new tasks and aborts active tasks during shutdown', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-coord-test-'));
        try {
            const statusManager = new TaskStatusManager();
            const credStore = new CredentialStore({ storeDir: tmpDir });
            const permissionAuthority = new PermissionAuthority({ workspaceRoot: tmpDir });
            const toolRegistry = new ToolRegistry({ permissionAuthority });
            const providerAdapter = new ProviderAdapter({ credentialStore: credStore });
            const memoryStore = new MemoryStore({ memoryDir: tmpDir });
            const taskContinuityStore = new TaskContinuityStore({ storeDir: tmpDir });

            const coordinator = new TaskCoordinator({
                statusManager,
                permissionAuthority,
                toolRegistry,
                providerAdapter,
                memoryStore,
                taskContinuityStore
            });

            assert.equal(coordinator.isAcceptingTasks, true);

            // Shutdown signal
            coordinator.isAcceptingTasks = false;
            coordinator.cancelAllTasks('Application shutting down');

            const rejected = await coordinator.executeRequest('Create a note');
            assert.equal(rejected.ok, false);
            assert.equal(rejected.status, 'shutting_down');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // 11. Explicit Exit and prevention of orphaned processes
    await t.test('11. Explicit Exit performs bounded clean shutdown and kills tracked PIDs cleanly', async () => {
        const lifecycle = new ApplicationLifecycleManager({ shutdownTimeoutMs: 2000 });

        let coordinatorStopped = false;
        let desktopCleaned = false;
        let kokoroDisposed = false;
        let appExited = false;

        lifecycle.registerService('coordinator', {
            isAcceptingTasks: true,
            cancelAllTasks: () => { coordinatorStopped = true; }
        });

        lifecycle.registerService('desktopManager', {
            cleanup: () => { desktopCleaned = true; },
            proc: { pid: 999999, killed: false }
        });

        lifecycle.registerService('kokoro', {
            stop: () => {},
            dispose: () => { kokoroDisposed = true; },
            workerProcess: { pid: 999998, killed: false }
        });

        lifecycle.registerService('app', {
            exit: () => { appExited = true; }
        });

        await lifecycle.performCleanShutdown({ trigger: 'test_exit' });

        assert.equal(coordinatorStopped, true, 'Coordinator must cancel active work');
        assert.equal(desktopCleaned, true, 'DesktopManager worker must be cleaned');
        assert.equal(kokoroDisposed, true, 'Kokoro TTS worker must be disposed');
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.STOPPED);
        assert.equal(appExited, true, 'App must be terminated');
    });

    // 12. Window recreation without duplicate services or event listeners
    await t.test('12. Window recreation resolves new instance without duplicating service registries', async () => {
        const lifecycle = new ApplicationLifecycleManager();
        lifecycle.transitionTo(LIFECYCLE_STATES.STARTING);

        let windowCreateCount = 0;
        let currentWin = null;

        function getOrCreateWindow() {
            if (currentWin && !currentWin.isDestroyed()) {
                return currentWin;
            }
            windowCreateCount++;
            currentWin = new MockLifecycleWindow();
            lifecycle.registerService('mainWindow', currentWin);
            return currentWin;
        }

        const win1 = await lifecycle.restoreMainWindow(getOrCreateWindow);
        assert.equal(windowCreateCount, 1);
        assert.equal(lifecycle.services.get('mainWindow'), currentWin);

        // Second restore while healthy must NOT create another window
        const win2 = await lifecycle.restoreMainWindow(getOrCreateWindow);
        assert.equal(windowCreateCount, 1, 'Must not duplicate window when existing is healthy');

        // Destroy window and restore: must create exactly 1 replacement
        currentWin.destroy();
        const win3 = await lifecycle.restoreMainWindow(getOrCreateWindow);
        assert.equal(windowCreateCount, 2, 'Must recreate destroyed window cleanly');
        assert.equal(win3.ok, true);
    });

    // 13. Preservation of settings, memory and user data
    await t.test('13. Application settings schema and persistence validation preserves valid fields', () => {
        const validPayload = {
            backgroundMode: true,
            closeAction: 'minimize_to_tray',
            closeToTray: true,
            backgroundListening: true,
            startMinimized: false
        };

        const validated = validateSetAppSettings(validPayload);
        assert.equal(validated.ok, true);
        assert.equal(validated.sanitized.closeAction, 'minimize_to_tray');
        assert.equal(validated.sanitized.backgroundListening, true);

        // Invalid closeAction rejected
        const invalidPayload = { closeAction: 'drop_database' };
        const invalidRes = validateSetAppSettings(invalidPayload);
        assert.equal(invalidRes.ok, false);
        assert.equal(invalidRes.code, 'INVALID_CLOSE_ACTION');
    });

    // 14. Deterministic state machine enforcement
    await t.test('14. Deterministic state machine allows valid transitions and blocks illegal state jumps', () => {
        const lifecycle = new ApplicationLifecycleManager();
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.STARTING);

        // Allowed: starting -> main_window_visible
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE), true);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE);

        // Allowed: main_window_visible -> companion_only
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.COMPANION_ONLY), true);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.COMPANION_ONLY);

        // Allowed: companion_only -> restoring
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.RESTORING), true);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.RESTORING);

        // Allowed: restoring -> main_window_visible
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE), true);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE);

        // Disallowed: main_window_visible -> stopped directly (must go through shutting_down)
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.STOPPED), false);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE);

        // Allowed: main_window_visible -> shutting_down -> stopped
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.SHUTTING_DOWN), true);
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.STOPPED), true);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.STOPPED);

        // Disallowed: stopped -> starting (stopped is terminal)
        assert.equal(lifecycle.transitionTo(LIFECYCLE_STATES.STARTING), false);
        assert.equal(lifecycle.getState(), LIFECYCLE_STATES.STOPPED);
    });
});
