'use strict';

/**
 * Unified Voice Controller for L.U.C.Y.
 * Integrates SpeechRecognition and SpeechSynthesis with the companion familiar
 * and task coordinator.
 * 
 * Guarantees:
 * 1. Explicit start/stop controls (push-to-talk / toggle).
 * 2. Instant playback cancellation (Stop Voice button).
 * 3. Text chat remains 100% operational if voice fails or is disabled (fail-open to text).
 * 4. Zero multi-GB downloads, zero cloud audio streaming without consent.
 */

const _createSpeechRecognition = (typeof require !== 'undefined')
    ? require('./speech-recognition.js').createSpeechRecognition
    : (typeof window !== 'undefined' ? window.createSpeechRecognition : globalThis.createSpeechRecognition);

const _createSpeechSynthesis = (typeof require !== 'undefined')
    ? require('./speech-synthesis.js').createSpeechSynthesis
    : (typeof window !== 'undefined' ? window.createSpeechSynthesis : globalThis.createSpeechSynthesis);

const _WhisperEngine = (typeof require !== 'undefined')
    ? require('./whisper-recognition.js').WhisperOfflineRecognitionEngine
    : (typeof window !== 'undefined' ? window.WhisperOfflineRecognitionEngine : null);

const _WakeWordEngine = (typeof require !== 'undefined')
    ? require('./wake-word-engine.js').WakeWordEngine
    : (typeof window !== 'undefined' ? window.WakeWordEngine : null);

const VOICE_STATES = Object.freeze({
    IDLE: 'idle',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
    ERROR: 'error'
});

class VoiceController {
    constructor({
        globalScope = (typeof globalThis !== 'undefined' ? globalThis : null),
        onStateChange = () => {},
        onInterimTranscript = () => {},
        onFinalTranscript = () => {},
        onError = () => {},
        onWakeWord = () => {},
        ttsEnabled = true,
        language = 'en-US',
        wakeWordEnabled = false,
        whisperConfig = {}
    } = {}) {
        this.globalScope = globalScope;
        this.onStateChange = onStateChange;
        this.onInterimTranscript = onInterimTranscript;
        this.onFinalTranscript = onFinalTranscript;
        this.onError = onError;
        this.voiceState = VOICE_STATES.IDLE;
        this.ttsEnabled = Boolean(ttsEnabled);
        this.currentSpeechId = 0;

        // Initialize Speech Recognition
        const makeRecognition = _createSpeechRecognition || (globalScope ? globalScope.createSpeechRecognition : null);
        this.recognition = makeRecognition ? makeRecognition({
            globalScope,
            language,
            onStateChange: ({ state }) => {
                if (state === 'listening') {
                    this.setVoiceState(VOICE_STATES.LISTENING);
                } else if (state === 'processing') {
                    this.setVoiceState(VOICE_STATES.PROCESSING);
                } else if (state === 'idle' && this.voiceState !== VOICE_STATES.SPEAKING && this.voiceState !== VOICE_STATES.ERROR) {
                    this.setVoiceState(VOICE_STATES.IDLE);
                }
            },
            onInterimResult: ({ transcript }) => {
                this.onInterimTranscript(transcript);
            },
            onFinalResult: ({ transcript }) => {
                this.onFinalTranscript(transcript);
                // Return to idle after transcription finishes
                this.setVoiceState(VOICE_STATES.IDLE);
            },
            onError: (err) => {
                this.setVoiceState(VOICE_STATES.ERROR, { error: err });
                this.onError(err);
            }
        }) : { supported: false, state: 'idle', isListening: false, start: () => false, stop: () => false, cancel: () => false };

        // Initialize Speech Synthesis
        const makeSynthesis = _createSpeechSynthesis || (globalScope ? globalScope.createSpeechSynthesis : null);
        this.synthesis = makeSynthesis ? makeSynthesis({
            globalScope,
            onStateChange: ({ state, text }) => {
                if (state === 'speaking') {
                    this.setVoiceState(VOICE_STATES.SPEAKING, { text });
                } else if (state === 'idle' && this.voiceState === VOICE_STATES.SPEAKING) {
                    this.setVoiceState(VOICE_STATES.IDLE);
                }
            },
            onError: (err) => {
                this.onError(err);
                if (this.voiceState === VOICE_STATES.SPEAKING) {
                    this.setVoiceState(VOICE_STATES.IDLE);
                }
            }
        }) : { supported: false, isSpeaking: false, speak: async () => false, stop: () => {} };
        this.synthesis.enabled = this.ttsEnabled;

        // Initialize Wake-Word Engine (opt-in privacy default)
        this.wakeWordEngine = _WakeWordEngine ? new _WakeWordEngine({
            enabled: Boolean(wakeWordEnabled)
        }) : null;

        if (this.wakeWordEngine) {
            this.wakeWordEngine.on('wakeWordDetected', (res) => {
                if (typeof onWakeWord === 'function') {
                    onWakeWord(res);
                }
                this.startListening();
            });
        }

        // Initialize Offline Whisper Recognition Engine
        this.whisperEngine = _WhisperEngine ? new _WhisperEngine(whisperConfig) : null;
    }

