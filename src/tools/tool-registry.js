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
            capabilities: Array.isArray(tool.capabilities) ? tool.capabilities : [],
            inputContract: tool.inputContract || null,
            outputContract: tool.outputContract || null,
            parameterAdapter: typeof tool.parameterAdapter === 'function' ? tool.parameterAdapter : null,
            pluginId: tool.pluginId || null,
            active: tool.active !== false,
            reconcile: typeof tool.reconcile === 'function' ? tool.reconcile : null
        };

        this.tools.set(tool.id, registeredRecord);
        return registeredRecord;
    }

    hasTool(toolId) {
        return this.tools.has(toolId);
    }

    getTool(toolId) {
        return this.tools.get(toolId) || null;
    }

    _inferCategory(toolId) {
        if (!toolId || typeof toolId !== 'string') return 'general';
        if (toolId.startsWith('file_') || toolId.startsWith('fs_')) return 'filesystem';
        if (toolId.startsWith('browser_') || toolId.startsWith('web_')) return 'browser';
        if (toolId.startsWith('desktop_') || toolId.startsWith('uia_')) return 'desktop';
        if (toolId.startsWith('memory_')) return 'memory';
        if (toolId.startsWith('system_') || toolId.startsWith('os_')) return 'system';
        if (toolId.startsWith('visual_')) return 'visual';
        return 'general';
    }

    _inferOperation(toolId) {
        if (!toolId || typeof toolId !== 'string') return null;
        const idLower = toolId.toLowerCase();
        if (/(?:^|[._-])(?:read|reader|reading|cat|fetch|fetcher|get_content)(?:[._-]|$)/.test(idLower)) {
            return 'read';
        }
        if (/(?:^|[._-])(?:write|writer|writing|save|saver|append|edit|editor|modify)(?:[._-]|$)/.test(idLower)) {
            return 'write';
        }
        if (/(?:^|[._-])(?:delete|deleter|remove|remover|unlink|rm|destroy)(?:[._-]|$)/.test(idLower)) {
            return 'delete';
        }
        if (/(?:^|[._-])(?:list|lister|listing|readdir|ls)(?:[._-]|$)/.test(idLower)) {
            return 'list';
        }
        if (/(?:^|[._-])(?:stat|status|metadata|exists)(?:[._-]|$)/.test(idLower)) {
            return 'stat';
        }
        if (/(?:^|[._-])(?:search|searcher|find|finder|grep|query)(?:[._-]|$)/.test(idLower)) {
            return 'search';
        }
        if (/(?:^|[._-])(?:mkdir|make_dir|createdir)(?:[._-]|$)/.test(idLower)) {
            return 'mkdir';
        }
        if (/(?:^|[._-])(?:copy|copier|cp)(?:[._-]|$)/.test(idLower)) {
            return 'copy';
        }
        if (/(?:^|[._-])(?:move|mover|rename|mv)(?:[._-]|$)/.test(idLower)) {
            return 'move';
        }
        if (/(?:^|[._-])(?:launch|launcher|spawn|run|runner|execute|executor)(?:[._-]|$)/.test(idLower)) {
            return 'launch';
        }
        if (/(?:^|[._-])(?:navigate|navigator|browse|browser|goto)(?:[._-]|$)/.test(idLower)) {
            return 'navigate';
        }
        if (/(?:^|[._-])(?:click|type|press|focus|interact)(?:[._-]|$)/.test(idLower)) {
            return 'interact';
        }
        return null;
    }

    /**
     * Check if a tool supports outcome reconciliation for uncertain execution outcomes.
     * @param {string} toolId
     * @returns {boolean}
     */
    hasReconciliation(toolId) {
        const tool = this.tools.get(toolId);
        return Boolean(tool && typeof tool.reconcile === 'function');
    }

    /**
     * Attempt automated outcome reconciliation for a step whose completion was uncertain.
     * @param {string} toolId
     * @param {Object} [params={}]
     * @param {Object} [context={}]
     * @returns {Promise<{ ok: boolean, resolved: boolean, status?: string, details?: any, canReplay?: boolean, error?: string }>}
     */
    async reconcile(toolId, params = {}, context = {}) {
        const tool = this.tools.get(toolId);
        if (!tool) {
            return { ok: false, resolved: false, status: 'indeterminate', canReplay: false, error: `Tool not found: ${toolId}` };
        }
        if (!tool.active) {
            return { ok: false, resolved: false, status: 'indeterminate', canReplay: false, error: `Tool '${toolId}' is inactive` };
        }
        if (typeof tool.reconcile !== 'function') {
            return { ok: false, resolved: false, status: 'indeterminate', canReplay: false, error: `Tool '${toolId}' does not provide reconciliation capability` };
        }
        try {
            const outcome = await tool.reconcile(params, context);
            if (!outcome || typeof outcome !== 'object') {
                return {
                    ok: false,
                    resolved: false,
                    status: 'indeterminate',
                    canReplay: false,
                    error: 'Malformed reconciliation outcome: expected object response'
                };
            }

            const rawStatus = typeof outcome.status === 'string' ? outcome.status.trim() : '';
            const VALID_STATUSES = ['confirmed_success', 'confirmed_failure', 'indeterminate'];
            
            // Reject arbitrary/unknown statuses fail-closed
            if (!VALID_STATUSES.includes(rawStatus)) {
                return {
                    ok: false,
                    resolved: false,
                    status: 'indeterminate',
                    canReplay: false,
                    details: outcome.details || outcome,
                    error: `Reconciliation returned unrecognized or unauthoritative status: '${rawStatus}'`
                };
            }

            const isResolved = Boolean(outcome.resolved && rawStatus !== 'indeterminate');
            
            // For confirmed_failure: canReplay is strictly permitted ONLY if explicitly verified that no side effect occurred
            let safeReplay = false;
            if (rawStatus === 'confirmed_failure' && outcome.canReplay) {
                const sideEffectAbsent = outcome.sideEffectOccurred === false ||
                    outcome.details?.sideEffectOccurred === false ||
                    outcome.noSideEffectConfirmed === true;
                safeReplay = Boolean(sideEffectAbsent);
            }

            return {
                ok: true,
                resolved: isResolved,
                status: isResolved ? rawStatus : 'indeterminate',
                details: outcome.details || outcome,
                canReplay: safeReplay
            };
        } catch (err) {
            return {
                ok: false,
                resolved: false,
                status: 'reconciliation_error',
                canReplay: false,
                error: err.message
            };
        }
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
                capabilities: t.capabilities || [],
                inputContract: t.inputContract,
                outputContract: t.outputContract,
                version: t.version,
                pluginId: t.pluginId,
                active: t.active,
                supportsReconciliation: typeof t.reconcile === 'function'
            });
        }
        return result;
    }

    /**
     * Context-Aware Fallback Tool Routing (REQ-FALLBACK-ROUTING)
     * Deterministically finds and ranks registered fallback candidates for a failed tool.
     * Evaluates capabilities, input schema validity, output contract compatibility,
     * availability in current environment, and independent permission authority boundaries.
     *
     * @param {Object} options
     * @param {string} options.failedToolId - The tool that failed
     * @param {Object} [options.step={}] - The plan step being executed
     * @param {Object} [options.params={}] - Parameters passed to the failed step
     * @param {Array<string>} [options.requiredCapabilities=[]] - Required capability tags
     * @param {Array<string>} [options.requiredOutputs=[]] - Required output keys
     * @param {Set<string>|Array<string>} [options.failedTools] - Tools already failed in this task
     * @param {Object} [options.context={}] - Execution context (e.g. dryRun, taskId)
     * @returns {Promise<{ candidates: Array<Object>, rejected: Array<Object> }>}
     */
    async findFallbackCandidates(options = {}) {
        const {
            failedToolId,
            step = {},
            params = {},
            requiredCapabilities = [],
            requiredOutputs = [],
            failedTools = new Set(),
            context = {}
        } = options;

        const attemptedSet = failedTools instanceof Set
            ? new Set(failedTools)
            : new Set(Array.isArray(failedTools) ? failedTools : []);
        if (failedToolId) {
            attemptedSet.add(failedToolId);
        }

        const failedTool = this.tools.get(failedToolId) || null;
        const failedCategory = failedTool ? failedTool.category : (step.category || this._inferCategory(failedToolId || ''));
        const failedRiskTier = failedTool ? failedTool.riskTier : (step.riskTier || RISK_TIERS.SAFE_READ);

        const candidates = [];
        const rejected = [];

        // Derive required capabilities
        const targetCapabilities = new Set(requiredCapabilities);
        if (targetCapabilities.size === 0 && failedTool && Array.isArray(failedTool.capabilities)) {
            for (const cap of failedTool.capabilities) {
                targetCapabilities.add(cap);
            }
        }
        if (step.capability) {
            targetCapabilities.add(step.capability);
        }

        // Evaluate all registered tools
        for (const [toolId, candidate] of this.tools.entries()) {
            // 1. Condition: Cannot be the same failed candidate or already-failed candidate
            if (attemptedSet.has(toolId)) {
                rejected.push({
                    toolId,
                    status: 'rejected',
                    reason: 'already_attempted_or_failed'
                });
                continue;
            }

            // Exclude tools already completed in prior steps (never rerun completed steps as fallback)
            if (context.completedStepTools && context.completedStepTools.includes(toolId)) {
                rejected.push({
                    toolId,
                    status: 'rejected',
                    reason: 'already_completed_prior_step'
                });
                continue;
            }

            // Exclude tools already declared in other steps of the DAG
            if (context.planStepTools && context.planStepTools.includes(toolId)) {
                rejected.push({
                    toolId,
                    status: 'rejected',
                    reason: 'already_planned_in_task_dag'
                });
                continue;
            }

            // 2. Condition: Must be registered and active
            if (!candidate.active) {
                rejected.push({
                    toolId,
                    status: 'rejected',
                    reason: 'tool_deactivated'
                });
                continue;
            }

            // 3. Condition: Platform / environment availability check
            const avail = await this.checkAvailability(toolId, context);
            if (!avail.available) {
                rejected.push({
                    toolId,
                    status: 'rejected',
                    reason: `environment_unavailable: ${avail.reason || 'check failed'}`
                });
                continue;
            }

            // 4. Condition: Operation match (read vs write vs delete, etc.)
            const failedOp = this._inferOperation(failedToolId);
            const candidateOp = this._inferOperation(toolId);
            if (failedOp && candidateOp && failedOp !== candidateOp) {
                rejected.push({
                    toolId,
                    status: 'rejected',
                    reason: `incompatible_operation: failed tool requires '${failedOp}', candidate provides '${candidateOp}'`
                });
                continue;
            }

            // 5. Condition: Capability / category compatibility
            const candidateCaps = new Set(Array.isArray(candidate.capabilities) ? candidate.capabilities : []);
            if (candidate.category) candidateCaps.add(candidate.category);

            let capabilityMatchScore = 0;
            let hasCapabilityOverlap = false;

            if (targetCapabilities.size > 0) {
                let hasCapabilityMatch = false;
                for (const cap of targetCapabilities) {
                    if (candidateCaps.has(cap)) {
                        hasCapabilityMatch = true;
                        capabilityMatchScore += 10;
                    }
                }
                if (!hasCapabilityMatch) {
                    rejected.push({
                        toolId,
                        status: 'rejected',
                        reason: `incompatible_capability: candidate does not support required capabilities [${[...targetCapabilities].join(', ')}]`
                    });
                    continue;
                }
                hasCapabilityOverlap = true;
            }

            const categoryMatches = Boolean(
                candidate.category &&
                candidate.category === failedCategory &&
                candidate.category !== 'general'
            );
            if (categoryMatches) {
                capabilityMatchScore += 5;
                hasCapabilityOverlap = true;
            }

            // If general category or either is general, require explicit non-general matching capabilities
            if (failedCategory === 'general' || candidate.category === 'general') {
                const hasMatchingExplicitCap = Array.isArray(candidate.capabilities) && candidate.capabilities.some(c =>
                    c && c !== 'general' && (targetCapabilities.has(c) || (Array.isArray(failedTool?.capabilities) && failedTool.capabilities.includes(c)))
                );
                if (!hasMatchingExplicitCap) {
                    rejected.push({
                        toolId,
                        status: 'rejected',
                        reason: 'general_category_requires_explicit_matching_capabilities'
                    });
                    continue;
                }
            }

            // If neither explicit capabilities nor valid category match, reject
            if (!hasCapabilityOverlap) {
                rejected.push({
                    toolId,
                    status: 'rejected',
                    reason: `incompatible_capability: candidate does not support required capabilities [${[...targetCapabilities].join(', ')}] or category '${failedCategory}'`
                });
                continue;
            }

            // 5. Condition: Input schema compatibility & parameter adaptation
            let adaptedParams = { ...params };
            if (typeof candidate.parameterAdapter === 'function') {
                try {
                    adaptedParams = await candidate.parameterAdapter(params, step);
                } catch (adaptErr) {
                    rejected.push({
                        toolId,
                        status: 'rejected',
                        reason: `parameter_adaptation_failed: ${adaptErr.message}`
                    });
                    continue;
                }
            }

            // Validate adapted parameters against candidate's JSON schema
            if (candidate.schema && typeof candidate.schema === 'object' && Object.keys(candidate.schema).length > 0) {
                const schemaValidation = validateToolArguments(candidate.schema, adaptedParams);
                if (!schemaValidation.valid) {
                    rejected.push({
                        toolId,
                        status: 'rejected',
                        reason: `incompatible_input_schema: ${schemaValidation.error}`
                    });
                    continue;
                }
            }

            // 6. Condition: Output contract compatibility
            if (requiredOutputs && requiredOutputs.length > 0) {
                if (candidate.outputSchema && typeof candidate.outputSchema === 'object') {
                    const schemaProps = candidate.outputSchema.properties || {};
                    const missingOutputs = requiredOutputs.filter(reqOut => !(reqOut in schemaProps));
                    if (missingOutputs.length > 0 && candidate.outputSchema.strictOutputCheck) {
                        rejected.push({
                            toolId,
                            status: 'rejected',
                            reason: `incompatible_output_contract: candidate does not guarantee required output properties: ${missingOutputs.join(', ')}`
                        });
                        continue;
                    }
                }
                if (candidate.outputContract && Array.isArray(candidate.outputContract.provides)) {
                    const provides = new Set(candidate.outputContract.provides);
                    const missingOutputs = requiredOutputs.filter(reqOut => !provides.has(reqOut));
                    if (missingOutputs.length > 0) {
                        rejected.push({
                            toolId,
                            status: 'rejected',
                            reason: `incompatible_output_contract: candidate missing output contract capabilities: ${missingOutputs.join(', ')}`
                        });
                        continue;
                    }
                }
            }

            // 7. Condition: Independent Permission Authority Boundary
            // Fallback cannot bypass permission or silently elevate privilege
            let requiresUserApproval = false;
            let authReason = '';

            if (this.permissionAuthority) {
                const action = adaptedParams.action || 'default';
                const authDecision = await this.permissionAuthority.evaluate({
                    toolId: candidate.id,
                    action,
                    riskTier: candidate.riskTier,
                    params: adaptedParams,
                    dryRun: Boolean(context.dryRun)
                });

                if (!authDecision.permitted) {
                    // If permission was denied fail-closed
                    rejected.push({
                        toolId,
                        status: 'rejected',
                        reason: `permission_authority_denied: ${authDecision.reason}`
                    });
                    continue;
                }

                if (authDecision.status === 'awaiting_approval' || authDecision.requiresConfirmation) {
                    requiresUserApproval = true;
                }
                authReason = authDecision.reason || '';
            }

            // 8. Deterministic ranking score calculation
            let score = capabilityMatchScore;
            // Same risk tier preference (avoids unexpected privilege jumps)
            if (candidate.riskTier === failedRiskTier) {
                score += 5;
            } else if (candidate.riskTier === RISK_TIERS.SAFE_READ && failedRiskTier !== RISK_TIERS.SAFE_READ) {
                score += 8; // Prefer safer read-only fallback when available
            }
            // Zero parameter adaptation bonus
            if (!candidate.parameterAdapter) {
                score += 2;
            }

            candidates.push({
                id: candidate.id,
                name: candidate.name,
                toolId: candidate.id,
                category: candidate.category,
                riskTier: candidate.riskTier,
                score,
                adaptedParams,
                requiresUserApproval,
                authReason,
                rationale: `Matched category '${candidate.category}' with capability score ${score}`
            });
        }

        // Sort deterministically: highest score first, ties broken lexicographically by ID
        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.id.localeCompare(b.id);
        });

        return {
            candidates,
            rejected
        };
    }

    /**
     * Find registered tools providing a specific capability or matching explicit capability criteria.
     * Evaluates explicit tool capabilities metadata, operational category, and environment availability.
     * 
     * @param {string|Array<string>} requiredCapabilities - Required capability tag(s)
     * @param {Object} [options={}]
     * @param {boolean} [options.activeOnly=true]
     * @param {Object} [options.context={}]
     * @returns {Promise<Array<Object>>} Matching tools ranked by relevance
     */
    async findToolsByCapability(requiredCapabilities, options = {}) {
        const caps = Array.isArray(requiredCapabilities) ? requiredCapabilities : [requiredCapabilities];
        const activeOnly = options.activeOnly !== false;
        const matches = [];

        for (const tool of this.tools.values()) {
            if (activeOnly && !tool.active) continue;

            const toolCaps = Array.isArray(tool.capabilities) ? tool.capabilities : [];
            const hasCap = caps.some((c) => toolCaps.includes(c) || tool.category === c);

            if (hasCap) {
                const avail = await this.checkAvailability(tool.id, options.context || {});
                if (avail.available) {
                    matches.push({
                        ...tool,
                        matchScore: toolCaps.some((c) => caps.includes(c)) ? 10 : 5
                    });
                }
            }
        }

        matches.sort((a, b) => b.matchScore - a.matchScore || a.id.localeCompare(b.id));
        return matches;
    }

    /**
     * Dynamically select the most suitable tool for a required capability and parameter set.
     * Evaluates capability metadata, JSON schema validity of parameters, platform availability,
     * and independent permission authority boundaries.
     * Prevents selecting tools solely based on name resemblance.
     * 
     * @param {string} capability - Required capability (e.g. 'system_inspection', 'file_read')
     * @param {Object} [params={}] - Proposed parameters to validate against schema
     * @param {Object} [options={}] - Context options (e.g. dryRun, taskId)
     * @returns {Promise<{ selectedTool: Object|null, validation: Object, permission: Object|null, candidates: Array<Object>, rejected: Array<Object> }>}
     */
    async selectToolForCapability(capability, params = {}, options = {}) {
        const candidates = await this.findToolsByCapability(capability, options);
        const rejected = [];

        for (const candidate of candidates) {
            // Validate arguments against tool schema
            const schemaValidation = validateToolArguments(candidate.schema, params);
            if (!schemaValidation.valid) {
                rejected.push({
                    toolId: candidate.id,
                    reason: `incompatible_arguments: ${schemaValidation.error}`,
                    missingParameter: schemaValidation.missingParameter
                });
                continue;
            }

            // Check permission authority if configured
            let permDecision = null;
            if (this.permissionAuthority) {
                const action = params.action || 'default';
                permDecision = await this.permissionAuthority.evaluate({
                    toolId: candidate.id,
                    action,
                    riskTier: candidate.riskTier,
                    params,
                    dryRun: Boolean(options.dryRun)
                });

                if (!permDecision.permitted) {
                    rejected.push({
                        toolId: candidate.id,
                        reason: `permission_denied: ${permDecision.reason}`
                    });
                    continue;
                }
            }

            return {
                selectedTool: candidate,
                validation: schemaValidation,
                permission: permDecision,
                candidates,
                rejected
            };
        }

        return {
            selectedTool: null,
            validation: { valid: false, error: 'No compatible registered tool found for capability' },
            permission: null,
            candidates,
            rejected
        };
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
    _sanitizeForLog(obj, seen = new WeakSet(), parentIsSensitive = false) {
        if (!obj || typeof obj !== 'object') return obj;
        if (seen.has(obj)) return '[CIRCULAR]';
        seen.add(obj);

        const SENSITIVE_KEYS = ['password', 'apiKey', 'token', 'secret', 'authorization', 'credential', 'authKey'];
        const isSensitiveContext = Boolean(
            parentIsSensitive ||
            obj.isSecret ||
            obj.secret ||
            /password|passwd|pwd|pin|secret|credential|token|auth/i.test(
                obj.automationId || obj.name || obj.controlName || obj.targetControl || obj.className || (typeof obj.target === 'string' ? obj.target : '')
            )
        );

        const copy = Array.isArray(obj) ? [] : {};
        for (const [k, v] of Object.entries(obj)) {
            if (SENSITIVE_KEYS.some(sk => k.toLowerCase().includes(sk.toLowerCase())) || (isSensitiveContext && (k === 'text' || k === 'readText'))) {
                copy[k] = '[REDACTED_SECRET]';
            } else if (v && typeof v === 'object') {
                copy[k] = this._sanitizeForLog(v, seen, isSensitiveContext);
            } else if (typeof v === 'string') {
                copy[k] = v
                    .replace(/sk-[a-zA-Z0-9_\-]{8,}/gi, '[REDACTED_SECRET]')
                    .replace(/bearer\s+[a-zA-Z0-9_\.\-]+/gi, 'Bearer [REDACTED_SECRET]')
                    .replace(/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED_SECRET]')
                    .replace(/ghp_[a-zA-Z0-9]{36}/gi, '[REDACTED_SECRET]');
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

            if (context) {
                context.permissionDecision = authDecision;
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
        const rawTimeout = (context && context.timeoutMs !== undefined && context.timeoutMs !== null)
            ? context.timeoutMs
            : tool.timeoutMs;
        const numTimeout = Number(rawTimeout);
        const timeoutMs = (Number.isFinite(numTimeout) && numTimeout > 0)
            ? Math.floor(numTimeout)
            : (rawTimeout === 0 ? 0 : 30000);

        let timeoutHandle = null;
        let abortCleanup = null;
        const racers = [];

        let isHandlerSettled = false;
        let handlerPromise;
        try {
            const rawHandlerPromise = Promise.resolve(tool.handler(params, context));
            handlerPromise = rawHandlerPromise.finally(() => {
                isHandlerSettled = true;
            });
        } catch (syncErr) {
            isHandlerSettled = true;
            handlerPromise = Promise.reject(syncErr);
        }

        if (context && typeof context.onHandlerStarted === 'function') {
            try {
                context.onHandlerStarted({
                    promise: handlerPromise,
                    isSettled: () => isHandlerSettled
                });
            } catch {
                // safe ignore
            }
        }

        racers.push(handlerPromise);

        if (timeoutMs > 0) {
            const timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    const err = new Error(`Tool execution for '${toolId}' timed out after ${timeoutMs}ms`);
                    err.code = 'TIMEOUT';
                    reject(err);
                }, timeoutMs);
            });
            racers.push(timeoutPromise);
        }

        if (context.signal) {
            if (context.signal.aborted) {
                const err = new Error('Task execution was cancelled during tool operation.');
                err.code = 'ABORT_ERR';
                err.name = 'AbortError';
                racers.push(Promise.reject(err));
            } else {
                const abortPromise = new Promise((_, reject) => {
                    const onAbort = () => {
                        const err = new Error('Task execution was cancelled during tool operation.');
                        err.code = 'ABORT_ERR';
                        err.name = 'AbortError';
                        reject(err);
                    };
                    context.signal.addEventListener('abort', onAbort, { once: true });
                    abortCleanup = () => context.signal.removeEventListener('abort', onAbort);
                });
                racers.push(abortPromise);
            }
        }

        try {
            const rawResult = await Promise.race(racers);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (abortCleanup) abortCleanup();

            if (context.signal && context.signal.aborted) {
                return {
                    ok: false,
                    status: 'cancelled',
                    error: 'Task execution was cancelled during tool operation.',
                    cancelled: true,
                    toolId,
                    isHandlerSettled: () => isHandlerSettled,
                    handlerPromise
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
                },
                isHandlerSettled: () => isHandlerSettled,
                handlerPromise
            };

            // Store in recent executions for idempotency
            if (idempotencyKey && finalResult.ok) {
                this.recentExecutions.set(idempotencyKey, { timestamp: Date.now(), result: finalResult });
            }

            this._logExecution({ toolId, params, dryRun: false, result: finalResult });
            return finalResult;
        } catch (err) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (abortCleanup) abortCleanup();

            const durationMs = Date.now() - startTime;
            const isCancelled = (context.signal && context.signal.aborted) ||
                                err.code === 'ABORT_ERR' ||
                                err.name === 'AbortError' ||
                                err.message?.includes('cancelled');
            const isTimeout = err.code === 'TIMEOUT' || err.message?.includes('timed out');

            const errorResult = {
                ok: false,
                status: isCancelled ? 'cancelled' : (isTimeout ? 'timed_out' : 'execution_failed'),
                dryRun: false,
                executed: true,
                cancelled: isCancelled,
                timedOut: isTimeout,
                toolId,
                action,
                durationMs,
                error: err.message,
                code: err.code,
                verification: { verified: false, failureReason: err.message },
                isHandlerSettled: () => isHandlerSettled,
                handlerPromise
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
