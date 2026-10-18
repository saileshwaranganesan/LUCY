'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROVIDER_TYPES, ModelCatalogue } = require('./model-catalogue.js');
const { CONNECTION_STATES } = require('./connection-manager.js');

const ROUTING_MODES = Object.freeze({
    AUTO: 'auto',
    PREFER_LOCAL: 'prefer_local',
    LOCAL_FIRST: 'local-first',
    LOCAL_ONLY: 'local_only',
    HOSTED_FIRST: 'hosted-first',
    FREE_ONLY: 'free_only',
    MANUAL: 'manual',
    TASK_AWARE: 'task-aware'
});

const TASK_CATEGORIES = Object.freeze({
    GENERAL: 'general',
    REASONING: 'reasoning',
    CODING: 'coding',
    VISION: 'vision',
    TOOLS: 'tools',
    LONG_CONTEXT: 'long_context',
    SUMMARIZATION: 'summarization',
    LIGHTWEIGHT: 'lightweight',
    VOICE: 'voice',
    LOCAL: 'local'
});

const ERROR_CLASSIFICATIONS = Object.freeze({
    AUTH_INVALID_KEY: 'auth_invalid_key',
    PERMISSION_DENIED: 'permission_denied',
    RATE_LIMIT: 'rate_limit',
    QUOTA_EXHAUSTED: 'quota_exhausted',
    SERVER_ERROR: 'server_error',
    NETWORK_FAILURE: 'network_failure',
    LOCAL_UNAVAILABLE: 'local_unavailable',
    MODEL_NOT_INSTALLED: 'model_not_installed',
    MODEL_LOADING_FAILURE: 'model_loading_failure',
    UNSUPPORTED_CAPABILITY: 'unsupported_capability',
    INVALID_REQUEST: 'invalid_request',
    CONTENT_POLICY: 'content_policy',
    USER_CANCELLED: 'user_cancelled',
    CONTEXT_LIMIT_EXCEEDED: 'context_limit_exceeded',
    HOSTED_FALLBACK_DISABLED: 'hosted_fallback_disabled',
    PRIVACY_POLICY_VIOLATION: 'privacy_policy_violation',
    UNKNOWN: 'unknown'
});

function normalizeRoutingMode(mode) {
    if (!mode) return ROUTING_MODES.AUTO;
    const m = String(mode).trim().toLowerCase();
    if (m === 'local-first' || m === 'local_first' || m === 'prefer_local') return 'local-first';
    if (m === 'hosted-first' || m === 'hosted_first' || m === 'cloud_first') return 'hosted-first';
    if (m === 'task-aware' || m === 'task_aware' || m === 'auto') return 'auto';
    if (m === 'local_only' || m === 'local-only') return 'local_only';
    if (m === 'free_only' || m === 'free-only') return 'free_only';
    if (m === 'manual') return 'manual';
    return m;
}

/**
 * ModelRouter
 * Central intelligent routing, task-aware model selection, and automatic failover engine.
 *
 * Invariants:
 * 1. Strictly honors Free-Only policy: paid or unknown-pricing models are NEVER selected.
 * 2. Strictly honors Local-Only mode: never dispatches to remote endpoints when active.
 * 3. Vision tasks MUST be routed exclusively to vision-capable models.
 * 4. Tool execution tasks MUST be routed exclusively to tool-calling capable models.
 * 5. Bounded failover (max 3 candidate attempts) to prevent retry storms.
 * 6. Consequential action safety: requests with executed side effects never blindly re-execute.
 * 7. Records sanitized diagnostic events for observability.
 */
class ModelRouter {
    constructor(options = {}) {
        this.connectionManager = options.connectionManager;
        this.modelCatalogue = options.modelCatalogue || new ModelCatalogue();
        this.providerAdapter = options.providerAdapter;
        this.storageDir = options.configDir || options.storageDir || path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'LUCY',
            'secure'
        );
        this.configPath = path.join(this.storageDir, 'routing-config.json');

        this.config = {
            mode: ROUTING_MODES.AUTO,
            freeOnly: true, // Non-negotiable safety default: Free-only
            allowPaidFallback: false,
            allowHostedFallback: false, // In local-first mode, hosted fallback is disabled unless explicitly approved
            defaultProvider: PROVIDER_TYPES.GEMINI,
            defaultModel: 'gemini-2.0-flash',
            manualProvider: null,
            manualModel: null,
            maxBudgetUsd: null,
            maxConcurrentLocalRequests: 1,
            categoryPreferences: {
                [TASK_CATEGORIES.GENERAL]: { provider: null, model: null },
                [TASK_CATEGORIES.REASONING]: { provider: null, model: null },
                [TASK_CATEGORIES.CODING]: { provider: null, model: null },
                [TASK_CATEGORIES.VISION]: { provider: null, model: null },
                [TASK_CATEGORIES.TOOLS]: { provider: null, model: null },
                [TASK_CATEGORIES.LONG_CONTEXT]: { provider: null, model: null },
                [TASK_CATEGORIES.SUMMARIZATION]: { provider: null, model: null },
                [TASK_CATEGORIES.LIGHTWEIGHT]: { provider: null, model: null },
                [TASK_CATEGORIES.VOICE]: { provider: null, model: null }
            }
        };

        if (options.defaultConfig) {
            this.config = {
                ...this.config,
                ...options.defaultConfig,
                mode: options.defaultConfig.mode ? normalizeRoutingMode(options.defaultConfig.mode) : this.config.mode,
                categoryPreferences: {
                    ...this.config.categoryPreferences,
                    ...(options.defaultConfig.categoryPreferences || {})
                }
            };
        }

        this._localConcurrencyLimit = options.maxConcurrentLocalRequests || 1;
        this._activeLocalRequests = 0;
        this._localQueue = [];

        this._usageAccounting = {
            totalRequests: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            byProvider: {}
        };

