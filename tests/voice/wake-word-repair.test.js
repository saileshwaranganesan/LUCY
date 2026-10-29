'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WakeWordEngine, PRIVACY_STATES } = require('../../src/voice/wake-word-engine.js');
const { VoiceController, VOICE_STATES, RECOGNITION_MODES } = require('../../src/voice/voice-controller.js');
const { synthesizeHeyLucy, synthesizeLucy, synthesizeSilence, synthesizeBackgroundNoise, synthesizeHello, synthesizeHeyLucky } = require('../../src/voice/acoustic-synthesizer.js');

test('L.U.C.Y. Targeted Wake-Word Repair Suite (REQ-028)', async (t) => {

    await t.test('1. Streaming chunk ingestion detects "Hey Lucy" even with preceding silence/ambient noise in sliding buffer', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.65,
            cooldownMs: 0
        });

        let detected = null;
        engine.on('wakeWordDetected', (res) => {
            detected = res;
        });

        // 1 second of silence + "Hey Lucy" + 1 second of silence
        const silence1s = synthesizeSilence(1000);
        const speech = synthesizeHeyLucy();
        const combined = new Float32Array(silence1s.length + speech.length + silence1s.length);
        combined.set(silence1s, 0);
        combined.set(speech, silence1s.length);
        combined.set(silence1s, silence1s.length + speech.length);

        // Feed in real 2048-sample chunks as Web Audio delivers
        for (let i = 0; i < combined.length; i += 2048) {
            const chunk = combined.subarray(i, Math.min(i + 2048, combined.length));
            engine.processInput({ audioFrame: chunk });
            if (detected) break;
        }

        assert.ok(detected !== null, 'Wake word must be detected when arriving in continuous streaming buffer');
        assert.ok(['hey lucy', 'lucy'].includes(detected.keyword));
        assert.ok(detected.confidence >= 0.65);

        engine.dispose();
    });

    await t.test('2. Streaming chunk ingestion detects "Lucy" keyword with preceding silence', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.65,
            cooldownMs: 0
        });

        let detected = null;
        engine.on('wakeWordDetected', (res) => {
            detected = res;
        });

        const silence1s = synthesizeSilence(1000);
        const speech = synthesizeLucy();
        const combined = new Float32Array(silence1s.length + speech.length + silence1s.length);
        combined.set(silence1s, 0);
        combined.set(speech, silence1s.length);
        combined.set(silence1s, silence1s.length + speech.length);

        for (let i = 0; i < combined.length; i += 2048) {
            const chunk = combined.subarray(i, Math.min(i + 2048, combined.length));
            engine.processInput({ audioFrame: chunk });
            if (detected) break;
        }

        assert.ok(detected !== null, 'Standalone keyword "Lucy" must be detected in streaming buffer');
        assert.equal(detected.keyword, 'lucy');

        engine.dispose();
    });

    await t.test('3. Streaming negatives ("Hey Lucky", "Hello", Noise) do not cause false activation in sliding buffer', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.65,
            cooldownMs: 0
        });

        let detected = null;
        engine.on('wakeWordDetected', (res) => {
            detected = res;
        });

        const silence1s = synthesizeSilence(1000);
        const lucky = synthesizeHeyLucky();
        const streamLucky = new Float32Array(silence1s.length + lucky.length + silence1s.length);
        streamLucky.set(silence1s, 0);
        streamLucky.set(lucky, silence1s.length);
        streamLucky.set(silence1s, silence1s.length + lucky.length);

        for (let i = 0; i < streamLucky.length; i += 2048) {
            const chunk = streamLucky.subarray(i, Math.min(i + 2048, streamLucky.length));
            engine.processInput({ audioFrame: chunk });
        }

        assert.equal(detected, null, 'Near-miss "Hey Lucky" must not trigger detection');

        // Test noise stream
        const noise = synthesizeBackgroundNoise(2000, 0.05);
        for (let i = 0; i < noise.length; i += 2048) {
            const chunk = noise.subarray(i, Math.min(i + 2048, noise.length));
            engine.processInput({ audioFrame: chunk });
        }

        assert.equal(detected, null, 'Background noise must not trigger detection');

        engine.dispose();
    });

    await t.test('4. Wake-word detection triggers command capture after acknowledgment speech completes', async () => {
        let commandStarted = false;
        let commandTranscribed = false;
        let speechStarted = false;
        let speechFinished = false;

        const stateTransitions = [];

        const mockRecorder = {
            supported: true,
            isCapturing: true,
            startContinuousCapture: async () => true,
            stopContinuousCapture: async () => true,
            setWakeWordCallback: () => {},
            start: async () => {
                commandStarted = true;
                return true;
            },
            stop: async () => {
                return new Uint8Array(200);
            },
            cancel: () => {}
        };

        const mockWhisper = {
            isAvailable: () => true,
            getStatus: () => ({ isAvailable: true }),
            transcribeAudio: async () => {
                commandTranscribed = true;
                return { ok: true, transcript: 'open notepad' };
            }
        };

        const mockSynthesis = {
            supported: true,
            isSpeaking: false,
            speak: async (text, options = {}) => {
                speechStarted = true;
                if (typeof options.onStart === 'function') options.onStart();
                await new Promise(r => setTimeout(r, 50));
                speechFinished = true;
                return true;
            },
            stop: () => {},
            getVoiceConfig: () => ({ pitch: 1.05, rate: 1.02 }),
            setVoiceConfig: () => {}
        };

        const controller = new VoiceController({
            whisperEngine: mockWhisper,
            audioRecorder: mockRecorder,
            synthesis: mockSynthesis,
            recognitionMode: RECOGNITION_MODES.OFFLINE,
            enableVad: false,
            wakeWordEnabled: true,
            onWakeWord: () => {
                // UI simulates speaking prompt on wake word
                controller.speak("I'm listening! How can I help?").catch(() => {});
            },
            onWakeWordStateChange: (info) => {
                stateTransitions.push(info.state);
            }
        });

        // Emit wakeWordDetected on engine
        controller.wakeWordEngine.emit('wakeWordDetected', { keyword: 'hey lucy', confidence: 0.95 });

        // Speech should start first without command listening recording Lucy's own speech
        assert.equal(speechStarted, true, 'Acknowledgment speech should start');

        // Wait for prompt speech to finish
        await new Promise(r => setTimeout(r, 100));

        assert.equal(speechFinished, true, 'Speech must have completed');
        assert.equal(commandStarted, true, 'Command capture must start immediately after prompt completes');
        assert.equal(controller.voiceState, VOICE_STATES.LISTENING);
        assert.ok(stateTransitions.includes('waiting_for_command') || stateTransitions.includes('listening'));

        // Complete user command
        controller.stopListening();
        await new Promise(r => setTimeout(r, 50));

        assert.equal(commandTranscribed, true, 'Command must be transcribed');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);

        controller.dispose();
    });

    await t.test('5. Anti-echo debounce restores wake-word listening state after response finishes speaking', async () => {
        let wakeWordState = null;

        const mockRecorder = {
            supported: true,
            startContinuousCapture: async () => true,
            stopContinuousCapture: async () => true,
            setWakeWordCallback: () => {}
        };

        const mockSynthesis = {
            supported: true,
            isSpeaking: false,
            speak: async (text, options = {}) => {
                if (typeof options.onStart === 'function') options.onStart();
                await new Promise(r => setTimeout(r, 40));
                return true;
            },
            stop: () => {}
        };

        const controller = new VoiceController({
            audioRecorder: mockRecorder,
            synthesis: mockSynthesis,
            wakeWordEnabled: true,
            onWakeWordStateChange: (info) => {
                wakeWordState = info.state;
            }
        });

        assert.equal(wakeWordState, 'listening_wake');

        // Lucy speaks a response
        await controller.speakResponse('I have opened Notepad for you.');

        // Immediately after speech, anti-echo debounce is active
        assert.equal(controller.wakeWordEngine.isPaused, true);

        // Wait for 450ms anti-echo debounce to complete
        await new Promise(r => setTimeout(r, 500));

        assert.equal(controller.wakeWordEngine.isPaused, false);
        assert.equal(wakeWordState, 'listening_wake', 'Wake-word state must return to listening_wake');

        controller.dispose();
    });

    await t.test('6. Push-to-talk works independently and returns to wake-word listening afterwards', async () => {
        let transcribedText = '';

        const mockRecorder = {
            supported: true,
            isCapturing: true,
            startContinuousCapture: async () => true,
            stopContinuousCapture: async () => true,
            setWakeWordCallback: () => {},
            start: async () => true,
            stop: async () => new Uint8Array(200),
            cancel: () => {}
        };

        const mockWhisper = {
            isAvailable: () => true,
            getStatus: () => ({ isAvailable: true }),
            transcribeAudio: async () => ({ ok: true, transcript: 'take screenshot' })
        };

        const controller = new VoiceController({
            whisperEngine: mockWhisper,
            audioRecorder: mockRecorder,
            wakeWordEnabled: true,
            recognitionMode: RECOGNITION_MODES.OFFLINE,
            enableVad: false,
            onFinalTranscript: (t) => {
                transcribedText = t;
            }
        });

        // Push-to-talk explicitly pressed
        controller.startListening();
        assert.equal(controller.isListening, true);
        assert.equal(controller.wakeWordEngine.isPaused, true, 'Wake word pauses during PTT');

        // User releases PTT
        controller.stopListening();
        await new Promise(r => setTimeout(r, 50));

        assert.equal(transcribedText, 'take screenshot');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
        assert.equal(controller.wakeWordEngine.isPaused, false, 'Wake word resumes after PTT');

        controller.dispose();
    });

    await t.test('7. Missing microphone permission produces truthful error state and does not pretend to listen', async () => {
        const stateLog = [];

        const mockRecorder = {
            supported: true,
            startContinuousCapture: async () => {
                const err = new Error('NotAllowedError: Permission denied by system');
                err.name = 'NotAllowedError';
                throw err;
            },
            stopContinuousCapture: async () => true
        };

        const controller = new VoiceController({
            audioRecorder: mockRecorder,
            wakeWordEnabled: false,
            onWakeWordStateChange: (info) => {
                stateLog.push(info.state);
            }
        });

        const result = controller.setWakeWordEnabled(true);
        await new Promise(r => setTimeout(r, 30));

        assert.equal(controller.wakeWordEngine.enabled, false);
        assert.ok(stateLog.includes('failed'), 'Must report failed state on denied permission');

        controller.dispose();
    });

    await t.test('8. Repeated wake-word events during cooldown do not duplicate command execution', () => {
        let triggerCount = 0;

        const engine = new WakeWordEngine({
            enabled: true,
            cooldownMs: 3000
        });

        engine.on('wakeWordDetected', () => {
            triggerCount++;
        });

        // Trigger 1
        const res1 = engine.processInput({ transcriptCandidate: 'hey lucy please help' });
        assert.ok(res1 !== null);
        assert.equal(triggerCount, 1);

        // Immediate duplicate trigger 2 (within 3000ms cooldown)
        const res2 = engine.processInput({ transcriptCandidate: 'hey lucy please help again' });
        assert.equal(res2, null, 'Must be rejected during cooldown');
        assert.equal(triggerCount, 1, 'Trigger count must remain 1');

        engine.dispose();
    });
});
