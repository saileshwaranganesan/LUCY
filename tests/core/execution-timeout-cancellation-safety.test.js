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
const { TaskRecoveryEngine, FAILURE_TYPES } = require('../../src/core/recovery-engine.js');

test('Execution Engine: Timeout, Cancellation & Retry Safety Suite', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-timeout-safety-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    await t.test('1. Tool ignores abort signal: Coordinator unblocks promptly upon timeout without hanging', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_1');

        let toolStarted = false;
        let toolFinished = false;

        tr.registerTool({
            id: 'stubborn_slow_tool',
            name: 'Stubborn Slow Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                toolStarted = true;
                // Ignores signal and sleeps 300ms
                await new Promise((r) => setTimeout(r, 300));
                toolFinished = true;
                return { ok: true, status: 'done', data: { value: 123 } };
            }
        });

        const customPlan = {
            objective: 'Stubborn tool timeout',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Stubborn Step',
                    toolId: 'stubborn_slow_tool',
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
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 0 }),
            memoryDir: memDir
        });

        const startTime = Date.now();
        const res = await coordinator.executeRequest('Run stubborn tool');
        const elapsed = Date.now() - startTime;

        assert.equal(toolStarted, true, 'Tool must have started');
        assert.equal(res.ok, false, 'Result must be failure on timeout');
        assert.match(res.error, /timed out after 40ms/i);
        // Coordinator must unblock around ~40-120ms, NOT wait 300ms!
        assert.ok(elapsed < 200, `Coordinator took ${elapsed}ms; must unblock promptly near timeout`);
    });

    await t.test('2. Attempt concurrency prevention: Retry does not launch concurrently while attempt 1 is still active', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_2');

        let concurrentExecutions = 0;
        let maxConcurrent = 0;
        let attemptCount = 0;

        tr.registerTool({
            id: 'concurrency_leak_tool',
            name: 'Concurrency Leak Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                attemptCount++;
                concurrentExecutions++;
                if (concurrentExecutions > maxConcurrent) {
                    maxConcurrent = concurrentExecutions;
                }
                // Simulate slow tool that ignores signal and runs for 200ms
                await new Promise((r) => setTimeout(r, 200));
                concurrentExecutions--;
                return { ok: true, status: 'slow_done' };
            }
        });

        const customPlan = {
            objective: 'Concurrency leak check',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Slow Retry Step',
                    toolId: 'concurrency_leak_tool',
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
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 10 }),
            memoryDir: memDir
        });

        const res = await coordinator.executeRequest('Run concurrency check');

        // Verify that two attempts never executed at the same time
        assert.equal(maxConcurrent, 1, `Max concurrent attempts was ${maxConcurrent}, expected at most 1 (no overlapping executions)`);
        assert.equal(res.ok, false, 'Task must fail closed if attempt remains active or times out');
    });

    await t.test('3. Late completion isolation: First attempt finishing late does not corrupt task state or checkpoint', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_3');

        let lateAttemptCompleted = false;

        tr.registerTool({
            id: 'late_tool',
            name: 'Late Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                await new Promise((r) => setTimeout(r, 150));
                lateAttemptCompleted = true;
                return { ok: true, status: 'unwanted_late_success', result: { secretPwn: true } };
            }
        });

        const customPlan = {
            objective: 'Late attempt check',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Late Step',
                    toolId: 'late_tool',
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
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 0 }),
            memoryDir: memDir
        });

        const res = await coordinator.executeRequest('Run late attempt test');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');

        // Wait until the late attempt actually finishes in background
        await new Promise((r) => setTimeout(r, 180));
        assert.equal(lateAttemptCompleted, true);

        // State check: Coordinator status and checkpoint must NOT have been converted to completed!
        const cp = coordinator.taskContinuityStore.tasks.get(res.taskId);
        assert.equal(cp.status, TASK_STATUSES.FAILED);
        assert.equal(coordinator.statusManager.currentState, TASK_STATES.FAILED);
    });

    await t.test('4. Non-idempotent action timeout: Does NOT retry automatically and reports uncertain outcome', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        pa.setConfirmationHandler(async () => ({ approved: true }));
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_4');

        let mutationCount = 0;

        tr.registerTool({
            id: 'non_idempotent_mutation_tool',
            name: 'Mutation Tool',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                // Side-effect executed immediately
                mutationCount++;
                // Then operation delays beyond step timeout
                await new Promise((r) => setTimeout(r, 200));
                return { ok: true, status: 'mutated' };
            }
        });

        const customPlan = {
            objective: 'Non-idempotent retry check',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Consequential Mutation Step',
                    toolId: 'non_idempotent_mutation_tool',
                    params: {},
                    isConsequential: true,
                    timeoutMs: 35,
                    dependsOn: []
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 3, baseBackoffMs: 10 }),
            memoryDir: memDir
        });

        const res = await coordinator.executeRequest('Mutate state once');

        assert.equal(res.ok, false);
        assert.equal(mutationCount, 1, 'Non-idempotent operation must NOT be retried on timeout (mutationCount must be 1, not 2+)');
        assert.ok(res.uncertain || res.error.toLowerCase().includes('uncertain') || res.error.toLowerCase().includes('timeout'));
    });

    await t.test('5. Cancellation during running step: Halts and allows resumption of only pending steps', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_5');

        let step1Ran = 0;
        let step2Ran = 0;

        tr.registerTool({
            id: 'step1_fast',
            name: 'Step 1 Fast',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step1Ran++;
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'step2_cancellable',
            name: 'Step 2 Cancellable',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (_, { signal }) => {
                step2Ran++;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 300);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Operation cancelled by signal'));
                        }, { once: true });
                    }
                });
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        const plan = {
            objective: 'Cancel then resume',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Fast', toolId: 'step1_fast', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Cancellable', toolId: 'step2_cancellable', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => plan },
            memoryDir: memDir
        });

        const taskId = 'task_cancel_then_resume';
        const execPromise = coordinator.executeRequest('Cancel then resume', { taskId });

        // Cancel while step 2 is executing
        await new Promise((r) => setTimeout(r, 40));
        coordinator.cancelTask(taskId, 'User stopped task mid-flight');

        const cancelRes = await execPromise;
        assert.equal(cancelRes.ok, false);
        assert.equal(cancelRes.cancelled, true);
        assert.equal(step1Ran, 1);
        assert.equal(cancelRes.partiallyCompleted, true);

        // Resume the task
        const resumeRes = await coordinator.resumeTask(taskId);
        assert.equal(resumeRes.ok, true);
        assert.equal(resumeRes.status, 'completed');
        assert.equal(step1Ran, 1, 'Step 1 must NOT be re-executed upon resumption');
        assert.equal(step2Ran, 2, 'Step 2 must execute upon resumption');
    });

    await t.test('6. Verified step is not executed again when a later step fails', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_6');

        let step1ExecCount = 0;

        tr.registerTool({
            id: 'step1_tool',
            name: 'Step 1 Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step1ExecCount++;
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'step2_fail_tool',
            name: 'Step 2 Fail Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                return { ok: false, error: 'Target resource unavailable' };
            }
        });

        const plan = {
            objective: 'Failure after step 1',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'step1_tool', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2', toolId: 'step2_fail_tool', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => plan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 0 }),
            memoryDir: memDir
        });

        const taskId = 'task_step2_fails';
        const res = await coordinator.executeRequest('Run until step 2 fails', { taskId });

        assert.equal(res.ok, false);
        assert.equal(step1ExecCount, 1);
        assert.equal(res.partiallyCompleted, true);

        // Check continuity store inspection
        const inspect = coordinator.inspectTask(taskId);
        assert.equal(inspect.completedCount, 1);
        assert.equal(inspect.completedSteps[0].id, 'step_1');
        assert.equal(inspect.isResumable, true);
    });

    await t.test('7. Concurrent resumption prevention: Second resume rejects with DuplicateTaskExecutionError', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_7');

        tr.registerTool({
            id: 'slow_resume_tool',
            name: 'Slow Resume Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                await new Promise((r) => setTimeout(r, 120));
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: memDir
        });

        const taskId = 'task_concurrent_resume_check';
        const plan = {
            objective: 'Concurrent resume check',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Slow Step', toolId: 'slow_resume_tool', params: {}, dependsOn: [] }
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

        const resume1 = coordinator.resumeTask(taskId);

        // Simultaneous second resume on the same task must reject
        await assert.rejects(
            async () => await coordinator.resumeTask(taskId),
            (err) => {
                assert.ok(err instanceof DuplicateTaskExecutionError);
                return true;
            }
        );

        const res1 = await resume1;
        assert.equal(res1.ok, true);
    });

    await t.test('8. Timed-out step exhausts retries and leaves accurate checkpoint', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_8');

        let attempts = 0;
        tr.registerTool({
            id: 'always_times_out_tool',
            name: 'Always Times Out',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (_, { signal }) => {
                attempts++;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 300);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Operation aborted'));
                        }, { once: true });
                    }
                });
                return { ok: true };
            }
        });

        const customPlan = {
            objective: 'Exhaust retries',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Exhaust Step',
                    toolId: 'always_times_out_tool',
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
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 5 }),
            memoryDir: memDir
        });

        const taskId = 'task_timeout_exhaust';
        const res = await coordinator.executeRequest('Exhaust timeout', { taskId });

        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(attempts, 3, 'Initial attempt + 2 retries = 3 attempts total');
        assert.match(res.error, /timed out after 30ms/i);

        // Checkpoint verification
        const cp = coordinator.taskContinuityStore.tasks.get(taskId);
        assert.equal(cp.status, TASK_STATUSES.FAILED);
        assert.match(cp.error, /timed out after 30ms/i);
    });

    await t.test('9. Missing, zero, negative, and invalid timeout settings have explicit, tested behavior', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const memDir = path.join(testDir, 'mem_9');

        tr.registerTool({
            id: 'fast_finisher',
            name: 'Fast Finisher',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                await new Promise((r) => setTimeout(r, 10));
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: memDir
        });

        // 9a: Missing timeout (undefined) -> succeeds normally
        const planA = {
            type: 'plan',
            steps: [{ id: 's1', index: 1, title: 'Missing timeout', toolId: 'fast_finisher', params: {} }]
        };
        const resA = await coordinator.executeRequest('Test missing timeout', { planOverride: planA });
        assert.equal(resA.ok, true);

        // 9b: Zero timeout (0) -> explicit meaning: no timeout enforced, succeeds normally
        const planB = {
            type: 'plan',
            steps: [{ id: 's1', index: 1, title: 'Zero timeout', toolId: 'fast_finisher', params: {}, timeoutMs: 0 }]
        };
        const resB = await coordinator.executeRequest('Test zero timeout', { planOverride: planB });
        assert.equal(resB.ok, true);

        // 9c: Negative timeout (-50) -> normalized to no timeout (not treated as 1ms premature abort!)
        const planC = {
            type: 'plan',
            steps: [{ id: 's1', index: 1, title: 'Negative timeout', toolId: 'fast_finisher', params: {}, timeoutMs: -50 }]
        };
        const resC = await coordinator.executeRequest('Test negative timeout', { planOverride: planC });
        assert.equal(resC.ok, true, 'Negative timeout must be normalized and not trigger a 1ms premature abort');

        // 9d: Invalid timeout (NaN / "abc") -> normalized to no timeout without crashing
        const planD = {
            type: 'plan',
            steps: [{ id: 's1', index: 1, title: 'Invalid string timeout', toolId: 'fast_finisher', params: {}, timeoutMs: 'invalid_timeout' }]
        };
        const resD = await coordinator.executeRequest('Test invalid timeout', { planOverride: planD });
        assert.equal(resD.ok, true, 'Invalid non-numeric timeout must be safely normalized');
    });
});
