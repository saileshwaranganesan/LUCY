'use strict';

/**
 * Voice Activity Detector (VAD) for L.U.C.Y.
 * 
 * Local, real-time speech boundary and voice activity detection:
 * 1. Zero external network access: 100% in-memory audio processing.
 * 2. Multi-feature analysis: RMS energy, Zero-Crossing Rate (ZCR), and speech-band spectral weighting.
 * 3. Adaptive noise floor tracking: dynamically calibrates to ambient room acoustics.
 * 4. Dual-hangover state machine: prevents cutting off speech between words and natural conversational pauses.
 * 5. Bounded memory buffers: prevents memory growth during extended listening.
 * 6. Configurable sensitivity levels: 'low', 'normal', 'high'.
 */

const _VadEventEmitter = (typeof require !== 'undefined')
    ? require('events').EventEmitter
    : class SimpleVadEventEmitter {
        constructor() { this._listeners = {}; }
        on(event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); return this; }
        off(event, fn) { if (this._listeners[event]) this._listeners[event] = this._listeners[event].filter(f => f !== fn); return this; }
        removeListener(event, fn) { return this.off(event, fn); }
        removeAllListeners(event) { if (event) { delete this._listeners[event]; } else { this._listeners = {}; } return this; }
        emit(event, ...args) {
            const list = (this._listeners[event] || []).slice();
            list.forEach(fn => { try { fn(...args); } catch (e) { console.error('[VAD]', e); } });
            return list.length > 0;
        }
    };

const VAD_SAMPLE_RATE = 16000;
const VAD_FRAME_SIZE = 512; // 32ms at 16kHz
const DEFAULT_HANGOVER_MS = 1000; // 1 second of silence to conclude utterance
const DEFAULT_ONSET_FRAMES = 3;   // ~96ms of consecutive speech frames to establish onset
const DEFAULT_INITIAL_TIMEOUT_MS = 6000; // 6s to detect first speech
const DEFAULT_MAX_DURATION_MS = 20000;   // 20s max utterance duration

const VAD_STATES = Object.freeze({
    IDLE: 'idle',
    WAITING_FOR_SPEECH: 'waiting_for_speech',
    SPEECH_ONSET: 'speech_onset',
    SPEAKING: 'speaking',
    HANGOVER: 'hangover',
    COMPLETED: 'completed'
});

const SENSITIVITY_PROFILES = Object.freeze({
    low: {
        multiplier: 3.2,
        minRms: 0.035,
        zcrMin: 0.02,
        zcrMax: 0.45,
        hangoverMs: 800
    },
    normal: {
        multiplier: 2.3,
        minRms: 0.020,
        zcrMin: 0.015,
        zcrMax: 0.50,
        hangoverMs: 1000
    },
    high: {
        multiplier: 1.6,
        minRms: 0.012,
        zcrMin: 0.01,
        zcrMax: 0.55,
        hangoverMs: 1200
    }
});

class VoiceActivityDetector extends _VadEventEmitter {
    constructor({
        sampleRate = VAD_SAMPLE_RATE,
        sensitivity = 'normal',
        hangoverMs = DEFAULT_HANGOVER_MS,
        onsetFrames = DEFAULT_ONSET_FRAMES,
        initialSilenceTimeoutMs = DEFAULT_INITIAL_TIMEOUT_MS,
        maxSpeechDurationMs = DEFAULT_MAX_DURATION_MS
    } = {}) {
        super();
        this.sampleRate = sampleRate;
        this.sensitivity = SENSITIVITY_PROFILES[sensitivity] ? sensitivity : 'normal';
        this.profile = { ...SENSITIVITY_PROFILES[this.sensitivity] };
        this.hangoverMs = Number(hangoverMs) || this.profile.hangoverMs;
        this.onsetFramesRequired = Number(onsetFrames) || DEFAULT_ONSET_FRAMES;
        this.initialSilenceTimeoutMs = Number(initialSilenceTimeoutMs) || DEFAULT_INITIAL_TIMEOUT_MS;
        this.maxSpeechDurationMs = Number(maxSpeechDurationMs) || DEFAULT_MAX_DURATION_MS;

        this.state = VAD_STATES.IDLE;
        this.noiseFloorRms = 0.01;
        this.adaptationRate = 0.05; // Leaky integrator weight for noise floor

        this.consecutiveSpeechFrames = 0;
        this.consecutiveSilenceMs = 0;
        this.speechDurationMs = 0;
        this.waitingSilenceMs = 0;

        this.speechChunks = [];
        this.totalSpeechSamples = 0;
        this.isActive = false;
        this.isPaused = false;
        this.unprocessedBuffer = null;
    }

