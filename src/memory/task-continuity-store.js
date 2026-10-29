'use strict';

const fs = require('fs');
const path = require('path');

const { assertStorageIsolation } = require('./memory-constants.js');
const { UncertainOutcomeError } = require('../core/task-status.js');

const TASK_STATUSES = Object.freeze({
    IN_PROGRESS: 'in_progress',
    INTERRUPTED: 'interrupted',
    AWAITING_RECONCILIATION: 'awaiting_reconciliation',
    COMPLETED: 'completed',
    PARTIALLY_COMPLETED: 'partially_completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    DISCARDED: 'discarded'
});

function sanitizeSecrets(val, seen = new WeakSet(), parentIsSensitive = false) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'boolean' || typeof val === 'number') return val;
    if (typeof val === 'string') {
        let sanitized = val
            .replace(/sk-[a-zA-Z0-9_\-]{8,}/gi, '[REDACTED]')
            .replace(/bearer\s+[a-zA-Z0-9_\.\-]+/gi, 'Bearer [REDACTED]')
            .replace(/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED]')
            .replace(/ghp_[a-zA-Z0-9]{36}/gi, '[REDACTED]')
            .replace(/glpat-[a-zA-Z0-9\-]{20,}/gi, '[REDACTED]')
            .replace(/xox[baprs]-[0-9a-zA-Z]{10,}/gi, '[REDACTED]');
        return sanitized;
    }
    if (Array.isArray(val)) {
        if (seen.has(val)) return '[CIRCULAR]';
        seen.add(val);
        return val.map((item) => sanitizeSecrets(item, seen, parentIsSensitive));
    }
    if (typeof val === 'object') {
        if (seen.has(val)) return '[CIRCULAR]';
        seen.add(val);
        const isSensitiveContext = Boolean(
            parentIsSensitive ||
            val.isSecret ||
            val.secret ||
            /password|passwd|pwd|pin|secret|credential|token|auth/i.test(
                val.automationId || val.name || val.controlName || val.targetControl || val.className || (typeof val.target === 'string' ? val.target : '')
            )
        );
        const sanitized = {};
        for (const [k, v] of Object.entries(val)) {
            const isNonSecretIdentifier = /^(sha|sha1|sha256|sha512|md5|hash|checksum|commit|gitCommit|id|taskId|stepId|uuid|file|path|url|href|version|title|name|status|strategy|tierName)/i.test(k);
            if (!isNonSecretIdentifier && (/token|secret|key|password|credential|auth/i.test(k) || (isSensitiveContext && (k === 'text' || k === 'readText')))) {
                sanitized[k] = '[REDACTED]';
            } else {
                sanitized[k] = sanitizeSecrets(v, seen, isSensitiveContext);
            }
        }
        return sanitized;
    }
    return val;
}

class TaskContinuityStore {
    constructor(options = {}) {
        this.storeDir = assertStorageIsolation('TaskContinuityStore', options, ['storeDir', 'memoryDir']);
        this.filePath = options.filePath || path.join(this.storeDir, 'task-checkpoints.json');
        this.tasks = new Map();
        this.sqliteAdapter = options.sqliteAdapter || null;
        this.loadFailed = false;
        this.corruptBackupPath = null;
        this.recoveredFromSqlite = false;

        this._ensureDir();
        this.load();
    }

    setSqliteAdapter(adapter) {
        this.sqliteAdapter = adapter;
        if (adapter && adapter.initialized) {
            this.syncFromSqlite();
        }
    }

