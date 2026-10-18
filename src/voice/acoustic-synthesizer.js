'use strict';

/**
 * Deterministic Acoustic Speech Synthesizer for L.U.C.Y. (REQ-028)
 * 
 * Provides pure mathematical source-filter speech synthesis for deterministic
 * test fixtures and acoustic model calibration:
 * - Glottal pulse excitation source for voiced vowels and consonants.
 * - Vocal tract digital resonator filters (Formants F1, F2, F3).
 * - Sibilant fricative noise generator for /s/ (4.5kHz - 7.5kHz).
 * - Plosive burst generator for stops (/k/).
 * - Generates 16kHz 16-bit mono PCM buffers and Float32Array frames.
 * 
 * Licenced under Apache-2.0 / MIT. Zero third-party audio dependencies.
 */

const SYNTH_SAMPLE_RATE = 16000;

// Second-order digital resonator (biquad bandpass formant filter)
class FormantResonator {
    constructor(sampleRate = SYNTH_SAMPLE_RATE) {
        this.sampleRate = sampleRate;
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
    }

    setFilter(freq, bandwidth) {
        const r = Math.exp((-Math.PI * bandwidth) / this.sampleRate);
        const theta = (2 * Math.PI * freq) / this.sampleRate;
        this.a1 = -2 * r * Math.cos(theta);
        this.a2 = r * r;
        this.b0 = 1 - r;
    }

    process(sample) {
        const out = this.b0 * sample - this.a1 * this.y1 - this.a2 * this.y2;
        this.y2 = this.y1;
        this.y1 = out;
        return out;
    }

    reset() {
        this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    }
}

// Bandpass filter for fricatives /s/
class NoiseBandpass {
    constructor(lowFreq, highFreq, sampleRate = SYNTH_SAMPLE_RATE) {
        this.sampleRate = sampleRate;
        const center = (lowFreq + highFreq) / 2;
        const bw = highFreq - lowFreq;
        const q = center / bw;
        const w0 = (2 * Math.PI * center) / sampleRate;
        const alpha = Math.sin(w0) / (2 * q);

        this.b0 = alpha;
        this.b1 = 0;
        this.b2 = -alpha;
        this.a0 = 1 + alpha;
        this.a1 = -2 * Math.cos(w0);
        this.a2 = 1 - alpha;

        this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    }

    process(x) {
        const y = (this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2) / this.a0;
        this.x2 = this.x1;
        this.x1 = x;
        this.y2 = this.y1;
        this.y1 = y;
        return y;
    }

    reset() {
        this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    }
}

// Pseudo-random deterministic noise generator (seeded LCG)
class SeededNoise {
    constructor(seed = 123456789) {
        this.seed = seed;
    }
    next() {
        this.seed = (1103515245 * this.seed + 12345) & 0x7fffffff;
        return (this.seed / 0x3fffffff) - 1.0;
    }
}

/**
 * Synthesizes a phoneme segment
 */