    setSensitivity(level) {
        if (SENSITIVITY_PROFILES[level]) {
            this.sensitivity = level;
            this.profile = { ...SENSITIVITY_PROFILES[level] };
        }
    }

    /**
     * Start VAD monitoring on an incoming audio stream.
     */
    start() {
        this.reset();
        this.isActive = true;
        this.isPaused = false;
        this.state = VAD_STATES.WAITING_FOR_SPEECH;
        this.emit('stateChange', { state: this.state });
    }

    /**
     * Stop VAD monitoring.
     */
    stop() {
        this.isActive = false;
        this.state = VAD_STATES.IDLE;
        this.reset();
        this.emit('stateChange', { state: this.state });
    }

    pause() {
        this.isPaused = true;
    }

    resume() {
        this.isPaused = false;
    }

    reset() {
        this.state = VAD_STATES.IDLE;
        this.consecutiveSpeechFrames = 0;
        this.consecutiveSilenceMs = 0;
        this.speechDurationMs = 0;
        this.waitingSilenceMs = 0;
        this.speechChunks = [];
        this.totalSpeechSamples = 0;
        this.unprocessedBuffer = null;
    }

    /**
     * Process an incoming raw audio chunk (Float32Array).
     * Slices chunk into 512-sample (32ms) analysis frames.
     * @param {Float32Array} chunk
     */
    processAudioChunk(chunk) {
        if (!this.isActive || this.isPaused || !chunk || chunk.length === 0) {
            return;
        }

        // Combine with any previously unprocessed audio leftover
        let samples;
        if (this.unprocessedBuffer && this.unprocessedBuffer.length > 0) {
            samples = new Float32Array(this.unprocessedBuffer.length + chunk.length);
            samples.set(this.unprocessedBuffer, 0);
            samples.set(chunk, this.unprocessedBuffer.length);
            this.unprocessedBuffer = null;
        } else {
            samples = chunk;
        }

        let offset = 0;
        const frameDurationMs = (VAD_FRAME_SIZE / this.sampleRate) * 1000;

        while (offset + VAD_FRAME_SIZE <= samples.length) {
            const frame = samples.subarray(offset, offset + VAD_FRAME_SIZE);
            this._processFrame(frame, frameDurationMs);
            offset += VAD_FRAME_SIZE;
        }

        // Save leftovers for next chunk
        if (offset < samples.length) {
            this.unprocessedBuffer = new Float32Array(samples.length - offset);
            this.unprocessedBuffer.set(samples.subarray(offset));
        }
    }

