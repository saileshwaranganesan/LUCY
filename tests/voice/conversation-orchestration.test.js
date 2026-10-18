'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { VoiceActivityDetector, VAD_STATES } = require('../../src/voice/voice-activity-detector.js');
const { ConversationStateMachine, CONVERSATION_STATES } = require('../../src/voice/conversation-state-machine.js');
const { VoiceController, VOICE_STATES, RECOGNITION_MODES } = require('../../src/voice/voice-controller.js');

describe('L.U.C.Y. Voice Conversation Orchestration & Conversational Cycle Suite', () => {

    // Helper: generate synthetic sine-wave audio frame (simulates voice)
    function generateSpeechChunk(durationSec = 0.5, sampleRate = 16000, freq = 300, amplitude = 0.3) {
        const numSamples = Math.floor(sampleRate * durationSec);
        const chunk = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            chunk[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
        }
        return chunk;
    }

    // Helper: generate synthetic low-amplitude noise (simulates room silence)
    function generateSilenceChunk(durationSec = 0.5, sampleRate = 16000, amplitude = 0.002) {
        const numSamples = Math.floor(sampleRate * durationSec);
        const chunk = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            chunk[i] = (Math.random() * 2 - 1) * amplitude;
        }
        return chunk;
    }

    describe('1. Voice Activity Detector (VAD) Local Acoustics & Hangover Mechanics', () => {
        let vad;

        beforeEach(() => {
            vad = new VoiceActivityDetector({
                sampleRate: 16000,
                hangoverMs: 200,      // fast hangover for tests
                onsetFrames: 2,       // 2 frames (~64ms) to trigger onset
                initialSilenceTimeoutMs: 1000
            });
        });

        afterEach(() => {
            vad.stop();
        });

        test('initializes in IDLE state with default sensitivity profile', () => {
            assert.strictEqual(vad.state, VAD_STATES.IDLE);
            assert.strictEqual(vad.sensitivity, 'normal');
            assert.strictEqual(vad.isActive, false);
        });

        test('transitions to WAITING_FOR_SPEECH upon start()', () => {
            let stateEmitted = null;
            vad.on('stateChange', ({ state }) => { stateEmitted = state; });

            vad.start();
            assert.strictEqual(vad.isActive, true);
            assert.strictEqual(vad.state, VAD_STATES.WAITING_FOR_SPEECH);
            assert.strictEqual(stateEmitted, VAD_STATES.WAITING_FOR_SPEECH);
        });

        test('adapts noise floor to steady ambient room silence without false triggers', () => {
            vad.start();
            const silence = generateSilenceChunk(0.2, 16000, 0.005);

            for (let i = 0; i < 5; i++) {
                vad.processAudioChunk(silence);
            }

            // State should remain WAITING_FOR_SPEECH, no false speechStart emitted
            assert.strictEqual(vad.state, VAD_STATES.WAITING_FOR_SPEECH);
            assert.ok(vad.noiseFloorRms < 0.02, `Noise floor ${vad.noiseFloorRms} adapted properly`);
        });

        test('detects speech onset and transitions through SPEECH_ONSET to SPEAKING', () => {
            vad.start();
            let speechStartFired = false;
            vad.on('speechStart', () => { speechStartFired = true; });

            // Feed speech audio frames
            const speech = generateSpeechChunk(0.1, 16000, 400, 0.25);
            vad.processAudioChunk(speech);

            assert.strictEqual(speechStartFired, true);
            assert.strictEqual(vad.state, VAD_STATES.SPEAKING);
        });

        test('fires speechEnd after speech followed by hangover silence period', (t, done) => {
            vad.start();
            let speechEnded = false;

            vad.on('speechEnd', ({ sampleCount, durationMs }) => {
                speechEnded = true;
                assert.ok(sampleCount > 0, 'Speech samples accumulated');
                assert.ok(durationMs > 0, 'Duration reported');
                assert.strictEqual(vad.state, VAD_STATES.COMPLETED);
                done();
            });

            // 1. Send speech
            const speech = generateSpeechChunk(0.15, 16000, 400, 0.3);
            vad.processAudioChunk(speech);

            // 2. Send silence lasting longer than hangoverMs (200ms)
            const silence = generateSilenceChunk(0.25, 16000, 0.001);
            vad.processAudioChunk(silence);
        });

        test('triggers silenceTimeout if no speech is detected within timeout', (t, done) => {
            const shortTimeoutVad = new VoiceActivityDetector({
                initialSilenceTimeoutMs: 150
            });
            shortTimeoutVad.start();

            shortTimeoutVad.on('silenceTimeout', () => {
                shortTimeoutVad.stop();
                done();
            });

            // Send 200ms of pure silence
            const silence = generateSilenceChunk(0.25, 16000, 0.001);
            shortTimeoutVad.processAudioChunk(silence);
        });

        test('supports dynamic sensitivity level switching (low, normal, high)', () => {
            vad.setSensitivity('high');
            assert.strictEqual(vad.sensitivity, 'high');
            assert.strictEqual(vad.profile.multiplier, 1.6);

            vad.setSensitivity('low');
            assert.strictEqual(vad.sensitivity, 'low');
            assert.strictEqual(vad.profile.multiplier, 3.2);
        });
    });

    describe('2. Conversational Lifecycle State Machine', () => {
        let sm;
        let mockVoiceController;
        let mockTaskCoordinator;
        let mockCompanionBridge;

        beforeEach(() => {
            mockVoiceController = {
                ttsEnabled: true,
                isSpeaking: false,
                spokenTexts: [],
                startListening: () => true,
                stopListening: () => true,
                stopSpeaking: function() { this.isSpeaking = false; },
                speakResponse: async function(text) {
                    this.isSpeaking = true;
                    this.spokenTexts.push(text);
                    this.isSpeaking = false;
                    return true;
                },
                transcribeAudio: async (samples) => ({ ok: true, transcript: 'What is the weather today?' })
            };

            mockTaskCoordinator = {
                requests: [],
                executeRequest: async function(text, opts) {
                    this.requests.push({ text, opts });
                    return { ok: true, replyText: 'The weather in Neo-Veridia is crystal clear, 22°C.' };
                }
            };

            mockCompanionBridge = {
                emotions: [],
                setEmotion: function(emotion, desc) {
                    this.emotions.push({ emotion, desc });
                }
            };

            sm = new ConversationStateMachine({
                voiceController: mockVoiceController,
                taskCoordinator: mockTaskCoordinator,
                companionBridge: mockCompanionBridge,
                continuousConversation: true,
                followUpTimeoutMs: 250, // short for testing
                bargeInEnabled: true
            });
        });

        afterEach(() => {
            sm.cancel();
        });

        test('starts in STANDBY state with initial metrics', () => {
            const state = sm.getState();
            assert.strictEqual(state.state, CONVERSATION_STATES.STANDBY);
            assert.strictEqual(state.turnCount, 0);
            assert.strictEqual(state.continuousConversation, true);
        });

        test('full conversational cycle: Wake word → Listening → SpeechEnd → Transcribe → Understand → Speak → Follow-up', async () => {
            const transitions = [];
            sm.on('stateTransition', ({ from, to }) => {
                transitions.push(`${from}->${to}`);
            });

            // Step 1: Wake word trigger
            await sm.handleWakeWord({ keyword: 'hey lucy', confidence: 0.95 });
            assert.strictEqual(sm.state, CONVERSATION_STATES.LISTENING);

            // Step 2: Speech arrives and finishes via VAD
            const speechSamples = generateSpeechChunk(0.2, 16000, 350, 0.3);
            await sm._handleSpeechEnd(speechSamples);

            // Verifies understanding execution
            assert.strictEqual(mockTaskCoordinator.requests.length, 1);
            assert.strictEqual(mockTaskCoordinator.requests[0].text, 'What is the weather today?');

            // Verifies response speech
            assert.strictEqual(mockVoiceController.spokenTexts.length, 1);
            assert.ok(mockVoiceController.spokenTexts[0].includes('crystal clear'));

            // Step 7: Returns to follow-up listening
            assert.strictEqual(sm.state, CONVERSATION_STATES.FOLLOW_UP_LISTENING);
            assert.strictEqual(sm.turnCount, 1);

            // Wait for follow-up timer to expire
            await new Promise((r) => setTimeout(r, 300));
            assert.strictEqual(sm.state, CONVERSATION_STATES.STANDBY);
        });

        test('multi-turn conversational follow-up without re-triggering wake word', async () => {
            // First turn
            await sm.handleWakeWord({ keyword: 'hey lucy' });
            await sm._handleSpeechEnd(generateSpeechChunk(0.1, 16000));

            assert.strictEqual(sm.state, CONVERSATION_STATES.FOLLOW_UP_LISTENING);
            assert.strictEqual(sm.turnCount, 1);

            // Second turn: user speaks directly during follow-up window
            mockVoiceController.transcribeAudio = async () => ({ ok: true, transcript: 'And what time is sunset?' });
            mockTaskCoordinator.executeRequest = async () => ({ ok: true, replyText: 'Sunset is at 6:42 PM.' });

            // VAD detects speech in follow-up
            sm.vad.emit('speechStart');
            assert.strictEqual(sm.state, CONVERSATION_STATES.LISTENING);

            await sm._handleSpeechEnd(generateSpeechChunk(0.1, 16000));
            assert.strictEqual(sm.turnCount, 2);
            assert.strictEqual(mockVoiceController.spokenTexts.length, 2);
            assert.ok(mockVoiceController.spokenTexts[1].includes('6:42 PM'));
        });

        test('companion bridge emotions synchronize with conversation states', async () => {
            await sm.handleWakeWord({ keyword: 'hey lucy' });
            assert.ok(mockCompanionBridge.emotions.some(e => e.emotion === 'listening'));

            await sm._handleSpeechEnd(generateSpeechChunk(0.1, 16000));
            assert.ok(mockCompanionBridge.emotions.some(e => e.emotion === 'thinking'));
            assert.ok(mockCompanionBridge.emotions.some(e => e.emotion === 'speaking'));
        });

        test('explicitly distinguishes all 11 runtime conversation states', () => {
            const expectedStates = [
                'idle',
                'wake_word_active',
                'listening',
                'transcribing',
                'waiting_ai',
                'synthesizing',
                'speaking',
                'interrupted',
                'waiting_next_utterance',
                'recovering',
                'unavailable'
            ];

            for (const expected of expectedStates) {
                sm.transitionTo(expected, { test: true });
                assert.strictEqual(sm.state, expected);
            }

            // Verify invalid state throws fail-closed error
            assert.throws(() => {
                sm.transitionTo('non_existent_state');
            }, /Invalid conversation state/);
        });

        test('transitions to UNAVAILABLE when microphone or hardware is missing with text fallback', () => {
            let emittedTransition = null;
            sm.on('stateTransition', (evt) => { emittedTransition = evt; });

            sm.transitionTo(CONVERSATION_STATES.UNAVAILABLE, { reason: 'No microphone detected' });
            assert.strictEqual(sm.state, CONVERSATION_STATES.UNAVAILABLE);
            assert.strictEqual(emittedTransition.to, 'unavailable');
            assert.strictEqual(emittedTransition.reason, 'No microphone detected');

            // Companion visual state updates appropriately
            assert.ok(mockCompanionBridge.emotions.some(e => e.emotion === 'sleepy'));
        });
    });

    describe('3. Barge-In Interruption & Anti-Echo Suppression', () => {
        let sm;
        let mockVoiceController;

        beforeEach(() => {
            mockVoiceController = {
                ttsEnabled: true,
                isSpeaking: true,
                stoppedCount: 0,
                stopSpeaking: function() {
                    this.isSpeaking = false;
                    this.stoppedCount++;
                },
                speakResponse: async function() { return true; }
            };

            sm = new ConversationStateMachine({
                voiceController: mockVoiceController,
                bargeInEnabled: true,
                continuousConversation: true
            });
        });

        test('barge-in interrupts active speech playback immediately', () => {
            sm.transitionTo(CONVERSATION_STATES.SPEAKING);
            sm.lastPlaybackEndTime = 0; // well outside cooldown

            // Simulate incoming loud speech audio frame
            const loudFrame = generateSpeechChunk(0.05, 16000, 300, 0.4);
            sm.processAudioFrame(loudFrame);

            assert.strictEqual(mockVoiceController.stoppedCount, 1);
            assert.strictEqual(sm.state, CONVERSATION_STATES.LISTENING);
        });

        test('anti-echo cooldown blocks false barge-in immediately after speech playback', () => {
            sm.transitionTo(CONVERSATION_STATES.SPEAKING);
            sm.lastPlaybackEndTime = Date.now(); // active cooldown (< 350ms)

            const loudFrame = generateSpeechChunk(0.05, 16000, 300, 0.4);
            sm.processAudioFrame(loudFrame);

            // Should NOT have interrupted due to anti-echo protection
            assert.strictEqual(mockVoiceController.stoppedCount, 0);
            assert.strictEqual(sm.state, CONVERSATION_STATES.SPEAKING);
        });

        test('barge-in aborts in-flight coordinator request via AbortController', async () => {
            sm.transitionTo(CONVERSATION_STATES.SPEAKING);
            let aborted = false;

            sm.activeAbortController = new AbortController();
            sm.activeAbortController.signal.addEventListener('abort', () => {
                aborted = true;
            });

            sm.interrupt('User barge-in');
            assert.strictEqual(aborted, true);
        });
    });

    describe('4. Verbal Confirmation Gates for Consequential Tools', () => {
        let sm;
        let mockVoiceController;

        beforeEach(() => {
            mockVoiceController = {
                ttsEnabled: true,
                spokenTexts: [],
                speakResponse: async function(text) {
                    this.spokenTexts.push(text);
                    return true;
                }
            };

            sm = new ConversationStateMachine({
                voiceController: mockVoiceController,
                continuousConversation: true
            });
        });

        test('requests confirmation, speaks question and waits in WAITING_CONFIRMATION state', async () => {
            await sm.requestConfirmation({
                auditId: 'audit_441',
                toolId: 'file_write',
                action: 'Overwrite report.txt',
                question: 'Are you sure you want to overwrite report.txt?'
            });

            assert.strictEqual(sm.state, CONVERSATION_STATES.WAITING_CONFIRMATION);
            assert.strictEqual(mockVoiceController.spokenTexts.length, 1);
            assert.ok(mockVoiceController.spokenTexts[0].includes('overwrite report.txt'));
            assert.strictEqual(sm.pendingConfirmation.auditId, 'audit_441');
        });

        test('resolves confirmation approved: true on affirmative verbal answers ("yes", "proceed")', async () => {
            sm.requestConfirmation({
                auditId: 'audit_442',
                toolId: 'desktop_click',
                question: 'Confirm desktop action?'
            });

            let resolution = null;
            sm.on('confirmationResolved', (res) => { resolution = res; });

            await sm._handleSpeechEnd(generateSpeechChunk(0.1, 16000));
            // Simulate transcription returning "yes, please proceed"
            await sm._handleConfirmationAnswer('yes, please proceed');

            assert.strictEqual(resolution.approved, true);
            assert.strictEqual(resolution.auditId, 'audit_442');
            assert.ok(mockVoiceController.spokenTexts.some(t => t.includes('Confirmed')));
        });

        test('resolves confirmation approved: false on negative verbal answers ("no", "cancel")', async () => {
            sm.requestConfirmation({
                auditId: 'audit_443',
                toolId: 'file_delete',
                question: 'Confirm file deletion?'
            });

            let resolution = null;
            sm.on('confirmationResolved', (res) => { resolution = res; });

            await sm._handleConfirmationAnswer('no, do not delete it');

            assert.strictEqual(resolution.approved, false);
            assert.strictEqual(resolution.auditId, 'audit_443');
            assert.ok(mockVoiceController.spokenTexts.some(t => t.includes('cancelled')));
        });

        test('prompts clarification on ambiguous answers without leaking approval', async () => {
            sm.requestConfirmation({
                auditId: 'audit_444',
                toolId: 'file_delete',
                question: 'Delete file?'
            });

            let resolution = null;
            sm.on('confirmationResolved', (res) => { resolution = res; });

            await sm._handleConfirmationAnswer('maybe later today');

            assert.strictEqual(resolution, null, 'Did not approve or deny ambiguous answer');
            assert.strictEqual(sm.state, CONVERSATION_STATES.WAITING_CONFIRMATION);
            assert.ok(mockVoiceController.spokenTexts.some(t => t.includes('say yes to proceed, or no to cancel')));
        });
    });

    describe('5. Streaming Sentence-Level TTS and VoiceController Integration', () => {
        let vc;

        beforeEach(() => {
            vc = new VoiceController({
                ttsEnabled: true,
                enableVad: true,
                continuousConversation: true,
                bargeInEnabled: true
            });
        });

        afterEach(() => {
            vc.dispose();
        });

        test('VoiceController exposes VAD status and configuration controls', () => {
            const vadStatus = vc.getVadStatus();
            assert.strictEqual(vadStatus.enabled, true);
            assert.strictEqual(vadStatus.sensitivity, 'normal');

            vc.setVadSensitivity('high');
            assert.strictEqual(vc.getVadStatus().sensitivity, 'high');

            vc.setContinuousConversation(false);
            assert.strictEqual(vc.continuousConversation, false);

            vc.setBargeInEnabled(false);
            assert.strictEqual(vc.bargeInEnabled, false);
        });

        test('createStreamingSpeaker accumulates tokens and splits by sentence boundary', async () => {
            const spoken = [];
            vc.speakResponse = async (text) => {
                spoken.push(text);
                return true;
            };

            const speaker = vc.createStreamingSpeaker();

            // Stream tokens
            speaker.feed('Hello there! ');
            speaker.feed('I am Lucy, your celestial assistant. ');
            speaker.feed('Let us begin working together.');
            await speaker.flush();

            assert.ok(spoken.length >= 2, `Expected at least 2 spoken sentences, got ${spoken.length}`);
            assert.ok(spoken[0].includes('Hello there'));
            assert.ok(spoken.some(s => s.includes('celestial assistant')));
        });

        test('createStreamingSpeaker cancels pending speech queue cleanly', async () => {
            let stopped = false;
            vc.stopSpeaking = () => { stopped = true; };

            const speaker = vc.createStreamingSpeaker();
            speaker.feed('This is a test sentence that should not be spoken.');
            speaker.cancel();

            assert.strictEqual(stopped, true);
        });

        test('clean resource disposal terminates VAD and resets all timers', () => {
            vc.startListening();
            assert.ok(vc.isListening || vc.activeRecognitionEngine);

            vc.dispose();
            assert.strictEqual(vc.isListening, false);
            assert.strictEqual(vc.isSpeaking, false);
            assert.strictEqual(vc.vad.isActive, false);
        });
    });
});
