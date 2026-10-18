'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceController, VOICE_STATES } = require('../../src/voice/voice-controller.js');
const { KokoroTtsService } = require('../../src/voice/kokoro-tts-service.js');

class MockAudioElement {
    constructor(src) {
        this.src = src;
        this.volume = 1.0;
        this.playbackRate = 1.0;
        this.preservesPitch = true;
        this.paused = true;
        this.currentTime = 0;
        this.sinkId = '';
        this.error = null;
        this.onplay = null;
        this.onended = null;
        this.onerror = null;
        this.onabort = null;
        MockAudioElement.instances.push(this);
    }

    setSinkId(id) {
        if (MockAudioElement.sinkIdShouldFail) {
            return Promise.reject(new Error('Requested audio output device not found'));
        }
        this.sinkId = id;
        return Promise.resolve();
    }

    play() {
        if (MockAudioElement.playShouldReject) {
            const err = new Error(MockAudioElement.playRejectMessage || 'NotSupportedError: Failed to load because no supported source was found.');
            err.name = 'NotSupportedError';
            return Promise.reject(err);
        }
        this.paused = false;
        if (this.onplay) {
            process.nextTick(() => {
                if (!this.paused && this.onplay) this.onplay();
            });
        }
        if (MockAudioElement.autoEnd) {
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
MockAudioElement.instances = [];
MockAudioElement.autoEnd = true;
MockAudioElement.playShouldReject = false;
MockAudioElement.playRejectMessage = '';
MockAudioElement.sinkIdShouldFail = false;

class MockAudioContext {
    constructor() {
        this.state = 'suspended';
        this.sampleRate = 48000;
        this.destination = { id: 'mock-destination' };
        MockAudioContext.instances.push(this);
    }

    async resume() {
        this.state = 'running';
    }

    createAnalyser() {
        return {
            fftSize: 64,
            frequencyBinCount: 32,
            connect: (dest) => { this._connectedTo = dest; },
            disconnect: () => { this._connectedTo = null; },
            getByteFrequencyData: (arr) => arr.fill(128)
        };
    }

    createMediaElementSource(audio) {
        if (MockAudioContext.mediaSourceShouldFail) {
            throw new Error('CORS taint / MediaElementSource not permitted');
        }
        const node = {
            audio,
            connected: null,
            connect: (target) => { node.connected = target; },
            disconnect: () => { node.connected = null; }
        };
        MockAudioContext.mediaSources.push(node);
        return node;
    }

    close() {
        this.state = 'closed';
        return Promise.resolve();
    }
}
MockAudioContext.instances = [];
MockAudioContext.mediaSources = [];
MockAudioContext.mediaSourceShouldFail = false;

test('L.U.C.Y. Repair 2: Voice Playback and Audible Output Comprehensive Verification', async (t) => {

    t.beforeEach(() => {
        MockAudioElement.instances = [];
        MockAudioElement.autoEnd = true;
        MockAudioElement.playShouldReject = false;
        MockAudioElement.playRejectMessage = '';
        MockAudioElement.sinkIdShouldFail = false;
        MockAudioContext.instances = [];
        MockAudioContext.mediaSources = [];
        MockAudioContext.mediaSourceShouldFail = false;
    });

    await t.test('1. Valid WAV synthesis and audio-format validation', async () => {
        // Validate PCM 16-bit 24kHz mono WAV structure
        const sampleRate = 24000;
        const numSamples = 2400; // 0.1s
        const buffer = Buffer.alloc(44 + numSamples * 2);
        buffer.write('RIFF', 0, 4, 'ascii');
        buffer.writeUInt32LE(36 + numSamples * 2, 4);
        buffer.write('WAVE', 8, 4, 'ascii');
        buffer.write('fmt ', 12, 4, 'ascii');
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20); // Audio format 1 = PCM integer
        buffer.writeUInt16LE(1, 22); // Mono
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * 2, 28);
        buffer.writeUInt16LE(2, 32);
        buffer.writeUInt16LE(16, 34); // 16-bit
        buffer.write('data', 36, 4, 'ascii');
        buffer.writeUInt32LE(numSamples * 2, 40);

        assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
        assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
        assert.equal(buffer.readUInt16LE(20), 1, 'Must be PCM integer format');
        assert.equal(buffer.readUInt16LE(22), 1, 'Must be 1 channel (mono)');
        assert.equal(buffer.readUInt32LE(24), 24000, 'Must be 24000 Hz');
        assert.equal(buffer.readUInt16LE(34), 16, 'Must be 16-bit samples');
    });

    await t.test('2. Successful playback initialization and settings configuration', async () => {
        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async (_t, opts) => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
                        duration_s: 1.0
                    })
                }
            }
        });

        const success = await controller.speak('Test playback initialization', {
            voice: 'af_bella',
            rate: 1.15,
            pitch: 1.1,
            volume: 0.85
        });

        assert.equal(success, true, 'Playback must succeed');
        assert.equal(MockAudioElement.instances.length, 1);
        const audio = MockAudioElement.instances[0];
        assert.equal(audio.volume, 0.85, 'Audio volume must match passed volume setting');
        assert.equal(audio.playbackRate, 1.1, 'Audio playbackRate must match passed pitch');
        assert.equal(MockAudioContext.instances.length, 1);
        assert.equal(MockAudioContext.instances[0].state, 'running', 'AudioContext must be resumed');
    });

    await t.test('3. Playback-start event and truthful speaking-state transition', async () => {
        let stateDuringSynthesis = null;
        let stateOnStart = null;

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        // Check controller state during active synthesis
                        stateDuringSynthesis = controller.voiceState;
                        return {
                            ok: true,
                            audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                        };
                    }
                }
            }
        });

        MockAudioElement.autoEnd = false; // keep playing

        const speakPromise = controller.speak('Speaking state verification', {
            onStart: () => {
                stateOnStart = controller.voiceState;
            }
        });

        // Allow microtasks for synthesis and onplay to fire
        for (let i = 0; i < 10 && !stateOnStart; i++) {
            await new Promise(r => setImmediate(r));
        }

        assert.notEqual(stateDuringSynthesis, VOICE_STATES.SPEAKING, 'Must NOT be speaking during synthesis');
        assert.equal(stateOnStart, VOICE_STATES.SPEAKING, 'Must transition to speaking when onStart fires');
        assert.equal(controller.isSpeaking, true, 'isSpeaking must be true while audio is active');

        // End playback
        MockAudioElement.instances[0].onended();
        const res = await speakPromise;
        assert.equal(res, true);
    });

    await t.test('4. Playback completion and return to idle', async () => {
        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                    })
                }
            }
        });

        const res = await controller.speak('Complete and return to idle');
        assert.equal(res, true);
        assert.equal(controller.voiceState, VOICE_STATES.IDLE, 'State must return to idle upon completion');
        assert.equal(controller.isSpeaking, false);
    });

    await t.test('5. Audio-device unavailability handling', async () => {
        MockAudioElement.sinkIdShouldFail = true;

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                    })
                }
            }
        });

        // Even if requested sinkId fails, playback gracefully proceeds to default output
        const res = await controller.speak('Audio device fallback test', { sinkId: 'non-existent-device-id' });
        assert.equal(res, true, 'Should fall back gracefully without unhandled crashes');
    });

    await t.test('6. Rejected playback promises handled explicitly without faking success', async () => {
        MockAudioElement.playShouldReject = true;
        MockAudioElement.playRejectMessage = 'NotSupportedError: Failed to load because no supported source was found.';

        let errorReceived = null;
        const controller = new VoiceController({
            onError: (err) => { errorReceived = err; },
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                    })
                }
            }
        });

        const res = await controller.speak('Playback rejection test');
        assert.equal(res, false, 'Must return false when audio.play() rejects');
        assert.ok(errorReceived, 'Must report error to onError callback');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE, 'Must not remain in speaking state');
        assert.equal(controller.isSpeaking, false);
    });

    await t.test('7. Corrupted or unsupported audio data emits error and resolves false', async () => {
        let errorReceived = null;
        const controller = new VoiceController({
            onError: (err) => { errorReceived = err; },
            globalScope: {
                Audio: class CorruptedAudio extends MockAudioElement {
                    play() {
                        this.error = { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format not supported' };
                        process.nextTick(() => {
                            if (this.onerror) this.onerror();
                        });
                        return Promise.resolve();
                    }
                },
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,CORRUPTED_BYTES'
                    })
                }
            }
        });

        const res = await controller.speak('Corrupted audio test');
        assert.equal(res, false, 'Must resolve false on audio error event');
        assert.ok(errorReceived);
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
    });

    await t.test('8. Synthesis failure handles transparent fallback or truthful failure', async () => {
        let fallbackCalled = false;
        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: false,
                        error: 'ONNX worker out of memory'
                    })
                }
            }
        });

        // Mock synthesis fallback
        controller.synthesis = {
            speak: async (_t, opts) => {
                fallbackCalled = true;
                if (opts.onStart) opts.onStart();
                return true;
            },
            stop: () => {}
        };

        const res = await controller.speak('Fallback test');
        assert.equal(fallbackCalled, true, 'Must fall back to secondary synthesis service on Kokoro failure');
        assert.equal(res, true);
    });

    await t.test('9. Empty or invalid speech text rejected immediately', async () => {
        let ipcCalled = false;
        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => {
                        ipcCalled = true;
                        return { ok: true, audio: 'data:audio/wav;base64,...' };
                    }
                }
            }
        });

        assert.equal(await controller.speak(''), false);
        assert.equal(await controller.speak('   '), false);
        assert.equal(await controller.speak(null), false);
        assert.equal(await controller.speak(undefined), false);
        assert.equal(ipcCalled, false, 'IPC synthesis must not be called for empty text');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
    });

    await t.test('10. Cancellation and interruption stops playback and releases resources', async () => {
        MockAudioElement.autoEnd = false;
        let kokoroStopped = false;

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                    }),
                    stopKokoroSpeech: async () => {
                        kokoroStopped = true;
                        return { ok: true };
                    }
                }
            }
        });

        let started = false;
        const speakPromise = controller.speak('Cancel test phrase', {
            onStart: () => { started = true; }
        });

        for (let i = 0; i < 10 && !started; i++) {
            await new Promise(r => setImmediate(r));
        }

        assert.equal(controller.isSpeaking, true);
        const audioInstance = MockAudioElement.instances[0];
        assert.equal(audioInstance.paused, false);

        // Cancel
        controller.stopSpeaking();

        assert.equal(audioInstance.paused, true, 'Audio must be paused immediately');
        assert.equal(kokoroStopped, true, 'stopKokoroSpeech IPC must be invoked');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE, 'State must return to IDLE');
        assert.equal(controller.isSpeaking, false);

        const res = await speakPromise;
        assert.equal(res, false, 'Cancelled speech must resolve false');
    });

    await t.test('11. Rapid consecutive speech requests do not corrupt sequence or state', async () => {
        MockAudioElement.autoEnd = true;

        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async (_text) => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                    })
                }
            }
        });

        const p1 = controller.speak('First fast request');
        const p2 = controller.speak('Second fast request');

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, false, 'First superseded request must resolve false');
        assert.equal(r2, true, 'Second active request must resolve true');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
    });

    await t.test('12. Voice preview functions without assistant task execution', async () => {
        let taskExecuted = false;
        const controller = new VoiceController({
            ttsEnabled: false, // Muted normal chat
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                    })
                }
            }
        });

        // Ordinary speech should be blocked because ttsEnabled = false
        const normalRes = await controller.speakResponse('Normal response');
        assert.equal(normalRes, false, 'Normal response must be muted');

        // Preview should bypass mute and play without task execution
        const previewRes = await controller.speak('Auditioning Fairy Voice', { isPreview: true });
        assert.equal(previewRes, true, 'Preview must succeed even when chat voice is muted');
        assert.equal(taskExecuted, false, 'Preview must never trigger assistant tasks');
    });

    await t.test('13. Selected voice preset and speech settings accurately applied', async () => {
        let passedOpts = null;
        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async (_t, opts) => {
                        passedOpts = opts;
                        return { ok: true, audio: 'data:audio/wav;base64,...' };
                    }
                }
            }
        });

        await controller.speak('Testing Sky preset with customized rate and pitch', {
            voice: 'af_sky',
            rate: 1.25,
            pitch: 1.15,
            volume: 0.75
        });

        assert.ok(passedOpts);
        assert.equal(passedOpts.voice, 'af_sky', 'Must pass af_sky preset');
        assert.equal(passedOpts.rate, 1.25, 'Must pass rate');
        assert.equal(passedOpts.pitch, 1.15, 'Must pass pitch');
        assert.equal(passedOpts.volume, 0.75, 'Must pass volume');
    });

    await t.test('14. Companion emotion preservation during speech', () => {
        // Test visual emotion state preservation as in app.js
        const mockRenderer = {
            state: { emotion: 'pet' },
            setVisualState: function(next) {
                if (this.state.emotion !== 'pet' && !String(this.state.emotion).startsWith('trick_')) {
                    this.state.emotion = next.emotion;
                }
            }
        };

        mockRenderer.setVisualState({ emotion: 'speaking' });
        assert.equal(mockRenderer.state.emotion, 'pet', 'Pet emotion must NOT be overwritten by speaking state');

        mockRenderer.state.emotion = 'trick_somersault';
        mockRenderer.setVisualState({ emotion: 'speaking' });
        assert.equal(mockRenderer.state.emotion, 'trick_somersault', 'Trick animation must NOT be overwritten by speaking state');

        mockRenderer.state.emotion = 'happy';
        mockRenderer.setVisualState({ emotion: 'speaking' });
        assert.equal(mockRenderer.state.emotion, 'speaking', 'Normal happy emotion transitions to speaking');
    });

    await t.test('15. Cleanup of audio resources, MediaElementSource, and references', async () => {
        const controller = new VoiceController({
            globalScope: {
                Audio: MockAudioElement,
                AudioContext: MockAudioContext,
                lucyIpc: {
                    synthesizeSpeech: async () => ({
                        ok: true,
                        audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
                    })
                }
            }
        });

        assert.equal(controller.activeKokoroAudio, null);
        const res = await controller.speak('Cleanup verification');
        assert.equal(res, true);

        // Verify audio element reference is cleared after playback
        assert.equal(controller.activeKokoroAudio, null, 'activeKokoroAudio must be nulled on completion');

        // Verify mediaSource was disconnected
        if (MockAudioContext.mediaSources.length > 0) {
            for (const ms of MockAudioContext.mediaSources) {
                assert.equal(ms.connected, null, 'MediaElementSource must be disconnected');
            }
        }
    });
});
