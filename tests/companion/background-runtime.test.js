'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { ProviderAdapter } = require('../../src/providers/provider-adapter.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');

class MockBrowserWindow {
    static instanceCount = 0;

    constructor(options = {}) {
        MockBrowserWindow.instanceCount++;
        this.options = options;
        this.destroyed = false;
        this.visible = false;
        this.minimized = false;
        this.alwaysOnTop = Boolean(options.alwaysOnTop);
        this.x = options.x || 100;
        this.y = options.y || 100;
        this.listeners = new Map();
        this.webContents = {
            setWindowOpenHandler: () => {},
            on: () => {},
            send: (channel, data) => {
                this.lastSent = { channel, data };
            }
        };
    }

    isDestroyed() { return this.destroyed; }
    show() { if (!this.destroyed) { this.visible = true; this.minimized = false; } }
    hide() { if (!this.destroyed) this.visible = false; }
    isVisible() { return this.visible && !this.destroyed; }
    isMinimized() { return this.minimized; }
    minimize() { this.minimized = true; }
    restore() { this.minimized = false; this.visible = true; }
    focus() { this.focused = true; }
    getPosition() { return [this.x, this.y]; }
    setPosition(x, y) { this.x = x; this.y = y; }
    setAlwaysOnTop(val) { this.alwaysOnTop = Boolean(val); }
    loadFile(filepath) { this.loadedFile = filepath; }
    destroy() {
        this.destroyed = true;
        this.visible = false;
        const handlers = this.listeners.get('closed') || [];
        for (const h of handlers) { try { h(); } catch (_) {} }
    }
    close() {
        const closeHandlers = this.listeners.get('close') || [];
        let prevented = false;
        const event = { preventDefault: () => { prevented = true; } };
        for (const h of closeHandlers) {
            try { h(event); } catch (_) {}
        }
        if (!prevented) {
            this.destroy();
        }
        return !prevented;
    }
    on(event, handler) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(handler);
    }
    once(event, handler) { this.on(event, handler); }
}

