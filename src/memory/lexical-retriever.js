'use strict';

/**
 * BM25 Lexical Memory Retriever for L.U.C.Y.
 * Adapted from AILIS (reference/AILIS/electron/ailis-memory-lexical-retriever.cjs)
 * 
 * Provides local, offline lexical search across memory documents with:
 * - BM25 scoring with phrase boosting
 * - English stemming and stopword filtering
 * - CJK bi-gram tokenization
 * - Numeric term and recency boosting
 * - Soft session/category diversity penalty
 * 
 * Zero external dependencies, zero cloud API fees, deterministic and reproducible.
 */

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const PHRASE_BOOST = 0.35;
const NUMERIC_BOOST = 0.45;
const RECENCY_BOOST = 0.10;
const IMPORTANCE_BOOST = 0.15;
const CATEGORY_REPEAT_PENALTY = 0.2;
const DEFAULT_LIMIT = 6;

const STOP_WORDS = new Set([
    'a', 'about', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any',
    'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between',
    'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'during',
    'each', 'for', 'from', 'had', 'has', 'have', 'having', 'he', 'her', 'here',
    'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just',
    'me', 'more', 'most', 'my', 'of', 'on', 'once', 'or', 'other', 'our',
    'please', 'she', 'should', 'so', 'some', 'than', 'that', 'the', 'their',
    'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
    'too', 'until', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where',
    'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your'
]);

function normalizeText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    return normalized || fallback;
}

function stemToken(value = '') {
    const token = normalizeText(value).toLowerCase();
    if (token.length <= 3 || /^\d+$/.test(token)) {
        return token;
    }
    if (token.length > 5 && token.endsWith('ies')) {
        return /[bcdfghjklmnpqrstvwxyz]ies$/.test(token)
            ? `${token.slice(0, -3)}y`
            : token.slice(0, -1);
    }
    if (token.length > 6 && token.endsWith('ing')) {
        const stemmed = token.slice(0, -3);
        return /([a-z])\1$/.test(stemmed) ? stemmed.slice(0, -1) : stemmed;
    }
    if (token.length > 5 && token.endsWith('ed')) {
        const stemmed = token.slice(0, -2);
        return /([a-z])\1$/.test(stemmed) ? stemmed.slice(0, -1) : stemmed;
    }
    if (token.length > 5 && token.endsWith('es')) {
        return /(?:s|x|z|ch|sh)es$/.test(token)
            ? token.slice(0, -2)
            : token.slice(0, -1);
    }
    if (token.length > 4 && token.endsWith('s')) {
        return token.slice(0, -1);
    }
    return token;
}

function tokenize(text, { includeStopWords = false } = {}) {
    const normalized = normalizeText(text).toLowerCase();
    const tokens = [];
    for (const rawToken of normalized.match(/[a-z0-9]+/g) || []) {
        const token = stemToken(rawToken);
        if (token.length >= 2 && (includeStopWords || !STOP_WORDS.has(token))) {
            tokens.push(token);
        }
    }
    const cjkRuns = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || [];
    for (const run of cjkRuns) {
        const chars = [...run];
        if (chars.length === 1) {
            tokens.push(chars[0]);
            continue;
        }
        for (let i = 0; i < chars.length - 1; i++) {
            tokens.push(chars.slice(i, i + 2).join(''));
        }
    }
    return tokens;
}

function extractPhrases(query = '') {
    const tokens = tokenize(query);
    const phrases = [];
    for (const size of [3, 2]) {
        for (let i = 0; i <= tokens.length - size; i++) {
            const phrase = tokens.slice(i, i + size).join(' ');
            if (!phrases.includes(phrase)) {
                phrases.push(phrase);
            }
        }
    }
    return phrases.slice(0, 16);
}

