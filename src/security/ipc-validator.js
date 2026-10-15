'use strict';

/**
 * IPC & Endpoint Validation Module (Workstream 06: SEC-007 & SEC-008)
 * 
 * Enforces strict boundary verification for:
 * 1. AI Provider Endpoint URLs (HTTPS enforcement for remote, strict loopback policy)
 * 2. IPC message payloads received from renderers
 */

// -------------------------------------------------------------
// 1. Loopback & Endpoint URL Security Policy (SEC-007)
// -------------------------------------------------------------

const ALLOWED_LOOPBACK_HOSTNAMES = Object.freeze(new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]'
]));

/**
 * Check if a hostname strictly represents a local loopback address.
 * Rejects arbitrary private IP ranges (e.g. 192.168.x.x, 10.x.x.x) or internal names.
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopbackHost(hostname) {
    if (!hostname || typeof hostname !== 'string') return false;
    const lower = hostname.toLowerCase().trim();
    if (ALLOWED_LOOPBACK_HOSTNAMES.has(lower)) return true;
    // Strict IPv4 loopback range 127.0.0.0/8
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) {
        return true;
    }
    return false;
}

/**
 * Sanitize URL for safe logging/errors (masks potential embedded secrets or keys).
 * @param {string} rawUrl
 * @returns {string}
 */
function sanitizeUrlForLogging(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
        const parsed = new URL(rawUrl);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        return parsed.href;
    } catch {
        return rawUrl.replace(/[:/?&=#].*$/, '...');
    }
}

/**
 * Validate an AI provider endpoint URL.
 * Enforces:
 * - Valid URL structure
 * - Disallows embedded user credentials (user:pass@host)
 * - Remote endpoints MUST use HTTPS
 * - Insecure HTTP is ONLY permitted for loopback addresses (localhost, 127.0.0.1)
 * 
 * @param {string} urlString
 * @param {Object} [options]
 * @param {string} [options.context='Endpoint']
 * @param {boolean} [options.allowHttpLoopback=true]
 * @returns {{ ok: boolean, error?: string, code?: string, url?: string, isLoopback?: boolean }}
 */
function validateEndpointUrl(urlString, options = {}) {
    const { context = 'Endpoint', allowHttpLoopback = true } = options;

    if (typeof urlString !== 'string' || !urlString.trim()) {
        return {
            ok: false,
            code: 'INVALID_URL',
            error: `${context} URL must be a non-empty string.`
        };
    }

    const trimmed = urlString.trim();
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return {
            ok: false,
            code: 'MALFORMED_URL',
            error: `${context} URL is malformed: '${sanitizeUrlForLogging(trimmed)}'.`
        };
    }

    // Disallow embedded credentials
    if (parsed.username || parsed.password) {
        return {
            ok: false,
            code: 'EMBEDDED_CREDENTIALS_FORBIDDEN',
            error: `${context} URL must not contain embedded user credentials or API keys.`
        };
    }

    // Protocol checks: only http: and https: supported
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return {
            ok: false,
            code: 'UNSUPPORTED_PROTOCOL',
            error: `${context} protocol '${parsed.protocol}' is unsupported. Only HTTPS (or local HTTP loopback) is allowed.`
        };
    }

    const loopback = isLoopbackHost(parsed.hostname);

    if (parsed.protocol === 'http:') {
        if (!allowHttpLoopback || !loopback) {
            return {
                ok: false,
                code: 'INSECURE_HTTP_FORBIDDEN',
                error: `Remote ${context} URL '${sanitizeUrlForLogging(trimmed)}' must use HTTPS. Plaintext HTTP is strictly forbidden for remote network hosts.`
            };
        }
    }

    return {
        ok: true,
        url: parsed.href,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        isLoopback: loopback
    };
}

// -------------------------------------------------------------
// 2. Type Guards & Primitive Validators
// -------------------------------------------------------------

function isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function isNonEmptyString(val, maxLength = 1000) {
    return typeof val === 'string' && val.trim().length > 0 && val.length <= maxLength;
}

function isFiniteNumber(val, min = -Infinity, max = Infinity) {
    return typeof val === 'number' && Number.isFinite(val) && val >= min && val <= max;
}

// -------------------------------------------------------------
// 3. Centralized IPC Parameter Validators (SEC-008)
// -------------------------------------------------------------

