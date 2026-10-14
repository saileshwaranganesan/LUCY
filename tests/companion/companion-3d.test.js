'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { TASK_STATES } = require('../../src/core/task-status.js');
const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');

// Mock BrowserWindow for deterministic lifecycle testing in headless Node
class MockBrowserWindow {
    static instanceCount = 0;

    constructor(options = {}) {
        MockBrowserWindow.instanceCount++;
        this.options = options;
        this.destroyed = false;
        this.visible = false;
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

    isDestroyed() {
        return this.destroyed;
    }

    show() {
        if (this.destroyed) throw new Error('Cannot show destroyed window');
        this.visible = true;
    }

    hide() {
        if (this.destroyed) throw new Error('Cannot hide destroyed window');
        this.visible = false;
    }

    isVisible() {
        return this.visible && !this.destroyed;
    }

    getPosition() {
        return [this.x, this.y];
    }

    setPosition(x, y) {
        this.x = x;
        this.y = y;
    }

    setAlwaysOnTop(val) {
        this.alwaysOnTop = Boolean(val);
    }

    loadFile(filepath) {
        this.loadedFile = filepath;
    }

    destroy() {
        this.destroyed = true;
        this.visible = false;
        const closedHandlers = this.listeners.get('closed') || [];
        for (const h of closedHandlers) {
            try { h(); } catch (_) {}
        }
    }

    on(event, handler) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(handler);
    }

    once(event, handler) {
        this.on(event, handler);
    }
}

