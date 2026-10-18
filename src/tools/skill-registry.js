'use strict';

/**
 * SkillRegistry (REQ-SKILL-001)
 * 
 * Formalizes the distinction between a TOOL and a SKILL:
 * - A TOOL is an atomic, single-action primitive (e.g. file_read, browser_click, launch_app).
 * - A SKILL is a high-level composite workflow that orchestrates multiple tools,
 *   preconditions, state transformations, progress reporting, user approval gates,
 *   and error recovery/rollback strategies.
 * 
 * Enforces:
 * 1. Strict definition validation (id, name, purpose, workflow, required tools).
 * 2. Prerequisite & dependency verification against ToolRegistry.
 * 3. Standardized execution lifecycle with step-by-step progress callbacks.
 * 4. Permission & risk evaluation via PermissionAuthority.
 * 5. Bounded timeouts, cancellation (AbortSignal), and failure recovery.
 */

const { EventEmitter } = require('events');
const { RISK_TIERS } = require('../security/permission-authority.js');

const SKILL_EXECUTION_STATES = Object.freeze({
    REQUESTED: 'requested',
    VALIDATING: 'validating',
    AWAITING_APPROVAL: 'awaiting_approval',
    READY: 'ready',
    RUNNING: 'running',
    VERIFYING: 'verifying',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    PARTIALLY_COMPLETED: 'partially_completed',
    CANCELLED: 'cancelled'
});

class Skill {
    constructor(definition = {}) {
        this.validateDefinition(definition);

        this.id = definition.id;
        this.name = definition.name || definition.id;
        this.description = definition.description || '';
        this.purpose = definition.purpose || '';
        this.version = definition.version || '1.0.0';
        this.supportedTasks = Array.isArray(definition.supportedTasks) ? [...definition.supportedTasks] : [];
        this.requiredTools = Array.isArray(definition.requiredTools) ? [...definition.requiredTools] : [];
        this.riskTier = definition.riskTier || RISK_TIERS.CONSEQUENTIAL;
        this.timeoutMs = typeof definition.timeoutMs === 'number' && definition.timeoutMs > 0 ? definition.timeoutMs : 60000;
        this.userApprovalRequired = Boolean(definition.userApprovalRequired);
        
        // Functions
        this.preconditions = typeof definition.preconditions === 'function' ? definition.preconditions : async () => ({ ok: true });
        this.workflow = definition.workflow;
        this.failureRecovery = typeof definition.failureRecovery === 'function' ? definition.failureRecovery : null;
        this.rollback = typeof definition.rollback === 'function' ? definition.rollback : null;

        this.active = definition.active !== false;
        this.category = definition.category || 'general';
        this.metadata = definition.metadata || {};
    }

    validateDefinition(def) {
        if (!def || typeof def !== 'object') {
            throw new Error('Skill definition must be an object');
        }
        if (!def.id || typeof def.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(def.id)) {
            throw new Error(`Invalid skill id: "${def.id}". Must be alphanumeric with underscores or hyphens.`);
        }
        if (typeof def.workflow !== 'function') {
            throw new Error(`Skill "${def.id}" must provide an async workflow function`);
        }
        if (def.requiredTools && !Array.isArray(def.requiredTools)) {
            throw new Error(`Skill "${def.id}" requiredTools must be an array of tool IDs`);
        }
    }
}

class SkillRegistry extends EventEmitter {
    constructor(options = {}) {
        super();
        this.toolRegistry = options.toolRegistry || null;
        this.permissionAuthority = options.permissionAuthority || null;
        this.skills = new Map();
        this.executionLog = [];
    }

    setToolRegistry(registry) {
        this.toolRegistry = registry;
    }

    setPermissionAuthority(authority) {
        this.permissionAuthority = authority;
    }

