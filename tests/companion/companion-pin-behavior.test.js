'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');

/**
 * Mock Electron BrowserWindow providing realistic tracking of:
 * - alwaysOnTop and alwaysOnTopLevel
 * - focus, show, hide, showInactive
 * - webContents IPC broadcasts
 */
class RealisticMockBrowserWindow {
    constructor(options = {}) {
        this.options = options;
        this.destroyed = false;
        this.visible = false;
        this.focused = false;
        this.focusCount = 0;
        this.showCount = 0;
        this.showInactiveCount = 0;
        this.x = options.x || 100;
        this.y = options.y || 100;
        this.width = options.width || FloatingCompanionWindow.DEFAULT_WIDTH;
        this.height = options.height || FloatingCompanionWindow.DEFAULT_HEIGHT;
        this.alwaysOnTop = Boolean(options.alwaysOnTop);
        this.alwaysOnTopLevel = options.alwaysOnTop ? 'screen-saver' : 'normal';
        this.throwOnAlwaysOnTop = false;

        this.eventListeners = {};
        this.sentMessages = [];

        this.webContents = {
            send: (channel, data) => {
                this.sentMessages.push({ channel, data });
            },
            setWindowOpenHandler: () => {},
            on: () => {}
        };
    }

    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isVisible() { return this.visible; }

    show() {
        this.visible = true;
        this.focused = true;
        this.showCount++;
    }

    showInactive() {
        this.visible = true;
        this.focused = false; // Does NOT steal focus!
        this.showInactiveCount++;
    }

    hide() {
        this.visible = false;
        this.focused = false;
    }

    focus() {
        this.focused = true;
        this.focusCount++;
    }

    restore() {
        this.restored = true;
        if (this.eventListeners['restore']) {
            this.eventListeners['restore'].forEach(fn => fn());
        }
    }

    getPosition() { return [this.x, this.y]; }
    getSize() { return [this.width, this.height]; }
    getContentSize() { return [this.width, this.height]; }

    setSize(w, h) {
        this.width = w;
        this.height = h;
    }

    setContentSize(w, h) {
        this.width = w;
        this.height = h;
    }

    setPosition(x, y) {
        this.x = x;
        this.y = y;
    }

    setAlwaysOnTop(val, level) {
        if (this.throwOnAlwaysOnTop) {
            throw new Error('OS native error: unable to set topmost window flag');
        }
        this.alwaysOnTop = Boolean(val);
        this.alwaysOnTopLevel = level || (val ? 'screen-saver' : 'normal');
    }

    isAlwaysOnTop() {
        return Boolean(this.alwaysOnTop);
    }

    loadFile() {}

    on(ev, cb) {
        if (!this.eventListeners[ev]) this.eventListeners[ev] = [];
        this.eventListeners[ev].push(cb);
    }

    once(ev, cb) {
        if (ev === 'ready-to-show') {
            setTimeout(cb, 1);
        }
    }

    destroy() {
        this.destroyed = true;
        this.visible = false;
        this.focused = false;
    }
}

/**
 * Mock Main Window for testing IPC synchronization
 */
function createMockMainWindow() {
    return {
        isDestroyed: () => false,
        webContents: {
            sentMessages: [],
            send: function (channel, data) {
                this.sentMessages.push({ channel, data });
            }
        }
    };
}

