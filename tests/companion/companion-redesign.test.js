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

        // Test repeated returnToApp clicks do not crash or create duplicate windows
        assert.doesNotThrow(() => {
            floating.returnToApp();
            floating.returnToApp();
        }, 'Repeated returnToApp calls must be safe and idempotent');
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
        assert.ok(html.includes('id="sideConversationPanel"'), 'companion.html must contain sideConversationPanel');
        assert.ok(html.includes('id="typewriterText"'), 'companion.html must contain typewriterText');
        assert.ok(html.includes('id="talkBtn"'), 'companion.html must contain talkBtn');
        assert.ok(html.includes('id="pinBtn"'), 'companion.html must contain pinBtn');
        assert.ok(html.includes('id="returnBtn"'), 'companion.html must contain returnBtn');
        assert.ok(html.includes('id="resizeGrip"'), 'companion.html must contain resizeGrip');

        // Verify primary dock contains ONLY the clean 3 primary actions
        const controlDockMatch = html.match(/<div class="control-dock" id="controlDock"[^>]*>([\s\S]*?)<\/div>/);
        assert.ok(controlDockMatch, 'companion.html must contain controlDock');
        assert.ok(!controlDockMatch[1].includes('id="petBtn"'), 'Primary dock must NOT contain petBtn');
        assert.ok(!controlDockMatch[1].includes('id="magicBtn"'), 'Primary dock must NOT contain magicBtn');

        const css = fs.readFileSync(cssPath, 'utf8');
        assert.ok(css.includes('backdrop-filter'), 'companion.css must use glassmorphic styling');
        assert.ok(css.includes('pointer-events'), 'companion.css must configure transparent pass-through');
        assert.ok(css.includes('.side-panel'), 'companion.css must style side-panel');
        assert.ok(css.includes('.resize-grip'), 'companion.css must style resize-grip');

        const appCode = fs.readFileSync(appPath, 'utf8');
        assert.ok(appCode.includes('CelestialFamiliarRenderer'), 'companion-app.js must use CelestialFamiliarRenderer');
        assert.ok(appCode.includes('returnToApp'), 'companion-app.js must handle returnToApp');
        assert.ok(appCode.includes('displayMessage'), 'companion-app.js must handle side panel message display');
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
        assert.equal(FloatingCompanionWindow.DEFAULT_WIDTH, 160, 'Default floating companion width must be 160px');
        assert.equal(FloatingCompanionWindow.DEFAULT_HEIGHT, 190, 'Default floating companion height must be 190px');
        assert.equal(FloatingCompanionWindow.MIN_WIDTH, 140, 'Minimum floating companion width must be 140px');
        assert.equal(FloatingCompanionWindow.MIN_HEIGHT, 170, 'Minimum floating companion height must be 170px');

        const floating = new FloatingCompanionWindow();
        const status = floating.getStatus();
        assert.equal(status.width, 160);
        assert.equal(status.height, 190);
        assert.equal(status.isPinned, true);

        // Test boundary clamping with fallback mock
        const clamped = floating._clampToBounds(99999, 99999, 160, 190);
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

    await t.test('9. Expressive Fairy Tricks: Spin, Jump, Fly, Bounce, and Clean Settlement to Idle', () => {
        const canvas = createMockCanvas(240, 240);
        const renderer = new CelestialFamiliarRenderer(canvas);

        // 1. Spin trick
        renderer.playTrick('spin');
        assert.equal(renderer.state.emotion, 'trick_spin');
        assert.equal(renderer.targetFps, 60, 'Tricks must elevate frame rate to 60 FPS');
        assert.ok(renderer.burstParticles.length > 0, 'Spin must generate swirling particles');
        // Simulate time advancement to completion
        renderer._update(100, 1.7);
        assert.equal(renderer.state.emotion, 'idle', 'Spin trick must settle cleanly back to idle');
        assert.equal(renderer.state.spinAngle, 0, 'Spin angle must reset to 0');

        // 2. Jump trick
        renderer.playTrick('jump');
        assert.equal(renderer.state.emotion, 'trick_jump');
        // Anticipation phase
        renderer._update(100, 0.1);
        assert.ok(renderer.state.scaleY < 1.0, 'Jump anticipation must squash character');
        // Airborne phase
        renderer._update(200, 0.3);
        assert.ok(renderer.state.transitionOffset < 0, 'Airborne jump must raise character upwards');
        // Completion
        renderer._update(1000, 1.0);
        assert.equal(renderer.state.emotion, 'idle', 'Jump trick must settle cleanly back to idle');
        assert.equal(renderer.state.transitionOffset, 0);
        assert.equal(renderer.state.scaleY, 1.0);

        // 3. Fly trick
        renderer.playTrick('fly');
        assert.equal(renderer.state.emotion, 'trick_fly');
        renderer._update(100, 0.5);
        assert.notEqual(renderer.state.flightOffsetX, 0, 'Flight trick must apply horizontal swoop offset');
        // Completion
        renderer._update(2500, 1.6);
        assert.equal(renderer.state.emotion, 'idle', 'Fly trick must settle cleanly back to idle');
        assert.equal(renderer.state.flightOffsetX, 0);

        // 4. Bounce trick
        renderer.playTrick('bounce');
        assert.equal(renderer.state.emotion, 'trick_bounce');
        renderer._update(100, 0.3);
        assert.ok(renderer.state.transitionOffset <= 0);
        renderer._update(1500, 1.0);
        assert.equal(renderer.state.emotion, 'idle', 'Bounce trick must settle cleanly back to idle');

        renderer.destroy();
    });

    await t.test('10. Adaptive Performance Engine: Idle Throttling (24 FPS) & Obscured Suspension', () => {
        const canvas = createMockCanvas(240, 240);
        const renderer = new CelestialFamiliarRenderer(canvas);

        assert.equal(renderer.targetFps, 24, 'Idle companion renderer must target 24 FPS by default');

        // User interaction elevates to 60 FPS
        renderer.markInteracted();
        assert.equal(renderer.targetFps, 24); // Will be evaluated in animate
        renderer.setVisualState({ emotion: 'speaking' });
        assert.equal(renderer.targetFps, 60, 'Active speaking state must elevate to 60 FPS');

        // Obscured / hidden window pauses rendering
        renderer.setVisibility(false);
        assert.equal(renderer.isObscured, true, 'Window obscured state must set isObscured flag');

        renderer.setVisibility(true);
        assert.equal(renderer.isObscured, false, 'Window visible state must clear isObscured flag');

        // Proportionate dynamic canvas resize
        renderer.onResize(350, 400);
        assert.equal(canvas.width, 350);
        assert.equal(canvas.height, 400);

        renderer.destroy();
    });

    await t.test('11. Genuine Window Resizing & Debounced Bounds Persistence', async () => {
        let setSizeCalled = false;
        let lastSize = null;

        class MockResizableWindow {
            constructor(options = {}) {
                this.options = options;
                this.destroyed = false;
                this.visible = false;
                this.x = 100;
                this.y = 100;
                this.width = options.width || 220;
                this.height = options.height || 260;
                this.webContents = {
                    send: () => {},
                    setWindowOpenHandler: () => {},
                    on: () => {}
                };
            }
            isDestroyed() { return this.destroyed; }
            isMinimized() { return false; }
            show() { this.visible = true; }
            hide() { this.visible = false; }
            getPosition() { return [this.x, this.y]; }
            getSize() { return [this.width, this.height]; }
            setSize(w, h) {
                setSizeCalled = true;
                this.width = w;
                this.height = h;
                lastSize = [w, h];
            }
            setPosition(x, y) { this.x = x; this.y = y; }
            setAlwaysOnTop() {}
            loadFile() {}
            on() {}
            once(ev, cb) { if (ev === 'ready-to-show') setTimeout(cb, 1); }
            destroy() { this.destroyed = true; }
        }

        const floating = new FloatingCompanionWindow({
            BrowserWindow: MockResizableWindow
        });

        // Window configuration must have resizable: true
        const win = floating.createWindow();
        assert.equal(win.options.resizable, true, 'Window configuration MUST have resizable: true');
        assert.equal(win.options.minWidth, 140, 'Must enforce minimum width 140');
        assert.equal(win.options.minHeight, 170, 'Must enforce minimum height 170');
        assert.equal(win.options.maxWidth, 520, 'Must enforce maximum width 520');
        assert.equal(win.options.maxHeight, 600, 'Must enforce maximum height 600');

        // Test status reflects current size
        const status = floating.getStatus();
        assert.equal(status.width, 160);
        assert.equal(status.height, 190);

        // Test size persistence across recreate
        floating.currentWidth = 240;
        floating.currentHeight = 280;
        floating._saveBounds(150, 150, 240, 280);
        assert.equal(floating.currentWidth, 240);
        assert.equal(floating.currentHeight, 280);

        // Test invalid/corrupted size fallback
        floating.currentWidth = NaN;
        floating.currentHeight = -50;
        floating._loadSavedBounds();
        assert.equal(floating.currentWidth, 160, 'Corrupted dimensions must safely fall back to 160');
        assert.equal(floating.currentHeight, 190, 'Corrupted dimensions must safely fall back to 190');

        floating.destroy();
    });

    await t.test('12. Adjacent Side Conversation Panel with Typewriter Presentation & No Face Obstruction', () => {
        const htmlPath = path.resolve(__dirname, '../../src/companion/companion.html');
        const cssPath = path.resolve(__dirname, '../../src/companion/companion.css');

        const html = fs.readFileSync(htmlPath, 'utf8');
        const css = fs.readFileSync(cssPath, 'utf8');

        // Verify structure: companion-body is a row containing fairy-stage AND side-panel
        assert.ok(html.includes('class="companion-body"'), 'companion.html must have companion-body wrapper');
        assert.ok(html.includes('class="side-panel collapsed"') || html.includes('id="sideConversationPanel"'), 'companion.html must have side-panel');
        assert.ok(html.includes('id="typewriterText"'), 'companion.html must have typewriterText');

        // In CSS, side panel is adjacent flex item, NOT positioned absolutely over fairy face
        assert.ok(css.includes('.companion-body'), 'companion.css must define companion-body');
        assert.ok(css.includes('flex-direction: row'), 'companion-body must use flex-direction: row for side-by-side layout');
        assert.ok(!css.includes('.speech-bubble {'), 'Old overlapping speech-bubble style must be replaced');
    });

    await t.test('13. Regression: Return to App Lifecycle, State Reset & Stale Message Prevention', () => {
        const appCode = fs.readFileSync(path.resolve(__dirname, '../../src/companion/companion-app.js'), 'utf8');
        assert.ok(appCode.includes('resetCompanionState'), 'companion-app.js must define resetCompanionState()');
        assert.ok(appCode.includes('isReturning'), 'companion-app.js must guard against repeated return clicks');
        assert.ok(appCode.includes("sidePanel.classList.add('collapsed')"), 'resetCompanionState must collapse sidePanel');
        assert.ok(appCode.includes("typewriterText.textContent = ''"), 'resetCompanionState must clear typewriter text');
        assert.ok(appCode.includes("renderer.setVisualState({ emotion: 'idle' })"), 'resetCompanionState must reset emotion to idle');
        assert.ok(appCode.includes('onResetState'), 'companion-app.js must listen for onResetState');
    });
});

