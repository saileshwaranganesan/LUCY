'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanTextForSpeech } = require('../../src/voice/speech-text-cleaner.js');
const {
    createSpeechRecognition,
    getSpeechRecognitionErrorMessage
} = require('../../src/voice/speech-recognition.js');
const {
    SpeechSynthesisService
} = require('../../src/voice/speech-synthesis.js');
const {
    VoiceController,
    VOICE_STATES
} = require('../../src/voice/voice-controller.js');

// Mock SpeechRecognition for testing
class MockSpeechRecognition {
    static instances = [];

    constructor() {
        MockSpeechRecognition.instances.push(this);
        this.started = false;
        this.stopped = false;
        this.aborted = false;
        this.lang = 'en-US';
        this.continuous = false;
        this.interimResults = true;
    }

    start() {
        this.started = true;
        this.onstart?.();
    }

    stop() {
        this.stopped = true;
    }

    abort() {
        this.aborted = true;
        this.onend?.();
    }
}

// Mock SpeechSynthesis and Utterance for testing
class MockSpeechSynthesisUtterance {
    constructor(text) {
        this.text = text;
        this.voice = null;
        this.lang = 'en-US';
        this.rate = 1.0;
        this.pitch = 1.0;
        this.volume = 1.0;
        this.onstart = null;
        this.onboundary = null;
        this.onend = null;
        this.onerror = null;
    }
}

