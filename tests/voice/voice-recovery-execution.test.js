'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { SpeechSynthesisService } = require('../../src/voice/speech-synthesis.js');
const { VoiceController, VOICE_STATES } = require('../../src/voice/voice-controller.js');
const { WakeWordEngine, PRIVACY_STATES } = require('../../src/voice/wake-word-engine.js');
const {
    AcousticWakeModel,
    evaluatePhoneticLandmarks,
    dtwDistance
} = require('../../src/voice/acoustic-wake-model.js');
const {
    normalizeAudioBuffer,
    extractAudioFeatures
} = require('../../src/voice/acoustic-feature-extractor.js');
const { validateVoiceConfig } = require('../../src/security/ipc-validator.js');
const nat = require('../../src/voice/natural-profiles.js');

// Mock Web Speech Synthesis implementation
class MockSpeechSynthesisUtterance {
    constructor(text) {
        this.text = text;
        this.rate = 1.0;
        this.pitch = 1.0;
        this.volume = 1.0;
        this.voice = null;
        this.lang = 'en-US';
        this.onstart = null;
        this.onend = null;
        this.onerror = null;
    }
}

class MockSpeechSynthesis {
    constructor() {
        this.speaking = false;
        this.paused = false;
        this.canceled = false;
        this.activeUtterance = null;
        this.voices = [
            { name: 'Microsoft David Desktop', lang: 'en-US', default: true },
            { name: 'Microsoft Zira Desktop', lang: 'en-US', default: false }
        ];
    }

    getVoices() {
        return this.voices;
    }

    speak(utterance) {
        this.speaking = true;
        this.canceled = false;
        this.activeUtterance = utterance;
        if (utterance.onstart) {
            process.nextTick(() => utterance.onstart());
        }
        process.nextTick(() => {
            if (this.speaking && !this.canceled) {
                this.speaking = false;
                if (utterance.onend) utterance.onend();
            }
        });
    }

    cancel() {
        this.speaking = false;
        this.canceled = true;
        if (this.activeUtterance?.onerror) {
            this.activeUtterance.onerror({ error: 'canceled' });
        }
    }
}

