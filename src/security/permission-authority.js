'use strict';

/**
 * PermissionAuthority
 * Central authoritative enforcement point for all tool actions and side-effects.
 * Follows principle of Least Privilege and enforces mandatory confirmation gates
 * for consequential operations (deletions, arbitrary commands, network transmissions).
 */

const RISK_TIERS = Object.freeze({
    SAFE_READ: 'SAFE_READ',                   // Internal facts, system time, memory view
    LOW_IMPACT: 'LOW_IMPACT',                 // Low-risk diagnostic inspection
    WORKSPACE_READ: 'WORKSPACE_READ',         // Reading files, listing workspace dirs
    WORKSPACE_WRITE: 'WORKSPACE_WRITE',       // Creating/modifying files within workspace boundary
    NETWORK_READ: 'NETWORK_READ',             // Fetching web content (untrusted input)
    CONSEQUENTIAL: 'CONSEQUENTIAL',           // Modifying external files, executing commands, deleting files
    HIGH_RISK: 'HIGH_RISK',                   // High-impact sensitive operation
    CRITICAL: 'CRITICAL'                      // System reconfiguration, credential changes, sending external data
});

const PERMISSION_MODES = Object.freeze({
    STRICT: 'strict',         // Every write and network access requires confirmation
    STANDARD: 'standard',     // Safe/Workspace reads auto-permitted; writes and consequential ops require confirmation
    AUTONOMOUS_SANDBOX: 'autonomous_sandbox', // Workspace writes permitted inside sandbox; external/consequential still gated
    ASK_EVERY_TIME: 'strict',
    NORMAL: 'standard'
});

class PermissionAuthority {
    constructor(options = {}) {
        this.mode = options.mode || PERMISSION_MODES.STANDARD;
        this.workspaceRoot = options.workspaceRoot || process.cwd();
        this.confirmationHandler = options.confirmationHandler || null;
        this.confirmationTimeoutMs = Number.isFinite(options.confirmationTimeoutMs) && options.confirmationTimeoutMs > 0
            ? options.confirmationTimeoutMs
            : 60000;
        this.pendingRequests = new Map();
        this.auditLog = [];
    }

    getConfirmationTimeout() {
        return this.confirmationTimeoutMs;
    }

