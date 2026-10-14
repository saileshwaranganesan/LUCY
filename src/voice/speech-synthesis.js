'use strict';

/**
 * Native Speech Synthesis Service for L.U.C.Y.
 * Adapted from AILIS (reference/AILIS/src/speech-provider.js)
 * 
 * Leverages native Windows SAPI5 / Windows Media Foundation voices via the Web Speech API
 * (window.speechSynthesis and SpeechSynthesisUtterance).
 * 
 * 100% offline-capable, zero external downloads, zero cost, instant stop/interruption.
 */

const _cleanTextForSpeech = (typeof require !== 'undefined')
    ? require('./speech-text-cleaner.js').cleanTextForSpeech
    : (typeof window !== 'undefined' ? window.cleanTextForSpeech : globalThis.cleanTextForSpeech);

const FEMALE_VOICE_HINTS = ['zira', 'jenny', 'aria', 'eva', 'sara', 'female', 'girl'];

function getSpeechSynthesis(globalScope = (typeof globalThis !== 'undefined' ? globalThis : null)) {
    if (!globalScope) return null;
    return globalScope.speechSynthesis || null;
}

function getSpeechSynthesisUtteranceConstructor(globalScope = (typeof globalThis !== 'undefined' ? globalThis : null)) {
    if (!globalScope) return null;
    return globalScope.SpeechSynthesisUtterance || null;
}

class SpeechSynthesisService {
    constructor({
        globalScope = (typeof globalThis !== 'undefined' ? globalThis : null),
        onStateChange = () => {},
        onBoundary = () => {},
        onError = () => {},
        pitch = 1.05,
        rate = 1.02,
        volume = 1.0,
        preferredVoiceName = ''
    } = {}) {
        this.globalScope = globalScope;
        this.onStateChange = onStateChange;
        this.onBoundary = onBoundary;
        this.onError = onError;
        this.synth = getSpeechSynthesis(globalScope);
        this.Utterance = getSpeechSynthesisUtteranceConstructor(globalScope);
        this.state = 'idle'; // 'idle' | 'speaking' | 'paused'
        this.currentUtterance = null;
        this.enabled = true;
        this.pitch = typeof pitch === 'number' && Number.isFinite(pitch) ? Math.max(0.5, Math.min(1.5, pitch)) : 1.05;
        this.rate = typeof rate === 'number' && Number.isFinite(rate) ? Math.max(0.5, Math.min(1.5, rate)) : 1.02;
        this.volume = typeof volume === 'number' && Number.isFinite(volume) ? Math.max(0, Math.min(1.0, volume)) : 1.0;
        this.preferredVoiceName = preferredVoiceName || '';
        this.speechSequence = 0;
    }

    setVoiceConfig(config = {}) {
        if (config.pitch !== undefined && config.pitch !== null) {
            const p = Number(config.pitch);
            if (!Number.isNaN(p) && Number.isFinite(p)) {
                this.pitch = Math.max(0.5, Math.min(1.5, p));
            }
        }
        if (config.rate !== undefined && config.rate !== null) {
            const r = Number(config.rate);
            if (!Number.isNaN(r) && Number.isFinite(r)) {
                this.rate = Math.max(0.5, Math.min(1.5, r));
            }
        }
        if (config.volume !== undefined && config.volume !== null) {
            const v = Number(config.volume);
            if (!Number.isNaN(v) && Number.isFinite(v)) {
                this.volume = Math.max(0, Math.min(1.0, v));
            }
        }
        if (config.voiceName !== undefined) {
            this.preferredVoiceName = String(config.voiceName || '');
        }
        if (config.preferredVoiceName !== undefined) {
            this.preferredVoiceName = String(config.preferredVoiceName || '');
        }
        if (config.enabled !== undefined) {
            this.enabled = Boolean(config.enabled);
        }
        return this.getVoiceConfig();
    }

    resetToDefaults() {
        this.stop();
        this.pitch = 1.05;
        this.rate = 1.02;
        this.volume = 1.0;
        this.preferredVoiceName = '';
        this.enabled = true;
        return this.getVoiceConfig();
    }

    async getAvailableVoices() {
        const voices = await this.loadVoices();
        return (voices || []).map((v) => ({
            name: v.name || '',
            lang: v.lang || '',
            default: Boolean(v.default),
            voiceURI: v.voiceURI || ''
        }));
    }

    getVoiceConfig() {
        return {
            pitch: this.pitch,
            rate: this.rate,
            volume: this.volume,
            preferredVoiceName: this.preferredVoiceName,
            enabled: this.enabled
        };
    }

    get supported() {
        return Boolean(this.synth && this.Utterance);
    }

    get isSpeaking() {
        return this.state === 'speaking';
    }

    setState(nextState, detail = {}) {
        this.state = nextState;
        this.onStateChange({ state: nextState, ...detail });
    }

