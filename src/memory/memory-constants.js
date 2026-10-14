'use strict';

const MEMORY_CATEGORIES = Object.freeze({
    CONVERSATION: 'conversation',
    USER_APPROVED: 'user_approved',
    TASK_CONTINUITY: 'task_continuity',
    PROJECT: 'project',
    WORKING_DATA: 'working_data'
});

const MEMORY_TYPES = Object.freeze({
    CONFIRMED_FACT: 'confirmed_fact',
    USER_INSTRUCTION: 'user_instruction',
    INFERRED_PREFERENCE: 'inferred_preference',
    OUTDATED: 'outdated'
});

const MEMORY_SOURCES = Object.freeze({
    USER_EXPLICIT: 'user_explicit',
    ASSISTANT_SYNTHESIS: 'assistant_synthesis',
    TASK_RECEIPT: 'task_receipt',
    UNTRUSTED_EXTERNAL: 'untrusted_external'
});

// Secret detection pattern (API keys, tokens, credentials)
const SECRET_PATTERN = /(?:sk-[a-zA-Z0-9_\-]{16,})|(?:ghp_[a-zA-Z0-9]{36})|(?:(?:api[_-]?key|secret|password|bearer|token)[-_=:\s]+[A-Za-z0-9_\-]{12,})|(?:[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,})/gi;

function redactSecrets(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(SECRET_PATTERN, '[REDACTED_SECRET]');
}

function hasSecretLikeContent(text) {
    if (!text || typeof text !== 'string') return false;
    SECRET_PATTERN.lastIndex = 0;
    return SECRET_PATTERN.test(text);
}

module.exports = {
    MEMORY_CATEGORIES,
    MEMORY_TYPES,
    MEMORY_SOURCES,
    redactSecrets,
    hasSecretLikeContent
};
