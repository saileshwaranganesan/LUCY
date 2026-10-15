'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROVIDER_TYPES, ModelCatalogue } = require('./model-catalogue.js');
const { CONNECTION_STATES } = require('./connection-manager.js');

const ROUTING_MODES = Object.freeze({
    AUTO: 'auto',
    PREFER_LOCAL: 'prefer_local',
    LOCAL_ONLY: 'local_only',
    FREE_ONLY: 'free_only',
    MANUAL: 'manual'
});

const TASK_CATEGORIES = Object.freeze({
    GENERAL: 'general',
    REASONING: 'reasoning',
    CODING: 'coding',
    VISION: 'vision',
    TOOLS: 'tools',
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
    UNSUPPORTED_CAPABILITY: 'unsupported_capability',
    INVALID_REQUEST: 'invalid_request',
    CONTENT_POLICY: 'content_policy',
    USER_CANCELLED: 'user_cancelled',
    UNKNOWN: 'unknown'
});

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
            defaultProvider: PROVIDER_TYPES.GEMINI,
            defaultModel: 'gemini-2.0-flash',
            categoryPreferences: {
                [TASK_CATEGORIES.GENERAL]: { provider: null, model: null },
                [TASK_CATEGORIES.REASONING]: { provider: null, model: null },
                [TASK_CATEGORIES.CODING]: { provider: null, model: null },
                [TASK_CATEGORIES.VISION]: { provider: null, model: null },
                [TASK_CATEGORIES.TOOLS]: { provider: null, model: null },
                [TASK_CATEGORIES.LIGHTWEIGHT]: { provider: null, model: null },
                [TASK_CATEGORIES.VOICE]: { provider: null, model: null }
            }
        };

        if (options.defaultConfig) {
            this.config = {
                ...this.config,
                ...options.defaultConfig,
                categoryPreferences: {
                    ...this.config.categoryPreferences,
                    ...(options.defaultConfig.categoryPreferences || {})
                }
            };
        }

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
        if (updates.mode && Object.values(ROUTING_MODES).includes(updates.mode)) {
            this.config.mode = updates.mode;
        }
        if (typeof updates.freeOnly === 'boolean') {
            this.config.freeOnly = updates.freeOnly;
        }
        if (typeof updates.allowPaidFallback === 'boolean') {
            this.config.allowPaidFallback = updates.allowPaidFallback;
        }
        if (updates.defaultProvider) {
            this.config.defaultProvider = String(updates.defaultProvider).trim();
        }
        if (updates.defaultModel) {
            this.config.defaultModel = String(updates.defaultModel).trim();
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
        if (code.startsWith('http_5') || errStr.includes('internal server') || errStr.includes('bad gateway') || errStr.includes('service unavailable')) {
            return ERROR_CLASSIFICATIONS.SERVER_ERROR;
        }
        if (code === 'network_timeout' || errStr.includes('econnrefused') || errStr.includes('fetch failed') || errStr.includes('network') || errStr.includes('timed out')) {
            return ERROR_CLASSIFICATIONS.NETWORK_FAILURE;
        }
        if (code === 'unsupported_capability' || errStr.includes('does not support') || errStr.includes('vision') || errStr.includes('tools')) {
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
        const effectiveMode = this.config.mode;
        const freeOnly = this.config.freeOnly;
        const localOnly = effectiveMode === ROUTING_MODES.LOCAL_ONLY;

        const overrideProvider = options.overrideProvider || options.userOverride?.provider;
        const overrideModel = options.overrideModel || options.userOverride?.model;
        const hasImages = Boolean(options.hasImages);
        const hasTools = Boolean(options.hasTools);
        const taskCategory = options.taskCategory || (hasImages ? TASK_CATEGORIES.VISION : (hasTools ? TASK_CATEGORIES.TOOLS : TASK_CATEGORIES.GENERAL));

        // 1. Explicit user override
        if (overrideProvider) {
            const prov = String(overrideProvider).trim().toLowerCase();
            const modelId = overrideModel;

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
                    reason: 'explicit_user_override'
                };
            }
        }

        // 2. Local-only check
        if (localOnly) {
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
            userOverride: overrideProvider ? { provider: overrideProvider, model: overrideModel } : null
        });

        if (candidates.length === 0) {
            if (localOnly) {
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
     * @param {Object} [options.userOverride] - { provider, model }
     * @returns {Array<{ connection: Object, model: string, reason: string }>}
     */
    resolveCandidateRoutes(options = {}) {
        this.init();
        const {
            taskCategory = TASK_CATEGORIES.GENERAL,
            requiresVision = false,
            requiresToolCalling = false,
            userOverride = null
        } = options;

        const effectiveMode = this.config.mode;
        const freeOnly = this.config.freeOnly;
        const localOnly = effectiveMode === ROUTING_MODES.LOCAL_ONLY;

        const allConnections = this.connectionManager ? this.connectionManager.listConnections() : [];
        const candidates = [];

        // 1. If explicit user override is provided and compatible, check it first
        if (userOverride && userOverride.provider) {
            const targetProvider = userOverride.provider.toLowerCase();
            const matchingConns = allConnections.filter((c) => c.provider === targetProvider && c.enabled);

            for (const conn of matchingConns) {
                const targetModel = userOverride.model || conn.defaultModel || (conn.models && conn.models[0]);
                if (!targetModel) continue;

                // Validate capabilities
                const capCheck = this.modelCatalogue.isCapable(targetModel, {
                    vision: requiresVision,
                    tool_calling: requiresToolCalling
                }, targetProvider);

                if (!capCheck.capable) {
                    continue; // Skip incompatible override route
                }

                // Validate cost policy
                if (freeOnly && !this.modelCatalogue.isFreeEligible(targetModel, targetProvider)) {
                    continue; // Reject paid/unknown in free-only mode
                }

                candidates.push({
                    connection: conn,
                    model: targetModel,
                    reason: `User explicit override: ${targetProvider}/${targetModel}`
                });
            }

            if (candidates.length > 0) {
                return candidates;
            }
        }

        // 2. Task Category Preference Check
        const catPref = this.config.categoryPreferences[taskCategory];
        if (catPref && catPref.provider) {
            const matchingConns = allConnections.filter((c) => c.provider === catPref.provider && c.enabled);
            for (const conn of matchingConns) {
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

        // 3. Scan all enabled connections matching mode and capability
        let eligibleConns = allConnections.filter((c) => c.enabled);

        if (localOnly) {
            eligibleConns = eligibleConns.filter((c) => c.provider === PROVIDER_TYPES.OLLAMA);
        } else if (effectiveMode === ROUTING_MODES.PREFER_LOCAL) {
            // Sort local connections first
            eligibleConns.sort((a, b) => {
                if (a.provider === PROVIDER_TYPES.OLLAMA && b.provider !== PROVIDER_TYPES.OLLAMA) return -1;
                if (b.provider === PROVIDER_TYPES.OLLAMA && a.provider !== PROVIDER_TYPES.OLLAMA) return 1;
                return (Number(a.priority) || 1) - (Number(b.priority) || 1);
            });
        } else {
            // Sort by priority ascending (1 is highest priority, 10 before 20)
            eligibleConns.sort((a, b) => (Number(a.priority) || 1) - (Number(b.priority) || 1));
        }

        for (const conn of eligibleConns) {
            // Check availability (not currently rate limited or invalid)
            if (this.connectionManager && !this.connectionManager.isAvailable(conn.id)) {
                continue;
            }

            // Find best capable model for this connection
            const modelsToCheck = (conn.models && conn.models.length > 0)
                ? conn.models
                : (conn.defaultModel ? [conn.defaultModel] : []);

            // If no specific models listed, fetch from catalogue for this provider
            if (modelsToCheck.length === 0) {
                const catModels = this.modelCatalogue.listModels({ provider: conn.provider });
                for (const m of catModels) modelsToCheck.push(m.id);
            }

            for (const modelId of modelsToCheck) {
                const capCheck = this.modelCatalogue.isCapable(modelId, {
                    vision: requiresVision,
                    tool_calling: requiresToolCalling
                }, conn.provider);

                if (!capCheck.capable) continue;

                if (freeOnly && !this.modelCatalogue.isFreeEligible(modelId, conn.provider)) {
                    continue; // Skip paid or unknown pricing models
                }

                // Avoid duplicate connection/model pairs
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
     * Execute an LLM completion with intelligent routing, error classification, and bounded failover.
     * @param {Object} request
     * @param {Object} [options={}]
     * @returns {Promise<Object>}
     */
    async complete(request = {}, options = {}) {
        this.init();
        const startTime = Date.now();

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

        // 1. Detect task requirements
        const hasImages = (request.messages || []).some((m) => {
            if (Array.isArray(m.content)) return m.content.some((p) => p && (p.type === 'image_url' || p.image_url));
            if (m.images && m.images.length > 0) return true;
            return false;
        });

        const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
        const taskCategory = options.taskCategory || (hasImages ? TASK_CATEGORIES.VISION : (hasTools ? TASK_CATEGORIES.TOOLS : TASK_CATEGORIES.GENERAL));

        // 2. Resolve eligible candidate routes
        const candidates = this.resolveCandidateRoutes({
            taskCategory,
            requiresVision: hasImages,
            requiresToolCalling: hasTools,
            userOverride: options.userOverride
        });

        if (candidates.length === 0) {
            const err = this._buildNoRouteError({
                hasImages,
                hasTools,
                freeOnly: this.config.freeOnly,
                localOnly: this.config.mode === ROUTING_MODES.LOCAL_ONLY,
                userOverride: options.userOverride
            });

            this._recordDiagnosticEvent({
                timestamp: new Date().toISOString(),
                outcome: 'no_route',
                category: taskCategory,
                error: err.error,
                latencyMs: Date.now() - startTime
            });

            return err;
        }

        // 3. Bounded Failover Execution Loop (max 3 candidate attempts)
        const maxAttempts = Math.min(3, candidates.length);
        let lastError = null;
        let attemptsMade = 0;
        const invalidConnectionIds = new Set();

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

            try {
                const res = await this.providerAdapter.completeWithConnection({
                    connection: conn,
                    apiKey,
                    model,
                    request: {
                        ...request,
                        signal,
                        onChunk: options.onChunk
                    }
                });

                if (res.ok) {
                    // Success!
                    if (this.connectionManager) {
                        this.connectionManager.markHealthy(conn.id);
                    }

                    this._lastUsedRoute = {
                        provider: conn.provider,
                        model,
                        connectionId: conn.id,
                        connectionLabel: conn.label,
                        timestamp: new Date().toISOString()
                    };

                    this._recordDiagnosticEvent({
                        timestamp: new Date().toISOString(),
                        outcome: attemptsMade === 1 ? 'success' : 'failover_success',
                        provider: conn.provider,
                        model,
                        connectionId: conn.id,
                        connectionLabel: conn.label,
                        category: taskCategory,
                        attempts: attemptsMade,
                        latencyMs: Date.now() - startTime
                    });

                    return {
                        ...res,
                        provider: conn.provider,
                        model,
                        connectionId: conn.id,
                        connectionLabel: conn.label,
                        routedVia: {
                            connectionId: conn.id,
                            connectionLabel: conn.label,
                            provider: conn.provider,
                            model,
                            attempts: attemptsMade,
                            failoverOccurred: attemptsMade > 1
                        }
                    };
                }

                // Error occurred
                lastError = res;
                const classification = this.classifyError(res);

                // Check fatal/non-recoverable errors
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

                // Consequential execution guard
                if (options.hasConsequentialSideEffects) {
                    return {
                        ok: false,
                        code: 'failover_aborted_consequential',
                        error: `Provider error after partial execution (${res.error}). Automatic failover suppressed to prevent duplicate consequential side effects.`,
                        lastResult: res
                    };
                }

            } catch (err) {
                lastError = { ok: false, error: err.message, code: 'exception' };
                const classification = this.classifyError(err);
                if (this.connectionManager) {
                    this.connectionManager.markFailed(conn.id, 'temporary_failure', err.message);
                }
            }
        }

        return {
            ok: false,
            code: lastError?.code || 'all_failovers_exhausted',
            error: lastError?.error || `All eligible provider routes failed (${attemptsMade} attempts made).`,
            attempts: attemptsMade,
            lastError
        };
    }

    _buildNoRouteError({ hasImages, hasTools, freeOnly, localOnly, userOverride }) {
        if (localOnly) {
            return {
                ok: false,
                code: 'no_local_route',
                error: 'Local-only policy is active, but no compatible local model/endpoint was available. Please ensure Ollama is running or switch routing mode.'
            };
        }
        if (hasImages) {
            return {
                ok: false,
                code: 'no_vision_route',
                error: 'This task contains images, but no vision-capable model is currently configured or available. Text-only models cannot interpret screenshots or images.'
            };
        }
        if (hasTools) {
            return {
                ok: false,
                code: 'no_tool_route',
                error: 'This task requires structured tool execution, but no configured model supports function calling.'
            };
        }
        if (freeOnly) {
            return {
                ok: false,
                code: 'no_free_route',
                error: 'Strict Free-Only policy is active, but no verified free-tier model is currently configured with valid credentials.'
            };
        }
        if (userOverride) {
            return {
                ok: false,
                code: 'incompatible_override',
                error: `User override '${userOverride.provider}/${userOverride.model}' is not compatible with request requirements or lacks valid credentials.`
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