    _ensureDir() {
        if (!fs.existsSync(this.storeDir)) {
            fs.mkdirSync(this.storeDir, { recursive: true });
        }
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                let data;
                try {
                    const raw = fs.readFileSync(this.filePath, 'utf8');
                    data = JSON.parse(raw);
                } catch (parseErr) {
                    console.error('[TaskContinuityStore] Failed to parse task checkpoints JSON, backing up corrupted file:', parseErr.message);
                    const corruptBackup = `${this.filePath}.corrupt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    try {
                        fs.copyFileSync(this.filePath, corruptBackup);
                        this.corruptBackupPath = corruptBackup;
                    } catch {}
                    this.loadFailed = true;
                    this.tasks = new Map();

                    // Fallback to SQLite if available
                    if (this.sqliteAdapter && this.sqliteAdapter.initialized) {
                        this.syncFromSqlite();
                        if (this.tasks.size > 0) {
                            this.recoveredFromSqlite = true;
                        }
                    }
                    this.reconcileStartupTasks();
                    return;
                }
                this.tasks = new Map(Object.entries(data.tasks || {}));
                this.loadFailed = false;
            } else {
                this.tasks = new Map();
                this.loadFailed = false;
            }
        } catch (err) {
            console.error('Failed to load task checkpoints:', err.message);
            this.tasks = new Map();
        }
        if (this.sqliteAdapter && this.sqliteAdapter.initialized) {
            this.syncFromSqlite();
        }
        this.reconcileStartupTasks();
    }

    /**
     * Sweep tasks left in progress/running across application restarts.
     * Transitions them to INTERRUPTED (or AWAITING_RECONCILIATION if uncertain).
     * @returns {boolean} Whether any tasks were reconciled
     */
    reconcileStartupTasks() {
        let stateMutated = false;
        const now = new Date().toISOString();

        for (const [taskId, task] of this.tasks.entries()) {
            if (task.status === TASK_STATUSES.IN_PROGRESS || task.status === 'running') {
                const isUncertain = Boolean(task.uncertainStep && !task.uncertainStep.resolved);
                task.status = isUncertain ? TASK_STATUSES.AWAITING_RECONCILIATION : TASK_STATUSES.INTERRUPTED;
                task.interruptedAt = now;
                task.updatedAt = now;
                if (!task.error) {
                    task.error = isUncertain
                        ? 'Task execution outcome uncertain across application restart; awaiting reconciliation'
                        : 'Task interrupted by application restart';
                }
                stateMutated = true;

                if (this.sqliteAdapter && this.sqliteAdapter.initialized) {
                    try {
                        this.sqliteAdapter.saveTaskCheckpoint({
                            taskId: task.taskId,
                            objective: task.userRequest,
                            totalSteps: task.totalSteps,
                            currentStepIndex: task.currentStepIndex,
                            steps: task.plan?.steps || [],
                            status: task.status,
                            resumptionState: {
                                completedSteps: task.completedSteps || [],
                                uncertainStep: task.uncertainStep || null,
                                resolutions: task.resolutions || [],
                                dryRun: task.dryRun,
                                error: task.error
                            }
                        });
                    } catch (err) {
                        console.warn('[TaskContinuityStore] Failed to sync reconciled startup task to SQLite:', err.message);
                    }
                }
            }
        }

        if (stateMutated && !this.loadFailed) {
            this.save();
        }
        return stateMutated;
    }

    syncFromSqlite() {
        if (!this.sqliteAdapter || !this.sqliteAdapter.initialized) return;
        try {
            const list = this.sqliteAdapter.getTaskCheckpoints();
            let stateMutated = false;

            for (const cp of list) {
                const existing = this.tasks.get(cp.taskId);
                const sqliteUncertain = cp.resumptionState?.uncertainStep || null;
                const sqliteUnresolved = Boolean(sqliteUncertain && !sqliteUncertain.resolved);
                const sqliteCompleted = cp.resumptionState?.completedSteps || [];
                const sqliteResolutions = cp.resumptionState?.resolutions || [];

                if (!existing) {
                    this.tasks.set(cp.taskId, {
                        taskId: cp.taskId,
                        userRequest: cp.objective,
                        plan: { steps: cp.steps || [] },
                        totalSteps: cp.totalSteps,
                        currentStepIndex: cp.currentStepIndex,
                        completedSteps: sqliteCompleted,
                        status: cp.status,
                        dryRun: Boolean(cp.resumptionState?.dryRun),
                        error: cp.resumptionState?.error || null,
                        uncertainStep: sqliteUncertain,
                        resolutions: sqliteResolutions,
                        createdAt: cp.createdAt,
                        updatedAt: cp.updatedAt
                    });
                    stateMutated = true;
                    continue;
                }

                // Crash consistency reconciliation rule:
                // If EITHER store recorded an unresolved uncertain step, preserve it fail-closed
                const jsonUncertain = existing.uncertainStep || null;
                const jsonUnresolved = Boolean(jsonUncertain && !jsonUncertain.resolved);

                let mergedUncertainStep;
                let mergedStatus = existing.status;

                if (sqliteUnresolved && !jsonUnresolved) {
                    // SQLite recorded newer or uncommitted uncertainty
                    mergedUncertainStep = sqliteUncertain;
                    mergedStatus = TASK_STATUSES.AWAITING_RECONCILIATION;
                } else if (jsonUnresolved && !sqliteUnresolved) {
                    // JSON recorded uncertainty
                    mergedUncertainStep = jsonUncertain;
                    mergedStatus = TASK_STATUSES.AWAITING_RECONCILIATION;
                } else {
                    // Both unresolved or both resolved: prefer newer timestamp
                    const sqliteTime = new Date(cp.updatedAt || 0).getTime();
                    const jsonTime = new Date(existing.updatedAt || 0).getTime();
                    if (sqliteTime > jsonTime) {
                        mergedUncertainStep = sqliteUncertain;
                        mergedStatus = cp.status;
                    } else {
                        mergedUncertainStep = jsonUncertain;
                    }
                }

                // Merge completed steps and resolutions without losing progress
                const completedMap = new Map();
                (existing.completedSteps || []).forEach((s, idx) => {
                    const key = s?.id || s?.stepId || (s?.stepIndex !== undefined ? `idx_${s.stepIndex}` : (s?.index !== undefined ? `idx_${s.index}` : `step_${idx}`));
                    completedMap.set(key, s);
                });
                sqliteCompleted.forEach((s, idx) => {
                    const key = s?.id || s?.stepId || (s?.stepIndex !== undefined ? `idx_${s.stepIndex}` : (s?.index !== undefined ? `idx_${s.index}` : `step_${idx}`));
                    if (!completedMap.has(key) || s?.verified) {
                        completedMap.set(key, s);
                    }
                });

                const resolutionMap = new Map();
                for (const r of (existing.resolutions || [])) {
                    if (r?.stepId) resolutionMap.set(`${r.stepId}_${r.attempt || 1}`, r);
                }
                for (const r of sqliteResolutions) {
                    if (r?.stepId) resolutionMap.set(`${r.stepId}_${r.attempt || 1}`, r);
                }

                const merged = {
                    ...existing,
                    status: mergedStatus,
                    uncertainStep: mergedUncertainStep,
                    completedSteps: Array.from(completedMap.values()),
                    resolutions: Array.from(resolutionMap.values()),
                    updatedAt: new Date(Math.max(
                        new Date(existing.updatedAt || 0).getTime(),
                        new Date(cp.updatedAt || 0).getTime()
                    )).toISOString()
                };

                this.tasks.set(cp.taskId, merged);
                stateMutated = true;
            }

            if (stateMutated && !this.loadFailed) {
                this.save();
            }
        } catch (err) {
            console.warn('[TaskContinuityStore] Failed to sync checkpoints from SQLite:', err.message);
        }
    }

    save() {
        if (this.loadFailed) {
            console.warn('[TaskContinuityStore] Skipping save to prevent overwriting corrupted task continuity store that has not been recovered.');
            return false;
        }
        let tempPath = null;
        let success = false;
        try {
            this._ensureDir();
            const payload = {
                version: 1,
                updatedAt: new Date().toISOString(),
                tasks: Object.fromEntries(this.tasks)
            };
            tempPath = `${this.filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tempPath, this.filePath);
            success = true;
            return true;
        } catch (err) {
            console.error('Failed to save task checkpoints:', err.message);
            return false;
        } finally {
            if (!success && tempPath && fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch {}
            }
        }
    }

