'use strict';

const { RISK_TIERS } = require('../security/permission-authority.js');
const { validateToolArguments } = require('./schema-validator.js');

const TOOL_EXECUTION_STATES = Object.freeze({
    REQUESTED: 'requested',
    VALIDATING: 'validating',
    AWAITING_APPROVAL: 'awaiting_approval',
    READY: 'ready',
    RUNNING: 'running',
    VERIFYING: 'verifying',
    SUCCEEDED: 'completed',
    FAILED: 'execution_failed',
    PARTIALLY_COMPLETED: 'partially_completed',
    CANCELLED: 'cancelled'
});

/**
 * ToolRegistry
 * Authoritative registry of all capabilities available to L.U.C.Y.
 * 
 * Enforces:
 * 1. Strict definition validation and duplicate tool registration prevention.
 * 2. Mandatory dry-run boundary: Side-effects CANNOT execute when dryRun is true.
 * 3. Mandatory permission evaluation through PermissionAuthority.
 * 4. Task-relevant tool selection to optimize context budget and prevent hallucinations.
 * 5. Execution outcome verification and structured error classification.
 * 6. Bounded execution timeouts and cancellation support.
 * 7. Duplicate consequential execution prevention (idempotency).
 * 8. Sanitized execution logging that avoids credential or secret leakage.
 */
class ToolRegistry {
    constructor(options = {}) {
        this.permissionAuthority = options.permissionAuthority || null;
        this.tools = new Map();
        this.executionLog = [];
        this.recentExecutions = new Map(); // idempotency tracking: key -> { timestamp, result }
        this.maxExecutionLogSize = options.maxExecutionLogSize || 200;
    }

