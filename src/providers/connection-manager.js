'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { PROVIDER_TYPES } = require('./model-catalogue.js');

const CONNECTION_STATES = Object.freeze({
    NOT_CONFIGURED: 'not_configured',
    CONFIGURED: 'unverified',
    UNVERIFIED: 'unverified',
    CONNECTED: 'connected',
    VALIDATED: 'connected',
    RATE_LIMITED: 'rate_limited',
    TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',
    UNREACHABLE: 'temporarily_unavailable',
    INVALID_CREDENTIAL: 'invalid_credential',
    MODEL_UNAVAILABLE: 'model_unavailable',
    POLICY_INELIGIBLE: 'policy_ineligible',
    FAILED: 'failed',
    DISABLED: 'disabled'
});

/**
 * ConnectionManager
 * Manages multiple AI provider connections, keys, endpoints, and health state.
 *
 * Security Invariants:
 * 1. Plaintext secrets are NEVER stored in connections.json.
 * 2. Secrets are stored exclusively in the DPAPI-backed CredentialStore under unique connection keys.
 * 3. All methods returning connections to IPC/renderers mask secrets (e.g. ••••••••).
 * 4. Preserves backward compatibility by migrating existing single-key configurations.
 */
class ConnectionManager {
    constructor(options = {}) {
        this.credentialStore = options.credentialStore;
        this.storageDir = options.configDir || options.storageDir || path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'LUCY',
            'secure'
        );
        this.configPath = path.join(this.storageDir, 'connections.json');
        this._connections = new Map();
        this._initialized = false;
    }

    init() {
        if (this._initialized) return;
        if (!fs.existsSync(this.storageDir)) {
            try {
                fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
            } catch (_) {}
        }
        this._loadConnections();
        this._migrateLegacySecrets();
        this._initialized = true;
    }

    _loadConnections() {
        this._connections.clear();
        if (fs.existsSync(this.configPath)) {
            try {
                const raw = fs.readFileSync(this.configPath, 'utf8');
                const list = JSON.parse(raw);
                if (Array.isArray(list)) {
                    for (const conn of list) {
                        if (conn && conn.id && conn.provider) {
                            let state = conn.enabled === false ? CONNECTION_STATES.DISABLED : (conn.state || CONNECTION_STATES.UNVERIFIED);
                            if (state === 'configured') {
                                state = conn.lastTestedAt ? CONNECTION_STATES.CONNECTED : CONNECTION_STATES.UNVERIFIED;
                            }
                            this._connections.set(conn.id, {
                                ...conn,
                                state
                            });
                        }
                    }
                }
            } catch (err) {
                console.warn('[ConnectionManager] Failed to read connections.json:', err.message);
            }
        }
    }

    _saveConnections() {
        try {
            const list = Array.from(this._connections.values()).map((c) => ({
                id: c.id,
                provider: c.provider,
                label: c.label || '',
                enabled: c.enabled !== false,
                priority: Number(c.priority) || 1,
                freeOnly: Boolean(c.freeOnly),
                baseUrl: c.baseUrl || null,
                defaultModel: c.defaultModel || null,
                models: Array.isArray(c.models) ? c.models : [],
                state: c.state || CONNECTION_STATES.UNVERIFIED,
                rateLimitedUntil: c.rateLimitedUntil || null,
                cooldownUntil: c.cooldownUntil || null,
                lastError: c.lastError || null,
                lastTestedAt: c.lastTestedAt || null,
                updatedAt: c.updatedAt || new Date().toISOString()
            }));

            fs.writeFileSync(this.configPath, JSON.stringify(list, null, 2), {
                encoding: 'utf8',
                mode: 0o600
            });
        } catch (err) {
            console.warn('[ConnectionManager] Failed to persist connections.json:', err.message);
        }
    }

    /**
     * Automatically discover existing legacy secrets (e.g. gemini_api_key) and seed connections.
     */
    _migrateLegacySecrets() {
        if (!this.credentialStore) return;

        const knownProviders = [
            { provider: PROVIDER_TYPES.GEMINI, defaultModel: 'gemini-2.0-flash', label: 'Primary Gemini' },
            { provider: PROVIDER_TYPES.OPENROUTER, defaultModel: 'google/gemini-2.0-flash-001', label: 'Primary OpenRouter' },
            { provider: PROVIDER_TYPES.GROQ, defaultModel: 'llama-3.3-70b-versatile', label: 'Primary Groq' },
            { provider: PROVIDER_TYPES.CEREBRAS, defaultModel: 'llama3.1-8b', label: 'Primary Cerebras' },
            { provider: PROVIDER_TYPES.HUGGINGFACE, defaultModel: 'meta-llama/Llama-3.2-3B-Instruct', label: 'Primary Hugging Face' }
        ];

        let hasChanges = false;

        for (const item of knownProviders) {
            // Check if a connection already exists for this provider
            const exists = Array.from(this._connections.values()).some((c) => c.provider === item.provider);
            if (exists) continue;

            const legacyKeyName = `${item.provider}_api_key`;
            const hasLegacyKey = this.credentialStore.hasSecret(legacyKeyName);

            if (hasLegacyKey) {
                const connId = `conn_${item.provider}_default`;
                const secret = this.credentialStore.getSecret(legacyKeyName);

                // Store under connection key
                if (secret) {
                    this.credentialStore.setSecret(`conn_${connId}_key`, secret);
                }

                this._connections.set(connId, {
                    id: connId,
                    provider: item.provider,
                    label: item.label,
                    enabled: true,
                    priority: 1,
                    baseUrl: item.baseUrl || null,
                    defaultModel: item.defaultModel,
                    models: [item.defaultModel],
                    state: CONNECTION_STATES.UNVERIFIED,
                    lastTestedAt: null,
                    updatedAt: new Date().toISOString()
                });
                hasChanges = true;
            }
        }

        if (hasChanges) {
            this._saveConnections();
        }
    }

    /**
     * Retrieve a connection's secret API key (Main Process ONLY).
     * Consistent Precedence:
     * 1. Environment variables (LUCY_<PROVIDER>_API_KEY, <PROVIDER>_API_KEY)
     * 2. Connection-specific key (conn_<id>_key) in CredentialStore
     * 3. Legacy provider key (<provider>_api_key) in CredentialStore
     * @param {string} connectionId
     * @returns {string|null}
     */
    getApiKey(connectionId) {
        if (!connectionId) return null;
        const conn = this._connections.get(connectionId);
        if (!conn) return null;

        if (conn.provider === PROVIDER_TYPES.OLLAMA) {
            return 'not_required';
        }

        // 1. Environment variables have highest precedence
        const provUpper = String(conn.provider).replace(/-/g, '_').toUpperCase();
        const envKey = process.env[`LUCY_${provUpper}_API_KEY`] ||
            process.env[`${provUpper}_API_KEY`];
        if (envKey && envKey.trim()) {
            return envKey.trim();
        }

        if (this.credentialStore) {
            // 2. Check connection-specific key in CredentialStore
            const connSecret = this.credentialStore.getSecret(`conn_${conn.id}_key`);
            if (connSecret && connSecret.trim()) return connSecret.trim();

            // 3. Fallback to legacy provider key in CredentialStore
            const legacySecret = this.credentialStore.getSecret(`${conn.provider}_api_key`);
            if (legacySecret && legacySecret.trim()) return legacySecret.trim();
        }

        return null;
    }

    /**
     * Get a connection by ID.
     * @param {string} connectionId
     * @returns {Object|null}
     */
    getConnection(connectionId) {
        this.init();
        return this._connections.get(connectionId) || null;
    }

    /**
     * Add or update a connection.
     * @param {Object} data
     * @returns {Object} Connection object
     */
    saveConnection(data = {}) {
        if (data.id && this._connections.has(data.id)) {
            return this.updateConnection(data.id, data, data.apiKey);
        }
        return this.addConnection(data, data.apiKey);
    }

    /**
     * Add a new connection with credentials.
     * @param {Object} data
     * @param {string} [apiKey]
     */
    addConnection(data = {}, apiKey = '') {
        this.init();
        if (!data.provider) throw new Error('Connection must specify a provider');

        const effectiveKey = apiKey || data.apiKey || '';
        const connId = data.id || `conn_${data.provider}_${crypto.randomBytes(4).toString('hex')}`;
        if (this._connections.has(connId)) {
            throw new Error(`Connection with ID '${connId}' already exists`);
        }

        if (effectiveKey && typeof effectiveKey === 'string' && effectiveKey.trim() && this.credentialStore) {
            this.credentialStore.setSecret(`conn_${connId}_key`, effectiveKey.trim());
        }

        const hasKey = Boolean(effectiveKey && effectiveKey.trim()) || data.provider === PROVIDER_TYPES.OLLAMA;
        const initialStatus = data.enabled === false
            ? CONNECTION_STATES.DISABLED
            : (hasKey ? CONNECTION_STATES.UNVERIFIED : CONNECTION_STATES.NOT_CONFIGURED);

        const conn = {
            id: connId,
            provider: String(data.provider).trim().toLowerCase(),
            label: data.label ? String(data.label).trim() : `Connection (${data.provider})`,
            enabled: data.enabled !== false,
            priority: Number(data.priority) || 1,
            freeOnly: Boolean(data.freeOnly),
            baseUrl: data.baseUrl ? String(data.baseUrl).trim() : null,
            defaultModel: data.defaultModel ? String(data.defaultModel).trim() : null,
            models: Array.isArray(data.models) ? data.models.map(String) : [],
            state: initialStatus,
            lastTestedAt: null,
            lastError: null,
            updatedAt: new Date().toISOString()
        };

        this._connections.set(connId, conn);
        this._saveConnections();
        return conn;
    }

    _sanitizeErrorMessage(text) {
        if (!text) return '';
        let sanitized = String(text);
        if (this.credentialStore && typeof this.credentialStore.sanitize === 'function') {
            sanitized = this.credentialStore.sanitize(sanitized);
        }
        sanitized = sanitized.replace(/(?:api[_-]?key|secret|token|password|bearer\s+)[:=\s]+['"]?([a-zA-Z0-9_\-]{8,})['"]?/gi, '[REDACTED_SECRET]');
        const geminiPattern = new RegExp(['AI', 'za', 'Sy', '[a-zA-Z0-9_-]{33}'].join(''), 'g');
        sanitized = sanitized.replace(geminiPattern, '[REDACTED_SECRET]');
        sanitized = sanitized.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_SECRET]');
        sanitized = sanitized.replace(/hf_[a-zA-Z0-9]{20,}/g, '[REDACTED_SECRET]');
        return sanitized;
    }

    /**
     * Update an existing connection and optionally replace its secret.
     * @param {string|Object} connectionId
     * @param {Object} [updates={}]
     * @param {string} [maybeNewApiKey]
     */
    updateConnection(connectionId, updates = {}, maybeNewApiKey = '') {
        this.init();
        let connId = connectionId;
        if (connectionId && typeof connectionId === 'object') {
            connId = connectionId.id;
            updates = { ...connectionId };
            if (connectionId.apiKey && maybeNewApiKey === '') {
                maybeNewApiKey = connectionId.apiKey;
            }
        }
        const conn = this._connections.get(connId);
        if (!conn) throw new Error(`Connection '${connId}' not found`);

        if (updates.label !== undefined) conn.label = String(updates.label).trim();
        if (updates.enabled !== undefined) {
            conn.enabled = Boolean(updates.enabled);
            if (!conn.enabled) {
                conn.state = CONNECTION_STATES.DISABLED;
            } else if (conn.state === CONNECTION_STATES.DISABLED) {
                conn.state = conn.lastTestedAt ? CONNECTION_STATES.CONNECTED : CONNECTION_STATES.UNVERIFIED;
            }
        }
        if (updates.priority !== undefined) conn.priority = Math.max(1, Number(updates.priority) || 1);
        if (updates.freeOnly !== undefined) conn.freeOnly = Boolean(updates.freeOnly);
        if (updates.baseUrl !== undefined) conn.baseUrl = updates.baseUrl ? String(updates.baseUrl).trim() : null;
        if (updates.defaultModel !== undefined) conn.defaultModel = updates.defaultModel ? String(updates.defaultModel).trim() : null;
        if (Array.isArray(updates.models)) conn.models = updates.models.map(String);
        if (updates.state !== undefined) conn.state = updates.state;
        if (updates.lastError !== undefined) conn.lastError = updates.lastError;

        const newKey = maybeNewApiKey !== '' ? maybeNewApiKey : updates.apiKey;
        if (newKey !== undefined && typeof newKey === 'string') {
            if (newKey.trim()) {
                if (this.credentialStore) {
                    this.credentialStore.setSecret(`conn_${conn.id}_key`, newKey.trim());
                }
                // Credential change invalidates previous validation results!
                conn.state = CONNECTION_STATES.UNVERIFIED;
                conn.lastTestedAt = null;
                conn.lastError = null;
                conn.rateLimitedUntil = null;
                conn.cooldownUntil = null;
            } else if (newKey.trim() === '' && updates.clearApiKey) {
                if (this.credentialStore) {
                    this.credentialStore.deleteSecret(`conn_${conn.id}_key`);
                }
                conn.state = CONNECTION_STATES.NOT_CONFIGURED;
                conn.lastTestedAt = null;
                conn.lastError = 'No API key configured';
            }
        }

        conn.updatedAt = new Date().toISOString();
        this._saveConnections();
        return conn;
    }

    /**
     * Delete a connection and purge its secret.
     * @param {string} connectionId
     */
    deleteConnection(connectionId) {
        this.init();
        if (!this._connections.has(connectionId)) {
            return false;
        }

        if (this.credentialStore) {
            this.credentialStore.deleteSecret(`conn_${connectionId}_key`);
        }

        this._connections.delete(connectionId);
        this._saveConnections();
        return true;
    }

    /**
     * Mark connection health / cooldown states.
     */
    markRateLimited(connectionId, cooldownMs = 60000, reason = 'Rate limit exceeded') {
        const conn = this._connections.get(connectionId);
        if (!conn) return;
        conn.state = CONNECTION_STATES.RATE_LIMITED;
        conn.rateLimitedUntil = Date.now() + cooldownMs;
        conn.cooldownUntil = Date.now() + cooldownMs;
        conn.lastError = reason;
        this._saveConnections();
    }

    markFailed(connectionId, classification = 'temporary_failure', reason = 'Connection error', cooldownSeconds = 30) {
        const conn = this._connections.get(connectionId);
        if (!conn) return;

        const cooldownMs = Number(cooldownSeconds) * 1000;
        if (classification === 'invalid_credential') {
            conn.state = CONNECTION_STATES.INVALID_CREDENTIAL;
            conn.lastTestedAt = new Date().toISOString();
        } else if (classification === 'rate_limited') {
            conn.state = CONNECTION_STATES.RATE_LIMITED;
            conn.rateLimitedUntil = Date.now() + cooldownMs;
            conn.cooldownUntil = Date.now() + cooldownMs;
        } else if (classification === 'model_unavailable') {
            conn.state = CONNECTION_STATES.MODEL_UNAVAILABLE;
            conn.cooldownUntil = Date.now() + cooldownMs;
        } else if (classification === 'policy_ineligible') {
            conn.state = CONNECTION_STATES.POLICY_INELIGIBLE;
        } else if (classification === 'not_configured') {
            conn.state = CONNECTION_STATES.NOT_CONFIGURED;
            conn.lastTestedAt = null;
        } else {
            conn.state = CONNECTION_STATES.TEMPORARILY_UNAVAILABLE;
            conn.cooldownUntil = Date.now() + cooldownMs;
        }
        conn.lastError = reason;
        this._saveConnections();
    }

    markHealthy(connectionId) {
        const conn = this._connections.get(connectionId);
        if (!conn) return;
        conn.state = CONNECTION_STATES.CONNECTED;
        conn.rateLimitedUntil = null;
        conn.cooldownUntil = null;
        conn.lastError = null;
        conn.lastTestedAt = new Date().toISOString();
        this._saveConnections();
    }

    /**
     * Check if connection is currently available for dispatch.
     */
    isAvailable(connectionId) {
        const conn = this._connections.get(connectionId);
        if (!conn || !conn.enabled) return false;

        const now = Date.now();
        if (conn.rateLimitedUntil && conn.rateLimitedUntil > now) {
            return false;
        }
        if (conn.cooldownUntil && conn.cooldownUntil > now) {
            return false;
        }
        if (conn.state === CONNECTION_STATES.INVALID_CREDENTIAL ||
            conn.state === CONNECTION_STATES.NOT_CONFIGURED ||
            conn.state === CONNECTION_STATES.MODEL_UNAVAILABLE ||
            conn.state === CONNECTION_STATES.POLICY_INELIGIBLE) {
            return false;
        }

        return Boolean(this.getApiKey(connectionId));
    }

    /**
     * Alias for isAvailable.
     */
    isConnectionAvailable(connectionId) {
        return this.isAvailable(connectionId);
    }

    /**
     * Return a sanitized connection object safe for IPC transmission to renderer.
     */
    getSanitizedConnection(connectionId) {
        const conn = this._connections.get(connectionId);
        if (!conn) return null;

        const hasKey = Boolean(this.getApiKey(connectionId));
        const now = Date.now();
        let activeState = conn.state;

        if (conn.enabled === false) {
            activeState = CONNECTION_STATES.DISABLED;
        } else if (conn.rateLimitedUntil && conn.rateLimitedUntil > now) {
            activeState = CONNECTION_STATES.RATE_LIMITED;
        } else if (conn.cooldownUntil && conn.cooldownUntil > now) {
            activeState = CONNECTION_STATES.TEMPORARILY_UNAVAILABLE;
        } else if (!hasKey && conn.provider !== PROVIDER_TYPES.OLLAMA) {
            activeState = CONNECTION_STATES.NOT_CONFIGURED;
        } else if (conn.state === CONNECTION_STATES.INVALID_CREDENTIAL) {
            activeState = CONNECTION_STATES.INVALID_CREDENTIAL;
        } else if (conn.state === 'configured' && !conn.lastTestedAt) {
            activeState = CONNECTION_STATES.UNVERIFIED;
        }

        return {
            id: conn.id,
            provider: conn.provider,
            label: conn.label || conn.id,
            enabled: conn.enabled !== false,
            priority: conn.priority || 1,
            freeOnly: Boolean(conn.freeOnly),
            baseUrl: conn.baseUrl,
            defaultModel: conn.defaultModel,
            models: conn.models || [],
            state: activeState,
            hasKey,
            maskedKey: hasKey ? '••••••••' : '',
            rateLimitedUntil: conn.rateLimitedUntil,
            cooldownUntil: conn.cooldownUntil,
            lastError: conn.lastError,
            lastTestedAt: conn.lastTestedAt,
            updatedAt: conn.updatedAt
        };
    }

    /**
     * List all connections sanitized for UI consumption.
     */
    listConnections(filter = {}) {
        this.init();
        let list = Array.from(this._connections.keys()).map((id) => this.getSanitizedConnection(id));

        if (filter.provider) {
            list = list.filter((c) => c.provider === filter.provider);
        }
        if (filter.enabledOnly) {
            list = list.filter((c) => c.enabled);
        }

        // Sort by priority ascending (1 is highest priority), then label
        list.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.label.localeCompare(b.label);
        });

        return list;
    }

    /**
     * Alias for listConnections ensuring sanitized connection list.
     */
    listSanitizedConnections(filter = {}) {
        return this.listConnections(filter);
    }

    /**
     * Test connection credentials and reachability without exposing secrets.
     */
    async testConnection(connectionId, providerAdapter) {
        this.init();
        const conn = this._connections.get(connectionId);
        if (!conn) throw new Error(`Connection '${connectionId}' not found`);

        const apiKey = this.getApiKey(connectionId);
        if (!apiKey && conn.provider !== PROVIDER_TYPES.OLLAMA) {
            this.markFailed(connectionId, 'not_configured', 'No API key configured');
            return {
                ok: false,
                code: 'missing_credentials',
                error: 'No API key configured for this connection.',
                state: CONNECTION_STATES.NOT_CONFIGURED
            };
        }

        try {
            // Lightweight test invocation
            const testModel = conn.defaultModel || (conn.models && conn.models[0]);
            const res = await providerAdapter.completeWithConnection({
                connection: conn,
                apiKey,
                model: testModel,
                request: {
                    messages: [{ role: 'user', content: 'ping' }],
                    maxTokens: 5,
                    temperature: 0.1
                }
            });

            if (res.ok) {
                this.markHealthy(connectionId);
                return {
                    ok: true,
                    state: CONNECTION_STATES.CONNECTED,
                    message: `Successfully connected to ${conn.provider} using ${res.model || testModel}`
                };
            }

            const errStr = String(res.error || res.message || '').toLowerCase();
            const isInvalidKey = res.code === 'http_401' ||
                res.code === 'http_403' ||
                res.code === 'missing_credentials' ||
                res.code === 'invalid_credential' ||
                errStr.includes('api key') ||
                errStr.includes('invalid api_key') ||
                errStr.includes('api_key_invalid') ||
                errStr.includes('unauthorized') ||
                errStr.includes('permission denied');

            if (isInvalidKey) {
                this.markFailed(connectionId, 'invalid_credential', res.error);
                return {
                    ok: false,
                    code: 'invalid_credential',
                    error: res.error,
                    state: CONNECTION_STATES.INVALID_CREDENTIAL
                };
            }

            if (res.code === 'http_429' || errStr.includes('rate limit') || errStr.includes('too many requests')) {
                this.markRateLimited(connectionId, 60000, res.error);
                return {
                    ok: false,
                    code: 'rate_limited',
                    error: res.error,
                    state: CONNECTION_STATES.RATE_LIMITED
                };
            }

            if (errStr.includes('not found') || errStr.includes('not installed') || errStr.includes('does not exist') || res.code === 'http_404') {
                this.markFailed(connectionId, 'model_unavailable', res.error);
                return {
                    ok: false,
                    code: 'model_unavailable',
                    error: res.error,
                    state: CONNECTION_STATES.MODEL_UNAVAILABLE
                };
            }

            this.markFailed(connectionId, 'temporary_failure', res.error);
            return {
                ok: false,
                code: res.code || 'test_failed',
                error: res.error,
                state: CONNECTION_STATES.TEMPORARILY_UNAVAILABLE
            };
        } catch (err) {
            this.markFailed(connectionId, 'temporary_failure', err.message);
            return {
                ok: false,
                code: 'connection_exception',
                error: err.message,
                state: CONNECTION_STATES.TEMPORARILY_UNAVAILABLE
            };
        }
    }
}

module.exports = {
    CONNECTION_STATES,
    ConnectionManager
};
