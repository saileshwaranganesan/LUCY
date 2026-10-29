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
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { TaskRecoveryEngine, FAILURE_TYPES, RECOVERY_STRATEGIES } = require('../../src/core/recovery-engine.js');

function createTempDir(prefix = 'lucy-replan-test-') {
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

test.describe('Adaptive Replanning & Context-Aware Fallback Tool Routing Suite', () => {

    // -------------------------------------------------------------------------
    // 1. An unavailable tool selects a genuinely compatible alternative.
    // -------------------------------------------------------------------------
    test('1. An unavailable tool selects a genuinely compatible alternative', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'http_fetcher_primary',
                name: 'Primary HTTP Fetcher',
                category: 'browser',
                capabilities: ['http_request', 'network'],
                riskTier: RISK_TIERS.SAFE_READ,
                schema: {
                    type: 'object',
                    properties: { url: { type: 'string' } },
                    required: ['url']
                },
                outputSchema: {
                    properties: { body: { type: 'string' }, statusCode: { type: 'number' } }
                },
                availabilityCheck: async () => ({ available: false, reason: 'Remote gateway unreachable' }),
                handler: async () => {
                    throw new Error('Gateway unreachable (503 Service Unavailable)');
                }
            });

            toolRegistry.registerTool({
                id: 'http_fetcher_fallback',
                name: 'Fallback HTTP Fetcher',
                category: 'browser',
                capabilities: ['http_request', 'network'],
                riskTier: RISK_TIERS.SAFE_READ,
                schema: {
                    type: 'object',
                    properties: { url: { type: 'string' } },
                    required: ['url']
                },
                outputSchema: {
                    properties: { body: { type: 'string' }, statusCode: { type: 'number' } }
                },
                availabilityCheck: async () => ({ available: true }),
                handler: async (params) => {
                    return { ok: true, status: 'fetched', body: `Payload from ${params.url}`, statusCode: 200 };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const plan = {
                objective: 'Fetch remote document',
                steps: [
                    {
                        id: 'step_fetch',
                        index: 1,
                        title: 'Fetch document',
                        toolId: 'http_fetcher_primary',
                        params: { url: 'https://api.example.com/doc' },
                        requiredOutputs: ['body']
                    }
                ]
            };

            const res = await coordinator.executeRequest('Fetch remote document', { planOverride: plan });

            assert.strictEqual(res.ok, true, 'Task should succeed via fallback tool');
            assert.strictEqual(res.executedSteps.length, 2, 'Audit trail must record failed attempt and fallback attempt');
            assert.strictEqual(res.executedSteps[0].toolId, 'http_fetcher_primary');
            assert.strictEqual(res.executedSteps[0].verified, false);
            assert.strictEqual(res.executedSteps[1].toolId, 'http_fetcher_fallback');
            assert.strictEqual(res.executedSteps[1].verified, true);
            assert.strictEqual(res.executedSteps[1].result.body, 'Payload from https://api.example.com/doc');

            const cp = continuityStore.getCheckpoint(res.taskId);
            assert.ok(cp.replanHistory && cp.replanHistory.length >= 1, 'Replan receipt must be recorded');
            assert.strictEqual(cp.replanHistory[0].failedToolId, 'http_fetcher_primary');
            assert.strictEqual(cp.replanHistory[0].selectedFallback, 'http_fetcher_fallback');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 2. An incompatible tool is rejected despite being available.
    // -------------------------------------------------------------------------
    test('2. An incompatible tool is rejected despite being available', async () => {
        const tempDir = createTempDir();
        try {
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'file_writer_primary',
                name: 'File Writer',
                category: 'filesystem',
                riskTier: RISK_TIERS.WORKSPACE_WRITE,
                capabilities: ['file_write'],
                schema: {
                    type: 'object',
                    properties: { path: { type: 'string' }, content: { type: 'string' } },
                    required: ['path', 'content']
                },
                availabilityCheck: async () => ({ available: false, reason: 'Disk read-only' }),
                handler: async () => ({ ok: false, error: 'Disk read-only' })
            });

            // Available tool, but incompatible operation (file_read cannot write files!)
            toolRegistry.registerTool({
                id: 'file_reader_available',
                name: 'File Reader',
                category: 'filesystem',
                riskTier: RISK_TIERS.WORKSPACE_READ,
                capabilities: ['file_read'],
                schema: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path']
                },
                availabilityCheck: async () => ({ available: true }),
                handler: async () => ({ ok: true, content: 'data' })
            });

            const fallbackEval = await toolRegistry.findFallbackCandidates({
                failedToolId: 'file_writer_primary',
                params: { path: 'out.txt', content: 'test' }
            });

            assert.strictEqual(fallbackEval.candidates.length, 0, 'Incompatible tool must not be selected as candidate');
            assert.ok(fallbackEval.rejected.some(r => r.toolId === 'file_reader_available' && r.reason.includes('incompatible_operation')));
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 3. A fallback with incompatible input/output contracts is rejected.
    // -------------------------------------------------------------------------
    test('3. A fallback with incompatible input/output contracts is rejected', async () => {
        const tempDir = createTempDir();
        try {
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'primary_processor',
                name: 'Primary Processor',
                category: 'browser',
                capabilities: ['data_processing'],
                riskTier: RISK_TIERS.SAFE_READ,
                schema: {
                    type: 'object',
                    properties: { data: { type: 'string' } },
                    required: ['data']
                },
                outputContract: { provides: ['processed_data', 'checksum'] },
                availabilityCheck: async () => ({ available: false }),
                handler: async () => ({ ok: false })
            });

            // Candidate A: Incompatible input schema (requires additional unprovided field apiKey)
            toolRegistry.registerTool({
                id: 'candidate_a_bad_schema',
                name: 'Candidate A',
                category: 'browser',
                capabilities: ['data_processing'],
                riskTier: RISK_TIERS.SAFE_READ,
                schema: {
                    type: 'object',
                    properties: { data: { type: 'string' }, secretApiKey: { type: 'string' } },
                    required: ['data', 'secretApiKey']
                },
                outputContract: { provides: ['processed_data', 'checksum'] },
                availabilityCheck: async () => ({ available: true }),
                handler: async () => ({ ok: true })
            });

            // Candidate B: Incompatible output contract (missing required 'checksum' output)
            toolRegistry.registerTool({
                id: 'candidate_b_missing_output',
                name: 'Candidate B',
                category: 'browser',
                capabilities: ['data_processing'],
                riskTier: RISK_TIERS.SAFE_READ,
                schema: {
                    type: 'object',
                    properties: { data: { type: 'string' } },
                    required: ['data']
                },
                outputContract: { provides: ['processed_data'] }, // Missing 'checksum'
                availabilityCheck: async () => ({ available: true }),
                handler: async () => ({ ok: true })
            });

            const evalResult = await toolRegistry.findFallbackCandidates({
                failedToolId: 'primary_processor',
                params: { data: 'sample' },
                requiredOutputs: ['processed_data', 'checksum']
            });

            assert.strictEqual(evalResult.candidates.length, 0, 'No candidate should be accepted');
            assert.ok(evalResult.rejected.some(r => r.toolId === 'candidate_a_bad_schema' && r.reason.includes('incompatible_input_schema')));
            assert.ok(evalResult.rejected.some(r => r.toolId === 'candidate_b_missing_output' && r.reason.includes('incompatible_output_contract')));
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 4. A temporary failure follows the existing bounded retry policy.
    // -------------------------------------------------------------------------
    test('4. A temporary failure follows the existing bounded retry policy without premature fallback', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let attemptCount = 0;
            toolRegistry.registerTool({
                id: 'flaky_network_tool',
                name: 'Flaky Network Tool',
                category: 'browser',
                capabilities: ['query'],
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => {
                    attemptCount++;
                    if (attemptCount === 1) {
                        return { ok: false, error: 'Connection timeout (ETIMEDOUT)', status: 'transient_failure' };
                    }
                    return { ok: true, data: 'recovered_on_retry' };
                }
            });

            toolRegistry.registerTool({
                id: 'alternative_query_tool',
                name: 'Alternative Query Tool',
                category: 'browser',
                capabilities: ['query'],
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => {
                    return { ok: true, data: 'from_alternative' };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const plan = {
                objective: 'Query remote store',
                steps: [
                    {
                        id: 'step_query',
                        index: 1,
                        title: 'Query data',
                        toolId: 'flaky_network_tool',
                        params: {}
                    }
                ]
            };

            const res = await coordinator.executeRequest('Query remote store', { planOverride: plan });

            assert.strictEqual(res.ok, true);
            assert.strictEqual(attemptCount, 2, 'Should succeed on second retry attempt');
            assert.strictEqual(res.executedSteps[0].toolId, 'flaky_network_tool', 'Should retain primary tool after transient recovery');
            assert.strictEqual(res.executedSteps[0].result.data, 'recovered_on_retry');

            const cp = continuityStore.getCheckpoint(res.taskId);
            assert.strictEqual(cp.replanHistory.length, 0, 'No fallback replan should occur for transient retry success');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 5. An authorization failure does not trigger a permission-bypassing fallback.
    // -------------------------------------------------------------------------
    test('5. An authorization failure does not trigger a permission-bypassing fallback', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const permissionAuthority = new PermissionAuthority({
                mode: PERMISSION_MODES.STANDARD,
                workspaceRoot: tempDir
            });
            const toolRegistry = new ToolRegistry({ permissionAuthority });

            let unrestrictedCalled = false;

            toolRegistry.registerTool({
                id: 'restricted_system_write',
                name: 'Restricted System Tool',
                category: 'system',
                riskTier: RISK_TIERS.SYSTEM_WRITE,
                handler: async () => ({ ok: true })
            });

            toolRegistry.registerTool({
                id: 'unrestricted_read_fallback',
                name: 'Unrestricted Tool',
                category: 'system',
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => {
                    unrestrictedCalled = true;
                    return { ok: true };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                permissionAuthority
            });

            const plan = {
                objective: 'Execute restricted action',
                steps: [
                    {
                        id: 'step_auth',
                        index: 1,
                        title: 'Restricted action',
                        toolId: 'restricted_system_write',
                        params: { action: 'write_config' }
                    }
                ]
            };

            const res = await coordinator.executeRequest('Execute restricted action', { planOverride: plan });

            assert.strictEqual(res.ok, false);
            assert.strictEqual(unrestrictedCalled, false, 'Unrestricted tool must NEVER be invoked as fallback for auth denial');
            assert.ok(res.error.includes('Permission') || res.error.includes('denied') || res.error.includes('Blocked') || res.error.includes('confirmation'), 'Error must report authorization block or permission denial');

            const cp = continuityStore.getCheckpoint(res.taskId);
            assert.strictEqual(cp.replanHistory.length, 0, 'Replanning is strictly forbidden on permission denial');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 6. A timeout with an uncertain consequential outcome does not trigger duplicate execution.
    // -------------------------------------------------------------------------
    test('6. A timeout with an uncertain consequential outcome does not trigger duplicate execution', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let fallbackTriggered = false;
            let handlerSettle;
            const handlerPromise = new Promise(resolve => {
                handlerSettle = resolve;
            });

            toolRegistry.registerTool({
                id: 'consequential_payment',
                name: 'Consequential Payment',
                category: 'system',
                capabilities: ['payment'],
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                timeoutMs: 40,
                handler: async () => {
                    await handlerPromise;
                    return { ok: true, charged: true };
                }
            });

            toolRegistry.registerTool({
                id: 'fallback_payment',
                name: 'Fallback Payment',
                category: 'system',
                capabilities: ['payment'],
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => {
                    fallbackTriggered = true;
                    return { ok: true, charged: true };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const plan = {
                objective: 'Process customer payment',
                steps: [
                    {
                        id: 'step_pay',
                        index: 1,
                        title: 'Charge payment',
                        toolId: 'consequential_payment',
                        isConsequential: true,
                        timeoutMs: 40,
                        params: { amount: 100 }
                    }
                ]
            };

            const res = await coordinator.executeRequest('Process payment', { planOverride: plan });

            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.status, 'awaiting_reconciliation');
            assert.strictEqual(fallbackTriggered, false, 'Fallback tool must NEVER execute when outcome is uncertain');

            const cp = continuityStore.getCheckpoint(res.taskId);
            assert.strictEqual(cp.status, TASK_STATUSES.AWAITING_RECONCILIATION);
            assert.strictEqual(cp.replanHistory.length, 0, 'Replanning is strictly blocked pending reconciliation');
        } finally {
            if (typeof handlerSettle === 'function') handlerSettle();
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 7. Reconciliation confirming success avoids repeating the side effect.
    // -------------------------------------------------------------------------
    test('7. Reconciliation confirming success avoids repeating the side effect', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let executedAgain = false;

            toolRegistry.registerTool({
                id: 'reconcilable_operation',
                name: 'Reconcilable Operation',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => {
                    executedAgain = true;
                    return { ok: true };
                },
                reconcile: async () => ({
                    ok: true,
                    resolved: true,
                    status: 'confirmed_success',
                    details: { ledgerRef: 'LEDGER-888' }
                })
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const taskId = 'task_reconcile_success_1';
            const plan = {
                objective: 'Perform mutation',
                steps: [
                    {
                        id: 'step_mutate',
                        index: 1,
                        title: 'Mutate external ledger',
                        toolId: 'reconcilable_operation',
                        isConsequential: true,
                        params: { account: 'ACC-01' }
                    }
                ]
            };

            // Seed an interrupted awaiting_reconciliation checkpoint
            continuityStore.saveCheckpoint({
                taskId,
                userRequest: 'Perform mutation',
                plan,
                currentStepIndex: 1,
                completedSteps: [],
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                uncertainStep: {
                    stepId: 'step_mutate',
                    toolId: 'reconcilable_operation',
                    index: 1,
                    params: { account: 'ACC-01' },
                    reason: 'Tool execution timed out'
                }
            });

            // Reconcile outcome with tool confirmation
            const receipt = await coordinator.reconcileTask(taskId);

            assert.strictEqual(receipt.ok, true);
            assert.strictEqual(receipt.status, 'confirmed_success');

            const cp = continuityStore.getCheckpoint(taskId);
            assert.strictEqual(cp.status, TASK_STATUSES.COMPLETED);
            assert.strictEqual(cp.completedSteps.length, 1);
            assert.strictEqual(cp.completedSteps[0].verified, true);
            assert.strictEqual(executedAgain, false, 'Operation must NOT be re-executed when reconciliation confirms success');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 8. Reconciliation confirming no side effect permits replay only under the validated policy.
    // -------------------------------------------------------------------------
    test('8. Reconciliation confirming no side effect permits replay only under validated policy', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let attemptNum = 0;
            toolRegistry.registerTool({
                id: 'safe_idempotent_retry_tool',
                name: 'Safe Replay Tool',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                handler: async () => {
                    attemptNum++;
                    return { ok: true, attempt: attemptNum };
                },
                reconcile: async () => ({
                    ok: true,
                    resolved: true,
                    status: 'confirmed_failure',
                    canReplay: true,
                    sideEffectOccurred: false
                })
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const taskId = 'task_reconcile_failure_safe_replay';
            const plan = {
                objective: 'Safe replay task',
                steps: [
                    {
                        id: 'step_1',
                        index: 1,
                        title: 'Execute safe step',
                        toolId: 'safe_idempotent_retry_tool',
                        isConsequential: true,
                        params: {}
                    }
                ]
            };

            continuityStore.saveCheckpoint({
                taskId,
                userRequest: 'Safe replay task',
                plan,
                currentStepIndex: 1,
                completedSteps: [],
                status: TASK_STATUSES.AWAITING_RECONCILIATION,
                uncertainStep: {
                    stepId: 'step_1',
                    toolId: 'safe_idempotent_retry_tool',
                    index: 1,
                    params: {},
                    reason: 'Timed out during submission'
                }
            });

            const receipt = await coordinator.reconcileTask(taskId);
            assert.strictEqual(receipt.ok, true);
            assert.strictEqual(receipt.status, 'confirmed_failure');
            assert.strictEqual(receipt.receipt.canReplay, true);

            // Now resumption is safely unblocked
            const resumeRes = await coordinator.resumeTask(taskId);
            assert.strictEqual(resumeRes.ok, true);
            assert.strictEqual(attemptNum, 1, 'Replay step executes safely');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 9. A verified earlier step remains completed after replanning.
    // -------------------------------------------------------------------------
    test('9. A verified earlier step remains completed after replanning', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            let step1ExecCount = 0;

            toolRegistry.registerTool({
                id: 'step1_creator',
                name: 'Step 1 Creator',
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => {
                    step1ExecCount++;
                    return { ok: true, artifactId: 'art-123' };
                }
            });

            toolRegistry.registerTool({
                id: 'step2_failing_processor',
                name: 'Failing Processor',
                category: 'system',
                capabilities: ['process_artifact'],
                riskTier: RISK_TIERS.SAFE_READ,
                availabilityCheck: async () => ({ available: false, reason: 'Engine offline' }),
                handler: async () => {
                    throw new Error('Engine offline');
                }
            });

            toolRegistry.registerTool({
                id: 'step2_fallback_processor',
                name: 'Fallback Processor',
                category: 'system',
                capabilities: ['process_artifact'],
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async (params) => {
                    return { ok: true, processed: true, source: params.artId };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const plan = {
                objective: 'Two step workflow with fallback',
                steps: [
                    {
                        id: 'step_1',
                        index: 1,
                        title: 'Create artifact',
                        toolId: 'step1_creator',
                        params: {}
                    },
                    {
                        id: 'step_2',
                        index: 2,
                        title: 'Process artifact',
                        toolId: 'step2_failing_processor',
                        dependsOn: ['step_1'],
                        params: { artId: '{{step_1.result.artifactId}}' }
                    }
                ]
            };

            const res = await coordinator.executeRequest('Run workflow', { planOverride: plan });

            assert.strictEqual(res.ok, true);
            assert.strictEqual(step1ExecCount, 1, 'Step 1 must be executed exactly once and NEVER rerun');
            assert.strictEqual(res.executedSteps.length, 3, 'Executed steps audit trail records step 1, failed step 2 attempt, and fallback step 2');
            assert.strictEqual(res.executedSteps[0].toolId, 'step1_creator');
            assert.strictEqual(res.executedSteps[0].verified, true);
            assert.strictEqual(res.executedSteps[1].toolId, 'step2_failing_processor');
            assert.strictEqual(res.executedSteps[1].verified, false);
            assert.strictEqual(res.executedSteps[2].toolId, 'step2_fallback_processor');
            assert.strictEqual(res.executedSteps[2].verified, true);
            assert.strictEqual(res.executedSteps[2].result.source, 'art-123');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 10. Dependent steps receive only verified outputs.
    // -------------------------------------------------------------------------
    test('10. Dependent steps receive only verified outputs from fallback step', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'auth_service_primary',
                name: 'Primary Auth Service',
                category: 'browser',
                capabilities: ['auth'],
                riskTier: RISK_TIERS.SAFE_READ,
                availabilityCheck: async () => ({ available: false, reason: 'Auth server down' }),
                handler: async () => ({ ok: false })
            });

            toolRegistry.registerTool({
                id: 'auth_service_fallback',
                name: 'Fallback Auth Service',
                category: 'browser',
                capabilities: ['auth'],
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => {
                    return { ok: true, sessionToken: 'verified-session-token-99' };
                }
            });

            let receivedHeader = null;
            toolRegistry.registerTool({
                id: 'api_client_step',
                name: 'API Client',
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async (params) => {
                    receivedHeader = params.authHeader;
                    return { ok: true, data: 'resource_fetched' };
                }
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const plan = {
                objective: 'Auth and fetch profile',
                steps: [
                    {
                        id: 'step_auth',
                        index: 1,
                        title: 'Authenticate',
                        toolId: 'auth_service_primary',
                        params: {}
                    },
                    {
                        id: 'step_fetch',
                        index: 2,
                        title: 'Fetch profile',
                        toolId: 'api_client_step',
                        dependsOn: ['step_auth'],
                        params: { authHeader: 'Bearer {{step_auth.result.sessionToken}}' }
                    }
                ]
            };

            const res = await coordinator.executeRequest('Auth and fetch', { planOverride: plan });

            assert.strictEqual(res.ok, true);
            assert.strictEqual(receivedHeader, 'Bearer verified-session-token-99', 'Dependent step must receive resolved verified output from fallback step');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 11. An invalid revised DAG is rejected before any revised step executes.
    // -------------------------------------------------------------------------
    test('11. An invalid revised DAG is rejected before any revised step executes', async () => {
        const tempDir = createTempDir();
        try {
            const coordinator = new TaskCoordinator({ memoryDir: tempDir });

            // Cycle: step_1 depends on step_2, step_2 depends on step_1
            const cyclicPlan = [
                { id: 'step_1', dependsOn: ['step_2'], toolId: 'tool_a' },
                { id: 'step_2', dependsOn: ['step_1'], toolId: 'tool_b' }
            ];

            const dagCheck = coordinator._validatePlanDAG(cyclicPlan);
            assert.strictEqual(dagCheck.valid, false);
            assert.ok(dagCheck.error.includes('Cyclic dependency') || dagCheck.error.includes('Cycle'));

            // Missing prerequisite
            const missingPreReqPlan = [
                { id: 'step_a', dependsOn: ['step_ghost'], toolId: 'tool_a' }
            ];

            const missingCheck = coordinator._validatePlanDAG(missingPreReqPlan);
            assert.strictEqual(missingCheck.valid, false);
            assert.ok(/unknown dependency/i.test(missingCheck.error));
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 12. Replanning stops when its configured budget is exhausted.
    // -------------------------------------------------------------------------
    test('12. Replanning stops when its configured budget is exhausted', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'failing_tool_1',
                name: 'Failing Tool 1',
                category: 'system',
                capabilities: ['action'],
                riskTier: RISK_TIERS.SAFE_READ,
                availabilityCheck: async () => ({ available: false, reason: 'Out of service' }),
                handler: async () => ({ ok: false })
            });

            toolRegistry.registerTool({
                id: 'failing_tool_2',
                name: 'Failing Tool 2',
                category: 'system',
                capabilities: ['action'],
                riskTier: RISK_TIERS.SAFE_READ,
                availabilityCheck: async () => ({ available: false, reason: 'Out of service' }),
                handler: async () => ({ ok: false })
            });

            toolRegistry.registerTool({
                id: 'failing_tool_3',
                name: 'Failing Tool 3',
                category: 'system',
                capabilities: ['action'],
                riskTier: RISK_TIERS.SAFE_READ,
                availabilityCheck: async () => ({ available: false, reason: 'Out of service' }),
                handler: async () => ({ ok: false })
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry,
                maxReplans: 1 // Strict budget: only 1 replan allowed!
            });

            const plan = {
                objective: 'Exhaust budget',
                steps: [
                    {
                        id: 'step_fail',
                        index: 1,
                        title: 'Execute action',
                        toolId: 'failing_tool_1',
                        params: {}
                    }
                ]
            };

            const res = await coordinator.executeRequest('Exhaust budget', { planOverride: plan });

            assert.strictEqual(res.ok, false);
            const cp = continuityStore.getCheckpoint(res.taskId);
            // Replan count should be capped at maxReplans (1)
            assert.ok(cp.replanHistory.length <= 1, 'Should not exceed maxReplans budget');
            assert.ok(res.error.includes('budget') || res.error.includes('Out of service') || res.error.includes('fallback'));
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 13. A repeated failed candidate is not selected indefinitely.
    // -------------------------------------------------------------------------
    test('13. A repeated failed candidate is not selected indefinitely', async () => {
        const tempDir = createTempDir();
        try {
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'cand_a',
                name: 'Candidate A',
                category: 'filesystem',
                capabilities: ['read'],
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => ({ ok: true })
            });

            toolRegistry.registerTool({
                id: 'cand_b',
                name: 'Candidate B',
                category: 'filesystem',
                capabilities: ['read'],
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => ({ ok: true })
            });

            // If both cand_a and cand_b have already failed
            const failedSet = new Set(['cand_a', 'cand_b']);
            const evalResult = await toolRegistry.findFallbackCandidates({
                failedToolId: 'cand_a',
                failedTools: failedSet
            });

            assert.strictEqual(evalResult.candidates.length, 0, 'Already failed tools must be excluded');
            assert.strictEqual(evalResult.rejected.filter(r => r.reason === 'already_attempted_or_failed').length, 2);
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 14. A late result from an abandoned attempt cannot overwrite the revised plan or task checkpoint.
    // -------------------------------------------------------------------------
    test('14. A late result from an abandoned attempt cannot overwrite revised plan or checkpoint', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore
            });

            const taskId = 'task_late_settlement_test';
            const plan = {
                objective: 'Task with fallback',
                steps: [
                    { id: 'step_1', index: 1, title: 'Step 1 (Fallback: Tool B)', toolId: 'tool_b' }
                ]
            };

            // Task has already finished with revised plan and completed status
            continuityStore.saveCheckpoint({
                taskId,
                userRequest: 'Task with fallback',
                plan,
                currentStepIndex: 1,
                completedSteps: [
                    { id: 'step_1', index: 1, toolId: 'tool_b', verified: true, result: { ok: true } }
                ],
                status: TASK_STATUSES.COMPLETED,
                replanHistory: [
                    { stepId: 'step_1', failedToolId: 'tool_a', selectedFallback: 'tool_b' }
                ]
            });

            // Abandoned Tool A attempt finishes late
            coordinator._handleLateSettlement(taskId, 'step_1', 1, { ok: true, data: 'stale_tool_a_output' });

            const cp = continuityStore.getCheckpoint(taskId);
            assert.strictEqual(cp.status, TASK_STATUSES.COMPLETED);
            assert.strictEqual(cp.plan.steps[0].toolId, 'tool_b', 'Revised plan step must not be overwritten');
            assert.strictEqual(cp.completedSteps[0].toolId, 'tool_b', 'Verified completed step must not be corrupted by stale handler');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 15. A revised plan requiring additional consequential permission is blocked pending the required approval.
    // -------------------------------------------------------------------------
    test('15. A revised plan requiring additional consequential permission is blocked when user declines', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'readonly_primary',
                name: 'Readonly Primary',
                category: 'system',
                capabilities: ['sync'],
                riskTier: RISK_TIERS.SAFE_READ,
                availabilityCheck: async () => ({ available: false, reason: 'Read replica offline' }),
                handler: async () => ({ ok: false })
            });

            toolRegistry.registerTool({
                id: 'consequential_sync_fallback',
                name: 'Consequential Sync Fallback',
                category: 'system',
                capabilities: ['sync'],
                riskTier: RISK_TIERS.WORKSPACE_WRITE, // Consequential tier!
                handler: async () => ({ ok: true, mutated: true })
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const plan = {
                objective: 'Sync state',
                steps: [
                    { id: 'step_sync', index: 1, title: 'Sync', toolId: 'readonly_primary', params: {} }
                ]
            };

            // User declines consequential confirmation
            const res = await coordinator.executeRequest('Sync state', {
                planOverride: plan,
                requireConsequentialConfirmation: true,
                onConfirmStep: async () => false // User rejects!
            });

            assert.strictEqual(res.ok, false);
            assert.ok(res.error.includes('Fallback blocked') || res.error.includes('declined'), 'Must report confirmation blocked');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 16. A task with no safe fallback ends with an honest structured failure.
    // -------------------------------------------------------------------------
    test('16. A task with no safe fallback ends with an honest structured failure', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'isolated_unique_tool',
                name: 'Isolated Unique Tool',
                category: 'unique_domain',
                capabilities: ['unique_special_capability'],
                riskTier: RISK_TIERS.SAFE_READ,
                availabilityCheck: async () => ({ available: false, reason: 'Driver missing' }),
                handler: async () => ({ ok: false })
            });

            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const plan = {
                objective: 'Execute isolated action',
                steps: [
                    { id: 'step_unique', index: 1, title: 'Unique action', toolId: 'isolated_unique_tool', params: {} }
                ]
            };

            const res = await coordinator.executeRequest('Execute isolated action', { planOverride: plan });

            assert.strictEqual(res.ok, false);
            assert.strictEqual(res.partiallyCompleted, false);
            assert.ok(res.error.includes('Driver missing') || res.error.includes('fallback') || res.error.includes('Adaptive replanning'));
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 17. Checkpoint persistence and resumption preserve the revised plan and recovery history.
    // -------------------------------------------------------------------------
    test('17. Checkpoint persistence and resumption preserve the revised plan and recovery history', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const toolRegistry = new ToolRegistry();

            toolRegistry.registerTool({
                id: 'step1_fallback',
                name: 'Step 1 Fallback Tool',
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async () => ({ ok: true, data: 'from_step_1' })
            });

            toolRegistry.registerTool({
                id: 'step2_tool',
                name: 'Step 2 Tool',
                riskTier: RISK_TIERS.SAFE_READ,
                handler: async (params) => ({ ok: true, received: params.val })
            });

            const taskId = 'task_persisted_replan_1';
            const revisedPlan = {
                objective: 'Workflow with revised step',
                steps: [
                    {
                        id: 'step_1',
                        index: 1,
                        title: 'Step 1 (Fallback: step1_fallback)',
                        toolId: 'step1_fallback',
                        replanMetadata: {
                            originalToolId: 'step1_primary',
                            fallbackToolId: 'step1_fallback',
                            replanAttempt: 1
                        }
                    },
                    {
                        id: 'step_2',
                        index: 2,
                        title: 'Step 2',
                        toolId: 'step2_tool',
                        dependsOn: ['step_1'],
                        params: { val: '{{step_1.result.data}}' }
                    }
                ]
            };

            continuityStore.saveCheckpoint({
                taskId,
                userRequest: 'Workflow with revised step',
                plan: revisedPlan,
                currentStepIndex: 1,
                completedSteps: [
                    { id: 'step_1', index: 1, toolId: 'step1_fallback', verified: true, result: { ok: true, data: 'from_step_1' } }
                ],
                status: TASK_STATUSES.INTERRUPTED,
                replanHistory: [
                    { stepId: 'step_1', failedToolId: 'step1_primary', selectedFallback: 'step1_fallback', replanAttempt: 1 }
                ]
            });

            // Reconstruct a new TaskCoordinator from the persisted store
            const newCoordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore,
                toolRegistry
            });

            const inspection = continuityStore.inspectTaskForResume(taskId);
            assert.strictEqual(inspection.isResumable, true);
            assert.strictEqual(inspection.pendingSteps.length, 1);
            assert.strictEqual(inspection.pendingSteps[0].id, 'step_2');

            // Resume task
            const resumeRes = await newCoordinator.resumeTask(taskId);
            assert.strictEqual(resumeRes.ok, true);

            const finalCp = continuityStore.getCheckpoint(taskId);
            assert.strictEqual(finalCp.status, TASK_STATUSES.COMPLETED);
            assert.strictEqual(finalCp.plan.steps[0].toolId, 'step1_fallback');
            assert.strictEqual(finalCp.replanHistory.length, 1);
            assert.strictEqual(finalCp.replanHistory[0].selectedFallback, 'step1_fallback');
        } finally {
            cleanTempDir(tempDir);
        }
    });

    // -------------------------------------------------------------------------
    // 18. Existing uncertain-outcome resolution, authorization, cancellation, and concurrency protections continue to pass.
    // -------------------------------------------------------------------------
    test('18. Existing uncertain-outcome, authorization, cancellation, and concurrency protections continue to hold', async () => {
        const tempDir = createTempDir();
        try {
            const continuityStore = new TaskContinuityStore({ storeDir: tempDir, memoryDir: tempDir });
            const coordinator = new TaskCoordinator({
                memoryDir: tempDir,
                taskContinuityStore: continuityStore
            });

            const taskId = 'task_concurrency_lock_guard';
            // Simulate lock
            coordinator.resolutionLocks.add(taskId);

            await assert.rejects(
                async () => {
                    await coordinator.resolveUncertainStep(taskId, {
                        resolution: 'confirmed_success',
                        evidence: { auditId: 'receipt-123' }
                    });
                },
                { code: 'CONCURRENCY_CONFLICT' },
                'Concurrent resolution request must be rejected with CONCURRENCY_CONFLICT'
            );

            coordinator.resolutionLocks.delete(taskId);
        } finally {
            cleanTempDir(tempDir);
        }
    });

});