    /**
     * Register a new Skill definition.
     * Prevents duplicate registrations unless allowOverride is explicitly true.
     * 
     * @param {Object|Skill} skillDef
     * @param {Object} [options={}]
     * @param {boolean} [options.allowOverride=false]
     * @returns {Skill}
     */
    registerSkill(skillDef, options = {}) {
        const skill = skillDef instanceof Skill ? skillDef : new Skill(skillDef);

        if (this.skills.has(skill.id) && !options.allowOverride) {
            throw new Error(`Skill "${skill.id}" is already registered. Use allowOverride: true to replace.`);
        }

        // Verify that required tools exist in ToolRegistry (if ToolRegistry is configured)
        if (this.toolRegistry && Array.isArray(skill.requiredTools)) {
            const missing = [];
            for (const toolId of skill.requiredTools) {
                if (!this.toolRegistry.getTool(toolId)) {
                    missing.push(toolId);
                }
            }
            if (missing.length > 0 && !options.ignoreMissingTools) {
                const err = new Error(`Cannot register skill "${skill.id}": missing required tool(s): ${missing.join(', ')}`);
                err.code = 'MISSING_TOOL_DEPENDENCIES';
                err.missingTools = missing;
                throw err;
            }
        }

        this.skills.set(skill.id, skill);
        this.emit('skillRegistered', { skillId: skill.id, name: skill.name });
        return skill;
    }

    /**
     * Unregister a skill by ID
     * @param {string} skillId
     * @returns {boolean}
     */
    unregisterSkill(skillId) {
        const existed = this.skills.delete(skillId);
        if (existed) {
            this.emit('skillUnregistered', { skillId });
        }
        return existed;
    }

    /**
     * Deactivate a skill without deleting it
     * @param {string} skillId
     * @returns {boolean}
     */
    deactivateSkill(skillId) {
        const skill = this.skills.get(skillId);
        if (!skill) return false;
        skill.active = false;
        this.emit('skillDeactivated', { skillId });
        return true;
    }

    /**
     * Activate a deactivated skill
     * @param {string} skillId
     * @returns {boolean}
     */
    activateSkill(skillId) {
        const skill = this.skills.get(skillId);
        if (!skill) return false;
        skill.active = true;
        this.emit('skillActivated', { skillId });
        return true;
    }

    getSkill(skillId) {
        return this.skills.get(skillId) || null;
    }

    /**
     * List all registered skills
     * @param {Object} [filter={}]
     * @param {boolean} [filter.activeOnly=true]
     * @returns {Array<Object>}
     */
    listSkills(filter = {}) {
        const activeOnly = filter.activeOnly !== false;
        const result = [];
        for (const skill of this.skills.values()) {
            if (activeOnly && !skill.active) continue;
            result.push({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                purpose: skill.purpose,
                version: skill.version,
                supportedTasks: skill.supportedTasks,
                requiredTools: skill.requiredTools,
                riskTier: skill.riskTier,
                userApprovalRequired: skill.userApprovalRequired,
                active: skill.active,
                category: skill.category
            });
        }
        return result;
    }

    /**
     * Check if a skill's required tools and preconditions are met
     * @param {string} skillId
     * @param {Object} [context={}]
     * @returns {Promise<{ available: boolean, reason?: string, missingTools?: string[] }>}
     */
    async checkSkillAvailability(skillId, context = {}) {
        const skill = this.skills.get(skillId);
        if (!skill) {
            return { available: false, reason: `Skill not found: ${skillId}` };
        }
        if (!skill.active) {
            return { available: false, reason: `Skill "${skillId}" is currently deactivated` };
        }

        if (this.toolRegistry && Array.isArray(skill.requiredTools)) {
            const missing = [];
            for (const tId of skill.requiredTools) {
                const tool = this.toolRegistry.getTool(tId);
                if (!tool) {
                    missing.push(tId);
                } else if (typeof this.toolRegistry.isToolActive === 'function' && !this.toolRegistry.isToolActive(tId)) {
                    missing.push(`${tId} (deactivated)`);
                }
            }
            if (missing.length > 0) {
                return {
                    available: false,
                    reason: `Required tool(s) unavailable: ${missing.join(', ')}`,
                    missingTools: missing
                };
            }
        }

        if (typeof skill.preconditions === 'function') {
            try {
                const preResult = await skill.preconditions(context, this);
                if (preResult && preResult.ok === false) {
                    return {
                        available: false,
                        reason: preResult.error || preResult.reason || 'Skill preconditions not satisfied'
                    };
                }
            } catch (err) {
                return {
                    available: false,
                    reason: `Precondition check failed: ${err.message}`
                };
            }
        }

        return { available: true };
    }