    get isRecognitionSupported() {
        return this.recognition.supported;
    }

    get isSynthesisSupported() {
        return this.synthesis.supported;
    }

    get isListening() {
        return this.voiceState === VOICE_STATES.LISTENING;
    }

    get isSpeaking() {
        return this.voiceState === VOICE_STATES.SPEAKING;
    }

    setVoiceState(nextState, detail = {}) {
        this.voiceState = nextState;
        this.onStateChange({ voiceState: nextState, ...detail });
    }

    /**
     * Start microphone listening (Push-to-talk).
     * Rejects duplicate sessions if already listening.
     */
    startListening() {
        if (this.isListening) {
            return false;
        }
        // If speaking, interrupt speech first
        if (this.isSpeaking) {
            this.stopSpeaking();
        }
        return this.recognition.start();
    }

    /**
     * Stop microphone listening.
     */
    stopListening() {
        return this.recognition.stop();
    }

    /**
     * Cancel listening without transcribing.
     */
    cancelListening() {
        return this.recognition.cancel();
    }

    /**
     * Toggle microphone listening.
     */
    toggleListening() {
        if (this.isListening) {
            return this.stopListening();
        }
        return this.startListening();
    }

    /**
     * Speak response text via TTS with sequence protection against stale responses.
     * @param {string} text 
     * @param {object} [options]
     * @returns {Promise<boolean>}
     */
    async speakResponse(text, options = {}) {
        if (!this.ttsEnabled) {
            return false;
        }
        if (this.isListening) {
            return false;
        }
        if (this.wakeWordEngine) {
            this.wakeWordEngine.pause();
        }
        const speechId = ++this.currentSpeechId;
        try {
            const res = await this.synthesis.speak(text, options);
            if (speechId !== this.currentSpeechId) {
                return false;
            }
            return res;
        } finally {
            if (this.wakeWordEngine) {
                this.wakeWordEngine.resume();
            }
        }
    }

    /**
     * Cancel and stop speech playback immediately, invalidating pending speech calls.
     */
    stopSpeaking() {
        this.currentSpeechId++;
        this.synthesis.stop();
        if (this.wakeWordEngine) {
            this.wakeWordEngine.resume();
        }
        if (this.voiceState === VOICE_STATES.SPEAKING) {
            this.setVoiceState(VOICE_STATES.IDLE);
        }
    }

    /**
     * Toggle TTS audio output on/off.
     */
    toggleTts() {
        this.ttsEnabled = !this.ttsEnabled;
        this.synthesis.enabled = this.ttsEnabled;
        if (!this.ttsEnabled && this.isSpeaking) {
            this.stopSpeaking();
        }
        return this.ttsEnabled;
    }

    setVoiceConfig(config = {}) {
        if (config.ttsEnabled !== undefined) {
            this.ttsEnabled = Boolean(config.ttsEnabled);
            this.synthesis.enabled = this.ttsEnabled;
            if (!this.ttsEnabled && this.isSpeaking) {
                this.stopSpeaking();
            }
        }
        if (typeof this.synthesis.setVoiceConfig === 'function') {
            this.synthesis.setVoiceConfig(config);
        }
        return this.getVoiceConfig();
    }

    getVoiceConfig() {
        const synthConfig = typeof this.synthesis.getVoiceConfig === 'function'
            ? this.synthesis.getVoiceConfig()
            : {};
        return {
            ...synthConfig,
            ttsEnabled: this.ttsEnabled
        };
    }

    resetToDefaults() {
        this.ttsEnabled = true;
        if (typeof this.synthesis.resetToDefaults === 'function') {
            this.synthesis.resetToDefaults();
        }
        return this.getVoiceConfig();
    }

    resetState() {
        this.setVoiceState(VOICE_STATES.IDLE);
    }

    async getAvailableVoices() {
        if (typeof this.synthesis.getAvailableVoices === 'function') {
            return await this.synthesis.getAvailableVoices();
        }
        return [];
    }

    getWakeWordStatus() {
        return this.wakeWordEngine ? this.wakeWordEngine.getPrivacyState() : { enabled: false, supported: false };
    }

    setWakeWordEnabled(enabled) {
        if (!this.wakeWordEngine) return false;
        if (enabled) {
            this.wakeWordEngine.enable();
        } else {
            this.wakeWordEngine.disable();
        }
        return this.wakeWordEngine.enabled;
    }

    getWhisperStatus() {
        return this.whisperEngine ? this.whisperEngine.getStatus() : { engine: 'whisper.cpp', isAvailable: false };
    }

    dispose() {
        this.cancelListening();
        this.stopSpeaking();
        if (this.wakeWordEngine && typeof this.wakeWordEngine.dispose === 'function') {
            this.wakeWordEngine.dispose();
        }
        if (this.recognition && typeof this.recognition.dispose === 'function') {
            this.recognition.dispose();
        }
    }
}

function createVoiceController(options = {}) {
    return new VoiceController(options);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VOICE_STATES,
        VoiceController,
        createVoiceController
    };
}

if (typeof window !== 'undefined') {
    window.VOICE_STATES = VOICE_STATES;
    window.VoiceController = VoiceController;
    window.createVoiceController = createVoiceController;
}
