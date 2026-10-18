'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceController, VOICE_STATES } = require('../../src/voice/voice-controller.js');
const { SpeechSynthesisService } = require('../../src/voice/speech-synthesis.js');

class MockUtterance {
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

class MockSpeechSynth {
    constructor() {
        this.speaking = false;
        this.canceled = false;
        this.activeUtterance = null;
        this.history = [];
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
        this.history.push({
            text: utterance.text,
            rate: utterance.rate,
            pitch: utterance.pitch,
            volume: utterance.volume,
            voiceName: utterance.voice?.name || ''
        });

        if (utterance.onstart) {
            process.nextTick(() => {
                if (this.speaking && !this.canceled) utterance.onstart();
            });
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

class MockAudio {
    constructor(src) {
        this.src = src;
        this.volume = 1.0;
        this.playbackRate = 1.0;
        this.preservesPitch = true;
        this.paused = true;
        this.currentTime = 0;
        this.onplay = null;
        this.onended = null;
        this.onerror = null;
        this.onabort = null;
        MockAudio.instances.push(this);
    }

    play() {
        this.paused = false;
        if (this.onplay) {
            process.nextTick(() => {
                if (!this.paused) this.onplay();
            });
        }
        if (MockAudio.autoEnd) {
            process.nextTick(() => {
                if (!this.paused) {
                    this.paused = true;
                    if (this.onended) this.onended();
                }
            });
        }
        return Promise.resolve();
    }

    pause() {
        this.paused = true;
    }
}
MockAudio.instances = [];
MockAudio.autoEnd = true;

test('L.U.C.Y. Repair 5: Voice Preview, Kokoro TTS & Playback Suite', async (t) => {

    await t.test('1. VoiceController.speak() exists, speaks test phrase and triggers onStart callback', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = true;

        let ipcCalled = false;
        let onStartCalled = false;
        const mockSynth = new MockSpeechSynth();

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async (text, opts) => {
                        ipcCalled = true;
                        assert.equal(opts.voice, 'af_bella');
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        assert.equal(typeof controller.speak, 'function', 'VoiceController must expose speak() method');

        const success = await controller.speak('Sparkle! I am Lucy testing voice preview.', {
            voice: 'af_bella',
            rate: 1.1,
            pitch: 1.05,
            volume: 0.9,
            isPreview: true,
            onStart: () => {
                onStartCalled = true;
            }
        });

        assert.equal(success, true, 'Speech playback must resolve true on completion');
        assert.equal(ipcCalled, true, 'Kokoro IPC synthesizeSpeech must be invoked');
        assert.equal(onStartCalled, true, 'onStart callback must fire when audio begins');
        assert.equal(MockAudio.instances.length, 1);
        assert.equal(MockAudio.instances[0].volume, 0.9, 'Audio volume must match configured volume');
    });

    await t.test('2. Kokoro preset selection: af_bella and af_sky route to Kokoro engine', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = true;
        const synthCalls = [];

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: new MockSpeechSynth(),
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async (text, opts) => {
                        synthCalls.push(opts);
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        // Test Sky voice
        await controller.speak('Testing Sky fairy voice', {
            voice: 'af_sky',
            rate: 1.0,
            isPreview: true
        });

        assert.equal(synthCalls.length, 1);
        assert.equal(synthCalls[0].voice, 'af_sky', 'Must pass af_sky to Kokoro synthesizer');

        // Test Bella voice
        await controller.speak('Testing Bella fairy voice', {
            voice: 'af_bella',
            rate: 1.0,
            isPreview: true
        });

        assert.equal(synthCalls.length, 2);
        assert.equal(synthCalls[1].voice, 'af_bella', 'Must pass af_bella to Kokoro synthesizer');
    });

    await t.test('3. Speech rate, pitch, and volume affect Kokoro and SAPI5 playback', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = true;
        const kokoroOpts = [];
        const mockSynth = new MockSpeechSynth();

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async (text, opts) => {
                        kokoroOpts.push(opts);
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        // Kokoro rate, pitch, and volume
        await controller.speak('Kokoro parameters test', {
            voice: 'af_bella',
            rate: 1.25,
            pitch: 1.15,
            volume: 0.65,
            isPreview: true
        });

        assert.equal(kokoroOpts[0].rate, 1.25);
        assert.equal(kokoroOpts[0].pitch, 1.15);
        assert.equal(kokoroOpts[0].volume, 0.65);
        assert.equal(MockAudio.instances[0].volume, 0.65);
        assert.equal(MockAudio.instances[0].playbackRate, 1.15);
        assert.equal(MockAudio.instances[0].preservesPitch, false);

        // Windows SAPI5 rate, pitch, and volume
        await controller.speak('Windows SAPI5 parameters test', {
            ttsEngine: 'windows-speech',
            voiceName: 'Microsoft David Desktop',
            rate: 0.85,
            pitch: 1.2,
            volume: 0.75,
            isPreview: true
        });

        const sapiCall = mockSynth.history[mockSynth.history.length - 1];
        assert.equal(sapiCall.rate, 0.85);
        assert.equal(sapiCall.pitch, 1.2);
        assert.equal(sapiCall.volume, 0.75);
        assert.equal(sapiCall.voiceName, 'Microsoft David Desktop');
    });

    await t.test('4. Preview uses live unsaved values rather than stale saved settings', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = true;
        let capturedOpts = null;

        const controller = new VoiceController({
            ttsEngine: 'kokoro',
            kokoroVoice: 'af_bella',
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: new MockSpeechSynth(),
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async (text, opts) => {
                        capturedOpts = opts;
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        // Controller saved state is rate: 1.0, pitch: 1.05, voice: af_bella
        // Simulate clicking preview with unsaved UI changes: Sky, rate 1.35, pitch 1.25, volume 0.5
        await controller.speak('Unsaved parameters test', {
            voice: 'af_sky',
            rate: 1.35,
            pitch: 1.25,
            volume: 0.5,
            isPreview: true
        });

        assert.equal(capturedOpts.voice, 'af_sky', 'Must use unsaved voice selection');
        assert.equal(capturedOpts.rate, 1.35, 'Must use unsaved rate');
        assert.equal(capturedOpts.pitch, 1.25, 'Must use unsaved pitch');
        assert.equal(capturedOpts.volume, 0.5, 'Must use unsaved volume');
    });

    await t.test('5. Preview bypasses muted chat TTS (ttsEnabled: false)', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = true;
        let speakResponseInvoked = false;
        let speakPreviewInvoked = false;

        const controller = new VoiceController({
            ttsEnabled: false, // User muted conversational chat TTS
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: new MockSpeechSynth(),
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        speakPreviewInvoked = true;
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        // Standard chat response must NOT speak when ttsEnabled: false
        const res = await controller.speakResponse('This chat response should stay silent.');
        assert.equal(res, false, 'speakResponse must be blocked when TTS is disabled');
        assert.equal(speakPreviewInvoked, false);

        // Preview MUST still speak when user tests voice in settings
        const previewRes = await controller.speak('Previewing voice while chat TTS is muted', {
            voice: 'af_bella',
            isPreview: true
        });
        assert.equal(previewRes, true, 'preview must bypass ttsEnabled: false');
        assert.equal(speakPreviewInvoked, true, 'synthesizeSpeech must be called for preview');
    });

    await t.test('6. Overlap prevention: Rapid repeated clicks cancel previous playback immediately', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = false; // Hold audio open to simulate ongoing playback
        let stopKokoroCount = 0;

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: new MockSpeechSynth(),
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => {
                        stopKokoroCount++;
                        return { ok: true };
                    }
                }
            }
        });

        // Trigger first speech and wait for playback to start
        let firstStarted = false;
        const p1 = controller.speak('First voice preview', {
            isPreview: true,
            onStart: () => { firstStarted = true; }
        });

        // Wait until first audio has started
        while (!firstStarted) {
            await new Promise(r => setImmediate(r));
        }

        // First audio is now active
        assert.equal(controller.isSpeaking, true);
        assert.equal(MockAudio.instances.length, 1);
        const firstAudio = MockAudio.instances[0];

        // Trigger second speech while first is still playing
        let secondStarted = false;
        const p2 = controller.speak('Second voice preview', {
            isPreview: true,
            onStart: () => { secondStarted = true; }
        });

        while (!secondStarted) {
            await new Promise(r => setImmediate(r));
        }

        // First audio must be halted and reset immediately
        assert.equal(firstAudio.paused, true, 'First audio must be paused immediately');
        assert.equal(firstAudio.src, '', 'First audio source must be cleared');
        assert.ok(stopKokoroCount >= 1, 'stopKokoroSpeech must be called on interruption');

        // Let second finish
        const secondAudio = MockAudio.instances[1];
        assert.ok(secondAudio, 'Second audio instance must exist');
        secondAudio.onended?.();

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, false, 'Superseded first speech must return false');
        assert.equal(r2, true, 'Latest second speech must succeed');
    });

    await t.test('7. Stop playback: stopSpeaking() cancels active preview and cleans up', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = false;
        let stopped = false;

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: new MockSpeechSynth(),
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => {
                        stopped = true;
                        return { ok: true };
                    }
                }
            }
        });

        let started = false;
        const speakPromise = controller.speak('Testing stop button capability', {
            isPreview: true,
            onStart: () => { started = true; }
        });
        // Allow microtasks for synthesis and playback start
        for (let i = 0; i < 10 && !started; i++) {
            await new Promise(r => setImmediate(r));
        }
        assert.equal(controller.isSpeaking, true, 'Controller must transition to speaking once playback starts');

        // User clicks Stop
        controller.stopSpeaking();
        assert.equal(controller.isSpeaking, false, 'Controller must immediately return to not speaking');
        assert.equal(stopped, true, 'stopKokoroSpeech IPC must be triggered');

        const result = await speakPromise;
        assert.equal(result, false, 'Interrupted preview must resolve false');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE, 'State must return to idle');
    });

    await t.test('8. Transparent fallback to Windows SAPI5 when Kokoro fails', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = true;
        const mockSynth = new MockSpeechSynth();

        const controller = new VoiceController({
            ttsEngine: 'kokoro',
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: mockSynth,
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        return { ok: false, error: 'Worker process OOM or model missing' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        // Must transparently fall back to native speech
        const res = await controller.speak('Fallback to SAPI5 test', {
            voice: 'af_bella',
            isPreview: true
        });

        assert.equal(res, true, 'Speech must succeed via SAPI5 fallback');
        assert.equal(mockSynth.history.length, 1, 'SAPI5 synth must have been called');
        assert.equal(mockSynth.history[0].text, 'Fallback to SAPI5 test');
    });

    await t.test('9. Resource cleanup: Media elements and memory references are freed', async () => {
        MockAudio.instances = [];
        MockAudio.autoEnd = true;

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudio,
                speechSynthesis: new MockSpeechSynth(),
                SpeechSynthesisUtterance: MockUtterance,
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        return { ok: true, audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' };
                    },
                    stopKokoroSpeech: async () => ({ ok: true })
                }
            }
        });

        await controller.speak('Cleanup test phrase', { isPreview: true });

        assert.equal(controller.activeKokoroAudio, null, 'activeKokoroAudio must be cleared after playback');
        assert.equal(controller.isSpeaking, false);
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
    });
});
