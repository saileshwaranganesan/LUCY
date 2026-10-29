'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES, DuplicateTaskExecutionError } = require('../../src/core/task-status.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');
const { registerSystemTools } = require('../../src/tools/system-tools.js');
const { MemoryStore } = require('../../src/memory/memory-store.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { ResultVerifier } = require('../../src/core/result-verifier.js');
const { TaskRecoveryEngine } = require('../../src/core/recovery-engine.js');

test('AI Execution Core Readiness — 10-Area Comprehensive Baseline Matrix', async (suite) => {
    const sandboxDir = path.join(os.tmpdir(), `lucy-core-matrix-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(sandboxDir, { recursive: true });

    const credStore = new CredentialStore({ storeDir: path.join(sandboxDir, 'creds') });
    const permissionAuth = new PermissionAuthority({
        mode: PERMISSION_MODES.STANDARD,
        workspaceRoot: sandboxDir
    });

    const toolRegistry = new ToolRegistry({ permissionAuthority: permissionAuth });
    registerFileTools(toolRegistry, sandboxDir);
    registerSystemTools(toolRegistry);

    // Register test mock tools
    let flakyAttempts = 0;
    toolRegistry.registerTool({
        id: 'mock_flaky_tool',
        name: 'Mock Flaky Tool',
        description: 'Recovers on retry',
        riskTier: RISK_TIERS.SAFE_READ,
        handler: async (params) => {
            flakyAttempts++;
            if (flakyAttempts === 1) {
                return { ok: false, error: 'Temporary connection timeout (ETIMEDOUT)', status: 'transient_failure' };
            }
            return { ok: true, status: 'completed', data: params.input || 'success' };
        }
    });

    toolRegistry.registerTool({
        id: 'mock_lying_tool',
        name: 'Mock Lying Tool',
        description: 'Claims success but does not create file',
        riskTier: RISK_TIERS.WORKSPACE_WRITE,
        handler: async (params) => {
            // Intentionally claims success without creating params.path
            return { ok: true, status: 'completed', result: { path: params.path } };
        }
    });

    const memoryStore = new MemoryStore({ memoryDir: path.join(sandboxDir, 'memory') });
    const taskContinuityStore = new TaskContinuityStore({ storeDir: path.join(sandboxDir, 'memory') });
    const resultVerifier = new ResultVerifier({ workspaceRoot: sandboxDir });
    const recoveryEngine = new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 10 });

    const providerAdapter = new ProviderAdapter({
        credentialStore: credStore,
        provider: PROVIDER_TYPES.GEMINI
    });

    const planner = new TaskPlanner({ providerAdapter, toolRegistry });

    function createCoordinator(overrides = {}) {
        return new TaskCoordinator({
            permissionAuthority: permissionAuth,
            workspaceRoot: sandboxDir,
            toolRegistry,
            providerAdapter,
            planner,
            memoryStore,
            taskContinuityStore,
            resultVerifier,
            recoveryEngine,
            ...overrides
        });
    }

    suite.after(() => {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
    });

    // -------------------------------------------------------------------------
    // 1. Simple Single-Tool Requests
    // -------------------------------------------------------------------------
    await suite.test('Area 1: Simple single-tool request executes and verifies successfully', async () => {
        const coordinator = createCoordinator();
        const res = await coordinator.executeRequest('Inspect system status');
        assert.strictEqual(res.ok, true, 'Result should be ok');
        assert.strictEqual(res.status, 'completed', 'Status should be completed');
        assert.strictEqual(res.executedSteps.length, 1, 'Should have 1 executed step');
        assert.strictEqual(res.executedSteps[0].toolId, 'system_info');
        assert.strictEqual(res.executedSteps[0].verified, true, 'Step should be verified');
        assert.strictEqual(res.verification.verified, true, 'Overall verification should pass');
    });

    // -------------------------------------------------------------------------
    // 2. Multi-Step Requests with Dependencies
    // -------------------------------------------------------------------------
    await suite.test('Area 2: Multi-step request resolves dependencies and dynamic parameters', async () => {
        permissionAuth.setMode(PERMISSION_MODES.AUTONOMOUS_SANDBOX);
        const coordinator = createCoordinator();

        const plan = {
            objective: 'Write and then read file',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Write test data',
                    toolId: 'file_write',
                    params: { path: 'piped_data.txt', content: 'Step 1 generated text' }
                },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Read test data',
                    toolId: 'file_read',
                    dependsOn: ['step_1'],
                    params: { path: '{{step_1.params.path}}' }
                }
            ]
        };

        const res = await coordinator.executeRequest('Piped workflow', { planOverride: plan });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.status, 'completed');
        assert.strictEqual(res.executedSteps.length, 2);
        assert.strictEqual(res.executedSteps[0].verified, true);
        assert.strictEqual(res.executedSteps[1].verified, true);
        assert.strictEqual(res.executedSteps[1].params.path, 'piped_data.txt', 'Template parameter must be resolved');
        assert.strictEqual(res.executedSteps[1].result.result.content, 'Step 1 generated text');
    });

    // -------------------------------------------------------------------------
    // 3. Ambiguous and Underspecified Requests
    // -------------------------------------------------------------------------
    await suite.test('Area 3: Ambiguous or underspecified requests trigger clarification without execution', async () => {
        const coordinator = createCoordinator();
        
        // Underspecified: missing filename and content
        const resMissing = await coordinator.executeRequest('create file');
        assert.strictEqual(resMissing.status, 'clarification_required');
        assert.ok(resMissing.missingParameters.includes('path'));
        assert.strictEqual(resMissing.executedSteps.length, 0, 'Must not execute any tools');

        // Ambiguous: conflicting directives
        const resAmbiguous = await coordinator.executeRequest('delete file test.txt and keep test.txt');
        assert.strictEqual(resAmbiguous.status, 'clarification_required');
        assert.strictEqual(resAmbiguous.ambiguous, true);
        assert.match(resAmbiguous.replyText, /contradictory/i);
    });

    // -------------------------------------------------------------------------
    // 4. Unsupported or Impossible Requests
    // -------------------------------------------------------------------------
    await suite.test('Area 4: Unsupported requests are truthfully reported without hallucinations', async () => {
        const coordinator = createCoordinator();
        const res = await coordinator.executeRequest('order pizza with extra cheese for delivery');
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.status, 'unsupported');
        assert.match(res.replyText, /not supported by L\.U\.C\.Y/i);
        assert.strictEqual(res.executedSteps.length, 0);
    });

    // -------------------------------------------------------------------------
    // 5. Tool Failures, Retries, and Recovery
    // -------------------------------------------------------------------------
    await suite.test('Area 5: Transient failure triggers bounded recovery and succeeds on retry', async () => {
        flakyAttempts = 0;
        const coordinator = createCoordinator();

        const plan = {
            objective: 'Test recovery',
            type: 'plan',
            steps: [
                { index: 1, title: 'Flaky step', toolId: 'mock_flaky_tool', params: { input: 'recovery-val' } }
            ]
        };

        const res = await coordinator.executeRequest('Test recovery', { planOverride: plan });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.status, 'completed');
        assert.strictEqual(flakyAttempts, 2, 'Should have retried exactly once');
        assert.strictEqual(res.executedSteps[0].recovery.recovered, true);
        assert.strictEqual(res.executedSteps[0].recovery.attempts, 1);
    });

    // -------------------------------------------------------------------------
    // 6. Cancellation and Duplicate-Execution Prevention
    // -------------------------------------------------------------------------
    await suite.test('Area 6: In-flight cancellation halts execution and duplicate active tasks are rejected', async () => {
        const coordinator = createCoordinator();
        const taskId = 'unique_active_task_001';

        // Duplicate active task rejection
        const ac = new AbortController();
        coordinator.activeTasks.set(taskId, ac);
        try {
            await assert.rejects(
                () => coordinator.executeRequest('Duplicate attempt', { taskId }),
                DuplicateTaskExecutionError,
                'Must throw DuplicateTaskExecutionError for active task'
            );
        } finally {
            coordinator.activeTasks.delete(taskId);
        }

        // Mid-flight cancellation
        const cancelAc = new AbortController();
        cancelAc.abort('User hit cancel button');
        const cancelRes = await coordinator.executeRequest('Cancel me', { signal: cancelAc.signal });
        assert.strictEqual(cancelRes.ok, false);
        assert.strictEqual(cancelRes.status, 'cancelled');
        assert.strictEqual(cancelRes.cancelled, true);
    });

    // -------------------------------------------------------------------------
    // 7. Permission Denial and Destructive-Action Safeguards
    // -------------------------------------------------------------------------
    await suite.test('Area 7: Permission denial and path traversal are rejected fail-closed', async () => {
        permissionAuth.setMode(PERMISSION_MODES.STANDARD);
        permissionAuth.setConfirmationHandler(async () => false); // Denied
        const coordinator = createCoordinator();

        // 1. Consequential file delete denied
        const targetPath = path.join(sandboxDir, 'sensitive_record.txt');
        fs.writeFileSync(targetPath, 'Important data');
        const deleteRes = await coordinator.executeRequest('delete file sensitive_record.txt');
        assert.strictEqual(deleteRes.ok, false);
        assert.strictEqual(deleteRes.status, 'failed');
        assert.strictEqual(fs.existsSync(targetPath), true, 'File must not be deleted when denied');

        // 2. Path traversal escaping workspace root
        const traversalRes = await coordinator.executeRequest('read file ../../windows/system32/cmd.exe');
        assert.strictEqual(traversalRes.ok, false);
        assert.match(traversalRes.error || traversalRes.replyText, /boundary|denied|traversal|workspace/i);
    });

    // -------------------------------------------------------------------------
    // 8. Incorrect, Incomplete, or Unverifiable Tool Results
    // -------------------------------------------------------------------------
    await suite.test('Area 8: Tool falsely claiming success fails verification (anti-hallucination)', async () => {
        const coordinator = createCoordinator();
        const plan = {
            objective: 'Test lying tool',
            type: 'plan',
            steps: [
                {
                    index: 1,
                    title: 'Lying write',
                    toolId: 'mock_lying_tool',
                    params: { path: 'ghost_file.txt' }
                }
            ]
        };

        const res = await coordinator.executeRequest('Write ghost file', { planOverride: plan });
        // ResultVerifier should check that ghost_file.txt does NOT exist on disk, failing verification
        assert.strictEqual(res.ok, false, 'Must fail when tool claims success but file does not exist');
        assert.strictEqual(res.executedSteps[0].verified, false, 'Step verification must be false');
        assert.strictEqual(res.verification.verified, false);
    });

    // -------------------------------------------------------------------------
    // 9. Accurate Reporting of Partial Completion and Failure
    // -------------------------------------------------------------------------
    await suite.test('Area 9: Mid-task failure truthfully reports PARTIALLY_COMPLETED lifecycle state', async () => {
        permissionAuth.setMode(PERMISSION_MODES.AUTONOMOUS_SANDBOX);
        const coordinator = createCoordinator();

        const plan = {
            objective: 'Partial workflow',
            type: 'plan',
            steps: [
                {
                    index: 1,
                    title: 'Step 1 success',
                    toolId: 'file_write',
                    params: { path: 'partial_step1.txt', content: 'Step 1 done' }
                },
                {
                    index: 2,
                    title: 'Step 2 failure',
                    toolId: 'file_read',
                    params: { path: 'non_existent_file_999.txt' }
                }
            ]
        };

        const res = await coordinator.executeRequest('Run partial workflow', { planOverride: plan });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.partiallyCompleted, true, 'partiallyCompleted flag must be true');
        assert.strictEqual(res.lifecycleState, TASK_STATES.PARTIALLY_COMPLETED, 'Lifecycle state must be PARTIALLY_COMPLETED');
        assert.strictEqual(res.executedSteps.length, 2);
        assert.strictEqual(res.executedSteps[0].verified, true, 'Step 1 must be verified');
        assert.strictEqual(res.executedSteps[1].verified, false, 'Step 2 must be failed');
    });

    // -------------------------------------------------------------------------
    // 10. Provider Unavailability and Fallback Behavior
    // -------------------------------------------------------------------------
    await suite.test('Area 10: Unconfigured provider reports actionable status without crashing', async () => {
        const unconfiguredCredStore = new CredentialStore({ storeDir: path.join(sandboxDir, 'empty_creds') });
        const unconfiguredAdapter = new ProviderAdapter({
            credentialStore: unconfiguredCredStore,
            provider: PROVIDER_TYPES.GEMINI
        });
        const unconfiguredPlanner = new TaskPlanner({ providerAdapter: unconfiguredAdapter, toolRegistry });
        const coordinator = createCoordinator({
            providerAdapter: unconfiguredAdapter,
            planner: unconfiguredPlanner
        });

        // Request requiring AI reasoning with unconfigured provider
        const res = await coordinator.executeRequest('Write an essay comparing quantum physics and relativity');
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.status, 'unconfigured_provider');
        assert.strictEqual(res.needsConfig, true);
        assert.match(res.replyText, /API key|configure/i);
    });
});
