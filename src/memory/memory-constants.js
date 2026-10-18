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
    OUTDATED: 'outdated',
    PROJECT_DECISION: 'project_decision',
    PROJECT_SNAPSHOT: 'project_snapshot',
    REJECTED_DECISION: 'rejected_decision',
    SUPERSEDED: 'superseded',
    UNCERTAIN_INFERENCE: 'uncertain_inference'
});

const PROJECT_STAGES = Object.freeze({
    PROPOSED: 'proposed',
    IN_PROGRESS: 'in_progress',
    IMPLEMENTED: 'implemented',
    VERIFIED: 'verified'
});

const MEMORY_SOURCES = Object.freeze({
    USER_EXPLICIT: 'user_explicit',
    ASSISTANT_SYNTHESIS: 'assistant_synthesis',
    TASK_RECEIPT: 'task_receipt',
    UNTRUSTED_EXTERNAL: 'untrusted_external'
});

function normalizeProjectKey(projectId) {
    if (!projectId || typeof projectId !== 'string') return '';
    return projectId.trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
}

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

function isTestEnvironment() {
    return (
        process.env.NODE_ENV === 'test' ||
        Boolean(process.env.NODE_TEST_CONTEXT) ||
        Boolean(process.env.LUCY_TEST_ENVIRONMENT) ||
        (Array.isArray(process.execArgv) && process.execArgv.some(arg => typeof arg === 'string' && arg.startsWith('--test')))
    );
}

function resolveIsolatedStorageDir(options = {}, paramNames = ['memoryDir', 'storeDir']) {
    for (const param of paramNames) {
        if (options[param] && typeof options[param] === 'string') {
            return options[param];
        }
    }
    if (options.storagePath && typeof options.storagePath === 'string') {
        const path = require('path');
        return path.dirname(options.storagePath);
    }
    if (options.dbPath && typeof options.dbPath === 'string') {
        const path = require('path');
        return path.dirname(options.dbPath);
    }
    if (options.filePath && typeof options.filePath === 'string') {
        const path = require('path');
        return path.dirname(options.filePath);
    }
    if (process.env.LUCY_MEMORY_DIR && typeof process.env.LUCY_MEMORY_DIR === 'string') {
        return process.env.LUCY_MEMORY_DIR;
    }
    return null;
}

function assertStorageIsolation(componentName, options = {}, paramNames = ['memoryDir', 'storeDir']) {
    const resolved = resolveIsolatedStorageDir(options, paramNames);
    if (resolved) {
        return resolved;
    }
    if (isTestEnvironment() && !process.env.LUCY_ALLOW_LIVE_STORAGE_TESTS) {
        throw new Error(
            `[TestIsolationViolation] ${componentName} instantiated during test execution without an explicit isolated storage directory. ` +
            `Must pass options.${paramNames[0]} or set process.env.LUCY_MEMORY_DIR.`
        );
    }
    const path = require('path');
    return path.resolve(__dirname, '../../data/memory');
}

module.exports = {
    MEMORY_CATEGORIES,
    MEMORY_TYPES,
    PROJECT_STAGES,
    MEMORY_SOURCES,
    normalizeProjectKey,
    redactSecrets,
    hasSecretLikeContent,
    isTestEnvironment,
    resolveIsolatedStorageDir,
    assertStorageIsolation
};

