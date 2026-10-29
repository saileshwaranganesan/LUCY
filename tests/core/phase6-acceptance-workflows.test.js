'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES, UncertainOutcomeError } = require('../../src/core/task-status.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { MemoryStore } = require('../../src/memory/memory-store.js');
const { SqliteMemoryAdapter } = require('../../src/memory/sqlite-adapter.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { MEMORY_CATEGORIES, MEMORY_TYPES, MEMORY_SOURCES } = require('../../src/memory/memory-constants.js');
const { registerMemoryTools } = require('../../src/tools/memory-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');

test('L.U.C.Y. Phase 6 — Authoritative Acceptance Workflows A through E', async (t) => {
    const baseTestDir = path.join(os.tmpdir(), `lucy-phase6-acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(baseTestDir, { recursive: true });

    t.after(() => {
        try {
            fs.rmSync(baseTestDir, { recursive: true, force: true });
        } catch (_) {}
    });

    // =========================================================================
    // WORKFLOW A: Approved memory restart, provenance, exact ID deletion & negative constraints
    // =========================================================================
    await t.test('Workflow A: Approved memory restart, provenance separation, exact ID deletion & negative constraints', async () => {
        const memDir = path.join(baseTestDir, 'workflow_a');
        fs.mkdirSync(memDir, { recursive: true });

        const sqliteAdapter = new SqliteMemoryAdapter({ dbPath: path.join(memDir, 'lucy-memory.db'), storeDir: memDir });
        await sqliteAdapter.init();

        const store1 = new MemoryStore({ memoryDir: memDir, sqliteAdapter });

        // 1. Store explicit user facts, inferred preference, and conversation records
        const fact1 = store1.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'editor_preference',
            content: 'Preferred editor is VS Code with dark fairy theme',
            type: MEMORY_TYPES.CONFIRMED_FACT,
            source: MEMORY_SOURCES.USER_EXPLICIT,
            importance: 5
        });

        const fact2 = store1.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: '', // Empty key to verify exact-ID deletion safety
            content: 'User prefers concise responses with bullet points',
            type: MEMORY_TYPES.CONFIRMED_FACT,
            source: MEMORY_SOURCES.USER_EXPLICIT,
            importance: 3
        });

        const inferred = store1.addMemory({
            category: MEMORY_CATEGORIES.WORKING_DATA,
            key: 'inferred_style',
            content: 'User seems to work late at night',
            type: MEMORY_TYPES.INFERRED_PREFERENCE,
            source: MEMORY_SOURCES.ASSISTANT_SYNTHESIS,
            importance: 2
        });

        const convRecord = store1.addMemory({
            category: MEMORY_CATEGORIES.CONVERSATION,
            key: '',
            content: 'User said: Hello Lucy',
            type: MEMORY_TYPES.CONFIRMED_FACT,
            source: MEMORY_SOURCES.USER_EXPLICIT
        });

        assert.ok(fact1.id.startsWith('mem_'));
        assert.ok(fact2.id.startsWith('mem_'));
        assert.ok(inferred.id.startsWith('mem_'));
        assert.ok(convRecord.id.startsWith('mem_'));

        // 2. Simulate Application Restart: close store1 and open fresh store2 from disk/sqlite
        const sqliteAdapter2 = new SqliteMemoryAdapter({ dbPath: path.join(memDir, 'lucy-memory.db'), storeDir: memDir });
        await sqliteAdapter2.init();
        const store2 = new MemoryStore({ memoryDir: memDir, sqliteAdapter: sqliteAdapter2 });

        // Verify approved facts survived restart with provenance preserved
        const approvedMemories = store2.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
        assert.equal(approvedMemories.length, 2, 'Both approved facts must survive restart');
        const retrievedFact1 = approvedMemories.find((m) => m.id === fact1.id);
        assert.ok(retrievedFact1, 'Fact 1 must be present by ID');
        assert.equal(retrievedFact1.source, MEMORY_SOURCES.USER_EXPLICIT);
        assert.equal(retrievedFact1.type, MEMORY_TYPES.CONFIRMED_FACT);
        assert.equal(retrievedFact1.key, 'editor_preference');

        const retrievedFact2 = approvedMemories.find((m) => m.id === fact2.id);
        assert.ok(retrievedFact2, 'Fact 2 must be present by ID');
        assert.equal(retrievedFact2.key, '');

        // Verify provenance separation: inferred preference is in working_data, not user_approved
        const workingMemories = store2.getMemories({ category: MEMORY_CATEGORIES.WORKING_DATA });
        assert.ok(workingMemories.some((m) => m.id === inferred.id && m.source === MEMORY_SOURCES.ASSISTANT_SYNTHESIS));

        // 3. Exact ID Deletion Protection:
        // Delete fact2 (which has key: "") using its exact ID.
        // It must NOT delete convRecord (which also has key: "") or any other record!
        const deleteRes = store2.deleteMemory(fact2.id, { exactIdOnly: true });
        assert.equal(deleteRes, true, 'Exact ID deletion must return true');

        const remainingApproved = store2.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
        assert.equal(remainingApproved.length, 1, 'Only Fact 2 should be deleted');
        assert.equal(remainingApproved[0].id, fact1.id, 'Fact 1 must remain intact');

        const remainingConv = store2.getMemories({ category: MEMORY_CATEGORIES.CONVERSATION });
        assert.ok(remainingConv.some((m) => m.id === convRecord.id), 'Conversation record with empty key must NOT be wiped');

        // Also verify SQLite adapter deletion matches exactly
        const sqliteFact2 = sqliteAdapter2.getMemoryById(fact2.id);
        assert.equal(sqliteFact2, null, 'Fact 2 must be deleted from SQLite');
        const sqliteFact1 = sqliteAdapter2.getMemoryById(fact1.id);
        assert.ok(sqliteFact1, 'Fact 1 must remain in SQLite');

        // 4. Negative User Instruction Enforcement:
        // User explicitly instructs: "Do not remember any credit card numbers"
        const instruction = store2.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'no_credit_cards',
            content: 'Do not remember any credit card numbers',
            type: MEMORY_TYPES.USER_INSTRUCTION,
            source: MEMORY_SOURCES.USER_EXPLICIT,
            metadata: { isNegativeInstruction: true, prohibitedTopic: 'credit card' }
        });
        assert.ok(instruction && !instruction.rejected);

        // Attempt to store a memory violating the negative instruction
        const violationAttempt = store2.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'payment_info',
            content: 'User credit card is 4111-2222-3333-4444',
            type: MEMORY_TYPES.CONFIRMED_FACT
        });
        assert.equal(violationAttempt.ok, false);
        assert.equal(violationAttempt.rejected, true);
        assert.match(violationAttempt.reason, /rejected by active user instruction/i);

        // 5. Model-Facing Tools Integration (memory_store, memory_delete, memory_forget)
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: memDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        registerMemoryTools(tr, store2);

        assert.ok(tr.hasTool('memory_search'));
        assert.ok(tr.hasTool('memory_get'));
        assert.ok(tr.hasTool('memory_list'));
        assert.ok(tr.hasTool('memory_store'));
        assert.ok(tr.hasTool('memory_delete'));
        assert.ok(tr.hasTool('memory_forget'));

        // Test memory_store tool
        const storeToolRes = await tr.execute('memory_store', {
            content: 'Project Alpha uses Node.js 22 LTS',
            category: 'project',
            key: 'alpha_runtime'
        });
        assert.equal(storeToolRes.ok, true);
        assert.equal(storeToolRes.status, 'completed');
        assert.ok(storeToolRes.memory.id);

        // Test memory_forget tool
        const forgetToolRes = await tr.execute('memory_forget', {
            topic: 'Alpha'
        });
        assert.equal(forgetToolRes.ok, true);
        assert.equal(forgetToolRes.status, 'completed');
        assert.equal(forgetToolRes.instructionCreated, true);

        // Test TaskPlanner intent routing for memory
        const planner = new TaskPlanner({ toolRegistry: tr });
        const planRemember = await planner.plan('Remember that the server runs on port 8080');
        assert.equal(planRemember.type, 'plan');
        assert.equal(planRemember.steps[0].toolId, 'memory_store');

        const planForget = await planner.plan('Do not remember passwords');
        assert.equal(planForget.type, 'plan');
        assert.equal(planForget.steps[0].toolId, 'memory_forget');
    });

    // =========================================================================
    // WORKFLOW B: Interrupted task resumption without duplicate execution
    // =========================================================================
    await t.test('Workflow B: Interrupted task resumption without duplicate execution of completed steps', async () => {
        const testDir = path.join(baseTestDir, 'workflow_b');
        fs.mkdirSync(testDir, { recursive: true });

        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let step1ExecCount = 0;
        let step2ExecCount = 0;
        let step3ExecCount = 0;

        tr.registerTool({
            id: 'side_effect_step_1',
            name: 'Side Effect Step 1',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step1ExecCount++;
                return { ok: true, status: 'ok', result: { step: 1, created: true }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'side_effect_step_2',
            name: 'Side Effect Step 2',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step2ExecCount++;
                return { ok: true, status: 'ok', result: { step: 2, transformed: true }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'side_effect_step_3',
            name: 'Side Effect Step 3',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step3ExecCount++;
                return { ok: true, status: 'ok', result: { step: 3, finalized: true }, verification: { verified: true } };
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
            memoryDir: testDir
        });

        const taskId = 'task_workflow_b_01';
        const plan = {
            objective: 'Execute sequential pipeline',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Initialize', toolId: 'side_effect_step_1', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Transform', toolId: 'side_effect_step_2', params: {}, dependsOn: ['step_1'] },
                { id: 'step_3', index: 3, title: 'Step 3 Finalize', toolId: 'side_effect_step_3', params: {}, dependsOn: ['step_2'] }
            ]
        };

        // Seed a checkpoint where Step 1 was already completed and verified, but task was INTERRUPTED
        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Execute sequential pipeline',
            plan,
            currentStepIndex: 1,
            completedSteps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Step 1 Initialize',
                    toolId: 'side_effect_step_1',
                    params: {},
                    result: { ok: true, status: 'ok', result: { step: 1, created: true } },
                    verified: true,
                    status: 'completed'
                }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        // Verify task state reflects interrupted prior to resumption
        const inspected = coordinator.taskContinuityStore.inspectTaskForResume(taskId);
        assert.equal(inspected.isResumable, true);
        assert.equal(inspected.completedSteps.length, 1);
        assert.equal(inspected.pendingSteps.length, 2);

        // Resume task execution through coordinator
        const resumeResult = await coordinator.resumeTask(taskId);

        assert.equal(resumeResult.ok, true);
        assert.equal(resumeResult.status, 'completed');

        // Step 1 MUST NOT have re-executed
        assert.equal(step1ExecCount, 0, 'Step 1 was already verified completed and must NOT re-execute');
        // Steps 2 and 3 MUST have executed exactly once
        assert.equal(step2ExecCount, 1, 'Step 2 must execute exactly once');
        assert.equal(step3ExecCount, 1, 'Step 3 must execute exactly once');

        // Verify status manager state transitions through resumption
        assert.ok(observedStates.includes(TASK_STATES.RUNNING));
        assert.ok(observedStates.includes(TASK_STATES.COMPLETED));

        // Verify checkpoint is terminal completed
        const finalCheckpoint = coordinator.taskContinuityStore.getCheckpoint(taskId);
        assert.equal(finalCheckpoint.status, TASK_STATUSES.COMPLETED);
        assert.equal(finalCheckpoint.completedSteps.length, 3);
    });

    // =========================================================================
    // WORKFLOW C: Uncertain outcome records uncertainty and blocks automated replay
    // =========================================================================
    await t.test('Workflow C: Uncertain outcome records uncertainty and blocks automated replay', async () => {
        const testDir = path.join(baseTestDir, 'workflow_c');
        fs.mkdirSync(testDir, { recursive: true });

        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        pa.setConfirmationHandler(async () => ({ confirmed: true }));
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'uncertain_action_tool',
            name: 'Uncertain Action Tool',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                // Return uncertain verification
                return {
                    ok: false,
                    status: 'inconclusive',
                    verification: {
                        verified: false,
                        uncertain: true,
                        inconclusive: true,
                        failureReason: 'Operation dispatched but status confirmation timed out; side-effect uncertain'
                    }
                };
            }
        });

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            memoryDir: testDir
        });

        const taskId = 'task_workflow_c_01';
        const plan = {
            objective: 'Consequential uncertain action',
            type: 'plan',
            steps: [
                { id: 'step_unc', index: 1, title: 'Uncertain action', toolId: 'uncertain_action_tool', params: {} }
            ]
        };

        // Seed task checkpoint with an unresolved uncertain step
        coordinator.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Perform risky action',
            plan,
            currentStepIndex: 0,
            completedSteps: [],
            status: TASK_STATUSES.AWAITING_RECONCILIATION,
            uncertainStep: {
                stepId: 'step_unc',
                toolId: 'uncertain_action_tool',
                reason: 'Network disconnect during transaction settlement',
                timestamp: new Date().toISOString(),
                resolved: false
            }
        });

        // 1. Attempting automated resumption must be STRICTLY BLOCKED
        const resumeAttempt = await coordinator.resumeTask(taskId);
        assert.equal(resumeAttempt.ok, false);
        assert.equal(resumeAttempt.status, 'uncertain_outcome_blocked');
        assert.match(resumeAttempt.error, /uncertain/i);

        // 2. Inspection must truthfully reflect that resumption is blocked
        const inspect = coordinator.taskContinuityStore.inspectTaskForResume(taskId);
        assert.equal(inspect.isResumable, false);
        assert.equal(inspect.hasUncertainStep, true);

        // 3. Explicit reconciliation resolving the step allows resumption or completes it
        const resolutionResult = await coordinator.resolveUncertainStep(taskId, {
            stepId: 'step_unc',
            resolution: 'confirmed_success',
            evidence: { receiptId: 'txn_confirmed_9982' },
            note: 'External audit confirms action succeeded'
        });
        assert.equal(resolutionResult.resolution, 'confirmed_success');
        assert.equal(resolutionResult.stepId, 'step_unc');
        assert.ok(resolutionResult.timestamp);

        // Checkpoint now reflects resolved uncertainty and completed state
        const updatedCheckpoint = coordinator.taskContinuityStore.getCheckpoint(taskId);
        assert.equal(updatedCheckpoint.uncertainStep.resolved, true);
        assert.equal(updatedCheckpoint.status, TASK_STATUSES.COMPLETED);
    });

    // =========================================================================
    // WORKFLOW D: Cancellation in-flight prevents late results from overwriting terminal state
    // =========================================================================
    await t.test('Workflow D: Cancellation in-flight drops late results and preserves terminal cancelled state', async () => {
        const testDir = path.join(baseTestDir, 'workflow_d');
        fs.mkdirSync(testDir, { recursive: true });

        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let step2Attempted = false;

        tr.registerTool({
            id: 'long_running_step_1',
            name: 'Long Running Step 1',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params, { signal }) => {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 300);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Operation aborted'));
                        }, { once: true });
                    }
                });
                return {
                    ok: true,
                    status: 'late_completion',
                    result: { lateData: 'should_not_overwrite' },
                    verification: { verified: true }
                };
            }
        });

        tr.registerTool({
            id: 'subsequent_step_2',
            name: 'Subsequent Step 2',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step2Attempted = true;
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        const statusManager = new TaskStatusManager();
        const plan = {
            objective: 'Multi-step task to be cancelled',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 Long', toolId: 'long_running_step_1', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2 Next', toolId: 'subsequent_step_2', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            statusManager,
            planner: { plan: async () => plan },
            memoryDir: testDir
        });

        const taskId = 'task_workflow_d_01';

        // Launch task asynchronously via executeRequest
        const runPromise = coordinator.executeRequest('Multi-step task to be cancelled', { taskId });

        // Wait briefly for Step 1 to begin execution, then cancel the task
        await new Promise((resolve) => setTimeout(resolve, 40));
        const cancelResult = coordinator.cancelTask(taskId, 'User cancelled workflow mid-step');
        assert.equal(cancelResult.ok, true);

        // Await the task completion
        const outcome = await runPromise;
        assert.equal(outcome.ok, false);
        assert.equal(outcome.status, 'cancelled');

        // Wait past the tool handler's 300ms delay to verify late arrival does NOT corrupt state
        await new Promise((resolve) => setTimeout(resolve, 350));

        // Terminal state in coordinator and continuity store MUST remain cancelled
        const finalTask = coordinator.taskContinuityStore.getCheckpoint(taskId);
        assert.equal(finalTask.status, TASK_STATUSES.CANCELLED);
        assert.equal(step2Attempted, false, 'Step 2 must NEVER run after cancellation');

        // Checkpoint must NOT treat late result as success
        const lateStep = (finalTask.completedSteps || []).find((s) => s.id === 'step_1');
        assert.ok(!lateStep || lateStep.status !== 'completed', 'Late step must not be committed as completed');
    });

    // =========================================================================
    // WORKFLOW E: Corrupted persistence creates backup, prevents destructive overwrite & restores SQLite
    // =========================================================================
    await t.test('Workflow E: Corrupted persistence creates backup, prevents destructive overwrite & restores SQLite', async () => {
        const testDir = path.join(baseTestDir, 'workflow_e');
        fs.mkdirSync(testDir, { recursive: true });

        // 1. Test TaskContinuityStore corruption resilience
        const continuityFile = path.join(testDir, 'task-checkpoints.json');
        // Write invalid corrupted JSON
        fs.writeFileSync(continuityFile, '{"tasks": { "broken_task": { INVALID_JSON_PAYLOAD_HERE', 'utf8');

        const continuityStore = new TaskContinuityStore({ storeDir: testDir });
        assert.equal(continuityStore.loadFailed, true, 'Corrupted JSON must set loadFailed to true');
        assert.ok(continuityStore.corruptBackupPath, 'Backup file path must be recorded');
        assert.ok(fs.existsSync(continuityStore.corruptBackupPath), 'Backup file must exist on disk');

        // Attempting to save MUST be rejected fail-closed to prevent wiping data
        const saveRes = continuityStore.save();
        assert.equal(saveRes, false, 'Save must be blocked when loadFailed is true');

        // Verify the original corrupted file on disk was NOT overwritten with an empty map
        const rawAfterSave = fs.readFileSync(continuityFile, 'utf8');
        assert.ok(rawAfterSave.includes('INVALID_JSON_PAYLOAD_HERE'), 'Corrupted file content must be preserved');

        // 2. Test MemoryStore corruption resilience with SQLite restoration
        const memDir = path.join(testDir, 'mem_corrupt_test');
        fs.mkdirSync(memDir, { recursive: true });

        // Initialize SQLite with a confirmed fact first
        const sqliteAdapter = new SqliteMemoryAdapter({ dbPath: path.join(memDir, 'lucy-memory.db'), storeDir: memDir });
        await sqliteAdapter.init();
        sqliteAdapter.insertMemory({
            id: 'mem_sqlite_golden_01',
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'golden_key',
            content: 'SQLite authentic persistent record',
            type: MEMORY_TYPES.CONFIRMED_FACT
        });

        // Corrupt the memory JSON file
        const memoryJsonFile = path.join(memDir, 'memory-store.json');
        fs.writeFileSync(memoryJsonFile, '{"version": 2, "memories": [ { MALFORMED_TRUNCATED_JSON', 'utf8');

        // Instantiate MemoryStore pointing to both the corrupt JSON and intact SQLite
        const memoryStore = new MemoryStore({ memoryDir: memDir, sqliteAdapter });

        assert.equal(memoryStore.loadFailed, true, 'MemoryStore must detect JSON corruption and set loadFailed');
        assert.ok(memoryStore.corruptBackupPath, 'Corrupt backup must be created');
        assert.ok(fs.existsSync(memoryStore.corruptBackupPath), 'Corrupt backup file must exist on disk');

        // Intact SQLite records MUST be intact and queryable through sqliteAdapter
        const records = sqliteAdapter.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
        assert.ok(records.some((r) => r.id === 'mem_sqlite_golden_01' && r.content === 'SQLite authentic persistent record'), 'SQLite records must be fully accessible');

        // Saving MemoryStore must also be blocked while loadFailed is active
        const memSaveRes = memoryStore.save();
        assert.equal(memSaveRes, false, 'MemoryStore save must be blocked while loadFailed');
    });
});