function synthesizePhoneme({
    type = 'vowel', // 'vowel', 'fricative', 'stop', 'silence'
    durationMs = 150,
    f0 = 130, // fundamental pitch in Hz
    f1Start = 500, f1End = 500, bw1 = 80,
    f2Start = 1500, f2End = 1500, bw2 = 120,
    f3Start = 2500, f3End = 2500, bw3 = 180,
    fricativeLow = 4500, fricativeHigh = 7500,
    burstFreq = 2200, burstMs = 20,
    gain = 0.5,
    noiseGen = null
}) {
    const numSamples = Math.floor((durationMs / 1000) * SYNTH_SAMPLE_RATE);
    const output = new Float32Array(numSamples);
    const noise = noiseGen || new SeededNoise(42);

    if (type === 'silence') {
        return output;
    }

    if (type === 'fricative') {
        const bp = new NoiseBandpass(fricativeLow, fricativeHigh, SYNTH_SAMPLE_RATE);
        for (let i = 0; i < numSamples; i++) {
            // Envelope: ramp up 20ms, ramp down 20ms
            const env = Math.min(1.0, i / (0.02 * SYNTH_SAMPLE_RATE), (numSamples - i) / (0.02 * SYNTH_SAMPLE_RATE));
            const white = noise.next();
            output[i] = bp.process(white) * gain * env;
        }
        return output;
    }

    if (type === 'stop') {
        // Stop: silent closure for durationMs - burstMs, then sharp burst
        const closureSamples = Math.floor(((durationMs - burstMs) / 1000) * SYNTH_SAMPLE_RATE);
        const bp = new NoiseBandpass(burstFreq - 300, burstFreq + 300, SYNTH_SAMPLE_RATE);
        for (let i = closureSamples; i < numSamples; i++) {
            const burstProgress = (i - closureSamples) / (numSamples - closureSamples);
            const env = Math.exp(-burstProgress * 5);
            output[i] = bp.process(noise.next()) * gain * 1.5 * env;
        }
        return output;
    }

    // Voiced phoneme / vowel
    const r1 = new FormantResonator(SYNTH_SAMPLE_RATE);
    const r2 = new FormantResonator(SYNTH_SAMPLE_RATE);
    const r3 = new FormantResonator(SYNTH_SAMPLE_RATE);

    const samplesPerPeriod = Math.floor(SYNTH_SAMPLE_RATE / f0);
    let periodIndex = 0;

    for (let i = 0; i < numSamples; i++) {
        const t = i / numSamples;
        const currentF1 = f1Start + (f1End - f1Start) * t;
        const currentF2 = f2Start + (f2End - f2Start) * t;
        const currentF3 = f3Start + (f3End - f3Start) * t;

        r1.setFilter(currentF1, bw1);
        r2.setFilter(currentF2, bw2);
        r3.setFilter(currentF3, bw3);

        // Rosenberg glottal pulse approximation
        let excitation = 0;
        if (periodIndex < samplesPerPeriod * 0.4) {
            const p = periodIndex / (samplesPerPeriod * 0.4);
            excitation = 0.5 * (1 - Math.cos(Math.PI * p));
        } else if (periodIndex < samplesPerPeriod * 0.56) {
            const p = (periodIndex - samplesPerPeriod * 0.4) / (samplesPerPeriod * 0.16);
            excitation = Math.cos(0.5 * Math.PI * p);
        }
        periodIndex = (periodIndex + 1) % samplesPerPeriod;

        // Add slight aspiration noise
        const glottal = excitation + noise.next() * 0.03;
        const y1 = r1.process(glottal);
        const y2 = r2.process(glottal) * 0.6;
        const y3 = r3.process(glottal) * 0.25;

        // Smooth onset/offset envelope
        const env = Math.min(1.0, i / (0.015 * SYNTH_SAMPLE_RATE), (numSamples - i) / (0.015 * SYNTH_SAMPLE_RATE));
        output[i] = (y1 + y2 + y3) * gain * env;
    }

    return output;
}

/**
 * Concatenate multiple audio segments into a single Float32Array.
 */
function concatAudio(segments) {
    let totalLen = 0;
    for (const seg of segments) {
        totalLen += seg.length;
    }
    const result = new Float32Array(totalLen);
    let offset = 0;
    for (const seg of segments) {
        result.set(seg, offset);
        offset += seg.length;
    }
    return result;
}

/**
 * Synthesizes the wake phrase "Hey Lucy"
 */
function synthesizeHeyLucy(options = {}) {
    const f0 = options.f0 || 135;
    const noise = new SeededNoise(options.seed || 101);

    const segments = [
        // Silence lead-in
        synthesizePhoneme({ type: 'silence', durationMs: 40 }),
        // /h/ aspiration
        synthesizePhoneme({ type: 'fricative', durationMs: 70, fricativeLow: 1000, fricativeHigh: 3500, gain: 0.15, noiseGen: noise }),
        // /eɪ/ diphthong
        synthesizePhoneme({ type: 'vowel', durationMs: 160, f0, f1Start: 520, f1End: 420, f2Start: 1800, f2End: 2200, gain: 0.5, noiseGen: noise }),
        // /l/ transition
        synthesizePhoneme({ type: 'vowel', durationMs: 90, f0, f1Start: 380, f1End: 350, f2Start: 1200, f2End: 1050, gain: 0.35, noiseGen: noise }),
        // /uː/ back vowel
        synthesizePhoneme({ type: 'vowel', durationMs: 140, f0, f1Start: 340, f1End: 320, f2Start: 950, f2End: 900, gain: 0.45, noiseGen: noise }),
        // /s/ sibilant fricative (distinctive acoustic signature!)
        synthesizePhoneme({ type: 'fricative', durationMs: 150, fricativeLow: 4500, fricativeHigh: 7500, gain: 0.45, noiseGen: noise }),
        // /i/ high front vowel
        synthesizePhoneme({ type: 'vowel', durationMs: 150, f0, f1Start: 290, f1End: 280, f2Start: 2350, f2End: 2450, gain: 0.4, noiseGen: noise }),
        // Trailing silence
        synthesizePhoneme({ type: 'silence', durationMs: 50 })
    ];

    return concatAudio(segments);
}

