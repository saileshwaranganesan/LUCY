'use strict';

const { EventEmitter } = require('events');

const TASK_STATES = Object.freeze({
    IDLE: 'IDLE',
    INTERPRETING: 'INTERPRETING',
    PLANNING: 'PLANNING',
    WAITING_PERMISSION: 'WAITING_PERMISSION',
    EXECUTING_TOOL: 'EXECUTING_TOOL',
    VERIFYING: 'VERIFYING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    INTERRUPTED: 'INTERRUPTED'
});

class TaskStatusManager extends EventEmitter {
    constructor() {
        super();
        this.currentState = TASK_STATES.IDLE;
        this.currentTask = null;
        this.history = [];
    }

    getState() {
        return {
            state: this.currentState,
            task: this.currentTask ? { ...this.currentTask } : null
        };
    }

    transition(newState, payload = {}) {
        if (!Object.values(TASK_STATES).includes(newState)) {
            throw new Error(`Invalid state: ${newState}`);
        }

        const previousState = this.currentState;
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
            if (payload.step) this.currentTask.currentStep = payload.step;
            if (payload.plan) this.currentTask.plan = payload.plan;
            if (payload.error) this.currentTask.error = payload.error;
            if (payload.result) this.currentTask.result = payload.result;
        }

        this.history.push(event);
        this.emit('stateChanged', event);
        return event;
    }

    startTask(taskId, description) {
        this.currentTask = {
            id: taskId || `task_${Date.now()}`,
            description,
            state: TASK_STATES.INTERPRETING,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            currentStep: 0,
            totalSteps: 0,
            plan: []
        };
        return this.transition(TASK_STATES.INTERPRETING, { taskId: this.currentTask.id, description });
    }

    completeTask(result = {}) {
        return this.transition(TASK_STATES.COMPLETED, { result });
    }

    failTask(error = '') {
        return this.transition(TASK_STATES.FAILED, { error });
    }

    reset() {
        this.currentTask = null;
        return this.transition(TASK_STATES.IDLE);
    }
}

module.exports = {
    TaskStatusManager,
    TASK_STATES
};
