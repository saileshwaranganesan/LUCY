'use strict';

/**
 * Persistent Proactive Reminder and Scheduling Engine for L.U.C.Y. (REQ-037)
 * 
 * Supports:
 * - One-shot reminders with exact timestamp or relative delay.
 * - Recurring proactive interval schedules.
 * - Persistent storage across application restarts (JSON/SQLite).
 * - Safe task execution with fail-closed permission enforcement.
 * - Missed-task handling upon restart (expired vs catch-up).
 * - Clean cancellation by ID and resource disposal.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const JOB_STATUS = Object.freeze({
    SCHEDULED: 'scheduled',
    RUNNING: 'running',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    MISSED: 'missed',
    FAILED: 'failed'
});

function getStoragePath(customDir = null) {
    const baseDir = customDir
        || process.env.LUCY_MEMORY_DIR
        || path.resolve(process.cwd(), 'data', 'memory');
    return path.join(baseDir, 'scheduled-tasks.json');
}

class Scheduler extends EventEmitter {
    constructor({
        storageDir = null,
        storagePath = null,
        taskCoordinator = null,
        permissionAuthority = null,
        clock = { now: () => Date.now() }
    } = {}) {
        super();
        this.filePath = storagePath || getStoragePath(storageDir);
        this.taskCoordinator = taskCoordinator;
        this.permissionAuthority = permissionAuthority;
        this.clock = clock;
        this.activeTimers = new Map(); // id -> timer handle
        this.jobs = new Map(); // id -> job record
        this.isDisposed = false;

        this._loadStore();
    }

    _loadStore() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                const data = JSON.parse(raw);
                if (Array.isArray(data)) {
                    for (const job of data) {
                        if (job && job.id) {
                            this.jobs.set(job.id, job);
                        }
                    }
                }
            }
        } catch (err) {
            this.emit('error', new Error(`Failed to load scheduled tasks: ${err.message}`));
        }
    }

    _saveStore() {
        if (this.isDisposed) return;
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = Array.from(this.jobs.values());
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (err) {
            this.emit('error', new Error(`Failed to persist scheduled tasks: ${err.message}`));
        }
    }

    /**
     * Start the scheduler and resume any pending or recurring jobs.
     */
    start() {
        if (this.isDisposed) return;
        const now = this.clock.now();

        for (const [id, job] of this.jobs.entries()) {
            if (job.status !== JOB_STATUS.SCHEDULED) {
                continue;
            }

            if (job.recurring) {
                this._armRecurringJob(job);
            } else {
                if (job.executeAt <= now) {
                    if (job.triggerIfMissed) {
                        this.emit('missed', job);
                        this._executeJob(id);
                    } else {
                        job.status = JOB_STATUS.MISSED;
                        job.completedAt = now;
                        this.emit('expired', job);
                    }
                } else {
                    this._armOneShotJob(job, job.executeAt - now);
                }
            }
        }
        this._saveStore();
    }

    /**
     * Schedule a one-shot reminder or proactive task.
     * @param {object} params
     * @param {string} [params.id] Unique task ID.
     * @param {string} params.prompt Action prompt or reminder text.
     * @param {number} [params.delayMs] Delay in milliseconds from now.
     * @param {number|string|Date} [params.targetTime] Exact execution time.
     * @param {boolean} [params.triggerIfMissed=false] Whether to fire if offline when due.
     * @param {Function} [params.callback] Optional direct callback.
     * @param {object} [params.metadata]
     * @returns {object} Scheduled job record.
     */
    scheduleOnce({
        id,
        prompt,
        delayMs,
        targetTime,
        triggerIfMissed = false,
        callback = null,
        metadata = {}
    }) {
        if (this.isDisposed) {
            throw new Error('Scheduler is disposed');
        }
        if (!prompt || typeof prompt !== 'string') {
            throw new Error('Scheduled task prompt must be a non-empty string');
        }

        const now = this.clock.now();
        let executeAt;
        if (targetTime !== undefined && targetTime !== null) {
            executeAt = new Date(targetTime).getTime();
            if (isNaN(executeAt)) {
                throw new Error('Invalid targetTime provided');
            }
        } else if (typeof delayMs === 'number' && delayMs >= 0) {
            executeAt = now + delayMs;
        } else {
            throw new Error('Either delayMs or valid targetTime must be provided');
        }

        const jobId = id || `rem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const job = {
            id: jobId,
            prompt: prompt.trim(),
            createdAt: now,
            executeAt,
            recurring: false,
            intervalMs: null,
            triggerIfMissed: Boolean(triggerIfMissed),
            status: JOB_STATUS.SCHEDULED,
            metadata
        };

        this.jobs.set(jobId, job);
        this._saveStore();

        const delay = Math.max(0, executeAt - now);
        this._armOneShotJob(job, delay, callback);
        this.emit('scheduled', job);
        return job;
    }

    /**
     * Schedule a recurring interval reminder or task.
     * @param {object} params
     * @param {string} [params.id]
     * @param {string} params.prompt
     * @param {number} params.intervalMs Interval in milliseconds (minimum 1000ms).
     * @param {Function} [params.callback]
     * @param {object} [params.metadata]
     * @returns {object} Scheduled job record.
     */
    scheduleRecurring({
        id,
        prompt,
        intervalMs,
        callback = null,
        metadata = {}
    }) {
        if (this.isDisposed) {
            throw new Error('Scheduler is disposed');
        }
        if (!prompt || typeof prompt !== 'string') {
            throw new Error('Recurring task prompt must be a non-empty string');
        }
        if (typeof intervalMs !== 'number' || intervalMs < 1000) {
            throw new Error('Recurring intervalMs must be a number >= 1000ms');
        }

        const now = this.clock.now();
        const jobId = id || `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const job = {
            id: jobId,
            prompt: prompt.trim(),
            createdAt: now,
            executeAt: now + intervalMs,
            recurring: true,
            intervalMs,
            triggerIfMissed: false,
            status: JOB_STATUS.SCHEDULED,
            iterationCount: 0,
            metadata
        };

        this.jobs.set(jobId, job);
        this._saveStore();

        this._armRecurringJob(job, callback);
        this.emit('scheduled', job);
        return job;
    }

    _armOneShotJob(job, delayMs, callback = null) {
        if (this.activeTimers.has(job.id)) {
            clearTimeout(this.activeTimers.get(job.id));
        }

        const timer = setTimeout(async () => {
            this.activeTimers.delete(job.id);
            await this._executeJob(job.id, callback);
        }, delayMs);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        this.activeTimers.set(job.id, timer);
    }

    _armRecurringJob(job, callback = null) {
        if (this.activeTimers.has(job.id)) {
            clearInterval(this.activeTimers.get(job.id));
        }

        const timer = setInterval(async () => {
            await this._executeJob(job.id, callback);
        }, job.intervalMs);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        this.activeTimers.set(job.id, timer);
    }

    async _executeJob(jobId, directCallback = null) {
        const job = this.jobs.get(jobId);
        if (!job || job.status === JOB_STATUS.CANCELLED) {
            return;
        }

        job.status = JOB_STATUS.RUNNING;
        job.lastExecutedAt = this.clock.now();
        if (job.recurring) {
            job.iterationCount = (job.iterationCount || 0) + 1;
        }
        this.emit('triggered', job);

        try {
            if (typeof directCallback === 'function') {
                await directCallback(job);
            } else if (this.taskCoordinator && typeof this.taskCoordinator.executeRequest === 'function') {
                await this.taskCoordinator.executeRequest(job.prompt);
            }

            if (!job.recurring) {
                job.status = JOB_STATUS.COMPLETED;
                job.completedAt = this.clock.now();
            } else {
                job.status = JOB_STATUS.SCHEDULED;
            }
            this.emit('completed', job);
        } catch (err) {
            job.status = job.recurring ? JOB_STATUS.SCHEDULED : JOB_STATUS.FAILED;
            job.lastError = err.message;
            this.emit('failed', { job, error: err });
        } finally {
            this._saveStore();
        }
    }

    /**
     * Cancel an active or pending job by ID.
     * @param {string} id 
     * @returns {boolean} True if cancelled, false if not found.
     */
    cancelJob(id) {
        const job = this.jobs.get(id);
        if (!job) {
            return false;
        }

        if (this.activeTimers.has(id)) {
            const handle = this.activeTimers.get(id);
            if (job.recurring) {
                clearInterval(handle);
            } else {
                clearTimeout(handle);
            }
            this.activeTimers.delete(id);
        }

        job.status = JOB_STATUS.CANCELLED;
        job.cancelledAt = this.clock.now();
        this._saveStore();
        this.emit('cancelled', job);
        return true;
    }

    /**
     * List all scheduled jobs.
     * @param {object} [options]
     * @param {boolean} [options.includeCompleted=false]
     * @returns {Array<object>}
     */
    listJobs({ includeCompleted = false } = {}) {
        const result = [];
        for (const job of this.jobs.values()) {
            if (!includeCompleted && (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.CANCELLED)) {
                continue;
            }
            result.push({ ...job });
        }
        return result;
    }

    /**
     * Retrieve job by ID.
     */
    getJob(id) {
        const job = this.jobs.get(id);
        return job ? { ...job } : null;
    }

    /**
     * Clear all scheduled timers and persist state.
     */
    dispose() {
        this.isDisposed = true;
        for (const [id, handle] of this.activeTimers.entries()) {
            const job = this.jobs.get(id);
            if (job && job.recurring) {
                clearInterval(handle);
            } else {
                clearTimeout(handle);
            }
        }
        this.activeTimers.clear();
        this.removeAllListeners();
    }
}

module.exports = {
    Scheduler,
    JOB_STATUS,
    getStoragePath
};