/**
 * Synthesizes the keyword "Lucy"
 */
function synthesizeLucy(options = {}) {
    const f0 = options.f0 || 140;
    const noise = new SeededNoise(options.seed || 202);

    const segments = [
        synthesizePhoneme({ type: 'silence', durationMs: 40 }),
        // /l/
        synthesizePhoneme({ type: 'vowel', durationMs: 100, f0, f1Start: 380, f1End: 350, f2Start: 1200, f2End: 1050, gain: 0.35, noiseGen: noise }),
        // /uː/
        synthesizePhoneme({ type: 'vowel', durationMs: 160, f0, f1Start: 340, f1End: 320, f2Start: 950, f2End: 900, gain: 0.45, noiseGen: noise }),
        // /s/ sibilant fricative
        synthesizePhoneme({ type: 'fricative', durationMs: 160, fricativeLow: 4500, fricativeHigh: 7500, gain: 0.45, noiseGen: noise }),
        // /i/
        synthesizePhoneme({ type: 'vowel', durationMs: 160, f0, f1Start: 290, f1End: 280, f2Start: 2350, f2End: 2450, gain: 0.4, noiseGen: noise }),
        synthesizePhoneme({ type: 'silence', durationMs: 50 })
    ];

    return concatAudio(segments);
}

/**
 * Synthesizes near-miss negative "Hey Lucky" (/k/ stop instead of /s/ fricative)
 */
function synthesizeHeyLucky(options = {}) {
    const f0 = options.f0 || 135;
    const noise = new SeededNoise(options.seed || 303);

    const segments = [
        synthesizePhoneme({ type: 'silence', durationMs: 40 }),
        synthesizePhoneme({ type: 'fricative', durationMs: 70, fricativeLow: 1000, fricativeHigh: 3500, gain: 0.15, noiseGen: noise }),
        synthesizePhoneme({ type: 'vowel', durationMs: 160, f0, f1Start: 520, f1End: 420, f2Start: 1800, f2End: 2200, gain: 0.5, noiseGen: noise }),
        synthesizePhoneme({ type: 'vowel', durationMs: 90, f0, f1Start: 380, f1End: 350, f2Start: 1200, f2End: 1050, gain: 0.35, noiseGen: noise }),
        synthesizePhoneme({ type: 'vowel', durationMs: 140, f0, f1Start: 340, f1End: 320, f2Start: 950, f2End: 900, gain: 0.45, noiseGen: noise }),
        // /k/ plosive stop: closure silence + sharp burst at 2200Hz
        synthesizePhoneme({ type: 'stop', durationMs: 90, burstFreq: 2200, burstMs: 25, gain: 0.4, noiseGen: noise }),
        synthesizePhoneme({ type: 'vowel', durationMs: 150, f0, f1Start: 290, f1End: 280, f2Start: 2350, f2End: 2450, gain: 0.4, noiseGen: noise }),
        synthesizePhoneme({ type: 'silence', durationMs: 50 })
    ];

    return concatAudio(segments);
}

/**
 * Synthesizes negative "Hello"
 */
function synthesizeHello(options = {}) {
    const f0 = options.f0 || 130;
    const noise = new SeededNoise(options.seed || 404);

    const segments = [
        synthesizePhoneme({ type: 'silence', durationMs: 40 }),
        synthesizePhoneme({ type: 'fricative', durationMs: 70, fricativeLow: 1000, fricativeHigh: 3500, gain: 0.15, noiseGen: noise }),
        // /ə/
        synthesizePhoneme({ type: 'vowel', durationMs: 120, f0, f1Start: 500, f1End: 500, f2Start: 1500, f2End: 1500, gain: 0.45, noiseGen: noise }),
        // /l/
        synthesizePhoneme({ type: 'vowel', durationMs: 90, f0, f1Start: 360, f1End: 350, f2Start: 1150, f2End: 1100, gain: 0.35, noiseGen: noise }),
        // /oʊ/
        synthesizePhoneme({ type: 'vowel', durationMs: 220, f0, f1Start: 450, f1End: 550, f2Start: 1100, f2End: 850, gain: 0.5, noiseGen: noise }),
        synthesizePhoneme({ type: 'silence', durationMs: 50 })
    ];

    return concatAudio(segments);
}

