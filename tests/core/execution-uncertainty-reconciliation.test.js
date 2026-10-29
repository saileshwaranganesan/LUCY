'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES, UncertainOutcomeError } = require('../../src/core/task-status.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { SqliteMemoryAdapter } = require('../../src/memory/sqlite-adapter.js');

function createTempDir(prefix = 'lucy-uncertainty-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.LUCY_MEMORY_DIR = dir;
    return dir;
}

function cleanTempDir(dir) {
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    } catch (_) {}
}

test.describe('Execution Engine: Uncertain Outcomes & Safe Resumption Audit', () => {

    test('1. Consequential timeout with late handler side-effect reports awaiting_reconciliation', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let sideEffectOccurred = false;
            let handlerSettle;
            const handlerPromise = new Promise((resolve) => {
                handlerSettle = resolve;
            });

            toolRegistry.registerTool({
                id: 'consequential_write',
                name: 'Consequential Write',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                supportsCancellation: true,
                timeoutMs: 50,
                handler: async () => {
                    await handlerPromise;
                    sideEffectOccurred = true;
                    return { ok: true, fileWritten: true };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [
                            {
                                id: 'step_write',
                                title: 'Write critical record',
                                toolId: 'consequential_write',
                                isConsequential: true,
                                timeoutMs: 30,
                                params: { key: 'secret_val' }
                            }
                        ]
                    })
                }
            });

            const res = await coordinator.executeRequest('Write the record', { taskId: 'task_uncertain_1' });

            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.status, 'awaiting_reconciliation');
            assert.strictEqual(res.uncertain, true);
            assert.strictEqual(res.lifecycleState, TASK_STATES.AWAITING_RECONCILIATION);
            assert.ok(res.uncertainStep, 'Must provide structured uncertainStep');
            assert.strictEqual(res.uncertainStep.toolId, 'consequential_write');
            assert.strictEqual(res.uncertainStep.resolved, false);

            const cp = continuityStore.getCheckpoint('task_uncertain_1');
            assert.strictEqual(cp.status, TASK_STATUSES.AWAITING_RECONCILIATION);
            assert.strictEqual(cp.uncertainStep.resolved, false);

            // Clean up late handler
            handlerSettle();
            await handlerPromise;
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('2. Resumption blocked while handler is still active', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let handlerSettle;
            const handlerPromise = new Promise((resolve) => {
                handlerSettle = resolve;
            });

            toolRegistry.registerTool({
                id: 'slow_consequential',
                name: 'Slow Consequential Tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                timeoutMs: 30,
                handler: async () => {
                    await handlerPromise;
                    return { ok: true };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [
                            {
                                id: 'step_slow',
                                title: 'Slow execution',
                                toolId: 'slow_consequential',
                                isConsequential: true,
                                timeoutMs: 25,
                                params: {}
                            }
                        ]
                    })
                }
            });

            await coordinator.executeRequest('Execute slow action', { taskId: 'task_still_running_1' });

            // Handler is still running in background
            const resumeRes = await coordinator.resumeTask('task_still_running_1');
            assert.strictEqual(resumeRes.ok, false);
            assert.strictEqual(resumeRes.status, 'still_running_blocked');
            assert.match(resumeRes.error, /still actively executing/i);

            handlerSettle();
            await handlerPromise;
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('3. Uncertainty survives coordinator reconstruction (restart) and blocks resumption', async () => {
        const tempDir = createTempDir();
        try {
            const toolRegistry = new ToolRegistry();
            toolRegistry.registerTool({
                id: 'restart_consequential',
                name: 'Restart Consequential',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                timeoutMs: 20,
                handler: async () => {
                    await new Promise((r) => setTimeout(r, 60));
                    return { ok: true };
                }
            });

            // Session 1: run and time out
            const continuityStore1 = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const coordinator1 = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore1,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 'step_restart', title: 'Action', toolId: 'restart_consequential', isConsequential: true, timeoutMs: 20, params: {} }]
                    })
                }
            });

            const runRes = await coordinator1.executeRequest('Run action', { taskId: 'task_reboot_1' });
            assert.strictEqual(runRes.status, 'awaiting_reconciliation');

            // Simulate application shutdown / restart by creating completely new instances from same storeDir
            const continuityStore2 = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const coordinator2 = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore2,
                toolRegistry
            });

            const inspection = continuityStore2.inspectTaskForResume('task_reboot_1');
            assert.strictEqual(inspection.hasUncertainStep, true);
            assert.strictEqual(inspection.isResumable, false);
            assert.match(inspection.blockingReason, /Automatic replay is strictly blocked/i);

            // Attempt resumption through coordinator2
            const resumeRes = await coordinator2.resumeTask('task_reboot_1');
            assert.strictEqual(resumeRes.ok, false);
            assert.strictEqual(resumeRes.status, 'uncertain_outcome_blocked');
            assert.strictEqual(resumeRes.uncertainStep.stepId, 'step_restart');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('4. Resumption blocked across multiple resume entry points', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            store.saveCheckpoint({
                taskId: 'task_multi_entry_1',
                userRequest: 'Uncertain task',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 's1', toolId: 'c_tool', isConsequential: true }] },
                uncertainStep: {
                    stepId: 's1',
                    index: 1,
                    toolId: 'c_tool',
                    reason: 'Timed out',
                    resolved: false
                }
            });

            const coordinator = new TaskCoordinator({ memoryDir: tempDir, taskContinuityStore: store });

            // Entry point 1: coordinator.resumeTask()
            const cRes = await coordinator.resumeTask('task_multi_entry_1');
            assert.strictEqual(cRes.ok, false);
            assert.strictEqual(cRes.status, 'uncertain_outcome_blocked');

            // Entry point 2: coordinator.resumeTask with throwOnBlocked
            await assert.rejects(
                async () => await coordinator.resumeTask('task_multi_entry_1', { throwOnBlocked: true }),
                UncertainOutcomeError
            );

            // Entry point 3: store.resumeTask directly
            await assert.rejects(
                async () => await store.resumeTask('task_multi_entry_1'),
                UncertainOutcomeError
            );
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('5. Prior verified step preserved while later step is uncertain', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let step1ExecutionCount = 0;
            toolRegistry.registerTool({
                id: 'safe_step_1',
                name: 'Safe Step 1',
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => {
                    step1ExecutionCount++;
                    return { ok: true, data: 'step1_output' };
                }
            });

            toolRegistry.registerTool({
                id: 'consequential_step_2',
                name: 'Consequential Step 2',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                timeoutMs: 25,
                handler: async () => {
                    await new Promise((r) => setTimeout(r, 60));
                    return { ok: true };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [
                            { id: 's1', title: 'Step 1', toolId: 'safe_step_1', timeoutMs: 100 },
                            { id: 's2', title: 'Step 2', toolId: 'consequential_step_2', isConsequential: true, timeoutMs: 20 }
                        ]
                    })
                }
            });

            const res = await coordinator.executeRequest('Execute two steps', { taskId: 'task_two_steps' });
            assert.strictEqual(res.status, 'awaiting_reconciliation');
            assert.strictEqual(step1ExecutionCount, 1);

            const cp = store.getCheckpoint('task_two_steps');
            assert.strictEqual(cp.completedSteps.length, 1);
            assert.strictEqual(cp.completedSteps[0].id, 's1');
            assert.strictEqual(cp.completedSteps[0].verified, true);
            assert.strictEqual(cp.uncertainStep.stepId, 's2');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('6. Reconciliation confirms success -> resolves and completes task', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let remoteResourceCreated = false;
            toolRegistry.registerTool({
                id: 'reconcilable_create',
                name: 'Reconcilable Create',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                timeoutMs: 25,
                handler: async () => {
                    await new Promise((r) => setTimeout(r, 50));
                    remoteResourceCreated = true;
                    return { ok: true, id: 'item_123' };
                },
                reconcile: async () => {
                    if (remoteResourceCreated) {
                        return { resolved: true, status: 'confirmed_success', details: { id: 'item_123', state: 'active' } };
                    }
                    return { resolved: false, status: 'not_found' };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 's_rec', title: 'Create item', toolId: 'reconcilable_create', isConsequential: true, timeoutMs: 20 }]
                    })
                }
            });

            await coordinator.executeRequest('Create item', { taskId: 'task_reconcile_success' });

            // Allow the handler in background to create resource
            await new Promise((r) => setTimeout(r, 60));

            // Call reconcileTask
            const recRes = await coordinator.reconcileTask('task_reconcile_success');
            assert.strictEqual(recRes.ok, true);
            assert.strictEqual(recRes.resolved, true);
            assert.strictEqual(recRes.status, 'confirmed_success');

            const cp = store.getCheckpoint('task_reconcile_success');
            assert.strictEqual(cp.status, TASK_STATUSES.COMPLETED);
            assert.strictEqual(cp.uncertainStep.resolved, true);
            assert.strictEqual(cp.completedSteps.length, 1);
            assert.strictEqual(cp.completedSteps[0].verified, true);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('7. Reconciliation confirms failure with no side effect -> allows safe replay', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let executions = 0;
            toolRegistry.registerTool({
                id: 'payment_tool',
                name: 'Payment Tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => {
                    executions++;
                    if (executions === 1) {
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    return { ok: true, txId: 'tx_999' };
                },
                reconcile: async () => {
                    return {
                        resolved: true,
                        status: 'confirmed_failure',
                        canReplay: true,
                        details: { gatewayStatus: 'NO_RECORD_FOUND' }
                    };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 's_pay', title: 'Pay', toolId: 'payment_tool', isConsequential: true, timeoutMs: 20 }]
                    })
                }
            });

            await coordinator.executeRequest('Pay order', { taskId: 'task_safe_replay' });
            assert.strictEqual(store.getCheckpoint('task_safe_replay').status, TASK_STATUSES.AWAITING_RECONCILIATION);

            // Reconcile confirms failure with safe replay
            const rec = await coordinator.reconcileTask('task_safe_replay');
            assert.strictEqual(rec.resolved, true);
            assert.strictEqual(rec.status, 'confirmed_failure');

            // Inspection should now report resumable (replayable)
            const inspection = store.inspectTaskForResume('task_safe_replay');
            assert.strictEqual(inspection.hasUncertainStep, false);
            assert.strictEqual(inspection.isResumable, true);

            // Wait for previous background handler to settle so resumption is not blocked by active handler
            await new Promise((r) => setTimeout(r, 60));

            // Resume task safely executes step 1
            const resumeRes = await coordinator.resumeTask('task_safe_replay');
            assert.strictEqual(resumeRes.ok, true);
            assert.strictEqual(resumeRes.status, 'completed');
            assert.strictEqual(executions, 2);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('8. Tool has no reconciliation -> remains blocked pending explicit resolution', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'no_rec_tool',
                name: 'No Rec Tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => {
                    await new Promise((r) => setTimeout(r, 50));
                    return { ok: true };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 's_norec', title: 'No Rec Step', toolId: 'no_rec_tool', isConsequential: true, timeoutMs: 20 }]
                    })
                }
            });

            await coordinator.executeRequest('Run norec', { taskId: 'task_norec_1' });

            const rec = await coordinator.reconcileTask('task_norec_1');
            assert.strictEqual(rec.ok, false);
            assert.strictEqual(rec.resolved, false);
            assert.strictEqual(rec.status, 'unsupported');

            const cp = store.getCheckpoint('task_norec_1');
            assert.strictEqual(cp.status, TASK_STATUSES.AWAITING_RECONCILIATION);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('9. Stale handler finishes late after explicit resolution -> dropped, cannot overwrite', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let handlerResolve;
            const handlerPromise = new Promise((resolve) => {
                handlerResolve = resolve;
            });

            toolRegistry.registerTool({
                id: 'late_tool',
                name: 'Late Tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => {
                    await handlerPromise;
                    return { ok: true, sideEffect: 'done_too_late' };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 's_late', title: 'Late Step', toolId: 'late_tool', isConsequential: true, timeoutMs: 20 }]
                    })
                }
            });

            await coordinator.executeRequest('Execute late step', { taskId: 'task_late_handler' });

            // Explicit resolution: user discards the task
            await coordinator.resolveUncertainStep('task_late_handler', {
                stepId: 's_late',
                resolution: 'discard',
                evidence: { userDecision: 'abandoned_by_operator' }
            });

            const cpBefore = store.getCheckpoint('task_late_handler');
            assert.strictEqual(cpBefore.status, TASK_STATUSES.DISCARDED);
            assert.strictEqual(cpBefore.uncertainStep.resolved, true);

            // Now late handler resolves
            handlerResolve();
            await handlerPromise;
            await new Promise((r) => setTimeout(r, 20));

            const cpAfter = store.getCheckpoint('task_late_handler');
            assert.strictEqual(cpAfter.status, TASK_STATUSES.DISCARDED, 'Status must remain DISCARDED');
            assert.strictEqual(cpAfter.completedSteps.length, 0, 'No completed steps added');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('10. Stale handler cannot overwrite terminal state', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let handlerResolve;
            const handlerPromise = new Promise((resolve) => {
                handlerResolve = resolve;
            });

            toolRegistry.registerTool({
                id: 'terminal_tool',
                name: 'Terminal Tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => {
                    await handlerPromise;
                    return { ok: true };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 's_term', title: 'Term', toolId: 'terminal_tool', isConsequential: true, timeoutMs: 20 }]
                    })
                }
            });

            await coordinator.executeRequest('Term test', { taskId: 'task_term_test' });

            // Coordinator marks failed
            await coordinator.resolveUncertainStep('task_term_test', {
                stepId: 's_term',
                resolution: 'confirmed_failure',
                canReplay: false,
                evidence: { error: 'manual_verification_failed' }
            });

            assert.strictEqual(store.getCheckpoint('task_term_test').status, TASK_STATUSES.FAILED);

            // Handler finishes
            handlerResolve();
            await handlerPromise;
            await new Promise((r) => setTimeout(r, 20));

            assert.strictEqual(store.getCheckpoint('task_term_test').status, TASK_STATUSES.FAILED);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('11. Concurrent resolution attempts rejected with CONCURRENCY_CONFLICT', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            store.saveCheckpoint({
                taskId: 'task_concurrent_1',
                userRequest: 'Concurrent test',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 's_c', toolId: 'some_tool', isConsequential: true }] },
                uncertainStep: { stepId: 's_c', index: 1, toolId: 'some_tool', resolved: false }
            });

            const coordinator = new TaskCoordinator({ memoryDir: tempDir, taskContinuityStore: store });

            // Simulate lock in progress
            coordinator.resolutionLocks.add('task_concurrent_1');

            await assert.rejects(
                async () => {
                    await coordinator.resolveUncertainStep('task_concurrent_1', {
                        stepId: 's_c',
                        resolution: 'confirmed_success',
                        evidence: { proof: true }
                    });
                },
                (err) => {
                    assert.strictEqual(err.code, 'CONCURRENCY_CONFLICT');
                    return true;
                }
            );

            coordinator.resolutionLocks.delete('task_concurrent_1');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('12. Malformed, unauthorized, or evidence-free resolution requests rejected', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            store.saveCheckpoint({
                taskId: 'task_invalid_1',
                userRequest: 'Invalid test',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 's_inv', toolId: 'some_tool', isConsequential: true }] },
                uncertainStep: { stepId: 's_inv', index: 1, toolId: 'some_tool', resolved: false }
            });

            const coordinator = new TaskCoordinator({ memoryDir: tempDir, taskContinuityStore: store });

            // Missing evidence
            await assert.rejects(
                async () => await coordinator.resolveUncertainStep('task_invalid_1', { stepId: 's_inv', resolution: 'confirmed_success' }),
                /non-empty verifiable evidence/i
            );

            // Empty object evidence
            await assert.rejects(
                async () => await coordinator.resolveUncertainStep('task_invalid_1', { stepId: 's_inv', resolution: 'confirmed_success', evidence: {} }),
                /non-empty verifiable evidence/i
            );

            // Invalid resolution enum
            await assert.rejects(
                async () => await coordinator.resolveUncertainStep('task_invalid_1', { stepId: 's_inv', resolution: 'magic_fix', evidence: { a: 1 } }),
                /Invalid resolution 'magic_fix'/i
            );

            // Step mismatch
            await assert.rejects(
                async () => await coordinator.resolveUncertainStep('task_invalid_1', { stepId: 'wrong_step', resolution: 'confirmed_success', evidence: { a: 1 } }),
                /Step ID mismatch/i
            );

            // Authorization denial
            const permissionAuthority = new PermissionAuthority({ workspaceRoot: tempDir });
            permissionAuthority.evaluate = async () => ({ permitted: false, reason: 'Operator lacking elevated privilege' });

            const secureCoordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                permissionAuthority
            });

            await assert.rejects(
                async () => await secureCoordinator.resolveUncertainStep('task_invalid_1', {
                    stepId: 's_inv',
                    resolution: 'confirmed_success',
                    evidence: { verified: true }
                }),
                (err) => {
                    assert.strictEqual(err.code, 'PERMISSION_DENIED');
                    return true;
                }
            );
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('13. Process restart preserves all uncertainty and prevents replay (JSON & SQLite)', async () => {
        const tempDir = createTempDir();
        try {
            const sqliteAdapter = new SqliteMemoryAdapter({ memoryDir: tempDir, dbPath: path.join(tempDir, 'lucy.db') });
            await sqliteAdapter.init();

            const store1 = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir, sqliteAdapter });
            store1.saveCheckpoint({
                taskId: 'task_sqlite_uncertain',
                userRequest: 'Database transaction',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 's_db', toolId: 'db_insert', isConsequential: true }] },
                uncertainStep: {
                    stepId: 's_db',
                    index: 1,
                    toolId: 'db_insert',
                    reason: 'Socket timed out during commit',
                    resolved: false
                }
            });

            // Inspect from store1
            const insp1 = store1.inspectTaskForResume('task_sqlite_uncertain');
            assert.strictEqual(insp1.hasUncertainStep, true);

            // Recreate store2 simulating reboot
            const store2 = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir, sqliteAdapter });
            const insp2 = store2.inspectTaskForResume('task_sqlite_uncertain');
            assert.strictEqual(insp2.hasUncertainStep, true);
            assert.strictEqual(insp2.isResumable, false);
            assert.strictEqual(insp2.uncertainStep.stepId, 's_db');

            sqliteAdapter.close();
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('14. Idempotent read-only steps resume normally without blocking uncertainty', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let readAttempts = 0;
            toolRegistry.registerTool({
                id: 'safe_reader',
                name: 'Safe Reader',
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => {
                    readAttempts++;
                    if (readAttempts === 1) {
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    return { ok: true, data: 'file_content' };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                maxRetries: 0,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 's_read', title: 'Read file', toolId: 'safe_reader', timeoutMs: 20 }]
                    })
                }
            });

            const res1 = await coordinator.executeRequest('Read file', { taskId: 'task_read_timeout' });
            assert.strictEqual(res1.ok, false);
            assert.strictEqual(res1.uncertain, false);

            const inspection = store.inspectTaskForResume('task_read_timeout');
            assert.strictEqual(inspection.hasUncertainStep, false);
            assert.strictEqual(inspection.isResumable, true);

            // Wait for previous background handler to settle
            await new Promise((r) => setTimeout(r, 60));

            // Resume successfully executes read-only step
            const resumeRes = await coordinator.resumeTask('task_read_timeout');
            assert.strictEqual(resumeRes.ok, true);
            assert.strictEqual(resumeRes.status, 'completed');
            assert.strictEqual(readAttempts, 2);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('15. Cancellation and timeout leave zero dangling timers or unhandled rejections', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'cancellable_tool',
                name: 'Cancellable Tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async (params, context) => {
                    return new Promise((resolve, reject) => {
                        const timer = setTimeout(() => resolve({ ok: true }), 500);
                        if (context.signal) {
                            context.signal.addEventListener('abort', () => {
                                clearTimeout(timer);
                                reject(new Error('Operation aborted'));
                            });
                        }
                    });
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: store,
                toolRegistry,
                planner: {
                    plan: async () => ({
                        type: 'execution_plan',
                        steps: [{ id: 's_canc', title: 'Cancellable Step', toolId: 'cancellable_tool', isConsequential: true }]
                    })
                }
            });

            const execPromise = coordinator.executeRequest('Cancel me', { taskId: 'task_cancel_clean' });
            await new Promise((r) => setTimeout(r, 20));

            // Cancel active task
            const cancelRes = coordinator.cancelTask('task_cancel_clean', 'User abort');
            assert.strictEqual(cancelRes.ok, true);

            const outcome = await execPromise;
            assert.strictEqual(outcome.ok, false);
            assert.strictEqual(outcome.status, 'cancelled');

            // Confirm active tasks map is clean
            assert.strictEqual(coordinator.activeTasks.size, 0);
        } finally {
            cleanTempDir(tempDir);
        }
    });
});
