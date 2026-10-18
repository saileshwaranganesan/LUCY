'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { WakeWordEngine, PRIVACY_STATES } = require('../../src/voice/wake-word-engine.js');
const { VoiceController, VOICE_STATES, RECOGNITION_MODES } = require('../../src/voice/voice-controller.js');
const { synthesizeHeyLucy, synthesizeLucy, synthesizeSilence } = require('../../src/voice/acoustic-synthesizer.js');

test('L.U.C.Y. Repair 6: Hands-Free Wake-Word Detection & Pipeline Activation Suite', async (t) => {

    await t.test('1. Detector initialization, supported vocabulary & keyword templates', () => {
        const engine = new WakeWordEngine({ enabled: false });
        assert.equal(engine.enabled, false);
        assert.equal(engine.getPrivacyState().state, PRIVACY_STATES.DISABLED);

        // Verify supported vocabulary
        assert.ok(engine.keywords.includes('hey lucy'));
        assert.ok(engine.keywords.includes('lucy'));

        // Verify underlying acoustic model loaded reference templates
        assert.ok(engine.acousticModel);
        assert.ok('hey lucy' in engine.acousticModel.templates);
        assert.ok('lucy' in engine.acousticModel.templates);
        assert.ok(engine.acousticModel.templates['hey lucy'].length >= 1);
        assert.ok(engine.acousticModel.templates['lucy'].length >= 1);

        engine.dispose();
    });

    await t.test('2. Truthful UI state transitions across wake-word lifecycle', async () => {
        const stateHistory = [];
        let wakeWordFired = null;

        // Mock recorder simulating microphone frames
        let continuousCaptureCallback = null;
        let isCapturing = false;
        const mockRecorder = {
            supported: true,
            startContinuousCapture: async ({ onAudioFrame }) => {
                continuousCaptureCallback = onAudioFrame;
                isCapturing = true;
                return true;
            },
            stopContinuousCapture: async () => {
                continuousCaptureCallback = null;
                isCapturing = false;
                return true;
            },
            start: async () => true,
            stop: async () => new Uint8Array(100),
            cancel: () => {}
        };

        const mockWhisper = {
            isAvailable: () => true,
            getStatus: () => ({ isAvailable: true }),
            transcribeAudio: async () => ({ ok: true, transcript: 'open status report' })
        };

        const mockSynthesis = {
            supported: true,
            speak: async () => true,
            cancel: () => {},
            getVoiceConfig: () => ({ pitch: 1.05, rate: 1.02 }),
            setVoiceConfig: () => {}
        };

        const vc = new VoiceController({
            whisperEngine: mockWhisper,
            audioRecorder: mockRecorder,
            synthesis: mockSynthesis,
            recognitionMode: RECOGNITION_MODES.OFFLINE,
            enableVad: false,
            onWakeWordStateChange: (info) => {
                stateHistory.push(info.state);
            },
            onWakeWord: (res) => {
                wakeWordFired = res;
            }
        });

        // 1. Initial state: disabled
        assert.equal(vc.getWakeWordStatus().enabled, false);
        assert.equal(isCapturing, false);

        // 2. Enable wake-word detection -> transitions to 'listening_wake'
        vc.setWakeWordEnabled(true);
        assert.equal(vc.getWakeWordStatus().enabled, true);
        assert.equal(isCapturing, true);
        assert.ok(stateHistory.includes('listening_wake'));

        // 3. Audio frame representing "Hey Lucy" arrives from microphone
        const heyLucyPcm = synthesizeHeyLucy();
        continuousCaptureCallback(heyLucyPcm);

        // 4. Verification: wake-word triggered event and transition into command listening
        assert.ok(wakeWordFired !== null, 'Wake word callback must be fired on matching acoustic input');
        assert.equal(wakeWordFired.keyword, 'hey lucy');
        assert.ok(wakeWordFired.confidence >= 0.6);

        // 5. Check state history: triggered -> waiting_for_command (listening)
        assert.ok(stateHistory.includes('triggered'), 'Must emit triggered state for visual feedback');
        assert.ok(stateHistory.includes('waiting_for_command'), 'Must emit waiting_for_command when listening begins');
        assert.equal(vc.voiceState, VOICE_STATES.LISTENING);

        // 6. Push-to-talk / speech endpoint finishes listening -> transitions to processing
        vc.stopListening();
        assert.ok(stateHistory.includes('processing_command'), 'Must emit processing_command while transcribing');

        // Allow promise microtask queue to settle
        await new Promise(r => setTimeout(r, 50));

        // 7. Command transcription completes -> returns to IDLE and automatically resumes wake-word listening
        assert.equal(vc.voiceState, VOICE_STATES.IDLE);
        assert.equal(stateHistory[stateHistory.length - 1], 'listening_wake');
        assert.equal(isCapturing, true, 'Continuous microphone capture must resume once idle');

        // 8. Disable wake-word -> releases microphone capture cleanly
        vc.setWakeWordEnabled(false);
        assert.equal(vc.getWakeWordStatus().enabled, false);
        assert.equal(isCapturing, false, 'Continuous microphone capture must stop when disabled');
        assert.equal(stateHistory[stateHistory.length - 1], 'disabled');

        vc.dispose();
    });

    await t.test('3. Cooldown and debounce prevent duplicate activations', () => {
        let triggerCount = 0;
        const engine = new WakeWordEngine({
            enabled: true,
            cooldownMs: 2000,
            confidenceThreshold: 0.6
        });

        engine.on('wakeWordDetected', () => {
            triggerCount++;
        });

        const pcm1 = synthesizeHeyLucy();
        const res1 = engine.processInput({ audioFrame: pcm1 });
        assert.ok(res1 !== null);
        assert.equal(triggerCount, 1);

        // Rapid duplicate acoustic frame within cooldown window must be rejected
        const pcm2 = synthesizeHeyLucy();
        const res2 = engine.processInput({ audioFrame: pcm2 });
        assert.equal(res2, null, 'Rapid duplicate frame must be suppressed by debounce/cooldown');
        assert.equal(triggerCount, 1);

        engine.dispose();
    });

    await t.test('4. Sensitivity adjustment updates detection threshold', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.65,
            sensitivity: 0.5
        });

        assert.equal(engine.sensitivity, 0.5);

        // Higher sensitivity lowers threshold
        engine.setSensitivity(0.9);
        assert.equal(engine.sensitivity, 0.9);
        assert.ok(engine.confidenceThreshold < 0.65);

        // Lower sensitivity raises threshold
        engine.setSensitivity(0.2);
        assert.equal(engine.sensitivity, 0.2);
        assert.ok(engine.confidenceThreshold > 0.65);

        engine.dispose();
    });

    await t.test('5. Non-matching acoustic energy does not activate hands-free trigger', () => {
        let triggerCount = 0;
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.65
        });

        engine.on('wakeWordDetected', () => {
            triggerCount++;
        });

        // Silence
        const silence = synthesizeSilence(16000);
        const resSilence = engine.processInput({ audioFrame: silence });
        assert.equal(resSilence, null);
        assert.equal(triggerCount, 0);

        // High frequency random noise
        const noise = new Float32Array(16000);
        for (let i = 0; i < noise.length; i++) {
            noise[i] = (Math.random() - 0.5) * 0.2;
        }
        const resNoise = engine.processInput({ audioFrame: noise });
        assert.equal(resNoise, null);
        assert.equal(triggerCount, 0);

        engine.dispose();
    });
});
