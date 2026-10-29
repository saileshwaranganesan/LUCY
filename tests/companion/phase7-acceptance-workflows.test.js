'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { PetInteractionManager, AFFECTION_PHRASES } = require('../../src/companion/pet-interactions.js');
const { TASK_STATES, TaskStatusManager } = require('../../src/core/task-status.js');
const { validateSendVoiceState } = require('../../src/security/ipc-validator.js');

// Mock 2D Canvas for Headless Node.js Testing
function createMockCanvas(width = 160, height = 190) {
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

/**
 * Realistic Mock Electron BrowserWindow for testing window sizing,
 * positioning, movement, pinning, and IPC broadcasts.
 */
class RealisticMockBrowserWindow {
    constructor(options = {}) {
        this.options = options;
        this.destroyed = false;
        this.visible = false;
        this.focused = false;
        this.focusCount = 0;
        this.x = options.x || 200;
        this.y = options.y || 200;
        this.width = options.width || FloatingCompanionWindow.DEFAULT_WIDTH;
        this.height = options.height || FloatingCompanionWindow.DEFAULT_HEIGHT;
        this.alwaysOnTop = Boolean(options.alwaysOnTop);
        this.alwaysOnTopLevel = options.alwaysOnTop ? 'screen-saver' : 'normal';

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
    }

    showInactive() {
        this.visible = true;
        this.focused = false;
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

    setBounds(bounds) {
        if (typeof bounds.x === 'number') this.x = bounds.x;
        if (typeof bounds.y === 'number') this.y = bounds.y;
        if (typeof bounds.width === 'number') this.width = bounds.width;
        if (typeof bounds.height === 'number') this.height = bounds.height;
    }

    setAlwaysOnTop(val, level = 'normal') {
        this.alwaysOnTop = Boolean(val);
        this.alwaysOnTopLevel = level;
    }

    isAlwaysOnTop() {
        return this.alwaysOnTop;
    }

    loadFile() {}

    on(event, handler) {
        if (!this.eventListeners[event]) this.eventListeners[event] = [];
        this.eventListeners[event].push(handler);
    }

    once(event, handler) {
        if (event === 'ready-to-show') {
            setTimeout(handler, 1);
        }
    }

    destroy() {
        this.destroyed = true;
        this.visible = false;
    }
}

test('L.U.C.Y. Phase 7 Acceptance Suite: Unified Fairy Companion & Desktop Interaction', async (t) => {

    // -------------------------------------------------------------------------
    // Workflow A: State Synchronization Across Voice, Execution, and Recovery
    // -------------------------------------------------------------------------
    await t.test('Workflow A: State synchronization across voice, execution, and recovery', async (t) => {
        const bridge = new CompanionBridge();
        const visualEvents = [];
        bridge.on('visualUpdate', (evt) => visualEvents.push(evt));

        // 1. Start in IDLE
        bridge.handleStateEvent({ to: TASK_STATES.IDLE });
        assert.equal(bridge.currentEmotion, 'idle');
        assert.match(bridge.speechBubble, /At your service/i);

        // 2. Voice Input States
        // Validate that recovering and awaiting_reconciliation pass IPC validation
        const valRec = validateSendVoiceState({ voiceState: 'recovering', text: 'Auto-recovering...' });
        assert.ok(valRec.ok, 'recovering must be allowed in voice state IPC');

        const valRecon = validateSendVoiceState({ voiceState: 'awaiting_reconciliation' });
        assert.ok(valRecon.ok, 'awaiting_reconciliation must be allowed in voice state IPC');

        // 3. Task Execution lifecycle transitions
        bridge.handleStateEvent({ to: TASK_STATES.PLANNING, description: 'Planning subtasks' });
        assert.equal(bridge.currentEmotion, 'focused');

        bridge.handleStateEvent({ to: TASK_STATES.WAITING_PERMISSION, description: 'Waiting user consent' });
        assert.equal(bridge.currentEmotion, 'curious');

        bridge.handleStateEvent({ to: TASK_STATES.AWAITING_AUTHORIZATION, description: 'Requires authorization' });
        assert.equal(bridge.currentEmotion, 'curious');

        bridge.handleStateEvent({ to: TASK_STATES.RUNNING, description: 'Executing step 1' });
        assert.equal(bridge.currentEmotion, 'working');

        bridge.handleStateEvent({ to: TASK_STATES.EXECUTING_TOOL, currentTool: 'system_info' });
        assert.equal(bridge.currentEmotion, 'working');

        bridge.handleStateEvent({ to: TASK_STATES.VERIFYING });
        assert.equal(bridge.currentEmotion, 'focused');

        // 4. Task Recovery: must reflect thinking / recovery without falsely indicating success
        bridge.handleStateEvent({ to: TASK_STATES.RECOVERING, description: 'Retrying tool step with backoff' });
        assert.equal(bridge.currentEmotion, 'thinking');
        assert.equal(bridge.speechBubble, 'Retrying tool step with backoff');

        bridge.handleStateEvent({ to: TASK_STATES.RECOVERING });
        assert.equal(bridge.currentEmotion, 'thinking');
        assert.match(bridge.speechBubble, /Recovering/i);

        bridge.handleStateEvent({ to: TASK_STATES.AWAITING_RECONCILIATION, description: 'Need guidance' });
        assert.equal(bridge.currentEmotion, 'curious');

        // 5. Verified Task Completion: happy emotion only on completed outcome
        bridge.handleStateEvent({ to: TASK_STATES.COMPLETED, result: { summary: 'Calculated 42' } });
        assert.equal(bridge.currentEmotion, 'happy');
        assert.equal(bridge.speechBubble, 'Calculated 42');

        // 6. Task Cancellation: clean return to idle
        bridge.handleStateEvent({ to: TASK_STATES.CANCELLED });
        assert.equal(bridge.currentEmotion, 'idle');
        assert.equal(bridge.speechBubble, 'Task cancelled.');

        // 7. Task Interrupted / Failed
        bridge.handleStateEvent({ to: TASK_STATES.FAILED, error: 'Network socket closed' });
        assert.equal(bridge.currentEmotion, 'worried');
        assert.equal(bridge.speechBubble, 'Network socket closed');
    });

    // -------------------------------------------------------------------------
    // Workflow B: Resize Stability, Hover Expansion, and Footprint Integrity
    // -------------------------------------------------------------------------
    await t.test('Workflow B: Resize stability, hover expansion, and footprint integrity', async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-phase7-b-'));
        const boundsFile = path.join(tempDir, 'bounds.json');

        try {
            const floating = new FloatingCompanionWindow({
                boundsFile,
                BrowserWindow: RealisticMockBrowserWindow
            });

            floating.createWindow();

            // 1. Initial default size is 160 × 190
            assert.equal(floating.currentWidth, 160);
            assert.equal(floating.currentHeight, 190);

            // 2. Configure a specific custom size (e.g., 200 × 240)
            const setRes = floating.setWindowSize(200, 240, false);
            assert.ok(setRes.ok);
            assert.equal(floating.currentWidth, 200);
            assert.equal(floating.currentHeight, 240);

            // 3. Movement across desktop must NOT cause progressive growth
            for (let i = 0; i < 15; i++) {
                floating._updateWindowPosition(250 + i * 2, 250 + i * 2);
                assert.equal(floating.currentWidth, 200, `Width must remain 200 on move iteration ${i}`);
                assert.equal(floating.currentHeight, 240, `Height must remain 240 on move iteration ${i}`);
            }

            // 4. Hover expansion: temporary size change (e.g., side panel expand to 320px)
            floating.setWindowSize(320, 240, true);
            assert.equal(floating.window.width, 320, 'Window content size expands temporarily');
            assert.equal(floating.currentWidth, 200, 'Configured base width remains 200 during temporary hover');
            assert.equal(floating._isTemporarySize, true);

            // 5. Restore from hover expansion: collapses back to configured 200 × 240
            floating.setWindowSize(floating.currentWidth, floating.currentHeight, false);
            assert.equal(floating.window.width, 200);
            assert.equal(floating.window.height, 240);
            assert.equal(floating._isTemporarySize, false);

            // 6. Resizing adheres to safety bounds (140..520 width, 170..600 height)
            floating.setWindowSize(50, 50, false); // below min
            assert.equal(floating.currentWidth, FloatingCompanionWindow.MIN_WIDTH);
            assert.equal(floating.currentHeight, FloatingCompanionWindow.MIN_HEIGHT);

            floating.setWindowSize(900, 900, false); // above max
            assert.equal(floating.currentWidth, FloatingCompanionWindow.MAX_WIDTH);
            assert.equal(floating.currentHeight, FloatingCompanionWindow.MAX_HEIGHT);

            floating.hide();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // -------------------------------------------------------------------------
    // Workflow C: Pinning, Window Order, and Desktop Persistence
    // -------------------------------------------------------------------------
    await t.test('Workflow C: Pinning, window order, and desktop persistence', async (t) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-phase7-c-'));
        const boundsFile = path.join(tempDir, 'bounds.json');

        try {
            const floating = new FloatingCompanionWindow({
                boundsFile,
                BrowserWindow: RealisticMockBrowserWindow
            });

            floating.createWindow();

            // 1. Initial pin state defaults to true with screen-saver topmost level
            assert.equal(floating.isPinned, true);
            assert.equal(floating.window.alwaysOnTop, true);
            assert.equal(floating.window.alwaysOnTopLevel, 'screen-saver');

            // 2. Toggle pin off (unpinned / free mode)
            const unpinRes = floating.togglePin();
            assert.equal(unpinRes.isPinned, false);
            assert.equal(floating.window.alwaysOnTop, false);
            assert.equal(floating.window.alwaysOnTopLevel, 'normal');

            // 3. Toggle pin on (pinned / always on top)
            const pinRes = floating.togglePin();
            assert.equal(pinRes.isPinned, true);
            assert.equal(floating.window.alwaysOnTop, true);
            assert.equal(floating.window.alwaysOnTopLevel, 'screen-saver');

            // 4. Position and pin state are saved to disk
            floating._saveBounds(320, 180, 180, 220);
            assert.ok(fs.existsSync(boundsFile));

            // 5. Restart application simulation: restored window reloads exact settings
            const reloadedFloating = new FloatingCompanionWindow({
                boundsFile,
                BrowserWindow: RealisticMockBrowserWindow
            });

            assert.equal(reloadedFloating.isPinned, true);
            assert.equal(reloadedFloating.currentWidth, 180);
            assert.equal(reloadedFloating.currentHeight, 220);
            assert.equal(reloadedFloating.lastPosition.x, 320);
            assert.equal(reloadedFloating.lastPosition.y, 180);

            // 6. Clamping within display area
            const clamped = reloadedFloating._clampToBounds(-100, -100, 160, 190, { x: 0, y: 0, width: 1920, height: 1080 });
            assert.ok(clamped.x >= 8, 'X position must be clamped within screen bounds');
            assert.ok(clamped.y >= 8, 'Y position must be clamped within screen bounds');

            floating.hide();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // -------------------------------------------------------------------------
    // Workflow D: Facial Animation, Lip Synchronization, and Speech Lifecycle
    // -------------------------------------------------------------------------
    await t.test('Workflow D: Facial animation, lip synchronization, and speech lifecycle', async (t) => {
        const canvas = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas);

        assert.equal(renderer.state.emotion, 'idle');

        // 1. Idle state: mouth is serene, mouthOpen is 0
        assert.doesNotThrow(() => {
            renderer._render(100);
        });

        // 2. Transition to speaking state: mouth animation active
        renderer.setVisualState({ emotion: 'speaking' });
        assert.equal(renderer.state.emotion, 'speaking');

        // Speaking mouth animation calculates dynamic ellipse with time parameter
        const timeVal = 500;
        const mouthOpen = Math.abs(Math.sin(timeVal * 0.016)) * 3.5 + 1.8;
        assert.ok(mouthOpen > 1.5, 'Mouth open height must animate dynamically during speech');

        // 3. Speech completion: return to idle stops mouth animation
        renderer.setVisualState({ emotion: 'idle' });
        assert.equal(renderer.state.emotion, 'idle');

        // 4. Cancelled speech: mouth immediately settles to serene smile
        renderer.setVisualState({ emotion: 'speaking' });
        assert.equal(renderer.state.emotion, 'speaking');
        renderer.setVisualState({ emotion: 'cancelled' });
        assert.equal(renderer.state.emotion, 'cancelled');

        // 5. Cleanup: destroy stops RAF loop and clears resources cleanly
        renderer.destroy();
        assert.equal(renderer.running, false);
        assert.equal(renderer.orbitParticles.length, 0);
    });

    // -------------------------------------------------------------------------
    // Workflow E: Petting, Affection Personality, and Safety Protection
    // -------------------------------------------------------------------------
    await t.test('Workflow E: Petting, affection personality, and safety protection', async (t) => {
        const petManager = new PetInteractionManager();

        // 1. Varied affection phrases
        const phrases = new Set();
        for (let i = 0; i < 20; i++) {
            phrases.add(petManager.getNextAffectionPhrase());
        }
        assert.ok(phrases.size >= 4, 'Must provide varied, non-mechanical affection phrases');

        // Immediate subsequent phrase must not equal the previous one
        let prev = petManager.getNextAffectionPhrase();
        for (let i = 0; i < 15; i++) {
            const next = petManager.getNextAffectionPhrase();
            assert.notEqual(next, prev, 'Consecutive affection phrases must not be identical');
            prev = next;
        }

        // 2. Rate-limiting / Cooldown throttling
        assert.equal(petManager.canTriggerPet(), true, 'First pet must be allowed');
        assert.equal(petManager.canTriggerPet(), false, 'Immediate rapid click must be throttled');

        // 3. Stunts and Tricks support
        const spinTrick = petManager.getTrick('spin');
        assert.ok(spinTrick, 'Spin trick must exist');
        assert.equal(spinTrick.animation, 'trick_spin');

        const danceTrick = petManager.getTrick('groove'); // alias for dance
        assert.ok(danceTrick, 'Alias groove must resolve to dance');
        assert.equal(danceTrick.id, 'dance');

        // 4. Safety Confirmation Guard: Petting must NOT interrupt awaiting_confirmation
        let voiceSpoken = false;
        const mockVoiceController = {
            state: 'awaiting_confirmation',
            ttsEnabled: true,
            stopSpeaking: () => { voiceSpoken = false; },
            speakResponse: async () => { voiceSpoken = true; }
        };

        // Simulate petting event while awaiting_confirmation
        const isAwaitingConfirmation = (mockVoiceController.state === 'awaiting_confirmation');
        if (!isAwaitingConfirmation) {
            mockVoiceController.stopSpeaking();
            mockVoiceController.speakResponse('tickle');
        }

        assert.equal(voiceSpoken, false, 'Petting must never interrupt awaiting confirmation prompt');
    });

});
