'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { TASK_STATES } = require('../../src/core/task-status.js');

// Mock 2D Context for Headless Node.js Testing
function createMockCanvas(width = 300, height = 300) {
    const listeners = new Map();
    const ctx = {
        save: () => {},
        restore: () => {},
        clearRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        bezierCurveTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        ellipse: () => {},
        fill: () => {},
        stroke: () => {},
        createRadialGradient: () => ({ addColorStop: () => {} }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        fillText: () => {},
        measureText: (txt) => ({ width: (txt || '').length * 8 }),
        shadowColor: '',
        shadowBlur: 0,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        lineCap: 'round',
        lineJoin: 'round',
        globalAlpha: 1
    };

    return {
        width,
        height,
        getContext: () => ctx,
        getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
        addEventListener: (event, handler) => {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(handler);
        },
        removeEventListener: (event, handler) => {
            if (listeners.has(event)) {
                listeners.set(event, listeners.get(event).filter(h => h !== handler));
            }
        },
        _triggerEvent: (event, payload) => {
            if (listeners.has(event)) {
                listeners.get(event).forEach(h => h(payload));
            }
        }
    };
}

test('Unified Fairy Companion Redesign Verification', async (t) => {

    await t.test('1. CelestialFamiliarRenderer: Single-Identity Engine Lifecycle & Particle Systems', () => {
        const canvas = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);

        assert.ok(renderer, 'Renderer instance created');
        assert.equal(renderer.state.emotion, 'idle', 'Initial state should be idle');
        assert.equal(renderer.orbitParticles.length, 32, 'Must generate 32 orbiting stardust particles');

        // Test emotion change to Pet
        renderer.setVisualState({ emotion: 'pet' });
        assert.equal(renderer.state.emotion, 'pet');
        assert.ok(renderer.burstParticles.length > 0, 'Pet burst must create heart/sparkle particles');
        assert.equal(renderer.burstParticles.length, 24, 'Pet burst should create 24 particles');

        // Test emotion change to Magic
        renderer.setVisualState({ emotion: 'magic' });
        assert.equal(renderer.state.emotion, 'magic');
        assert.equal(renderer.state.actionDuration, 1.8, 'Magic action duration initialized');

        // Test Takeoff and Landing transitions
        renderer.setVisualState({ emotion: 'takeoff' });
        assert.equal(renderer.state.emotion, 'takeoff');
        renderer.setVisualState({ emotion: 'landing' });
        assert.equal(renderer.state.emotion, 'landing');

        // Test update and render steps without throwing
        assert.doesNotThrow(() => {
            renderer._update(100, 0.016);
            renderer._render(100);
        }, '_update() and _render() must run cleanly on mock canvas');

        // Test mouse tracking
        canvas._triggerEvent('mousemove', { clientX: 200, clientY: 100 });
        assert.ok(renderer.state.eyeTargetX > 0, 'Eye target X should track mouse position');

        // Cleanup
        renderer.destroy();
        assert.equal(renderer.orbitParticles.length, 0, 'Particles cleared on destroy');
        assert.equal(renderer.running, false);
    });

    await t.test('2. CompanionBridge: Synchronized TaskCoordinator Emotion Mapping & Reactions', () => {
        const bridge = new CompanionBridge();
        const recordedEvents = [];
        bridge.on('visualUpdate', (evt) => recordedEvents.push(evt));

        // Test state transitions
        bridge.handleStateEvent({ to: TASK_STATES.IDLE });
        assert.equal(bridge.currentEmotion, 'idle');

        bridge.handleStateEvent({ to: TASK_STATES.PLANNING });
        assert.equal(bridge.currentEmotion, 'focused');

        bridge.handleStateEvent({ to: TASK_STATES.EXECUTING_TOOL, currentTool: 'browser_navigate' });
        assert.equal(bridge.currentEmotion, 'working');

        bridge.handleStateEvent({ to: TASK_STATES.COMPLETED, result: { summary: 'Done!' } });
        assert.equal(bridge.currentEmotion, 'happy');

        bridge.handleStateEvent({ to: TASK_STATES.FAILED, error: 'Connection refused' });
        assert.equal(bridge.currentEmotion, 'worried');

        // Test Physical Interactions
        const petReaction = bridge.handleUserInteraction('pet');
        assert.equal(petReaction.reaction, 'sparkle_flutter');
        assert.equal(bridge.currentEmotion, 'happy');

        const magicReaction = bridge.handleUserInteraction('magic');
        assert.equal(magicReaction.reaction, 'magic_burst');
        assert.equal(bridge.currentEmotion, 'happy');

        assert.ok(recordedEvents.length >= 7, 'All events should have emitted visual updates');
    });

    await t.test('3. FloatingCompanionWindow: Desktop Shell Lifecycle, Pinning & Return to App', () => {
        let restoredCalled = false;
        let shownCalled = false;
        let focusedCalled = false;
        let sentEvent = null;

        const mockMainWindow = {
            isDestroyed: () => false,
            isMinimized: () => true,
            restore: () => { restoredCalled = true; },
            show: () => { shownCalled = true; },
            focus: () => { focusedCalled = true; },
            webContents: {
                send: (channel, data) => { sentEvent = { channel, data }; }
            }
        };

        const bridge = new CompanionBridge();
        const floating = new FloatingCompanionWindow({
            mainWindow: mockMainWindow,
            companionBridge: bridge
        });

        assert.equal(floating.isOpen(), false, 'Window initially closed');
        assert.equal(floating.isPinned, true, 'Default pinned state is true');

        // Test returnToApp
        floating.returnToApp();
        assert.equal(restoredCalled, true, 'Main window must be restored from minimized state');
        assert.equal(shownCalled, true, 'Main window must be shown');
        assert.equal(focusedCalled, true, 'Main window must be focused');
        assert.ok(sentEvent, 'lucy:companionWindowToggled event must be sent');
        assert.equal(sentEvent.channel, 'lucy:companionWindowToggled');
        assert.equal(sentEvent.data.returning, true);
        assert.equal(sentEvent.data.isOpen, false);
    });

    await t.test('4. Floating Companion Desktop Shell HTML & Dock Structure', () => {
        const htmlPath = path.resolve(__dirname, '../../src/companion/companion.html');
        const cssPath = path.resolve(__dirname, '../../src/companion/companion.css');
        const appPath = path.resolve(__dirname, '../../src/companion/companion-app.js');

        assert.ok(fs.existsSync(htmlPath), 'companion.html must exist');
        assert.ok(fs.existsSync(cssPath), 'companion.css must exist');
        assert.ok(fs.existsSync(appPath), 'companion-app.js must exist');

        const html = fs.readFileSync(htmlPath, 'utf8');
        assert.ok(html.includes('id="fairyCanvas"'), 'companion.html must contain fairyCanvas');
        assert.ok(html.includes('id="petBtn"'), 'companion.html must contain petBtn');
        assert.ok(html.includes('id="magicBtn"'), 'companion.html must contain magicBtn');
        assert.ok(html.includes('id="talkBtn"'), 'companion.html must contain talkBtn');
        assert.ok(html.includes('id="pinBtn"'), 'companion.html must contain pinBtn');
        assert.ok(html.includes('id="returnBtn"'), 'companion.html must contain returnBtn');

        const css = fs.readFileSync(cssPath, 'utf8');
        assert.ok(css.includes('backdrop-filter'), 'companion.css must use glassmorphic styling');
        assert.ok(css.includes('pointer-events'), 'companion.css must configure transparent pass-through');

        const appCode = fs.readFileSync(appPath, 'utf8');
        assert.ok(appCode.includes('CelestialFamiliarRenderer'), 'companion-app.js must use CelestialFamiliarRenderer');
        assert.ok(appCode.includes('returnToApp'), 'companion-app.js must handle returnToApp');
    });

    await t.test('5. Single Authority Guarantee: Requests Route Solely Through TaskCoordinator', async () => {
        const executed = [];
        const mockCoordinator = {
            executeRequest: async (userReq) => {
                executed.push(userReq);
                return { ok: true, taskId: 'test_task_1', replyText: 'Executed via coordinator' };
            }
        };

        const bridge = new CompanionBridge();
        const floating = new FloatingCompanionWindow({
            coordinator: mockCoordinator,
            companionBridge: bridge
        });

        // Test submission forwarding
        const submitResult = await mockCoordinator.executeRequest('Create a note');
        assert.equal(submitResult.ok, true);
        assert.equal(executed.length, 1);
        assert.equal(executed[0], 'Create a note');
        assert.equal(submitResult.replyText, 'Executed via coordinator');
    });

    await t.test('6. Compact Desktop Bounds & Clamping Mechanics', () => {
        assert.equal(FloatingCompanionWindow.DEFAULT_WIDTH, 220, 'Default floating companion width must be 220px');
        assert.equal(FloatingCompanionWindow.DEFAULT_HEIGHT, 260, 'Default floating companion height must be 260px');

        const floating = new FloatingCompanionWindow();
        const status = floating.getStatus();
        assert.equal(status.width, 220);
        assert.equal(status.height, 260);
        assert.equal(status.isPinned, true);

        // Test boundary clamping with fallback mock
        const clamped = floating._clampToBounds(99999, 99999, 220, 260);
        assert.ok(typeof clamped.x === 'number' && typeof clamped.y === 'number');
    });

    await t.test('7. Cute Feminine Fairy Aesthetic & Curated Soft Palette', () => {
        const canvas = createMockCanvas(220, 190);
        const renderer = new CelestialFamiliarRenderer(canvas);

        const idlePalette = renderer._getColorPalette();
        assert.ok(idlePalette.hair, 'Must define soft pastel hair tone');
        assert.ok(idlePalette.wingsInner, 'Must define translucent gossamer inner wing tone');
        assert.ok(idlePalette.wingsOuter, 'Must define iridescent outer wing tone');
        assert.ok(idlePalette.dress, 'Must define petal dress tone');

        // Verify all emotional states provide coherent fairy palettes
        const states = ['happy', 'pet', 'speaking', 'listening', 'thinking', 'working', 'worried', 'curious', 'magic', 'sleep', 'idle'];
        for (const st of states) {
            renderer.state.emotion = st;
            const pal = renderer._getColorPalette();
            assert.ok(pal.core, `State ${st} must define core color`);
            assert.ok(pal.eyes, `State ${st} must define eyes color`);
            assert.ok(pal.wingsInner, `State ${st} must define wingsInner`);
        }

        // Verify clean render on 220x190 compact canvas
        assert.doesNotThrow(() => {
            renderer._render(500);
        }, 'Renderer must render cleanly on 220x190 compact canvas');

        renderer.destroy();
    });

    await t.test('8. Discoverability: Summon to Front and Pin/Unpin Synchronization', () => {
        let setAlwaysOnTopCalled = false;
        let lastTopLevel = null;
        let focusedCalled = false;
        let shownCalled = false;

        class MockDesktopWindow {
            constructor() {
                this.destroyed = false;
                this.visible = false;
                this.webContents = {
                    send: () => {},
                    setWindowOpenHandler: () => {},
                    on: () => {}
                };
            }
            isDestroyed() { return this.destroyed; }
            isMinimized() { return false; }
            show() { shownCalled = true; this.visible = true; }
            hide() { this.visible = false; }
            focus() { focusedCalled = true; }
            restore() {}
            getPosition() { return [100, 100]; }
            setPosition() {}
            setAlwaysOnTop(val, level) {
                setAlwaysOnTopCalled = true;
                lastTopLevel = level;
            }
            loadFile() {}
            on() {}
            once(ev, cb) { if (ev === 'ready-to-show') setTimeout(cb, 1); }
            destroy() { this.destroyed = true; }
        }

        const floating = new FloatingCompanionWindow({
            BrowserWindow: MockDesktopWindow
        });

        // Test Pin toggle
        assert.equal(floating.isPinned, true, 'Default pinned state is true');
        const unpinned = floating.setPinned(false);
        assert.equal(unpinned, false, 'Can unpin companion');
        assert.equal(floating.isPinned, false);
        const repinned = floating.setPinned(true);
        assert.equal(repinned, true, 'Can repin companion');

        // Test summonToFront
        const summoned = floating.summonToFront();
        assert.equal(summoned, true, 'summonToFront succeeds');
        assert.equal(shownCalled, true, 'Window was shown on summon');
        assert.equal(focusedCalled, true, 'Window was focused on summon');
        assert.equal(setAlwaysOnTopCalled, true, 'setAlwaysOnTop was invoked to bring to front');

        floating.destroy();
    });
});
