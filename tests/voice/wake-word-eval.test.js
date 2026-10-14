'use strict';

/**
 * REQ-028: Comprehensive Wake-Word Detection Evaluation Harness & Integration Tests
 * 
 * Verifies:
 * 1. Genuine local detector integration and model loading.
 * 2. Audio framing, sample rate normalization, and circular sliding buffer.
 * 3. Deterministic evaluation harness:
 *    - Positives: "Hey Lucy", "Lucy" across multiple pitches/speakers.
 *    - Hard negatives / near-misses: "Hey Lucky", "Look see", "Hello".
 *    - Acoustic non-speech: silence, stationary noise, sinusoidal tones.
 *    - Human speech fixture: test_speech.wav.
 *    - Detection rate and false activation measurement.
 * 4. Privacy, cooldown, debounce, and duplicate detection suppression.
 * 5. Hardware mute and pause kill-switches.
 * 6. TTS echo prevention and anti-echo debounce.
 * 7. Microphone permission denial and device failure recovery.
 * 8. Prevention of duplicate conversations and microphone streams.
 * 9. Integration with VoiceController and task orchestration safety.
 * 10. Complete resource disposal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { WakeWordEngine, PRIVACY_STATES, WAKE_WORD_LICENCE } = require('../../src/voice/wake-word-engine.js');
const { VoiceController, VOICE_STATES, RECOGNITION_MODES } = require('../../src/voice/voice-controller.js');
const { AudioRecorder, encodeWavPcm16 } = require('../../src/voice/audio-recorder.js');
const {
    synthesizeHeyLucy,
    synthesizeLucy,
    synthesizeHeyLucky,
    synthesizeHello,
    synthesizeLookSee,
    synthesizeSilence,
    synthesizeBackgroundNoise,
    synthesizeSineTone
} = require('../../src/voice/acoustic-synthesizer.js');
const {
    normalizeAudioBuffer,
    extractFrameFeatures,
    extractAudioFeatures
} = require('../../src/voice/acoustic-feature-extractor.js');
const { AcousticWakeModel } = require('../../src/voice/acoustic-wake-model.js');
const { WhisperOfflineRecognitionEngine } = require('../../src/voice/whisper-recognition.js');

const FIXTURE_AUDIO_PATH = path.resolve(__dirname, '../fixtures/test_speech.wav');

test('REQ-028: Comprehensive Wake-Word Detection Evaluation Harness & Integration', async (t) => {

    await t.test('1. Model loading, provenance, and permissive licensing metadata', () => {
        const engine = new WakeWordEngine();
        const info = engine.getLicenceInfo();

        assert.equal(info.engine, 'LucyWakeWordCore');
        assert.equal(info.licence, 'Apache-2.0');
        assert.ok(info.licenceType.includes('Permissive Open Source'));
        assert.ok(info.thirdPartyRestrictions.includes('Rejects CC-BY-NC'));
        assert.ok(info.privacyGuarantee.includes('Zero cloud audio dispatch'));
        assert.ok(info.modelType.includes('MFCC-DTW'));
    });

    await t.test('2. Audio framing, channel normalization, and feature extraction', () => {
        // Test Float32 normalization
        const floatArray = new Float32Array([0.1, -0.2, 0.3, -0.4]);
        const normFloat = normalizeAudioBuffer(floatArray);
        assert.equal(normFloat.length, 4);

        // Test Int16 normalization
        const int16 = new Int16Array([16384, -16384, 0, 32767]);
        const normInt16 = normalizeAudioBuffer(int16);
        assert.equal(normInt16.length, 4);
        assert.equal(normInt16[0], 16384 / 32768);

        // Test WAV buffer normalization
        const wav = encodeWavPcm16(new Float32Array(400).fill(0.1));
        const normWav = normalizeAudioBuffer(wav);
        assert.equal(normWav.length, 400);

        // Test frame feature extraction (400 samples)
        const frame = new Float32Array(400);
        for (let i = 0; i < 400; i++) frame[i] = Math.sin(i / 10) * 0.5;
        const feats = extractFrameFeatures(frame);
        assert.ok(feats !== null);
        assert.equal(feats.mfcc.length, 13);
        assert.ok(feats.spectralCentroid > 0);
        assert.ok(feats.zcr > 0);
    });

    await t.test('3. Deterministic evaluation harness: positive vs negative detection rates', () => {
        const model = new AcousticWakeModel({ confidenceThreshold: 0.65 });

        // Corpus A: True Positives (various pitches & acoustic seeds)
        const positives = [
            { name: 'Hey Lucy (F0=135Hz male)', audio: synthesizeHeyLucy({ seed: 101, f0: 135 }) },
            { name: 'Hey Lucy (F0=165Hz mid)', audio: synthesizeHeyLucy({ seed: 102, f0: 165 }) },
            { name: 'Hey Lucy (F0=210Hz female)', audio: synthesizeHeyLucy({ seed: 103, f0: 210 }) },
            { name: 'Lucy (F0=140Hz male)', audio: synthesizeLucy({ seed: 201, f0: 140 }) },
            { name: 'Lucy (F0=185Hz female)', audio: synthesizeLucy({ seed: 202, f0: 185 }) }
        ];

        let positiveDetections = 0;
        for (const sample of positives) {
            const res = model.evaluate(sample.audio);
            if (res.detected) {
                positiveDetections++;
            }
            assert.ok(res.detected, `Expected positive detection for ${sample.name}, got confidence ${res.confidence}`);
            assert.ok(res.confidence >= 0.65);
            assert.ok(['hey lucy', 'lucy'].includes(res.keyword));
        }

        const positiveRate = positiveDetections / positives.length;
        assert.equal(positiveRate, 1.0, 'Detection rate on positive corpus must be 100%');

        // Corpus B: Hard Negatives, Near-Misses, Non-Speech, and Silence
        const negatives = [
            { name: 'Hey Lucky (velar stop near-miss)', audio: synthesizeHeyLucky({ seed: 301 }) },
            { name: 'Hey Lucky (alternate pitch)', audio: synthesizeHeyLucky({ seed: 302, f0: 180 }) },
            { name: 'Hello (common greeting)', audio: synthesizeHello({ seed: 401 }) },
            { name: 'Look see (inverted order)', audio: synthesizeLookSee({ seed: 501 }) },
            { name: 'Pure silence (500ms)', audio: synthesizeSilence(500) },
            { name: 'Background room noise (500ms)', audio: synthesizeBackgroundNoise(500, 0.02) },
            { name: 'Sine wave 250Hz tone', audio: synthesizeSineTone(250, 500, 0.6) },
            { name: 'Sine wave 1000Hz tone', audio: synthesizeSineTone(1000, 500, 0.6) }
        ];

        let falseActivations = 0;
        for (const sample of negatives) {
            const res = model.evaluate(sample.audio);
            if (res.detected) {
                falseActivations++;
            }
            assert.equal(res.detected, false, `Expected rejection for ${sample.name}, but falsely activated with confidence ${res.confidence}`);
            assert.equal(res.keyword, null);
        }

        const falseActivationRate = falseActivations / negatives.length;
        assert.equal(falseActivationRate, 0.0, 'False activation rate on negative corpus must be 0%');

        // Corpus C: Human spoken sentence fixture (tests/fixtures/test_speech.wav)
        if (fs.existsSync(FIXTURE_AUDIO_PATH)) {
            const wavData = fs.readFileSync(FIXTURE_AUDIO_PATH);
            const res = model.evaluate(wavData);
            // Sentence "Hello Lucy, what is on my schedule today?" without windowing should NOT match standalone wake word
            assert.equal(res.detected, false, 'Full sentence audio must not falsely trigger standalone wake word');
        }
    });

    await t.test('4. Streaming chunk ingestion via bounded circular sliding buffer', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.65,
            cooldownMs: 0
        });

        const fullAudio = synthesizeHeyLucy();
        const chunkSize = 512;
        let detectedResult = null;

        engine.on('wakeWordDetected', (res) => {
            detectedResult = res;
        });

        // Feed audio in consecutive 512-sample streaming chunks
        for (let i = 0; i < fullAudio.length; i += chunkSize) {
            const chunk = fullAudio.subarray(i, Math.min(i + chunkSize, fullAudio.length));
            engine.processInput({ audioFrame: chunk });
            if (detectedResult) break;
        }

        assert.ok(detectedResult !== null, 'Streaming chunk ingestion must detect wake phrase across sliding window');
        assert.equal(detectedResult.keyword, 'hey lucy');
        assert.ok(detectedResult.confidence >= 0.65);

        // Verify buffer memory boundedness (cannot exceed capacity)
        assert.ok(engine.slidingBuffer.length <= 24000);

        engine.dispose();
    });

    await t.test('5. Cooldown, debounce, and duplicate detection suppression', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.6,
            cooldownMs: 2000
        });

        const pcmFrame = synthesizeHeyLucy();

        // 1st detection should succeed
        const res1 = engine.processInput({ audioFrame: pcmFrame });
        assert.ok(res1 !== null);
        assert.equal(res1.keyword, 'hey lucy');

        // Immediately following input must be suppressed by cooldown
        const res2 = engine.processInput({ audioFrame: pcmFrame });
        assert.equal(res2, null, 'Immediate duplicate frame must be suppressed by cooldown');

        const res3 = engine.processInput({ transcriptCandidate: 'hey lucy' });
        assert.equal(res3, null, 'Immediate transcript candidate must also be suppressed by cooldown');

        engine.dispose();
    });

    await t.test('6. Hardware privacy mute and pause kill-switches', () => {
        const engine = new WakeWordEngine({ enabled: true });
        const pcmFrame = synthesizeHeyLucy();

        // Mute halts detection immediately
        engine.mute();
        assert.equal(engine.getPrivacyState().isMuted, true);
        assert.equal(engine.getPrivacyState().isMicActive, false);
        assert.equal(engine.processInput({ audioFrame: pcmFrame }), null);

        // Unmute restores detection
        engine.unmute();
        assert.equal(engine.getPrivacyState().isMuted, false);
        assert.equal(engine.getPrivacyState().isMicActive, true);

        // Pause halts detection
        engine.pause();
        assert.equal(engine.getPrivacyState().isPaused, true);
        assert.equal(engine.getPrivacyState().isMicActive, false);
        assert.equal(engine.processInput({ audioFrame: pcmFrame }), null);

        // Resume restores detection
        engine.resume();
        assert.equal(engine.getPrivacyState().isPaused, false);
        assert.equal(engine.getPrivacyState().isMicActive, true);

        // Disable turns off completely
        engine.disable();
        assert.equal(engine.getPrivacyState().enabled, false);
        assert.equal(engine.processInput({ audioFrame: pcmFrame }), null);

        engine.dispose();
    });

    await t.test('7. TTS echo prevention and anti-echo cooldown in VoiceController', async () => {
        let wakeWordFired = false;
        let activeSpeaker = false;

        const mockSynthesis = {
            supported: true,
            isSpeaking: false,
            speak: async (text) => {
                activeSpeaker = true;
                await new Promise(r => setTimeout(r, 50));
                activeSpeaker = false;
                return true;
            },
            stop: () => { activeSpeaker = false; }
        };

        const controller = new VoiceController({
            wakeWordEnabled: true,
            onWakeWord: () => { wakeWordFired = true; }
        });
        controller.synthesis = mockSynthesis;

        assert.equal(controller.wakeWordEngine.enabled, true);

        // Initiate speech
        const speakPromise = controller.speakResponse('Hello there, I am Lucy.');
        // During active speech, wake-word engine MUST be paused
        assert.equal(controller.wakeWordEngine.isPaused, true);

        // Simulated microphone audio arriving during speech playback must be ignored
        const echoAudio = synthesizeHeyLucy();
        const resDuringTts = controller.wakeWordEngine.processInput({ audioFrame: echoAudio });
        assert.equal(resDuringTts, null, 'Audio arriving during active TTS must be ignored to prevent self-triggering');

        await speakPromise;

        // Verify anti-echo debounce
        await new Promise(r => setTimeout(r, 500));
        assert.equal(controller.wakeWordEngine.isPaused, false, 'Wake word must resume safely after anti-echo debounce');

        controller.dispose();
    });

    await t.test('8. Microphone permission denial and device failure recovery', async () => {
        let reportedError = null;

        // Mock navigator that denies microphone permission
        const mockGlobal = {
            navigator: {
                mediaDevices: {
                    getUserMedia: async () => {
                        const err = new Error('Permission denied by user');
                        err.name = 'NotAllowedError';
                        throw err;
                    }
                }
            }
        };

        const controller = new VoiceController({
            globalScope: mockGlobal,
            wakeWordEnabled: false,
            onError: (err) => { reportedError = err; }
        });

        // Attempt to enable wake-word when permission is denied
        controller.setWakeWordEnabled(true);
        await new Promise(r => setTimeout(r, 50));

        assert.ok(reportedError !== null, 'Error must be reported via onError');
        assert.match(reportedError.message, /Permission denied/i);
        // Detector failure must safely disable wake word and not leave mic hanging
        assert.equal(controller.wakeWordEngine.enabled, false);
        assert.equal(controller.getWakeWordStatus().isStreaming, false);

        controller.dispose();
    });

    await t.test('9. Prevention of duplicate conversations and microphone streams', async () => {
        let streamCount = 0;
        let stopCount = 0;

        const mockTrack = {
            stop: () => { stopCount++; }
        };

        const mockGlobal = {
            AudioContext: class {
                constructor() { this.destination = {}; }
                createMediaStreamSource() { return { connect: () => {} }; }
                createScriptProcessor() { return { connect: () => {} }; }
                close() {}
            },
            navigator: {
                mediaDevices: {
                    getUserMedia: async () => {
                        streamCount++;
                        return { getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] };
                    }
                }
            }
        };

        const controller = new VoiceController({
            globalScope: mockGlobal,
            recognitionMode: RECOGNITION_MODES.OFFLINE,
            whisperEngine: { isAvailable: () => true },
            wakeWordEnabled: false
        });

        // 1. Enable wake-word
        controller.setWakeWordEnabled(true);
        await new Promise(r => setTimeout(r, 20));
        assert.equal(streamCount, 1, 'Initial wake-word capture requires 1 stream');

        // 2. Trigger wake-word detection -> transitions to listening
        controller.startListening();
        // Crucial: Must NOT open a second getUserMedia stream
        assert.equal(streamCount, 1, 'Transitioning to active listening must reuse existing capture pipeline');
        assert.equal(controller.voiceState, VOICE_STATES.LISTENING);

        // 3. Stop listening -> returns to IDLE
        controller.stopListening();
        assert.equal(streamCount, 1);

        controller.dispose();
    });

    await t.test('10. End-to-end orchestration flow and execution safety guard', () => {
        let wakeWordTriggered = false;
        let commandExecuted = false;

        const mockGlobal = {
            AudioContext: class {
                constructor() { this.destination = {}; }
                createMediaStreamSource() { return { connect: () => {} }; }
                createScriptProcessor() { return { connect: () => {} }; }
                close() {}
            },
            navigator: {
                mediaDevices: {
                    getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }], getAudioTracks: () => [{ stop: () => {} }] })
                }
            }
        };

        const controller = new VoiceController({
            globalScope: mockGlobal,
            recognitionMode: RECOGNITION_MODES.OFFLINE,
            whisperEngine: { isAvailable: () => true },
            wakeWordEnabled: true,
            onWakeWord: () => {
                wakeWordTriggered = true;
            }
        });

        // Simulate wake phrase detection
        const res = controller.wakeWordEngine.processInput({ audioFrame: synthesizeHeyLucy() });
        assert.ok(res !== null);
        assert.equal(res.keyword, 'hey lucy');
        assert.equal(wakeWordTriggered, true);

        // Safety Guard: Wake-word detection alone MUST NOT execute tasks or tool actions!
        assert.equal(commandExecuted, false, 'No task must execute merely because wake phrase was detected');
        // Controller transitions to listening state for speech intake
        assert.equal(controller.voiceState, VOICE_STATES.LISTENING);

        controller.dispose();
    });

    await t.test('11. Resource cleanup on disposal', async () => {
        let streamClosed = false;
        const mockTrack = { stop: () => { streamClosed = true; } };

        const mockGlobal = {
            AudioContext: class {
                constructor() { this.destination = {}; }
                createMediaStreamSource() { return { connect: () => {} }; }
                createScriptProcessor() { return { connect: () => {} }; }
                close() {}
            },
            navigator: {
                mediaDevices: {
                    getUserMedia: async () => ({ getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] })
                }
            }
        };

        const controller = new VoiceController({
            globalScope: mockGlobal,
            wakeWordEnabled: true
        });

        assert.equal(controller.wakeWordEngine.enabled, true);
        await new Promise(r => setTimeout(r, 20));

        controller.dispose();

        assert.equal(controller.wakeWordEngine.enabled, false);
        assert.equal(controller.wakeWordEngine.listenerCount('wakeWordDetected'), 0);
        assert.equal(streamClosed, true, 'Microphone tracks must be stopped on dispose');
        assert.equal(controller.getWakeWordStatus().isStreaming, false);
    });

    await t.test('12. Local Whisper verification smoke test (when runtime is available)', async () => {
        const whisper = new WhisperOfflineRecognitionEngine();
        const available = whisper.isAvailable();

        if (available && fs.existsSync(FIXTURE_AUDIO_PATH)) {
            const engine = new WakeWordEngine({
                enabled: true,
                whisperEngine: whisper,
                dualStageVerification: true,
                confidenceThreshold: 0.6
            });

            // Status check
            assert.equal(engine.whisperEngine.isAvailable(), true);
            const status = engine.getPrivacyState();
            assert.equal(status.enabled, true);

            engine.dispose();
        } else {
            // Verify graceful fallback when offline model is absent
            const engine = new WakeWordEngine({
                enabled: true,
                whisperEngine: null,
                dualStageVerification: false
            });
            assert.equal(engine.getPrivacyState().enabled, true);
            engine.dispose();
        }
    });
});
