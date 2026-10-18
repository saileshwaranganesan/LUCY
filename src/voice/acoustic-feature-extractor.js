'use strict';

/**
 * Acoustic Feature Extraction Engine for L.U.C.Y. (REQ-028)
 * 
 * Computes speech spectral representations:
 * 1. DC offset removal, pre-emphasis filter, and Hamming windowing.
 * 2. 512-point Radix-2 Fast Fourier Transform (FFT).
 * 3. 26-band Mel-scale triangular filterbank log energies.
 * 4. 13 Mel-Frequency Cepstral Coefficients (MFCC) via DCT-II.
 * 5. Time-domain and spectral descriptors: Zero-Crossing Rate (ZCR),
 *    Spectral Centroid, High-Frequency Energy Ratio (HFER) for sibilants (/s/).
 * 6. Cepstral Mean Normalization (CMN).
 * 
 * Licenced under Apache-2.0 / MIT compatible. 100% in-memory local processing.
 */

const AFE_SAMPLE_RATE = 16000;
const AFE_FRAME_SIZE = 400; // 25ms at 16kHz
const FRAME_STEP = 160; // 10ms hop at 16kHz
const FFT_SIZE = 512;
const NUM_MEL_FILTERS = 26;
const NUM_MFCC = 13;
const PRE_EMPHASIS = 0.97;

// Precomputed Hamming window
const HAMMING_WINDOW = new Float32Array(AFE_FRAME_SIZE);
for (let n = 0; n < AFE_FRAME_SIZE; n++) {
    HAMMING_WINDOW[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (AFE_FRAME_SIZE - 1));
}

// Convert Hz to Mel
function hzToMel(hz) {
    return 2595 * Math.log10(1 + hz / 700);
}

// Convert Mel to Hz
function melToHz(mel) {
    return 700 * (Math.pow(10, mel / 2595) - 1);
}

// Build 26 Mel triangular filterbanks
function createMelFilterbanks(numFilters = NUM_MEL_FILTERS, fftSize = FFT_SIZE, sampleRate = AFE_SAMPLE_RATE, minHz = 100, maxHz = 7500) {
    const minMel = hzToMel(minHz);
    const maxMel = hzToMel(maxHz);
    const melStep = (maxMel - minMel) / (numFilters + 1);

    const melPoints = new Float32Array(numFilters + 2);
    const hzPoints = new Float32Array(numFilters + 2);
    const binPoints = new Int32Array(numFilters + 2);

    for (let i = 0; i < numFilters + 2; i++) {
        melPoints[i] = minMel + i * melStep;
        hzPoints[i] = melToHz(melPoints[i]);
        binPoints[i] = Math.floor(((fftSize + 1) * hzPoints[i]) / sampleRate);
    }

    const filterbanks = [];
    const numBins = Math.floor(fftSize / 2) + 1;

    for (let m = 1; m <= numFilters; m++) {
        const filter = new Float32Array(numBins);
        const left = binPoints[m - 1];
        const center = binPoints[m];
        const right = binPoints[m + 1];

        for (let k = left; k < center; k++) {
            if (k >= 0 && k < numBins && center > left) {
                filter[k] = (k - left) / (center - left);
            }
        }
        for (let k = center; k <= right; k++) {
            if (k >= 0 && k < numBins && right > center) {
                filter[k] = (right - k) / (right - center);
            }
        }
        filterbanks.push(filter);
    }

    return filterbanks;
}

const MEL_FILTERBANKS = createMelFilterbanks();

// Precomputed DCT-II matrix
const DCT_MATRIX = new Float32Array(NUM_MFCC * NUM_MEL_FILTERS);
for (let i = 0; i < NUM_MFCC; i++) {
    for (let j = 0; j < NUM_MEL_FILTERS; j++) {
        DCT_MATRIX[i * NUM_MEL_FILTERS + j] = Math.cos((Math.PI * i * (j + 0.5)) / NUM_MEL_FILTERS);
    }
}

/**
 * In-place Radix-2 Cooley-Tukey Fast Fourier Transform (FFT)
 * @param {Float32Array} real - real components (length must be power of 2)
 * @param {Float32Array} imag - imaginary components (length must be power of 2)
 */
