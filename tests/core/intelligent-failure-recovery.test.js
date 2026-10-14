'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TaskRecoveryEngine, FAILURE_TYPES, RECOVERY_STRATEGIES } = require('../../src/core/recovery-engine.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');

test('Workstream 4: Intelligent Failure Recovery', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-recovery-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    await t.test('1. Deterministic failure classification across categories', () => {
        const engine = new TaskRecoveryEngine();

        // 1a. Transient timeouts
        const c1 = engine.classifyFailure(new Error('Navigation timeout after 30000ms'));
        assert.equal(c1.type, FAILURE_TYPES.TRANSIENT);
        assert.equal(c1.recoverable, true);
        assert.equal(c1.suggestedStrategy, RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF);

        // 1b. Permission denial
        const c2 = engine.classifyFailure({ status: 'permission_denied', error: 'User declined permission' });
        assert.equal(c2.type, FAILURE_TYPES.PERMISSION_DENIED);
        assert.equal(c2.recoverable, false);
        assert.equal(c2.suggestedStrategy, RECOVERY_STRATEGIES.FAIL_CLOSED);

        // 1c. Cancellation
        const c3 = engine.classifyFailure({ name: 'AbortError', message: 'Task was cancelled by user' });
        assert.equal(c3.type, FAILURE_TYPES.CANCELLED);
        assert.equal(c3.recoverable, false);
        assert.equal(c3.suggestedStrategy, RECOVERY_STRATEGIES.FAIL_CLOSED);

        // 1d. Invalid schema input
        const c4 = engine.classifyFailure(new Error('Validation error: parameters.path must be a string'));
        assert.equal(c4.type, FAILURE_TYPES.INVALID_INPUT);
        assert.equal(c4.recoverable, false);
        assert.equal(c4.suggestedStrategy, RECOVERY_STRATEGIES.FAIL_CLOSED);

        // 1e. Unavailable capability
        const c5 = engine.classifyFailure(new Error('Vision model not configured or unsupported on this endpoint'));
        assert.equal(c5.type, FAILURE_TYPES.UNAVAILABLE_CAPABILITY);
        assert.equal(c5.recoverable, false);
    });

    await t.test('2. Bounded transient failure recovery: Recovers on second attempt and records structured recovery receipt', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let executionCalls = 0;
        tr.registerTool({
            id: 'flaky_network_api',
            name: 'Flaky Network API',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                executionCalls++;
                if (executionCalls === 1) {
                    return { ok: false, error: 'Connection reset by peer (ECONNRESET)', verification: { verified: false } };
                }
                return {
                    ok: true,
                    status: 'success_on_retry',
                    result: { data: 'recovered_payload' },
                    verification: { verified: true }
                };
            }
        });

        const customPlan = {
            objective: 'Recover transient network error',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Fetch Remote Data', toolId: 'flaky_network_api', params: {} }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 20 }),
            memoryDir: path.join(testDir, 'mem_rec_1')
        });

        const res = await coordinator.executeRequest('Fetch remote data with transient recovery');

        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(executionCalls, 2, 'Tool should have been retried once upon transient network reset');
        assert.equal(res.executedSteps.length, 1);
        assert.equal(res.executedSteps[0].verified, true);

        // Recovery receipt verification
        const receipt = res.executedSteps[0].recovery;
        assert.ok(receipt, 'Recovery receipt must be attached to the recovered step');
        assert.equal(receipt.attempts, 1);
        assert.equal(receipt.recovered, true);
        assert.equal(receipt.failureType, FAILURE_TYPES.TRANSIENT);
        assert.equal(receipt.strategy, RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF);
    });

    await t.test('3. Permission denial is NEVER retried and immediately halts fail-closed', async () => {
        let attemptsCount = 0;
        const pa = new PermissionAuthority({
            mode: PERMISSION_MODES.STRICT,
            workspaceRoot: testDir,
            confirmationHandler: async () => {
                attemptsCount++;
                return false; // Denied by user
            }
        });

        const tr = new ToolRegistry({ permissionAuthority: pa });
        tr.registerTool({
            id: 'restricted_op',
            name: 'Restricted Op',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => ({ ok: true, verification: { verified: true } })
        });

        const customPlan = {
            objective: 'Restricted execution',
            type: 'plan',
            steps: [{ id: 'step_1', index: 1, title: 'Restricted Step', toolId: 'restricted_op', params: {} }]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 3 }),
            memoryDir: path.join(testDir, 'mem_rec_2')
        });

        const res = await coordinator.executeRequest('Execute restricted step');

        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(attemptsCount, 1, 'Permission denial must NOT trigger recovery retry loops!');
        assert.equal(res.executedSteps[0].recovery, null);
    });

    await t.test('4. Task cancellation halts immediately and is never retried', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let executionCalls = 0;
        const abortController = new AbortController();

        tr.registerTool({
            id: 'cancellable_step',
            name: 'Cancellable Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                executionCalls++;
                abortController.abort('User stopped workflow');
                const err = new Error('Task was cancelled');
                err.name = 'AbortError';
                throw err;
            }
        });

        const customPlan = {
            objective: 'Cancel test',
            type: 'plan',
            steps: [{ id: 'step_1', index: 1, title: 'Cancel Step', toolId: 'cancellable_step', params: {} }]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 2 }),
            memoryDir: path.join(testDir, 'mem_rec_3')
        });

        const res = await coordinator.executeRequest('Run cancellable step', { signal: abortController.signal });

        assert.equal(res.ok, false);
        assert.equal(res.cancelled, true);
        assert.equal(executionCalls, 1, 'Cancelled task must not be retried!');
    });

    await t.test('5. Exhaustion of recovery budget: halts after max retries and honestly reports terminal failure', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let calls = 0;
        tr.registerTool({
            id: 'persistently_timing_out',
            name: 'Persistent Timeout',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                calls++;
                return { ok: false, error: 'ETIMEDOUT: Connection timed out', verification: { verified: false } };
            }
        });

        const customPlan = {
            objective: 'Exhaust retries',
            type: 'plan',
            steps: [{ id: 'step_1', index: 1, title: 'Timeout Step', toolId: 'persistently_timing_out', params: {} }]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 10 }),
            memoryDir: path.join(testDir, 'mem_rec_4')
        });

        const res = await coordinator.executeRequest('Exhaust timeout retries');

        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(calls, 3, 'Initial execution + 2 retries = 3 total attempts');

        const stepReceipt = res.executedSteps[0];
        assert.equal(stepReceipt.verified, false);
        assert.ok(stepReceipt.recovery);
        assert.equal(stepReceipt.recovery.attempts, 2);
        assert.equal(stepReceipt.recovery.recovered, false);
        assert.equal(stepReceipt.recovery.finalStatus, 'failed');
    });

    await t.test('6. Stable task ID continuity across recovery attempts and checkpoints', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let attempts = 0;
        tr.registerTool({
            id: 'retry_with_id_check',
            name: 'ID Check Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                attempts++;
                if (attempts < 2) {
                    return { ok: false, error: 'Temporary timeout error', verification: { verified: false } };
                }
                return { ok: true, status: 'recovered', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Test ID continuity',
            type: 'plan',
            steps: [{ id: 'step_1', index: 1, title: 'Step 1', toolId: 'retry_with_id_check', params: {} }]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            recoveryEngine: new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 10 }),
            memoryDir: path.join(testDir, 'mem_rec_5')
        });

        const fixedId = 'stable_id_continuity_1234';
        const res = await coordinator.executeRequest('Stable task id verification', { taskId: fixedId });

        assert.equal(res.taskId, fixedId);
        assert.equal(res.ok, true);
        assert.equal(res.executedSteps[0].recovery.recovered, true);

        // Checkpoint inspection
        const checkpoint = coordinator.taskContinuityStore.getCheckpoint(fixedId);
        assert.ok(checkpoint);
        assert.equal(checkpoint.taskId, fixedId);
        assert.equal(checkpoint.status, 'completed');
    });
});
