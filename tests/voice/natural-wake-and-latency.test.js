'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
    AcousticWakeModel,
    evaluatePhoneticLandmarks,
    dtwDistance,
    REF_HEY_LUCY
} = require('../../src/voice/acoustic-wake-model.js');

const {
    normalizeAudioBuffer,
    extractAudioFeatures
} = require('../../src/voice/acoustic-feature-extractor.js');

const { WakeWordEngine } = require('../../src/voice/wake-word-engine.js');
const { WhisperOfflineRecognitionEngine } = require('../../src/voice/whisper-recognition.js');

describe('L.U.C.Y. Natural Voice Wake-Word & Voice Latency Regression Suite', () => {
    const fixtureDir = path.resolve(__dirname, '../../scratch');
    const heyLucyWav = path.join(fixtureDir, 'sapi_hey_lucy.wav');
    const ziraLucyWav = path.join(fixtureDir, 'zira_hey_lucy.wav');
    const lookSeeWav = path.join(fixtureDir, 'test_look_see.wav');
    const notepadWav = path.join(fixtureDir, 'test_phrase_2.wav');

    before(() => {
        // Ensure scratch fixtures exist using Windows SAPI
        if (!fs.existsSync(heyLucyWav)) {
            execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${heyLucyWav.replace(/\\/g, '/')}'); $s.Speak('Hey Lucy'); $s.Dispose()"`);
        }
        if (!fs.existsSync(ziraLucyWav)) {
            execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('Microsoft Zira Desktop') } catch {}; $s.SetOutputToWaveFile('${ziraLucyWav.replace(/\\/g, '/')}'); $s.Speak('Hey Lucy'); $s.Dispose()"`);
        }
        if (!fs.existsSync(lookSeeWav)) {
            execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${lookSeeWav.replace(/\\/g, '/')}'); $s.Speak('Look see'); $s.Dispose()"`);
        }
        if (!fs.existsSync(notepadWav)) {
            execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${notepadWav.replace(/\\/g, '/')}'); $s.Speak('Open Notepad'); $s.Dispose()"`);
        }
    });

    test('1. SAPI Natural "Hey Lucy" must NOT be rejected by silent frame landmark false-positives', () => {
        const buf = fs.readFileSync(heyLucyWav);
        const samples = normalizeAudioBuffer(buf);
        const frames = extractAudioFeatures(samples);

        const lm = evaluatePhoneticLandmarks(frames, 'hey lucy');
        assert.strictEqual(lm.valid, true, `Landmark evaluation failed: ${lm.reason}`);
        assert.ok(lm.score >= 0.5, `Landmark score too low: ${lm.score}`);
    });

    test('2. SAPI Distractor "Open Notepad" must be rejected by phonetic landmark validation', () => {
        const buf = fs.readFileSync(notepadWav);
        const samples = normalizeAudioBuffer(buf);
        const frames = extractAudioFeatures(samples);

        const lm = evaluatePhoneticLandmarks(frames, 'hey lucy');
        assert.strictEqual(lm.valid, false, 'Open Notepad should fail phonetic landmark validation for hey lucy');
    });

    test('3. AcousticWakeModel.evaluate correctly detects natural "Hey Lucy"', () => {
        const buf = fs.readFileSync(heyLucyWav);
        const samples = normalizeAudioBuffer(buf);

        const model = new AcousticWakeModel({
            keywords: ['hey lucy', 'lucy'],
            confidenceThreshold: 0.50,
            sensitivity: 0.6
        });
        const res = model.evaluate(samples);
        assert.strictEqual(res.detected, true, `Model failed to detect Hey Lucy: ${JSON.stringify(res)}`);
        assert.strictEqual(res.keyword, 'hey lucy');
        assert.ok(res.confidence >= 0.50, `Confidence too low: ${res.confidence}`);
    });

    test('4. Streaming chunk ingestion into WakeWordEngine triggers wake-word event on natural speech', (t, done) => {
        const buf = fs.readFileSync(heyLucyWav);
        const samples = normalizeAudioBuffer(buf);

        const engine = new WakeWordEngine({
            enabled: true,
            keywords: ['hey lucy', 'lucy'],
            confidenceThreshold: 0.50,
            sensitivity: 0.6
        });

        let triggered = false;
        engine.on('wakeWordDetected', (res) => {
            triggered = true;
            assert.strictEqual(res.keyword, 'hey lucy');
            assert.ok(res.confidence >= 0.50);
            done();
        });

        // Feed chunks of 2048 samples as ScriptProcessorNode does
        const chunkSize = 2048;
        for (let offset = 0; offset < samples.length; offset += chunkSize) {
            const chunk = samples.subarray(offset, Math.min(samples.length, offset + chunkSize));
            engine.processInput({ audioFrame: chunk });
            if (triggered) break;
        }

        if (!triggered) {
            done(new Error('WakeWordEngine did not trigger on natural streaming chunks'));
        }
    });

    test('5. Dual-stage Whisper verification accurately transcribes and confirms "Hey Lucy"', async () => {
        const whisper = new WhisperOfflineRecognitionEngine();
        assert.strictEqual(whisper.isAvailable(), true, 'Whisper offline binary and model must be available');

        const buf = fs.readFileSync(heyLucyWav);
        const res = await whisper.transcribeAudio(buf);
        assert.strictEqual(res.ok, true, `Whisper transcription failed: ${res.error}`);
        const lower = (res.transcript || '').toLowerCase();
        assert.ok(lower.includes('hey lucy'), `Transcript did not contain 'hey lucy': "${res.transcript}"`);
    });

    test('6. KokoroTtsService idle unload timeout is calibrated to 120s to prevent thrashing', () => {
        const { KokoroTtsService } = require('../../src/voice/kokoro-tts-service.js');
        const svc = new KokoroTtsService();
        assert.strictEqual(svc.idleUnloadTimeoutMs, 120000, 'idleUnloadTimeoutMs must be 120,000ms');
    });

    test('7. VoiceController executes sentence pipelining for low-latency playback', async () => {
        const { VoiceController } = require('../../src/voice/voice-controller.js');

        class MockAudio {
            constructor(src) {
                this.src = src;
                this.volume = 1.0;
                MockAudio.instances.push(this);
            }
            play() {
                setTimeout(() => {
                    if (typeof this.onplay === 'function') this.onplay();
                    setTimeout(() => {
                        if (typeof this.onended === 'function') this.onended();
                    }, 20);
                }, 5);
                return Promise.resolve();
            }
        }
        MockAudio.instances = [];

        const synthesizedChunks = [];
        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudio,
                lucyIpc: {
                    synthesizeSpeech: async (text, opts) => {
                        synthesizedChunks.push(text);
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        const multiSentenceText = 'I have analyzed the request. All system services are running optimally.';
        let onStartFired = false;
        let latencyRecorded = null;

        const success = await controller.speak(multiSentenceText, {
            voice: 'af_bella',
            onStart: () => {
                onStartFired = true;
                latencyRecorded = controller.lastTtsStartupLatencyMs;
            }
        });

        assert.strictEqual(success, true);
        assert.strictEqual(onStartFired, true);
        assert.strictEqual(synthesizedChunks.length, 2, 'Must synthesize exactly 2 sentences sequentially');
        assert.strictEqual(synthesizedChunks[0], 'I have analyzed the request.');
        assert.strictEqual(synthesizedChunks[1], 'All system services are running optimally.');
        assert.strictEqual(typeof latencyRecorded, 'number');
        assert.ok(latencyRecorded >= 0);
    });

    test('8. AcousticWakeModel correctly detects female SAPI (Zira) "Hey Lucy"', () => {
        const buf = fs.readFileSync(ziraLucyWav);
        const samples = normalizeAudioBuffer(buf);

        const model = new AcousticWakeModel({
            keywords: ['hey lucy', 'lucy'],
            confidenceThreshold: 0.65,
            sensitivity: 0.5
        });
        const res = model.evaluate(samples);
        assert.strictEqual(res.detected, true, `Model failed to detect female Hey Lucy: ${JSON.stringify(res)}`);
        assert.strictEqual(res.keyword, 'hey lucy');
        assert.ok(res.confidence >= 0.80, `Female Hey Lucy confidence should be >= 0.80, got ${res.confidence}`);
    });

    test('9. AcousticWakeModel rejects negative distractor "Look see"', () => {
        const buf = fs.readFileSync(lookSeeWav);
        const samples = normalizeAudioBuffer(buf);

        const model = new AcousticWakeModel({
            keywords: ['hey lucy', 'lucy'],
            confidenceThreshold: 0.65,
            sensitivity: 0.5
        });
        const res = model.evaluate(samples);
        assert.strictEqual(res.detected, false, `Distractor "Look see" should NOT be detected: ${JSON.stringify(res)}`);
        assert.ok(res.confidence < 0.65, `Distractor confidence should be below threshold 0.65, got ${res.confidence}`);
    });

    test('10. VoiceController respects ttsEngine: windows-speech without overriding to Kokoro', async () => {
        const { VoiceController } = require('../../src/voice/voice-controller.js');

        let sapiSpoken = false;
        let kokoroInvoked = false;

        const controller = new VoiceController({
            ttsEngine: 'windows-speech',
            kokoroVoice: 'af_bella',
            globalScope: {
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        kokoroInvoked = true;
                        return { ok: true, audio: 'mock' };
                    }
                }
            }
        });

        // Mock synthesis backend
        controller.synthesis = {
            supported: true,
            enabled: true,
            speak: async (text, opts) => {
                sapiSpoken = true;
                if (typeof opts.onStart === 'function') opts.onStart();
                return true;
            }
        };

        const res = await controller.speak('Test SAPI precedence', {
            ttsEngine: 'windows-speech',
            force: true
        });

        assert.strictEqual(res, true);
        assert.strictEqual(sapiSpoken, true, 'Windows Speech synthesizer must be called');
        assert.strictEqual(kokoroInvoked, false, 'Kokoro IPC must NOT be invoked when windows-speech is selected');
    });
});