/**
 * Synthesizes negative "Look see"
 */
function synthesizeLookSee(options = {}) {
    const f0 = options.f0 || 135;
    const noise = new SeededNoise(options.seed || 505);

    const segments = [
        synthesizePhoneme({ type: 'silence', durationMs: 40 }),
        synthesizePhoneme({ type: 'vowel', durationMs: 90, f0, f1Start: 360, f1End: 350, f2Start: 1150, f2End: 1100, gain: 0.35, noiseGen: noise }),
        // /ʊ/
        synthesizePhoneme({ type: 'vowel', durationMs: 130, f0, f1Start: 440, f1End: 440, f2Start: 1020, f2End: 1020, gain: 0.45, noiseGen: noise }),
        // /k/
        synthesizePhoneme({ type: 'stop', durationMs: 80, burstFreq: 2200, burstMs: 20, gain: 0.4, noiseGen: noise }),
        // /s/
        synthesizePhoneme({ type: 'fricative', durationMs: 140, fricativeLow: 4500, fricativeHigh: 7500, gain: 0.4, noiseGen: noise }),
        // /i/
        synthesizePhoneme({ type: 'vowel', durationMs: 160, f0, f1Start: 290, f1End: 280, f2Start: 2350, f2End: 2450, gain: 0.4, noiseGen: noise }),
        synthesizePhoneme({ type: 'silence', durationMs: 50 })
    ];

    return concatAudio(segments);
}

/**
 * Synthesizes pure silence
 */
function synthesizeSilence(durationMs = 500) {
    const ms = (typeof durationMs === 'object' && durationMs !== null) ? (durationMs.durationMs || 500) : (Number(durationMs) || 500);
    const numSamples = Math.floor((ms / 1000) * SYNTH_SAMPLE_RATE);
    return new Float32Array(numSamples);
}

/**
 * Synthesizes stationary background white/room noise
 */
function synthesizeBackgroundNoise(durationMs = 500, amplitude = 0.01) {
    const ms = (typeof durationMs === 'object' && durationMs !== null) ? (durationMs.durationMs || 500) : (Number(durationMs) || 500);
    const amp = (typeof durationMs === 'object' && durationMs !== null && durationMs.amplitude !== undefined) ? durationMs.amplitude : amplitude;
    const numSamples = Math.floor((ms / 1000) * SYNTH_SAMPLE_RATE);
    const output = new Float32Array(numSamples);
    const noise = new SeededNoise(777);
    for (let i = 0; i < numSamples; i++) {
        output[i] = noise.next() * amp;
    }
    return output;
}

/**
 * Synthesizes pure sine tone
 */
function synthesizeSineTone(freq = 440, durationMs = 500, amplitude = 0.5) {
    const numSamples = Math.floor((durationMs / 1000) * SYNTH_SAMPLE_RATE);
    const output = new Float32Array(numSamples);
    const step = (2 * Math.PI * freq) / SYNTH_SAMPLE_RATE;
    for (let i = 0; i < numSamples; i++) {
        output[i] = Math.sin(i * step) * amplitude;
    }
    return output;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SAMPLE_RATE: SYNTH_SAMPLE_RATE,
        synthesizeHeyLucy,
        synthesizeLucy,
        synthesizeHeyLucky,
        synthesizeHello,
        synthesizeLookSee,
        synthesizeSilence,
        synthesizeBackgroundNoise,
        synthesizeSineTone
    };
}

if (typeof window !== 'undefined') {
    window.synthesizeHeyLucy = synthesizeHeyLucy;
    window.synthesizeLucy = synthesizeLucy;
    window.synthesizeHeyLucky = synthesizeHeyLucky;
    window.synthesizeHello = synthesizeHello;
    window.synthesizeLookSee = synthesizeLookSee;
    window.synthesizeSilence = synthesizeSilence;
    window.synthesizeBackgroundNoise = synthesizeBackgroundNoise;
    window.synthesizeSineTone = synthesizeSineTone;
}
