'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { AFFECTION_PHRASES, TRICK_DEFINITIONS, PetInteractionManager } = require('../../src/companion/pet-interactions.js');
const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');

// Mock HTML5 2D Canvas & Context for deterministic Node.js renderer testing
function createMockCanvas(width = 280, height = 280) {
    const drawingCalls = [];
    const mockCtx = {
        save: () => drawingCalls.push({ type: 'save' }),
        restore: () => drawingCalls.push({ type: 'restore' }),
        beginPath: () => drawingCalls.push({ type: 'beginPath' }),
        closePath: () => drawingCalls.push({ type: 'closePath' }),
        moveTo: (x, y) => drawingCalls.push({ type: 'moveTo', x, y }),
        lineTo: (x, y) => drawingCalls.push({ type: 'lineTo', x, y }),
        arc: (x, y, r, sa, ea) => drawingCalls.push({ type: 'arc', x, y, r, sa, ea }),
        ellipse: (x, y, rx, ry, rot, sa, ea) => drawingCalls.push({ type: 'ellipse', x, y, rx, ry, rot, sa, ea }),
        quadraticCurveTo: (cpx, cpy, x, y) => drawingCalls.push({ type: 'quadraticCurveTo', cpx, cpy, x, y }),
        bezierCurveTo: (cp1x, cp1y, cp2x, cp2y, x, y) => drawingCalls.push({ type: 'bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y }),
        fill: () => drawingCalls.push({ type: 'fill' }),
        stroke: () => drawingCalls.push({ type: 'stroke' }),
        clearRect: (x, y, w, h) => drawingCalls.push({ type: 'clearRect', x, y, w, h }),
        translate: (x, y) => drawingCalls.push({ type: 'translate', x, y }),
        scale: (sx, sy) => drawingCalls.push({ type: 'scale', sx, sy }),
        rotate: (angle) => drawingCalls.push({ type: 'rotate', angle }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        lineCap: 'butt',
        globalAlpha: 1,
        shadowColor: '',
        shadowBlur: 0
    };

    const listeners = new Map();
    const mockCanvas = {
        width,
        height,
        getContext: (type) => (type === '2d' ? mockCtx : null),
        getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
        addEventListener: (event, handler) => {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(handler);
        },
        removeEventListener: (event, handler) => {
            const arr = listeners.get(event) || [];
            const idx = arr.indexOf(handler);
            if (idx !== -1) arr.splice(idx, 1);
        },
        _trigger: (event, e) => {
            const arr = listeners.get(event) || [];
            for (const h of arr) h(e);
        },
        _drawingCalls: drawingCalls
    };

    return { canvas: mockCanvas, ctx: mockCtx, drawingCalls };
}

test('L.U.C.Y. Repair 4: Interactive Virtual Pet Behaviour, Affection & Animations Suite', async (t) => {

    await t.test('1. Pet Interactions Engine: Affection Phrase Variety & Rate-Limiting', () => {
        const mgr = new PetInteractionManager();
        assert.ok(AFFECTION_PHRASES.length >= 8, 'Must have at least 8 varied affection phrases');

        // Verify non-repetition: consecutive calls must not yield the identical phrase
        const sampled = [];
        let previous = null;
        for (let i = 0; i < 30; i++) {
            const phrase = mgr.getNextAffectionPhrase();
            assert.ok(phrase && typeof phrase === 'string', 'Phrase must be a non-empty string');
            assert.notEqual(phrase, previous, `Phrase '${phrase}' must not be consecutively repeated`);
            previous = phrase;
            if (!sampled.includes(phrase)) sampled.push(phrase);
        }

        // Must exhibit genuine variety across 30 calls
        assert.ok(sampled.length >= 5, `Expected variety of phrases, sampled ${sampled.length} unique phrases`);

        // Test rate-limiting / cooldown
        const canPet1 = mgr.canTriggerPet();
        assert.equal(canPet1, true, 'First pet should succeed immediately');

        const canPetSpam = mgr.canTriggerPet();
        assert.equal(canPetSpam, false, 'Spam pet within cooldown window should be throttled');

        // Advance simulated time past cooldown
        mgr.lastPetTime = Date.now() - 500;
        assert.equal(mgr.canTriggerPet(), true, 'Pet should succeed once cooldown has elapsed');
    });

    await t.test('2. Trick Definitions & Aliases: Complete Stunts Support', () => {
        const mgr = new PetInteractionManager();
        const tricks = mgr.listTricks();
        assert.equal(tricks.length, 6, 'Must define exactly 6 core stunts (spin, jump, fly, bounce, somersault, dance)');

        const expectedTricks = ['spin', 'jump', 'fly', 'bounce', 'somersault', 'dance'];
        for (const id of expectedTricks) {
            const trick = mgr.getTrick(id);
            assert.ok(trick, `Trick '${id}' must be defined`);
            assert.equal(trick.id, id);
            assert.ok(trick.duration > 0, `Trick '${id}' must have a positive duration`);
            assert.ok(trick.message, `Trick '${id}' must have a dialogue message`);
        }

        // Test trick aliases
        assert.equal(mgr.getTrick('twirl').id, 'spin');
        assert.equal(mgr.getTrick('leap').id, 'jump');
        assert.equal(mgr.getTrick('glide').id, 'fly');
        assert.equal(mgr.getTrick('flutter').id, 'bounce');
        assert.equal(mgr.getTrick('flip').id, 'somersault');
        assert.equal(mgr.getTrick('loop').id, 'somersault');
        assert.equal(mgr.getTrick('groove').id, 'dance');
    });

    await t.test('3. Petting Produces Observable Reaction: Hearts, Raised Arms & Return to Happy', () => {
        const { canvas } = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);

        assert.equal(renderer.state.emotion, 'idle');
        renderer.setVisualState({ emotion: 'pet' });

        assert.equal(renderer.state.emotion, 'pet', 'Emotion state should be pet');
        assert.ok(renderer.burstParticles.length > 0, 'Petting must spawn heart/sparkle burst particles');
        assert.ok(renderer.state.actionDuration > 0, 'Petting must have actionDuration set');

        // Test render pass during pet state
        renderer._render(1000);
        assert.ok(canvas._drawingCalls.length > 50, 'Render pass should draw character elements');

        // Simulate update frames to verify automatic transition back to happy/idle
        const dt = 0.1;
        for (let time = 0; time < 2500; time += 100) {
            renderer._update(time, dt);
        }

        assert.equal(renderer.state.emotion, 'happy', 'Pet reaction must return smoothly to happy/idle');
    });

    await t.test('4. Somersault Stunt: Full 360-degree Aerial Loop & Clean Return to Idle', () => {
        const { canvas } = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);

        renderer.playTrick('somersault');
        assert.equal(renderer.state.emotion, 'trick_somersault');
        assert.equal(renderer.state.actionDuration, 1.8);
        assert.equal(renderer.targetFps, 60, 'Stunts run at 60 FPS');

        // Mid-stunt simulation: verify rotation and vertical arc
        renderer._update(500, 0.9); // halfway through 1.8s
        assert.ok(renderer.state.somersaultAngle > 0, 'Somersault angle must rotate');
        assert.ok(renderer.state.transitionOffset < 0, 'Somersault must arc upwards vertically');

        // Finish stunt duration
        renderer._update(1900, 1.0);
        assert.equal(renderer.state.emotion, 'idle', 'Must return to idle after duration completes');
        assert.equal(renderer.state.somersaultAngle, 0, 'Somersault angle must reset to 0');
        assert.equal(renderer.state.transitionOffset, 0, 'Transition offset must reset to 0');
        assert.equal(renderer.state.scaleY, 1.0, 'Scale must reset to 1.0');
    });

    await t.test('5. Starlight Dance Stunt: Melodic Sway, Arm Waves & Return to Idle', () => {
        const { canvas } = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);

        renderer.playTrick('dance');
        assert.equal(renderer.state.emotion, 'trick_dance');
        assert.equal(renderer.state.actionDuration, 2.4);

        // Mid-dance simulation
        renderer._update(1200, 1.2);
        assert.notEqual(renderer.state.flightOffsetX, 0, 'Dance must oscillate horizontal position');
        assert.ok(renderer.state.danceArmWave !== undefined, 'Dance arm wave must be defined');

        // Finish dance
        renderer._update(2500, 1.3);
        assert.equal(renderer.state.emotion, 'idle', 'Must return to idle after dance');
        assert.equal(renderer.state.flightOffsetX, 0, 'Flight offset must reset to 0');
        assert.equal(renderer.state.danceArmWave, 0, 'Dance arm wave must reset to 0');
    });

    await t.test('6. Spin, Jump, Fly, and Bounce Stunts: Real Procedural Physics & Idle Return', () => {
        const stunts = ['spin', 'jump', 'fly', 'bounce'];
        for (const stunt of stunts) {
            const { canvas } = createMockCanvas(280, 280);
            const renderer = new CelestialFamiliarRenderer(canvas);

            renderer.playTrick(stunt);
            assert.equal(renderer.state.emotion, `trick_${stunt}`);
            assert.ok(renderer.state.actionDuration > 0);

            // Step through physics to end
            const totalSteps = Math.ceil(renderer.state.actionDuration / 0.1) + 2;
            for (let s = 0; s < totalSteps; s++) {
                renderer._update(s * 100, 0.1);
            }

            assert.equal(renderer.state.emotion, 'idle', `${stunt} must return to idle`);
            assert.equal(renderer.state.transitionOffset, 0);
            assert.equal(renderer.state.spinAngle, 0);
        }
    });

    await t.test('7. Idle Animations: Floating Hover, Blinking, Subtle Breathing & Eye Saccades', () => {
        const { canvas } = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);
        renderer.setVisualState({ emotion: 'idle' });

        // Simulate 4 seconds of idle time
        let sawBlink = false;
        let sawSaccade = false;

        for (let t = 0; t <= 4500; t += 100) {
            renderer._update(t, 0.1);
            if (renderer.state.blinkProgress > 0) sawBlink = true;
            if (renderer.state.eyeTargetX !== 0 || renderer.state.eyeTargetY !== 0) sawSaccade = true;
        }

        assert.ok(renderer.state.hoverPhase !== 0, 'Idle must produce floating hover wave');
        assert.ok(sawBlink, 'Idle must naturally blink eyes periodically');
        assert.ok(sawSaccade, 'Idle must perform subtle eye glances/saccades');
        assert.ok(renderer.state.scaleY >= 0.98 && renderer.state.scaleY <= 1.02, 'Subtle breathing oscillation');
    });

    await t.test('8. Emotional Reactions: Expressive Cheeks, Mouth & Eyes', () => {
        const { canvas } = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);

        const emotions = ['happy', 'curious', 'sleep', 'worried', 'surprised', 'pet'];
        for (const emotion of emotions) {
            renderer.setVisualState({ emotion });
            assert.equal(renderer.state.emotion, emotion);

            const palette = renderer._getColorPalette();
            assert.ok(palette.aura, `Emotion '${emotion}' must have ambient aura`);
            assert.ok(palette.auraGlow, `Emotion '${emotion}' must have auraGlow`);

            // Verify render pass completes without throwing
            assert.doesNotThrow(() => {
                renderer._render(1500);
            }, `Rendering emotion '${emotion}' must be coherent`);
        }
    });

    await t.test('9. Incompatible Stunts Queue Guard: Triggering New Action Replaces Prior State', () => {
        const { canvas } = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);

        renderer.playTrick('spin');
        assert.equal(renderer.state.emotion, 'trick_spin');
        renderer._update(500, 0.5);
        assert.ok(renderer.state.spinAngle > 0);

        // Interrupt with somersault
        renderer.playTrick('somersault');
        assert.equal(renderer.state.emotion, 'trick_somersault');
        assert.equal(renderer.state.spinAngle, 0, 'Previous stunt angle must reset cleanly');
        assert.equal(renderer.state.actionTimer, 0, 'Timer must reset for new stunt');

        // Finish somersault
        for (let s = 0; s < 25; s++) renderer._update(s * 100, 0.1);
        assert.equal(renderer.state.emotion, 'idle');
    });

    await t.test('10. Voice Integration Guard: Respects TTS Enabled/Disabled & Debounces Audio', async () => {
        let stopSpeakingCalls = 0;
        let speakResponseCalls = 0;
        let lastSpokenText = null;

        const mockVoiceController = {
            ttsEnabled: true,
            isSpeaking: false,
            stopSpeaking: () => { stopSpeakingCalls++; },
            speakResponse: async (text) => {
                speakResponseCalls++;
                lastSpokenText = text;
                return true;
            }
        };

        const mgr = new PetInteractionManager();

        // Handler simulation with voice enabled
        function simulatePet(voiceCtrl) {
            if (!mgr.canTriggerPet()) return false;
            const phrase = mgr.getNextAffectionPhrase();
            if (voiceCtrl && voiceCtrl.ttsEnabled) {
                voiceCtrl.stopSpeaking();
                voiceCtrl.speakResponse(phrase);
            }
            return true;
        }

        // Pet with voice enabled
        const ok1 = simulatePet(mockVoiceController);
        assert.equal(ok1, true);
        assert.equal(stopSpeakingCalls, 1, 'Must stop any prior speech immediately');
        assert.equal(speakResponseCalls, 1, 'Must speak affectionate response');
        assert.ok(lastSpokenText, 'Spoken text must be set');

        // Pet with voice disabled
        mockVoiceController.ttsEnabled = false;
        mgr.lastPetTime = Date.now() - 500; // bypass cooldown
        const ok2 = simulatePet(mockVoiceController);
        assert.equal(ok2, true);
        assert.equal(speakResponseCalls, 1, 'Must NOT invoke speech synthesis when voice is disabled');
    });

    await t.test('11. Desktop Floating and Main View Synchronization Guard', () => {
        const bridge = new CompanionBridge();
        const recorded = [];
        bridge.on('visualUpdate', (e) => recorded.push(e));

        const petResult = bridge.handleUserInteraction('pet');
        assert.equal(petResult.acknowledged, true);
        assert.equal(bridge.currentEmotion, 'happy');

        // Verify bridge interaction does NOT execute task coordinator AI planning
        let aiPlannerTriggered = false;
        bridge.taskCoordinator = {
            executeRequest: () => { aiPlannerTriggered = true; }
        };

        bridge.handleUserInteraction('pet');
        assert.equal(aiPlannerTriggered, false, 'Petting must NEVER send tasks to AI coordinator or task planner');
    });

    await t.test('12. Lifecycle Cleanup Guard: Stopping Renderer Halts RAF & Events', () => {
        const { canvas } = createMockCanvas(280, 280);
        const renderer = new CelestialFamiliarRenderer(canvas);

        renderer.start();
        assert.equal(renderer.running, true);

        renderer.stop();
        assert.equal(renderer.running, false);

        renderer.destroy();
        assert.equal(renderer.running, false);
    });
});
