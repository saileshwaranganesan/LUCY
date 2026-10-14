'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES } = require('../../src/core/task-status.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');
const { registerSystemTools } = require('../../src/tools/system-tools.js');
const { registerVisualTools } = require('../../src/tools/visual-tools.js');
const { registerStudentWorkflowTools } = require('../../src/tools/student-workflow-tools.js');
const { StudentWorkflows } = require('../../src/workflows/student-workflows.js');
const { Scheduler, JOB_STATUS } = require('../../src/core/scheduler.js');
const { VoiceController, RECOGNITION_MODES, VOICE_STATES } = require('../../src/voice/voice-controller.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { MemoryStore } = require('../../src/memory/memory-store.js');
const { ResultVerifier } = require('../../src/core/result-verifier.js');
const { TaskRecoveryEngine } = require('../../src/core/recovery-engine.js');

test('L.U.C.Y. Sprint 2: Comprehensive End-to-End Assistant Integration Harness', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-sprint2-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const credStore = new CredentialStore({ storeDir: path.join(testDir, 'creds') });
    const permissionAuth = new PermissionAuthority({
        mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX,
        workspaceRoot: testDir
    });

    const toolRegistry = new ToolRegistry({ permissionAuthority: permissionAuth });
    registerFileTools(toolRegistry, testDir);
    registerSystemTools(toolRegistry);

    const providerAdapter = new ProviderAdapter({
        credentialStore: credStore,
        provider: PROVIDER_TYPES.GEMINI
    });

    const statusManager = new TaskStatusManager();
    const companionBridge = new CompanionBridge();
    const memoryStore = new MemoryStore({ memoryDir: path.join(testDir, 'memory') });
    const taskContinuityStore = new TaskContinuityStore({ storeDir: path.join(testDir, 'memory') });

    const resultVerifier = new ResultVerifier({ workspaceRoot: testDir });
    const recoveryEngine = new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 20 });

    const coordinator = new TaskCoordinator({
        statusManager,
        permissionAuthority: permissionAuth,
        toolRegistry,
        providerAdapter,
        resultVerifier,
        recoveryEngine,
        memoryStore,
        taskContinuityStore,
        workspaceRoot: testDir
    });
    coordinator.setCompanionBridge(companionBridge);

    const scheduler = new Scheduler({
        storageDir: path.join(testDir, 'memory'),
        taskCoordinator: coordinator,
        permissionAuthority: permissionAuth
    });

    const studentWorkflows = new StudentWorkflows({
        workspaceRoot: testDir,
        scheduler,
        permissionAuthority: permissionAuth
    });
    registerStudentWorkflowTools(toolRegistry, studentWorkflows, scheduler);
    registerVisualTools(toolRegistry, { providerAdapter });

    t.after(() => {
        scheduler.dispose();
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {}
    });

    // 1. Typed request completes a dependent multi-step task
    await t.test('Scenario 1: Typed request completes a dependent multi-step task', async () => {
        const typedRequest = 'Create file report.txt with content "Initial Findings" and read it back';
        const result = await coordinator.executeRequest(typedRequest);

        assert.equal(result.ok, true, 'Multi-step task must complete successfully');
        assert.equal(result.status, 'completed');
        assert.equal(result.lifecycleState, TASK_STATES.COMPLETED);
        assert.equal(result.executedSteps.length, 2, 'Must have planned and executed 2 steps');

        // Step 1: Write file
        assert.equal(result.executedSteps[0].toolId, 'file_write');
        assert.equal(result.executedSteps[0].verified, true);

        // Step 2: Read file (dependent on step 1)
        assert.equal(result.executedSteps[1].toolId, 'file_read');
        assert.equal(result.executedSteps[1].verified, true);
        assert.equal(result.executedSteps[1].result.result.content, 'Initial Findings');

        assert.equal(result.verification.verified, true);
        assert.equal(result.verification.allStepsVerified, true);
    });

    // 2. Voice request enters the same task pipeline
    await t.test('Scenario 2: Voice request enters the same task pipeline', async () => {
        let coordinatorInvoked = false;
        let spokenOutput = null;

        const fakeSynthesis = {
            supported: true,
            isSpeaking: false,
            speak: async (text) => {
                spokenOutput = text;
                return true;
            },
            stop: () => {}
        };

        const voiceController = new VoiceController({
            ttsEnabled: true,
            recognitionMode: RECOGNITION_MODES.AUTO,
            onFinalTranscript: async (transcript) => {
                coordinatorInvoked = true;
                const res = await coordinator.executeRequest(transcript);
                if (res.replyText) {
                    await voiceController.speakResponse(res.replyText);
                }
            }
        });
        voiceController.synthesis = fakeSynthesis;

        // Simulate incoming final speech recognition event
        const spokenCommand = 'Inspect system status';
        await voiceController.onFinalTranscript(spokenCommand);

        assert.equal(coordinatorInvoked, true, 'Voice request must reach the exact same coordinator');
        assert.ok(spokenOutput, 'Assistant must synthesize spoken audio response');
        assert.ok(spokenOutput.includes('Completed'), 'Spoken output must reflect completion');
    });

    // 3. Screenshot interpretation informs a follow-up step
    await t.test('Scenario 3: Screenshot interpretation informs a follow-up step', async () => {
        const sampleBase64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

        // Mock multimodal provider completion
        const originalComplete = providerAdapter.complete.bind(providerAdapter);
        let capturedMessage = null;

        providerAdapter.complete = async (req) => {
            capturedMessage = req.messages;
            return {
                ok: true,
                content: 'EXACT_IMAGE_ANALYSIS_TOKEN_99',
                provider: 'gemini',
                model: 'gemini-2.0-flash',
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        };

        // Construct a plan where step 2 consumes step 1's visual analysis
        const visualPlan = {
            objective: 'Inspect screenshot and write analysis to file',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Inspect image visually',
                    toolId: 'visual_inspect',
                    params: {
                        prompt: 'Read the token in this image',
                        imageBase64: sampleBase64Image
                    }
                },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Write visual findings to disk',
                    toolId: 'file_write',
                    params: {
                        path: 'vision_findings.txt',
                        content: '{{step_1.result.analysis}}'
                    },
                    dependsOn: ['step_1']
                }
            ]
        };

        const originalPlan = coordinator.planner.plan.bind(coordinator.planner);
        coordinator.planner.plan = async () => visualPlan;

        const res = await coordinator.executeRequest('Inspect visual state and save findings');

        coordinator.planner.plan = originalPlan;
        providerAdapter.complete = originalComplete;

        assert.equal(res.ok, true);
        assert.equal(res.executedSteps.length, 2);

        // Verify image data reached provider adapter
        assert.ok(capturedMessage, 'Multimodal message must reach provider adapter');
        const userMsg = capturedMessage.find(m => m.role === 'user');
        assert.ok(userMsg && userMsg.images && userMsg.images.length > 0, 'Image payload must be delivered');

        // Verify analysis was interpolated into step 2 and written to disk
        const writtenContent = fs.readFileSync(path.join(testDir, 'vision_findings.txt'), 'utf8');
        assert.equal(writtenContent, 'EXACT_IMAGE_ANALYSIS_TOKEN_99', 'Model visual analysis must inform subsequent step');
    });

    // 4. A tool failure triggers safe bounded recovery
    await t.test('Scenario 4: A tool failure triggers safe bounded recovery', async () => {
        let attempts = 0;
        toolRegistry.registerTool({
            id: 'unstable_transient_tool',
            name: 'Transient Failing Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: {} },
            handler: async () => {
                attempts++;
                if (attempts === 1) {
                    return { ok: false, status: 'error', error: 'ETIMEDOUT: Connection timed out to remote socket' };
                }
                return { ok: true, status: 'completed', data: { recovered: true } };
            }
        });

        const transientPlan = {
            objective: 'Execute transient operation with recovery',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Transient call',
                    toolId: 'unstable_transient_tool',
                    params: {}
                }
            ]
        };

        const originalPlan = coordinator.planner.plan.bind(coordinator.planner);
        coordinator.planner.plan = async () => transientPlan;

        const res = await coordinator.executeRequest('Run transient operation');
        coordinator.planner.plan = originalPlan;

        assert.equal(res.ok, true, 'Should successfully recover after transient failure');
        assert.equal(attempts, 2, 'Should execute 1 retry (2 total attempts)');
        assert.ok(res.executedSteps[0].recovery, 'Recovery receipt must be attached');
        assert.equal(res.executedSteps[0].recovery.recovered, true);
        assert.equal(res.executedSteps[0].recovery.attempts, 1);
    });

    // 5. Failed verification prevents false completion
    await t.test('Scenario 5: Failed verification prevents false completion', async () => {
        toolRegistry.registerTool({
            id: 'dishonest_phantom_tool',
            name: 'Phantom Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: {} },
            handler: async () => {
                // Claims ok: true, but targets non-existent file
                return { ok: true, status: 'completed', path: path.join(testDir, 'non_existent_file.txt') };
            }
        });

        const phantomPlan = {
            objective: 'Phantom tool execution',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Perform phantom write',
                    toolId: 'dishonest_phantom_tool',
                    params: { path: 'non_existent_file.txt' }
                }
            ]
        };

        // Custom verifier returns verified: false because file is missing
        const originalVerify = coordinator.resultVerifier.verify.bind(coordinator.resultVerifier);
        coordinator.resultVerifier.verify = async (step, result) => {
            if (step.toolId === 'dishonest_phantom_tool') {
                return { verified: false, failureReason: 'Evidence check failed: file does not exist on disk' };
            }
            return originalVerify(step, result);
        };

        const originalPlan = coordinator.planner.plan.bind(coordinator.planner);
        coordinator.planner.plan = async () => phantomPlan;

        const res = await coordinator.executeRequest('Execute phantom write');
        coordinator.planner.plan = originalPlan;
        coordinator.resultVerifier.verify = originalVerify;

        assert.equal(res.ok, false, 'Failed verification must prevent task from reporting success');
        assert.equal(res.status, 'failed');
        assert.equal(res.verification.verified, false);
    });

    // 6. Missing authorization blocks execution
    await t.test('Scenario 6: Missing authorization blocks execution', async () => {
        // Enforce STANDARD mode with user denying permission
        permissionAuth.setMode(PERMISSION_MODES.STANDARD);
        permissionAuth.setConfirmationHandler(async () => false); // Denied!

        const deletePlan = {
            objective: 'Delete confidential file',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Delete file',
                    toolId: 'file_delete',
                    params: { path: 'report.txt' }
                }
            ]
        };

        const originalPlan = coordinator.planner.plan.bind(coordinator.planner);
        coordinator.planner.plan = async () => deletePlan;

        const res = await coordinator.executeRequest('Delete file report.txt');
        coordinator.planner.plan = originalPlan;
        permissionAuth.setMode(PERMISSION_MODES.AUTONOMOUS_SANDBOX);

        assert.equal(res.ok, false, 'Denied authorization must halt execution');
        assert.equal(res.executedSteps[0].result.status, 'permission_denied');
        assert.equal(fs.existsSync(path.join(testDir, 'report.txt')), true, 'File must not be deleted');
    });

    // 7. Cancellation prevents subsequent steps
    await t.test('Scenario 7: Cancellation prevents subsequent steps', async () => {
        let step2Executed = false;

        toolRegistry.registerTool({
            id: 'cancellable_step_1',
            name: 'Step 1',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: {} },
            handler: async (_p, ctx) => {
                // Cancel active task while step 1 is finishing
                coordinator.cancelTask(ctx.taskId, 'User clicked stop button');
                return { ok: true, status: 'completed' };
            }
        });

        toolRegistry.registerTool({
            id: 'cancellable_step_2',
            name: 'Step 2',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: {} },
            handler: async () => {
                step2Executed = true;
                return { ok: true };
            }
        });

        const cancelPlan = {
            objective: 'Task to be cancelled',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'cancellable_step_1', params: {} },
                { id: 'step_2', index: 2, title: 'Step 2', toolId: 'cancellable_step_2', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const originalPlan = coordinator.planner.plan.bind(coordinator.planner);
        coordinator.planner.plan = async () => cancelPlan;

        const res = await coordinator.executeRequest('Run cancellable task');
        coordinator.planner.plan = originalPlan;

        assert.equal(res.ok, false);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.cancelled, true);
        assert.equal(step2Executed, false, 'Subsequent steps must NEVER execute after cancellation');
    });

    // 8. Restart recovery does not duplicate a side effect
    await t.test('Scenario 8: Restart recovery does not duplicate a side effect', async () => {
        const taskId = `resume_test_${Date.now()}`;
        let sideEffectExecutions = 0;

        toolRegistry.registerTool({
            id: 'consequential_side_effect_tool',
            name: 'Side Effect Tool',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            schema: { type: 'object', properties: {} },
            handler: async () => {
                sideEffectExecutions++;
                return { ok: true, status: 'completed' };
            }
        });

        toolRegistry.registerTool({
            id: 'pending_step_tool',
            name: 'Pending Step Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: {} },
            handler: async () => {
                return { ok: true, status: 'completed', data: 'done' };
            }
        });

        // Seed a checkpoint where Step 1 completed, but the task was interrupted before Step 2
        taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest: 'Perform multi-phase operation',
            plan: {
                steps: [
                    { stepIndex: 0, index: 1, title: 'Step 1 Consequential', toolId: 'consequential_side_effect_tool', params: {} },
                    { stepIndex: 1, index: 2, title: 'Step 2 Read', toolId: 'pending_step_tool', params: {} }
                ]
            },
            completedSteps: [
                { stepIndex: 0, index: 1, toolId: 'consequential_side_effect_tool', verified: true, result: { ok: true } }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        // Inspect and resume
        const inspection = coordinator.inspectTask(taskId);
        assert.equal(inspection.completedCount, 1);
        assert.equal(inspection.pendingCount, 1);
        assert.equal(inspection.pendingSteps[0].toolId, 'pending_step_tool');

        const resumeRes = await coordinator.resumeTask(taskId);
        assert.equal(resumeRes.ok, true);
        assert.equal(sideEffectExecutions, 0, 'Completed consequential step 1 must NOT be re-executed');
    });

    // 9. Student workflow produces a verified file
    await t.test('Scenario 9: Student workflow produces a verified file', async () => {
        const guideResult = await toolRegistry.execute('student_synthesize_study_guide', {
            subject: 'Distributed Systems',
            notesContent: 'Raft consensus algorithm uses leader election and log replication.',
            outputFileName: 'Study_Guide_Distributed_Systems.md'
        });

        assert.equal(guideResult.ok, true);
        assert.equal(guideResult.status, 'completed');

        const guidePath = path.join(testDir, 'Study_Guide_Distributed_Systems.md');
        assert.equal(fs.existsSync(guidePath), true, 'Study guide file must be created on disk');

        const fileContent = fs.readFileSync(guidePath, 'utf8');
        assert.ok(fileContent.includes('Study Guide: Distributed Systems'));
        assert.ok(fileContent.includes('Raft consensus'));

        // Verify ResultVerifier also accepts and corroborates the artifact
        const ver = await resultVerifier.verify(
            { toolId: 'student_synthesize_study_guide', params: { outputFileName: 'Study_Guide_Distributed_Systems.md' } },
            guideResult
        );
        assert.equal(ver.verified, true);
    });

    // 10. Reminder creation, persistence, delivery, and cancellation
    await t.test('Scenario 10: Reminder creation, persistence, delivery, and cancellation', async () => {
        const reminderPrompt = 'Submit lab assignment before midnight';

        // 1. Schedule reminder via tool registry
        const schedRes = await toolRegistry.execute('schedule_reminder', {
            prompt: reminderPrompt,
            delayMs: 60000
        });
        assert.equal(schedRes.ok, true);
        const jobId = schedRes.result.job.id;

        // 2. Prevent duplicate reminder
        const duplicateRes = await toolRegistry.execute('schedule_reminder', {
            prompt: reminderPrompt,
            delayMs: 60000
        });
        assert.equal(duplicateRes.ok, true);
        assert.equal(duplicateRes.result.job.id, jobId, 'Identical reminder must be deduplicated to same job ID');

        // 3. Verify persistence across scheduler instances
        const newScheduler = new Scheduler({
            storageDir: path.join(testDir, 'memory'),
            clock: { now: () => Date.now() }
        });
        const loadedJob = newScheduler.getJob(jobId);
        assert.ok(loadedJob, 'Scheduled job must persist across scheduler reload');
        assert.equal(loadedJob.prompt, reminderPrompt);
        assert.equal(loadedJob.status, JOB_STATUS.SCHEDULED);

        // 4. Cancel reminder
        const cancelRes = await toolRegistry.execute('cancel_reminder', { id: jobId });
        assert.equal(cancelRes.ok, true);
        assert.equal(cancelRes.result.cancelled, true);

        const afterCancel = scheduler.getJob(jobId);
        assert.equal(afterCancel.status, JOB_STATUS.CANCELLED);
        newScheduler.dispose();
    });

    // 11. Provider outage returns an honest actionable error
    await t.test('Scenario 11: Provider outage returns an honest actionable error', async () => {
        credStore.setSecret('gemini_api_key', 'valid-format-key-for-outage-test');

        const originalComplete = providerAdapter.complete.bind(providerAdapter);
        providerAdapter.complete = async () => {
            return {
                ok: false,
                code: 'http_503',
                error: 'Gemini API returned HTTP 503: Service Unavailable'
            };
        };

        const res = await coordinator.executeRequest('Explain quantum computing');
        providerAdapter.complete = originalComplete;
        credStore.deleteSecret('gemini_api_key');

        assert.equal(res.ok, false);
        assert.equal(res.status, 'provider_error');
        assert.ok(res.error.includes('503') || res.error.includes('Service Unavailable'), 'Must surface exact provider outage');
    });

    // 12. Partial completion is represented accurately
    await t.test('Scenario 12: Partial completion is represented accurately', async () => {
        toolRegistry.registerTool({
            id: 'successful_step_tool',
            name: 'Success Step',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: {} },
            handler: async () => ({ ok: true, status: 'completed' })
        });

        toolRegistry.registerTool({
            id: 'failing_step_tool',
            name: 'Failing Step',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: {} },
            handler: async () => ({ ok: false, error: 'Command execution crashed' })
        });

        const partialPlan = {
            objective: 'Compound task with partial success',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1 (Succeeds)', toolId: 'successful_step_tool', params: {} },
                { id: 'step_2', index: 2, title: 'Step 2 (Fails)', toolId: 'failing_step_tool', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const originalPlan = coordinator.planner.plan.bind(coordinator.planner);
        coordinator.planner.plan = async () => partialPlan;

        const res = await coordinator.executeRequest('Run partial task');
        coordinator.planner.plan = originalPlan;

        assert.equal(res.ok, false);
        assert.equal(res.partiallyCompleted, true, 'partiallyCompleted must be true');
        assert.equal(res.lifecycleState, TASK_STATES.PARTIALLY_COMPLETED);
        assert.equal(res.executedSteps.length, 2);
        assert.equal(res.executedSteps[0].verified, true);
        assert.equal(res.executedSteps[1].verified, false);
    });

    // 13. Unavailable offline speech assets are reported honestly
    await t.test('Scenario 13: Unavailable offline speech assets are reported honestly', async () => {
        let reportedError = null;

        const voiceController = new VoiceController({
            recognitionMode: RECOGNITION_MODES.OFFLINE,
            whisperEngine: {
                isAvailable: () => false,
                getStatus: () => ({ isAvailable: false, error: 'whisper.cpp executable missing' })
            },
            onError: (err) => {
                reportedError = err;
            }
        });

        const started = voiceController.startListening();
        assert.equal(started, false, 'Cannot start listening when offline runtime is unavailable');
        assert.ok(reportedError, 'Error callback must be invoked');
        assert.equal(reportedError.code, 'OFFLINE_UNAVAILABLE');
        assert.ok(reportedError.message.includes('whisper.cpp binary or model weights not detected'));
    });

    // 14. UI progress reflects actual task state
    await t.test('Scenario 14: UI progress reflects actual task state', async () => {
        const observedStates = [];
        const listener = (event) => {
            observedStates.push(event.to || event.state);
        };

        statusManager.on('stateChanged', listener);

        const request = 'Inspect system status';
        await coordinator.executeRequest(request);

        statusManager.off('stateChanged', listener);

        assert.ok(observedStates.includes(TASK_STATES.PLANNING), 'Must transition through PLANNING');
        assert.ok(observedStates.includes(TASK_STATES.READY), 'Must transition through READY');
        assert.ok(observedStates.includes(TASK_STATES.RUNNING), 'Must transition through RUNNING');
        assert.ok(observedStates.includes(TASK_STATES.EXECUTING_TOOL), 'Must transition through EXECUTING_TOOL');
        assert.ok(observedStates.includes(TASK_STATES.VERIFYING), 'Must transition through VERIFYING');
        assert.ok(observedStates.includes(TASK_STATES.COMPLETED), 'Must finish in COMPLETED');
    });
});