        this._lastUsedRoute = null;
        this._diagnosticHistory = [];
        this._maxHistory = 50;
        this._initialized = false;
    }

    init() {
        if (this._initialized) return;
        if (!fs.existsSync(this.storageDir)) {
            try { fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 }); } catch (_) {}
        }
        this._loadConfig();
        this._initialized = true;
    }

    _loadConfig() {
        if (fs.existsSync(this.configPath)) {
            try {
                const raw = fs.readFileSync(this.configPath, 'utf8');
                const saved = JSON.parse(raw);
                if (saved && typeof saved === 'object') {
                    this.config = {
                        ...this.config,
                        ...saved,
                        mode: saved.mode ? normalizeRoutingMode(saved.mode) : this.config.mode,
                        categoryPreferences: {
                            ...this.config.categoryPreferences,
                            ...(saved.categoryPreferences || {})
                        }
                    };
                }
            } catch (err) {
                console.warn('[ModelRouter] Failed to read routing-config.json:', err.message);
            }
        }
    }

    _saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), {
                encoding: 'utf8',
                mode: 0o600
            });
        } catch (err) {
            console.warn('[ModelRouter] Failed to persist routing-config.json:', err.message);
        }
    }

    getConfig() {
        this.init();
        return {
            ...this.config,
            categoryPreferences: { ...this.config.categoryPreferences }
        };
    }

    updateConfig(updates = {}) {
        this.init();
        if (updates.mode) {
            this.config.mode = normalizeRoutingMode(updates.mode);
        }
        if (typeof updates.freeOnly === 'boolean') {
            this.config.freeOnly = updates.freeOnly;
        }
        if (typeof updates.allowPaidFallback === 'boolean') {
            this.config.allowPaidFallback = updates.allowPaidFallback;
        }
        if (typeof updates.allowHostedFallback === 'boolean') {
            this.config.allowHostedFallback = updates.allowHostedFallback;
        }
        if (updates.defaultProvider) {
            this.config.defaultProvider = String(updates.defaultProvider).trim();
        }
        if (updates.defaultModel) {
            this.config.defaultModel = String(updates.defaultModel).trim();
        }
        if (updates.manualProvider !== undefined) {
            this.config.manualProvider = updates.manualProvider ? String(updates.manualProvider).trim() : null;
        }
        if (updates.manualModel !== undefined) {
            this.config.manualModel = updates.manualModel ? String(updates.manualModel).trim() : null;
        }
        if (updates.maxConcurrentLocalRequests) {
            const num = Number(updates.maxConcurrentLocalRequests);
            if (num > 0) this._localConcurrencyLimit = num;
        }
        if (updates.categoryPreferences && typeof updates.categoryPreferences === 'object') {
            this.config.categoryPreferences = {
                ...this.config.categoryPreferences,
                ...updates.categoryPreferences
            };
        }

        this._saveConfig();
        return this.getConfig();
    }

    setConfig(updates = {}) {
        return this.updateConfig(updates);
    }

    /**
     * Classify an error code/message into a standard error classification.
     * @param {Object} responseOrErr
     * @returns {string}
     */
    classifyError(responseOrErr) {
        if (!responseOrErr) return ERROR_CLASSIFICATIONS.UNKNOWN;
        const code = String(responseOrErr.code || '').toLowerCase();
        const errStr = String(responseOrErr.error || responseOrErr.message || '').toLowerCase();

        if (code === 'request_cancelled' || responseOrErr.cancelled || errStr.includes('cancelled') || errStr.includes('aborted')) {
            return ERROR_CLASSIFICATIONS.USER_CANCELLED;
        }
        if (code === 'http_401' || code === 'missing_credentials' || errStr.includes('api key') || errStr.includes('unauthorized') || errStr.includes('invalid api_key')) {
            return ERROR_CLASSIFICATIONS.AUTH_INVALID_KEY;
        }
        if (code === 'http_403' || errStr.includes('forbidden') || errStr.includes('permission denied')) {
            return ERROR_CLASSIFICATIONS.PERMISSION_DENIED;
        }
        if (code === 'http_429' || errStr.includes('rate limit') || errStr.includes('too many requests') || errStr.includes('resource_exhausted')) {
            return ERROR_CLASSIFICATIONS.RATE_LIMIT;
        }
        if (code === 'http_402' || errStr.includes('quota') || errStr.includes('insufficient funds') || errStr.includes('billing')) {
            return ERROR_CLASSIFICATIONS.QUOTA_EXHAUSTED;
        }
        if (code === 'ollama_unavailable' || code === 'local_unavailable' || errStr.includes('ollama server is unavailable') || errStr.includes('econnrefused')) {
            return ERROR_CLASSIFICATIONS.LOCAL_UNAVAILABLE;
        }
        if (code === 'model_not_installed' || errStr.includes('not installed in ollama')) {
            return ERROR_CLASSIFICATIONS.MODEL_NOT_INSTALLED;
        }
        if (code === 'model_loading_failure' || errStr.includes('failed to load model')) {
            return ERROR_CLASSIFICATIONS.MODEL_LOADING_FAILURE;
        }
        if (code === 'context_limit_exceeded' || errStr.includes('context limit')) {
            return ERROR_CLASSIFICATIONS.CONTEXT_LIMIT_EXCEEDED;
        }
        if (code === 'hosted_fallback_disabled' || errStr.includes('hosted fallback is disabled')) {
            return ERROR_CLASSIFICATIONS.HOSTED_FALLBACK_DISABLED;
        }
        if (code === 'privacy_policy_local_only' || errStr.includes('prohibited by privacy policy')) {
            return ERROR_CLASSIFICATIONS.PRIVACY_POLICY_VIOLATION;
        }
        if (code.startsWith('http_5') || errStr.includes('internal server') || errStr.includes('bad gateway') || errStr.includes('service unavailable')) {
            return ERROR_CLASSIFICATIONS.SERVER_ERROR;
        }
        if (code === 'network_timeout' || errStr.includes('fetch failed') || errStr.includes('network') || errStr.includes('timed out')) {
            return ERROR_CLASSIFICATIONS.NETWORK_FAILURE;
        }
        if (code === 'unsupported_capability' || code === 'unsupported_multimodal' || errStr.includes('does not support') || errStr.includes('vision') || errStr.includes('tools')) {
            return ERROR_CLASSIFICATIONS.UNSUPPORTED_CAPABILITY;
        }
        if (code === 'http_400' || code === 'empty_messages' || errStr.includes('invalid_request') || errStr.includes('malformed')) {
            return ERROR_CLASSIFICATIONS.INVALID_REQUEST;
        }
        if (errStr.includes('safety') || errStr.includes('content policy') || errStr.includes('harmful')) {
            return ERROR_CLASSIFICATIONS.CONTENT_POLICY;
        }

        return ERROR_CLASSIFICATIONS.UNKNOWN;
    }

    get mode() {
        return this.config.mode;
    }

    /**
     * Classify a task request to determine required capabilities and category.
     * @param {Object|string} request
     * @param {Object} [options={}]
     * @returns {{ category: string, hasImages: boolean, hasTools: boolean, requiresVision: boolean, requiresToolCalling: boolean, isBasicText: boolean }}
     */
    classifyTask(request = {}, options = {}) {
        const text = typeof request === 'string'
            ? request
            : (request.text || (request.messages && request.messages.map((m) => typeof m.content === 'string' ? m.content : '').join(' ')) || '');

        const hasImages = Boolean(
            options.hasImages ||
            options.requiresVision ||
            (request.messages || []).some((m) => {
                if (Array.isArray(m.content)) return m.content.some((p) => p && (p.type === 'image_url' || p.image_url));
                if (m.images && m.images.length > 0) return true;
                return false;
            })
        );

        const explicitNoTools = options.requiresToolCalling === false ||
            request.requiresToolCalling === false ||
            options.isBasicText === true ||
            request.isBasicText === true;

        const hasTools = !explicitNoTools && Boolean(
            options.hasTools ||
            options.requiresToolCalling ||
            (Array.isArray(request.tools) && request.tools.length > 0)
        );

        let category = options.taskCategory;
        if (!category) {
            if (hasImages) {
                category = TASK_CATEGORIES.VISION;
            } else if (hasTools) {
                category = TASK_CATEGORIES.TOOLS;
            } else {
                const lower = text.toLowerCase();
                if (/\b(?:write\s+code|implement|function|bug|class|script|python|javascript|typescript|c\+\+|html|css|sql|refactor|compile)\b/i.test(lower)) {
                    category = TASK_CATEGORIES.CODING;
                } else if (/\b(?:reason|prove|calculate|solve|step-by-step|logic|analyze\s+why|math|puzzle)\b/i.test(lower)) {
                    category = TASK_CATEGORIES.REASONING;
                } else if (/\b(?:summarize|tldr|brief\s+summary|synopsis)\b/i.test(lower)) {
                    category = TASK_CATEGORIES.SUMMARIZATION;
                } else if (text.length > 12000) {
                    category = TASK_CATEGORIES.LONG_CONTEXT;
                } else {
                    category = TASK_CATEGORIES.GENERAL;
                }
            }
        }

        const isBasicText = !hasImages && !hasTools && (category === TASK_CATEGORIES.GENERAL || category === TASK_CATEGORIES.LIGHTWEIGHT);

        return {
            category,
            hasImages,
            hasTools,
            requiresVision: hasImages,
            requiresToolCalling: hasTools,
            isBasicText
        };
    }

    getLastUsedRoute() {
        return this._lastUsedRoute ? { ...this._lastUsedRoute } : null;
    }

    /**
     * Resolve a single route synchronously/deterministically based on policy and requirements.
     * Throws descriptive errors if no route satisfies requirements.
     * @param {Object} [options={}]
     * @returns {{ provider: string, model: string, connection: Object, reason: string }}
     */
    resolveRoute(options = {}) {
        this.init();
        const effectiveMode = normalizeRoutingMode(this.config.mode);
        const freeOnly = this.config.freeOnly;
        const requiresLocal = Boolean(options.requiresLocal || options.privacyLevel === 'local_only' || options.localOnly || effectiveMode === 'local_only');

        const overrideProvider = options.overrideProvider || options.userOverride?.provider || (effectiveMode === 'manual' ? (this.config.manualProvider || this.config.defaultProvider) : null);
        const overrideModel = options.overrideModel || options.userOverride?.model || (effectiveMode === 'manual' ? (this.config.manualModel || this.config.defaultModel) : null);
        const hasImages = Boolean(options.hasImages);
        const hasTools = Boolean(options.hasTools);
        const taskCategory = options.taskCategory || (hasImages ? TASK_CATEGORIES.VISION : (hasTools ? TASK_CATEGORIES.TOOLS : TASK_CATEGORIES.GENERAL));

        // 1. Explicit user override or manual mode
        if (overrideProvider) {
            const prov = String(overrideProvider).trim().toLowerCase();
            const modelId = overrideModel;

            if (requiresLocal && prov !== PROVIDER_TYPES.OLLAMA) {
                throw new Error('Request requires local processing; manual override to hosted provider is rejected by privacy policy.');
            }

            if (hasImages && modelId) {
                const cap = this.modelCatalogue.isCapable(modelId, { vision: true }, prov);
                if (!cap.capable) {
                    throw new Error(`Requested model '${modelId}' on provider '${prov}' does not support required visual/image input`);
                }
            }
            if (hasTools && modelId) {
                const cap = this.modelCatalogue.isCapable(modelId, { tool_calling: true }, prov);
                if (!cap.capable) {
                    throw new Error(`Requested model '${modelId}' on provider '${prov}' does not support required tool-calling capabilities`);
                }
            }

            const conns = this.connectionManager ? this.connectionManager.listConnections() : [];
            const matchingConn = conns.find((c) => c.provider === prov && c.enabled);
            if (matchingConn) {
                const resolvedModel = modelId || matchingConn.defaultModel || (matchingConn.models && matchingConn.models[0]);
                return {
                    provider: prov,
                    model: resolvedModel,
                    connection: matchingConn,
                    reason: effectiveMode === 'manual' ? 'manual_selection' : 'explicit_user_override'
                };
            }
        }

        // 2. Local-only check
        if (requiresLocal) {
            const conns = this.connectionManager ? this.connectionManager.listConnections() : [];
            const localConn = conns.find((c) => c.provider === PROVIDER_TYPES.OLLAMA && c.enabled);
            if (!localConn) {
                throw new Error('Local-only mode active, but no local inference connection configured or available.');
            }
        }

        // 3. Resolve candidate routes
        const candidates = this.resolveCandidateRoutes({
            taskCategory,
            requiresVision: hasImages,
            requiresToolCalling: hasTools,
            requiresLocal,
            userOverride: overrideProvider ? { provider: overrideProvider, model: overrideModel } : null
        });

        if (candidates.length === 0) {
            if (requiresLocal) {
                throw new Error('Local-only mode active, but no local inference connection configured or available.');
            }
            throw new Error('No eligible active AI connections available matching task requirements and routing policies.');
        }

        const best = candidates[0];
        return {
            provider: best.connection.provider,
            model: best.model,
            connection: best.connection,
            reason: best.reason
        };
    }

    /**
     * Determine candidate connections and models matching the task requirements.
     * @param {Object} options
     * @param {string} [options.taskCategory='general']
     * @param {boolean} [options.requiresVision=false]
     * @param {boolean} [options.requiresToolCalling=false]
     * @param {boolean} [options.requiresLocal=false]
     * @param {Object} [options.userOverride] - { provider, model }
     * @returns {Array<{ connection: Object, model: string, reason: string }>}
     */
    resolveCandidateRoutes(options = {}) {
        this.init();
        const {
            taskCategory = TASK_CATEGORIES.GENERAL,
            requiresVision = false,
            requiresToolCalling = false,
            requiresLocal = false,
            userOverride = null
        } = options;

        const effectiveMode = normalizeRoutingMode(this.config.mode);
        const freeOnly = this.config.freeOnly;
        const localOnly = Boolean(requiresLocal || options.privacyLevel === 'local_only' || effectiveMode === 'local_only');

        const allConnections = this.connectionManager ? this.connectionManager.listConnections() : [];
        const candidates = [];

        // 1. Manual mode or explicit user override
        const override = userOverride || (effectiveMode === 'manual' ? {
            provider: this.config.manualProvider || this.config.defaultProvider,
            model: this.config.manualModel || this.config.defaultModel
        } : null);

        const rankState = (c) => {
            if (c.state === CONNECTION_STATES.CONNECTED) return 0;
            if (c.state === CONNECTION_STATES.UNVERIFIED || c.state === CONNECTION_STATES.CONFIGURED) return 1;
            return 2;
        };

        if (override && override.provider) {
            const targetProvider = override.provider.toLowerCase();
            if (!localOnly || targetProvider === PROVIDER_TYPES.OLLAMA) {
                const matchingConns = allConnections.filter((c) => c.provider === targetProvider && c.enabled);

                for (const conn of matchingConns) {
                    if (this.connectionManager && !this.connectionManager.isAvailable(conn.id)) {
                        continue;
                    }
                    const targetModel = override.model || conn.defaultModel || (conn.models && conn.models[0]);
                    if (!targetModel) continue;

                    const capCheck = this.modelCatalogue.isCapable(targetModel, {
                        vision: requiresVision,
                        tool_calling: requiresToolCalling
                    }, targetProvider);

                    if (!capCheck.capable) {
                        continue;
                    }

                    if (freeOnly && !this.modelCatalogue.isFreeEligible(targetModel, targetProvider)) {
                        continue;
                    }

                    candidates.push({
                        connection: conn,
                        model: targetModel,
                        reason: effectiveMode === 'manual'
                            ? `Manual selection: ${targetProvider}/${targetModel}`
                            : `User explicit override: ${targetProvider}/${targetModel}`
                    });
                }

                if (candidates.length > 0) {
                    return candidates;
                }
            }
        }

        // 2. Task Category Preference Check (when not manual)
        if (effectiveMode !== 'manual') {
            const catPref = this.config.categoryPreferences[taskCategory];
            if (catPref && catPref.provider) {
                const targetProv = catPref.provider.toLowerCase();
                if (!localOnly || targetProv === PROVIDER_TYPES.OLLAMA) {
                    const matchingConns = allConnections.filter((c) => c.provider === targetProv && c.enabled);
                    for (const conn of matchingConns) {
                        if (this.connectionManager && !this.connectionManager.isAvailable(conn.id)) {
                            continue;
                        }
                        const targetModel = catPref.model || conn.defaultModel;
                        if (!targetModel) continue;

                        const capCheck = this.modelCatalogue.isCapable(targetModel, {
                            vision: requiresVision,
                            tool_calling: requiresToolCalling
                        }, conn.provider);

                        if (capCheck.capable) {
                            if (!freeOnly || this.modelCatalogue.isFreeEligible(targetModel, conn.provider)) {
                                candidates.push({
                                    connection: conn,
                                    model: targetModel,
                                    reason: `Category preference for '${taskCategory}': ${conn.provider}/${targetModel}`
                                });
                            }
                        }
                    }
                }
            }
        }

        // 3. Scan all enabled connections matching mode and capability
        let eligibleConns = allConnections.filter((c) => c.enabled);

        if (localOnly) {
            eligibleConns = eligibleConns.filter((c) => c.provider === PROVIDER_TYPES.OLLAMA);
        } else if (effectiveMode === 'local-first' || effectiveMode === 'prefer_local') {
            // In local-first mode, if hosted fallback is disabled, only local connections are eligible!
            if (!this.config.allowHostedFallback && !this.config.allowPaidFallback) {
                eligibleConns = eligibleConns.filter((c) => c.provider === PROVIDER_TYPES.OLLAMA);
            } else {
                // Local connections first, then hosted
                eligibleConns.sort((a, b) => {
                    if (a.provider === PROVIDER_TYPES.OLLAMA && b.provider !== PROVIDER_TYPES.OLLAMA) return -1;
                    if (b.provider === PROVIDER_TYPES.OLLAMA && a.provider !== PROVIDER_TYPES.OLLAMA) return 1;
                    const pDiff = (Number(a.priority) || 1) - (Number(b.priority) || 1);
                    if (pDiff !== 0) return pDiff;
                    return rankState(a) - rankState(b);
                });
            }
        } else if (effectiveMode === 'hosted-first') {
            // Hosted connections first, then local
            eligibleConns.sort((a, b) => {
                if (a.provider !== PROVIDER_TYPES.OLLAMA && b.provider === PROVIDER_TYPES.OLLAMA) return -1;
                if (b.provider !== PROVIDER_TYPES.OLLAMA && a.provider === PROVIDER_TYPES.OLLAMA) return 1;
                const pDiff = (Number(a.priority) || 1) - (Number(b.priority) || 1);
                if (pDiff !== 0) return pDiff;
                return rankState(a) - rankState(b);
            });
        } else {
            // Sort by priority ascending (1 is highest priority), then state rank
            eligibleConns.sort((a, b) => {
                const pDiff = (Number(a.priority) || 1) - (Number(b.priority) || 1);
                if (pDiff !== 0) return pDiff;
                return rankState(a) - rankState(b);
            });
        }

        for (const conn of eligibleConns) {
            // Check availability (not currently rate limited or invalid)
            if (this.connectionManager && !this.connectionManager.isAvailable(conn.id)) {
                continue;
            }

            // Find capable models for this connection
            const modelsToCheck = (conn.models && conn.models.length > 0)
                ? conn.models
                : (conn.defaultModel ? [conn.defaultModel] : []);

            if (modelsToCheck.length === 0) {
                const catModels = this.modelCatalogue.listModels({ provider: conn.provider });
                for (const m of catModels) modelsToCheck.push(m.id);
            }

            // Capability checks including task-aware criteria
            const requiredCaps = {
                vision: requiresVision,
                tool_calling: requiresToolCalling
            };
            if (taskCategory === TASK_CATEGORIES.CODING) requiredCaps.coding = true;
            if (taskCategory === TASK_CATEGORIES.LONG_CONTEXT) requiredCaps.long_context = true;

            for (const modelId of modelsToCheck) {
                const capCheck = this.modelCatalogue.isCapable(modelId, requiredCaps, conn.provider);
                if (!capCheck.capable) continue;

                if (freeOnly && !this.modelCatalogue.isFreeEligible(modelId, conn.provider)) {
                    continue;
                }

                const alreadyAdded = candidates.some((c) => c.connection.id === conn.id && c.model === modelId);
                if (!alreadyAdded) {
                    candidates.push({
                        connection: conn,
                        model: modelId,
                        reason: `Priority ${conn.priority || 1} route (${conn.provider}/${modelId})`
                    });
                }
            }
        }

        return candidates;
    }

    /**
     * Acquire local inference slot to prevent concurrent local models overloading laptop RAM/CPU.
     */
    async _acquireLocalSlot() {
        if (this._activeLocalRequests < this._localConcurrencyLimit) {
            this._activeLocalRequests++;
            return;
        }
        await new Promise((resolve) => this._localQueue.push(resolve));
        this._activeLocalRequests++;
    }

    /**
     * Release local inference slot.
     */
    _releaseLocalSlot() {
        this._activeLocalRequests = Math.max(0, this._activeLocalRequests - 1);
        if (this._localQueue.length > 0) {
            const next = this._localQueue.shift();
            if (typeof next === 'function') next();
        }
    }

    /**
     * Verify context limit and safely prune earlier messages if budget exceeded.
     */
    _checkAndTrimContext(messages = [], modelId, provider, options = {}) {
        const modelDef = this.modelCatalogue ? this.modelCatalogue.getModel(modelId, provider) : null;
        const limit = modelDef?.contextLimit || 128000;

        let totalChars = 0;
        for (const m of messages) {
            if (typeof m.content === 'string') totalChars += m.content.length;
            else if (Array.isArray(m.content)) {
                for (const p of m.content) {
                    if (p && p.text) totalChars += p.text.length;
                }
            }
        }
        const estimatedTokens = Math.ceil(totalChars / 4);

        if (estimatedTokens <= limit) {
            return { ok: true, messages, truncated: false };
        }

        if (options.truncateContext === false) {
            return {
                ok: false,
                code: 'context_limit_exceeded',
                error: `Estimated prompt length (${estimatedTokens} tokens) exceeds model context limit of ${limit} tokens.`,
                limit,
                estimatedTokens
            };
        }

        // Safe pruning: retain system messages and latest user message
        const systemMessages = messages.filter((m) => m.role === 'system');
        const otherMessages = messages.filter((m) => m.role !== 'system');
        const trimmedOthers = [];

        let currentChars = systemMessages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
        const maxAllowedChars = limit * 3.5;

        for (let i = otherMessages.length - 1; i >= 0; i--) {
            const m = otherMessages[i];
            const len = typeof m.content === 'string' ? m.content.length : 0;
            if (currentChars + len < maxAllowedChars || trimmedOthers.length === 0) {
                trimmedOthers.unshift(m);
                currentChars += len;
            } else {
                break;
            }
        }

        return {
            ok: true,
            messages: [...systemMessages, ...trimmedOthers],
            truncated: true,
            originalTokens: estimatedTokens,
            limit
        };
    }

    /**
     * Record cumulative usage accounting.
     */
    _recordUsage(provider, usage) {
        if (!usage || typeof usage !== 'object') return;
        const promptTokens = Number(usage.promptTokens ?? usage.prompt_tokens) || 0;
        const completionTokens = Number(usage.completionTokens ?? usage.completion_tokens) || 0;
        const totalTokens = Number(usage.totalTokens ?? usage.total_tokens) || (promptTokens + completionTokens);

        this._usageAccounting.totalRequests++;
        this._usageAccounting.totalPromptTokens += promptTokens;
        this._usageAccounting.totalCompletionTokens += completionTokens;
        this._usageAccounting.totalTokens += totalTokens;

        if (provider) {
            const p = String(provider).toLowerCase();
            if (!this._usageAccounting.byProvider[p]) {
                this._usageAccounting.byProvider[p] = {
                    requests: 0,
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0
                };
            }
            this._usageAccounting.byProvider[p].requests++;
            this._usageAccounting.byProvider[p].promptTokens += promptTokens;
            this._usageAccounting.byProvider[p].completionTokens += completionTokens;
            this._usageAccounting.byProvider[p].totalTokens += totalTokens;
        }
    }

    getUsageAccounting() {
        return JSON.parse(JSON.stringify(this._usageAccounting));
    }

    resetUsageAccounting() {
        this._usageAccounting = {
            totalRequests: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            byProvider: {}
        };
    }

    /**
     * Execute an LLM completion with intelligent routing, error classification, and bounded failover.
     * @param {Object} request
     * @param {Object} [options={}]
     * @returns {Promise<Object>}
     */
    async complete(request = {}, options = {}) {
        this.init();
        const startTime = Date.now();
        const effectiveMode = normalizeRoutingMode(this.config.mode);

        // 0. User cancellation check
        const signal = options.signal || request.signal;
        if (signal && signal.aborted) {
            return {
                ok: false,
                code: 'user_cancelled',
                error: 'Request was cancelled by user.',
                cancelled: true
            };
        }

        // 1. Detect task requirements & privacy constraints via classifyTask
        const classification = this.classifyTask(request, options);
        const hasImages = classification.hasImages;
        const hasTools = classification.hasTools;
        const taskCategory = classification.category;
        const requiresLocal = Boolean(options.requiresLocal || request.requiresLocal || options.privacyLevel === 'local_only' || effectiveMode === 'local_only');

        // 2. Resolve eligible candidate routes
        const candidates = this.resolveCandidateRoutes({
            taskCategory,
            requiresVision: hasImages,
            requiresToolCalling: hasTools,
            requiresLocal,
            userOverride: options.userOverride
        });

        if (candidates.length === 0) {
            const err = this._buildNoRouteError({
                hasImages,
                hasTools,
                freeOnly: this.config.freeOnly,
                localOnly: requiresLocal,
                userOverride: options.userOverride
            });

            const diagProvider = options.userOverride?.provider || this.config.manualProvider || this.config.defaultProvider || 'none';
            const diagModel = options.userOverride?.model || this.config.manualModel || this.config.defaultModel || 'none';

            this._recordDiagnosticEvent({
                timestamp: new Date().toISOString(),
                outcome: 'no_route',
                category: taskCategory,
                provider: diagProvider,
                model: diagModel,
                reason: err.error,
                error: err.error,
                code: err.code,
                latencyMs: Date.now() - startTime
            });

            return err;
        }

        // 3. Bounded Failover Execution Loop (max 3 candidate attempts)
        const maxAttempts = Math.min(3, candidates.length);
        let lastError = null;
        let attemptsMade = 0;
        const invalidConnectionIds = new Set();
        let chunksStreamed = 0;

        for (let i = 0; i < candidates.length && attemptsMade < maxAttempts; i++) {
            const route = candidates[i];
            const conn = route.connection;
            const model = route.model;

            if (invalidConnectionIds.has(conn.id)) {
                continue;
            }

            attemptsMade++;
            const apiKey = this.connectionManager ? this.connectionManager.getApiKey(conn.id) : '';

            // User cancellation check
            if (signal && signal.aborted) {
                return {
                    ok: false,
                    code: 'user_cancelled',
                    error: 'Request was cancelled by user.',
                    cancelled: true,
                    provider: conn.provider,
                    model
                };
            }

            // Context window validation and pruning
            const contextCheck = this._checkAndTrimContext(request.messages || [], model, conn.provider, options);
            if (!contextCheck.ok) {
                return {
                    ok: false,
                    code: contextCheck.code,
                    error: contextCheck.error,
                    provider: conn.provider,
                    model
                };
            }

            // Concurrency Slot Acquisition for Local Inference
            let acquiredLocalSlot = false;
            if (conn.provider === PROVIDER_TYPES.OLLAMA) {
                await this._acquireLocalSlot();
                acquiredLocalSlot = true;
            }

            // Wrap onChunk to track partial output delivery
            const trackedOnChunk = options.onChunk ? (chunk) => {
                chunksStreamed++;
                options.onChunk(chunk);
            } : null;

            try {
                const res = await this.providerAdapter.completeWithConnection({
                    connection: conn,
                    apiKey,
                    model,
                    request: {
                        ...request,
                        messages: contextCheck.messages,
                        signal,
                        onChunk: trackedOnChunk
                    }
                });

                if (res.ok) {
                    if (this.connectionManager) {
                        this.connectionManager.markHealthy(conn.id);
                    }

                    this._lastUsedRoute = {
                        provider: conn.provider,
                        model: res.model || model,
                        connectionId: conn.id,
                        connectionLabel: conn.label,
                        isLocal: conn.provider === PROVIDER_TYPES.OLLAMA,
                        leavesLocalMachine: conn.provider !== PROVIDER_TYPES.OLLAMA,
                        timestamp: new Date().toISOString()
                    };

                    this._recordDiagnosticEvent({
                        timestamp: new Date().toISOString(),
                        outcome: attemptsMade === 1 ? 'success' : 'failover_success',
                        provider: conn.provider,
                        model: res.model || model,
                        connectionId: conn.id,
                        connectionLabel: conn.label,
                        category: taskCategory,
                        reason: route.reason || 'Optimal route',
                        attempts: attemptsMade,
                        latencyMs: Date.now() - startTime
                    });

                    this._recordUsage(conn.provider, res.usage);

                    return {
                        ...res,
                        provider: conn.provider,
                        model: res.model || model,
                        connectionId: conn.id,
                        connectionLabel: conn.label,
                        isLocal: conn.provider === PROVIDER_TYPES.OLLAMA,
                        leavesLocalMachine: conn.provider !== PROVIDER_TYPES.OLLAMA,
                        contextTruncated: contextCheck.truncated,
                        routedVia: {
                            connectionId: conn.id,
                            connectionLabel: conn.label,
                            provider: conn.provider,
                            model: res.model || model,
                            attempts: attemptsMade,
                            failoverOccurred: attemptsMade > 1,
                            mode: effectiveMode
                        }
                    };
                }

                // Error occurred
                lastError = res;
                const classification = this.classifyError(res);

                if (classification === ERROR_CLASSIFICATIONS.USER_CANCELLED) {
                    return {
                        ...res,
                        ok: false,
                        code: 'user_cancelled',
                        cancelled: true
                    };
                }

                if (classification === ERROR_CLASSIFICATIONS.CONTENT_POLICY || classification === ERROR_CLASSIFICATIONS.INVALID_REQUEST) {
                    return res;
                }

                // Update connection health state
                if (this.connectionManager) {
                    if (classification === ERROR_CLASSIFICATIONS.AUTH_INVALID_KEY) {
                        this.connectionManager.markFailed(conn.id, 'invalid_credential', res.error);
                        invalidConnectionIds.add(conn.id);
                    } else if (classification === ERROR_CLASSIFICATIONS.RATE_LIMIT) {
                        this.connectionManager.markRateLimited(conn.id, 60000, res.error);
                    } else {
                        this.connectionManager.markFailed(conn.id, 'temporary_failure', res.error);
                    }
                }

                this._recordDiagnosticEvent({
                    timestamp: new Date().toISOString(),
                    outcome: 'failover_attempt',
                    provider: conn.provider,
                    model,
                    connectionId: conn.id,
                    errorClassification: classification,
                    error: res.error,
                    nextAttemptAvailable: attemptsMade < maxAttempts
                });

                // Partial streaming failover guard
                if (chunksStreamed > 0) {
                    return {
                        ok: false,
                        code: 'streaming_interrupted_no_failover',
                        error: `Streaming response was interrupted after output began: ${res.error}. Failover aborted to prevent output corruption.`,
                        provider: conn.provider,
                        model,
                        lastResult: res
                    };
                }

                // Consequential execution guard
                if (options.hasConsequentialSideEffects) {
                    return {
                        ok: false,
                        code: 'failover_aborted_consequential',
                        error: `Provider error after partial execution (${res.error}). Automatic failover suppressed to prevent duplicate consequential side effects.`,
                        lastResult: res
                    };
                }

                // Privacy local-only guard
                if (requiresLocal) {
                    return {
                        ok: false,
                        code: 'privacy_policy_local_only',
                        error: `Local model (${conn.provider}/${model}) failed: ${res.error}. External transmission prohibited by privacy policy.`,
                        provider: conn.provider,
                        model,
                        lastResult: res
                    };
                }

                // Hosted fallback disabled guard in local-first mode
                if ((effectiveMode === 'local-first' || effectiveMode === 'prefer_local') && conn.provider === PROVIDER_TYPES.OLLAMA) {
                    if (!this.config.allowHostedFallback && !this.config.allowPaidFallback) {
                        return {
                            ok: false,
                            code: 'hosted_fallback_disabled',
                            error: `Local model (${conn.provider}/${model}) failed: ${res.error}. Hosted fallback is disabled by policy.`,
                            provider: conn.provider,
                            model,
                            lastResult: res
                        };
                    }
                }

            } catch (err) {
                lastError = { ok: false, error: err.message, code: 'exception' };
                const classification = this.classifyError(err);
                if (this.connectionManager) {
                    this.connectionManager.markFailed(conn.id, 'temporary_failure', err.message);
                }
            } finally {
                if (acquiredLocalSlot) {
                    this._releaseLocalSlot();
                }
            }
        }

        const exhaustedErr = {
            ok: false,
            code: lastError?.code || 'all_failovers_exhausted',
            error: lastError?.error || `All eligible provider routes failed (${attemptsMade} attempts made).`,
            attempts: attemptsMade,
            lastError
        };

        this._recordDiagnosticEvent({
            timestamp: new Date().toISOString(),
            outcome: 'failed',
            provider: lastError?.provider || 'all_routes',
            model: lastError?.model || 'none',
            category: taskCategory,
            reason: exhaustedErr.error,
            error: exhaustedErr.error,
            code: exhaustedErr.code,
            attempts: attemptsMade,
            latencyMs: Date.now() - startTime
        });

        return exhaustedErr;
    }

    _buildNoRouteError(options = {}) {
        const {
            hasImages = false,
            hasTools = false,
            freeOnly = this.config.freeOnly,
            localOnly = false,
            userOverride = null
        } = options;

        const conns = this.connectionManager ? this.connectionManager.listConnections() : [];
        const enabledConns = conns.filter((c) => c.enabled);

        if (localOnly) {
            return {
                ok: false,
                code: 'no_local_route',
                error: 'Local-only policy is active, but no compatible local model/endpoint was available. Please ensure Ollama is running or switch routing mode.'
            };
        }

        if (conns.length === 0) {
            return {
                ok: false,
                code: 'no_configured_connection',
                error: 'No AI provider connection is configured. Please configure an API key in Provider Settings.'
            };
        }

        if (enabledConns.length === 0) {
            return {
                ok: false,
                code: 'all_connections_disabled',
                error: 'All configured AI provider connections are currently disabled. Please enable at least one connection in Settings.'
            };
        }

        if (userOverride) {
            const targetProv = String(userOverride.provider || '').toLowerCase();
            const match = enabledConns.find((c) => c.provider === targetProv);
            if (!match) {
                return {
                    ok: false,
                    code: 'override_provider_not_configured',
                    error: `Requested override provider '${userOverride.provider}' is not configured or disabled.`
                };
            }
            if (this.connectionManager && !this.connectionManager.isAvailable(match.id)) {
                if (match.state === CONNECTION_STATES.INVALID_CREDENTIAL) {
                    return {
                        ok: false,
                        code: 'invalid_credentials',
                        error: `Requested override provider '${userOverride.provider}' has invalid credentials.`
                    };
                }
                if (match.state === CONNECTION_STATES.RATE_LIMITED) {
                    return {
                        ok: false,
                        code: 'rate_limited',
                        error: `Requested override provider '${userOverride.provider}' is currently rate-limited.`
                    };
                }
            }
            if (hasImages && userOverride.model) {
                const cap = this.modelCatalogue.isCapable(userOverride.model, { vision: true }, userOverride.provider);
                if (!cap.capable) {
                    return {
                        ok: false,
                        code: 'no_vision_route',
                        error: `Requested model '${userOverride.model}' on provider '${userOverride.provider}' does not support visual/image inputs.`
                    };
                }
            }
            if (hasTools && userOverride.model) {
                const cap = this.modelCatalogue.isCapable(userOverride.model, { tool_calling: true }, userOverride.provider);
                if (!cap.capable) {
                    return {
                        ok: false,
                        code: 'no_tool_route',
                        error: `Requested model '${userOverride.model}' on provider '${userOverride.provider}' does not support structured tool calling.`
                    };
                }
            }
            if (freeOnly && userOverride.model && !this.modelCatalogue.isFreeEligible(userOverride.model, userOverride.provider)) {
                return {
                    ok: false,
                    code: 'policy_rejection_paid',
                    error: `Requested model '${userOverride.model}' is a paid model and is blocked by Strict Free-Only spending policy.`
                };
            }
            return {
                ok: false,
                code: 'incompatible_override',
                error: `User override '${userOverride.provider}/${userOverride.model}' is not compatible with request requirements or lacks valid credentials.`
            };
        }

        // 1. Check connection health states FIRST so credential / network / rate-limit errors are never masked by capability checks!
        const invalidConns = enabledConns.filter((c) => c.state === CONNECTION_STATES.INVALID_CREDENTIAL);
        const unconfiguredConns = enabledConns.filter((c) => c.state === CONNECTION_STATES.NOT_CONFIGURED || (!c.hasKey && c.provider !== PROVIDER_TYPES.OLLAMA));
        const rateLimitedConns = enabledConns.filter((c) => c.state === CONNECTION_STATES.RATE_LIMITED);
        const unavailableConns = enabledConns.filter((c) => c.state === CONNECTION_STATES.TEMPORARILY_UNAVAILABLE);

        if (invalidConns.length > 0 && (invalidConns.length + unconfiguredConns.length === enabledConns.length)) {
            const names = invalidConns.map((c) => c.label || c.provider).join(', ');
            return {
                ok: false,
                code: 'invalid_credentials',
                error: `Configured credentials for ${names} are invalid or rejected by the provider. Please update your API key in Settings.`
            };
        }

        if (unconfiguredConns.length === enabledConns.length) {
            return {
                ok: false,
                code: 'missing_credentials',
                error: 'Configured provider connections are missing API keys. Please enter valid credentials in Settings.'
            };
        }

        if (rateLimitedConns.length === enabledConns.length) {
            return {
                ok: false,
                code: 'rate_limited',
                error: 'All configured AI provider connections are currently rate-limited. Please wait for cooldown or switch providers.'
            };
        }

        if (unavailableConns.length === enabledConns.length) {
            return {
                ok: false,
                code: 'provider_unreachable',
                error: 'Configured AI providers are currently unreachable. Please check network connectivity or local service status.'
            };
        }

        // 2. Vision capability check
        if (hasImages) {
            return {
                ok: false,
                code: 'no_vision_route',
                error: 'This task contains images, but no vision-capable model is currently configured or available. Text-only models cannot interpret screenshots or images.'
            };
        }

        // 3. Structured tool-calling capability check
        if (hasTools) {
            const configuredModelNames = enabledConns.map((c) => `${c.label || c.provider} (${c.defaultModel || (c.models && c.models[0]) || 'default'})`).join(', ');
            return {
                ok: false,
                code: 'no_tool_route',
                error: configuredModelNames
                    ? `This task requires structured tool execution, but no configured model supports function calling. Configured model(s): ${configuredModelNames} only support text generation. Please configure a model with tool-calling capabilities (such as Gemini 2.0 Flash, Groq Llama 3.3, or Ollama Llama 3.2 3B) in Settings.`
                    : 'This task requires structured tool execution, but no configured model supports function calling.'
            };
        }

        if (freeOnly) {
            let hasAnyCapableModel = false;
            let hasPaidOnlyModels = false;
            for (const conn of enabledConns) {
                const models = (conn.models && conn.models.length > 0) ? conn.models : (conn.defaultModel ? [conn.defaultModel] : []);
                for (const m of models) {
                    hasAnyCapableModel = true;
                    if (!this.modelCatalogue.isFreeEligible(m, conn.provider)) {
                        hasPaidOnlyModels = true;
                    }
                }
            }
            if (hasPaidOnlyModels && !hasAnyCapableModel) {
                return {
                    ok: false,
                    code: 'policy_rejection_paid',
                    error: 'Configured models are paid models and are rejected under Strict Free-Only spending policy.'
                };
            }

            return {
                ok: false,
                code: 'no_free_route',
                error: 'Strict Free-Only policy is active, but no verified free-tier model is currently configured with valid credentials.'
            };
        }

        return {
            ok: false,
            code: 'no_eligible_route',
            error: 'No eligible AI provider connection is configured. Please add an API key in Provider Settings.'
        };
    }

    _recordDiagnosticEvent(event) {
        this._diagnosticHistory.unshift(event);
        if (this._diagnosticHistory.length > this._maxHistory) {
            this._diagnosticHistory.pop();
        }
    }

    getDiagnostics() {
        return [...this._diagnosticHistory];
    }
}

module.exports = {
    ROUTING_MODES,
    TASK_CATEGORIES,
    ERROR_CLASSIFICATIONS,
    ModelRouter
};