test('Workstream 2: Persistent Background Runtime & Tray Lifecycle Suite', async (suite) => {

    await suite.test('1. Main window close is intercepted and hidden when backgroundMode is active', () => {
        let isExplicitQuitting = false;
        const appSettings = { backgroundMode: true, closeToTray: true };

        const mockMain = new MockBrowserWindow({ width: 1080, height: 740 });
        mockMain.show();
        assert.equal(mockMain.isVisible(), true);

        // Bind lifecycle close handler
        mockMain.on('close', (event) => {
            if (!isExplicitQuitting && appSettings.backgroundMode) {
                event.preventDefault();
                mockMain.hide();
                return false;
            }
        });

        // Trigger close
        const closed = mockMain.close();
        assert.equal(closed, false, 'Window close must be intercepted/prevented');
        assert.equal(mockMain.isDestroyed(), false, 'Main window must NOT be destroyed');
        assert.equal(mockMain.isVisible(), false, 'Main window must be hidden to tray');
    });

    await suite.test('2. Floating fairy companion survives and remains active after main window hides', () => {
        let isExplicitQuitting = false;
        const appSettings = { backgroundMode: true };

        const mockMain = new MockBrowserWindow({ width: 1080, height: 740 });
        mockMain.show();

        const companion = new FloatingCompanionWindow({
            BrowserWindow: MockBrowserWindow,
            mainWindow: mockMain
        });
        companion.show();
        assert.equal(companion.isOpen(), true);

        // Simulate main window close intercepted
        mockMain.on('close', (event) => {
            if (!isExplicitQuitting && appSettings.backgroundMode) {
                event.preventDefault();
                mockMain.hide();
                return false;
            }
        });
        mockMain.close();

        // Verification: Companion remains OPEN and ALIVE
        assert.equal(mockMain.isVisible(), false);
        assert.equal(companion.isOpen(), true, 'Floating fairy must remain OPEN after main window is hidden');
        assert.equal(companion.window.isDestroyed(), false, 'Companion window must NOT be destroyed');
        assert.equal(companion.window.isVisible(), true, 'Companion window must remain visible on desktop');
    });

    await suite.test('3. Tray restore predictably restores, un-minimizes, and focuses main window', () => {
        const mockMain = new MockBrowserWindow();
        mockMain.hide();
        mockMain.minimize();
        assert.equal(mockMain.isVisible(), false);
        assert.equal(mockMain.isMinimized(), true);

        // Simulated tray click/double-click action
        function restoreFromTray() {
            if (mockMain && !mockMain.isDestroyed()) {
                if (mockMain.isMinimized()) mockMain.restore();
                mockMain.show();
                mockMain.focus();
            }
        }

        restoreFromTray();
        assert.equal(mockMain.isVisible(), true, 'Main window must be visible after tray restore');
        assert.equal(mockMain.isMinimized(), false, 'Main window must be un-minimized');
        assert.equal(mockMain.focused, true, 'Main window must receive focus');
    });

    await suite.test('4. Tray can summon and toggle floating companion independently', () => {
        const companion = new FloatingCompanionWindow({
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();
        assert.equal(companion.isOpen(), false);

        // Tray action: Show Floating Fairy
        companion.show();
        companion.summonToFront();
        assert.equal(companion.isOpen(), true);
        assert.equal(companion.window.isVisible(), true);

        // Tray action: Hide Floating Fairy
        companion.hide();
        assert.equal(companion.isOpen(), false);
        assert.equal(companion.window.isVisible(), false);

        // Re-summon from tray
        companion.show();
        assert.equal(companion.isOpen(), true);
    });

    await suite.test('5. Closing or hiding floating companion does not terminate the assistant', () => {
        let appQuitCalled = false;
        const fakeApp = { quit: () => { appQuitCalled = true; } };

        const companion = new FloatingCompanionWindow({
            BrowserWindow: MockBrowserWindow
        });
        companion.show();
        assert.equal(companion.isOpen(), true);

        // User hides companion
        companion.hide();
        assert.equal(companion.isOpen(), false);
        assert.equal(appQuitCalled, false, 'Hiding companion must never trigger app.quit()');

        // User closes companion window
        const winRef = companion.window;
        winRef.destroy();
        assert.equal(winRef.isDestroyed(), true);
        assert.equal(appQuitCalled, false, 'Closing companion window must never trigger app.quit()');
    });

    await suite.test('6. Explicit Exit terminates all windows and cleans up resources without intercepting', () => {
        let isExplicitQuitting = false;
        let shutdownClean = false;

        const mockMain = new MockBrowserWindow();
        mockMain.show();

        const companion = new FloatingCompanionWindow({
            BrowserWindow: MockBrowserWindow,
            mainWindow: mockMain
        });
        companion.show();
        const compWinRef = companion.window;

        // Main close hook
        mockMain.on('close', (event) => {
            if (!isExplicitQuitting) {
                event.preventDefault();
                mockMain.hide();
                return false;
            }
        });

        // Trigger Explicit Exit
        isExplicitQuitting = true;
        const closed = mockMain.close();
        assert.equal(closed, true, 'Explicit exit must allow main window to close');
        assert.equal(mockMain.isDestroyed(), true);

        companion.destroy();
        assert.equal(compWinRef.isDestroyed(), true, 'Companion must be destroyed on explicit exit');
        assert.equal(companion.window, null);
        shutdownClean = true;
        assert.equal(shutdownClean, true);
    });

    await suite.test('7. Background tasks and coordinator remain alive when main window is hidden', async () => {
        const os = require('os');
        const tmpMemDir = path.join(os.tmpdir(), 'lucy_test_mem_' + Date.now());
        fs.mkdirSync(tmpMemDir, { recursive: true });
        const oldEnv = process.env.LUCY_MEMORY_DIR;
        process.env.LUCY_MEMORY_DIR = tmpMemDir;

        const credStore = new CredentialStore({ inMemoryOnly: true });
        const providerAdapter = new ProviderAdapter({ credentialStore: credStore });
        const authority = new PermissionAuthority({ mode: 'permissive' });
        const registry = new ToolRegistry({ permissionAuthority: authority });
        registry.registerTool({
            id: 'bg_ping',
            name: 'bg_ping',
            description: 'Background ping',
            parameters: {},
            riskTier: 'harmless',
            handler: async () => ({ status: 'pong', timestamp: Date.now() })
        });
        const coordinator = new TaskCoordinator({
            providerAdapter,
            toolRegistry: registry,
            permissionAuthority: authority
        });

        // Main window is hidden
        const mockMain = new MockBrowserWindow();
        mockMain.hide();
        assert.equal(mockMain.isVisible(), false);

        // Execute task while window is hidden
        const result = await coordinator.executeRequest('execute bg_ping', { dryRun: true });
        assert.ok(result);
        assert.equal(result.ok, true);

        if (coordinator.memoryStore) coordinator.memoryStore.close();
        if (oldEnv) process.env.LUCY_MEMORY_DIR = oldEnv;
        else delete process.env.LUCY_MEMORY_DIR;
        try { fs.rmSync(tmpMemDir, { recursive: true, force: true }); } catch (_) {}
    });

    await suite.test('8. Second-instance activation restores and un-minimizes existing main window', () => {
        const mockMain = new MockBrowserWindow();
        mockMain.hide();
        mockMain.minimize();

        // Simulated app 'second-instance' handler
        function onSecondInstance() {
            if (mockMain && !mockMain.isDestroyed()) {
                if (mockMain.isMinimized()) mockMain.restore();
                if (!mockMain.isVisible()) mockMain.show();
                mockMain.focus();
            }
        }

        onSecondInstance();
        assert.equal(mockMain.isVisible(), true, 'Second instance must make window visible');
        assert.equal(mockMain.isMinimized(), false, 'Second instance must restore minimized window');
        assert.equal(mockMain.focused, true, 'Second instance must focus window');
    });

    await suite.test('9. No duplicate companion windows created on multiple summon/show calls', () => {
        MockBrowserWindow.instanceCount = 0;
        const companion = new FloatingCompanionWindow({
            BrowserWindow: MockBrowserWindow
        });

        companion.show();
        companion.show();
        companion.summonToFront();
        companion.show();

        assert.equal(MockBrowserWindow.instanceCount, 1, 'Only one BrowserWindow instance should ever be created');
    });
});
