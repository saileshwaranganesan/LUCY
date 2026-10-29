'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES, DuplicateTaskExecutionError } = require('../../src/core/task-status.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { ResultVerifier } = require('../../src/core/result-verifier.js');
const { TaskRecoveryEngine, FAILURE_TYPES } = require('../../src/core/recovery-engine.js');

test('Execution Engine: Authoritative Task Continuity, Resumption & Timeout Lifecycle', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-continuity-exec-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    await t.test('1. Authoritative Resumption: Executes pending steps through coordinator with state machine transitions', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_1');

        let step1Ran = false;
        let step2Ran = false;

        tr.registerTool({
            id: 'setup_step_tool',
            name: 'Setup Step Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step1Ran = true;
                return { ok: true, status: 'ok', result: { ready: true }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'resume_step_tool',
            name: 'Resume Step Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step2Ran = true;
                return { ok: true, status: 'completed_resumed', result: { count: 42 }, verification: { verified: true } };
            }
        });

        const statusManager = new TaskStatusManager();
        const observedStates = [];
        statusManager.on('stateChanged', (ev) => {
            observedStates.push(ev.to);
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            statusManager,
            memoryDir: memDir
        });

        const taskId = 'task_resume_01';
        const plan = {
            objective: 'Test resumption execution',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Setup', toolId: 'setup_step_tool', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Work', toolId: 'resume_step_tool', params: {}, dependsOn: ['step_1'] }
            ]
        };

        // Seed interrupted task where step 1 is completed
        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Execute multi-step workflow',
            plan,
            currentStepIndex: 1,
            completedSteps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Step 1 Setup',
                    toolId: 'setup_step_tool',
                    params: {},
                    result: { ok: true, status: 'ok', result: { ready: true } },
                    verified: true,
                    status: 'completed'
                }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        const resumeRes = await coordinator.resumeTask(taskId);

        assert.equal(resumeRes.ok, true);
        assert.equal(resumeRes.status, 'completed');
        assert.equal(resumeRes.lifecycleState, TASK_STATES.COMPLETED);
        assert.equal(step1Ran, false, 'Completed step 1 must NEVER be re-executed');
        assert.equal(step2Ran, true, 'Pending step 2 must be executed');
        assert.equal(resumeRes.executedSteps.length, 1);
        assert.equal(resumeRes.allCompletedSteps.length, 2);

        // State machine progression check
        assert.ok(observedStates.includes(TASK_STATES.READY));
        assert.ok(observedStates.includes(TASK_STATES.RUNNING));
        assert.ok(observedStates.includes(TASK_STATES.EXECUTING_TOOL));
        assert.ok(observedStates.includes(TASK_STATES.VERIFYING));
        assert.ok(observedStates.includes(TASK_STATES.COMPLETED));
        assert.equal(statusManager.state, TASK_STATES.COMPLETED);

        // Continuity store verification
        const finalTask = coordinator.taskContinuityStore.tasks.get(taskId);
        assert.equal(finalTask.status, TASK_STATUSES.COMPLETED);
        assert.equal(finalTask.completedSteps.length, 2);
    });

    await t.test('2. Duplicate Execution Prevention: Throws DuplicateTaskExecutionError if task is currently active', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_2');

        tr.registerTool({
            id: 'slow_step_tool',
            name: 'Slow Step Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                await new Promise((r) => setTimeout(r, 100));
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: memDir
        });

        const taskId = 'task_active_dup';
        const plan = {
            objective: 'Concurrent resume check',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Slow Step', toolId: 'slow_step_tool', params: {} }
            ]
        };

        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Run slow step',
            plan,
            currentStepIndex: 0,
            completedSteps: [],
            status: TASK_STATUSES.INTERRUPTED
        });

        // Launch first resume
        const resumePromise = coordinator.resumeTask(taskId);

        // Immediately attempt concurrent resume on the same taskId
        await assert.rejects(
            async () => await coordinator.resumeTask(taskId),
            (err) => {
                assert.ok(err instanceof DuplicateTaskExecutionError);
                return true;
            }
        );

        const res = await resumePromise;
        assert.equal(res.ok, true);
    });

    await t.test('3. Dynamic Template Parameter Resolution: Resumed step resolves prior checkpointed outputs', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_3');

        let receivedParams = null;
        tr.registerTool({
            id: 'dependent_receiver_tool',
            name: 'Dependent Receiver',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => {
                receivedParams = params;
                return { ok: true, status: 'received', verification: { verified: true } };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: memDir
        });

        const taskId = 'task_param_interp';
        const plan = {
            objective: 'Dynamic param resumption',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Generate Artifact', toolId: 'generator', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Consume Artifact',
                    toolId: 'dependent_receiver_tool',
                    params: {
                        artifactPath: '{{step_1.result.outputPath}}',
                        fileSize: '{{step_1.result.bytes}}'
                    },
                    dependsOn: ['step_1']
                }
            ]
        };

        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Generate and consume artifact',
            plan,
            currentStepIndex: 1,
            completedSteps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Generate Artifact',
                    toolId: 'generator',
                    params: {},
                    result: {
                        ok: true,
                        status: 'generated',
                        result: { outputPath: 'build/output.bin', bytes: 1048576 }
                    },
                    verified: true,
                    status: 'completed'
                }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        const res = await coordinator.resumeTask(taskId);
        assert.equal(res.ok, true);
        assert.deepEqual(receivedParams, {
            artifactPath: 'build/output.bin',
            fileSize: '1048576'
        });
    });

    await t.test('4. Result Verification: Catches unverified results on resumed steps and prevents false success', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_4');

        // Tool claims ok: true, but verifier will report verification failure
        tr.registerTool({
            id: 'lying_step_tool',
            name: 'Lying Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                return { ok: true, status: 'claimed_success', result: { done: true } };
            }
        });

        const customVerifier = new ResultVerifier({ workspaceRoot: testDir });
        customVerifier.verify = async () => ({
            status: 'failed',
            verified: false,
            failureReason: 'Physical artifact absent from disk'
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            resultVerifier: customVerifier,
            memoryDir: memDir
        });

        const taskId = 'task_verifier_check';
        const plan = {
            objective: 'Verification on resume',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Prior', toolId: 'dummy', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Verify', toolId: 'lying_step_tool', params: {}, dependsOn: ['step_1'] }
            ]
        };

        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Verify resumed step',
            plan,
            currentStepIndex: 1,
            completedSteps: [
                { id: 'step_1', index: 1, title: 'Step 1 Prior', toolId: 'dummy', verified: true, result: { ok: true } }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        const res = await coordinator.resumeTask(taskId);

        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(res.partiallyCompleted, true, 'Task must be reported as partially completed');
        assert.equal(res.lifecycleState, TASK_STATES.PARTIALLY_COMPLETED);
        assert.match(res.error, /Physical artifact absent from disk/i);

        // Checkpoint must reflect partially completed state, not completed
        const cp = coordinator.taskContinuityStore.tasks.get(taskId);
        assert.equal(cp.status, TASK_STATUSES.PARTIALLY_COMPLETED);
    });

    await t.test('5. Conditional Branching in Resumed Steps: Correctly skips when condition is unmet', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_5');

        let skippedToolRan = false;
        tr.registerTool({
            id: 'conditional_unmet_tool',
            name: 'Conditional Unmet Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                skippedToolRan = true;
                return { ok: true, status: 'should_not_run' };
            }
        });

        let finalToolRan = false;
        tr.registerTool({
            id: 'final_step_tool',
            name: 'Final Step Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                finalToolRan = true;
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: memDir
        });

        const taskId = 'task_cond_resume';
        const plan = {
            objective: 'Condition on resume',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Completed', toolId: 'init', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Step 2 Conditioned',
                    toolId: 'conditional_unmet_tool',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.shouldExecute', op: 'eq', value: true },
                    onFalse: 'skip'
                },
                { id: 'step_3', index: 3, title: 'Step 3 Final', toolId: 'final_step_tool', params: {}, dependsOn: ['step_2'] }
            ]
        };

        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Run conditional resume',
            plan,
            currentStepIndex: 1,
            completedSteps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Step 1 Completed',
                    toolId: 'init',
                    result: { ok: true, status: 'ok', result: { shouldExecute: false } },
                    verified: true,
                    status: 'completed'
                }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        const res = await coordinator.resumeTask(taskId);

        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(skippedToolRan, false, 'Condition was false: tool must NOT run');
        assert.equal(finalToolRan, true, 'Downstream step must run after skipped step');

        const step2Receipt = res.executedSteps.find(s => s.id === 'step_2');
        assert.ok(step2Receipt);
        assert.equal(step2Receipt.status, 'skipped');
        assert.equal(step2Receipt.skipped, true);
    });

    await t.test('6. Task Cancellation During Resumption: Halts immediately and preserves progress in checkpoint', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_6');

        tr.registerTool({
            id: 'cancellable_step_tool',
            name: 'Cancellable Step Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (_, { signal }) => {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 300);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Operation aborted'));
                        }, { once: true });
                    }
                });
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: memDir
        });

        const taskId = 'task_cancel_resume';
        const plan = {
            objective: 'Cancel during resume',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Done', toolId: 'done_tool', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Long', toolId: 'cancellable_step_tool', params: {}, dependsOn: ['step_1'] }
            ]
        };

        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Cancel during resume',
            plan,
            currentStepIndex: 1,
            completedSteps: [
                { id: 'step_1', index: 1, title: 'Step 1 Done', toolId: 'done_tool', verified: true, result: { ok: true } }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        const resumePromise = coordinator.resumeTask(taskId);

        // Cancel while step 2 is running
        await new Promise((r) => setTimeout(r, 40));
        const cancelResult = coordinator.cancelTask(taskId, 'User cancelled resumed task');
        assert.equal(cancelResult.ok, true);

        const res = await resumePromise;
        assert.equal(res.ok, false);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.cancelled, true);

        // Checkpoint MUST preserve Step 1
        const cp = coordinator.taskContinuityStore.tasks.get(taskId);
        assert.equal(cp.status, TASK_STATUSES.CANCELLED);
        assert.equal(cp.completedSteps.length, 1, 'Checkpoint must NOT wipe completedSteps on cancellation');
        assert.equal(cp.completedSteps[0].id, 'step_1');
    });

    await t.test('7. Checkpoint Preservation in executeRequest on Cancellation: Does not wipe completed steps', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_7');

        tr.registerTool({
            id: 'fast_step_tool',
            name: 'Fast Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'fast_done', verification: { verified: true } })
        });

        tr.registerTool({
            id: 'hanging_step_tool',
            name: 'Hanging Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (_, { signal }) => {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 500);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Aborted'));
                        }, { once: true });
                    }
                });
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Preserve checkpoint on cancel',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Fast', toolId: 'fast_step_tool', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Hanging', toolId: 'hanging_step_tool', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: memDir
        });

        const taskId = 'task_cancel_preserve_cp';
        const execPromise = coordinator.executeRequest('Run fast then hanging', { taskId });

        await new Promise((r) => setTimeout(r, 40));
        coordinator.cancelTask(taskId, 'Cancelled mid-flight');

        const res = await execPromise;
        assert.equal(res.ok, false);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.partiallyCompleted, true, 'Task must report partial completion since step 1 succeeded');

        // Checkpoint must contain step 1
        const cp = coordinator.taskContinuityStore.tasks.get(taskId);
        assert.equal(cp.status, TASK_STATUSES.CANCELLED);
        assert.equal(cp.completedSteps.length, 1, 'Checkpoint completedSteps must retain step 1');
        assert.equal(cp.completedSteps[0].id, 'step_1');
    });

    await t.test('8. Step Timeout Lifecycle: Bounded timeout retries transient error and records recovery', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_8');

        let attempts = 0;
        tr.registerTool({
            id: 'timed_out_then_fast_tool',
            name: 'Timed Out Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (_, { signal }) => {
                attempts++;
                if (attempts === 1) {
                    // Simulate long operation that will exceed step timeout
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(resolve, 200);
                        if (signal) {
                            signal.addEventListener('abort', () => {
                                clearTimeout(timer);
                                reject(new Error('Operation aborted'));
                            }, { once: true });
                        }
                    });
                }
                return { ok: true, status: 'fast_success', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Step timeout retry',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Step 1 With Timeout',
                    toolId: 'timed_out_then_fast_tool',
                    params: {},
                    timeoutMs: 40,
                    dependsOn: []
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 10 }),
            memoryDir: memDir
        });

        const res = await coordinator.executeRequest('Run step with timeout retry');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(attempts, 2, 'Step must be retried after transient timeout');
        assert.ok(res.executedSteps[0].recovery, 'Recovery receipt must be present');
        assert.equal(res.executedSteps[0].recovery.recovered, true);
        assert.equal(res.executedSteps[0].recovery.failureType, FAILURE_TYPES.TRANSIENT);
    });

    await t.test('9. Step Timeout Exhaustion: Fails closed and reports truthful actionable error', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_9');

        let attempts = 0;
        tr.registerTool({
            id: 'persistently_slow_tool',
            name: 'Persistently Slow Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (_, { signal }) => {
                attempts++;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 200);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Aborted'));
                        }, { once: true });
                    }
                });
                return { ok: true };
            }
        });

        const customPlan = {
            objective: 'Exhaust timeout',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Step 1 Timeout Exhaust',
                    toolId: 'persistently_slow_tool',
                    params: {},
                    timeoutMs: 30,
                    dependsOn: []
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 1, baseBackoffMs: 5 }),
            memoryDir: memDir
        });

        const res = await coordinator.executeRequest('Exhaust timeout');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.match(res.error, /timed out after 30ms/i);
        assert.equal(attempts, 2, 'Initial attempt plus 1 retry');
    });

    await t.test('10. Resumption Passes Task ID and Authorization Context to Tools', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_10');

        let passedTaskId = null;
        let passedInteractionMode = null;

        tr.registerTool({
            id: 'auth_bound_tool',
            name: 'Auth Bound Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params, options) => {
                passedTaskId = options.taskId;
                passedInteractionMode = options.interactionMode;
                return { ok: true, status: 'authorized', verification: { verified: true } };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: memDir
        });

        const taskId = 'task_auth_check_101';
        const plan = {
            objective: 'Auth check on resume',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Prior', toolId: 'init', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Auth Bound', toolId: 'auth_bound_tool', params: {}, dependsOn: ['step_1'] }
            ]
        };

        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Auth context check',
            plan,
            currentStepIndex: 1,
            completedSteps: [
                { id: 'step_1', index: 1, title: 'Step 1 Prior', toolId: 'init', verified: true, result: { ok: true } }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        const res = await coordinator.resumeTask(taskId);
        assert.equal(res.ok, true);
        assert.equal(passedTaskId, taskId, 'Resumed step must receive the bound taskId in execution options');
        assert.ok(passedInteractionMode, 'Resumed step must receive interactionMode');
    });
});