function scoreDocument(docTokens, queryTokens, queryPhrases, corpusStats, docText) {
    const docLength = docTokens.length || 1;
    const avgDocLength = corpusStats.avgDocLength || 1;
    const docFreq = new Map();
    for (const t of docTokens) {
        docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }

    let score = 0;
    for (const qToken of queryTokens) {
        const freq = docFreq.get(qToken) || 0;
        if (freq === 0) continue;

        const df = corpusStats.docFrequencies.get(qToken) || 1;
        const totalDocs = corpusStats.totalDocs || 1;
        // Standard BM25 IDF
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
        // BM25 TF component
        const tf = (freq * (BM25_K1 + 1)) / (freq + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength)));
        let termScore = idf * tf;

        // Numeric term boost
        if (/^\d+$/.test(qToken)) {
            termScore *= (1 + NUMERIC_BOOST);
        }
        score += termScore;
    }

    // Phrase boost (check exact multi-word token overlap)
    if (queryPhrases.length > 0 && docText) {
        const normalizedDoc = normalizeText(docText).toLowerCase();
        for (const phrase of queryPhrases) {
            if (normalizedDoc.includes(phrase)) {
                score += PHRASE_BOOST;
            }
        }
    }

    return score;
}

/**
 * Rank memory documents against a query using BM25 and diversity filtering.
 * @param {Array<Object>} documents 
 * @param {string} query 
 * @param {Object} [options]
 * @returns {Array<Object>}
 */
function rankMemoryDocuments(documents = [], query = '', options = {}) {
    const limit = Math.max(1, options.limit || DEFAULT_LIMIT);
    const queryTokens = tokenize(query);
    if (!documents.length || !queryTokens.length) {
        return [];
    }

    const queryPhrases = extractPhrases(query);

    // Compute corpus statistics
    const tokenizedDocs = documents.map((doc) => {
        const text = `${doc.title || ''} ${doc.content || ''} ${doc.key || ''} ${(doc.tags || []).join(' ')}`;
        return {
            doc,
            text,
            tokens: tokenize(text)
        };
    });

    const totalDocs = tokenizedDocs.length;
    let totalLength = 0;
    const docFrequencies = new Map();

    for (const { tokens } of tokenizedDocs) {
        totalLength += tokens.length;
        const unique = new Set(tokens);
        for (const t of unique) {
            docFrequencies.set(t, (docFrequencies.get(t) || 0) + 1);
        }
    }

    const corpusStats = {
        totalDocs,
        avgDocLength: totalLength / Math.max(1, totalDocs),
        docFrequencies
    };

    const now = Date.now();
    const scored = [];

    for (const item of tokenizedDocs) {
        let baseScore = scoreDocument(item.tokens, queryTokens, queryPhrases, corpusStats, item.text);
        if (baseScore <= 0) continue;

        // Importance boost
        if (item.doc.importance) {
            baseScore += Number(item.doc.importance) * IMPORTANCE_BOOST;
        }

        // Recency boost (within 7 days)
        if (item.doc.updatedAt || item.doc.createdAt) {
            const ageMs = now - new Date(item.doc.updatedAt || item.doc.createdAt).getTime();
            const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
            if (ageDays < 7) {
                baseScore += (1 - ageDays / 7) * RECENCY_BOOST;
            }
        }

        scored.push({
            document: item.doc,
            score: baseScore,
            category: item.doc.category || 'general'
        });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply category diversity penalty to avoid 1 category drowning out others
    const selected = [];
    const categoryCounts = new Map();
    const pool = [...scored];

    while (selected.length < limit && pool.length) {
        let bestIdx = -1;
        let bestAdjusted = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < pool.length; i++) {
            const count = categoryCounts.get(pool[i].category) || 0;
            const penalty = Math.pow(1 - CATEGORY_REPEAT_PENALTY, count);
            const adj = pool[i].score * penalty;
            if (adj > bestAdjusted) {
                bestAdjusted = adj;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0) {
            const item = pool.splice(bestIdx, 1)[0];
            item.adjustedScore = bestAdjusted;
            selected.push(item);
            categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
        } else {
            break;
        }
    }

    return selected.map((s) => ({
        ...s.document,
        relevanceScore: Number(s.score.toFixed(3)),
        adjustedScore: Number((s.adjustedScore || s.score).toFixed(3))
    }));
}

module.exports = {
    tokenize,
    extractPhrases,
    rankMemoryDocuments
};