    /**
     * Save or update task checkpoint.
     */
    saveCheckpoint({
        taskId,
        userRequest,
        plan = {},
        currentStepIndex = 0,
        completedSteps = [],
        status = TASK_STATUSES.IN_PROGRESS,
        dryRun = false,
        error = null,
        uncertainStep = undefined,
        resolutions = undefined,
        replanHistory = undefined
    }) {
        if (!taskId) throw new Error('taskId is required for checkpoint');

        const now = new Date().toISOString();
        const existing = this.tasks.get(taskId) || {};

        // Guard against stale write regressing resolved uncertainty to unresolved
        let effectiveUncertainStep;
        if (existing.uncertainStep && existing.uncertainStep.resolved) {
            if (uncertainStep && !uncertainStep.resolved && uncertainStep.stepId === existing.uncertainStep.stepId) {
                // Stale write attempting to regress a resolved step: preserve resolved state
                effectiveUncertainStep = existing.uncertainStep;
            } else {
                effectiveUncertainStep = uncertainStep !== undefined ? uncertainStep : existing.uncertainStep;
            }
        } else {
            effectiveUncertainStep = uncertainStep !== undefined
                ? uncertainStep
                : (existing.uncertainStep || null);
        }

        // Guard against stale write dropping verified completed steps
        let effectiveCompletedSteps;
        const incomingSteps = Array.isArray(completedSteps) ? completedSteps : [];
        const existingSteps = Array.isArray(existing.completedSteps) ? existing.completedSteps : [];
        if (incomingSteps.length === 0 && existingSteps.length > 0) {
            effectiveCompletedSteps = existingSteps;
        } else if (existingSteps.length > incomingSteps.length) {
            const stepMap = new Map();
            existingSteps.forEach((s, idx) => {
                const key = s?.id || s?.stepId || (s?.stepIndex !== undefined ? `idx_${s.stepIndex}` : (s?.index !== undefined ? `idx_${s.index}` : `step_${idx}`));
                stepMap.set(key, s);
            });
            incomingSteps.forEach((s, idx) => {
                const key = s?.id || s?.stepId || (s?.stepIndex !== undefined ? `idx_${s.stepIndex}` : (s?.index !== undefined ? `idx_${s.index}` : `step_${idx}`));
                stepMap.set(key, s);
            });
            effectiveCompletedSteps = Array.from(stepMap.values());
        } else {
            effectiveCompletedSteps = incomingSteps.length ? incomingSteps : existingSteps;
        }

        // Merge resolutions monotonically
        const resMap = new Map();
        for (const r of (existing.resolutions || [])) {
            if (r?.stepId) resMap.set(`${r.stepId}_${r.attempt || 1}`, r);
        }
        for (const r of (Array.isArray(resolutions) ? resolutions : [])) {
            if (r?.stepId) resMap.set(`${r.stepId}_${r.attempt || 1}`, r);
        }
        const effectiveResolutions = Array.from(resMap.values());

        const effectiveReplanHistory = Array.isArray(replanHistory)
            ? replanHistory
            : (existing.replanHistory || []);

        let effectiveStatus = status;
        if (existing.status === TASK_STATUSES.CANCELLED && status !== TASK_STATUSES.CANCELLED) {
            effectiveStatus = TASK_STATUSES.CANCELLED;
        } else if (existing.status === TASK_STATUSES.DISCARDED && status !== TASK_STATUSES.DISCARDED) {
            effectiveStatus = TASK_STATUSES.DISCARDED;
        } else if (existing.status === TASK_STATUSES.COMPLETED && status === TASK_STATUSES.IN_PROGRESS) {
            effectiveStatus = TASK_STATUSES.COMPLETED;
        }

        const checkpoint = {
            taskId,
            userRequest: userRequest || existing.userRequest || '',
            plan: sanitizeSecrets(plan.steps ? plan : (existing.plan || { steps: [] })),
            totalSteps: (plan.steps || existing.plan?.steps || []).length,
            currentStepIndex,
            completedSteps: sanitizeSecrets(effectiveCompletedSteps),
            status: effectiveStatus,
            dryRun: Boolean(dryRun),
            error: sanitizeSecrets(error || null),
            uncertainStep: sanitizeSecrets(effectiveUncertainStep),
            resolutions: sanitizeSecrets(effectiveResolutions),
            replanHistory: sanitizeSecrets(effectiveReplanHistory),
            version: (existing.version || 0) + 1,
            createdAt: existing.createdAt || now,
            updatedAt: now
        };

        this.tasks.set(taskId, checkpoint);
        this.save();

        if (this.sqliteAdapter && this.sqliteAdapter.initialized) {
            try {
                this.sqliteAdapter.saveTaskCheckpoint({
                    taskId: checkpoint.taskId,
                    objective: checkpoint.userRequest,
                    status: checkpoint.status,
                    currentStepIndex: checkpoint.currentStepIndex,
                    totalSteps: checkpoint.totalSteps,
                    steps: checkpoint.plan?.steps || [],
                    resumptionState: {
                        completedSteps: checkpoint.completedSteps,
                        dryRun: checkpoint.dryRun,
                        error: checkpoint.error,
                        uncertainStep: checkpoint.uncertainStep,
                        resolutions: checkpoint.resolutions,
                        replanHistory: checkpoint.replanHistory
                    },
                    createdAt: checkpoint.createdAt
                });
            } catch (err) {
                console.warn('[TaskContinuityStore] Failed to sync checkpoint to SQLite:', err.message);
            }
        }

        return checkpoint;
    }

