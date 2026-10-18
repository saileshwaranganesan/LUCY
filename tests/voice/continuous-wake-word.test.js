'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WakeWordEngine, PRIVACY_STATES } = require('../../src/voice/wake-word-engine.js');
const { VoiceController, VOICE_STATES, RECOGNITION_MODES } = require('../../src/voice/voice-controller.js');
const { synthesizeHeyLucy, synthesizeLucy, synthesizeSilence } = require('../../src/voice/acoustic-synthesizer.js');
const { AudioRecorder } = require('../../src/voice/audio-recorder.js');

test('L.U.C.Y. Repair 3: Continuous Wake-Word Detection and Hands-Free Activation Suite', async (t) => {

    await t.test('1. AudioRecorder supports concurrent continuous streaming and utterance recording without clobbering', async () => {
        let streamClosed = false;
        const mockTrack = { stop: () => { streamClosed = true; } };

        let streamNode = null;
        let procNode = null;

        const mockGlobal = {
            AudioContext: class MockAudioContext {
                constructor() {
                    this.state = 'running';
                    this.destination = {};
                }
                createMediaStreamSource(st) {
                    streamNode = {
                        connect: (target) => { this.target = target; },
                        disconnect: () => {}
                    };
                    return streamNode;
                }
                createScriptProcessor(bufSize, inCh, outCh) {
                    procNode = {
                        connect: (target) => {},
                        disconnect: () => {}
                    };
                    return procNode;
                }
                async resume() { this.state = 'running'; }
                async close() { this.state = 'closed'; }
            },
            navigator: {
                mediaDevices: {
                    getUserMedia: async () => ({
                        getTracks: () => [mockTrack],
                        getAudioTracks: () => [mockTrack]
                    })
                }
            }
        };

        const recorder = new AudioRecorder({ globalScope: mockGlobal });

        let wakeFrames = [];
        let recordFrames = [];

        // 1. Start continuous capture (for wake word)
        await recorder.startContinuousCapture({
            onAudioFrame: (frame) => wakeFrames.push(frame)
        });

        assert.equal(recorder.isStreaming, true);
        assert.equal(recorder.isRecording, false);
        assert.ok(procNode.onaudioprocess, 'Processor node audio handler must be bound');

        // Simulate audio chunk from hardware
        const chunk1 = new Float32Array(2048).fill(0.05);
        procNode.onaudioprocess({ inputBuffer: { getChannelData: () => chunk1 } });

        assert.equal(wakeFrames.length, 1, 'Wake word callback must receive stream frame');
        assert.equal(recordFrames.length, 0);

        // 2. Start utterance recording (when wake word or mic button activates)
        await recorder.start({
            onAudioFrame: (frame) => recordFrames.push(frame)
        });

        assert.equal(recorder.isStreaming, true);
        assert.equal(recorder.isRecording, true);

        // Simulate second audio chunk while recording
        const chunk2 = new Float32Array(2048).fill(0.08);
        procNode.onaudioprocess({ inputBuffer: { getChannelData: () => chunk2 } });

        assert.equal(wakeFrames.length, 2, 'Wake word callback must remain intact and receiving');
        assert.equal(recordFrames.length, 1, 'Recording callback must receive frame');

        // 3. Stop utterance recording
        const wav = recorder.stop();
        assert.ok(wav instanceof Uint8Array || Buffer.isBuffer(wav), 'WAV buffer must be returned');
        assert.equal(recorder.isRecording, false);
        assert.equal(recorder.isStreaming, true, 'Streaming must remain active after stopping utterance');
        assert.equal(streamClosed, false, 'Hardware stream must remain open and not destroyed');

        // Simulate third audio chunk post-utterance
        const chunk3 = new Float32Array(2048).fill(0.03);
        procNode.onaudioprocess({ inputBuffer: { getChannelData: () => chunk3 } });

        assert.equal(wakeFrames.length, 3, 'Wake word callback must continue receiving frames post-utterance');

        // 4. Cleanup
        recorder.cleanup();
        assert.equal(streamClosed, true);
    });

    await t.test('2. VoiceController maintains continuous frame flow across multiple repeated wake-word cycles', async () => {
        let wakeWordDetections = 0;
        let commandTranscriptions = 0;
        let wakeWordFrameDeliveries = 0;

        let continuousCallback = null;
        let isContinuousStreaming = false;

        const mockRecorder = {
            supported: true,
            isCapturing: true,
            startContinuousCapture: async ({ onAudioFrame }) => {
                continuousCallback = onAudioFrame;
                isContinuousStreaming = true;
                return true;
            },
            setWakeWordCallback: (fn) => {
                continuousCallback = fn;
            },
            stopContinuousCapture: async () => {
                continuousCallback = null;
                isContinuousStreaming = false;
                return true;
            },
            start: async () => true,
            stop: async () => new Uint8Array(200),
            cancel: () => {}
        };

        const mockWhisper = {
            isAvailable: () => true,
            getStatus: () => ({ isAvailable: true }),
            transcribeAudio: async () => {
                commandTranscriptions++;
                return { ok: true, transcript: `command ${commandTranscriptions}` };
            }
        };

        const mockSynthesis = {
            supported: true,
            isSpeaking: false,
            speak: async () => true,
            stop: () => {},
            getVoiceConfig: () => ({ pitch: 1.05, rate: 1.02 }),
            setVoiceConfig: () => {}
        };

        const states = [];
        const controller = new VoiceController({
            whisperEngine: mockWhisper,
            audioRecorder: mockRecorder,
            synthesis: mockSynthesis,
            recognitionMode: RECOGNITION_MODES.OFFLINE,
            enableVad: false,
            wakeWordEnabled: true,
            onWakeWord: () => {
                wakeWordDetections++;
            },
            onWakeWordStateChange: (info) => {
                states.push(info.state);
            }
        });

        // Wrap wake word processInput to count frame deliveries
        const origProcess = controller.wakeWordEngine.processInput.bind(controller.wakeWordEngine);
        controller.wakeWordEngine.processInput = (input) => {
            if (input && input.audioFrame) {
                wakeWordFrameDeliveries++;
            }
            return origProcess(input);
        };

        assert.equal(isContinuousStreaming, true, 'Continuous streaming must be active on enable');
        assert.ok(typeof continuousCallback === 'function', 'Continuous callback must be registered');

        // CYCLE 1:
        // Feed silence
        continuousCallback(synthesizeSilence({ durationMs: 200 }));
        assert.equal(wakeWordFrameDeliveries, 1);
        assert.equal(wakeWordDetections, 0);

        // Feed "Hey Lucy"
        continuousCallback(synthesizeHeyLucy());
        assert.equal(wakeWordDetections, 1, 'First wake word must trigger');
        assert.equal(controller.voiceState, VOICE_STATES.LISTENING);
        assert.ok(states.includes('triggered'));
        assert.ok(states.includes('waiting_for_command'));

        // Complete command 1
        controller.stopListening();
        await new Promise(r => setTimeout(r, 60));

        assert.equal(commandTranscriptions, 1);
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
        assert.equal(controller.wakeWordEngine.isPaused, false);

        // Post-Cycle 1: Feed audio frame, must reach wakeWordEngine!
        continuousCallback(synthesizeSilence({ durationMs: 200 }));
        assert.equal(wakeWordFrameDeliveries, 3, 'Frames must continue reaching detector after cycle 1 completion');

        // Wait for cooldown
        await new Promise(r => setTimeout(r, 100));
        controller.wakeWordEngine.lastTriggerTime = 0; // reset cooldown for deterministic test

        // CYCLE 2: Second activation without any user click!
        continuousCallback(synthesizeHeyLucy());
        assert.equal(wakeWordDetections, 2, 'Second hands-free wake word must trigger cleanly');
        assert.equal(controller.voiceState, VOICE_STATES.LISTENING);

        // Complete command 2
        controller.stopListening();
        await new Promise(r => setTimeout(r, 60));

        assert.equal(commandTranscriptions, 2);
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);

        // Post-Cycle 2: Feed another frame, must still reach detector!
        continuousCallback(synthesizeSilence({ durationMs: 200 }));
        assert.equal(wakeWordFrameDeliveries, 5, 'Frames must continue reaching detector after cycle 2 completion');

        controller.dispose();
    });

    await t.test('3. Truthful state reporting: initialising, failure, and recovery', async () => {
        let stateLog = [];

        let shouldFail = true;
        const mockRecorder = {
            supported: true,
            startContinuousCapture: async () => {
                if (shouldFail) {
                    throw new Error('NotAllowedError: Permission denied');
                }
                return true;
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

        // Attempt enable when hardware fails
        controller.setWakeWordEnabled(true);
        await new Promise(r => setTimeout(r, 30));

        assert.ok(stateLog.includes('failed'), 'Must report failed state on hardware failure');
        assert.equal(controller.wakeWordEngine.enabled, false);

        // Now hardware recovers
        shouldFail = false;
        stateLog = [];
        controller.setWakeWordEnabled(true);
        await new Promise(r => setTimeout(r, 30));

        assert.ok(stateLog.includes('listening_wake'), 'Must report listening_wake on recovery');
        assert.equal(controller.wakeWordEngine.enabled, true);

        controller.dispose();
    });

    await t.test('4. Anti-echo debounce prevents false activation during speech playback', async () => {
        let wakeWordFired = false;
        const mockSynthesis = {
            supported: true,
            isSpeaking: false,
            speak: async (text, options = {}) => {
                if (typeof options.onStart === 'function') {
                    options.onStart();
                }
                await new Promise(r => setTimeout(r, 80));
                return true;
            },
            stop: () => {}
        };

        const mockRecorder = {
            supported: true,
            startContinuousCapture: async () => true,
            stopContinuousCapture: async () => true,
            setWakeWordCallback: () => {}
        };

        const controller = new VoiceController({
            wakeWordEnabled: true,
            synthesis: mockSynthesis,
            audioRecorder: mockRecorder,
            onWakeWord: () => { wakeWordFired = true; }
        });

        const speakPromise = controller.speak('Lucy is speaking this message.');
        assert.equal(controller.wakeWordEngine.isPaused, true, 'Wake word must pause immediately on speech start');

        // Audio arriving during speech must be ignored
        const echo = synthesizeHeyLucy();
        const res = controller.wakeWordEngine.processInput({ audioFrame: echo });
        assert.equal(res, null, 'Wake word must not trigger on acoustic input while speaking');
        assert.equal(wakeWordFired, false);

        await speakPromise;

        // Immediately after playback ends, anti-echo debounce must still keep engine paused
        assert.equal(controller.wakeWordEngine.isPaused, true, 'Engine must remain paused during anti-echo debounce');

        // After 450ms, engine unpauses
        await new Promise(r => setTimeout(r, 500));
        assert.equal(controller.wakeWordEngine.isPaused, false, 'Engine must resume after anti-echo debounce');

        controller.dispose();
    });
});
