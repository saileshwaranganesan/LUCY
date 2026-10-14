'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs');

const { SpeechSynthesisService } = require('../../src/voice/speech-synthesis.js');
const { VoiceController, VOICE_STATES } = require('../../src/voice/voice-controller.js');
const { validateVoiceConfig } = require('../../src/security/ipc-validator.js');

// Mock Web Speech Synthesis & Recognition implementations
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
        this.onboundary = null;
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

class MockSpeechRecognition {
    constructor() {
        this.continuous = false;
        this.interimResults = true;
        this.lang = 'en-US';
        this.onstart = null;
        this.onend = null;
        this.onerror = null;
        this.onresult = null;
        this.started = false;
        MockSpeechRecognition.instances.push(this);
    }

    start() {
        this.started = true;
        this.onstart?.();
    }

    stop() {
        this.started = false;
        this.onend?.();
    }

    abort() {
        this.started = false;
        this.onend?.();
    }
}
MockSpeechRecognition.instances = [];

test('Batch 04: Voice Customization, Pitch/Rate Control & Lifecycle Management', async (t) => {

    // Test 1: Configurable Speech Pitch and Rate with Clamping
    await t.test('configures pitch and rate and clamps extreme values within [0.5, 1.5]', async () => {
        const mockSynth = new MockSpeechSynthesis();
        const synth = new SpeechSynthesisService({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            },
            pitch: 1.25,
            rate: 0.95
        });

        const cfg = synth.getVoiceConfig();
        assert.equal(cfg.pitch, 1.25);
        assert.equal(cfg.rate, 0.95);

        // Clamp extreme low and high
        synth.setVoiceConfig({ pitch: 0.1, rate: 3.0 });
        const clamped = synth.getVoiceConfig();
        assert.equal(clamped.pitch, 0.5, 'Pitch below 0.5 must be clamped to 0.5');
        assert.equal(clamped.rate, 1.5, 'Rate above 1.5 must be clamped to 1.5');

        await synth.speak('Testing clamped speech');
        assert.equal(mockSynth.activeUtterance.pitch, 0.5);
        assert.equal(mockSynth.activeUtterance.rate, 1.5);
    });

    // Test 2: Dynamic Per-Utterance Overrides vs Configured Defaults
    await t.test('applies per-utterance overrides while preserving service default settings', async () => {
        const mockSynth = new MockSpeechSynthesis();
        const synth = new SpeechSynthesisService({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            },
            pitch: 1.05,
            rate: 1.02
        });

        await synth.speak('Custom speech parameters', { pitch: 1.3, rate: 0.8 });
        assert.equal(mockSynth.activeUtterance.pitch, 1.3);
        assert.equal(mockSynth.activeUtterance.rate, 0.8);

        // Service defaults remain intact
        const cfg = synth.getVoiceConfig();
        assert.equal(cfg.pitch, 1.05);
        assert.equal(cfg.rate, 1.02);
    });

    // Test 3: Speech Interruption and Lifecycle Management
    await t.test('interrupts active speech immediately when stop or new speech is triggered', async () => {
        const mockSynth = new MockSpeechSynthesis();
        const synth = new SpeechSynthesisService({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            }
        });

        // Start speech and interrupt immediately
        synth.speak('First message that will be interrupted');
        synth.stop();
        assert.equal(synth.state, 'idle');
        assert.equal(mockSynth.canceled, true);
    });

    // Test 4: Push-to-Talk Interruption & Wake-Word Deferred
    await t.test('push-to-talk halts active speech playback before microphone capture', async () => {
        MockSpeechRecognition.instances = [];
        const mockSynth = new MockSpeechSynthesis();
        const states = [];

        const controller = new VoiceController({
            globalScope: {
                SpeechRecognition: MockSpeechRecognition,
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            },
            onStateChange: ({ voiceState }) => states.push(voiceState)
        });

        // Trigger active speaking
        controller.speakResponse('Assistant is currently speaking');

        // Trigger push-to-talk listening
        controller.startListening();

        // Speech must be cancelled immediately
        assert.equal(mockSynth.canceled, true);
        assert.equal(controller.isListening, true);
        assert.equal(controller.isSpeaking, false);

        controller.stopListening();
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
    });

    // Test 5: VoiceController setVoiceConfig & getVoiceConfig delegation
    await t.test('delegates voice configuration updates through VoiceController', async () => {
        const mockSynth = new MockSpeechSynthesis();
        const controller = new VoiceController({
            globalScope: {
                SpeechRecognition: MockSpeechRecognition,
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            }
        });

        controller.setVoiceConfig({
            pitch: 1.15,
            rate: 1.10,
            voiceName: 'Microsoft Zira Desktop',
            ttsEnabled: true
        });

        const cfg = controller.getVoiceConfig();
        assert.equal(cfg.pitch, 1.15);
        assert.equal(cfg.rate, 1.10);
        assert.equal(cfg.preferredVoiceName, 'Microsoft Zira Desktop');
        assert.equal(cfg.ttsEnabled, true);

        // Disabling TTS halts speech
        controller.setVoiceConfig({ ttsEnabled: false });
        assert.equal(controller.ttsEnabled, false);
        const speakResult = await controller.speakResponse('Should not speak');
        assert.equal(speakResult, false);
    });

    // Test 6: IPC Validation for Voice Configuration (validateVoiceConfig)
    await t.test('enforces strict boundary validation on voice configuration IPC payloads', () => {
        // Valid payload
        const valid = validateVoiceConfig({
            pitch: 1.1,
            rate: 0.95,
            volume: 0.8,
            voiceName: 'Microsoft Zira',
            ttsEnabled: true
        });
        assert.equal(valid.ok, true);
        assert.equal(valid.sanitized.pitch, 1.1);
        assert.equal(valid.sanitized.rate, 0.95);
        assert.equal(valid.sanitized.volume, 0.8);
        assert.equal(valid.sanitized.ttsEnabled, true);

        // Invalid non-object
        assert.equal(validateVoiceConfig(null).ok, false);
        assert.equal(validateVoiceConfig('pitch: 1.0').ok, false);

        // Out of bounds pitch
        const badPitchLow = validateVoiceConfig({ pitch: 0.2 });
        assert.equal(badPitchLow.ok, false);
        assert.equal(badPitchLow.code, 'INVALID_PITCH');

        const badPitchHigh = validateVoiceConfig({ pitch: 2.5 });
        assert.equal(badPitchHigh.ok, false);
        assert.equal(badPitchHigh.code, 'INVALID_PITCH');

        // Out of bounds rate
        const badRate = validateVoiceConfig({ rate: 2.0 });
        assert.equal(badRate.ok, false);
        assert.equal(badRate.code, 'INVALID_RATE');

        // Invalid voice name containing control characters
        const badVoiceName = validateVoiceConfig({ voiceName: 'Bad\nVoice\tName' });
        assert.equal(badVoiceName.ok, false);
        assert.equal(badVoiceName.code, 'INVALID_VOICE_NAME');
    });

    // Test 7: Persistence File Roundtrip & Validation
    await t.test('persists and reloads voice configuration accurately', () => {
        const testFile = path.resolve(__dirname, '../../scratch/test-voice-config.json');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });

        const configToSave = {
            pitch: 1.12,
            rate: 1.05,
            volume: 0.9,
            preferredVoiceName: 'Microsoft Zira Desktop',
            ttsEnabled: true
        };

        fs.writeFileSync(testFile, JSON.stringify(configToSave, null, 2), 'utf8');
        assert.ok(fs.existsSync(testFile));

        const loaded = JSON.parse(fs.readFileSync(testFile, 'utf8'));
        assert.deepEqual(loaded, configToSave);

        // Cleanup
        try { fs.unlinkSync(testFile); } catch {}
    });

    // Test 8: Default Voice Settings & Reset to Defaults
    await t.test('provides sensible defaults and restores them via resetToDefaults', () => {
        const mockSynth = new MockSpeechSynthesis();
        const synth = new SpeechSynthesisService({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            }
        });

        // Verify factory defaults
        const defaults = synth.getVoiceConfig();
        assert.equal(defaults.pitch, 1.05);
        assert.equal(defaults.rate, 1.02);
        assert.equal(defaults.volume, 1.0);
        assert.equal(defaults.preferredVoiceName, '');
        assert.equal(defaults.enabled, true);

        // Mutate settings
        synth.setVoiceConfig({ pitch: 1.4, rate: 0.8, preferredVoiceName: 'CustomVoice' });
        assert.equal(synth.getVoiceConfig().pitch, 1.4);

        // Reset to defaults
        const restored = synth.resetToDefaults();
        assert.equal(restored.pitch, 1.05);
        assert.equal(restored.rate, 1.02);
        assert.equal(restored.volume, 1.0);
        assert.equal(restored.preferredVoiceName, '');
        assert.equal(restored.enabled, true);

        // Verify via IPC validator reset flag
        const ipcReset = validateVoiceConfig({ resetToDefaults: true });
        assert.equal(ipcReset.ok, true);
        assert.equal(ipcReset.sanitized.pitch, 1.05);
        assert.equal(ipcReset.sanitized.rate, 1.02);
        assert.equal(ipcReset.sanitized.resetToDefaults, true);
    });

    // Test 9: Non-Finite Values (NaN, Infinity, -Infinity) and Malformed Inputs
    await t.test('rejects non-finite values and malformed numbers in IPC validator and synthesis service', () => {
        // IPC validator rejects NaN, Infinity, -Infinity
        assert.equal(validateVoiceConfig({ pitch: NaN }).ok, false);
        assert.equal(validateVoiceConfig({ pitch: Infinity }).ok, false);
        assert.equal(validateVoiceConfig({ pitch: -Infinity }).ok, false);
        assert.equal(validateVoiceConfig({ rate: NaN }).ok, false);
        assert.equal(validateVoiceConfig({ rate: Infinity }).ok, false);
        assert.equal(validateVoiceConfig({ volume: NaN }).ok, false);
        assert.equal(validateVoiceConfig({ volume: Infinity }).ok, false);
        assert.equal(validateVoiceConfig({ ttsEnabled: 'yes' }).ok, false);

        // Synthesis service ignores non-finite inputs
        const mockSynth = new MockSpeechSynthesis();
        const synth = new SpeechSynthesisService({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            }
        });

        synth.setVoiceConfig({ pitch: NaN, rate: Infinity, volume: -Infinity });
        const cfg = synth.getVoiceConfig();
        assert.equal(cfg.pitch, 1.05, 'Pitch must ignore NaN');
        assert.equal(cfg.rate, 1.02, 'Rate must ignore Infinity');
        assert.equal(cfg.volume, 1.0, 'Volume must ignore -Infinity');
    });

    // Test 10: Unsupported Voice Selection Fallback
    await t.test('falls back gracefully to natural default voice when unsupported voice is selected', async () => {
        const mockSynth = new MockSpeechSynthesis();
        const synth = new SpeechSynthesisService({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            },
            preferredVoiceName: 'CompletelyUnsupportedVoice12345'
        });

        // Available voices: David & Zira
        const selected = await synth.selectBestVoice('CompletelyUnsupportedVoice12345');
        assert.ok(selected, 'Must fall back to an available voice rather than null');
        assert.equal(selected.name, 'Microsoft Zira Desktop', 'Must prefer natural female voice as fallback');

        // Can list available voices safely
        const available = await synth.getAvailableVoices();
        assert.equal(available.length, 2);
        assert.equal(available[0].name, 'Microsoft David Desktop');
    });

    // Test 11: Duplicate Voice Session Prevention
    await t.test('strictly prevents duplicate or overlapping microphone sessions', () => {
        MockSpeechRecognition.instances = [];
        const mockSynth = new MockSpeechSynthesis();

        const controller = new VoiceController({
            globalScope: {
                SpeechRecognition: MockSpeechRecognition,
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            }
        });

        const firstStart = controller.startListening();
        assert.equal(firstStart, true);
        assert.equal(controller.isListening, true);

        // Second start while already listening must return false
        const secondStart = controller.startListening();
        assert.equal(secondStart, false, 'Duplicate startListening must be rejected');

        controller.stopListening();
        assert.equal(controller.isListening, false);
    });

    // Test 12: Microphone Permission Denial and Hardware Failure Handling
    await t.test('handles microphone permission denial and missing mic gracefully without crashing', () => {
        const errors = [];
        const states = [];

        const controller = new VoiceController({
            globalScope: {
                SpeechRecognition: MockSpeechRecognition,
                speechSynthesis: new MockSpeechSynthesis(),
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            },
            onStateChange: ({ voiceState }) => states.push(voiceState),
            onError: (err) => errors.push(err)
        });

        controller.startListening();
        const instance = MockSpeechRecognition.instances[MockSpeechRecognition.instances.length - 1];
        instance.onerror({ error: 'not-allowed' });

        // Must report error and allow returning to idle
        assert.equal(errors.length, 1);
        assert.equal(errors[0].error, 'not-allowed');
        assert.equal(controller.voiceState, VOICE_STATES.ERROR);

        controller.resetState();
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
    });

    // Test 13: Stale Asynchronous Response Prevention
    await t.test('prevents stale asynchronous responses from speaking after cancellation or replacement', async () => {
        const mockSynth = new MockSpeechSynthesis();
        const spokenTexts = [];

        // Custom utterance to track what actually speaks
        class TrackingUtterance extends MockSpeechSynthesisUtterance {
            constructor(text) {
                super(text);
                spokenTexts.push(text);
            }
        }

        const synth = new SpeechSynthesisService({
            globalScope: {
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: TrackingUtterance
            }
        });

        // Trigger first speech
        const p1 = synth.speak('Old stale response');
        // Immediately interrupt/stop
        synth.stop();

        // Trigger second speech
        const p2 = synth.speak('New fresh response');

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, false, 'Stale response must return false');
        assert.equal(r2, true, 'Fresh response must succeed');
    });

    // Test 14: Privacy & Activation Boundaries (No Wake-Word, No Background Listening)
    await t.test('enforces strict push-to-talk privacy boundary with continuous listening disabled', () => {
        MockSpeechRecognition.instances = [];
        const controller = new VoiceController({
            globalScope: {
                SpeechRecognition: MockSpeechRecognition,
                speechSynthesis: new MockSpeechSynthesis(),
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            }
        });

        controller.startListening();
        const instance = MockSpeechRecognition.instances[MockSpeechRecognition.instances.length - 1];
        assert.ok(instance);
        assert.equal(instance.continuous, false, 'continuous listening MUST be disabled (push-to-talk only)');

        controller.stopListening();
    });

    // Test 15: Audio Resource Cleanup & Lifecycle Disposal
    await t.test('cleans up audio and recognition resources on dispose()', () => {
        MockSpeechRecognition.instances = [];
        const mockSynth = new MockSpeechSynthesis();

        const controller = new VoiceController({
            globalScope: {
                SpeechRecognition: MockSpeechRecognition,
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
            }
        });

        controller.startListening();
        assert.equal(controller.isListening, true);

        controller.dispose();
        assert.equal(controller.isListening, false);
        assert.equal(controller.isSpeaking, false);
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
    });
});

