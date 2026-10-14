'use strict';

/**
 * Speech Recognition Service for L.U.C.Y.
 * Adapted from AILIS (reference/AILIS/src/browser-speech-recognition.js)
 * 
 * Provides microphone audio capture and speech-to-text transcription using the
 * native Web Speech API (SpeechRecognition / webkitSpeechRecognition) in Chromium and Electron.
 * 
 * Zero external models to download, zero cloud streaming by default, zero cost.
 */

const ERROR_MESSAGES = Object.freeze({
    'not-allowed': 'Microphone permission was denied. Please allow microphone access in Windows or browser settings.',
    'service-not-allowed': 'Speech recognition service is disabled by the host system.',
    'audio-capture': 'No microphone device was detected. Please verify your microphone is plugged in.',
    'no-speech': 'No speech was detected. Please try speaking closer to the microphone.',
    'network': 'Speech recognition service is temporarily unreachable.',
    'aborted': '',
    'language': 'The requested speech recognition language is not supported.',
    'unsupported': 'Speech recognition is not supported in this runtime environment.'
});

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function getSpeechRecognitionConstructor(globalScope = (typeof globalThis !== 'undefined' ? globalThis : null)) {
    if (!globalScope) return null;
    return globalScope.SpeechRecognition || globalScope.webkitSpeechRecognition || null;
}

function getSpeechRecognitionErrorMessage(error) {
    const code = String(error?.error || error?.code || '').trim().toLowerCase();
    if (code in ERROR_MESSAGES) {
        return ERROR_MESSAGES[code];
    }
    return String(error?.message || '').trim() || 'Speech recognition encountered an unexpected error.';
}

function mergeSpeechTranscript(baseText, transcript) {
    const base = String(baseText || '').trimEnd();
    const next = normalizeText(transcript);
    if (!base) return next;
    if (!next) return base;
    return `${base}${/[\s，。！？,.!?：:；;]$/.test(base) ? '' : ' '}${next}`;
}

function createSpeechRecognition({
    globalScope = (typeof globalThis !== 'undefined' ? globalThis : null),
    language = 'en-US',
    onStateChange = () => {},
    onInterimResult = () => {},
    onFinalResult = () => {},
    onError = () => {}
} = {}) {
    const Recognition = getSpeechRecognitionConstructor(globalScope);
    let recognition = null;
    let state = 'idle'; // 'idle' | 'starting' | 'listening' | 'processing'
    let finalTranscript = '';
    let stopRequested = false;

    const setState = (nextState, detail = {}) => {
        state = nextState;
        onStateChange({ state, ...detail });
    };

    const disposeRecognition = () => {
        if (!recognition) return;
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition = null;
    };

    const finish = () => {
        disposeRecognition();
        setState('idle');
    };

    return {
        get supported() {
            return Boolean(Recognition);
        },
        get state() {
            return state;
        },
        get isListening() {
            return state === 'listening' || state === 'starting';
        },
        start() {
            if (!Recognition) {
                const err = {
                    error: 'unsupported',
                    message: ERROR_MESSAGES.unsupported
                };
                onError(err);
                return false;
            }
            if (recognition || state !== 'idle') {
                return false;
            }

            finalTranscript = '';
            stopRequested = false;

            try {
                recognition = new Recognition();
            } catch (err) {
                onError({
                    error: 'instantiation-failed',
                    message: getSpeechRecognitionErrorMessage(err)
                });
                return false;
            }

            recognition.lang = language;
            recognition.continuous = false;
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;

            recognition.onstart = () => {
                setState('listening');
            };

            recognition.onresult = (event) => {
                let interimTranscript = '';
                for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
                    const res = event.results[i];
                    const text = normalizeText(res?.[0]?.transcript);
                    if (!text) continue;
                    if (res.isFinal) {
                        finalTranscript = mergeSpeechTranscript(finalTranscript, text);
                    } else {
                        interimTranscript = mergeSpeechTranscript(interimTranscript, text);
                    }
                }

                if (interimTranscript) {
                    onInterimResult({ transcript: interimTranscript, finalTranscript });
                }
                if (finalTranscript) {
                    onFinalResult({ transcript: finalTranscript });
                    finalTranscript = '';
                }
            };

            recognition.onerror = (event) => {
                const code = String(event?.error || '').toLowerCase();
                if (code !== 'aborted' || !stopRequested) {
                    onError({
                        error: code || 'unknown',
                        message: getSpeechRecognitionErrorMessage(event),
                        sourceEvent: event
                    });
                }
                disposeRecognition();
                setState('idle');
            };

            recognition.onend = () => {
                finish();
            };

            setState('starting');
            try {
                recognition.start();
                return true;
            } catch (err) {
                disposeRecognition();
                setState('idle');
                onError({
                    error: err?.name || 'start-failed',
                    message: getSpeechRecognitionErrorMessage(err),
                    sourceError: err
                });
                return false;
            }
        },
        stop() {
            if (!recognition) return false;
            stopRequested = true;
            setState('processing');
            try {
                recognition.stop();
            } catch {
                finish();
            }
            return true;
        },
        cancel() {
            if (!recognition) return false;
            stopRequested = true;
            try {
                recognition.abort();
            } catch {}
            finish();
            return true;
        },
        toggle() {
            if (this.isListening) {
                return this.stop();
            }
            return this.start();
        },
        dispose() {
            this.cancel();
            disposeRecognition();
            setState('idle');
        }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createSpeechRecognition,
        getSpeechRecognitionConstructor,
        getSpeechRecognitionErrorMessage,
        mergeSpeechTranscript,
        ERROR_MESSAGES
    };
}

if (typeof window !== 'undefined') {
    window.createSpeechRecognition = createSpeechRecognition;
    window.getSpeechRecognitionErrorMessage = getSpeechRecognitionErrorMessage;
    window.mergeSpeechTranscript = mergeSpeechTranscript;
}
