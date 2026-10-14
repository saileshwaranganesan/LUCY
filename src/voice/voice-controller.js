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

const _createAudioRecorder = (typeof require !== 'undefined')
    ? require('./audio-recorder.js').createAudioRecorder
    : (typeof window !== 'undefined' ? window.createAudioRecorder : null);

const VOICE_STATES = Object.freeze({
    IDLE: 'idle',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
    ERROR: 'error'
});

const RECOGNITION_MODES = Object.freeze({
    AUTO: 'auto',
    OFFLINE: 'offline',
    WEB_SPEECH: 'web-speech'
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
        wakeWordConfig = {},
        recognitionMode = RECOGNITION_MODES.AUTO,
        audioRecorder = null,
        whisperEngine = null,
        whisperConfig = {}
    } = {}) {
        this.globalScope = globalScope;
        this.onStateChange = onStateChange;
        this.onInterimTranscript = onInterimTranscript;
        this.onFinalTranscript = onFinalTranscript;
        this.onError = onError;
        this.onWakeWord = onWakeWord;
        this.voiceState = VOICE_STATES.IDLE;
        this.ttsEnabled = Boolean(ttsEnabled);
        this.currentSpeechId = 0;
        this.recognitionMode = recognitionMode;
        this.activeRecognitionEngine = 'web-speech'; // 'whisper' | 'web-speech'
        this.transcriptionAbortController = null;
        this._cachedWhisperStatus = null;
        this._isWakeWordCapturing = false;

        // Initialize Speech Recognition (Web Speech API fallback)
        const makeRecognition = _createSpeechRecognition || (globalScope ? globalScope.createSpeechRecognition : null);
        this.recognition = makeRecognition ? makeRecognition({
            globalScope,
            language,
            onStateChange: ({ state }) => {
                if (this.activeRecognitionEngine === 'whisper') return;
                if (state === 'listening') {
                    this.setVoiceState(VOICE_STATES.LISTENING);
                } else if (state === 'processing') {
                    this.setVoiceState(VOICE_STATES.PROCESSING);
                } else if (state === 'idle' && this.voiceState !== VOICE_STATES.SPEAKING && this.voiceState !== VOICE_STATES.ERROR) {
                    this.setVoiceState(VOICE_STATES.IDLE);
                }
            },
            onInterimResult: ({ transcript }) => {
                if (this.activeRecognitionEngine === 'whisper') return;
                this.onInterimTranscript(transcript);
            },
            onFinalResult: ({ transcript }) => {
                if (this.activeRecognitionEngine === 'whisper') return;
                this.onFinalTranscript(transcript);
                this.setVoiceState(VOICE_STATES.IDLE);
            },
            onError: (err) => {
                if (this.activeRecognitionEngine === 'whisper') return;
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

        // Initialize Offline Whisper Recognition Engine
        if (whisperEngine) {
            this.whisperEngine = whisperEngine;
        } else if (_WhisperEngine) {
            this.whisperEngine = new _WhisperEngine(whisperConfig);
        } else if (globalScope && globalScope.lucyIpc && typeof globalScope.lucyIpc.transcribeAudio === 'function') {
            // Electron renderer IPC bridge
            this.whisperEngine = {
                isAvailable: () => Boolean(this._cachedWhisperStatus?.isAvailable ?? true),
                getStatus: () => (this._cachedWhisperStatus || { engine: 'whisper.cpp', isAvailable: true }),
                transcribeAudio: (buf, opts) => globalScope.lucyIpc.transcribeAudio(buf, opts)
            };
            if (typeof globalScope.lucyIpc.getWhisperStatus === 'function') {
                globalScope.lucyIpc.getWhisperStatus().then((st) => {
                    this._cachedWhisperStatus = st;
                }).catch(() => {});
            }
        } else {
            this.whisperEngine = null;
        }

        // Initialize Audio Recorder for offline microphone capture and continuous wake-word streaming
        const makeAudioRecorder = audioRecorder || _createAudioRecorder;
        this.audioRecorder = (typeof makeAudioRecorder === 'function')
            ? makeAudioRecorder({
                globalScope,
                onStreamEnd: () => {
                    this._stopWakeWordCapture();
                }
            })
            : (audioRecorder || null);

        // Initialize Wake-Word Engine (opt-in privacy default)
        const wwOpts = {
            enabled: Boolean(wakeWordEnabled),
            whisperEngine: this.whisperEngine,
            ...wakeWordConfig
        };
        this.wakeWordEngine = _WakeWordEngine ? new _WakeWordEngine(wwOpts) : null;

        if (this.wakeWordEngine) {
            this.wakeWordEngine.on('wakeWordDetected', (res) => {
                if (typeof this.onWakeWord === 'function') {
                    this.onWakeWord(res);
                }
                this.startListening();
            });
            if (this.wakeWordEngine.enabled) {
                this._syncWakeWordCapture();
            }
        }
    }

    get isRecognitionSupported() {
        if (this.recognitionMode === RECOGNITION_MODES.OFFLINE) {
            return this.isWhisperAvailable();
        }
        return this.recognition.supported || this.isWhisperAvailable();
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
        if (nextState === VOICE_STATES.IDLE) {
            if (this.wakeWordEngine && this.wakeWordEngine.isPaused && !this.isSpeaking) {
                this.wakeWordEngine.resume();
            }
            this._syncWakeWordCapture();
        } else if (this.wakeWordEngine && !this.wakeWordEngine.isPaused) {
            this.wakeWordEngine.pause();
        }
    }

    setRecognitionMode(mode) {
        if (!Object.values(RECOGNITION_MODES).includes(mode)) {
            throw new Error(`Invalid recognition mode: '${mode}'. Supported modes: ${Object.values(RECOGNITION_MODES).join(', ')}`);
        }
        this.recognitionMode = mode;
        return this.recognitionMode;
    }

    getRecognitionMode() {
        return this.recognitionMode;
    }

    isWhisperAvailable() {
        if (!this.whisperEngine) return false;
        if (typeof this.whisperEngine.isAvailable === 'function') {
            return this.whisperEngine.isAvailable();
        }
        if (this._cachedWhisperStatus) {
            return Boolean(this._cachedWhisperStatus.isAvailable);
        }
        return false;
    }

    /**
     * Start microphone listening (Push-to-talk).
     * Automatically routes to whisper.cpp offline engine or Web Speech API based on mode.
     */
    startListening() {
        if (this.isListening) {
            return false;
        }
        if (this.isSpeaking) {
            this.stopSpeaking();
        }
        if (this.wakeWordEngine) {
            this.wakeWordEngine.pause();
        }

        const isOfflineAvailable = this.isWhisperAvailable();
        const hasRecorderSupport = Boolean(this.audioRecorder && this.audioRecorder.supported !== false);

        // Strict offline mode validation: never silently fall back to cloud if offline was explicitly requested
        if (this.recognitionMode === RECOGNITION_MODES.OFFLINE) {
            if (!isOfflineAvailable) {
                const err = new Error('Offline speech recognition is unavailable: whisper.cpp binary or model weights not detected.');
                err.code = 'OFFLINE_UNAVAILABLE';
                this.setVoiceState(VOICE_STATES.ERROR, { error: err });
                this.onError(err);
                return false;
            }
        }

        // Determine active engine
        const shouldUseOffline = (this.recognitionMode === RECOGNITION_MODES.OFFLINE) ||
            (this.recognitionMode === RECOGNITION_MODES.AUTO && isOfflineAvailable && hasRecorderSupport);

        if (shouldUseOffline) {
            this.activeRecognitionEngine = 'whisper';
            this.setVoiceState(VOICE_STATES.LISTENING);

            if (this.audioRecorder && typeof this.audioRecorder.start === 'function') {
                Promise.resolve(this.audioRecorder.start()).catch((err) => {
                    this.setVoiceState(VOICE_STATES.ERROR, { error: err });
                    this.onError(err);
                });
            }
            return true;
        } else {
            this.activeRecognitionEngine = 'web-speech';
            return this.recognition.start();
        }
    }

    /**
     * Stop microphone listening.
     */
    stopListening() {
        if (this.activeRecognitionEngine === 'whisper') {
            if (this.voiceState !== VOICE_STATES.LISTENING) {
                return false;
            }
            this.setVoiceState(VOICE_STATES.PROCESSING);

            const recordPromise = (this.audioRecorder && typeof this.audioRecorder.stop === 'function')
                ? Promise.resolve(this.audioRecorder.stop())
                : Promise.resolve(null);

            recordPromise.then((audioBuffer) => {
                if (!audioBuffer) {
                    this.setVoiceState(VOICE_STATES.IDLE);
                    return;
                }
                this.transcriptionAbortController = new AbortController();
                return this.transcribeAudio(audioBuffer, {
                    signal: this.transcriptionAbortController.signal
                }).then((res) => {
                    if (res && res.ok && res.transcript) {
                        this.onFinalTranscript(res.transcript);
                        this.setVoiceState(VOICE_STATES.IDLE);
                    } else if (res && res.cancelled) {
                        this.setVoiceState(VOICE_STATES.IDLE);
                    } else {
                        const err = new Error(res?.error || 'Offline speech transcription failed.');
                        this.setVoiceState(VOICE_STATES.ERROR, { error: err });
                        this.onError(err);
                    }
                });
            }).catch((err) => {
                this.setVoiceState(VOICE_STATES.ERROR, { error: err });
                this.onError(err);
            });

            return true;
        } else {
            return this.recognition.stop();
        }
    }

    /**
     * Cancel listening without transcribing.
     */
    cancelListening() {
        if (this.activeRecognitionEngine === 'whisper') {
            if (this.audioRecorder && typeof this.audioRecorder.cancel === 'function') {
                this.audioRecorder.cancel();
            }
            if (this.transcriptionAbortController) {
                try { this.transcriptionAbortController.abort(); } catch (_) {}
                this.transcriptionAbortController = null;
            }
            this.setVoiceState(VOICE_STATES.IDLE);
            return true;
        } else {
            return this.recognition.cancel();
        }
    }

    /**
     * Transcribe an audio file or buffer using local whisper.cpp offline engine.
     * @param {string|Buffer|Uint8Array} audioInput
     * @param {object} [options]
     * @returns {Promise<{ ok: boolean, transcript: string, durationMs?: number, error?: string }>}
     */
    async transcribeAudio(audioInput, options = {}) {
        if (!this.whisperEngine) {
            return {
                ok: false,
                transcript: '',
                error: 'Whisper offline engine is not configured'
            };
        }
        return await this.whisperEngine.transcribeAudio(audioInput, options);
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
                // Anti-echo debounce: delay resume slightly to ensure speaker reverberation dissipates
                setTimeout(() => {
                    if (this.wakeWordEngine && !this.isSpeaking && this.voiceState === VOICE_STATES.IDLE) {
                        this.wakeWordEngine.resume();
                        this._syncWakeWordCapture();
                    }
                }, 400);
            }
        }
    }

    /**
     * Cancel and stop speech playback immediately, invalidating pending speech calls.
     */
    stopSpeaking() {
        this.currentSpeechId++;
        this.synthesis.stop();
        if (this.voiceState === VOICE_STATES.SPEAKING) {
            this.setVoiceState(VOICE_STATES.IDLE);
        } else if (this.wakeWordEngine && !this.isSpeaking && this.voiceState === VOICE_STATES.IDLE) {
            this.wakeWordEngine.resume();
            this._syncWakeWordCapture();
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
        if (!this.wakeWordEngine) {
            return { enabled: false, supported: false };
        }
        return {
            ...this.wakeWordEngine.getPrivacyState(),
            isStreaming: Boolean(this._isWakeWordCapturing),
            licenceInfo: this.wakeWordEngine.getLicenceInfo()
        };
    }

    setWakeWordEnabled(enabled) {
        if (!this.wakeWordEngine) return false;
        if (enabled) {
            this.wakeWordEngine.enable();
            this._syncWakeWordCapture();
        } else {
            this.wakeWordEngine.disable();
            this._stopWakeWordCapture();
        }
        return this.wakeWordEngine.enabled;
    }

    muteWakeWord() {
        if (!this.wakeWordEngine) return false;
        const res = this.wakeWordEngine.mute();
        this._stopWakeWordCapture();
        return res;
    }

    unmuteWakeWord() {
        if (!this.wakeWordEngine) return false;
        const res = this.wakeWordEngine.unmute();
        this._syncWakeWordCapture();
        return res;
    }

    pauseWakeWord() {
        if (!this.wakeWordEngine) return false;
        return this.wakeWordEngine.pause();
    }

    resumeWakeWord() {
        if (!this.wakeWordEngine) return false;
        const res = this.wakeWordEngine.resume();
        this._syncWakeWordCapture();
        return res;
    }

    _syncWakeWordCapture() {
        if (!this.wakeWordEngine || !this.wakeWordEngine.enabled || this.wakeWordEngine.isMuted || this.wakeWordEngine.isPaused) {
            this._stopWakeWordCapture();
            return;
        }

        if (this.voiceState !== VOICE_STATES.IDLE || this.isSpeaking) {
            return;
        }

        this._startWakeWordCapture();
    }

    _startWakeWordCapture() {
        if (!this.audioRecorder || typeof this.audioRecorder.startContinuousCapture !== 'function') {
            return;
        }

        if (this._isWakeWordCapturing) {
            return;
        }

        this._isWakeWordCapturing = true;

        Promise.resolve(this.audioRecorder.startContinuousCapture({
            onAudioFrame: (frame) => {
                if (this.voiceState !== VOICE_STATES.IDLE || this.isSpeaking) {
                    return;
                }
                if (!this.wakeWordEngine || !this.wakeWordEngine.enabled || this.wakeWordEngine.isMuted || this.wakeWordEngine.isPaused) {
                    return;
                }
                try {
                    this.wakeWordEngine.processInput({ audioFrame: frame });
                } catch (err) {
                    this._stopWakeWordCapture();
                    this.onError(err);
                }
            }
        })).catch((err) => {
            this._isWakeWordCapturing = false;
            if (this.wakeWordEngine) {
                this.wakeWordEngine.disable();
            }
            this.onError(err);
        });
    }

    _stopWakeWordCapture() {
        this._isWakeWordCapturing = false;
        if (this.audioRecorder && typeof this.audioRecorder.stopContinuousCapture === 'function') {
            try {
                this.audioRecorder.stopContinuousCapture();
            } catch (_) {}
        }
    }

    getWhisperStatus() {
        return this.whisperEngine ? this.whisperEngine.getStatus() : { engine: 'whisper.cpp', isAvailable: false };
    }

    dispose() {
        this.cancelListening();
        this.stopSpeaking();
        this._stopWakeWordCapture();
        if (this.wakeWordEngine && typeof this.wakeWordEngine.dispose === 'function') {
            this.wakeWordEngine.dispose();
        }
        if (this.audioRecorder && typeof this.audioRecorder.cleanup === 'function') {
            this.audioRecorder.cleanup();
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
        RECOGNITION_MODES,
        VoiceController,
        createVoiceController
    };
}

if (typeof window !== 'undefined') {
    window.VOICE_STATES = VOICE_STATES;
    window.RECOGNITION_MODES = RECOGNITION_MODES;
    window.VoiceController = VoiceController;
    window.createVoiceController = createVoiceController;
}
