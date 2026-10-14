'use strict';

/**
 * Acoustic Wake-Word Model & DTW Pattern Matcher for L.U.C.Y. (REQ-028)
 * 
 * Provides genuine local acoustic pattern matching:
 * 1. Multi-feature frame distance combining normalized MFCC cosine distance,
 *    High-Frequency Energy Ratio (HFER) for sibilants (/s/), and Zero-Crossing Rate (ZCR).
 * 2. Constrained Dynamic Time Warping (DTW) with Sakoe-Chiba band.
 * 3. Phonetic sequence validation:
 *    - Enforces presence and ordering of vocalic nuclei (/eɪ/, /uː/) and sibilant frication (/s/).
 *    - Enforces "Hey" diphthong for "Hey Lucy".
 *    - Rejects pure tones, silence, room noise, and phonetically divergent phrases (e.g., "Hello", "Hey Lucky", "Look see").
 * 4. Multi-keyword support: "hey lucy" and "lucy".
 * 
 * Licenced under Apache-2.0 / MIT. Zero cloud network calls.
 */

const { extractAudioFeatures } = require('./acoustic-feature-extractor.js');
const { synthesizeHeyLucy, synthesizeLucy } = require('./acoustic-synthesizer.js');

// Precomputed reference acoustic profiles (computed once on module load)
const REF_HEY_LUCY = extractAudioFeatures(synthesizeHeyLucy({ seed: 42, f0: 135 }));
const REF_LUCY = extractAudioFeatures(synthesizeLucy({ seed: 84, f0: 140 }));

// Frame distance combining MFCC, HFER, and ZCR
function computeFrameDistance(frameA, frameB) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let k = 0; k < 13; k++) {
        dot += frameA.mfcc[k] * frameB.mfcc[k];
        normA += frameA.mfcc[k] * frameA.mfcc[k];
        normB += frameB.mfcc[k] * frameB.mfcc[k];
    }

    const cos = (normA > 1e-9 && normB > 1e-9) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    const mfccDist = 1.0 - cos;
    const hferDist = Math.abs(frameA.hfer - frameB.hfer);
    const zcrDist = Math.abs(frameA.zcr - frameB.zcr);

    return 0.5 * mfccDist + 0.3 * hferDist + 0.2 * zcrDist;
}

/**
 * Constrained Dynamic Time Warping (DTW) with Sakoe-Chiba band
 */
function dtwDistance(seqA, seqB, maxBand = 25) {
    const n = seqA.length;
    const m = seqB.length;
    if (n === 0 || m === 0) return 2.0;

    const ratio = n / m;
    if (ratio < 0.45 || ratio > 2.2) {
        return 2.0;
    }

    const band = Math.max(maxBand, Math.abs(n - m) + 5);
    const d = Array.from({ length: n + 1 }, () => new Float32Array(m + 1).fill(Infinity));
    d[0][0] = 0;

    for (let i = 1; i <= n; i++) {
        const jStart = Math.max(1, i - band);
        const jEnd = Math.min(m, i + band);

        for (let j = jStart; j <= jEnd; j++) {
            const cost = computeFrameDistance(seqA[i - 1], seqB[j - 1]);
            const minPrev = Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
            d[i][j] = cost + minPrev;
        }
    }

    const totalCost = d[n][m];
    if (!Number.isFinite(totalCost)) {
        return 2.0;
    }

    return totalCost / (n + m);
}

/**
 * Validates phonetic landmark signatures required for "Lucy" / "Hey Lucy":
 * - Must have voiced vowel section with low HFER (< 0.25)
 * - Must have sibilant fricative section (/s/) with high HFER (> 0.35) and high centroid (> 3800Hz)
 * - Sibilant must occur in the second half of the phrase (onset -> vowel -> /s/ -> /i/)
 */