    /**
     * Mark an in-progress task as interrupted (e.g. on shutdown, crash, or manual stop).
     */
    markInterrupted(taskId, reason = 'Application session interrupted') {
        const task = this.tasks.get(taskId);
        if (!task) return null;
        if (task.status === TASK_STATUSES.IN_PROGRESS || task.status === TASK_STATUSES.AWAITING_RECONCILIATION) {
            task.status = TASK_STATUSES.INTERRUPTED;
            task.error = reason;
            task.updatedAt = new Date().toISOString();
            this.save();
        }
        return task;
    }

    /**
     * Record an auditable resolution receipt for an uncertain step in this store.
     */
    recordResolution(taskId, resolutionReceipt) {
        const task = this.tasks.get(taskId);
        if (!task) return null;
        if (!task.resolutions) task.resolutions = [];
        task.resolutions.push(resolutionReceipt);
        if (task.uncertainStep && task.uncertainStep.stepId === resolutionReceipt.stepId) {
            task.uncertainStep.resolved = true;
            task.uncertainStep.resolvedAt = resolutionReceipt.timestamp;
            task.uncertainStep.resolution = resolutionReceipt.resolution;
            task.uncertainStep.evidence = resolutionReceipt.evidence;
        }
        task.updatedAt = new Date().toISOString();
        this.save();
        return task;
    }