const ALLOWED_PROVIDERS = Object.freeze(new Set([
    'gemini',
    'openrouter',
    'groq',
    'cerebras',
    'ollama',
    'custom-openai',
    'huggingface'
]));

const ALLOWED_ROUTING_MODES = Object.freeze(new Set([
    'auto',
    'prefer_local',
    'local_only',
    'free_only',
    'manual'
]));

const ALLOWED_MEMORY_CATEGORIES = Object.freeze(new Set([
    'conversation',
    'user_approved',
    'task_continuity',
    'project',
    'working_data'
]));

const ALLOWED_VOICE_STATES = Object.freeze(new Set([
    'idle',
    'listening',
    'thinking',
    'speaking',
    'error',
    'waiting_permission',
    'ready'
]));

/**
 * Validate lucy:executeRequest
 * @param {unknown} userRequest
 * @param {unknown} options
 */
function validateExecuteRequest(userRequest, options) {
    if (typeof userRequest !== 'string') {
        return { ok: false, code: 'INVALID_TYPE', error: 'User request must be a string.' };
    }
    const trimmed = userRequest.trim();
    if (trimmed.length === 0) {
        return { ok: false, code: 'EMPTY_PAYLOAD', error: 'User request cannot be empty.' };
    }
    if (userRequest.length > 64000) {
        return { ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'User request exceeds maximum allowed length of 64,000 characters.' };
    }

    if (options !== undefined && options !== null) {
        if (!isPlainObject(options)) {
            return { ok: false, code: 'INVALID_OPTIONS', error: 'Request options must be a plain object.' };
        }
        if (Object.keys(options).length > 20) {
            return { ok: false, code: 'TOO_MANY_PROPERTIES', error: 'Options object has too many properties.' };
        }
        if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
            return { ok: false, code: 'INVALID_OPTION_TYPE', error: 'Option dryRun must be a boolean.' };
        }
    }

    return { ok: true, sanitized: { userRequest: trimmed, options: options || {} } };
}

/**
 * Validate lucy:setProviderConfig
 * @param {unknown} config
 */
function validateSetProviderConfig(config) {
    if (!isPlainObject(config)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Provider configuration must be a plain object.' };
    }

    const { provider, model, apiKey, localBaseUrl, customOpenAiUrl } = config;

    if (provider !== undefined) {
        if (typeof provider !== 'string' || !ALLOWED_PROVIDERS.has(provider.toLowerCase())) {
            return { ok: false, code: 'INVALID_PROVIDER', error: `Unsupported provider '${provider}'. Allowed: ${Array.from(ALLOWED_PROVIDERS).join(', ')}.` };
        }
    }

    if (model !== undefined && model !== null) {
        if (typeof model !== 'string' || model.length > 120 || /[\r\n\t]/.test(model)) {
            return { ok: false, code: 'INVALID_MODEL', error: 'Model identifier must be a single-line string up to 120 characters.' };
        }
    }

    if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
        if (typeof apiKey !== 'string' || apiKey.length > 1024) {
            return { ok: false, code: 'INVALID_API_KEY', error: 'API key must be a string up to 1024 characters.' };
        }
    }

    if (localBaseUrl !== undefined && localBaseUrl !== null && localBaseUrl !== '') {
        const urlCheck = validateEndpointUrl(localBaseUrl, { context: 'Local Base' });
        if (!urlCheck.ok) {
            return urlCheck;
        }
    }

    if (customOpenAiUrl !== undefined && customOpenAiUrl !== null && customOpenAiUrl !== '') {
        const urlCheck = validateEndpointUrl(customOpenAiUrl, { context: 'Custom OpenAI' });
        if (!urlCheck.ok) {
            return urlCheck;
        }
    }

    return { ok: true };
}

/**
 * Validate lucy:clearApiKey
 * @param {unknown} provider
 */
function validateClearApiKey(provider) {
    if (provider !== undefined && provider !== null && provider !== '') {
        if (typeof provider !== 'string' || !ALLOWED_PROVIDERS.has(provider.toLowerCase())) {
            return { ok: false, code: 'INVALID_PROVIDER', error: `Invalid provider '${provider}'.` };
        }
    }
    return { ok: true };
}

/**
 * Validate lucy:permissionResponse
 * @param {unknown} payload
 */
