'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
    TaskStatusManager,
    TASK_STATES,
    IllegalStateTransitionError,
    DuplicateTaskExecutionError
} = require('../../src/core/task-status.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS } = require('../../src/security/permission-authority.js');

test('Workstream 1: Unified Execution State Machine', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-sm-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    await t.test('1. Valid full lifecycle state transitions', () => {
        const sm = new TaskStatusManager();
        sm.startTask('task-101', 'Analyze workspace files');

        assert.equal(sm.state, TASK_STATES.CREATED);
        assert.equal(sm.canTransition(TASK_STATES.PLANNING), true);

        sm.transition(TASK_STATES.PLANNING);
        assert.equal(sm.state, TASK_STATES.PLANNING);

        sm.transition(TASK_STATES.READY);
        assert.equal(sm.state, TASK_STATES.READY);

        sm.transition(TASK_STATES.RUNNING);
        assert.equal(sm.state, TASK_STATES.RUNNING);

        sm.transition(TASK_STATES.EXECUTING_TOOL, { tool: 'file_read' });
        assert.equal(sm.state, TASK_STATES.EXECUTING_TOOL);

        sm.transition(TASK_STATES.VERIFYING);
        assert.equal(sm.state, TASK_STATES.VERIFYING);

        sm.transition(TASK_STATES.RECOVERING, { attempt: 1 });
        assert.equal(sm.state, TASK_STATES.RECOVERING);

        sm.transition(TASK_STATES.EXECUTING_TOOL, { tool: 'file_read', retry: true });
        sm.transition(TASK_STATES.VERIFYING);

        sm.transition(TASK_STATES.COMPLETED, { summary: 'All steps verified successfully.' });
        assert.equal(sm.state, TASK_STATES.COMPLETED);
    });

    await t.test('2. Illegal state transitions are strictly prevented and throw IllegalStateTransitionError', () => {
        const sm = new TaskStatusManager();
        sm.startTask('task-102', 'Test illegal transitions');

        // Cannot jump directly from CREATED to COMPLETED
        assert.equal(sm.canTransition(TASK_STATES.COMPLETED), false);
        assert.throws(
            () => sm.transition(TASK_STATES.COMPLETED),
            (err) => {
                assert.ok(err instanceof IllegalStateTransitionError);
                assert.match(err.message, /Illegal state transition/i);
                return true;
            }
        );

        sm.transition(TASK_STATES.PLANNING);
        sm.transition(TASK_STATES.READY);
        sm.transition(TASK_STATES.RUNNING);
        sm.transition(TASK_STATES.COMPLETED);

        // Terminal state COMPLETED cannot transition to RUNNING or EXECUTING_TOOL
        assert.equal(sm.canTransition(TASK_STATES.RUNNING), false);
        assert.throws(
            () => sm.transition(TASK_STATES.RUNNING),
            (err) => {
                assert.ok(err instanceof IllegalStateTransitionError);
                return true;
            }
        );
    });

    await t.test('3. Terminal-state integrity: terminal states cannot be mutated without explicit reset', () => {
        const terminalStates = [
            TASK_STATES.COMPLETED,
            TASK_STATES.PARTIALLY_COMPLETED,
            TASK_STATES.FAILED,
            TASK_STATES.CANCELLED
        ];

        for (const termState of terminalStates) {
            const sm = new TaskStatusManager();
            sm.startTask(`task-${termState}`, 'Testing terminal integrity');
            sm.transition(TASK_STATES.PLANNING);
            sm.transition(termState);

            assert.equal(sm.state, termState);
            assert.equal(sm.isTerminal(), true);

            // Attempting transition to any active state must fail
            assert.equal(sm.canTransition(TASK_STATES.RUNNING), false);
            assert.equal(sm.canTransition(TASK_STATES.EXECUTING_TOOL), false);
            assert.equal(sm.canTransition(TASK_STATES.PLANNING), false);

            assert.throws(() => sm.transition(TASK_STATES.RUNNING), IllegalStateTransitionError);

            // Calling failTask or completeTask while in terminal state must be a safe no-op
            sm.failTask('Ignored failure');
            assert.equal(sm.state, termState);

            sm.completeTask({ ignored: true });
            assert.equal(sm.state, termState);
        }
    });

    await t.test('3b. Explicit reset accurately captures previous state in transition event and updates history', () => {
        const sm = new TaskStatusManager();
        sm.startTask('task-reset-test', 'Testing explicit reset');
        sm.transition(TASK_STATES.PLANNING);
        sm.transition(TASK_STATES.COMPLETED, { summary: 'Finished' });

        assert.equal(sm.state, TASK_STATES.COMPLETED);
        assert.equal(sm.isTerminal(), true);

        const resetEvent = sm.reset();
        assert.equal(resetEvent.from, TASK_STATES.COMPLETED);
        assert.equal(resetEvent.to, TASK_STATES.IDLE);
        assert.equal(sm.state, TASK_STATES.IDLE);
        assert.equal(sm.isTerminal(), false);
        assert.equal(sm.currentTask, null);

        const lastHistoryEvent = sm.history[sm.history.length - 1];
        assert.ok(lastHistoryEvent, 'Reset event should be recorded in history');
        assert.equal(lastHistoryEvent.from, TASK_STATES.COMPLETED);
        assert.equal(lastHistoryEvent.to, TASK_STATES.IDLE);
    });

    await t.test('4. Duplicate task execution rejection in TaskCoordinator', async () => {
        const pa = new PermissionAuthority({ workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'long_running_tool',
            name: 'Long Running Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                await new Promise((r) => setTimeout(r, 100));
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        const customPlanner = {
            plan: async () => ({
                type: 'plan',
                steps: [{ index: 1, title: 'Long task', toolId: 'long_running_tool', params: {} }]
            })
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: customPlanner,
            memoryDir: path.join(testDir, 'mem_duplicate')
        });

        const fixedTaskId = 'fixed_task_id_999';

        // Start task asynchronously
        const p1 = coordinator.executeRequest('Execute initial task', { taskId: fixedTaskId });

        // Immediately attempt duplicate execution with same taskId while p1 is in-flight
        await assert.rejects(
            async () => {
                await coordinator.executeRequest('Execute duplicate task', { taskId: fixedTaskId });
            },
            (err) => {
                assert.ok(err instanceof DuplicateTaskExecutionError);
                assert.match(err.message, /already actively executing/i);
                return true;
            }
        );

        const res1 = await p1;
        assert.equal(res1.ok, true);
    });

    await t.test('5. Exception cleanup: Uncaught exceptions never leave task orphaned in running state', async () => {
        const pa = new PermissionAuthority({ workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'exploding_tool',
            name: 'Exploding Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                throw new Error('Fatal unhandled crash inside tool handler');
            }
        });

        const customPlanner = {
            plan: async () => ({
                type: 'plan',
                steps: [{ index: 1, title: 'Step 1', toolId: 'exploding_tool', params: {} }]
            })
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: customPlanner,
            memoryDir: path.join(testDir, 'mem_exception')
        });

        const taskId = 'task_crash_test';
        const outcome = await coordinator.executeRequest('Trigger fatal crash', { taskId });

        assert.equal(outcome.ok, false);
        assert.equal(outcome.status, 'failed');
        assert.match(outcome.error, /Fatal unhandled crash inside tool handler/i);

        // Crucial requirement: coordinator activeTasks must NOT contain taskId
        assert.equal(coordinator.activeTasks.has(taskId), false);

        // Status manager must be in FAILED, not RUNNING
        assert.equal(coordinator.statusManager.state, TASK_STATES.FAILED);
        assert.equal(coordinator.statusManager.isTerminal(), true);
    });

    await t.test('6. Step-level tracking: records step start, completion, and failure history', () => {
        const sm = new TaskStatusManager();
        sm.startTask('task-steps', 'Multi-step verification');
        sm.transition(TASK_STATES.PLANNING);
        sm.transition(TASK_STATES.READY);
        sm.transition(TASK_STATES.RUNNING);

        // Record Step 1 Start and Completion
        sm.recordStepStart('step_1', { toolId: 'file_read', path: 'notes.txt' });
        assert.equal(sm.stepHistory.has('step_1'), true);
        assert.equal(sm.stepHistory.get('step_1').status, 'started');

        sm.recordStepCompletion('step_1', { content: 'hello' }, { verified: true });
        assert.equal(sm.stepHistory.get('step_1').status, 'completed');
        assert.equal(sm.stepHistory.get('step_1').verified, true);

        // Record Step 2 Start and Failure
        sm.recordStepStart('step_2', { toolId: 'file_write', path: 'out.txt' });
        sm.recordStepFailure('step_2', 'Disk full', { verified: false });

        assert.equal(sm.stepHistory.get('step_2').status, 'failed');
        assert.equal(sm.stepHistory.get('step_2').error, 'Disk full');
        assert.equal(sm.stepHistory.get('step_2').verified, false);

        const summary = sm.getStepSummary();
        assert.equal(summary.total, 2);
        assert.equal(summary.completed, 1);
        assert.equal(summary.failed, 1);
    });
});