test('Fairy Companion & Anti-Dragon Regression Suite', async (t) => {

    await t.test('1. Anti-Dragon Regression Guard: Dragon 3D Models and Legacy Renderers Eliminated', () => {
        // Assert dragon.glb does NOT exist
        const modelPath = path.resolve(__dirname, '../../src/companion/assets/dragon.glb');
        assert.equal(fs.existsSync(modelPath), false, 'dragon.glb must NOT exist in src/companion/assets');

        // Assert legacy companion-3d-renderer.js does NOT exist
        const legacyRendererPath = path.resolve(__dirname, '../../src/companion/companion-3d-renderer.js');
        assert.equal(fs.existsSync(legacyRendererPath), false, 'companion-3d-renderer.js must NOT exist in src/companion');

        // Assert companion.html does NOT reference dragon or companion-3d-renderer.js
        const htmlPath = path.resolve(__dirname, '../../src/companion/companion.html');
        assert.ok(fs.existsSync(htmlPath), 'companion.html must exist');
        const html = fs.readFileSync(htmlPath, 'utf8');
        assert.ok(!html.includes('dragon'), 'companion.html must contain no dragon references');
        assert.ok(!html.includes('companion-3d-renderer'), 'companion.html must not load companion-3d-renderer.js');
        assert.ok(!html.includes('threeCanvas'), 'companion.html must not contain threeCanvas element');
        assert.ok(html.includes('fairyCanvas'), 'companion.html must contain fairyCanvas');
        assert.ok(html.includes('companion-renderer.js'), 'companion.html must script companion-renderer.js');
        assert.ok(html.includes('companion-app.js'), 'companion.html must script companion-app.js');

        // Assert companion-app.js does NOT reference dragon or threeCanvas
        const appPath = path.resolve(__dirname, '../../src/companion/companion-app.js');
        assert.ok(fs.existsSync(appPath), 'companion-app.js must exist');
        const appCode = fs.readFileSync(appPath, 'utf8');
        assert.ok(!appCode.includes('dragon'), 'companion-app.js must contain no dragon references');
        assert.ok(!appCode.includes('threeCanvas'), 'companion-app.js must contain no threeCanvas references');
        assert.ok(appCode.includes('CelestialFamiliarRenderer'), 'companion-app.js must instantiate CelestialFamiliarRenderer');

        // Assert main ui/index.html and app.js do NOT reference dragon and load CelestialFamiliarRenderer
        const mainUiPath = path.resolve(__dirname, '../../src/ui/index.html');
        assert.ok(fs.existsSync(mainUiPath), 'src/ui/index.html must exist');
        const mainUiCode = fs.readFileSync(mainUiPath, 'utf8');
        assert.ok(!mainUiCode.includes('dragon'), 'src/ui/index.html must contain no dragon references');
        assert.ok(mainUiCode.includes('companion-renderer.js'), 'src/ui/index.html must script companion-renderer.js');

        const mainAppPath = path.resolve(__dirname, '../../src/ui/app.js');
        assert.ok(fs.existsSync(mainAppPath), 'src/ui/app.js must exist');
        const mainAppCode = fs.readFileSync(mainAppPath, 'utf8');
        assert.ok(!mainAppCode.includes('dragon'), 'src/ui/app.js must contain no dragon references');
        assert.ok(mainAppCode.includes('CelestialFamiliarRenderer'), 'src/ui/app.js must instantiate CelestialFamiliarRenderer');
    });

    await t.test('2. Authoritative Renderer Selection: CelestialFamiliarRenderer at Every Entry Point', () => {
        // UI canonical renderer export
        const uiRendererModule = require('../../src/ui/companion-renderer.js');
        assert.ok(uiRendererModule.CelestialFamiliarRenderer, 'src/ui/companion-renderer.js must export CelestialFamiliarRenderer');

        // Companion canonical renderer export
        const companionRendererModule = require('../../src/companion/companion-renderer.js');
        assert.ok(companionRendererModule.CelestialFamiliarRenderer, 'src/companion/companion-renderer.js must export CelestialFamiliarRenderer');
        assert.equal(uiRendererModule.CelestialFamiliarRenderer, companionRendererModule.CelestialFamiliarRenderer,
            'Companion renderer export must match ui renderer export identically');
    });

    await t.test('3. Single-Instance & Duplicate Window Prevention in FloatingCompanionWindow', () => {
        MockBrowserWindow.instanceCount = 0;
        const bridge = new CompanionBridge();
        const floating = new FloatingCompanionWindow({
            companionBridge: bridge,
            BrowserWindow: MockBrowserWindow
        });

        assert.equal(floating.isOpen(), false, 'Window initially closed');
        assert.equal(floating.window, null, 'Underlying window is null before creation');

        // First creation
        const win1 = floating.createWindow();
        assert.ok(win1, 'First window instance created');
        assert.equal(MockBrowserWindow.instanceCount, 1, 'Exactly one BrowserWindow instantiated');

        // Second creation call must return existing instance, NOT create a second window
        const win2 = floating.createWindow();
        assert.equal(win1, win2, 'Second createWindow() must return identical window instance');
        assert.equal(MockBrowserWindow.instanceCount, 1, 'Instance count must remain 1 (no duplicate)');

        // Show when already shown must not create a duplicate
        floating.show();
        assert.equal(MockBrowserWindow.instanceCount, 1, 'show() on open window must not instantiate duplicate');
        assert.equal(floating.isOpen(), true, 'Window is open');
    });

    await t.test('4. Window Lifecycle Transitions: Dock, Undock, Hide, Destroy, and Safe Re-creation', () => {
        let restoredCalled = false;
        let shownCalled = false;
        let focusedCalled = false;
        let toggleEventSent = null;

        const mockMainWindow = {
            isDestroyed: () => false,
            isMinimized: () => true,
            isVisible: () => false,
            restore: () => { restoredCalled = true; },
            show: () => { shownCalled = true; },
            focus: () => { focusedCalled = true; },
            webContents: {
                send: (channel, data) => {
                    toggleEventSent = { channel, data };
                }
            }
        };

        MockBrowserWindow.instanceCount = 0;
        const bridge = new CompanionBridge();
        const floating = new FloatingCompanionWindow({
            mainWindow: mockMainWindow,
            companionBridge: bridge,
            BrowserWindow: MockBrowserWindow
        });

        // 1. Show / Undock to desktop
        floating.show();
        assert.equal(floating.isOpen(), true, 'Floating companion is open');
        assert.equal(floating.window.isVisible(), true, 'Mock window is visible');

        // 2. Hide
        floating.hide();
        assert.equal(floating.isOpen(), false, 'Floating companion is hidden');
        assert.equal(floating.window.isVisible(), false, 'Mock window is not visible');

        // 3. Return to App (Docking)
        floating.show();
        assert.equal(floating.isOpen(), true);
        floating.returnToApp();

        assert.equal(floating.isOpen(), false, 'Companion hidden after returnToApp');
        assert.equal(restoredCalled, true, 'Main window restored on dock');
        assert.equal(shownCalled, true, 'Main window shown on dock');
        assert.equal(focusedCalled, true, 'Main window focused on dock');
        assert.ok(toggleEventSent, 'Toggled IPC event sent to main window');
        assert.equal(toggleEventSent.data.returning, true);
        assert.equal(toggleEventSent.data.isOpen, false);

        // 4. Destroy
        floating.destroy();
        assert.equal(floating.isOpen(), false, 'isOpen must be false after destroy');
        assert.equal(floating.window, null, 'Window reference must be null after destroy');

        // 5. Safe Re-creation after Destroy
        floating.show();
        assert.equal(floating.isOpen(), true, 'Safe recreation after destroy succeeded');
        assert.ok(floating.window, 'New window created after destroy');
        assert.equal(floating.window.isDestroyed(), false, 'New window is active');

        // Final cleanup
        floating.destroy();
        assert.equal(floating.isOpen(), false);
    });

    await t.test('5. Synchronized Main and Floating Companion Identity and Coordinator Events', () => {
        const bridge = new CompanionBridge();
        const recordedEvents = [];
        bridge.on('visualUpdate', (evt) => recordedEvents.push(evt));

        // Coordinator State 1: IDLE -> idle emotion
        bridge.handleStateEvent({ to: TASK_STATES.IDLE });
        assert.equal(bridge.currentEmotion, 'idle');
        assert.equal(recordedEvents[recordedEvents.length - 1].emotion, 'idle');

        // Coordinator State 2: INTERPRETING -> thinking
        bridge.handleStateEvent({ to: TASK_STATES.INTERPRETING, description: 'Listening...' });
        assert.equal(bridge.currentEmotion, 'thinking');

        // Coordinator State 3: PLANNING -> focused
        bridge.handleStateEvent({ to: TASK_STATES.PLANNING });
        assert.equal(bridge.currentEmotion, 'focused');

        // Coordinator State 4: WAITING_PERMISSION -> curious
        bridge.handleStateEvent({ to: TASK_STATES.WAITING_PERMISSION });
        assert.equal(bridge.currentEmotion, 'curious');

        // Coordinator State 5: EXECUTING_TOOL -> working
        bridge.handleStateEvent({ to: TASK_STATES.EXECUTING_TOOL, currentTool: 'system_info' });
        assert.equal(bridge.currentEmotion, 'working');

        // Coordinator State 6: COMPLETED -> happy
        bridge.handleStateEvent({ to: TASK_STATES.COMPLETED, result: { summary: 'Done!' } });
        assert.equal(bridge.currentEmotion, 'happy');

        // Coordinator State 7: FAILED -> worried
        bridge.handleStateEvent({ to: TASK_STATES.FAILED, error: 'Access denied' });
        assert.equal(bridge.currentEmotion, 'worried');

        // User Physical Interaction: Pet
        const petResult = bridge.handleUserInteraction('pet');
        assert.equal(petResult.acknowledged, true);
        assert.equal(petResult.reaction, 'sparkle_flutter');
        assert.equal(bridge.currentEmotion, 'happy');

        // User Physical Interaction: Magic
        const magicResult = bridge.handleUserInteraction('magic');
        assert.equal(magicResult.acknowledged, true);
        assert.equal(magicResult.reaction, 'magic_burst');
        assert.equal(bridge.currentEmotion, 'happy');
    });

    await t.test('6. Single Authority: Companion Interactions Route Exclusively Through TaskCoordinator', async () => {
        let coordinatorExecuted = false;
        let submittedText = null;

        const mockCoordinator = {
            executeRequest: async (text, options) => {
                coordinatorExecuted = true;
                submittedText = text;
                return { ok: true, taskId: 'task-test-coord-1', text, options };
            }
        };

        const bridge = new CompanionBridge({ taskCoordinator: mockCoordinator });
        const execResult = await bridge.handleUserInteraction('submit_request', { text: 'Show calendar' });

        assert.equal(coordinatorExecuted, true, 'Request forwarded to TaskCoordinator');
        assert.equal(submittedText, 'Show calendar');
        assert.equal(execResult.ok, true);
    });
});