function validatePermissionResponse(payload) {
    if (!isPlainObject(payload)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Permission response payload must be a plain object.' };
    }
    const { auditId, approved } = payload;
    if (typeof auditId !== 'string' || auditId.length < 5 || auditId.length > 120 || !/^[a-zA-Z0-9_\-]+$/.test(auditId)) {
        return { ok: false, code: 'INVALID_AUDIT_ID', error: 'Invalid or malformed auditId format.' };
    }
    if (typeof approved !== 'boolean' && typeof approved !== 'number') {
        return { ok: false, code: 'INVALID_APPROVAL_VALUE', error: 'Approval decision must be a boolean.' };
    }

    return { ok: true, sanitized: { auditId, approved: Boolean(approved) } };
}

/**
 * Validate lucy:getMemories
 * @param {unknown} options
 */
function validateGetMemories(options) {
    if (options === undefined || options === null) {
        return { ok: true, sanitized: {} };
    }

    if (typeof options === 'string') {
        const lower = options.toLowerCase().trim();
        if (lower && !ALLOWED_MEMORY_CATEGORIES.has(lower)) {
            return { ok: false, code: 'INVALID_CATEGORY', error: `Unknown memory category '${options}'.` };
        }
        return { ok: true, sanitized: { category: lower } };
    }

    if (isPlainObject(options)) {
        const { category, limit, query } = options;
        if (category && (typeof category !== 'string' || !ALLOWED_MEMORY_CATEGORIES.has(category.toLowerCase().trim()))) {
            return { ok: false, code: 'INVALID_CATEGORY', error: `Unknown memory category '${category}'.` };
        }
        if (limit !== undefined && (!isFiniteNumber(limit, 1, 1000))) {
            return { ok: false, code: 'INVALID_LIMIT', error: 'Memory query limit must be an integer between 1 and 1000.' };
        }
        if (query !== undefined && (typeof query !== 'string' || query.length > 1000)) {
            return { ok: false, code: 'INVALID_QUERY', error: 'Memory query string must be up to 1000 characters.' };
        }
        return { ok: true, sanitized: options };
    }

    return { ok: false, code: 'INVALID_TYPE', error: 'Options must be a category string or query object.' };
}

/**
 * Validate lucy:addMemory
 * @param {unknown} entry
 */
function validateAddMemory(entry) {
    if (!isPlainObject(entry)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Memory entry must be a plain object.' };
    }

    const content = entry.content || entry.text;
    if (typeof content !== 'string' || content.trim().length === 0) {
        return { ok: false, code: 'EMPTY_CONTENT', error: 'Memory entry must contain non-empty content.' };
    }
    if (content.length > 32768) {
        return { ok: false, code: 'CONTENT_TOO_LARGE', error: 'Memory content exceeds maximum limit of 32,768 characters.' };
    }

    if (entry.category !== undefined && entry.category !== null) {
        if (typeof entry.category !== 'string' || !ALLOWED_MEMORY_CATEGORIES.has(entry.category.toLowerCase().trim())) {
            return { ok: false, code: 'INVALID_CATEGORY', error: `Unknown memory category '${entry.category}'.` };
        }
    }

    if (entry.key !== undefined && entry.key !== null) {
        if (typeof entry.key !== 'string' || entry.key.length > 200) {
            return { ok: false, code: 'INVALID_KEY', error: 'Memory key must be a string up to 200 characters.' };
        }
    }

    return { ok: true };
}

/**
 * Validate identifier string (memory ID, task ID, etc.)
 * @param {unknown} id
 * @param {string} [name='Identifier']
 */
function validateIdentifier(id, name = 'Identifier') {
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 200) {
        return { ok: false, code: 'INVALID_ID', error: `${name} must be a non-empty string up to 200 characters.` };
    }
    return { ok: true, sanitized: id.trim() };
}

/**
 * Validate lucy:clearMemoryCategory
 * @param {unknown} category
 */
function validateClearMemoryCategory(category) {
    if (typeof category !== 'string' || !ALLOWED_MEMORY_CATEGORIES.has(category.toLowerCase().trim())) {
        return { ok: false, code: 'INVALID_CATEGORY', error: `Unknown memory category '${category}'.` };
    }
    return { ok: true, sanitized: category.toLowerCase().trim() };
}