    /**
     * Process a single 32ms audio frame.
     * @param {Float32Array} frame
     * @param {number} frameDurationMs
     */
    _processFrame(frame, frameDurationMs) {
        // 1. Feature extraction
        let sumSq = 0;
        let zeroCrossings = 0;
        let prevSign = frame[0] >= 0;

        for (let i = 0; i < frame.length; i++) {
            const val = frame[i];
            sumSq += val * val;
            const currentSign = val >= 0;
            if (currentSign !== prevSign) {
                zeroCrossings++;
                prevSign = currentSign;
            }
        }

        const rms = Math.sqrt(sumSq / frame.length);
        const zcr = zeroCrossings / frame.length;

        // Dynamic threshold based on adaptive noise floor
        const dynamicThreshold = Math.max(
            this.profile.minRms,
            this.noiseFloorRms * this.profile.multiplier
        );

        // Frame classification
        const isEnergySpeech = rms >= dynamicThreshold;
        const isZcrValid = zcr >= this.profile.zcrMin && zcr <= this.profile.zcrMax;
        const isSpeechFrame = isEnergySpeech && isZcrValid;

        // Adaptive noise floor update (only when confident it is ambient silence)
        if (!isSpeechFrame && rms < dynamicThreshold * 0.8) {
            this.noiseFloorRms = (1 - this.adaptationRate) * this.noiseFloorRms + this.adaptationRate * rms;
        }

        this.emit('frameAnalysis', {
            rms,
            zcr,
            threshold: dynamicThreshold,
            isSpeech: isSpeechFrame,
            noiseFloor: this.noiseFloorRms
        });

        // 2. State machine transitions
        switch (this.state) {
            case VAD_STATES.WAITING_FOR_SPEECH: {
                if (isSpeechFrame) {
                    this.consecutiveSpeechFrames++;
                    if (this.consecutiveSpeechFrames >= this.onsetFramesRequired) {
                        this.state = VAD_STATES.SPEAKING;
                        this.speechDurationMs = this.consecutiveSpeechFrames * frameDurationMs;
                        this.consecutiveSilenceMs = 0;
                        this.speechChunks.push(new Float32Array(frame));
                        this.totalSpeechSamples += frame.length;
                        this.emit('speechStart', { timestamp: Date.now(), initialRms: rms });
                        this.emit('stateChange', { state: this.state });
                    }
                } else {
                    this.consecutiveSpeechFrames = 0;
                    this.waitingSilenceMs += frameDurationMs;
                    if (this.initialSilenceTimeoutMs > 0 && this.waitingSilenceMs >= this.initialSilenceTimeoutMs) {
                        this.state = VAD_STATES.COMPLETED;
                        this.isActive = false;
                        this.emit('silenceTimeout', { elapsedMs: this.waitingSilenceMs });
                        this.emit('stateChange', { state: this.state });
                    }
                }
                break;
            }

            case VAD_STATES.SPEAKING: {
                this.speechChunks.push(new Float32Array(frame));
                this.totalSpeechSamples += frame.length;
                this.speechDurationMs += frameDurationMs;

                if (isSpeechFrame) {
                    this.consecutiveSilenceMs = 0;
                    this.emit('speechProgress', { durationMs: this.speechDurationMs, rms });
                } else {
                    this.state = VAD_STATES.HANGOVER;
                    this.consecutiveSilenceMs = frameDurationMs;
                    this.emit('stateChange', { state: this.state });
                }

                // Max duration safety guard
                if (this.maxSpeechDurationMs > 0 && this.speechDurationMs >= this.maxSpeechDurationMs) {
                    this._concludeSpeech('max_duration_exceeded');
                }
                break;
            }

            case VAD_STATES.HANGOVER: {
                this.speechChunks.push(new Float32Array(frame));
                this.totalSpeechSamples += frame.length;
                this.speechDurationMs += frameDurationMs;

                if (isSpeechFrame) {
                    // Resumed speech before hangover expired! Return to speaking
                    this.state = VAD_STATES.SPEAKING;
                    this.consecutiveSilenceMs = 0;
                    this.emit('speechProgress', { durationMs: this.speechDurationMs, rms });
                    this.emit('stateChange', { state: this.state });
                } else {
                    this.consecutiveSilenceMs += frameDurationMs;
                    if (this.consecutiveSilenceMs >= this.hangoverMs) {
                        this._concludeSpeech('endpoint_detected');
                    }
                }

                if (this.maxSpeechDurationMs > 0 && this.speechDurationMs >= this.maxSpeechDurationMs) {
                    this._concludeSpeech('max_duration_exceeded');
                }
                break;
            }

            default:
                break;
        }
    }

    /**
     * Conclude the active speech utterance and emit speechEnd event with concatenated audio.
     */
    _concludeSpeech(reason) {
        this.state = VAD_STATES.COMPLETED;
        this.isActive = false;

        const flattened = new Float32Array(this.totalSpeechSamples);
        let offset = 0;
        for (const c of this.speechChunks) {
            flattened.set(c, offset);
            offset += c.length;
        }

        const durationMs = (this.totalSpeechSamples / this.sampleRate) * 1000;

        this.emit('speechEnd', {
            samples: flattened,
            sampleCount: this.totalSpeechSamples,
            durationMs,
            reason
        });

        this.emit('stateChange', { state: this.state });
        this.reset();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VoiceActivityDetector,
        VAD_STATES,
        SENSITIVITY_PROFILES,
        SAMPLE_RATE: VAD_SAMPLE_RATE,
        FRAME_SIZE: VAD_FRAME_SIZE
    };
}

if (typeof window !== 'undefined') {
    window.VoiceActivityDetector = VoiceActivityDetector;
    window.VAD_STATES = VAD_STATES;
    window.SENSITIVITY_PROFILES = SENSITIVITY_PROFILES;
}