    /**
     * Get checkpoint by taskId
     * @param {string} taskId
     * @returns {Object|null}
     */
    getCheckpoint(taskId) {
        return this.tasks.get(taskId) || null;
    }

    /**
     * Get list of interrupted or awaiting reconciliation tasks that can be inspected or resumed.
     */
    getInterruptedTasks() {
        const interrupted = [];
        for (const task of this.tasks.values()) {
            if (
                task.status === TASK_STATUSES.INTERRUPTED ||
                task.status === TASK_STATUSES.IN_PROGRESS ||
                task.status === TASK_STATUSES.AWAITING_RECONCILIATION
            ) {
                interrupted.push(task);
            }
        }
        interrupted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return interrupted;
    }

    /**
     * Inspect task state before resuming.
     * Evaluates verification receipts, identifies uncertain step outcomes, and blocks replay fail-closed.
     */
    inspectTaskForResume(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found in continuity store`);
        }

        const allSteps = task.plan?.steps || [];
        // Only verified, successful steps count as completed
        const completed = (task.completedSteps || []).filter((s) => s.verified && s.result?.ok !== false);
        const completedIndices = new Set(completed.map((s) => {
            if (s.stepIndex !== undefined) return s.stepIndex;
            if (s.index !== undefined) return s.index - 1;
            return undefined;
        }).filter(idx => idx !== undefined));

        // Pending steps that were never executed
        const pendingSteps = allSteps.filter((s, idx) => {
            const stepIdx = s.stepIndex !== undefined ? s.stepIndex : (s.index !== undefined ? s.index - 1 : idx);
            return !completedIndices.has(stepIdx);
        });

        // Check if the last executed step actually completed with verified receipt
        const lastCompleted = completed[completed.length - 1] || null;
        const lastStepVerified = lastCompleted ? Boolean(lastCompleted.verified) : true;

        // Identify consequential tools in pending steps that require user re-confirmation
        const consequentialPending = pendingSteps.filter((step) => {
            const toolId = step.toolId || '';
            return toolId.includes('write') ||
                   toolId.includes('delete') ||
                   toolId.includes('fill') ||
                   toolId.includes('click') ||
                   toolId.includes('execute');
        });

        const hasUnresolvedUncertain = Boolean(task.uncertainStep && !task.uncertainStep.resolved);
        const blockingReason = hasUnresolvedUncertain
            ? `Task has an unresolved uncertain step outcome (${task.uncertainStep.reason || 'timeout / in-flight side-effect'}). Automatic replay is strictly blocked.`
            : null;

        return {
            taskId: task.taskId,
            userRequest: task.userRequest,
            status: task.status,
            dryRun: task.dryRun,
            totalSteps: allSteps.length,
            completedCount: completed.length,
            completedSteps: completed,
            pendingCount: pendingSteps.length,
            pendingSteps,
            lastStepVerified,
            lastCompletedStep: lastCompleted,
            hasConsequentialPending: consequentialPending.length > 0,
            consequentialPendingSteps: consequentialPending,
            hasUncertainStep: hasUnresolvedUncertain,
            uncertainStep: hasUnresolvedUncertain ? task.uncertainStep : null,
            blockingReason,
            isResumable: !hasUnresolvedUncertain && pendingSteps.length > 0 && task.status !== TASK_STATUSES.COMPLETED
        };
    }

    /**
     * Safely resume an interrupted task.
     * Re-executes only the remaining pending steps.
     */
    async resumeTask(taskId, coordinator, options = {}) {
        if (coordinator && typeof coordinator._resumeTaskInternal === 'function') {
            return await coordinator._resumeTaskInternal(taskId, options);
        }

        const inspection = this.inspectTaskForResume(taskId);
        if (inspection.hasUncertainStep) {
            throw new UncertainOutcomeError(taskId, inspection.uncertainStep?.stepId, inspection.blockingReason);
        }
        if (!inspection.isResumable) {
            throw new Error(`Task ${taskId} has no pending steps to resume`);
        }

        const task = this.tasks.get(taskId);
        task.status = TASK_STATUSES.IN_PROGRESS;
        task.updatedAt = new Date().toISOString();
        this.save();

        const pendingSteps = inspection.pendingSteps;
        const executedSteps = [...task.completedSteps];
        const newlyExecuted = [];

        for (let i = 0; i < pendingSteps.length; i++) {
            const step = pendingSteps[i];
            const stepIndex = executedSteps.length + 1;

            // Check if step is consequential and re-confirmation is requested
            if (options.requireConsequentialConfirmation && inspection.consequentialPendingSteps.some(s => s.toolId === step.toolId)) {
                if (options.onConfirmStep) {
                    const approved = await options.onConfirmStep(step);
                    if (!approved) {
                        task.status = TASK_STATUSES.INTERRUPTED;
                        task.error = `Resumed task halted: User declined confirmation for step ${stepIndex}`;
                        this.save();
                        return {
                            ok: false,
                            status: 'interrupted',
                            taskId,
                            haltedAtStep: step,
                            completedSteps: executedSteps,
                            resumedSteps: newlyExecuted
                        };
                    }
                }
            }

            // Execute through coordinator's toolRegistry
            const toolResult = await coordinator.toolRegistry.execute(step.toolId, step.params, { dryRun: task.dryRun });
            const stepReceipt = {
                index: stepIndex,
                stepIndex: step.stepIndex !== undefined ? step.stepIndex : stepIndex - 1,
                title: step.title,
                toolId: step.toolId,
                params: step.params,
                result: toolResult,
                verified: toolResult.ok && Boolean(toolResult.verification?.verified)
            };

            executedSteps.push(stepReceipt);
            newlyExecuted.push(stepReceipt);

            // Update checkpoint after each step
            this.saveCheckpoint({
                taskId,
                userRequest: task.userRequest,
                plan: task.plan,
                currentStepIndex: stepIndex,
                completedSteps: executedSteps,
                status: toolResult.ok ? TASK_STATUSES.IN_PROGRESS : TASK_STATUSES.FAILED,
                dryRun: task.dryRun,
                error: toolResult.ok ? null : toolResult.error
            });

            if (!toolResult.ok) {
                return {
                    ok: false,
                    status: 'failed',
                    taskId,
                    failedStep: stepReceipt,
                    completedSteps: executedSteps,
                    resumedSteps: newlyExecuted,
                    error: toolResult.error
                };
            }
        }

        // Complete the task checkpoint
        this.saveCheckpoint({
            taskId,
            userRequest: task.userRequest,
            plan: task.plan,
            currentStepIndex: executedSteps.length,
            completedSteps: executedSteps,
            status: TASK_STATUSES.COMPLETED,
            dryRun: task.dryRun,
            error: null
        });

        return {
            ok: true,
            status: 'completed',
            taskId,
            userRequest: task.userRequest,
            executedSteps: newlyExecuted,
            allCompletedSteps: executedSteps,
            replyText: `Resumed and completed all remaining ${pendingSteps.length} step(s) successfully.`
        };
    }

    /**
     * Discard an interrupted task.
     */
    discardTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        if (task.status === TASK_STATUSES.DISCARDED) return false;
        task.status = TASK_STATUSES.DISCARDED;
        task.updatedAt = new Date().toISOString();
        this.save();

        if (this.sqliteAdapter && this.sqliteAdapter.initialized) {
            try {
                this.sqliteAdapter.saveTaskCheckpoint({
                    taskId,
                    objective: task.userRequest,
                    status: TASK_STATUSES.DISCARDED,
                    currentStepIndex: task.currentStepIndex,
                    totalSteps: task.totalSteps,
                    steps: task.plan?.steps || [],
                    resumptionState: {
                        completedSteps: task.completedSteps,
                        dryRun: task.dryRun,
                        error: task.error
                    },
                    createdAt: task.createdAt
                });
            } catch (err) {
                console.warn('[TaskContinuityStore] Failed to sync discarded status to SQLite:', err.message);
            }
        }

        return true;
    }
}

module.exports = {
    TASK_STATUSES,
    TaskContinuityStore
};