    /**
     * Discover relevant skills for a user query/task
     * @param {string} userRequest
     * @param {Object} [context={}]
     * @returns {Array<Skill>}
     */
    findSkillsForTask(userRequest, context = {}) {
        const query = String(userRequest || '').toLowerCase().trim();
        if (!query) return [];

        const matched = [];
        for (const skill of this.skills.values()) {
            if (!skill.active) continue;

            let score = 0;
            // 1. Direct ID match
            if (query.includes(skill.id.toLowerCase())) {
                score += 10;
            }
            // 2. Name match
            if (query.includes(skill.name.toLowerCase())) {
                score += 8;
            }
            // 3. Supported tasks pattern match
            for (const task of skill.supportedTasks) {
                const lowerTask = task.toLowerCase();
                if (query.includes(lowerTask) || lowerTask.includes(query)) {
                    score += 5;
                } else {
                    const words = lowerTask.split(/\s+/).filter(w => w.length > 3);
                    for (const word of words) {
                        if (query.includes(word)) score += 2;
                    }
                }
            }
            // 4. Purpose keywords
            if (skill.purpose) {
                const purposeWords = skill.purpose.toLowerCase().split(/\s+/).filter(w => w.length > 4);
                for (const pw of purposeWords) {
                    if (query.includes(pw)) score += 1;
                }
            }

            if (score > 0) {
                matched.push({ skill, score });
            }
        }

        matched.sort((a, b) => b.score - a.score);
        return matched.map(m => m.skill);
    }

