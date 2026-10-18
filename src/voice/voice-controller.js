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

const _VoiceActivityDetector = (typeof require !== 'undefined')
    ? require('./voice-activity-detector.js').VoiceActivityDetector
    : (typeof window !== 'undefined' ? window.VoiceActivityDetector : null);

const _ConversationStateMachine = (typeof require !== 'undefined')
    ? require('./conversation-state-machine.js').ConversationStateMachine
    : (typeof window !== 'undefined' ? window.ConversationStateMachine : null);

const _CONVERSATION_STATES = (typeof require !== 'undefined')
    ? (require('./conversation-state-machine.js').CONVERSATION_STATES || {})
    : (typeof window !== 'undefined' && window.CONVERSATION_STATES ? window.CONVERSATION_STATES : (typeof CONVERSATION_STATES !== 'undefined' ? CONVERSATION_STATES : {}));

const _VAD_STATES = (typeof require !== 'undefined')
    ? (require('./voice-activity-detector.js').VAD_STATES || {})
    : (typeof window !== 'undefined' && window.VAD_STATES ? window.VAD_STATES : (typeof VAD_STATES !== 'undefined' ? VAD_STATES : {}));

const _createAudioRecorder = (typeof require !== 'undefined')
    ? require('./audio-recorder.js').createAudioRecorder
    : (typeof window !== 'undefined' ? window.createAudioRecorder : null);