function fft(real, imag) {
    const n = real.length;
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
        if (i < j) {
            const tr = real[i]; real[i] = real[j]; real[j] = tr;
            const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
        }
        let k = n >> 1;
        while (k <= j) {
            j -= k;
            k >>= 1;
        }
        j += k;
    }

    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = (-2 * Math.PI) / len;
        const wStepR = Math.cos(angle);
        const wStepI = Math.sin(angle);

        for (let i = 0; i < n; i += len) {
            let wr = 1.0;
            let wi = 0.0;
            for (let k = 0; k < half; k++) {
                const pos = i + k;
                const matchPos = pos + half;
                const tr = wr * real[matchPos] - wi * imag[matchPos];
                const ti = wr * imag[matchPos] + wi * real[matchPos];
                real[matchPos] = real[pos] - tr;
                imag[matchPos] = imag[pos] - ti;
                real[pos] += tr;
                imag[pos] += ti;

                const nextWr = wr * wStepR - wi * wStepI;
                wi = wr * wStepI + wi * wStepR;
                wr = nextWr;
            }
        }
    }
}

/**
 * Normalize arbitrary audio buffer into 16kHz mono Float32Array in [-1.0, 1.0].
 * Removes DC bias.
 */
function normalizeAudioBuffer(input) {
    if (!input) return new Float32Array(0);

    let floatSamples;
    if (input instanceof Float32Array) {
        floatSamples = new Float32Array(input.length);
        floatSamples.set(input);
    } else if (input instanceof Int16Array) {
        floatSamples = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
            floatSamples[i] = input[i] / 32768.0;
        }
    } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        // Check if WAV header (first 4 bytes RIFF)
        let byteOffset = 0;
        let isPcm16 = true;
        if (input.length >= 44 && input[0] === 0x52 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x46) {
            // Standard 44-byte WAV header
            byteOffset = 44;
        }
        const sampleCount = Math.floor((input.length - byteOffset) / 2);
        floatSamples = new Float32Array(sampleCount);
        const view = new DataView(input.buffer, input.byteOffset + byteOffset, sampleCount * 2);
        for (let i = 0; i < sampleCount; i++) {
            floatSamples[i] = view.getInt16(i * 2, true) / 32768.0;
        }
    } else if (Array.isArray(input)) {
        floatSamples = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
            floatSamples[i] = Number(input[i]) || 0;
        }
    } else {
        return new Float32Array(0);
    }

    // Remove DC offset only on long buffers (>= 1600 samples = 100ms)
    // Subtracting mean on short micro-chunks (32ms) distorts speech vowel formants!
    const len = floatSamples.length;
    if (len >= 1600) {
        let sum = 0;
        for (let i = 0; i < len; i++) {
            sum += floatSamples[i];
        }
        const dcMean = sum / len;
        for (let i = 0; i < len; i++) {
            floatSamples[i] -= dcMean;
        }
    }

    return floatSamples;
}

/**
 * Extracts acoustic features for a single 400-sample windowed frame:
 * - 13 MFCC coefficients
 * - Zero Crossing Rate (ZCR)
 * - Spectral Centroid (Hz)
 * - High-Frequency Energy Ratio (HFER: fraction of energy above 4000Hz)
 * - RMS energy
 */
