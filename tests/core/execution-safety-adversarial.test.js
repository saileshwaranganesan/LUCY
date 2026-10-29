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

function createTempDir(prefix = 'lucy-adversarial-test-') {
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

test.describe('Execution Safety: Adversarial Verification & Trust Boundaries', () => {

    // =========================================================================
    // 1. RECONCILIATION TRUST BOUNDARY
    // =========================================================================

    test('1.1 Malformed or arbitrary reconciliation status is rejected fail-closed and does NOT default to confirmed_success', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            // Adversarial tool returns non-standard status with resolved: true
            toolRegistry.registerTool({
                id: 'adversarial_tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => ({ ok: true }),
                reconcile: async () => ({
                    resolved: true,
                    status: 'arbitrary_bypass_status',
                    details: { bypass: true }
                })
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            // Set up task in awaiting_reconciliation
            continuityStore.saveCheckpoint({
                taskId: 'task_adv_1',
                userRequest: 'Run adversarial action',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'adversarial_tool', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'adversarial_tool',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            const recResult = await coordinator.reconcileTask('task_adv_1');

            // Must NOT resolve or treat as confirmed_success!
            assert.strictEqual(recResult.resolved, false, 'Malformed status must NOT be resolved');
            assert.notStrictEqual(recResult.status, 'confirmed_success', 'Must not default to confirmed_success');

            const cp = continuityStore.getCheckpoint('task_adv_1');
            assert.strictEqual(cp.uncertainStep.resolved, false, 'Uncertain step must remain unresolved');
            assert.strictEqual(cp.status, TASK_STATUSES.AWAITING_RECONCILIATION);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('1.2 confirmed_failure with canReplay: true requires explicit verification of NO side effect', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            // Adversarial tool claims canReplay: true but does NOT establish sideEffectOccurred: false
            toolRegistry.registerTool({
                id: 'unverified_replay_tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => ({ ok: true }),
                reconcile: async () => ({
                    resolved: true,
                    status: 'confirmed_failure',
                    canReplay: true,
                    // sideEffectOccurred missing or undefined
                    details: { reason: 'Network timeout happened' }
                })
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_adv_2',
                userRequest: 'Consequential action',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'unverified_replay_tool', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'unverified_replay_tool',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            const outcome = await toolRegistry.reconcile('unverified_replay_tool', {}, {});
            // Tool registry must force canReplay: false when sideEffectOccurred is not explicitly false
            assert.strictEqual(outcome.canReplay, false, 'canReplay must be rejected without proof of no side effect');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('1.3 Reconciliation runtime errors preserve uncertainty and never trigger replay', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'crashing_reconcile_tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => ({ ok: true }),
                reconcile: async () => {
                    throw new Error('Remote reconciliation probe socket hung up');
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_adv_3',
                userRequest: 'Payment action',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'crashing_reconcile_tool', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'crashing_reconcile_tool',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            const recResult = await coordinator.reconcileTask('task_adv_3');
            assert.strictEqual(recResult.ok, false);
            assert.strictEqual(recResult.resolved, false);

            // Resumption must still be blocked
            const resumeResult = await coordinator.resumeTask('task_adv_3');
            assert.strictEqual(resumeResult.ok, false);
            assert.strictEqual(resumeResult.status, 'uncertain_outcome_blocked');

            const cp = continuityStore.getCheckpoint('task_adv_3');
            assert.strictEqual(cp.uncertainStep.resolved, false);
            assert.strictEqual(cp.status, TASK_STATUSES.AWAITING_RECONCILIATION);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // =========================================================================
    // 2. RESOLUTION AUTHORIZATION AND EVIDENCE
    // =========================================================================

    test('2.1 Untrusted caller cannot bypass coordinator authorization via injected authority', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            // Coordinator configured with real strict permission authority that denies without confirmation
            const strictAuthority = new PermissionAuthority();
            strictAuthority.setConfirmationHandler(async () => false); // Always denies

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                permissionAuthority: strictAuthority,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_adv_auth',
                userRequest: 'Sensitive task',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'tool_1', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            // Adversarial caller passes fake permissive permissionAuthority in options
            const fakeAuthority = {
                evaluate: async () => ({ permitted: true, reason: 'Bypass' })
            };

            await assert.rejects(
                async () => {
                    await coordinator.resolveUncertainStep(
                        'task_adv_auth',
                        {
                            stepId: 'step_1',
                            resolution: 'confirmed_success',
                            evidence: { manualAuditId: 'audit-123', justification: 'Verified by human operator' }
                        },
                        { permissionAuthority: fakeAuthority } // Injected bypass attempt
                    );
                },
                (err) => err.code === 'PERMISSION_DENIED',
                'Must reject resolution using coordinator authoritative permission authority'
            );
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('2.2 Meaningless, whitespace, empty, or short dummy evidence is rejected', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            const permissiveAuthority = new PermissionAuthority();
            permissiveAuthority.setConfirmationHandler(async () => true);

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                permissionAuthority: permissiveAuthority,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_adv_evid',
                userRequest: 'Task',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'tool_1', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            const invalidEvidences = [
                '',
                '   ',
                'ok',
                'done',
                [],
                {},
                { details: '' },
                { justification: '   ' }
            ];

            for (const badEvidence of invalidEvidences) {
                await assert.rejects(
                    async () => {
                        await coordinator.resolveUncertainStep('task_adv_evid', {
                            stepId: 'step_1',
                            resolution: 'confirmed_success',
                            evidence: badEvidence
                        });
                    },
                    (err) => err.message.includes('evidence') || err.message.includes('justification'),
                    `Evidence ${JSON.stringify(badEvidence)} must be rejected`
                );
            }
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('2.3 Resolution evidence with embedded secrets is scrubbed before checkpoint persistence', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            const permissiveAuthority = new PermissionAuthority();
            permissiveAuthority.setConfirmationHandler(async () => true);

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                permissionAuthority: permissiveAuthority,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_adv_scrub',
                userRequest: 'Task with sensitive data',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'tool_1', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            const receipt = await coordinator.resolveUncertainStep('task_adv_scrub', {
                stepId: 'step_1',
                resolution: 'confirmed_success',
                evidence: {
                    justification: 'Confirmed external transaction on gateway with token sk-ant-api03-abcdef1234567890abcdef',
                    authHeader: 'Bearer secret_access_token_xyz_123',
                    apiKey: 'AIzaSyA1234567890123456789012345678901'
                }
            });

            // Receipt and stored checkpoint must not contain raw secrets
            const receiptStr = JSON.stringify(receipt);
            assert.ok(!receiptStr.includes('sk-ant-api03-abcdef1234567890abcdef'), 'Must redact API key');
            assert.ok(!receiptStr.includes('secret_access_token_xyz_123'), 'Must redact bearer token');
            assert.ok(!receiptStr.includes('AIzaSyA1234567890123456789012345678901'), 'Must redact Google API key');

            const cp = continuityStore.getCheckpoint('task_adv_scrub');
            const cpStr = JSON.stringify(cp);
            assert.ok(!cpStr.includes('sk-ant-api03-abcdef1234567890abcdef'), 'Checkpoint must not leak secret');
            assert.ok(!cpStr.includes('secret_access_token_xyz_123'), 'Checkpoint must not leak bearer token');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('2.4 Resolving uncertain step on a CANCELLED task cannot resurrect it to COMPLETED or INTERRUPTED', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            const permissiveAuthority = new PermissionAuthority();
            permissiveAuthority.setConfirmationHandler(async () => true);

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                permissionAuthority: permissiveAuthority,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            // Task was cancelled by user
            continuityStore.saveCheckpoint({
                taskId: 'task_cancelled_res',
                userRequest: 'Cancelled task',
                status: TASK_STATUSES.CANCELLED,
                plan: { steps: [{ id: 'step_1', toolId: 'tool_1', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            await coordinator.resolveUncertainStep('task_cancelled_res', {
                stepId: 'step_1',
                resolution: 'confirmed_success',
                evidence: { justification: 'Side effect verified independently after cancellation' }
            });

            const cp = continuityStore.getCheckpoint('task_cancelled_res');
            // Must remain CANCELLED! Must NOT become COMPLETED or INTERRUPTED!
            assert.strictEqual(cp.status, TASK_STATUSES.CANCELLED, 'Cancelled task must remain cancelled');
            assert.strictEqual(cp.uncertainStep.resolved, true, 'Uncertain step can be marked resolved for audit');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // =========================================================================
    // 3. JSON/SQLITE CRASH CONSISTENCY
    // =========================================================================

    test('3.1 Startup reconciliation prefers store with unresolved uncertainStep fail-closed', async () => {
        const tempDir = createTempDir();
        try {
            // Setup SQLite store
            const adapter = new SqliteMemoryAdapter({ dbPath: path.join(tempDir, 'lucy-memory.db') });
            await adapter.init();

            // Scenario: SQLite has a newer checkpoint with an unresolved uncertainStep (awaiting_reconciliation),
            // while JSON file has an older checkpoint without uncertainStep (e.g. interruption happened before JSON write).
            adapter.saveTaskCheckpoint({
                taskId: 'task_split_1',
                objective: 'Execute high-value action',
                status: 'awaiting_reconciliation',
                currentStepIndex: 1,
                totalSteps: 2,
                steps: [
                    { id: 'step_1', toolId: 'action_1', isConsequential: true },
                    { id: 'step_2', toolId: 'action_2', isConsequential: false }
                ],
                resumptionState: {
                    completedSteps: [],
                    uncertainStep: {
                        stepId: 'step_1',
                        toolId: 'action_1',
                        resolved: false,
                        attempt: 1,
                        params: {}
                    },
                    resolutions: []
                },
                createdAt: new Date(Date.now() - 5000).toISOString()
            });

            // JSON store has older checkpoint (in_progress, no uncertainStep)
            const jsonStoreFile = path.join(tempDir, 'task-checkpoints.json');
            fs.writeFileSync(jsonStoreFile, JSON.stringify({
                version: 1,
                updatedAt: new Date(Date.now() - 10000).toISOString(),
                tasks: {
                    task_split_1: {
                        taskId: 'task_split_1',
                        userRequest: 'Execute high-value action',
                        plan: { steps: [{ id: 'step_1', toolId: 'action_1', isConsequential: true }] },
                        totalSteps: 2,
                        currentStepIndex: 0,
                        completedSteps: [],
                        status: 'in_progress',
                        uncertainStep: null,
                        createdAt: new Date(Date.now() - 10000).toISOString(),
                        updatedAt: new Date(Date.now() - 10000).toISOString()
                    }
                }
            }, null, 2));

            // Fresh store loads with both JSON and SQLite adapter
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            store.setSqliteAdapter(adapter);
            store.load();

            const cp = store.getCheckpoint('task_split_1');
            assert.ok(cp, 'Task must exist');
            assert.strictEqual(cp.status, TASK_STATUSES.AWAITING_RECONCILIATION, 'Must choose awaiting_reconciliation state');
            assert.ok(cp.uncertainStep, 'Must preserve uncertainStep');
            assert.strictEqual(cp.uncertainStep.resolved, false, 'Uncertain step must be unresolved');

            // Inspection must block resume fail-closed
            const inspection = store.inspectTaskForResume('task_split_1');
            assert.strictEqual(inspection.isResumable, false, 'Must block resumption');
            assert.strictEqual(inspection.hasUncertainStep, true);

            await adapter.close();
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('3.2 SQLite write failure does not corrupt JSON checkpoint or lose in-memory task state', async () => {
        const tempDir = createTempDir();
        try {
            const store = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });

            // Mock adapter that throws on write
            const brokenAdapter = {
                initialized: true,
                saveTaskCheckpoint: () => {
                    throw new Error('Disk I/O error on SQLite transaction');
                },
                getTaskCheckpoints: () => []
            };

            store.setSqliteAdapter(brokenAdapter);

            // Saving checkpoint should succeed in JSON even when SQLite throws
            const cp = store.saveCheckpoint({
                taskId: 'task_sqlite_fail',
                userRequest: 'Perform action',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: false
                }
            });

            assert.ok(cp, 'Checkpoint must be saved');
            assert.strictEqual(store.getCheckpoint('task_sqlite_fail').status, TASK_STATUSES.AWAITING_RECONCILIATION);

            // Re-read directly from JSON file on disk
            const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'task-checkpoints.json'), 'utf8'));
            assert.ok(onDisk.tasks.task_sqlite_fail, 'Must exist in JSON on disk');
            assert.strictEqual(onDisk.tasks.task_sqlite_fail.status, TASK_STATUSES.AWAITING_RECONCILIATION);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // =========================================================================
    // 4. STALE WRITES AND CONCURRENCY
    // =========================================================================

    test('4.1 Concurrent resolution requests for the same task reject with CONCURRENCY_CONFLICT', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let pauseResolve;
            const pausePromise = new Promise((resolve) => {
                pauseResolve = resolve;
            });

            const authority = new PermissionAuthority();
            authority.setConfirmationHandler(async () => {
                await pausePromise;
                return true;
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                permissionAuthority: authority,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_race_res',
                userRequest: 'Action',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'tool_1', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            // Launch first resolution (awaits confirmation)
            const firstResPromise = coordinator.resolveUncertainStep('task_race_res', {
                stepId: 'step_1',
                resolution: 'confirmed_success',
                evidence: { justification: 'First attempt verified by auditor 1' }
            });

            // Immediately launch concurrent resolution while first is in-flight
            await assert.rejects(
                async () => {
                    await coordinator.resolveUncertainStep('task_race_res', {
                        stepId: 'step_1',
                        resolution: 'confirmed_failure',
                        evidence: { justification: 'Conflicting concurrent claim from auditor 2' }
                    });
                },
                (err) => err.code === 'CONCURRENCY_CONFLICT',
                'Second concurrent resolution must reject with CONCURRENCY_CONFLICT'
            );

            // Unblock first resolution
            pauseResolve();
            const firstReceipt = await firstResPromise;
            assert.strictEqual(firstReceipt.resolution, 'confirmed_success');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('4.2 Concurrent resume requests through different entry points reject with DuplicateTaskExecutionError', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let unblockReconcile;
            const pauseReconcile = new Promise((resolve) => {
                unblockReconcile = resolve;
            });

            toolRegistry.registerTool({
                id: 'slow_reconcile_tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => ({ ok: true }),
                reconcile: async () => {
                    await pauseReconcile;
                    return {
                        resolved: true,
                        status: 'confirmed_success',
                        details: { sideEffectOccurred: true }
                    };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_race_resume',
                userRequest: 'Action',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: {
                    steps: [
                        { id: 'step_1', toolId: 'slow_reconcile_tool', isConsequential: true },
                        { id: 'step_2', toolId: 'slow_reconcile_tool', isConsequential: false }
                    ]
                },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'slow_reconcile_tool',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            // Entry point 1: coordinator.resumeTask()
            const firstResume = coordinator.resumeTask('task_race_resume');

            // Entry point 2: continuityStore.resumeTask() concurrent while first is in-flight
            await assert.rejects(
                async () => {
                    await continuityStore.resumeTask('task_race_resume', coordinator);
                },
                (err) => err.name === 'DuplicateTaskExecutionError' || err.message.includes('already actively executing') || err.message.includes('DuplicateTaskExecutionError'),
                'Concurrent resume must be rejected immediately'
            );

            unblockReconcile();
            await firstResume;
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('4.3 Stale checkpoint update cannot regress resolved step to unresolved or drop verified steps', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });

            // 1. Task has resolved step
            continuityStore.saveCheckpoint({
                taskId: 'task_stale_update',
                userRequest: 'Multi-step task',
                status: TASK_STATUSES.COMPLETED,
                completedSteps: [
                    { id: 'step_1', verified: true },
                    { id: 'step_2', verified: true }
                ],
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: true,
                    resolution: 'confirmed_success'
                },
                resolutions: [{ stepId: 'step_1', resolution: 'confirmed_success' }]
            });

            // 2. A stale caller attempts to write an older checkpoint with unresolved uncertainStep and 0 completed steps
            continuityStore.saveCheckpoint({
                taskId: 'task_stale_update',
                userRequest: 'Multi-step task',
                status: TASK_STATUSES.IN_PROGRESS,
                completedSteps: [],
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'tool_1',
                    resolved: false
                }
            });

            const cp = continuityStore.getCheckpoint('task_stale_update');
            assert.strictEqual(cp.uncertainStep.resolved, true, 'Resolved uncertainStep must NOT regress to unresolved');
            assert.strictEqual(cp.completedSteps.length, 2, 'Verified completed steps must NOT be erased by stale write');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    test('4.4 Cancellation while reconciliation is in flight preserves CANCELLED status', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let pauseRec;
            const recPromise = new Promise((resolve) => {
                pauseRec = resolve;
            });

            toolRegistry.registerTool({
                id: 'in_flight_rec_tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => ({ ok: true }),
                reconcile: async () => {
                    await recPromise;
                    return {
                        resolved: true,
                        status: 'confirmed_success',
                        details: { sideEffectOccurred: true }
                    };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                planner: { plan: async () => ({ type: 'execution_plan', steps: [] }) }
            });

            continuityStore.saveCheckpoint({
                taskId: 'task_cancel_rec',
                userRequest: 'Action',
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                plan: { steps: [{ id: 'step_1', toolId: 'in_flight_rec_tool', isConsequential: true }] },
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'in_flight_rec_tool',
                    resolved: false,
                    attempt: 1,
                    params: {}
                }
            });

            // Start reconcileTask
            const reconcilePromise = coordinator.reconcileTask('task_cancel_rec');

            // While reconciliation is in-flight, cancel task
            coordinator.cancelTask('task_cancel_rec', 'User cancelled during reconciliation');

            // Release reconciliation
            pauseRec();
            await reconcilePromise;

            const cp = continuityStore.getCheckpoint('task_cancel_rec');
            assert.strictEqual(cp.status, TASK_STATUSES.CANCELLED, 'Status must remain CANCELLED');
        } finally {
            cleanTempDir(tempDir);
        }
    });
});