/**
 * Validate lucy:sendVoiceState
 * @param {unknown} voiceData
 */
function validateSendVoiceState(voiceData) {
    if (!isPlainObject(voiceData)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Voice state payload must be a plain object.' };
    }

    if (voiceData.state !== undefined && voiceData.state !== null) {
        if (typeof voiceData.state !== 'string' || !ALLOWED_VOICE_STATES.has(voiceData.state.toLowerCase())) {
            return { ok: false, code: 'INVALID_VOICE_STATE', error: `Invalid voice state '${voiceData.state}'.` };
        }
    }

    if (voiceData.transcript !== undefined && voiceData.transcript !== null) {
        if (typeof voiceData.transcript !== 'string' || voiceData.transcript.length > 10000) {
            return { ok: false, code: 'INVALID_TRANSCRIPT', error: 'Voice transcript must be a string up to 10,000 characters.' };
        }
    }

    return { ok: true };
}

/**
 * Validate companion:moveWindow
 * @param {unknown} payload
 */
function validateMoveWindow(payload) {
    if (!isPlainObject(payload)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Window move payload must be a plain object.' };
    }
    const { deltaX, deltaY } = payload;
    if (!isFiniteNumber(deltaX, -10000, 10000) || !isFiniteNumber(deltaY, -10000, 10000)) {
        return { ok: false, code: 'INVALID_COORDINATES', error: 'Move delta values must be finite numbers within -10000 to +10000.' };
    }
    return { ok: true, sanitized: { deltaX, deltaY } };
}

/**
 * Validate lucy:discoverOllamaModels
 * @param {unknown} endpointUrl
 */
function validateDiscoverOllamaModels(endpointUrl) {
    if (endpointUrl === undefined || endpointUrl === null || endpointUrl === '') {
        return { ok: true, sanitized: 'http://127.0.0.1:11434' };
    }
    if (typeof endpointUrl !== 'string') {
        return { ok: false, code: 'INVALID_TYPE', error: 'Ollama endpoint URL must be a string.' };
    }
    const check = validateEndpointUrl(endpointUrl, { context: 'Local Ollama endpoint', allowHttpLoopback: true });
    if (!check.ok) {
        return { ok: false, code: check.code, error: check.error };
    }
    return { ok: true, sanitized: check.url };
}

/**
 * Validate lucy:cancelRequest
 * @param {unknown} taskId
 */
function validateCancelRequest(taskId) {
    return validateIdentifier(taskId, 'Task ID');
}

/**
 * Validate lucy:setVoiceConfig
 * @param {unknown} config
 * @returns {ValidationResult}
 */
function validateVoiceConfig(config) {
    if (!isPlainObject(config)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Voice configuration must be a plain object.' };
    }

    if (config.resetToDefaults === true) {
        return {
            ok: true,
            sanitized: {
                pitch: 1.05,
                rate: 1.02,
                volume: 1.0,
                voiceName: '',
                preferredVoiceName: '',
                ttsEnabled: true,
                resetToDefaults: true
            }
        };
    }

    const { pitch, rate, volume, voiceName, preferredVoiceName, ttsEnabled } = config;
    const sanitized = {};

    if (pitch !== undefined && pitch !== null) {
        const p = Number(pitch);
        if (!Number.isFinite(p) || p < 0.5 || p > 1.5) {
            return { ok: false, code: 'INVALID_PITCH', error: 'Voice pitch must be a finite number between 0.5 and 1.5.' };
        }
        sanitized.pitch = p;
    }

    if (rate !== undefined && rate !== null) {
        const r = Number(rate);
        if (!Number.isFinite(r) || r < 0.5 || r > 1.5) {
            return { ok: false, code: 'INVALID_RATE', error: 'Voice speech rate must be a finite number between 0.5 and 1.5.' };
        }
        sanitized.rate = r;
    }

    if (volume !== undefined && volume !== null) {
        const v = Number(volume);
        if (!Number.isFinite(v) || v < 0 || v > 1.0) {
            return { ok: false, code: 'INVALID_VOLUME', error: 'Voice volume must be a finite number between 0.0 and 1.0.' };
        }
        sanitized.volume = v;
    }

    const name = voiceName !== undefined ? voiceName : preferredVoiceName;
    if (name !== undefined && name !== null) {
        if (typeof name !== 'string' || name.length > 120 || /[\r\n\t]/.test(name)) {
            return { ok: false, code: 'INVALID_VOICE_NAME', error: 'Voice name must be a single-line string up to 120 characters.' };
        }
        sanitized.voiceName = name;
        sanitized.preferredVoiceName = name;
    }

    if (ttsEnabled !== undefined && ttsEnabled !== null) {
        if (typeof ttsEnabled !== 'boolean') {
            return { ok: false, code: 'INVALID_TTS_FLAG', error: 'ttsEnabled must be a boolean.' };
        }
        sanitized.ttsEnabled = ttsEnabled;
    }

    const { wakeWordEnabled, wakeWordSensitivity } = config;
    if (wakeWordEnabled !== undefined && wakeWordEnabled !== null) {
        if (typeof wakeWordEnabled !== 'boolean') {
            return { ok: false, code: 'INVALID_WAKE_WORD_FLAG', error: 'wakeWordEnabled must be a boolean.' };
        }
        sanitized.wakeWordEnabled = wakeWordEnabled;
    }

    if (wakeWordSensitivity !== undefined && wakeWordSensitivity !== null) {
        const s = Number(wakeWordSensitivity);
        if (!Number.isFinite(s) || s < 0.0 || s > 1.0) {
            return { ok: false, code: 'INVALID_WAKE_WORD_SENSITIVITY', error: 'wakeWordSensitivity must be a finite number between 0.0 and 1.0.' };
        }
        sanitized.wakeWordSensitivity = s;
    }

    return { ok: true, sanitized };
}

