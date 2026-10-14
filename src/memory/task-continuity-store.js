'use strict';

const fs = require('fs');
const path = require('path');

const { assertStorageIsolation } = require('./memory-constants.js');

const TASK_STATUSES = Object.freeze({
    IN_PROGRESS: 'in_progress',
    INTERRUPTED: 'interrupted',
    COMPLETED: 'completed',
    FAILED: 'failed',
    DISCARDED: 'discarded'
});

class TaskContinuityStore {
    constructor(options = {}) {
        this.storeDir = assertStorageIsolation('TaskContinuityStore', options, ['storeDir', 'memoryDir']);
        this.filePath = options.filePath || path.join(this.storeDir, 'task-checkpoints.json');
        this.tasks = new Map();
        this.sqliteAdapter = options.sqliteAdapter || null;

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
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.tasks = new Map(Object.entries(data.tasks || {}));
            } else {
                this.tasks = new Map();
            }
        } catch (err) {
            console.error('Failed to load task checkpoints:', err.message);
            this.tasks = new Map();
        }
        if (this.tasks.size === 0 && this.sqliteAdapter && this.sqliteAdapter.initialized) {
            this.syncFromSqlite();
        }
    }

    syncFromSqlite() {
        if (!this.sqliteAdapter || !this.sqliteAdapter.initialized) return;
        try {
            const list = this.sqliteAdapter.getTaskCheckpoints();
            for (const cp of list) {
                if (!this.tasks.has(cp.taskId)) {
                    this.tasks.set(cp.taskId, {
                        taskId: cp.taskId,
                        userRequest: cp.objective,
                        plan: { steps: cp.steps || [] },
                        totalSteps: cp.totalSteps,
                        currentStepIndex: cp.currentStepIndex,
                        completedSteps: cp.resumptionState?.completedSteps || [],
                        status: cp.status,
                        dryRun: Boolean(cp.resumptionState?.dryRun),
                        error: cp.resumptionState?.error || null,
                        createdAt: cp.createdAt,
                        updatedAt: cp.updatedAt
                    });
                }
            }
        } catch (err) {
            console.warn('[TaskContinuityStore] Failed to sync checkpoints from SQLite:', err.message);
        }
    }

    save() {
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
        error = null
    }) {
        if (!taskId) throw new Error('taskId is required for checkpoint');

        const now = new Date().toISOString();
        const existing = this.tasks.get(taskId) || {};

        const checkpoint = {
            taskId,
            userRequest: userRequest || existing.userRequest || '',
            plan: plan.steps ? plan : (existing.plan || { steps: [] }),
            totalSteps: (plan.steps || existing.plan?.steps || []).length,
            currentStepIndex,
            completedSteps: completedSteps.length ? completedSteps : (existing.completedSteps || []),
            status,
            dryRun: Boolean(dryRun),
            error: error || null,
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
                        error: checkpoint.error
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
        if (task.status === TASK_STATUSES.IN_PROGRESS) {
            task.status = TASK_STATUSES.INTERRUPTED;
            task.error = reason;
            task.updatedAt = new Date().toISOString();
            this.save();
        }
        return task;
    }

    /**
     * Get list of interrupted tasks that can be resumed.
     */
    getInterruptedTasks() {
        const interrupted = [];
        for (const task of this.tasks.values()) {
            if (task.status === TASK_STATUSES.INTERRUPTED || task.status === TASK_STATUSES.IN_PROGRESS) {
                interrupted.push(task);
            }
        }
        interrupted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return interrupted;
    }

    /**
     * Inspect task state before resuming.
     * Evaluates verification receipts and identifies any consequential pending steps.
     */
    inspectTaskForResume(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found in continuity store`);
        }

        const allSteps = task.plan?.steps || [];
        const completed = task.completedSteps || [];
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
            isResumable: pendingSteps.length > 0 && task.status !== TASK_STATUSES.COMPLETED
        };
    }

    /**
     * Safely resume an interrupted task.
     * Re-executes only the remaining pending steps.
     */
    async resumeTask(taskId, coordinator, options = {}) {
        const inspection = this.inspectTaskForResume(taskId);
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