class MockSpeechSynthesis {
    constructor() {
        this.speaking = false;
        this.currentUtterance = null;
        this.canceled = false;
        this.voices = [
            { name: 'Microsoft Zira Desktop - English (United States)', lang: 'en-US', default: true },
            { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US', default: false }
        ];
    }

    getVoices() {
        return this.voices;
    }

    speak(utterance) {
        this.canceled = false;
        this.speaking = true;
        this.currentUtterance = utterance;
        setTimeout(() => {
            if (!this.canceled && utterance.onstart) {
                utterance.onstart();
            }
            setTimeout(() => {
                if (!this.canceled && utterance.onend) {
                    this.speaking = false;
                    utterance.onend();
                }
            }, 20);
        }, 10);
    }

    cancel() {
        this.canceled = true;
        this.speaking = false;
        if (this.currentUtterance && this.currentUtterance.onerror) {
            this.currentUtterance.onerror({ error: 'canceled' });
        }
        this.currentUtterance = null;
    }
}

test('Voice Sanitizer: Strips markdown, code blocks, URLs, and paths before TTS', () => {
    const rawMarkdown = `
# System Status Report
I have reviewed your request. Here is the script:
\`\`\`javascript
const secret = "do_not_read_me_aloud";
console.log(secret);
\`\`\`
Check the file at C:\\Users\\admin\\Desktop\\LUCY\\data.json or https://github.com/lucy/assistant for details.
**Result:** Complete! ✨
    `;

    const cleaned = cleanTextForSpeech(rawMarkdown);
    assert.doesNotMatch(cleaned, /do_not_read_me_aloud/);
    assert.doesNotMatch(cleaned, /console\.log/);
    assert.doesNotMatch(cleaned, /https:\/\//);
    assert.doesNotMatch(cleaned, /C:\\Users\\admin/);
    assert.doesNotMatch(cleaned, /#{1,6}/);
    assert.match(cleaned, /System Status Report/);
    assert.match(cleaned, /Complete!/);
});

test('SpeechRecognition: Push-to-talk start/stop and transcription forwarding', async () => {
    MockSpeechRecognition.instances = [];
    const states = [];
    const interimResults = [];
    const finalResults = [];

    const recognition = createSpeechRecognition({
        globalScope: { SpeechRecognition: MockSpeechRecognition },
        onStateChange: ({ state }) => states.push(state),
        onInterimResult: ({ transcript }) => interimResults.push(transcript),
        onFinalResult: ({ transcript }) => finalResults.push(transcript)
    });

    assert.equal(recognition.supported, true);
    assert.equal(recognition.state, 'idle');

    // Start listening
    const started = recognition.start();
    assert.equal(started, true);
    assert.equal(recognition.isListening, true);
    assert.deepEqual(states, ['starting', 'listening']);

    const instance = MockSpeechRecognition.instances[0];
    assert.ok(instance);

    // Simulate interim transcript
    instance.onresult({
        resultIndex: 0,
        results: [[{ transcript: 'open the browser' }]]
    });
    assert.deepEqual(interimResults, ['open the browser']);

    // Stop listening (transitions to processing)
    const stopped = recognition.stop();
    assert.equal(stopped, true);
    assert.equal(recognition.state, 'processing');

    // Simulate final result after stop
    const finalEventResult = [{ transcript: 'open the browser please' }];
    finalEventResult.isFinal = true;
    instance.onresult({
        resultIndex: 0,
        results: [finalEventResult]
    });
    instance.onend();

    assert.deepEqual(finalResults, ['open the browser please']);
    assert.equal(recognition.state, 'idle');
});

test('SpeechRecognition: Explains missing microphone and denied permission gracefully', () => {
    assert.match(getSpeechRecognitionErrorMessage({ error: 'not-allowed' }), /Microphone permission was denied/);
    assert.match(getSpeechRecognitionErrorMessage({ error: 'audio-capture' }), /No microphone device was detected/);
    assert.match(getSpeechRecognitionErrorMessage({ error: 'no-speech' }), /No speech was detected/);

    const errors = [];
    const recognition = createSpeechRecognition({
        globalScope: {}, // No SpeechRecognition constructor available
        onError: (err) => errors.push(err)
    });

    assert.equal(recognition.supported, false);
    const startResult = recognition.start();
    assert.equal(startResult, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error, 'unsupported');
});

test('SpeechSynthesis: Natural voice selection, playback, and instant cancellation', async () => {
    const mockSynth = new MockSpeechSynthesis();
    const states = [];

    const synthService = new SpeechSynthesisService({
        globalScope: {
            speechSynthesis: mockSynth,
            SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
        },
        onStateChange: ({ state }) => states.push(state)
    });

    assert.equal(synthService.supported, true);

    // Test voice selection prefers English female voice (Zira)
    const bestVoice = await synthService.selectBestVoice();
    assert.ok(bestVoice);
    assert.match(bestVoice.name, /Zira/);

    // Test speak execution
    const speakPromise = synthService.speak('Hello! I am Lucy, your desktop assistant.');
    assert.ok(speakPromise);
    const result = await speakPromise;
    assert.equal(result, true);
    assert.ok(states.includes('speaking'));
    assert.equal(synthService.state, 'idle');

    // Test immediate cancellation / stop
    const longSpeakPromise = synthService.speak('This is a longer message that will be interrupted.');
    synthService.stop();
    assert.equal(synthService.isSpeaking, false);
    assert.equal(mockSynth.canceled, true);
});

test('VoiceController: Coordinates listening, speaking, interruption, and text fallback', async () => {
    MockSpeechRecognition.instances = [];
    const mockSynth = new MockSpeechSynthesis();
    const stateTransitions = [];
    let recognizedText = '';
    const errors = [];

    const controller = new VoiceController({
        globalScope: {
            SpeechRecognition: MockSpeechRecognition,
            speechSynthesis: mockSynth,
            SpeechSynthesisUtterance: MockSpeechSynthesisUtterance
        },
        onStateChange: ({ voiceState }) => stateTransitions.push(voiceState),
        onFinalTranscript: (text) => { recognizedText = text; },
        onError: (err) => errors.push(err)
    });

    assert.equal(controller.voiceState, VOICE_STATES.IDLE);

    // 1. Test microphone toggle start -> listening
    controller.toggleListening();
    assert.equal(controller.isListening, true);
    assert.ok(stateTransitions.includes(VOICE_STATES.LISTENING));

    // 2. Simulate user speaking
    const recInstance = MockSpeechRecognition.instances[0];
    const finalSpeech = [{ transcript: 'check system status' }];
    finalSpeech.isFinal = true;
    recInstance.onresult({
        resultIndex: 0,
        results: [finalSpeech]
    });
    recInstance.onend();

    assert.equal(recognizedText, 'check system status');
    assert.equal(controller.voiceState, VOICE_STATES.IDLE);

    // 3. Test assistant speaking response
    const speakTask = controller.speakResponse('System status is optimal and verified.');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(controller.isSpeaking, true);
    assert.ok(stateTransitions.includes(VOICE_STATES.SPEAKING));

    // 4. Test explicit interruption / Stop Voice button
    controller.stopSpeaking();
    assert.equal(controller.isSpeaking, false);
    assert.equal(controller.voiceState, VOICE_STATES.IDLE);

    // 5. Test TTS toggle (Mute / Unmute)
    const isNowMuted = !controller.toggleTts();
    assert.equal(controller.ttsEnabled, false);
    const mutedResult = await controller.speakResponse('This should not play because TTS is muted.');
    assert.equal(mutedResult, false);

    // 6. Test text-only fallback resilience: Speech errors do not break controller
    controller.startListening();
    const secondRecInstance = MockSpeechRecognition.instances[1];
    secondRecInstance.onerror({ error: 'audio-capture' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error, 'audio-capture');
    assert.equal(controller.voiceState, VOICE_STATES.ERROR);
});