/**
 * Validate audio transcription request from renderer (REQ-027 & SEC-008).
 * Caps payload size at 25MB to prevent memory exhaustion and validates options.
 */
function validateTranscribeAudioRequest(audioData, options = {}) {
    if (!audioData) {
        return { ok: false, code: 'EMPTY_AUDIO', error: 'Audio data is required for transcription.' };
    }

    let buffer;
    if (Buffer.isBuffer(audioData)) {
        buffer = audioData;
    } else if (audioData instanceof Uint8Array || audioData instanceof ArrayBuffer) {
        buffer = Buffer.from(audioData);
    } else if (typeof audioData === 'string') {
        // Base64 encoded audio
        try {
            buffer = Buffer.from(audioData, 'base64');
        } catch {
            return { ok: false, code: 'INVALID_AUDIO_FORMAT', error: 'Could not decode base64 audio payload.' };
        }
    } else {
        return { ok: false, code: 'INVALID_AUDIO_TYPE', error: 'Audio data must be a Buffer, Uint8Array, or base64 string.' };
    }

    if (buffer.length === 0) {
        return { ok: false, code: 'EMPTY_AUDIO', error: 'Audio payload contains 0 bytes.' };
    }

    const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB limit
    if (buffer.length > MAX_AUDIO_BYTES) {
        return { ok: false, code: 'PAYLOAD_TOO_LARGE', error: `Audio payload exceeds maximum permitted size of 25MB (${buffer.length} bytes).` };
    }

    const sanitizedOptions = {};
    if (options && typeof options === 'object') {
        if (options.language !== undefined && options.language !== null) {
            if (typeof options.language !== 'string' || !/^[a-zA-Z-]{2,10}$/.test(options.language)) {
                return { ok: false, code: 'INVALID_LANGUAGE', error: 'Language must be an ISO language code (e.g. en, es, en-US).' };
            }
            sanitizedOptions.language = options.language.trim();
        }
        if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
            const t = Number(options.timeoutMs);
            if (!Number.isInteger(t) || t < 1000 || t > 120000) {
                return { ok: false, code: 'INVALID_TIMEOUT', error: 'timeoutMs must be an integer between 1000 and 120000 ms.' };
            }
            sanitizedOptions.timeoutMs = t;
        }
    }

    return {
        ok: true,
        sanitized: {
            audioBuffer: buffer,
            options: sanitizedOptions
        }
    };
}

/**
 * Validate lucy:saveConnection
 * @param {unknown} payload
 */