    async loadVoices(timeoutMs = 1500) {
        if (!this.synth || typeof this.synth.getVoices !== 'function') {
            return [];
        }

        const existing = this.synth.getVoices() || [];
        if (existing.length > 0) {
            return existing;
        }

        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve(this.synth.getVoices?.() || []);
                }
            }, timeoutMs);

            const handleVoicesChanged = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    if (this.synth.removeEventListener) {
                        this.synth.removeEventListener('voiceschanged', handleVoicesChanged);
                    }
                    resolve(this.synth.getVoices?.() || []);
                }
            };

            if (this.synth.addEventListener) {
                this.synth.addEventListener('voiceschanged', handleVoicesChanged, { once: true });
            } else {
                this.synth.onvoiceschanged = handleVoicesChanged;
            }
        });
    }

    async selectBestVoice(preferredVoiceName = '') {
        const voices = await this.loadVoices();
        if (!voices || !voices.length) return null;

        if (preferredVoiceName) {
            const match = voices.find((v) => 
                (v.name && v.name.toLowerCase().includes(preferredVoiceName.toLowerCase())) ||
                (v.voiceURI && v.voiceURI.toLowerCase().includes(preferredVoiceName.toLowerCase()))
            );
            if (match) return match;
        }

        // Rank voices: Prefer English female voices (fits Lucy celestial fairy persona)
        const scored = voices.map((v) => {
            const name = String(v.name || '').toLowerCase();
            const lang = String(v.lang || '').toLowerCase();
            let score = 0;

            if (lang.startsWith('en')) score += 30;
            if (FEMALE_VOICE_HINTS.some((h) => name.includes(h))) score += 40;
            if (name.includes('natural') || name.includes('online')) score += 15;
            if (v.default) score += 5;

            return { voice: v, score };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored[0]?.voice || voices[0];
    }

    /**
     * Synthesize and speak text.
     * @param {string} rawText 
     * @param {object} [options]
     * @returns {Promise<boolean>}
     */
    async speak(rawText, options = {}) {
        if (!this.enabled) {
            return false;
        }
        if (!this.supported) {
            this.onError({
                error: 'unsupported',
                message: 'Speech synthesis is not supported on this platform.'
            });
            return false;
        }

        const cleaner = _cleanTextForSpeech || (typeof window !== 'undefined' ? window.cleanTextForSpeech : null);
        const cleanText = cleaner ? cleaner(rawText) : String(rawText || '').trim();
        if (!cleanText) {
            return false;
        }

        // Stop any active speech and record unique speech sequence
        this.stop();
        const seq = ++this.speechSequence;

        const targetVoice = options.voiceName || this.preferredVoiceName;
        const bestVoice = await this.selectBestVoice(targetVoice);

        // Discard if superseded while awaiting voice selection
        if (seq !== this.speechSequence) {
            return false;
        }

        const utterance = new this.Utterance(cleanText);

        if (bestVoice) {
            utterance.voice = bestVoice;
            utterance.lang = bestVoice.lang || 'en-US';
        } else {
            utterance.lang = 'en-US';
        }

        const effectiveRate = typeof options.rate === 'number' && Number.isFinite(options.rate) ? options.rate : this.rate;
        const effectivePitch = typeof options.pitch === 'number' && Number.isFinite(options.pitch) ? options.pitch : this.pitch;
        const effectiveVolume = typeof options.volume === 'number' && Number.isFinite(options.volume) ? options.volume : this.volume;

        utterance.rate = Math.max(0.5, Math.min(1.5, effectiveRate));
        utterance.pitch = Math.max(0.5, Math.min(1.5, effectivePitch));
        utterance.volume = Math.max(0.0, Math.min(1.0, effectiveVolume));

        this.currentUtterance = utterance;

        return new Promise((resolve) => {
            let settled = false;
            let started = false;
            let startTimeout = null;

            const cleanup = () => {
                if (startTimeout) clearTimeout(startTimeout);
                this.currentUtterance = null;
            };

            const finish = (result) => {
                if (settled) return;
                settled = true;
                cleanup();
                this.setState('idle');
                resolve(result);
            };

            utterance.onstart = () => {
                if (settled || seq !== this.speechSequence) {
                    if (this.synth?.cancel) try { this.synth.cancel(); } catch {}
                    finish(false);
                    return;
                }
                started = true;
                if (startTimeout) clearTimeout(startTimeout);
                this.setState('speaking', { text: cleanText });
            };

            utterance.onboundary = (event) => {
                if (seq === this.speechSequence && this.onBoundary) {
                    this.onBoundary({
                        charIndex: event.charIndex,
                        charLength: event.charLength || 1,
                        text: cleanText
                    });
                }
            };

            utterance.onend = () => {
                if (seq !== this.speechSequence) {
                    finish(false);
                    return;
                }
                finish(true);
            };

            utterance.onerror = (event) => {
                if (seq !== this.speechSequence) {
                    finish(false);
                    return;
                }
                // If canceled by user, don't treat as an error
                if (event?.error === 'canceled' || event?.error === 'interrupted') {
                    finish(false);
                    return;
                }
                this.onError({
                    error: event?.error || 'playback-failed',
                    message: `Speech synthesis error: ${event?.error || 'unknown'}`
                });
                finish(false);
            };

            try {
                // Timeout safety net in case audio driver hangs
                startTimeout = setTimeout(() => {
                    if (!started && !settled) {
                        this.stop();
                        finish(false);
                    }
                }, 3000);

                this.synth.speak(utterance);
            } catch (err) {
                this.onError({
                    error: 'speak-failed',
                    message: err?.message || String(err)
                });
                finish(false);
            }
        });
    }

    /**
     * Stop and cancel active speech playback immediately.
     */
    stop() {
        this.speechSequence++;
        if (!this.synth) return;
        try {
            this.synth.cancel();
        } catch {}
        this.currentUtterance = null;
        if (this.state !== 'idle') {
            this.setState('idle');
        }
    }

    toggleMute() {
        this.enabled = !this.enabled;
        if (!this.enabled) {
            this.stop();
        }
        return this.enabled;
    }
}

function createSpeechSynthesis(options = {}) {
    return new SpeechSynthesisService(options);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SpeechSynthesisService,
        createSpeechSynthesis
    };
}

if (typeof window !== 'undefined') {
    window.SpeechSynthesisService = SpeechSynthesisService;
    window.createSpeechSynthesis = createSpeechSynthesis;
}