    /**
     * Execute a Skill through its standardized execution lifecycle
     * @param {string} skillId
     * @param {Object} params - Input parameters for the skill workflow
     * @param {Object} context - Execution context (signal, dryRun, onProgress, etc.)
     * @returns {Promise<Object>} Execution receipt
     */
    async execute(skillId, params = {}, context = {}) {
        const startTime = Date.now();
        const skill = this.skills.get(skillId);
        const signal = context.signal || null;
        const dryRun = Boolean(context.dryRun);

        if (!skill) {
            return {
                ok: false,
                status: SKILL_EXECUTION_STATES.FAILED,
                error: `Skill not found: ${skillId}`,
                skillId
            };
        }

        if (signal && signal.aborted) {
            return {
                ok: false,
                status: SKILL_EXECUTION_STATES.CANCELLED,
                error: 'Skill execution cancelled before start',
                cancelled: true,
                skillId
            };
        }

        const reportProgress = (progress) => {
            const payload = {
                skillId,
                step: progress.step || 1,
                total: progress.total || 1,
                message: progress.message || '',
                percent: progress.percent || Math.round(((progress.step || 1) / (progress.total || 1)) * 100),
                timestamp: Date.now()
            };
            this.emit('progress', payload);
            if (typeof context.onProgress === 'function') {
                try {
                    context.onProgress(payload);
                } catch (_) {}
            }
        };

        // 1. Availability & Preconditions check
        reportProgress({ step: 1, total: 5, message: `Checking availability for skill "${skill.name}"`, percent: 10 });
        const availability = await this.checkSkillAvailability(skillId, context);
        if (!availability.available) {
            const failReceipt = {
                ok: false,
                status: SKILL_EXECUTION_STATES.FAILED,
                error: availability.reason,
                skillId,
                durationMs: Date.now() - startTime
            };
            this._logExecution({ skillId, params, dryRun, result: failReceipt });
            return failReceipt;
        }

        // 2. Permission Authority Gate
        reportProgress({ step: 2, total: 5, message: 'Evaluating permission security policy', percent: 25 });
        if (this.permissionAuthority) {
            const authDecision = await this.permissionAuthority.evaluate({
                toolId: skill.id,
                action: 'execute_skill',
                riskTier: skill.riskTier,
                params,
                dryRun
            });

            if (!authDecision.permitted) {
                const deniedReceipt = {
                    ok: false,
                    status: 'permission_denied',
                    error: authDecision.reason || 'Skill execution denied by security policy',
                    auditId: authDecision.auditId,
                    skillId,
                    durationMs: Date.now() - startTime
                };
                this._logExecution({ skillId, params, dryRun, result: deniedReceipt });
                return deniedReceipt;
            }
        }

        // 3. Dry-Run Isolation Check
        if (dryRun) {
            reportProgress({ step: 3, total: 5, message: `Simulating dry-run for skill "${skill.name}"`, percent: 50 });
            const dryRunReceipt = {
                ok: true,
                status: 'dry_run_simulated',
                dryRun: true,
                executed: false,
                skillId,
                simulatedDetails: {
                    skillName: skill.name,
                    purpose: skill.purpose,
                    requiredTools: skill.requiredTools,
                    params
                },
                verification: { verified: true, method: 'dry_run_skill_sandbox' },
                durationMs: Date.now() - startTime
            };
            this._logExecution({ skillId, params, dryRun: true, result: dryRunReceipt });
            return dryRunReceipt;
        }

        // 4. Bound Execution with Timeout & Cancellation
        reportProgress({ step: 3, total: 5, message: `Executing workflow for "${skill.name}"`, percent: 40 });
        const timeoutMs = context.timeoutMs || skill.timeoutMs;
        let timeoutHandle = null;

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                const err = new Error(`Skill "${skillId}" execution timed out after ${timeoutMs}ms`);
                err.code = 'TIMEOUT';
                reject(err);
            }, timeoutMs);
        });

        try {
            const workflowPromise = skill.workflow({
                params,
                context,
                toolRegistry: this.toolRegistry,
                skillRegistry: this,
                onProgress: reportProgress,
                signal,
                dryRun
            });

            const rawResult = await Promise.race([workflowPromise, timeoutPromise]);
            clearTimeout(timeoutHandle);

            if (signal && signal.aborted) {
                throw new Error('Skill execution was cancelled during execution');
            }

            const durationMs = Date.now() - startTime;
            const successReceipt = {
                ok: rawResult?.ok !== false,
                status: rawResult?.status || SKILL_EXECUTION_STATES.SUCCEEDED,
                skillId,
                data: rawResult?.data ?? rawResult,
                stepsExecuted: rawResult?.stepsExecuted || [],
                verification: rawResult?.verification || { verified: rawResult?.ok !== false, method: 'skill_workflow_completed' },
                durationMs
            };

            reportProgress({ step: 5, total: 5, message: `Skill "${skill.name}" completed successfully`, percent: 100 });
            this._logExecution({ skillId, params, dryRun: false, result: successReceipt });
            return successReceipt;

        } catch (err) {
            clearTimeout(timeoutHandle);
            const durationMs = Date.now() - startTime;
            const isCancelled = (signal && signal.aborted) || err.message?.includes('cancelled');

            // Trigger rollback or recovery if registered
            let rollbackReceipt = null;
            if (skill.rollback && !isCancelled) {
                try {
                    rollbackReceipt = await skill.rollback({ params, context, error: err, toolRegistry: this.toolRegistry });
                } catch (rbErr) {
                    rollbackReceipt = { ok: false, error: rbErr.message };
                }
            }

            const errorReceipt = {
                ok: false,
                status: isCancelled ? SKILL_EXECUTION_STATES.CANCELLED : SKILL_EXECUTION_STATES.FAILED,
                error: err.message,
                code: err.code || (isCancelled ? 'CANCELLED' : 'EXECUTION_FAILED'),
                skillId,
                durationMs,
                rollback: rollbackReceipt,
                verification: { verified: false, failureReason: err.message }
            };

            this._logExecution({ skillId, params, dryRun: false, result: errorReceipt });
            return errorReceipt;
        }
    }

    _logExecution(entry) {
        this.executionLog.push({
            timestamp: new Date().toISOString(),
            ...entry
        });
        if (this.executionLog.length > 100) {
            this.executionLog.shift();
        }
    }

    getExecutionLog() {
        return [...this.executionLog];
    }
}

module.exports = {
    Skill,
    SkillRegistry,
    SKILL_EXECUTION_STATES
};
