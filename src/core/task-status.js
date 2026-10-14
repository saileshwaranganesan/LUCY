'use strict';

const { EventEmitter } = require('events');

/**
 * Unified Autonomous Task Execution State Machine
 * Centralizes lifecycle states, transition validation, terminal state integrity,
 * and step-level execution tracking.
 */
const TASK_STATES = Object.freeze({
    IDLE: 'IDLE',
    CREATED: 'CREATED',
    INTERPRETING: 'INTERPRETING',
    PLANNING: 'PLANNING',
    WAITING_PERMISSION: 'WAITING_PERMISSION',
    AWAITING_AUTHORIZATION: 'AWAITING_AUTHORIZATION',
    READY: 'READY',
    RUNNING: 'RUNNING',
    EXECUTING_TOOL: 'EXECUTING_TOOL',
    VERIFYING: 'VERIFYING',
    RECOVERING: 'RECOVERING',
    COMPLETED: 'COMPLETED',
    PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    INTERRUPTED: 'INTERRUPTED'
});

const TERMINAL_STATES = Object.freeze(new Set([
    TASK_STATES.COMPLETED,
    TASK_STATES.PARTIALLY_COMPLETED,
    TASK_STATES.FAILED,
    TASK_STATES.CANCELLED
]));

/**
 * Authoritative Transition Graph
 * Defines every permitted state progression in L.U.C.Y.'s execution lifecycle.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
    [TASK_STATES.IDLE]: new Set([
        TASK_STATES.IDLE,
        TASK_STATES.CREATED,
        TASK_STATES.INTERPRETING,
        TASK_STATES.PLANNING
    ]),
    [TASK_STATES.CREATED]: new Set([
        TASK_STATES.INTERPRETING,
        TASK_STATES.PLANNING,
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.READY,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    [TASK_STATES.INTERPRETING]: new Set([
        TASK_STATES.INTERPRETING,
        TASK_STATES.PLANNING,
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.READY,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.COMPLETED,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED,
        TASK_STATES.IDLE
    ]),
    [TASK_STATES.PLANNING]: new Set([
        TASK_STATES.PLANNING, // re-planning
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.READY,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.COMPLETED,
        TASK_STATES.PARTIALLY_COMPLETED,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    [TASK_STATES.WAITING_PERMISSION]: new Set([
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.READY,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.PLANNING,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    [TASK_STATES.AWAITING_AUTHORIZATION]: new Set([
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.READY,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.PLANNING,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    [TASK_STATES.READY]: new Set([
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.PLANNING,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    [TASK_STATES.RUNNING]: new Set([
        TASK_STATES.RUNNING, // subsequent steps
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.VERIFYING,
        TASK_STATES.RECOVERING,
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.COMPLETED,
        TASK_STATES.PARTIALLY_COMPLETED,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED,
        TASK_STATES.INTERRUPTED
    ]),
    [TASK_STATES.EXECUTING_TOOL]: new Set([
        TASK_STATES.EXECUTING_TOOL, // subsequent steps
        TASK_STATES.RUNNING,
        TASK_STATES.VERIFYING,
        TASK_STATES.RECOVERING,
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.COMPLETED,
        TASK_STATES.PARTIALLY_COMPLETED,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED,
        TASK_STATES.INTERRUPTED
    ]),
    [TASK_STATES.VERIFYING]: new Set([
        TASK_STATES.VERIFYING,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.RECOVERING,
        TASK_STATES.PLANNING, // re-plan on verification failure
        TASK_STATES.COMPLETED,
        TASK_STATES.PARTIALLY_COMPLETED,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    [TASK_STATES.RECOVERING]: new Set([
        TASK_STATES.RECOVERING,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.VERIFYING,
        TASK_STATES.PLANNING, // re-plan on alternative strategy
        TASK_STATES.AWAITING_AUTHORIZATION,
        TASK_STATES.WAITING_PERMISSION,
        TASK_STATES.COMPLETED,
        TASK_STATES.PARTIALLY_COMPLETED,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    [TASK_STATES.INTERRUPTED]: new Set([
        TASK_STATES.READY,
        TASK_STATES.RUNNING,
        TASK_STATES.EXECUTING_TOOL,
        TASK_STATES.PLANNING,
        TASK_STATES.FAILED,
        TASK_STATES.CANCELLED
    ]),
    // Terminal states cannot transition to active states unless reset()
    [TASK_STATES.COMPLETED]: new Set([TASK_STATES.IDLE]),
    [TASK_STATES.PARTIALLY_COMPLETED]: new Set([TASK_STATES.IDLE]),
    [TASK_STATES.FAILED]: new Set([TASK_STATES.IDLE]),
    [TASK_STATES.CANCELLED]: new Set([TASK_STATES.IDLE])
});

class IllegalStateTransitionError extends Error {
    constructor(fromState, toState, taskId) {
        super(`Illegal state transition from '${fromState}' to '${toState}'${taskId ? ` for task '${taskId}'` : ''}. Terminal or invalid transitions are strictly prohibited.`);
        this.name = 'IllegalStateTransitionError';
        this.fromState = fromState;
        this.toState = toState;
        this.taskId = taskId;
    }
}

class DuplicateTaskExecutionError extends Error {
    constructor(activeTaskId, attemptedTaskId) {
        super(`Cannot start task '${attemptedTaskId}': another task '${activeTaskId}' is currently active and running.`);
        this.name = 'DuplicateTaskExecutionError';
        this.activeTaskId = activeTaskId;
        this.attemptedTaskId = attemptedTaskId;
    }
}

class TaskStatusManager extends EventEmitter {
    constructor() {
        super();
        this.currentState = TASK_STATES.IDLE;
        this.currentTask = null;
        this.history = [];
    }

    get state() {
        return this.currentState;
    }

    get stepHistory() {
        const map = new Map();
        if (this.currentTask?.steps) {
            for (const s of this.currentTask.steps) {
                if (s.id) map.set(s.id, s);
                if (s.index !== undefined) map.set(s.index, s);
            }
        }
        return map;
    }

    getStepSummary() {
        const steps = this.currentTask?.steps || [];
        return {
            total: steps.length,
            completed: steps.filter(s => s.status === 'completed').length,
            failed: steps.filter(s => s.status === 'failed').length,
            started: steps.filter(s => s.status === 'started' || s.status === 'running').length
        };
    }

    getState() {
        return {
            state: this.currentState,
            isTerminal: this.isTerminal(),
            task: this.currentTask ? { ...this.currentTask, steps: [...(this.currentTask.steps || [])] } : null
        };
    }

    isTerminal() {
        return TERMINAL_STATES.has(this.currentState);
    }

    canTransition(newState) {
        if (!Object.values(TASK_STATES).includes(newState)) {
            return false;
        }
        if (this.currentState === newState) {
            // Allow re-entrant transitions for iterative/nested states
            return [
                TASK_STATES.RUNNING,
                TASK_STATES.EXECUTING_TOOL,
                TASK_STATES.VERIFYING,
                TASK_STATES.RECOVERING,
                TASK_STATES.PLANNING,
                TASK_STATES.IDLE
            ].includes(newState);
        }
        const allowed = ALLOWED_TRANSITIONS[this.currentState];
        return Boolean(allowed && allowed.has(newState));
    }

    transition(newState, payload = {}) {
        if (!Object.values(TASK_STATES).includes(newState)) {
            throw new Error(`Invalid state: ${newState}`);
        }

        const previousState = this.currentState;

        // Terminal state integrity enforcement
        if (TERMINAL_STATES.has(previousState) && newState !== TASK_STATES.IDLE && !payload.force) {
            throw new IllegalStateTransitionError(previousState, newState, this.currentTask?.id);
        }

        if (!this.canTransition(newState) && !payload.force) {
            throw new IllegalStateTransitionError(previousState, newState, this.currentTask?.id);
        }

        this.currentState = newState;

        const event = {
            from: previousState,
            to: newState,
            timestamp: new Date().toISOString(),
            ...payload
        };

        if (this.currentTask) {
            this.currentTask.state = newState;
            this.currentTask.updatedAt = event.timestamp;
            if (payload.step !== undefined) this.currentTask.currentStep = payload.step;
            if (payload.totalSteps !== undefined) this.currentTask.totalSteps = payload.totalSteps;
            if (payload.plan) this.currentTask.plan = payload.plan;
            if (payload.error) this.currentTask.error = payload.error;
            if (payload.result) this.currentTask.result = payload.result;
            if (payload.summary) this.currentTask.summary = payload.summary;
            if (payload.recovery) this.currentTask.lastRecovery = payload.recovery;
        }

        this.history.push(event);
        this.emit('stateChanged', event);
        return event;
    }

    startTask(taskId, description, options = {}) {
        // Prevent duplicate concurrent execution if another task is active
        if (this.currentTask && !this.isTerminal() && this.currentState !== TASK_STATES.IDLE && !options.allowConcurrent) {
            throw new DuplicateTaskExecutionError(this.currentTask.id, taskId);
        }

        this.currentState = TASK_STATES.IDLE;
        const id = taskId || `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        this.currentTask = {
            id,
            description,
            state: TASK_STATES.CREATED,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            currentStep: 0,
            totalSteps: 0,
            plan: [],
            steps: [],
            recoveries: []
        };

        return this.transition(options.initialState || TASK_STATES.CREATED, {
            taskId: this.currentTask.id,
            description
        });
    }

    recordStepStart(stepIdOrIndex, stepDetails = {}) {
        if (!this.currentTask) return;
        const stepRecord = {
            id: typeof stepIdOrIndex === 'string' ? stepIdOrIndex : `step_${stepIdOrIndex}`,
            index: typeof stepIdOrIndex === 'number' ? stepIdOrIndex : (parseInt(String(stepIdOrIndex).replace('step_', ''), 10) || 1),
            title: stepDetails.title || `Step ${stepIdOrIndex}`,
            toolId: stepDetails.toolId || '',
            params: stepDetails.params || {},
            expectedOutcome: stepDetails.expectedOutcome || '',
            startedAt: new Date().toISOString(),
            status: 'started'
        };

        if (!this.currentTask.steps) this.currentTask.steps = [];
        const existingIdx = this.currentTask.steps.findIndex(
            s => s.id === stepRecord.id || s.index === stepRecord.index
        );
        if (existingIdx !== -1) {
            this.currentTask.steps[existingIdx] = { ...this.currentTask.steps[existingIdx], ...stepRecord };
        } else {
            this.currentTask.steps.push(stepRecord);
        }

        this.currentTask.currentStep = stepRecord.index;
        this.emit('stepStarted', { taskId: this.currentTask.id, step: stepRecord });
    }

    recordStepCompletion(stepIdOrIndex, result = {}, verification = {}) {
        if (!this.currentTask || !this.currentTask.steps) return;
        const step = this.currentTask.steps.find(
            s => s.id === stepIdOrIndex || s.index === stepIdOrIndex
        );
        if (step) {
            step.completedAt = new Date().toISOString();
            step.status = 'completed';
            step.result = result;
            step.verification = verification;
            step.verified = Boolean(verification?.verified);
            this.emit('stepCompleted', { taskId: this.currentTask.id, step });
        }
    }

    recordStepFailure(stepIdOrIndex, error, verificationOrRecovery = {}) {
        if (!this.currentTask || !this.currentTask.steps) return;
        const step = this.currentTask.steps.find(
            s => s.id === stepIdOrIndex || s.index === stepIdOrIndex
        );
        if (step) {
            step.failedAt = new Date().toISOString();
            step.status = 'failed';
            step.error = typeof error === 'string' ? error : error?.message || 'Step failed';
            step.verified = Boolean(verificationOrRecovery?.verified);
            if (verificationOrRecovery) {
                step.verification = verificationOrRecovery;
                if (verificationOrRecovery.strategy || verificationOrRecovery.recovery) {
                    if (!this.currentTask.recoveries) this.currentTask.recoveries = [];
                    this.currentTask.recoveries.push({
                        stepId: step.id,
                        ...verificationOrRecovery,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            this.emit('stepFailed', { taskId: this.currentTask.id, step });
        }
    }

    completeTask(result = {}) {
        if (this.isTerminal()) return null;
        return this.transition(TASK_STATES.COMPLETED, { result });
    }

    partiallyCompleteTask(summary = {}, executedSteps = []) {
        if (this.isTerminal()) return null;
        return this.transition(TASK_STATES.PARTIALLY_COMPLETED, { summary, executedSteps });
    }

    failTask(error = '') {
        if (this.isTerminal()) return null;
        const errorMsg = typeof error === 'string' ? error : error?.message || 'Task failed';
        return this.transition(TASK_STATES.FAILED, { error: errorMsg });
    }

    cancelTask(reason = 'Task cancelled by user') {
        if (this.isTerminal()) return null;
        return this.transition(TASK_STATES.CANCELLED, { reason });
    }

    reset() {
        this.currentTask = null;
        this.currentState = TASK_STATES.IDLE;
        const event = {
            from: this.currentState,
            to: TASK_STATES.IDLE,
            timestamp: new Date().toISOString()
        };
        this.emit('stateChanged', event);
        return event;
    }
}

module.exports = {
    TaskStatusManager,
    TASK_STATES,
    TERMINAL_STATES,
    ALLOWED_TRANSITIONS,
    IllegalStateTransitionError,
    DuplicateTaskExecutionError
};
