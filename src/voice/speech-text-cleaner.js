'use strict';

/**
 * Spoken Text Cleaner for L.U.C.Y.
 * Adapted from AILIS (reference/AILIS/src/tts-speech-text.js & electron/ailis-spoken-reply.cjs)
 * 
 * Sanitizes markdown, code blocks, URLs, and file paths to produce natural, speakable plain text.
 * Prevents speech engines from pronouncing code tokens, backticks, hex escapes, or raw URLs.
 */

const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const HTML_TAG_PATTERN = /<[^>\n]+>/g;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\([^)]+\)/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\([^)]+\)/g;
const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const WINDOWS_PATH_PATTERN = /(?:[A-Za-z]:[\\/][\w.\-\\/]+)/g;
const UNIX_PATH_PATTERN = /(?:^|\s)\/(?:[\w.\-]+\/)+[\w.\-]*/g;
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
const CONTROL_TAG_PATTERN = /\[\s*(?:action|expression|emotion|gesture|taskState|status)\s*[:=][^\]]*\]/gi;
const REPEATED_PUNCTUATION_PATTERN = /([!?.~]){2,}/g;

/**
 * Clean text for natural spoken audio.
 * @param {string} rawText 
 * @param {object} options
 * @param {number} [options.maxChars=600]
 * @returns {string}
 */
function cleanTextForSpeech(rawText, { maxChars = 600 } = {}) {
    if (!rawText || typeof rawText !== 'string') {
        return '';
    }

    let text = rawText;

    // 1. Remove control tags and persona metadata
    text = text.replace(CONTROL_TAG_PATTERN, '');

    // 2. Remove fenced code blocks completely (do not read out lines of code)
    text = text.replace(FENCED_CODE_BLOCK_PATTERN, ' (code block omitted) ');

    // 3. Remove images and replace links with anchor text
    text = text.replace(MARKDOWN_IMAGE_PATTERN, '');
    text = text.replace(MARKDOWN_LINK_PATTERN, '$1');

    // 4. Strip URLs and raw file paths
    text = text.replace(URL_PATTERN, '');
    text = text.replace(WINDOWS_PATH_PATTERN, 'file path');
    text = text.replace(UNIX_PATH_PATTERN, 'file path');

    // 5. Strip HTML tags
    text = text.replace(HTML_TAG_PATTERN, ' ');

    // 6. Simplify inline code backticks to plain text
    text = text.replace(INLINE_CODE_PATTERN, '$1');

    // 7. Strip Markdown formatting characters: bold, italic, strikethrough, headers, blockquotes, bullets
    text = text
        .replace(/^#{1,6}\s+/gm, '')           // headers
        .replace(/^\s*[-*+]\s+/gm, '')         // unordered lists
        .replace(/^\s*\d+[.)]\s+/gm, '')       // ordered lists
        .replace(/^\s*>\s*/gm, '')             // blockquotes
        .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italics
        .replace(/\|/g, ' ')                   // tables
        .replace(EMOJI_PATTERN, '');           // emojis

    // 8. Normalize punctuation and whitespace
    text = text
        .replace(REPEATED_PUNCTUATION_PATTERN, '$1')
        .replace(/\s+/g, ' ')
        .trim();

    // 9. Gracefully truncate if excessively long
    if (text.length > maxChars) {
        // Find last sentence boundary or word boundary
        const boundary = text.lastIndexOf('.', maxChars);
        if (boundary > maxChars * 0.6) {
            text = text.slice(0, boundary + 1);
        } else {
            text = text.slice(0, maxChars).trim() + '...';
        }
    }

    return text;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { cleanTextForSpeech };
}

if (typeof window !== 'undefined') {
    window.cleanTextForSpeech = cleanTextForSpeech;
}