const _voiceCleanTextForSpeech = (typeof require !== 'undefined')
    ? require('./speech-text-cleaner.js').cleanTextForSpeech
    : (typeof window !== 'undefined' ? window.cleanTextForSpeech : globalThis.cleanTextForSpeech);

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
        onWakeWordStateChange = () => {},
        ttsEnabled = true,
        ttsEngine = 'kokoro',
        kokoroVoice = 'af_bella',
        language = 'en-US',
        wakeWordEnabled = false,
        wakeWordConfig = {},
        recognitionMode = RECOGNITION_MODES.AUTO,
        audioRecorder = null,
        whisperEngine = null,
        whisperConfig = {},
        continuousConversation = false,
        followUpTimeoutMs = 6000,
        bargeInEnabled = true,
        enableVad = true,
        vadSensitivity = 'normal',
        conversationStateMachine = null,
        synthesis = null
    } = {}) {
        this.globalScope = globalScope;
        this.onStateChange = onStateChange;
        this.onInterimTranscript = onInterimTranscript;
        this.onFinalTranscript = onFinalTranscript;
        this.onError = onError;
        this.onWakeWord = onWakeWord;
        this.onWakeWordStateChange = onWakeWordStateChange;
        this.voiceState = VOICE_STATES.IDLE;
        this.ttsEnabled = Boolean(ttsEnabled);
        this.ttsEngine = ttsEngine || 'kokoro';
        this.kokoroVoice = kokoroVoice || 'af_bella';
        this.currentSpeechId = 0;
        this.recognitionMode = recognitionMode;
        this.activeRecognitionEngine = 'web-speech'; // 'whisper' | 'web-speech'
        this.transcriptionAbortController = null;
        this._cachedWhisperStatus = null;
        this._isWakeWordCapturing = false;
        this.activeKokoroAudio = null;
        this._audioCtx = null;
        this._analyser = null;

        // Conversational lifecycle and VAD options
        this.continuousConversation = Boolean(continuousConversation);
        this.followUpTimeoutMs = Number(followUpTimeoutMs) || 6000;
        this.bargeInEnabled = Boolean(bargeInEnabled);
        this.enableVad = Boolean(enableVad);
        this.vadSensitivity = vadSensitivity;
        this.lastPlaybackStartTime = 0;
        this.lastPlaybackEndTime = 0;
        this.followUpTimer = null;
        this.conversationStateMachine = conversationStateMachine || null;

        // Initialize local Voice Activity Detector
        const makeVad = _VoiceActivityDetector || (globalScope ? globalScope.VoiceActivityDetector : null) || (typeof window !== 'undefined' ? window.VoiceActivityDetector : null);
        if (this.enableVad && makeVad) {
            this.vad = new makeVad({
                sensitivity: this.vadSensitivity,
                hangoverMs: 950,
                initialSilenceTimeoutMs: 6500
            });

            this.vad.on('speechEnd', () => {
                if (this.isListening) {
                    this.stopListening();
                }
            });

            this.vad.on('silenceTimeout', () => {
                if (this.isListening) {
                    this.cancelListening();
                }
            });
        } else {
            this.vad = null;
        }

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
        this.synthesis = (synthesis && typeof synthesis === 'object') ? synthesis : (makeSynthesis ? makeSynthesis({
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
        }) : { supported: false, isSpeaking: false, speak: async () => false, stop: () => {} });
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
        const makeWakeWord = _WakeWordEngine || (globalScope ? globalScope.WakeWordEngine : null) || (typeof window !== 'undefined' ? window.WakeWordEngine : null);
        this.wakeWordEngine = makeWakeWord ? new makeWakeWord(wwOpts) : null;

        if (this.wakeWordEngine) {
            this.wakeWordEngine.on('wakeWordDetected', (res) => {
                if (typeof this.onWakeWord === 'function') {
                    this.onWakeWord(res);
                }
                if (typeof this.onWakeWordStateChange === 'function') {
                    this.onWakeWordStateChange({ state: 'triggered', keyword: res.keyword, confidence: res.confidence });
                }
                if (this.voiceState === VOICE_STATES.IDLE && !this.isSpeaking) {
                    this.startListening();
                }
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
        const wasSpeaking = this.voiceState === VOICE_STATES.SPEAKING;
        this.voiceState = nextState;
        this.onStateChange({ voiceState: nextState, ...detail });
        if (nextState === VOICE_STATES.IDLE) {
            if (!wasSpeaking) {
                if (this.wakeWordEngine && this.wakeWordEngine.isPaused && !this.isSpeaking) {
                    this.wakeWordEngine.resume();
                }
                this._syncWakeWordCapture();
                if (this.wakeWordEngine && this.wakeWordEngine.enabled && this._isWakeWordCapturing && typeof this.onWakeWordStateChange === 'function') {
                    this.onWakeWordStateChange({ state: 'listening_wake' });
                }
            }
        } else if (this.wakeWordEngine && this.wakeWordEngine.enabled) {
            if (!this.wakeWordEngine.isPaused) {
                this.wakeWordEngine.pause();
            }
            if (typeof this.onWakeWordStateChange === 'function') {
                if (nextState === VOICE_STATES.LISTENING) {
                    this.onWakeWordStateChange({ state: 'waiting_for_command' });
                } else if (nextState === VOICE_STATES.PROCESSING) {
                    this.onWakeWordStateChange({ state: 'processing_command' });
                } else if (nextState === VOICE_STATES.SPEAKING) {
                    this.onWakeWordStateChange({ state: 'speaking' });
                }
            }
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

            if (this.vad) {
                this.vad.start();
            }

            if (this.audioRecorder && typeof this.audioRecorder.start === 'function') {
                Promise.resolve(this.audioRecorder.start({
                    onAudioFrame: (frame) => this._handleAudioFrame(frame)
                })).catch((err) => {
                    if (this.vad) this.vad.stop();
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
     * Internal audio frame distributor for VAD, barge-in, and state machine.
     * @param {Float32Array} frame
     */
    _handleAudioFrame(frame) {
        if (!frame || frame.length === 0) return;

        // 1. Acoustic barge-in: check if user speech interrupts active playback
        if (this.isSpeaking && this.bargeInEnabled) {
            const timeSinceStart = Date.now() - this.lastPlaybackStartTime;
            if (timeSinceStart > 180) { // allow initial playback buffer
                let sum = 0;
                for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
                const rms = Math.sqrt(sum / frame.length);
                if (rms > 0.08) {
                    this.stopSpeaking();
                    if (this.conversationStateMachine && typeof this.conversationStateMachine.interrupt === 'function') {
                        this.conversationStateMachine.interrupt('Acoustic barge-in');
                    }
                    this.startListening();
                    return;
                }
            }
        }

        // 2. Forward to ConversationStateMachine if present
        if (this.conversationStateMachine && typeof this.conversationStateMachine.processAudioFrame === 'function') {
            this.conversationStateMachine.processAudioFrame(frame);
        }

        // 3. Forward to local VAD if listening
        if (this.isListening && this.vad && this.vad.isActive) {
            this.vad.processAudioChunk(frame);
        }
    }

    /**
     * Stop microphone listening.
     */
    stopListening() {
        if (this.vad) {
            this.vad.stop();
        }
        this._clearFollowUpTimer();

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
        if (this.vad) {
            this.vad.stop();
        }
        this._clearFollowUpTimer();

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
     * Uses Kokoro-82M neural TTS by default when available in renderer IPC, with automatic fallback
     * to native Windows Speech (SAPI5).
     * @param {string} text 
     * @param {object} [options]
     * @returns {Promise<boolean>}
     */
    /**
     * General speech synthesis playback.
     * Used for preview, notifications, or direct speech requests.
     * Does NOT trigger follow-up conversational listening loops.
     * Can bypass ttsEnabled when isPreview or force is specified.
     * @param {string} text
     * @param {object} [options]
     * @returns {Promise<boolean>}
     */
    async speak(text, options = {}) {
        return await this._executeSpeech(text, options, false);
    }

    /**
     * Speak response text via TTS with sequence protection against stale responses.
     * Uses Kokoro-82M neural TTS by default when available in renderer IPC, with automatic fallback
     * to native Windows Speech (SAPI5).
     * @param {string} text 
     * @param {object} [options]
     * @returns {Promise<boolean>}
     */
    async speakResponse(text, options = {}) {
        return await this._executeSpeech(text, options, true);
    }

    /**
     * Internal unified speech execution engine for both conversational responses and voice previews.
     * @private
     */
    async _executeSpeech(text, options = {}, isResponse = false) {
        if (!text || typeof text !== 'string' || !text.trim()) {
            return false;
        }

        const isPreview = Boolean(options.isPreview || options.force);
        if (!this.ttsEnabled && !isPreview) {
            return false;
        }
        if (this.isListening && !isPreview) {
            return false;
        }
        if (this.wakeWordEngine) {
            this.wakeWordEngine.pause();
        }

        const speechId = ++this.currentSpeechId;
        this.stopSpeakingInternal();
        this.lastPlaybackStartTime = Date.now();

        try {
            const rawVoice = options.voice || options.kokoroVoice || options.voiceName || this.kokoroVoice || '';
            const isKokoroPreset = rawVoice === 'af_bella' || rawVoice === 'af_sky' || String(rawVoice).startsWith('kokoro');
            const cleanVoice = String(rawVoice).replace(/^kokoro:/, '');

            let engine = options.ttsEngine || this.ttsEngine || 'kokoro';
            if (isKokoroPreset) {
                engine = 'kokoro';
            } else if (rawVoice && rawVoice !== 'af_bella' && rawVoice !== 'af_sky' && options.ttsEngine !== 'kokoro') {
                engine = 'windows-speech';
            }

            const rate = typeof options.rate === 'number' && Number.isFinite(options.rate) ? options.rate : (this.synthesis?.rate || 1.0);
            const pitch = typeof options.pitch === 'number' && Number.isFinite(options.pitch) ? options.pitch : (this.synthesis?.pitch || 1.05);
            const volume = typeof options.volume === 'number' && Number.isFinite(options.volume) ? options.volume : (this.synthesis?.volume !== undefined ? this.synthesis.volume : 1.0);

            const hasKokoroIpc = Boolean(this.globalScope && this.globalScope.lucyIpc && typeof this.globalScope.lucyIpc.synthesizeSpeech === 'function');

            if (engine !== 'windows-speech' && hasKokoroIpc) {
                const clean = typeof _voiceCleanTextForSpeech === 'function' ? _voiceCleanTextForSpeech(text) : String(text || '').trim();
                if (!clean || !clean.trim()) return false;

                const kokoroVoice = (cleanVoice === 'af_sky' || cleanVoice === 'af_bella') ? cleanVoice : (this.kokoroVoice || 'af_bella');

                const res = await this.globalScope.lucyIpc.synthesizeSpeech(clean, {
                    voice: kokoroVoice,
                    rate,
                    pitch,
                    volume
                });

                if (speechId !== this.currentSpeechId) {
                    return false;
                }

                if (res && res.ok && res.audio) {
                    return await this._playAudioInRenderer(res.audio, speechId, {
                        rate,
                        pitch,
                        volume,
                        sinkId: options.sinkId || options.deviceId,
                        onStart: () => {
                            if (speechId === this.currentSpeechId) {
                                this.setVoiceState(VOICE_STATES.SPEAKING, { text: clean, engine: 'kokoro', voice: kokoroVoice });
                                if (typeof options.onStart === 'function') {
                                    try { options.onStart(); } catch (_) {}
                                }
                            }
                        }
                    });
                } else {
                    // Transparent fallback to native Windows speech
                    return await this.synthesis.speak(clean, {
                        ...options,
                        voiceName: cleanVoice,
                        rate,
                        pitch,
                        volume,
                        onStart: () => {
                            if (speechId === this.currentSpeechId) {
                                this.setVoiceState(VOICE_STATES.SPEAKING, { text: clean, engine: 'windows-speech', voice: cleanVoice });
                                if (typeof options.onStart === 'function') {
                                    try { options.onStart(); } catch (_) {}
                                }
                            }
                        }
                    });
                }
            } else {
                const clean = typeof _voiceCleanTextForSpeech === 'function' ? _voiceCleanTextForSpeech(text) : String(text || '').trim();
                if (!clean || !clean.trim()) return false;
                return await this.synthesis.speak(clean, {
                    ...options,
                    voiceName: cleanVoice,
                    rate,
                    pitch,
                    volume,
                    onStart: () => {
                        if (speechId === this.currentSpeechId) {
                            this.setVoiceState(VOICE_STATES.SPEAKING, { text: clean, engine: 'windows-speech', voice: cleanVoice });
                            if (typeof options.onStart === 'function') {
                                try { options.onStart(); } catch (_) {}
                            }
                        }
                    }
                });
            }
        } catch (err) {
            // Transparent fallback to native Windows speech
            if (speechId === this.currentSpeechId) {
                try {
                    return await this.synthesis.speak(text, { ...options, onStart: options.onStart });
                } catch (fallbackErr) {
                    this.onError(fallbackErr);
                    return false;
                }
            }
            return false;
        } finally {
            this.lastPlaybackEndTime = Date.now();
            if (speechId === this.currentSpeechId) {
                if (this.voiceState === VOICE_STATES.SPEAKING) {
                    this.setVoiceState(VOICE_STATES.IDLE);
                }
                if (isResponse && this.continuousConversation && !this.conversationStateMachine) {
                    this._startFollowUpListening();
                }
            }
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

    _startFollowUpListening() {
        this._clearFollowUpTimer();
        this.followUpTimer = setTimeout(() => {
            if (this.isListening) {
                this.stopListening();
            }
        }, this.followUpTimeoutMs);
        this.startListening();
    }

    _clearFollowUpTimer() {
        if (this.followUpTimer) {
            clearTimeout(this.followUpTimer);
            this.followUpTimer = null;
        }
    }

    /**
     * Internal audio playback in browser/Electron renderer environment.
     */
    async _playAudioInRenderer(audioDataUri, speechId, options = {}) {
        return new Promise(async (resolve) => {
            const AudioCtor = (this.globalScope && this.globalScope.Audio) || (typeof Audio !== 'undefined' ? Audio : null);
            if (!AudioCtor) {
                if (typeof options.onStart === 'function') {
                    try { options.onStart(); } catch (_) {}
                }
                resolve(speechId === this.currentSpeechId);
                return;
            }
            if (speechId !== this.currentSpeechId) {
                resolve(false);
                return;
            }

            // Ensure AudioContext is initialized and resumed if available
            try {
                if (this.globalScope && (this.globalScope.AudioContext || this.globalScope.webkitAudioContext)) {
                    if (!this._audioCtx) {
                        const AudioCtx = this.globalScope.AudioContext || this.globalScope.webkitAudioContext;
                        this._audioCtx = new AudioCtx();
                    }
                    if (this._audioCtx.state === 'suspended') {
                        await this._audioCtx.resume().catch(() => {});
                    }
                }
            } catch (_) {}

            if (speechId !== this.currentSpeechId) {
                resolve(false);
                return;
            }

            let audio = null;
            try {
                audio = new AudioCtor(audioDataUri);
            } catch (ctorErr) {
                this.onError(ctorErr);
                resolve(false);
                return;
            }

            this.activeKokoroAudio = audio;

            const volume = typeof options.volume === 'number' && Number.isFinite(options.volume)
                ? Math.max(0, Math.min(1.0, options.volume))
                : 1.0;
            audio.volume = volume;

            const pitch = typeof options.pitch === 'number' && Number.isFinite(options.pitch)
                ? Math.max(0.5, Math.min(1.5, options.pitch))
                : 1.0;

            if ('preservesPitch' in audio) {
                audio.preservesPitch = false;
            }
            if (Math.abs(pitch - 1.0) > 0.01) {
                try {
                    audio.playbackRate = pitch;
                } catch (_) {}
            }

            // Route to specified sink/audio output device if supported
            if (options.sinkId && typeof audio.setSinkId === 'function') {
                try {
                    await audio.setSinkId(options.sinkId);
                } catch (_) {}
            }

            let mediaSource = null;
            try {
                if (this._audioCtx && this._audioCtx.state !== 'closed') {
                    if (!this._analyser) {
                        this._analyser = this._audioCtx.createAnalyser();
                        this._analyser.fftSize = 64;
                        this._analyser.connect(this._audioCtx.destination);
                    }
                    mediaSource = this._audioCtx.createMediaElementSource(audio);
                    mediaSource.connect(this._analyser);
                }
            } catch (_) {
                // If createMediaElementSource is disallowed or fails, audio routes directly to output
                mediaSource = null;
            }

            let settled = false;
            let playbackStarted = false;

            const cleanup = (success = false, error = null) => {
                if (settled) return;
                settled = true;
                try {
                    if (mediaSource) {
                        mediaSource.disconnect();
                        mediaSource = null;
                    }
                } catch (_) {}
                if (this.activeKokoroAudio === audio) {
                    this.activeKokoroAudio = null;
                }
                if (error) {
                    this.onError(error);
                }
                const finalSuccess = Boolean(success && playbackStarted && speechId === this.currentSpeechId);
                resolve(finalSuccess);
            };

            audio.onended = () => cleanup(true);
            audio.onerror = () => {
                const err = (audio.error && audio.error.message)
                    ? new Error(`Audio playback error: ${audio.error.message} (code ${audio.error.code})`)
                    : new Error('Audio element encountered playback failure');
                cleanup(false, err);
            };
            audio.onabort = () => cleanup(false);

            let onStartFired = false;
            const fireOnStart = () => {
                if (!onStartFired && speechId === this.currentSpeechId) {
                    onStartFired = true;
                    playbackStarted = true;
                    if (typeof options.onStart === 'function') {
                        try { options.onStart(); } catch (_) {}
                    }
                }
            };

            audio.onplay = fireOnStart;

            try {
                const playPromise = audio.play();
                if (playPromise && typeof playPromise.then === 'function') {
                    playPromise.then(() => {
                        fireOnStart();
                    }).catch((playErr) => {
                        cleanup(false, playErr);
                    });
                } else {
                    fireOnStart();
                }
            } catch (playSyncErr) {
                cleanup(false, playSyncErr);
            }
        });
    }

    /**
     * Return frequency data for audio-reactive visualizer HUD.
     * @returns {Uint8Array|null}
     */
    getAudioFrequencyData() {
        if (!this._analyser || !this.isSpeaking) {
            return null;
        }
        const dataArray = new Uint8Array(this._analyser.frequencyBinCount);
        this._analyser.getByteFrequencyData(dataArray);
        return dataArray;
    }

    /**
     * Cancel and stop speech playback immediately, invalidating pending speech calls.
     */
    stopSpeaking() {
        this.currentSpeechId++;
        this.stopSpeakingInternal();
        if (this.voiceState === VOICE_STATES.SPEAKING) {
            this.setVoiceState(VOICE_STATES.IDLE);
        } else if (this.wakeWordEngine && !this.isSpeaking && this.voiceState === VOICE_STATES.IDLE) {
            this.wakeWordEngine.resume();
            this._syncWakeWordCapture();
        }
    }

    stopSpeakingInternal() {
        if (this.activeKokoroAudio) {
            const oldAudio = this.activeKokoroAudio;
            this.activeKokoroAudio = null;
            try {
                oldAudio.pause();
                oldAudio.currentTime = 0;
                oldAudio.src = '';
                if (typeof oldAudio.onabort === 'function') {
                    oldAudio.onabort();
                }
            } catch (_) {}
        }
        if (this.globalScope && this.globalScope.lucyIpc && typeof this.globalScope.lucyIpc.stopKokoroSpeech === 'function') {
            this.globalScope.lucyIpc.stopKokoroSpeech().catch(() => {});
        }
        if (this.synthesis && typeof this.synthesis.stop === 'function') {
            this.synthesis.stop();
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
        if (config.ttsEngine !== undefined) {
            this.ttsEngine = config.ttsEngine;
        }
        if (config.kokoroVoice !== undefined) {
            this.kokoroVoice = config.kokoroVoice;
        }
        if (config.wakeWordEnabled !== undefined) {
            this.setWakeWordEnabled(config.wakeWordEnabled);
        }
        if (config.wakeWordSensitivity !== undefined && this.wakeWordEngine) {
            this.wakeWordEngine.setSensitivity(config.wakeWordSensitivity);
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
            ttsEnabled: this.ttsEnabled,
            ttsEngine: this.ttsEngine,
            kokoroVoice: this.kokoroVoice,
            wakeWordEnabled: this.wakeWordEngine ? this.wakeWordEngine.enabled : false,
            wakeWordSensitivity: this.wakeWordEngine ? this.wakeWordEngine.sensitivity : 0.5
        };
    }

    resetToDefaults() {
        this.ttsEnabled = true;
        this.ttsEngine = 'kokoro';
        this.kokoroVoice = 'af_bella';
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
            if (this.audioRecorder && this.audioRecorder.supported === false) {
                this.wakeWordEngine.disable();
                if (typeof this.onWakeWordStateChange === 'function') {
                    this.onWakeWordStateChange({ state: 'failed', error: 'Microphone capture not supported' });
                }
                return false;
            }
            this.wakeWordEngine.enable();
            this._syncWakeWordCapture();
            if (this._isWakeWordCapturing && typeof this.onWakeWordStateChange === 'function') {
                this.onWakeWordStateChange({ state: 'listening_wake' });
            }
        } else {
            this.wakeWordEngine.disable();
            this._stopWakeWordCapture();
            if (typeof this.onWakeWordStateChange === 'function') {
                this.onWakeWordStateChange({ state: 'disabled' });
            }
        }
        return this.wakeWordEngine.enabled;
    }

    setWakeWordSensitivity(sensitivity) {
        if (!this.wakeWordEngine) return false;
        return this.wakeWordEngine.setSensitivity(sensitivity);
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
        const res = this.wakeWordEngine.pause();
        return res;
    }

    resumeWakeWord() {
        if (!this.wakeWordEngine) return false;
        const res = this.wakeWordEngine.resume();
        this._syncWakeWordCapture();
        return res;
    }

    _onWakeAudioFrame(frame) {
        if (!frame || frame.length === 0) return;
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
            // Re-affirm the wake-word callback on the running recorder pipeline
            if (typeof this.audioRecorder.setWakeWordCallback === 'function') {
                this.audioRecorder.setWakeWordCallback((frame) => this._onWakeAudioFrame(frame));
            }
            if (this.wakeWordEngine && this.wakeWordEngine.enabled && this.voiceState === VOICE_STATES.IDLE && !this.isSpeaking) {
                if (typeof this.onWakeWordStateChange === 'function') {
                    this.onWakeWordStateChange({ state: 'listening_wake' });
                }
            }
            return;
        }

        this._isWakeWordCapturing = true;

        Promise.resolve(this.audioRecorder.startContinuousCapture({
            onAudioFrame: (frame) => this._onWakeAudioFrame(frame)
        })).then(() => {
            if (this.wakeWordEngine && this.wakeWordEngine.enabled && this.voiceState === VOICE_STATES.IDLE && !this.isSpeaking) {
                if (typeof this.onWakeWordStateChange === 'function') {
                    this.onWakeWordStateChange({ state: 'listening_wake' });
                }
            }
        }).catch((err) => {
            this._isWakeWordCapturing = false;
            if (this.wakeWordEngine) {
                this.wakeWordEngine.disable();
            }
            if (typeof this.onWakeWordStateChange === 'function') {
                this.onWakeWordStateChange({ state: 'failed', error: err?.message || 'Microphone capture failed' });
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
        if (typeof this.onWakeWordStateChange === 'function') {
            const st = this.getWakeWordStatus();
            this.onWakeWordStateChange({ state: st.enabled ? 'standby' : 'disabled' });
        }
    }

    getWhisperStatus() {
        return this.whisperEngine ? this.whisperEngine.getStatus() : { engine: 'whisper.cpp', isAvailable: false };
    }

    setContinuousConversation(enabled) {
        this.continuousConversation = Boolean(enabled);
        if (this.conversationStateMachine) {
            this.conversationStateMachine.continuousConversation = this.continuousConversation;
        }
        return this.continuousConversation;
    }

    setBargeInEnabled(enabled) {
        this.bargeInEnabled = Boolean(enabled);
        if (this.conversationStateMachine) {
            this.conversationStateMachine.bargeInEnabled = this.bargeInEnabled;
        }
        return this.bargeInEnabled;
    }

    setVadSensitivity(level) {
        this.vadSensitivity = level;
        if (this.vad) {
            this.vad.setSensitivity(level);
        }
        if (this.conversationStateMachine && this.conversationStateMachine.vad) {
            this.conversationStateMachine.vad.setSensitivity(level);
        }
        return this.vadSensitivity;
    }

    getVadStatus() {
        return {
            enabled: this.enableVad,
            sensitivity: this.vadSensitivity,
            state: this.vad ? this.vad.state : 'disabled',
            isActive: Boolean(this.vad && this.vad.isActive)
        };
    }

    getConversationStateMachine() {
        return this.conversationStateMachine;
    }

    setConversationStateMachine(sm) {
        this.conversationStateMachine = sm;
        return this.conversationStateMachine;
    }

    /**
     * Create a streaming sentence-level speech synthesizer for LLM token streams.
     * Buffers tokens and speaks each complete sentence as it arrives.
     * @param {object} [options]
     * @returns {{ feed: (token: string) => void, flush: () => Promise<void>, cancel: () => void }}
     */
    createStreamingSpeaker(options = {}) {
        let buffer = '';
        let queue = Promise.resolve();
        let isCancelled = false;

        const sentenceRegex = /([.?!;\n]+)/g;

        const processQueue = async (textToSpeak) => {
            if (isCancelled || !textToSpeak || !textToSpeak.trim()) return;
            await this.speakResponse(textToSpeak, options);
        };

        return {
            feed: (token) => {
                if (isCancelled || !token) return;
                buffer += token;
                const parts = buffer.split(sentenceRegex);
                if (parts.length > 2) {
                    const completed = parts.slice(0, parts.length - 1).join('');
                    buffer = parts[parts.length - 1];
                    queue = queue.then(() => processQueue(completed));
                }
            },
            flush: async () => {
                if (isCancelled) return;
                if (buffer.trim()) {
                    const remaining = buffer.trim();
                    buffer = '';
                    queue = queue.then(() => processQueue(remaining));
                }
                await queue;
            },
            cancel: () => {
                isCancelled = true;
                buffer = '';
                this.stopSpeaking();
            }
        };
    }

    dispose() {
        this._clearFollowUpTimer();
        this.cancelListening();
        this.stopSpeaking();
        this._stopWakeWordCapture();
        if (this.vad) {
            this.vad.stop();
        }
        if (this.conversationStateMachine && typeof this.conversationStateMachine.cancel === 'function') {
            this.conversationStateMachine.cancel();
        }
        if (this.activeKokoroAudio) {
            try {
                this.activeKokoroAudio.pause();
                this.activeKokoroAudio.currentTime = 0;
            } catch (_) {}
            this.activeKokoroAudio = null;
        }
        if (this._audioCtx && typeof this._audioCtx.close === 'function') {
            try { this._audioCtx.close(); } catch (_) {}
            this._audioCtx = null;
            this._analyser = null;
        }
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
        CONVERSATION_STATES: _CONVERSATION_STATES,
        VoiceActivityDetector: _VoiceActivityDetector,
        ConversationStateMachine: _ConversationStateMachine,
        VoiceController,
        createVoiceController
    };
}

if (typeof window !== 'undefined') {
    window.VOICE_STATES = VOICE_STATES;
    window.RECOGNITION_MODES = RECOGNITION_MODES;
    window.CONVERSATION_STATES = _CONVERSATION_STATES;
    window.VoiceActivityDetector = _VoiceActivityDetector;
    window.ConversationStateMachine = _ConversationStateMachine;
    window.VoiceController = VoiceController;
    window.createVoiceController = createVoiceController;
}