function extractFrameFeatures(frame400) {
    if (frame400.length < AFE_FRAME_SIZE) {
        return null;
    }

    // 1. Pre-emphasis & windowing
    const real = new Float32Array(FFT_SIZE);
    const imag = new Float32Array(FFT_SIZE);

    let zcrCount = 0;
    let prevVal = frame400[0];
    let frameRmsSum = 0;

    for (let n = 0; n < AFE_FRAME_SIZE; n++) {
        const val = frame400[n];
        frameRmsSum += val * val;

        // Zero-crossing check
        if ((val >= 0 && prevVal < 0) || (val < 0 && prevVal >= 0)) {
            zcrCount++;
        }
        prevVal = val;

        // Pre-emphasis: s[n] - 0.97 * s[n-1]
        const preVal = n === 0 ? val : val - PRE_EMPHASIS * frame400[n - 1];
        real[n] = preVal * HAMMING_WINDOW[n];
    }

    const zcr = zcrCount / AFE_FRAME_SIZE;
    const rms = Math.sqrt(frameRmsSum / AFE_FRAME_SIZE);

    // 2. FFT
    fft(real, imag);

    // 3. Power Spectrum
    const numBins = Math.floor(FFT_SIZE / 2) + 1;
    const powerSpec = new Float32Array(numBins);
    let totalPower = 0;
    let weightedFreqSum = 0;
    let highFreqPower = 0;
    const binHz = AFE_SAMPLE_RATE / FFT_SIZE; // ~31.25 Hz per bin
    const cutoff4kHzBin = Math.floor(4000 / binHz);

    for (let k = 0; k < numBins; k++) {
        const p = (real[k] * real[k] + imag[k] * imag[k]) / FFT_SIZE;
        powerSpec[k] = p;
        totalPower += p;
        weightedFreqSum += p * (k * binHz);
        if (k >= cutoff4kHzBin) {
            highFreqPower += p;
        }
    }

    const spectralCentroid = totalPower > 1e-9 ? weightedFreqSum / totalPower : 0;
    const hfer = totalPower > 1e-9 ? highFreqPower / totalPower : 0;

    // 4. Mel Filterbank energies
    const logMelEnergies = new Float32Array(NUM_MEL_FILTERS);
    for (let m = 0; m < NUM_MEL_FILTERS; m++) {
        const filter = MEL_FILTERBANKS[m];
        let filterSum = 0;
        for (let k = 0; k < numBins; k++) {
            filterSum += powerSpec[k] * filter[k];
        }
        logMelEnergies[m] = Math.log10(Math.max(filterSum, 1e-6));
    }

    // 5. MFCCs via DCT-II
    const mfcc = new Float32Array(NUM_MFCC);
    for (let i = 0; i < NUM_MFCC; i++) {
        let sumDct = 0;
        const rowOffset = i * NUM_MEL_FILTERS;
        for (let j = 0; j < NUM_MEL_FILTERS; j++) {
            sumDct += logMelEnergies[j] * DCT_MATRIX[rowOffset + j];
        }
        mfcc[i] = sumDct;
    }

    return {
        mfcc,
        rms,
        zcr,
        spectralCentroid,
        hfer
    };
}

/**
 * Extracts a sequence of framed acoustic features from a continuous audio buffer.
 * Performs Cepstral Mean Normalization (CMN).
 */
function extractAudioFeatures(audioSamples) {
    const samples = normalizeAudioBuffer(audioSamples);
    if (samples.length < AFE_FRAME_SIZE) {
        return [];
    }

    const frames = [];
    const numFrames = Math.floor((samples.length - AFE_FRAME_SIZE) / FRAME_STEP) + 1;

    for (let f = 0; f < numFrames; f++) {
        const start = f * FRAME_STEP;
        const slice = samples.subarray(start, start + AFE_FRAME_SIZE);
        const feat = extractFrameFeatures(slice);
        if (feat) {
            frames.push(feat);
        }
    }

    if (frames.length === 0) {
        return [];
    }

    // Cepstral Mean Normalization (CMN)
    const meanMfcc = new Float32Array(NUM_MFCC);
    for (let i = 0; i < NUM_MFCC; i++) {
        let sum = 0;
        for (let f = 0; f < frames.length; f++) {
            sum += frames[f].mfcc[i];
        }
        meanMfcc[i] = sum / frames.length;
    }

    for (let f = 0; f < frames.length; f++) {
        for (let i = 0; i < NUM_MFCC; i++) {
            frames[f].mfcc[i] -= meanMfcc[i];
        }
    }

    return frames;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SAMPLE_RATE: AFE_SAMPLE_RATE,
        FRAME_SIZE: AFE_FRAME_SIZE,
        FRAME_STEP,
        NUM_MFCC,
        normalizeAudioBuffer,
        extractFrameFeatures,
        extractAudioFeatures
    };
}

if (typeof window !== 'undefined') {
    window.SAMPLE_RATE = AFE_SAMPLE_RATE;
    window.FRAME_SIZE = AFE_FRAME_SIZE;
    window.normalizeAudioBuffer = normalizeAudioBuffer;
    window.extractFrameFeatures = extractFrameFeatures;
    window.extractAudioFeatures = extractAudioFeatures;
}
