'use strict';

/**
 * ContentDiscriminator (DEF-001)
 * Distinguishes between literal string parameters and generative composition prompts.
 * 
 * Prevents treating generative requests (e.g., "a thank-you letter to Bob")
 * as literal keystrokes to be typed blindly into an application.
 */

// Patterns indicating content that must be composed/generated rather than typed literally
const GENERATIVE_NOUN_PATTERNS = [
    /\b(?:a|an)\s+(?:(?:short|quick|polite|formal|friendly|professional|heartfelt|brief|detailed|comprehensive|thank-you|introductory|follow-up|resignation|recommendation|cover|love|warm|condolence|congratulatory)\s+)?(?:letter|note|email|poem|essay|story|message|summary|report|memo|draft|response|reply|greeting|haiku|apology|review|invitation|overview|outline|speech)\b/i,
    /\b(?:a|an)\s+(?:letter|note|email|poem|essay|story|message|summary|report|memo|draft|response|reply|greeting|haiku|apology|review|invitation|overview|outline|speech)\s+(?:to|for|about|regarding|on)\s+/i,
    /\b(?:draft|compose|generate|synthesize)\b/i,
    /\b(?:write|type)\s+(?:a|an)\s+(?:(?:short|quick|polite|formal|friendly|professional|heartfelt|brief|detailed|comprehensive|thank-you|introductory|follow-up|resignation|recommendation|cover|love|warm|condolence|congratulatory)\s+)?(?:letter|note|email|poem|essay|story|message|summary|report|memo|draft|response|reply|greeting|haiku|apology|review|invitation|overview|outline|speech)\b/i
];

const LITERAL_EXPLICIT_MARKERS = [
    /\btype\s+(?:the\s+)?(?:exact\s+text|exact\s+words?|literal\s+text|characters?|string)\s*[:\s]+/i,
    /\bexactly\s*:\s*/i,
    /\bliterally\s*:\s*/i
];

/**
 * Classify a captured text phrase from an instruction.
 * 
 * @param {string} capturedPhrase - The captured candidate text
 * @param {string} fullInstruction - The full user instruction
 * @param {boolean} [wasQuoted=false] - Whether the phrase was enclosed in quotes in the input
 * @returns {{ type: 'LITERAL' | 'GENERATIVE', text?: string, prompt?: string }}
 */
function classifyTextIntent(capturedPhrase, fullInstruction = '', wasQuoted = false) {
    if (!capturedPhrase || typeof capturedPhrase !== 'string') {
        return { type: 'LITERAL', text: '' };
    }

    const trimmed = capturedPhrase.trim();

    // 1. Explicit quotes in input indicate literal text (user explicitly wrapped the exact characters)
    if (wasQuoted) {
        return { type: 'LITERAL', text: trimmed };
    }

    // Check if the trimmed string itself is enclosed in quotes
    const quoteMatch = trimmed.match(/^(['"`“])([\s\S]*)\1$/);
    if (quoteMatch) {
        return { type: 'LITERAL', text: quoteMatch[2] };
    }

    // 2. Check for explicit literal markers in the full instruction
    for (const marker of LITERAL_EXPLICIT_MARKERS) {
        if (marker.test(fullInstruction)) {
            return { type: 'LITERAL', text: trimmed };
        }
    }

    // 3. Check for generative indicators
    for (const pattern of GENERATIVE_NOUN_PATTERNS) {
        if (pattern.test(trimmed) || pattern.test(fullInstruction)) {
            // If the captured phrase looks like a generative prompt, classify as GENERATIVE
            return {
                type: 'GENERATIVE',
                prompt: trimmed
            };
        }
    }

    // 4. Default: Literal text for straightforward words or tokens
    return {
        type: 'LITERAL',
        text: trimmed
    };
}

module.exports = {
    classifyTextIntent
};