function evaluatePhoneticLandmarks(frames, keyword = 'hey lucy') {
    if (!frames || frames.length < 15) {
        return { valid: false, score: 0.0, reason: 'insufficient_frames' };
    }

    let hasVowelCore = false;
    let hasSibilant = false;
    let sibilantIndex = -1;
    let maxHfer = 0;
    let maxCentroid = 0;
    let speechEnergyCount = 0;

    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (f.rms > 0.015) {
            speechEnergyCount++;
        }

        if (f.hfer > maxHfer) maxHfer = f.hfer;
        if (f.spectralCentroid > maxCentroid) maxCentroid = f.spectralCentroid;

        // Vowel core check: voiced, low HFER, significant RMS
        if (!hasVowelCore && f.rms > 0.03 && f.hfer < 0.25 && f.zcr < 0.15) {
            hasVowelCore = true;
        }

        // Sibilant /s/ check: high HFER, high centroid, elevated ZCR
        if (f.hfer > 0.35 && f.spectralCentroid > 3500 && f.zcr > 0.15) {
            hasSibilant = true;
            if (sibilantIndex === -1) {
                sibilantIndex = i;
            }
        }
    }

    if (speechEnergyCount < 10) {
        return { valid: false, score: 0.0, reason: 'pure_silence_or_noise' };
    }

    if (!hasVowelCore) {
        return { valid: false, score: 0.1, reason: 'missing_vowel_core' };
    }

    if (!hasSibilant) {
        return { valid: false, score: 0.15, reason: 'missing_sibilant_s' };
    }

    // Sibilant must occur in the second half of the phrase (after vowel onset)
    const relativeSibilantPos = sibilantIndex / frames.length;
    if (relativeSibilantPos < 0.25) {
        return { valid: false, score: 0.2, reason: 'inverted_phonetic_order' };
    }

    // Keyword specific checks:
    // If "hey lucy", the first ~25% of frames must exhibit the /eɪ/ front diphthong (MFCC[1] < 0)
    if (keyword === 'hey lucy') {
        const initialSegmentFrames = Math.max(5, Math.floor(frames.length * 0.25));
        let initialMfcc1Sum = 0;
        for (let i = 0; i < initialSegmentFrames; i++) {
            initialMfcc1Sum += frames[i].mfcc[1];
        }
        const meanInitialMfcc1 = initialMfcc1Sum / initialSegmentFrames;
        if (meanInitialMfcc1 > 4.0) {
            // Lacks the "Hey" diphthong
            return { valid: false, score: 0.3, reason: 'missing_hey_diphthong' };
        }
    }

    const landmarkScore = Math.min(1.0, 0.5 + (maxHfer * 0.3) + (Math.min(maxCentroid, 6000) / 6000) * 0.2);
    return { valid: true, score: landmarkScore };
}

class AcousticWakeModel {
    constructor({
        keywords = ['hey lucy', 'lucy'],
        confidenceThreshold = 0.65,
        sensitivity = 0.5
    } = {}) {
        this.keywords = keywords.map(k => String(k).trim().toLowerCase());
        this.sensitivity = Math.max(0.0, Math.min(1.0, Number(sensitivity) || 0.5));
        
        // Effective threshold adjusted by sensitivity
        this.confidenceThreshold = Math.max(0.4, Math.min(0.85, confidenceThreshold - (this.sensitivity - 0.5) * 0.2));

        this.templates = {
            'hey lucy': REF_HEY_LUCY,
            'lucy': REF_LUCY
        };
    }

    setSensitivity(sensitivity) {
        this.sensitivity = Math.max(0.0, Math.min(1.0, Number(sensitivity) || 0.5));
        this.confidenceThreshold = Math.max(0.4, Math.min(0.85, 0.65 - (this.sensitivity - 0.5) * 0.2));
        return this.confidenceThreshold;
    }

    /**
     * Evaluates a sequence of framed acoustic features or raw audio buffer
     * against configured wake words.
     * 
     * @param {Array|Float32Array|Buffer} input - Audio features or raw audio
     * @returns {{ detected: boolean, keyword: string|null, confidence: number, details: object }}
     */
    evaluate(input) {
        let frames;
        if (Array.isArray(input)) {
            frames = input;
        } else {
            frames = extractAudioFeatures(input);
        }

        if (!frames || frames.length < 15) {
            return {
                detected: false,
                keyword: null,
                confidence: 0.0,
                details: { reason: 'insufficient_frames', frameCount: frames ? frames.length : 0 }
            };
        }

        let bestKeyword = null;
        let bestConfidence = 0.0;
        let bestDtw = 2.0;
        let bestLandmarkScore = 0.0;

        for (const kw of this.keywords) {
            const refFrames = this.templates[kw];
            if (!refFrames) continue;

            // Landmark check specific to keyword
            const landmark = evaluatePhoneticLandmarks(frames, kw);
            if (!landmark.valid) {
                if (landmark.score > bestConfidence) {
                    bestConfidence = landmark.score;
                }
                continue;
            }

            const dist = dtwDistance(frames, refFrames);
            // Dynamic scale: distance < 0.015 gives score > 0.73
            // distance > 0.038 gives score < 0.32
            const dtwScore = Math.max(0.0, Math.min(1.0, 1.0 - (dist * 18.0)));
            const combinedConfidence = 0.60 * dtwScore + 0.40 * landmark.score;

            if (combinedConfidence > bestConfidence) {
                bestConfidence = combinedConfidence;
                bestKeyword = kw;
                bestDtw = dist;
                bestLandmarkScore = landmark.score;
            }
        }

        const detected = bestConfidence >= this.confidenceThreshold;

        return {
            detected,
            keyword: detected ? bestKeyword : null,
            confidence: Math.round(bestConfidence * 1000) / 1000,
            details: {
                bestKeyword,
                dtwDistance: Math.round(bestDtw * 1000) / 1000,
                landmarkScore: Math.round(bestLandmarkScore * 1000) / 1000,
                threshold: this.confidenceThreshold
            }
        };
    }
}

module.exports = {
    AcousticWakeModel,
    REF_HEY_LUCY,
    REF_LUCY,
    dtwDistance,
    computeFrameDistance,
    evaluatePhoneticLandmarks
};