    setConfirmationTimeout(timeoutMs) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error('Confirmation timeout must be a positive number of milliseconds');
        }
        this.confirmationTimeoutMs = timeoutMs;
    }

    cancelAllPendingConfirmations(reason = 'Operation cancelled') {
        for (const [auditId, item] of this.pendingRequests.entries()) {
            if (!item.settled) {
                item.cancel(reason);
            }
        }
        this.pendingRequests.clear();
    }

    setConfirmationHandler(handler) {
        if (typeof handler !== 'function') {
            throw new Error('Confirmation handler must be a function');
        }
        this.confirmationHandler = handler;
    }

    setPromptHandler(handler) {
        return this.setConfirmationHandler(handler);
    }

    setPromptCallback(handler) {
        return this.setConfirmationHandler(handler);
    }

    setMode(newMode) {
        if (!Object.values(PERMISSION_MODES).includes(newMode)) {
            throw new Error(`Invalid permission mode: ${newMode}`);
        }
        this.mode = newMode;
    }

    /**
     * Check if a tool execution is authorized
     * @param {Object} request
     * @param {string} request.toolId - e.g. 'file_writer', 'shell_exec'
     * @param {string} request.action - e.g. 'write', 'delete', 'run'
     * @param {string} request.riskTier - One of RISK_TIERS
     * @param {Object} request.params - Parameters for the tool call
     * @param {boolean} [request.dryRun=false] - Whether dry run is enabled
     * @returns {Promise<{ permitted: boolean, reason: string, requiresConfirmation: boolean, auditId: string }>}
     */
    async evaluate(request = {}) {
        const { toolId, action, riskTier, params = {}, dryRun = false } = request;
        const auditId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = new Date().toISOString();

        // 1. Dry run requests are ALWAYS safe to evaluate through the dispatcher
        // (the tool registry will guarantee no execution occurs)
        if (dryRun) {
            const result = {
                permitted: true,
                reason: 'Dry-run mode active; simulated execution permitted',
                requiresConfirmation: false,
                auditId
            };
            this._logAudit({ auditId, timestamp, request, decision: result });
            return result;
        }

        // 2. Classify by risk tier
        const tier = riskTier || RISK_TIERS.CONSEQUENTIAL;

        // Tier 0: SAFE_READ and LOW_IMPACT are always permitted
        if (tier === RISK_TIERS.SAFE_READ || tier === RISK_TIERS.LOW_IMPACT) {
            const result = { permitted: true, reason: 'Safe read-only or low-impact operation', requiresConfirmation: false, auditId };
            this._logAudit({ auditId, timestamp, request, decision: result });
            return result;
        }

        // Tier 1: WORKSPACE_READ permitted in standard & autonomous
        if (tier === RISK_TIERS.WORKSPACE_READ) {
            if (this.mode === PERMISSION_MODES.STRICT) {
                return await this._requestUserConfirmation(request, auditId, timestamp, 'Strict mode: read confirmation requested');
            }
            const result = { permitted: true, reason: 'Workspace read permitted', requiresConfirmation: false, auditId };
            this._logAudit({ auditId, timestamp, request, decision: result });
            return result;
        }

        // Tier 2: WORKSPACE_WRITE
        if (tier === RISK_TIERS.WORKSPACE_WRITE) {
            if (this.mode === PERMISSION_MODES.AUTONOMOUS_SANDBOX) {
                const result = { permitted: true, reason: 'Workspace write auto-approved in sandbox mode', requiresConfirmation: false, auditId };
                this._logAudit({ auditId, timestamp, request, decision: result });
                return result;
            }
            return await this._requestUserConfirmation(request, auditId, timestamp, 'Workspace file modification requires approval');
        }

        // Tier 3: NETWORK_READ
        if (tier === RISK_TIERS.NETWORK_READ) {
            if (this.mode === PERMISSION_MODES.STRICT) {
                return await this._requestUserConfirmation(request, auditId, timestamp, 'Strict mode: external web request requires confirmation');
            }
            const result = { permitted: true, reason: 'External web read permitted under untrusted isolation', requiresConfirmation: false, auditId };
            this._logAudit({ auditId, timestamp, request, decision: result });
            return result;
        }

        // Tier 4 & 5: CONSEQUENTIAL and CRITICAL ALWAYS require explicit user confirmation
        const reason = tier === RISK_TIERS.CRITICAL
            ? 'Critical system action requires explicit user authorization'
            : `Consequential action (${toolId}:${action}) requires explicit confirmation`;

        return await this._requestUserConfirmation(request, auditId, timestamp, reason);
    }

    async _requestUserConfirmation(request, auditId, timestamp, promptReason) {
        if (!this.confirmationHandler) {
            // Fails closed if no handler is installed
            const decision = {
                permitted: false,
                reason: `Blocked: ${promptReason} (No interactive confirmation handler configured)`,
                requiresConfirmation: true,
                auditId,
                timedOut: false
            };
            this._logAudit({ auditId, timestamp, request, decision });
            return decision;
        }

        const timeoutMs = this.confirmationTimeoutMs;
        let timer = null;
        let settled = false;
        let cancelReject = null;

        const cancelPromise = new Promise((_, reject) => {
            cancelReject = reject;
        });

        const handlerPromise = new Promise(async (resolve, reject) => {
            try {
                const userApproved = await this.confirmationHandler({
                    auditId,
                    toolId: request.toolId,
                    action: request.action,
                    riskTier: request.riskTier,
                    params: request.params,
                    promptReason,
                    timeoutMs
                });
                const isApproved = (userApproved && typeof userApproved === 'object')
                    ? Boolean(userApproved.confirmed ?? userApproved.approved)
                    : Boolean(userApproved);
                resolve({ approved: isApproved });
            } catch (err) {
                reject(err);
            }
        });

        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const timeoutErr = new Error(`Permission confirmation timed out after ${Math.round(timeoutMs / 1000)}s`);
                timeoutErr.code = 'CONFIRMATION_TIMEOUT';
                reject(timeoutErr);
            }, timeoutMs);
        });

        const pendingEntry = {
            settled: false,
            timer,
            cancel: (reason) => {
                if (!settled) {
                    settled = true;
                    if (timer) clearTimeout(timer);
                    const cancelErr = new Error(`Permission confirmation cancelled: ${reason}`);
                    cancelErr.code = 'CONFIRMATION_CANCELLED';
                    if (cancelReject) cancelReject(cancelErr);
                }
            }
        };
        this.pendingRequests.set(auditId, pendingEntry);

        try {
            const outcome = await Promise.race([handlerPromise, timeoutPromise, cancelPromise]);
            settled = true;
            pendingEntry.settled = true;
            if (timer) clearTimeout(timer);

            const userApproved = outcome.approved;
            const decision = {
                permitted: Boolean(userApproved),
                reason: userApproved ? 'User explicitly granted confirmation' : 'User declined permission',
                requiresConfirmation: true,
                auditId,
                timedOut: false
            };
            this._logAudit({ auditId, timestamp, request, decision });
            return decision;
        } catch (err) {
            settled = true;
            pendingEntry.settled = true;
            if (timer) clearTimeout(timer);

            if (err.code === 'CONFIRMATION_TIMEOUT') {
                const decision = {
                    permitted: false,
                    reason: `Permission confirmation timed out after ${Math.round(timeoutMs / 1000)}s`,
                    requiresConfirmation: true,
                    auditId,
                    timedOut: true
                };
                this._logAudit({ auditId, timestamp, request, decision });
                return decision;
            }

            if (err.code === 'CONFIRMATION_CANCELLED') {
                const decision = {
                    permitted: false,
                    reason: err.message,
                    requiresConfirmation: true,
                    auditId,
                    timedOut: false,
                    cancelled: true
                };
                this._logAudit({ auditId, timestamp, request, decision });
                return decision;
            }

            const decision = {
                permitted: false,
                reason: `Permission prompt failed: ${err.message}`,
                requiresConfirmation: true,
                auditId,
                timedOut: false
            };
            this._logAudit({ auditId, timestamp, request, decision });
            return decision;
        } finally {
            if (timer) clearTimeout(timer);
            this.pendingRequests.delete(auditId);
        }
    }

    _logAudit(entry) {
        this.auditLog.push(entry);
        if (this.auditLog.length > 500) {
            this.auditLog.shift();
        }
    }

    getAuditHistory(limit = 50) {
        return this.auditLog.slice(-limit);
    }
}

module.exports = {
    PermissionAuthority,
    RISK_TIERS,
    PERMISSION_MODES
};