test('L.U.C.Y. Repair 7: Reliable Pin and Always-on-Top Behavior Suite', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-pin-test-'));
    const boundsFile = path.join(tempDir, 'test-companion-bounds.json');

    t.after(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test('1. Authoritative pin/unpin state transitions and native level', async () => {
        const mockMain = createMockMainWindow();
        let trayNotifiedState = null;

        const floating = new FloatingCompanionWindow({
            BrowserWindow: RealisticMockBrowserWindow,
            boundsFile,
            mainWindow: mockMain,
            onPinChanged: (pinned) => {
                trayNotifiedState = pinned;
            }
        });

        const win = floating.createWindow();
        assert.ok(win, 'BrowserWindow was created');
        assert.strictEqual(win.isAlwaysOnTop(), true, 'Window starts pinned with topmost = true');
        assert.strictEqual(win.alwaysOnTopLevel, 'screen-saver', 'Pinned level must be screen-saver');

        // Unpin
        const unpinnedResult = floating.setPinned(false);
        assert.strictEqual(unpinnedResult, false, 'setPinned(false) must return false');
        assert.strictEqual(floating.isPinned, false, 'Authoritative isPinned must be false');
        assert.strictEqual(win.isAlwaysOnTop(), false, 'Native window topmost must be false');
        assert.strictEqual(win.alwaysOnTopLevel, 'normal', 'Unpinned level must be normal');
        assert.strictEqual(trayNotifiedState, false, 'Tray was notified of unpin');

        // Re-pin
        const repinnedResult = floating.setPinned(true);
        assert.strictEqual(repinnedResult, true, 'setPinned(true) must return true');
        assert.strictEqual(floating.isPinned, true, 'Authoritative isPinned must be true');
        assert.strictEqual(win.isAlwaysOnTop(), true, 'Native window topmost must be true');
        assert.strictEqual(win.alwaysOnTopLevel, 'screen-saver', 'Re-pinned level must be screen-saver');
        assert.strictEqual(trayNotifiedState, true, 'Tray was notified of pin');

        // Toggle
        const toggleRes1 = floating.togglePin();
        assert.strictEqual(toggleRes1.ok, true);
        assert.strictEqual(toggleRes1.isPinned, false);
        assert.strictEqual(win.isAlwaysOnTop(), false);

        const toggleRes2 = floating.togglePin();
        assert.strictEqual(toggleRes2.ok, true);
        assert.strictEqual(toggleRes2.isPinned, true);
        assert.strictEqual(win.isAlwaysOnTop(), true);

        floating.destroy();
    });

    await t.test('2. Native setAlwaysOnTop failure handling and honest state reporting', async () => {
        const mockMain = createMockMainWindow();
        const floating = new FloatingCompanionWindow({
            BrowserWindow: RealisticMockBrowserWindow,
            boundsFile,
            mainWindow: mockMain
        });

        const win = floating.createWindow();
        floating.setPinned(false); // Start unpinned
        assert.strictEqual(floating.isPinned, false);

        // Simulate native OS failure
        win.throwOnAlwaysOnTop = true;

        // Attempting to pin should honestly fail and NOT report a false pinned state
        const res = floating.setPinned(true);
        assert.strictEqual(res, false, 'setPinned must revert to previous state and not claim success');
        assert.strictEqual(floating.isPinned, false, 'Authoritative state must not be false-pinned');
        assert.strictEqual(win.isAlwaysOnTop(), false, 'Window is not topmost');

        win.throwOnAlwaysOnTop = false;
        floating.destroy();
    });

    await t.test('3. UI state synchronization across companion, main window, and tray', async () => {
        const mockMain = createMockMainWindow();
        const trayEvents = [];

        const floating = new FloatingCompanionWindow({
            BrowserWindow: RealisticMockBrowserWindow,
            boundsFile,
            mainWindow: mockMain,
            onPinChanged: (pinned) => {
                trayEvents.push(pinned);
            }
        });

        const win = floating.createWindow();
        await new Promise(resolve => setTimeout(resolve, 20));

        // Check companion webContents messages
        const companionPinMsgs = win.sentMessages.filter(m => m.channel === 'companion:pinChanged');
        assert.ok(companionPinMsgs.length >= 1, 'Companion renderer received pinChanged');

        // Check main window IPC messages
        const mainPinMsgs = mockMain.webContents.sentMessages.filter(m => m.channel === 'lucy:companionPinChanged');
        assert.ok(mainPinMsgs.length >= 1, 'Main window received lucy:companionPinChanged');

        // Toggle from companion
        floating.setPinned(false);

        const lastCompanionMsg = win.sentMessages.filter(m => m.channel === 'companion:pinChanged').pop();
        assert.deepStrictEqual(lastCompanionMsg.data, { isPinned: false });

        const lastMainMsg = mockMain.webContents.sentMessages.filter(m => m.channel === 'lucy:companionPinChanged').pop();
        assert.deepStrictEqual(lastMainMsg.data, { isPinned: false });

        assert.strictEqual(trayEvents[trayEvents.length - 1], false);

        floating.destroy();
    });

    await t.test('4. Dock and undock transitions preserve pinned state', async () => {
        const mockMain = createMockMainWindow();
        const floating = new FloatingCompanionWindow({
            BrowserWindow: RealisticMockBrowserWindow,
            boundsFile,
            mainWindow: mockMain
        });

        const win = floating.createWindow();
        floating.setPinned(true);
        assert.strictEqual(floating.isPinned, true);
        assert.strictEqual(win.isAlwaysOnTop(), true);

        // 1. Dock Lucy into app (hide)
        floating.hide();
        assert.strictEqual(win.isVisible(), false, 'Window is hidden');
        assert.strictEqual(win.isAlwaysOnTop(), false, 'Hidden window releases topmost to avoid ghost layering');
        assert.strictEqual(floating.isPinned, true, 'isPinned configuration remains authoritatively true');

        // 2. Undock Lucy (show)
        floating.show();
        assert.strictEqual(win.isVisible(), true, 'Window is visible again');
        assert.strictEqual(win.isAlwaysOnTop(), true, 'Undocked window reasserts native topmost = true');
        assert.strictEqual(win.alwaysOnTopLevel, 'screen-saver', 'Undocked window reasserts screen-saver level');
        assert.strictEqual(floating.isPinned, true, 'isPinned remains true');

        floating.destroy();
    });

    await t.test('5. Non-activating presentation does not steal keyboard focus', async () => {
        const mockMain = createMockMainWindow();
        const floating = new FloatingCompanionWindow({
            BrowserWindow: RealisticMockBrowserWindow,
            boundsFile,
            mainWindow: mockMain
        });

        const win = floating.createWindow();

        // Trigger ready-to-show callback
        await new Promise(resolve => setTimeout(resolve, 20));

        // Window was shown using showInactive, NOT show
        assert.strictEqual(win.showInactiveCount >= 1, true, 'Window presented via showInactive()');
        assert.strictEqual(win.focused, false, 'Keyboard focus was NOT stolen');

        // Calling show() without activate option also uses non-activating approach
        win.focused = false;
        floating.show();
        assert.strictEqual(win.focused, false, 'Passive show() did NOT steal focus');

        floating.destroy();
    });

    await t.test('6. Window recreation and restart persistence preserve pin state', async () => {
        // Step 1: Create window, unpin, destroy
        {
            const floating1 = new FloatingCompanionWindow({
                BrowserWindow: RealisticMockBrowserWindow,
                boundsFile
            });
            floating1.createWindow();
            floating1.setPinned(false);
            floating1.destroy();
        }

        // Step 2: Recreate from saved bounds
        {
            const floating2 = new FloatingCompanionWindow({
                BrowserWindow: RealisticMockBrowserWindow,
                boundsFile
            });
            assert.strictEqual(floating2.isPinned, false, 'Unpinned state persisted across recreation');
            const win2 = floating2.createWindow();
            assert.strictEqual(win2.isAlwaysOnTop(), false, 'New native window correctly initialized as unpinned');
            floating2.destroy();
        }

        // Step 3: Re-pin and verify persistence again
        {
            const floating3 = new FloatingCompanionWindow({
                BrowserWindow: RealisticMockBrowserWindow,
                boundsFile
            });
            floating3.createWindow();
            floating3.setPinned(true);
            floating3.destroy();
        }

        {
            const floating4 = new FloatingCompanionWindow({
                BrowserWindow: RealisticMockBrowserWindow,
                boundsFile
            });
            assert.strictEqual(floating4.isPinned, true, 'Pinned state persisted across recreation');
            const win4 = floating4.createWindow();
            assert.strictEqual(win4.isAlwaysOnTop(), true, 'New native window correctly initialized as pinned');
            floating4.destroy();
        }
    });

    await t.test('7. Passive visual updates and resizing do not alter pin state or steal focus', async () => {
        const mockMain = createMockMainWindow();
        const floating = new FloatingCompanionWindow({
            BrowserWindow: RealisticMockBrowserWindow,
            boundsFile,
            mainWindow: mockMain
        });

        const win = floating.createWindow();
        floating.setPinned(true);
        win.focused = false;
        const initialFocusCount = win.focusCount;

        // Visual and animation updates
        floating.sendVisualUpdate({ emotion: 'speaking' });
        floating.sendVisualUpdate({ emotion: 'listening' });
        floating.sendVisualUpdate({ emotion: 'idle' });
        floating.sendVoiceUpdate({ isSpeaking: true });

        // Resize window
        floating.setWindowSize(200, 240, false);

        assert.strictEqual(floating.isPinned, true, 'Pin state untouched by animations or resizing');
        assert.strictEqual(win.isAlwaysOnTop(), true, 'Native topmost remains intact');
        assert.strictEqual(win.focusCount, initialFocusCount, 'Focus was never stolen during passive updates');
        assert.strictEqual(win.focused, false, 'Window remained unfocused');

        floating.destroy();
    });

    await t.test('8. OS window restore event automatically reasserts topmost state', async () => {
        const mockMain = createMockMainWindow();
        const floating = new FloatingCompanionWindow({
            BrowserWindow: RealisticMockBrowserWindow,
            boundsFile,
            mainWindow: mockMain
        });

        const win = floating.createWindow();
        floating.setPinned(true);
        assert.strictEqual(win.isAlwaysOnTop(), true);

        // Simulate Windows OS temporarily dropping topmost on minimize
        win.alwaysOnTop = false;

        // Trigger restore event
        win.restore();

        // The restore listener must have reasserted alwaysOnTop
        assert.strictEqual(win.isAlwaysOnTop(), true, 'Restore event reasserted native topmost');
        assert.strictEqual(win.alwaysOnTopLevel, 'screen-saver', 'Reasserted screen-saver level');

        floating.destroy();
    });
});
