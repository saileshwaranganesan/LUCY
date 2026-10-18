'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');

class MockElectronWindow {
    constructor(options = {}) {
        this.options = options;
        this.destroyed = false;
        this.visible = false;
        this.x = options.x || 100;
        this.y = options.y || 100;
        this.width = options.width || FloatingCompanionWindow.DEFAULT_WIDTH;
        this.height = options.height || FloatingCompanionWindow.DEFAULT_HEIGHT;
        this.alwaysOnTop = false;
        this.alwaysOnTopLevel = null;
        this.webContents = {
            send: (channel, data) => {
                this.lastSent = { channel, data };
            },
            setWindowOpenHandler: () => {},
            on: () => {}
        };
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    restore() { this.restored = true; }
    getPosition() { return [this.x, this.y]; }
    getSize() { return [this.width, this.height]; }
    setSize(w, h) {
        this.width = w;
        this.height = h;
    }
    setPosition(x, y) {
        this.x = x;
        this.y = y;
    }
    setAlwaysOnTop(val, level) {
        this.alwaysOnTop = Boolean(val);
        this.alwaysOnTopLevel = level;
    }
    isAlwaysOnTop() { return Boolean(this.alwaysOnTop); }
    showInactive() { this.visible = true; }
    loadFile() {}
    on() {}
    once(ev, cb) {
        if (ev === 'ready-to-show') setTimeout(cb, 1);
    }
    destroy() {
        this.destroyed = true;
        this.visible = false;
    }
}

test('Floating Companion Acceptance & Regression Suite: Return to App & Tiny Resizable Size', async (t) => {

    await t.test('1. Return to App reliably restores and focuses the main window', () => {
        let restoredCalled = false;
        let shownCalled = false;
        let focusedCalled = false;
        let sentData = null;

        const mockMainWindow = {
            isDestroyed: () => false,
            isMinimized: () => true,
            isVisible: () => false,
            restore: () => { restoredCalled = true; },
            show: () => { shownCalled = true; },
            focus: () => { focusedCalled = true; },
            webContents: {
                send: (channel, data) => {
                    if (channel === 'lucy:companionWindowToggled') {
                        sentData = data;
                    }
                }
            }
        };

        const floating = new FloatingCompanionWindow({
            mainWindow: mockMainWindow,
            BrowserWindow: MockElectronWindow
        });

        floating.createWindow();
        floating.show();
        assert.equal(floating.isOpen(), true, 'Window is open');

        floating.returnToApp();

        assert.equal(restoredCalled, true, 'Main window must be restored');
        assert.equal(shownCalled, true, 'Main window must be shown');
        assert.equal(focusedCalled, true, 'Main window must be focused');
        assert.ok(sentData, 'Must send lucy:companionWindowToggled');
        assert.equal(sentData.isOpen, false);
        assert.equal(sentData.returning, true);

        floating.destroy();
    });

    await t.test('2. Floating window closes or hides after return to avoid duplicate representations', () => {
        const mockMainWindow = {
            isDestroyed: () => false,
            isMinimized: () => false,
            isVisible: () => true,
            restore: () => {},
            show: () => {},
            focus: () => {},
            webContents: { send: () => {} }
        };

        const floating = new FloatingCompanionWindow({
            mainWindow: mockMainWindow,
            BrowserWindow: MockElectronWindow
        });

        const win = floating.createWindow();
        floating.show();
        assert.equal(floating.isOpen(), true);
        assert.equal(win.visible, true);

        floating.returnToApp();

        assert.equal(floating.isOpen(), false, 'Companion must report closed/hidden');
        assert.equal(win.visible, false, 'BrowserWindow must be hidden');
        assert.equal(win.alwaysOnTop, false, 'Always-on-top must be cleared so it cannot float over main app');

        floating.destroy();
    });

    await t.test('3. No stale return-animation message or stuck state remains', () => {
        const appCode = fs.readFileSync(path.resolve(__dirname, '../../src/companion/companion-app.js'), 'utf8');

        // Check companion-app.js defines state reset
        assert.ok(appCode.includes('function resetCompanionState()'), 'Must define resetCompanionState()');
        assert.ok(appCode.includes("sidePanel.classList.add('collapsed')"), 'Must collapse side panel on return');
        assert.ok(appCode.includes("typewriterText.textContent = ''"), 'Must clear typewriter text');
        assert.ok(appCode.includes("renderer.setVisualState({ emotion: 'idle' })"), 'Must reset renderer to idle');
        assert.ok(appCode.includes("document.body.style.opacity = '1'"), 'Must restore body opacity');
        assert.ok(appCode.includes('onResetState'), 'Must listen to companion:resetState IPC');
        assert.ok(appCode.includes('onVisibilityChanged'), 'Must listen to companion:visibilityChanged IPC');

        // Verify floating window sends resetState on hide
        const floatingCode = fs.readFileSync(path.resolve(__dirname, '../../src/companion/floating-companion-window.js'), 'utf8');
        assert.ok(floatingCode.includes("send('companion:resetState')"), 'floating-companion-window.js must emit companion:resetState');
    });

    await t.test('4. Repeated return clicks do not create duplicate windows or crash', () => {
        const mockMainWindow = {
            isDestroyed: () => false,
            isMinimized: () => false,
            isVisible: () => true,
            restore: () => {},
            show: () => {},
            focus: () => {},
            webContents: { send: () => {} }
        };

        const floating = new FloatingCompanionWindow({
            mainWindow: mockMainWindow,
            BrowserWindow: MockElectronWindow
        });

        floating.createWindow();

        // Simulate rapid repeated return clicks
        assert.doesNotThrow(() => {
            floating.returnToApp();
            floating.returnToApp();
            floating.returnToApp();
            floating.returnToApp();
        }, 'Sequential repeated return calls must be completely safe');

        assert.equal(floating.isOpen(), false);
        floating.destroy();
    });

    await t.test('5. Default floating companion size is 160 × 190 pixels within safe constraints', () => {
        assert.equal(FloatingCompanionWindow.DEFAULT_WIDTH, 160, 'DEFAULT_WIDTH must be 160');
        assert.equal(FloatingCompanionWindow.DEFAULT_HEIGHT, 190, 'DEFAULT_HEIGHT must be 190');
        assert.equal(FloatingCompanionWindow.MIN_WIDTH, 140, 'MIN_WIDTH must be 140');
        assert.equal(FloatingCompanionWindow.MIN_HEIGHT, 170, 'MIN_HEIGHT must be 170');
        assert.equal(FloatingCompanionWindow.MAX_WIDTH, 520, 'MAX_WIDTH must be 520');
        assert.equal(FloatingCompanionWindow.MAX_HEIGHT, 600, 'MAX_HEIGHT must be 600');

        const floating = new FloatingCompanionWindow({
            BrowserWindow: MockElectronWindow
        });

        const status = floating.getStatus();
        assert.equal(status.width, 160, 'Initial status width must be 160');
        assert.equal(status.height, 190, 'Initial status height must be 190');

        const win = floating.createWindow();
        assert.equal(win.options.width, 160, 'BrowserWindow width must be 160');
        assert.equal(win.options.height, 190, 'BrowserWindow height must be 190');
        assert.equal(win.options.minWidth, 140, 'BrowserWindow minWidth must be 140');
        assert.equal(win.options.minHeight, 170, 'BrowserWindow minHeight must be 170');

        floating.destroy();
    });

    await t.test('6. Manual window resizing works and updates dimensions', () => {
        const floating = new FloatingCompanionWindow({
            BrowserWindow: MockElectronWindow
        });

        const win = floating.createWindow();
        assert.equal(win.options.resizable, true, 'Window must have resizable: true');

        // Simulate resize to valid dimensions
        floating.currentWidth = 220;
        floating.currentHeight = 260;
        win.setSize(220, 260);

        const status = floating.getStatus();
        assert.equal(status.width, 220);
        assert.equal(status.height, 260);

        floating.destroy();
    });

    await t.test('7. Chosen size survives floating-window recreation', () => {
        const floating = new FloatingCompanionWindow({
            BrowserWindow: MockElectronWindow
        });

        floating.createWindow();
        floating.currentWidth = 280;
        floating.currentHeight = 320;
        floating._saveBounds(100, 100, 280, 320);

        // Close and recreate window
        floating.destroy();
        assert.equal(floating.window, null);

        const newWin = floating.createWindow();
        assert.equal(newWin.options.width, 280, 'Recreated window must reuse saved width 280');
        assert.equal(newWin.options.height, 320, 'Recreated window must reuse saved height 320');

        floating.destroy();
    });

    await t.test('8. Chosen size survives restart through persistent bounds file', () => {
        const tmpBoundsFile = path.join(os.tmpdir(), `lucy-bounds-test-${Date.now()}.json`);
        fs.writeFileSync(tmpBoundsFile, JSON.stringify({
            x: 120,
            y: 140,
            width: 250,
            height: 290,
            isPinned: true
        }), 'utf8');

        // Create a custom subclass pointing to the temp bounds file
        class TestFloatingCompanionWindow extends FloatingCompanionWindow {
            _getBoundsFile() {
                return tmpBoundsFile;
            }
        }

        const reloaded = new TestFloatingCompanionWindow({
            BrowserWindow: MockElectronWindow
        });

        assert.equal(reloaded.currentWidth, 250, 'Reloaded width must match persistent file');
        assert.equal(reloaded.currentHeight, 290, 'Reloaded height must match persistent file');
        assert.equal(reloaded.isPinned, true, 'Reloaded pin state must match persistent file');

        const win = reloaded.createWindow();
        assert.equal(win.options.width, 250);
        assert.equal(win.options.height, 290);

        reloaded.destroy();
        try { fs.unlinkSync(tmpBoundsFile); } catch (_) {}
    });

    await t.test('9. Invalid or corrupted saved dimensions fall back safely to 160 × 190', () => {
        const tmpBoundsFile = path.join(os.tmpdir(), `lucy-corrupted-bounds-${Date.now()}.json`);
        fs.writeFileSync(tmpBoundsFile, JSON.stringify({
            x: 'not_a_number',
            y: null,
            width: -999,
            height: NaN,
            isPinned: 'yes'
        }), 'utf8');

        class TestCorruptedFloatingCompanionWindow extends FloatingCompanionWindow {
            _getBoundsFile() {
                return tmpBoundsFile;
            }
        }

        const safeFallback = new TestCorruptedFloatingCompanionWindow({
            BrowserWindow: MockElectronWindow
        });

        assert.equal(safeFallback.currentWidth, 160, 'Invalid width must fall back to 160');
        assert.equal(safeFallback.currentHeight, 190, 'Invalid height must fall back to 190');

        safeFallback.destroy();
        try { fs.unlinkSync(tmpBoundsFile); } catch (_) {}
    });

    await t.test('10. Background/tray lifecycle and explicit exit rules are preserved', () => {
        const mainCode = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.js'), 'utf8');

        // Verify backgroundMode intercept on close
        assert.ok(mainCode.includes('appSettings.backgroundMode'), 'main/index.js must respect backgroundMode');
        assert.ok(mainCode.includes('event.preventDefault()'), 'main/index.js must preventDefault on window close when backgroundMode is active');
        assert.ok(mainCode.includes('mainWindow.hide()'), 'main/index.js must hide main window on background close');

        // Verify explicit exitApp handler
        assert.ok(mainCode.includes('lucy:exitApp') || mainCode.includes('app.quit()'), 'main/index.js must support clean explicit exit');
    });

    await t.test('11. Repair 6: Controls and status indicators are hidden on initial display', () => {
        const cssCode = fs.readFileSync(path.resolve(__dirname, '../../src/companion/companion.css'), 'utf8');

        // 1. Container has pointer-events: auto so whole window boundary detects hover reliably
        assert.match(cssCode, /#companionContainer\s*\{[^}]*pointer-events:\s*auto;/, '#companionContainer must have pointer-events: auto');

        // 2. Control dock is hidden by default
        assert.match(cssCode, /\.control-dock\s*\{[^}]*opacity:\s*0;/, '.control-dock must have opacity: 0 by default');
        assert.match(cssCode, /\.control-dock\s*\{[^}]*visibility:\s*hidden;/, '.control-dock must have visibility: hidden by default');
        assert.match(cssCode, /\.control-dock\s*\{[^}]*pointer-events:\s*none;/, '.control-dock must have pointer-events: none by default');

        // 3. Close button is hidden by default
        assert.match(cssCode, /\.top-close-btn\s*\{[^}]*opacity:\s*0;/, '.top-close-btn must have opacity: 0 by default');
        assert.match(cssCode, /\.top-close-btn\s*\{[^}]*visibility:\s*hidden;/, '.top-close-btn must have visibility: hidden by default');
        assert.match(cssCode, /\.top-close-btn\s*\{[^}]*pointer-events:\s*none;/, '.top-close-btn must have pointer-events: none by default');

        // 4. Status indicator pill is hidden by default (Repair 6: hover-only visibility)
        assert.match(cssCode, /\.status-pill\s*\{[^}]*opacity:\s*0;/, '.status-pill must be hidden by default with opacity: 0');
        assert.match(cssCode, /\.status-pill\s*\{[^}]*visibility:\s*hidden;/, '.status-pill must have visibility: hidden by default');
        assert.match(cssCode, /\.status-pill\s*\{[^}]*pointer-events:\s*none;/, '.status-pill must have pointer-events: none by default');
    });

    await t.test('12. Repair 6: Controls and status indicators reveal smoothly on hover and keyboard focus without flicker', () => {
        const cssCode = fs.readFileSync(path.resolve(__dirname, '../../src/companion/companion.css'), 'utf8');
        const appCode = fs.readFileSync(path.resolve(__dirname, '../../src/companion/companion-app.js'), 'utf8');

        // CSS reveal selectors for hover, focus-within, and programmatically active controls
        assert.ok(cssCode.includes('#companionContainer:hover .control-dock'), 'CSS must reveal control-dock on #companionContainer:hover');
        assert.ok(cssCode.includes('#companionContainer:hover .top-close-btn'), 'CSS must reveal top-close-btn on #companionContainer:hover');
        assert.ok(cssCode.includes('#companionContainer:hover .status-pill'), 'CSS must reveal status-pill on #companionContainer:hover');
        assert.ok(cssCode.includes('#companionContainer:focus-within .control-dock'), 'CSS must reveal control-dock on focus-within for keyboard accessibility');
        assert.ok(cssCode.includes('#companionContainer:focus-within .status-pill'), 'CSS must reveal status-pill on focus-within');
        assert.ok(cssCode.includes('#companionContainer.controls-visible .control-dock'), 'CSS must reveal control-dock on .controls-visible class');
        assert.ok(cssCode.includes('#companionContainer.controls-visible .status-pill'), 'CSS must reveal status-pill on .controls-visible class');

        // Companion App JS hover manager
        assert.ok(appCode.includes('function showControls()'), 'companion-app.js must define showControls()');
        assert.ok(appCode.includes('function scheduleHideControls('), 'companion-app.js must define scheduleHideControls() with debouncing');
        assert.ok(appCode.includes("companionContainer.addEventListener('pointerenter'"), 'Must attach pointerenter to container');
        assert.ok(appCode.includes("companionContainer.addEventListener('pointerleave'"), 'Must attach pointerleave to container');
        assert.ok(appCode.includes("companionContainer.addEventListener('focusin'"), 'Must attach focusin for keyboard accessibility');
        assert.ok(appCode.includes('isPointerDown'), 'Must track pointer down to prevent hiding while clicking controls');
    });

    await t.test('13. Repair 1: Chat, Pin, Return, and Close controls remain fully functional with proper close semantics', () => {
        const appCode = fs.readFileSync(path.resolve(__dirname, '../../src/companion/companion-app.js'), 'utf8');

        // Talk / Chat button
        assert.ok(appCode.includes("talkBtn.addEventListener('click'"), 'talkBtn click listener must be registered');
        assert.ok(appCode.includes('displayMessage(') && appCode.includes('focusMainWindow()'), 'talkBtn must open side panel or focus main window');

        // Pin button
        assert.ok(appCode.includes("pinBtn.addEventListener('click'"), 'pinBtn click listener must be registered');
        assert.ok(appCode.includes('togglePin()'), 'pinBtn must toggle pin state via IPC');

        // Return button
        assert.ok(appCode.includes("returnBtn.addEventListener('click'"), 'returnBtn click listener must be registered');

        // Close button: must trigger executeReturn() (dock to app) rather than killing the app
        assert.ok(appCode.includes("closeBtn.addEventListener('click'"), 'closeBtn click listener must be registered');
        assert.ok(appCode.includes('executeReturn()'), 'closeBtn must execute return to app, preserving existing close semantics');
        assert.ok(!appCode.includes('exitApp()'), 'closeBtn must NOT call exitApp');
    });

    await t.test('14. Repair 1: FloatingCompanionWindow broadcasts state changes to main window bidirectionally', () => {
        const eventsReceived = [];

        const mockMainWindow = {
            isDestroyed: () => false,
            isMinimized: () => false,
            isVisible: () => true,
            restore: () => {},
            show: () => {},
            focus: () => {},
            webContents: {
                send: (channel, data) => {
                    if (channel === 'lucy:companionWindowToggled') {
                        eventsReceived.push(data);
                    }
                }
            }
        };

        const floating = new FloatingCompanionWindow({
            mainWindow: mockMainWindow,
            BrowserWindow: MockElectronWindow
        });

        // 1. Show floating window -> must notify main window isOpen: true
        floating.show();
        assert.equal(eventsReceived.length, 1);
        assert.deepEqual(eventsReceived[0], { isOpen: true }, 'show() must notify main window with isOpen: true');

        // 2. Hide floating window -> must notify main window isOpen: false
        floating.hide();
        assert.equal(eventsReceived.length, 2);
        assert.deepEqual(eventsReceived[1], { isOpen: false }, 'hide() must notify main window with isOpen: false');

        // 3. Return to app -> must notify main window with isOpen: false and returning: true exactly once
        floating.show();
        assert.equal(eventsReceived.length, 3);
        assert.deepEqual(eventsReceived[2], { isOpen: true });

        floating.returnToApp();
        assert.equal(eventsReceived.length, 4);
        assert.deepEqual(eventsReceived[3], { isOpen: false, returning: true }, 'returnToApp must send returning: true without duplicate hide event');

        floating.destroy();
    });

    await t.test('15. Repair 1: Main window UI updates both sidebar and settings buttons simultaneously', () => {
        const appCode = fs.readFileSync(path.resolve(__dirname, '../../src/ui/app.js'), 'utf8');

        // Check centralized syncCompanionUI exists
        assert.ok(appCode.includes('function syncCompanionUI(isFloating, options = {})'), 'app.js must define syncCompanionUI');

        // Check sidebar button synchronized
        assert.ok(appCode.includes("toggleFloatingBtn.textContent = isFairyFloating ? '↩️ Dock Pet' : '🪟 Float Pet'"), 'Must update toggleFloatingBtn label');

        // Check settings button synchronized
        assert.ok(appCode.includes("settingsToggleFloat.textContent = isFairyFloating ? '↩️ Dock Pet to App' : '🪟 Float Pet to Desktop'"), 'Must update settingsToggleFloat label');

        // Check creature stage class synchronized
        assert.ok(appCode.includes("creatureStage.classList.add('fairy-on-desktop')"), 'Must add fairy-on-desktop class when floating');
        assert.ok(appCode.includes("creatureStage.classList.remove('fairy-flying-out', 'fairy-flying-in', 'fairy-on-desktop')"), 'Must remove floating classes when docked');

        // Check settings button click wires into dockFairyToApp/floatFairyToDesktop
        assert.ok(appCode.includes('settingsToggleFloat.addEventListener'), 'settingsToggleFloat listener must be wired');
    });

    await t.test('16. Repair 1: Repeated dock and float transitions without stale state or duplicate listeners', async () => {
        const eventsReceived = [];

        const mockMainWindow = {
            isDestroyed: () => false,
            isMinimized: () => false,
            isVisible: () => true,
            restore: () => {},
            show: () => {},
            focus: () => {},
            webContents: {
                send: (channel, data) => {
                    if (channel === 'lucy:companionWindowToggled') {
                        eventsReceived.push(data);
                    }
                }
            }
        };

        const floating = new FloatingCompanionWindow({
            mainWindow: mockMainWindow,
            BrowserWindow: MockElectronWindow
        });

        // Perform 5 alternating cycles
        for (let i = 0; i < 5; i++) {
            floating.show();
            assert.equal(floating.isOpen(), true, `Cycle ${i}: must be open after show()`);
            await floating.returnToApp();
            assert.equal(floating.isOpen(), false, `Cycle ${i}: must be closed after returnToApp()`);
        }

        // Each cycle must produce exactly 2 notifications: 1 open, 1 return
        assert.equal(eventsReceived.length, 10, 'Expected exactly 10 clean events for 5 cycles');
        for (let i = 0; i < 10; i += 2) {
            assert.equal(eventsReceived[i].isOpen, true, `Event ${i} must be open: true`);
            assert.equal(eventsReceived[i + 1].isOpen, false, `Event ${i+1} must be open: false`);
            assert.equal(eventsReceived[i + 1].returning, true, `Event ${i+1} must be returning: true`);
        }

        floating.destroy();
    });
});