function validateSaveConnection(payload) {
    if (!isPlainObject(payload)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Connection payload must be a plain object.' };
    }
    const { provider, label, apiKey, baseUrl, defaultModel, priority, freeOnly, enabled, id } = payload;
    if (typeof provider !== 'string' || !ALLOWED_PROVIDERS.has(provider.toLowerCase())) {
        return { ok: false, code: 'INVALID_PROVIDER', error: `Unsupported provider '${provider}'. Allowed: ${Array.from(ALLOWED_PROVIDERS).join(', ')}.` };
    }
    if (label !== undefined && label !== null) {
        if (typeof label !== 'string' || label.length > 80 || /[\r\n]/.test(label)) {
            return { ok: false, code: 'INVALID_LABEL', error: 'Label must be a single-line string up to 80 characters.' };
        }
    }
    if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
        if (typeof apiKey !== 'string' || apiKey.length > 1024) {
            return { ok: false, code: 'INVALID_API_KEY', error: 'API key must be a string up to 1024 characters.' };
        }
    }
    if (baseUrl !== undefined && baseUrl !== null && baseUrl !== '') {
        const urlCheck = validateEndpointUrl(baseUrl, { context: 'Connection endpoint', allowHttpLoopback: true });
        if (!urlCheck.ok) return urlCheck;
    }
    if (defaultModel !== undefined && defaultModel !== null && defaultModel !== '') {
        if (typeof defaultModel !== 'string' || defaultModel.length > 120 || /[\r\n]/.test(defaultModel)) {
            return { ok: false, code: 'INVALID_MODEL', error: 'Model identifier must be a single-line string up to 120 characters.' };
        }
    }
    if (priority !== undefined && priority !== null) {
        if (!isFiniteNumber(priority, 1, 100)) {
            return { ok: false, code: 'INVALID_PRIORITY', error: 'Priority must be an integer between 1 and 100.' };
        }
    }
    if (freeOnly !== undefined && typeof freeOnly !== 'boolean') {
        return { ok: false, code: 'INVALID_FREE_ONLY', error: 'freeOnly must be a boolean.' };
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
        return { ok: false, code: 'INVALID_ENABLED', error: 'enabled must be a boolean.' };
    }
    if (id !== undefined && id !== null) {
        if (typeof id !== 'string' || id.length > 64 || !/^[a-zA-Z0-9_\-]+$/.test(id)) {
            return { ok: false, code: 'INVALID_ID', error: 'Connection ID must be alphanumeric string with underscores or hyphens up to 64 chars.' };
        }
    }
    return { ok: true, sanitized: payload };
}

/**
 * Validate lucy:updateConnection
 * @param {unknown} payload
 */
function validateUpdateConnection(payload) {
    if (!isPlainObject(payload)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Update payload must be a plain object.' };
    }
    const { id, enabled, label, defaultModel, priority, freeOnly, apiKey, baseUrl } = payload;
    if (typeof id !== 'string' || !id.trim() || id.length > 64) {
        return { ok: false, code: 'INVALID_ID', error: 'Connection ID must be a non-empty string.' };
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
        return { ok: false, code: 'INVALID_ENABLED', error: 'enabled must be a boolean.' };
    }
    if (label !== undefined && label !== null) {
        if (typeof label !== 'string' || label.length > 80 || /[\r\n]/.test(label)) {
            return { ok: false, code: 'INVALID_LABEL', error: 'Label must be a single-line string up to 80 characters.' };
        }
    }
    if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
        if (typeof apiKey !== 'string' || apiKey.length > 1024) {
            return { ok: false, code: 'INVALID_API_KEY', error: 'API key must be a string up to 1024 characters.' };
        }
    }
    if (baseUrl !== undefined && baseUrl !== null && baseUrl !== '') {
        const urlCheck = validateEndpointUrl(baseUrl, { context: 'Connection endpoint', allowHttpLoopback: true });
        if (!urlCheck.ok) return urlCheck;
    }
    if (defaultModel !== undefined && defaultModel !== null && defaultModel !== '') {
        if (typeof defaultModel !== 'string' || defaultModel.length > 120 || /[\r\n]/.test(defaultModel)) {
            return { ok: false, code: 'INVALID_MODEL', error: 'Model identifier must be a single-line string up to 120 characters.' };
        }
    }
    if (priority !== undefined && priority !== null) {
        if (!isFiniteNumber(priority, 1, 100)) {
            return { ok: false, code: 'INVALID_PRIORITY', error: 'Priority must be an integer between 1 and 100.' };
        }
    }
    if (freeOnly !== undefined && typeof freeOnly !== 'boolean') {
        return { ok: false, code: 'INVALID_FREE_ONLY', error: 'freeOnly must be a boolean.' };
    }
    return { ok: true, sanitized: payload };
}