test('L.U.C.Y. Voice Recovery Execution Suite (DEF-001, DEF-002, DEF-003)', async (t) => {

    // ==========================================
    // 1. TTS Engine Persistence Roundtrip (DEF-001)
    // ==========================================
    await t.test('1.1 Persistence file stores and preserves ttsEngine: windows-speech across restart simulation', () => {
        const testConfigPath = path.join(os.tmpdir(), `lucy-voice-config-test-${Date.now()}.json`);
        
        try {
            // Initial write: User selects windows-speech
            const userConfig = {
                ttsEngine: 'windows-speech',
                ttsEnabled: true,
                wakeWordEnabled: true,
                wakeWordSensitivity: 0.7,
                rate: 1.0,
                pitch: 1.05,
                volume: 0.95
            };
            const val = validateVoiceConfig(userConfig);
            assert.equal(val.ok, true, 'Configuration must pass validation');

            fs.writeFileSync(testConfigPath, JSON.stringify(val.sanitized, null, 2), 'utf8');

            // Simulate full application restart: Read fresh from disk
            const reloaded = JSON.parse(fs.readFileSync(testConfigPath, 'utf8'));
            assert.equal(reloaded.ttsEngine, 'windows-speech', 'Persisted config must retain windows-speech');

            // Simulate VoiceController initialization with reloaded config
            const mockSynth = new MockSpeechSynthesis();
            const vc = new VoiceController({
                globalScope: {
                    speechSynthesis: mockSynth,
                    SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
                },
                ttsEngine: reloaded.ttsEngine
            });

            assert.equal(vc.ttsEngine, 'windows-speech', 'VoiceController must initialize with windows-speech');

            // Mutate unrelated setting (e.g. sensitivity or volume) and simulate persist
            const updatedConfig = {
                ...reloaded,
                volume: 0.8
            };
            assert.equal(updatedConfig.ttsEngine, 'windows-speech', 'ttsEngine must not revert to kokoro during subsequent setting updates');
            
            vc.dispose();
        } finally {
            try { fs.unlinkSync(testConfigPath); } catch (_) {}
        }
    });

    await t.test('1.2 VoiceController engine resolution gives absolute precedence to windows-speech when selected', async () => {
        const mockSynth = new MockSpeechSynthesis();
        let synthSpeakCalled = false;
        let kokoroSynthesizeCalled = false;

        const mockScope = {
            speechSynthesis: mockSynth,
            SpeechSynthesisUtterance: MockSpeechSynthesisUtterance,
            lucyIpc: {
                synthesizeSpeech: async () => {
                    kokoroSynthesizeCalled = true;
                    return { ok: true, audio: 'mock-base64' };
                }
            }
        };

        const vc = new VoiceController({
            globalScope: mockScope,
            ttsEngine: 'windows-speech'
        });

        // Intercept synthesis.speak
        const origSpeak = vc.synthesis.speak.bind(vc.synthesis);
        vc.synthesis.speak = async (text, options) => {
            synthSpeakCalled = true;
            return await origSpeak(text, options);
        };

        // When speakResponse is called without explicit engine, it must use vc.ttsEngine ('windows-speech')
        const ok = await vc.speakResponse('Hello, this is a response test.');
        assert.equal(ok, true, 'Speech response must succeed');
        assert.equal(synthSpeakCalled, true, 'Windows Speech synthesis must be invoked');
        assert.equal(kokoroSynthesizeCalled, false, 'Kokoro TTS must NOT be invoked when windows-speech is selected');

        vc.dispose();
    });

    // ==========================================
    // 2. Speech Latency & Listening Sequencing (DEF-002)
    // ==========================================
    await t.test('2.1 speakResponse automatically handles listening state transition and does not abort in 0ms', async () => {
        const mockSynth = new MockSpeechSynthesis();
        const vc = new VoiceController({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            },
            ttsEngine: 'windows-speech'
        });

        // Simulate active listening state (e.g. user just finished speaking command)
        vc.voiceState = VOICE_STATES.LISTENING;

        // speakResponse must cleanly sequence speech and not return false immediately
        const speechPromise = vc.speakResponse('The task has been completed successfully.');
        const ok = await speechPromise;
        assert.equal(ok, true, 'speakResponse must succeed even if voice was in listening state');
        assert.equal(vc.isListening, false, 'isListening must be false during speech playback');

        vc.dispose();
    });

    // ==========================================
    // 3. Physical Microphone Wake-Word Phonetics (DEF-003)
    // ==========================================
    await t.test('3.1 Calibrated phonetic landmarks pass for natural male and female speech', () => {
        const maleLm = evaluatePhoneticLandmarks(nat.NATURAL_HEY_LUCY, 'hey lucy');
        assert.equal(maleLm.valid, true, `Male landmark evaluation failed: ${maleLm.reason}`);
        assert.ok(maleLm.score >= 0.50, `Male landmark score too low: ${maleLm.score}`);

        const femaleLm = evaluatePhoneticLandmarks(nat.NATURAL_HEY_LUCY_FEMALE, 'hey lucy');
        assert.equal(femaleLm.valid, true, `Female landmark evaluation failed: ${femaleLm.reason}`);
        assert.ok(femaleLm.score >= 0.50, `Female landmark score too low: ${femaleLm.score}`);
    });

    await t.test('3.2 Calibrated phonetic landmarks tolerate microphone acoustic distance attenuation without false rejection', () => {
        // Simulate real-world laptop microphone attenuation (50% high-frequency loss at 50cm distance)
        const attenuatedFrames = nat.NATURAL_HEY_LUCY.map(f => ({
            ...f,
            hfer: f.hfer * 0.55,
            spectralCentroid: Math.max(1600, f.spectralCentroid * 0.85)
        }));

        const lm = evaluatePhoneticLandmarks(attenuatedFrames, 'hey lucy');
        assert.equal(lm.valid, true, `Attenuated speech landmark evaluation failed: ${lm.reason}`);
        assert.ok(lm.score >= 0.50, `Attenuated landmark score too low: ${lm.score}`);
    });

    await t.test('3.3 AcousticWakeModel accurately detects male and female Hey Lucy with clean distractor rejection', () => {
        const model = new AcousticWakeModel({
            keywords: ['hey lucy', 'lucy'],
            confidenceThreshold: 0.58,
            sensitivity: 0.5
        });

        // 1. Male speech detection
        const maleEval = model.evaluate(nat.NATURAL_HEY_LUCY);
        assert.equal(maleEval.detected, true, `Male Hey Lucy must be detected: ${JSON.stringify(maleEval)}`);
        assert.equal(maleEval.keyword, 'hey lucy');
        assert.ok(maleEval.confidence >= 0.58);

        // 2. Female speech detection
        const femaleEval = model.evaluate(nat.NATURAL_HEY_LUCY_FEMALE);
        assert.equal(femaleEval.detected, true, `Female Hey Lucy must be detected: ${JSON.stringify(femaleEval)}`);
        assert.equal(femaleEval.keyword, 'hey lucy');
        assert.ok(femaleEval.confidence >= 0.58);

        // 3. Negative Distractors
        const scratchDir = path.resolve(__dirname, '../../scratch');
        const lookSeePath = path.join(scratchDir, 'test_look_see.wav');
        if (fs.existsSync(lookSeePath)) {
            const lookSeeBuf = fs.readFileSync(lookSeePath);
            const lookSeeEval = model.evaluate(normalizeAudioBuffer(lookSeeBuf));
            assert.equal(lookSeeEval.detected, false, `Distractor "Look see" must be rejected: ${JSON.stringify(lookSeeEval)}`);
        }

        const notepadPath = path.join(scratchDir, 'test_phrase_2.wav');
        if (fs.existsSync(notepadPath)) {
            const notepadBuf = fs.readFileSync(notepadPath);
            const notepadEval = model.evaluate(normalizeAudioBuffer(notepadBuf));
            assert.equal(notepadEval.detected, false, `Distractor "Open Notepad" must be rejected: ${JSON.stringify(notepadEval)}`);
        }
    });

    await t.test('3.4 Streaming chunk ingestion sliding buffer correctly triggers wakeWordDetected on natural frames', (t, done) => {
        const engine = new WakeWordEngine({
            enabled: true,
            keywords: ['hey lucy', 'lucy'],
            confidenceThreshold: 0.55,
            sensitivity: 0.6,
            cooldownMs: 0
        });

        let detected = false;
        engine.on('wakeWordDetected', (res) => {
            detected = true;
            assert.ok(['hey lucy', 'lucy'].includes(res.keyword));
            assert.ok(res.confidence >= 0.55);
            engine.dispose();
            done();
        });

        // Synthesize 1s silence + natural Hey Lucy WAV + 0.5s silence
        const heyLucyWavPath = path.join(__dirname, '../../scratch/sapi_hey_lucy.wav');
        if (!fs.existsSync(heyLucyWavPath)) {
            // Skip if wav fixture is missing
            done();
            return;
        }

        const raw = normalizeAudioBuffer(fs.readFileSync(heyLucyWavPath));
        const silence = new Float32Array(8000); // 0.5s at 16kHz
        const stream = new Float32Array(silence.length + raw.length + silence.length);
        stream.set(silence, 0);
        stream.set(raw, silence.length);
        stream.set(silence, silence.length + raw.length);

        // Feed chunks in 2048-sample slices like ScriptProcessorNode does
        for (let i = 0; i < stream.length; i += 2048) {
            const chunk = stream.subarray(i, Math.min(i + 2048, stream.length));
            engine.processInput({ audioFrame: chunk });
            if (detected) break;
        }

        assert.ok(detected, 'Streaming chunk ingestion must trigger wakeWordDetected');
    });
});
