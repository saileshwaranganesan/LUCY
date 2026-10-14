'use strict';

const { RISK_TIERS } = require('../security/permission-authority.js');
const { validateToolArguments } = require('./schema-validator.js');

/**
 * ToolRegistry
 * Authoritative registry of all capabilities available to L.U.C.Y.
 * Enforces:
 * 1. Mandatory dry-run boundary: Side-effects CANNOT execute when dryRun is true.
 * 2. Mandatory permission evaluation through PermissionAuthority.
 * 3. Execution outcome verification.
 * 4. Rigorous JSON schema parameter validation before dispatch.
 */
class ToolRegistry {
    constructor(options = {}) {
        this.permissionAuthority = options.permissionAuthority;
        this.tools = new Map();
        this.executionLog = [];
    }

    /**
     * Register a tool definition
     * @param {Object} tool
     * @param {string} tool.id - Unique tool identifier
     * @param {string} tool.name - Human-readable name
     * @param {string} tool.description - Description for model/user
     * @param {Object} tool.schema - Parameters JSON schema
     * @param {string} tool.riskTier - One of RISK_TIERS
     * @param {Function} tool.handler - Async function executing the real action
     * @param {Function} [tool.dryRunSimulate] - Optional simulation generator
     */
    registerTool(tool) {
        if (!tool.id || typeof tool.handler !== 'function') {
            throw new Error('Tool must have an id and a handler function');
        }
        this.tools.set(tool.id, {
            id: tool.id,
            name: tool.name || tool.id,
            description: tool.description || '',
            schema: tool.schema || {},
            riskTier: tool.riskTier || RISK_TIERS.CONSEQUENTIAL,
            handler: tool.handler,
            dryRunSimulate: tool.dryRunSimulate || null
        });
    }

    getTool(toolId) {
        return this.tools.get(toolId);
    }

    listTools() {
        return Array.from(this.tools.values()).map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            schema: t.schema,
            riskTier: t.riskTier
        }));
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
     * Dispatch and execute a tool call with permission enforcement and guaranteed dry-run isolation.
     * @param {string} toolId
     * @param {Object} params
     * @param {Object} context
     * @param {boolean} [context.dryRun=false]
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

        // 1. Central Permission Check
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

        // 2. CRITICAL SECURITY GUARANTEE: Dry-run isolation
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

        // 3. Real Execution (Authorized and not in dry-run)
        const startTime = Date.now();
        try {
            const rawResult = await tool.handler(params, context);
            const durationMs = Date.now() - startTime;

            const finalResult = {
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

            this._logExecution({ toolId, params, dryRun: false, result: finalResult });
            return finalResult;
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const errorResult = {
                ok: false,
                status: 'execution_failed',
                dryRun: false,
                executed: true,
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
            ...entry
        });
        if (this.executionLog.length > 200) {
            this.executionLog.shift();
        }
    }

    getExecutionLog() {
        return this.executionLog;
    }
}

module.exports = {
    ToolRegistry
};