/**
 * Validate lucy:deleteConnection
 * @param {unknown} payload
 */
function validateDeleteConnection(payload) {
    const id = typeof payload === 'string' ? payload : (payload && payload.id);
    if (typeof id !== 'string' || !id.trim() || id.length > 64) {
        return { ok: false, code: 'INVALID_ID', error: 'Connection ID must be a non-empty string.' };
    }
    return { ok: true, sanitized: { id: id.trim() } };
}

/**
 * Validate lucy:testConnection
 * @param {unknown} payload
 */
function validateTestConnection(payload) {
    const id = typeof payload === 'string' ? payload : (payload && payload.id);
    if (typeof id !== 'string' || !id.trim() || id.length > 64) {
        return { ok: false, code: 'INVALID_ID', error: 'Connection ID must be a non-empty string.' };
    }
    return { ok: true, sanitized: { id: id.trim() } };
}

/**
 * Validate lucy:setRoutingConfig
 * @param {unknown} config
 */
function validateSetRoutingConfig(config) {
    if (!isPlainObject(config)) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Routing configuration must be a plain object.' };
    }
    const { mode, taskOverrides, manualProvider, manualModel, maxBudgetUsd } = config;
    if (mode !== undefined) {
        if (typeof mode !== 'string' || !ALLOWED_ROUTING_MODES.has(mode.toLowerCase())) {
            return { ok: false, code: 'INVALID_MODE', error: `Unsupported routing mode '${mode}'. Allowed: ${Array.from(ALLOWED_ROUTING_MODES).join(', ')}.` };
        }
    }
    if (manualProvider !== undefined && manualProvider !== null && manualProvider !== '') {
        if (typeof manualProvider !== 'string' || !ALLOWED_PROVIDERS.has(manualProvider.toLowerCase())) {
            return { ok: false, code: 'INVALID_PROVIDER', error: `Unsupported provider '${manualProvider}'.` };
        }
    }
    if (manualModel !== undefined && manualModel !== null && manualModel !== '') {
        if (typeof manualModel !== 'string' || manualModel.length > 120 || /[\r\n]/.test(manualModel)) {
            return { ok: false, code: 'INVALID_MODEL', error: 'Manual model must be a single-line string up to 120 characters.' };
        }
    }
    if (taskOverrides !== undefined && taskOverrides !== null) {
        if (!isPlainObject(taskOverrides)) {
            return { ok: false, code: 'INVALID_TASK_OVERRIDES', error: 'taskOverrides must be a plain object mapping task categories.' };
        }
    }
    if (maxBudgetUsd !== undefined && maxBudgetUsd !== null) {
        if (!isFiniteNumber(maxBudgetUsd, 0, 100000)) {
            return { ok: false, code: 'INVALID_BUDGET', error: 'maxBudgetUsd must be a positive number.' };
        }
    }
    return { ok: true, sanitized: config };
}

module.exports = {
    // Loopback & URL validation
    isLoopbackHost,
    validateEndpointUrl,
    sanitizeUrlForLogging,
    ALLOWED_LOOPBACK_HOSTNAMES,

    // IPC validation
    validateExecuteRequest,
    validateSetProviderConfig,
    validateClearApiKey,
    validatePermissionResponse,
    validateGetMemories,
    validateAddMemory,
    validateIdentifier,
    validateClearMemoryCategory,
    validateSendVoiceState,
    validateMoveWindow,
    validateDiscoverOllamaModels,
    validateCancelRequest,
    validateVoiceConfig,
    validateTranscribeAudioRequest,

    // Multi-provider & Connection validators
    validateSaveConnection,
    validateUpdateConnection,
    validateDeleteConnection,
    validateTestConnection,
    validateSetRoutingConfig,

    // Constant sets
    ALLOWED_PROVIDERS,
    ALLOWED_ROUTING_MODES,
    ALLOWED_MEMORY_CATEGORIES,
    ALLOWED_VOICE_STATES
};