    /**
     * Validate a tool definition before registration
     * @param {Object} tool
     */
    _validateToolDefinition(tool) {
        if (!tool || typeof tool !== 'object') {
            throw new Error('Tool definition must be an object');
        }
        if (!tool.id || typeof tool.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tool.id)) {
            throw new Error(`Tool must have a valid string 'id' (alphanumeric, underscore, hyphen). Received: ${tool?.id}`);
        }
        if (typeof tool.handler !== 'function') {
            throw new Error(`Tool '${tool.id}' must provide a handler function`);
        }
        if (tool.schema && typeof tool.schema !== 'object') {
            throw new Error(`Tool '${tool.id}' schema must be a valid JSON Schema object`);
        }
    }

    /**
     * Register a tool definition.
     * Prevents duplicate registrations unless allowOverride is explicitly true.
     * 
     * @param {Object} tool
     * @param {string} tool.id - Unique tool identifier
     * @param {string} tool.name - Human-readable name
     * @param {string} tool.description - Description for model/user
     * @param {Object} tool.schema - Parameters JSON schema
     * @param {Object} [tool.outputSchema] - Output verification schema
     * @param {string} tool.riskTier - One of RISK_TIERS
     * @param {Function} tool.handler - Async function executing the real action
     * @param {Function} [tool.dryRunSimulate] - Optional simulation generator
     * @param {Function} [tool.availabilityCheck] - Optional availability check function
     * @param {number} [tool.timeoutMs=30000] - Execution timeout in ms
     * @param {boolean} [tool.supportsCancellation=true] - Whether cancellation is supported
     * @param {string} [tool.version='1.0.0'] - Version
     * @param {string} [tool.category='general'] - Category tag
     * @param {string} [tool.pluginId] - Associated plugin ID if registered by an extension
     * @param {Object} [options={}]
     * @param {boolean} [options.allowOverride=false]
     */
    registerTool(tool, options = {}) {
        this._validateToolDefinition(tool);

        if (this.tools.has(tool.id) && !options.allowOverride) {
            throw new Error(`Tool '${tool.id}' is already registered. Use allowOverride: true to replace.`);
        }

        const registeredRecord = {
            id: tool.id,
            name: tool.name || tool.id,
            description: tool.description || '',
            schema: tool.schema || {},
            outputSchema: tool.outputSchema || null,
            riskTier: tool.riskTier || RISK_TIERS.CONSEQUENTIAL,
            handler: tool.handler,
            dryRunSimulate: tool.dryRunSimulate || null,
            availabilityCheck: typeof tool.availabilityCheck === 'function' ? tool.availabilityCheck : async () => ({ available: true }),
            timeoutMs: typeof tool.timeoutMs === 'number' && tool.timeoutMs > 0 ? tool.timeoutMs : 30000,
            supportsCancellation: tool.supportsCancellation !== false,
            version: tool.version || '1.0.0',
            category: tool.category || this._inferCategory(tool.id),
            pluginId: tool.pluginId || null,
            active: tool.active !== false
        };

        this.tools.set(tool.id, registeredRecord);
        return registeredRecord;
    }

    _inferCategory(toolId) {
        if (toolId.startsWith('file_')) return 'filesystem';
        if (toolId.startsWith('browser_')) return 'browser';
        if (toolId.startsWith('desktop_')) return 'desktop';
        if (toolId.startsWith('memory_')) return 'memory';
        if (toolId.startsWith('system_')) return 'system';
        if (toolId.startsWith('visual_')) return 'visual';
        return 'general';
    }

    /**
     * Unregister a tool
     * @param {string} toolId
     * @returns {boolean}
     */
    unregisterTool(toolId) {
        return this.tools.delete(toolId);
    }

    /**
     * Deactivate a tool temporarily without removing it
     * @param {string} toolId
     * @returns {boolean}
     */
    deactivateTool(toolId) {
        const tool = this.tools.get(toolId);
        if (!tool) return false;
        tool.active = false;
        return true;
    }

    /**
     * Reactivate a deactivated tool
     * @param {string} toolId
     * @returns {boolean}
     */
    activateTool(toolId) {
        const tool = this.tools.get(toolId);
        if (!tool) return false;
        tool.active = true;
        return true;
    }

    isToolActive(toolId) {
        const tool = this.tools.get(toolId);
        return Boolean(tool && tool.active);
    }

    setPermissionAuthority(authority) {
        this.permissionAuthority = authority;
    }

    getTool(toolId) {
        return this.tools.get(toolId);
    }

    /**
     * Check if a tool is available on this environment (e.g., OS platform, binaries present)
     * @param {string} toolId
     * @param {Object} [context={}]
     * @returns {Promise<{ available: boolean, reason?: string }>}
     */
    async checkAvailability(toolId, context = {}) {
        const tool = this.tools.get(toolId);
        if (!tool) {
            return { available: false, reason: `Tool not found: ${toolId}` };
        }
        if (!tool.active) {
            return { available: false, reason: `Tool '${toolId}' is currently deactivated` };
        }
        try {
            const res = await tool.availabilityCheck(context);
            if (res && res.available === false) {
                return { available: false, reason: res.reason || `Tool '${toolId}' is unavailable in current environment` };
            }
            return { available: true };
        } catch (err) {
            return { available: false, reason: `Availability check error: ${err.message}` };
        }
    }

    /**
     * List all registered tools
     * @param {Object} [filter={}]
     * @param {boolean} [filter.activeOnly=true]
     * @returns {Array<Object>}
     */
    listTools(filter = {}) {
        const activeOnly = filter.activeOnly !== false;
        const result = [];
        for (const t of this.tools.values()) {
            if (activeOnly && !t.active) continue;
            result.push({
                id: t.id,
                name: t.name,
                description: t.description,
                schema: t.schema,
                outputSchema: t.outputSchema,
                riskTier: t.riskTier,
                category: t.category,
                version: t.version,
                pluginId: t.pluginId,
                active: t.active
            });
        }
        return result;
    }

    /**
     * Task-Relevant Capability Selection (REQ-TOOL-ROUTING)
     * Filters available tools based on user request keywords and semantic category.
     * Prevents bloating the LLM prompt with 50+ irrelevant tools, reducing hallucinations and token usage.
     * 
     * @param {string} userRequest
     * @param {Object} [context={}]
     * @returns {Array<Object>} Filtered list of relevant tool definitions
     */
    getToolsForTask(userRequest, context = {}) {
        const allTools = this.listTools({ activeOnly: true });
        const request = String(userRequest || '').toLowerCase().trim();

        if (!request || context.allTools === true) {
            return allTools;
        }

        const relevantCategories = new Set(['general']);
        const forcedToolIds = new Set();

        // 1. Filesystem detection
        if (/\b(?:files?|folders?|directories|directory|read|write|save|create\s+note|markdown|txt|open\s+file|mkdir|copy|move|delete|readme)\b/i.test(request)) {
            relevantCategories.add('filesystem');
        }

        // 2. Desktop automation detection
        if (/\b(?:apps?|applications?|windows?|notepad|calculator|launch|close|click|type|switch|gui|uia|desktop|running)\b/i.test(request)) {
            relevantCategories.add('desktop');
        }

        // 3. Browser automation & research detection
        if (/\b(?:web|browsers?|urls?|websites?|youtube|canvas|moodle|portal|navigate|search|scrape|extract|pages?|html|online)\b/i.test(request)) {
            relevantCategories.add('browser');
        }

        // 4. Memory detection
        if (/\b(?:remember|recall|memory|preference|fact|what\s+did\s+i|history|store|notes)\b/i.test(request)) {
            relevantCategories.add('memory');
        }

        // 5. System inspection detection
        if (/\b(?:system|specs|ram|memory\s+usage|cpu|uptime|host|os|platform|status)\b/i.test(request)) {
            relevantCategories.add('system');
        }

        // 6. Visual inspection detection
        if (/\b(?:look\s+at|see|screen|screenshot|what\s+is\s+on|visual|vision)\b/i.test(request)) {
            relevantCategories.add('visual');
        }

        // Check explicit tool ID mentions
        for (const tool of allTools) {
            if (request.includes(tool.id.toLowerCase())) {
                forcedToolIds.add(tool.id);
            }
        }

        // Filter tools
        const filtered = allTools.filter((t) => {
            if (forcedToolIds.has(t.id)) return true;
            if (relevantCategories.has(t.category)) return true;
            return false;
        });

        // Always ensure at least base tools if filtering narrowed down to 0
        if (filtered.length === 0) {
            return allTools;
        }

        return filtered;
    }

    /**
     * Validate proposed parameters against the registered tool's schema.
     * @param {string} toolId
     * @param {Object} [params={}]
     * @returns {{ valid: boolean, error?: string, missingParameter?: string }}
     */
    validateParams(toolId, params = {}) {
        const tool = this.tools.get(toolId);
        if (!tool) {
            return { valid: false, error: `Tool not found: ${toolId}` };
        }
        return validateToolArguments(tool.schema, params);
    }

    /**
     * Sanitize tool parameters and results for safe logging (removes tokens, keys, passwords).
     * @param {Object} obj
     * @returns {Object}
     */
    _sanitizeForLog(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const SENSITIVE_KEYS = ['password', 'apiKey', 'token', 'secret', 'authorization', 'credential', 'authKey'];
        const copy = Array.isArray(obj) ? [] : {};
        for (const [k, v] of Object.entries(obj)) {
            if (SENSITIVE_KEYS.some(sk => k.toLowerCase().includes(sk.toLowerCase()))) {
                copy[k] = '[REDACTED_SECRET]';
            } else if (v && typeof v === 'object') {
                copy[k] = this._sanitizeForLog(v);
            } else {
                copy[k] = v;
            }
        }
        return copy;
    }

    /**
     * Dispatch and execute a tool call with permission enforcement and guaranteed dry-run isolation.
     * 
     * Supported states:
     * - requested
     * - validating
     * - awaiting_approval
     * - ready
     * - running
     * - verifying
     * - completed (succeeded)
     * - execution_failed
     * - cancelled
     * 
     * @param {string} toolId
     * @param {Object} params
     * @param {Object} context
     * @param {boolean} [context.dryRun=false]
     * @param {AbortSignal} [context.signal]
     * @param {number} [context.timeoutMs]
     * @param {string} [context.idempotencyKey]
     * @returns {Promise<Object>} Execution or simulation result
     */
    async execute(toolId, params = {}, context = {}) {
        const tool = this.tools.get(toolId);
        if (!tool) {
            return {
                ok: false,
                status: 'error',
                error: `Tool not found: ${toolId}`,
                toolId
            };
        }

        if (context.signal && context.signal.aborted) {
            return {
                ok: false,
                status: 'cancelled',
                error: 'Task execution was cancelled before tool started.',
                cancelled: true,
                toolId
            };
        }

        // Availability check
        const availability = await this.checkAvailability(toolId, context);
        if (!availability.available) {
            return {
                ok: false,
                status: 'unavailable',
                error: availability.reason,
                toolId
            };
        }

        // Duplicate execution / Idempotency protection for consequential tools
        const idempotencyKey = context.idempotencyKey || (context.preventDuplicateConsequential && tool.riskTier !== RISK_TIERS.SAFE_READ
            ? `${toolId}:${JSON.stringify(params)}`
            : null);

        if (idempotencyKey && this.recentExecutions.has(idempotencyKey)) {
            const cached = this.recentExecutions.get(idempotencyKey);
            if (Date.now() - cached.timestamp < 10000) {
                // Return cached recent execution result to prevent accidental duplicate side-effects
                return {
                    ...cached.result,
                    deduplicated: true,
                    cachedReceipt: true
                };
            }
        }

        // 1. Parameter Validation before execution
        if (context.strictSchema) {
            const paramValidation = validateToolArguments(tool.schema, params);
            if (!paramValidation.valid) {
                const err = `Parameter validation failed for tool '${toolId}': ${paramValidation.error}`;
                return {
                    ok: false,
                    status: 'invalid_parameters',
                    error: err,
                    toolId,
                    missingParameter: paramValidation.missingParameter,
                    result: { ok: false, status: 'invalid_parameters', error: err },
                    verification: { verified: false, failureReason: err }
                };
            }
        } else if (tool.schema?.required && Array.isArray(tool.schema.required)) {
            for (const req of tool.schema.required) {
                if (params[req] === undefined || params[req] === null || (typeof params[req] === 'string' && params[req].trim() === '')) {
                    const err = `Missing required parameter '${req}' for tool '${toolId}'`;
                    return {
                        ok: false,
                        status: 'invalid_parameters',
                        error: err,
                        toolId,
                        missingParameter: req,
                        result: { ok: false, status: 'invalid_parameters', error: err },
                        verification: { verified: false, failureReason: err }
                    };
                }
            }
        }

        const dryRun = Boolean(context.dryRun);
        const action = params.action || 'default';

        // 2. Central Permission Check
        if (this.permissionAuthority) {
            const authDecision = await this.permissionAuthority.evaluate({
                toolId,
                action,
                riskTier: tool.riskTier,
                params,
                dryRun
            });

            if (!authDecision.permitted) {
                return {
                    ok: false,
                    status: 'permission_denied',
                    error: authDecision.reason,
                    auditId: authDecision.auditId,
                    toolId,
                    action
                };
            }
        }

        // 3. CRITICAL SECURITY GUARANTEE: Dry-run isolation
        // If dry-run is requested, the real tool handler is NEVER invoked under any circumstance.
        if (dryRun) {
            let simulatedDetails = {};
            if (typeof tool.dryRunSimulate === 'function') {
                try {
                    simulatedDetails = await tool.dryRunSimulate(params, context);
                } catch (simErr) {
                    simulatedDetails = { simulationNotice: simErr.message };
                }
            } else {
                simulatedDetails = {
                    action,
                    target: params.path || params.url || params.command || 'unspecified',
                    effect: `Would perform ${action} on specified target`
                };
            }

            const dryRunResult = {
                ok: true,
                status: 'dry_run_simulated',
                dryRun: true,
                executed: false,
                toolId,
                action,
                simulatedDetails,
                verification: { verified: true, method: 'dry_run_sandbox_interception' }
            };

            this._logExecution({ toolId, params, dryRun: true, result: dryRunResult });
            return dryRunResult;
        }

        // 4. Real Execution with Bounded Timeout and Cancellation
        const startTime = Date.now();
        const timeoutMs = context.timeoutMs || tool.timeoutMs || 30000;
        let timeoutHandle = null;

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                const err = new Error(`Tool execution for '${toolId}' timed out after ${timeoutMs}ms`);
                err.code = 'TIMEOUT';
                reject(err);
            }, timeoutMs);
        });

        try {
            const handlerPromise = tool.handler(params, context);
            const rawResult = await Promise.race([handlerPromise, timeoutPromise]);
            clearTimeout(timeoutHandle);

            if (context.signal && context.signal.aborted) {
                return {
                    ok: false,
                    status: 'cancelled',
                    error: 'Task execution was cancelled during tool operation.',
                    cancelled: true,
                    toolId
                };
            }

            const durationMs = Date.now() - startTime;
            const extraProps = (rawResult && typeof rawResult === 'object') ? rawResult : {};

            const finalResult = {
                ...extraProps,
                ok: rawResult?.ok !== false,
                status: rawResult?.status || 'completed',
                dryRun: false,
                executed: true,
                toolId,
                action,
                durationMs,
                error: rawResult?.ok === false ? rawResult.error : undefined,
                result: rawResult?.data ?? rawResult,
                verification: rawResult?.verification || {
                    verified: rawResult?.ok !== false,
                    method: 'handler_status_check'
                }
            };

            // Store in recent executions for idempotency
            if (idempotencyKey && finalResult.ok) {
                this.recentExecutions.set(idempotencyKey, { timestamp: Date.now(), result: finalResult });
            }

            this._logExecution({ toolId, params, dryRun: false, result: finalResult });
            return finalResult;
        } catch (err) {
            clearTimeout(timeoutHandle);
            const durationMs = Date.now() - startTime;
            const isCancelled = (context.signal && context.signal.aborted) || err.message?.includes('cancelled');

            const errorResult = {
                ok: false,
                status: isCancelled ? 'cancelled' : 'execution_failed',
                dryRun: false,
                executed: true,
                cancelled: isCancelled,
                toolId,
                action,
                durationMs,
                error: err.message,
                verification: { verified: false, failureReason: err.message }
            };

            this._logExecution({ toolId, params, dryRun: false, result: errorResult });
            return errorResult;
        }
    }

    _logExecution(entry) {
        this.executionLog.push({
            timestamp: new Date().toISOString(),
            toolId: entry.toolId,
            params: this._sanitizeForLog(entry.params),
            dryRun: entry.dryRun,
            result: this._sanitizeForLog(entry.result)
        });
        if (this.executionLog.length > this.maxExecutionLogSize) {
            this.executionLog.shift();
        }
    }

    getExecutionLog() {
        return this.executionLog;
    }
}

module.exports = {
    ToolRegistry,
    TOOL_EXECUTION_STATES
};
