'use strict';

/**
 * L.U.C.Y. Phase 9 Acceptance Test Suite:
 * Reliable Autonomous Workflows & Real-World Task Completion
 * 
 * Verifies:
 * 1. Capability A: Goal-directed task planning & missing parameter clarification
 * 2. Capability B: End-to-end multi-step workflow execution (Research & Save, Cross-App, Workspace Audit)
 * 3. Capability C: Obstacle recovery with active state reobservation without restarting completed steps
 * 4. Capability D: Intelligent tool selection and deterministic parameter interpolation
 * 5. Capability E: Transparent task continuity and progress reporting (getTaskProgress)
 * 6. Capability F: Safe handling of consequential actions, fail-closed uncertainty, and immediate cancellation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const EventEmitter = require('events');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES } = require('../../src/core/task-status.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');
const { registerSystemTools } = require('../../src/tools/system-tools.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { TaskRecoveryEngine, FAILURE_TYPES, RECOVERY_STRATEGIES } = require('../../src/core/recovery-engine.js');

class MockWorkerProcess extends EventEmitter {
    constructor() {
        super();
        this.stdin = {
            write: (chunk) => {
                const lines = chunk.toString('utf8').split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const req = JSON.parse(line.trim());
                        this.handleRequest(req);
                    } catch (_) {}
                }
            }
        };
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.handlers = new Map();
        this.receivedCommands = [];
    }

    setHandler(action, handler) {
        this.handlers.set(action, handler);
    }

    handleRequest(req) {
        this.receivedCommands.push(req);
        const action = req.action;
        const handler = this.handlers.get(action);
        if (handler) {
            const res = handler(req);
            process.nextTick(() => {
                this.stdout.emit('data', Buffer.from(JSON.stringify(res) + '\n'));
            });
        } else {
            process.nextTick(() => {
                this.stdout.emit('data', Buffer.from(JSON.stringify({
                    requestId: req.requestId,
                    ok: true,
                    action,
                    status: 'success'
                }) + '\n'));
            });
        }
    }
}

function createTestHarness(customOptions = {}) {
    const testDir = path.join(os.tmpdir(), `lucy-phase9-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const credStore = new CredentialStore({ storeDir: path.join(testDir, 'creds') });
    const permissionAuth = new PermissionAuthority({
        mode: PERMISSION_MODES.STANDARD,
        workspaceRoot: testDir,
        confirmationHandler: async (req) => ({ confirmed: true, userAuthorizedDiscard: false })
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
    const continuityStore = new TaskContinuityStore({ storeDir: path.join(testDir, 'memory') });

    // Mock Desktop Automation Manager
    const mockWorker = new MockWorkerProcess();
    const desktopManager = {
        mockWorker,
        activeApps: new Map([
            ['app_notepad_1', { appId: 'app_notepad_1', executable: 'notepad.exe', pid: 1234, title: 'Untitled - Notepad' }]
        ]),
        launchApp: async (executable, opts) => {
            const appId = `app_notepad_${Date.now()}`;
            desktopManager.activeApps.set(appId, { appId, executable, pid: 1234, title: 'Untitled - Notepad' });
            return { ok: true, appId, status: 'launched', title: 'Untitled - Notepad', pid: 1234 };
        },
        inspectControl: async (target, opts) => {
            return { ok: true, responsive: true, ready: true, controlFound: true, controlType: opts?.controlType || 'Edit' };
        },
        typeText: async (target, text, opts) => {
            return { ok: true, status: 'typed', text, target, verified: true };
        },
        saveDocument: async (target, filePath, opts) => {
            const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(testDir, filePath);
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            fs.writeFileSync(resolvedPath, opts?.expectedContent || 'Saved text from desktop', 'utf8');
            return { ok: true, saved: true, path: filePath, fullPath: resolvedPath };
        },
        closeApp: async (target, opts) => {
            return { ok: true, closed: true, target };
        }
    };

    // Mock Browser Manager
    const browserManager = {
        currentPage: { url: 'https://example.com' },
        navigate: async (url, opts) => {
            browserManager.currentPage = { url };
            return { ok: true, status: 'navigated', url };
        },
        extract: async (selector, opts) => {
            const text = 'Extracted factual research content from web';
            return { ok: true, status: 'extraction_success', content: text, text, selector };
        },
        getCurrentPageInfo: async () => {
            return { ok: true, url: browserManager.currentPage.url, readyState: 'complete' };
        }
    };

    // Register desktop and browser tools in tool registry
    toolRegistry.registerTool({
        id: 'desktop_launch_app',
        name: 'Launch Desktop App',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: { type: 'object', properties: { executable: { type: 'string' } }, required: ['executable'] },
        handler: async (p, ctx) => desktopManager.launchApp(p.executable, ctx)
    });

    toolRegistry.registerTool({
        id: 'desktop_inspect_control',
        name: 'Inspect Desktop Control',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        handler: async (p, ctx) => desktopManager.inspectControl(p.target, ctx)
    });

    toolRegistry.registerTool({
        id: 'desktop_type_text',
        name: 'Type Desktop Text',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'] },
        handler: async (p, ctx) => desktopManager.typeText(p.target, p.text, ctx)
    });

    toolRegistry.registerTool({
        id: 'desktop_save_document',
        name: 'Save Desktop Document',
        riskTier: RISK_TIERS.CONSEQUENTIAL,
        schema: { type: 'object', properties: { target: { type: 'string' }, filePath: { type: 'string' } }, required: ['target', 'filePath'] },
        handler: async (p, ctx) => desktopManager.saveDocument(p.target, p.filePath, { ...ctx, expectedContent: p.expectedContent })
    });

    toolRegistry.registerTool({
        id: 'browser_navigate',
        name: 'Browser Navigate',
        riskTier: RISK_TIERS.NETWORK_READ,
        schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        handler: async (p, ctx) => browserManager.navigate(p.url, ctx)
    });

    toolRegistry.registerTool({
        id: 'browser_extract',
        name: 'Browser Extract',
        riskTier: RISK_TIERS.NETWORK_READ,
        schema: { type: 'object', properties: { selector: { type: 'string' } } },
        handler: async (p, ctx) => browserManager.extract(p.selector, ctx)
    });

    const coordinator = new TaskCoordinator({
        statusManager,
        permissionAuthority: permissionAuth,
        toolRegistry,
        providerAdapter,
        desktopManager,
        browserManager,
        workspaceRoot: testDir,
        memoryDir: path.join(testDir, 'memory'),
        taskContinuityStore: continuityStore,
        ...customOptions
    });
    coordinator.setCompanionBridge(companionBridge);

    const cleanup = () => {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    };

    return {
        testDir,
        coordinator,
        toolRegistry,
        permissionAuth,
        statusManager,
        companionBridge,
        continuityStore,
        desktopManager,
        browserManager,
        cleanup
    };
}

test('L.U.C.Y. Phase 9 Acceptance Tests', async (t) => {

    await t.test('Criterion 1: Capability A — Goal-directed Planning and Clarification', async () => {
        const { coordinator, cleanup } = createTestHarness();
        try {
            // Case 1A: Underspecified research query asks focused clarification instead of hallucinating target path
            const clarificationRes = await coordinator.planner.plan('research quantum computing and save');
            assert.equal(clarificationRes.type, 'clarification');
            assert.ok(clarificationRes.replyText.includes('Where would you like me to save'));
            assert.deepEqual(clarificationRes.missingParameters, ['destination_path']);

            // Case 1B: Underspecified workspace audit asks clarification for path and pattern
            const auditClarification = await coordinator.planner.plan('audit workspace');
            assert.equal(auditClarification.type, 'clarification');
            assert.ok(auditClarification.replyText.includes('Please specify the directory path'));
            assert.deepEqual(auditClarification.missingParameters, ['directory', 'pattern']);

            // Case 1C: Complete goal translates into structured 4-step DAG
            const planRes = await coordinator.planner.plan('research artificial intelligence on the web, extract summary facts, save to ai_summary.txt, and verify');
            assert.equal(planRes.type, 'plan');
            assert.equal(planRes.steps.length, 4);
            assert.equal(planRes.steps[0].toolId, 'browser_navigate');
            assert.equal(planRes.steps[1].toolId, 'browser_extract');
            assert.equal(planRes.steps[2].toolId, 'file_write');
            assert.equal(planRes.steps[3].toolId, 'file_read');
            assert.equal(planRes.steps[2].params.content, '{{step_2.result.text}}');
        } finally {
            cleanup();
        }
    });

    await t.test('Criterion 2: Capability B — Workflow 1: Research and Save with Verified Disk Outcome', async () => {
        const { coordinator, testDir, cleanup } = createTestHarness();
        try {
            const request = 'research robotics on the web, extract facts, save to research/robotics_facts.txt, and verify';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, true, `Workflow execution must succeed: ${result.error || ''}`);
            assert.equal(result.status, 'completed');
            assert.equal(result.executedSteps.length, 4);
            assert.equal(result.verification.verified, true);
            assert.equal(result.verification.allStepsVerified, true);

            // Verify intermediate data flow
            const writeStep = result.executedSteps[2];
            assert.equal(writeStep.toolId, 'file_write');
            assert.equal(writeStep.params.path, 'research/robotics_facts.txt');
            assert.equal(writeStep.params.content, 'Extracted factual research content from web');

            // Verify final outcome on disk
            const savedPath = path.join(testDir, 'research', 'robotics_facts.txt');
            assert.ok(fs.existsSync(savedPath), 'Saved file must exist on disk');
            const savedContent = fs.readFileSync(savedPath, 'utf8');
            assert.equal(savedContent, 'Extracted factual research content from web');

            // Check progress report
            const progress = coordinator.getTaskProgress(result.taskId);
            assert.equal(progress.ok, true);
            assert.equal(progress.status, 'completed');
            assert.equal(progress.completedAndVerifiedSteps.length, 4);
            assert.equal(progress.remainingSteps.length, 0);
            assert.equal(progress.isBlocked, false);
            assert.equal(progress.canSafelyResume, false);
        } finally {
            cleanup();
        }
    });

    await t.test('Criterion 3: Capability B — Workflow 2: Cross-Application Information Transfer', async () => {
        const { coordinator, testDir, cleanup } = createTestHarness();
        try {
            const request = 'extract information from https://example.com/data, enter into Notepad, save document to notes/extracted_data.txt, and verify';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, true, `Cross-app workflow must succeed: ${result.error || ''}`);
            assert.equal(result.status, 'completed');
            assert.equal(result.executedSteps.length, 7);

            // Check step sequence:
            // 1: browser_navigate
            // 2: browser_extract
            // 3: desktop_launch_app
            // 4: desktop_inspect_control
            // 5: desktop_type_text
            // 6: desktop_save_document
            // 7: file_read
            assert.equal(result.executedSteps[0].toolId, 'browser_navigate');
            assert.equal(result.executedSteps[1].toolId, 'browser_extract');
            assert.equal(result.executedSteps[2].toolId, 'desktop_launch_app');
            assert.equal(result.executedSteps[3].toolId, 'desktop_inspect_control');
            assert.equal(result.executedSteps[4].toolId, 'desktop_type_text');
            assert.equal(result.executedSteps[5].toolId, 'desktop_save_document');
            assert.equal(result.executedSteps[6].toolId, 'file_read');

            // Verify parameter resolution of dynamic data
            const typeStep = result.executedSteps[4];
            assert.equal(typeStep.params.text, 'Extracted factual research content from web');

            // Verify final disk persistence
            const savedPath = path.join(testDir, 'notes', 'extracted_data.txt');
            assert.ok(fs.existsSync(savedPath));
            assert.equal(fs.readFileSync(savedPath, 'utf8'), 'Extracted factual research content from web');
        } finally {
            cleanup();
        }
    });

    await t.test('Criterion 4: Capability B — Workflow 3: Workspace Task Organization and File Audit', async () => {
        const { coordinator, testDir, cleanup } = createTestHarness();
        try {
            // Seed workspace files
            const docsDir = path.join(testDir, 'docs');
            fs.mkdirSync(docsDir, { recursive: true });
            fs.writeFileSync(path.join(docsDir, 'report_q1.txt'), 'Q1 Performance Summary', 'utf8');

            const request = 'organize files: copy docs/report_q1.txt to backup/archive_q1.txt and verify';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, true, `Organization workflow must succeed: ${result.error || ''}`);
            assert.equal(result.status, 'completed');
            assert.equal(result.executedSteps.length, 3);
            assert.equal(result.executedSteps[0].toolId, 'file_mkdir');
            assert.equal(result.executedSteps[1].toolId, 'file_copy');
            assert.equal(result.executedSteps[2].toolId, 'file_read');

            const backupFile = path.join(testDir, 'backup', 'archive_q1.txt');
            assert.ok(fs.existsSync(backupFile));
            assert.equal(fs.readFileSync(backupFile, 'utf8'), 'Q1 Performance Summary');
        } finally {
            cleanup();
        }
    });

    await t.test('Criterion 5: Capability C — Obstacle Recovery with Active Reobservation without Replaying Prerequisite Steps', async () => {
        const { coordinator, toolRegistry, cleanup } = createTestHarness();
        try {
            let attemptCount = 0;
            let reobservedCalls = 0;

            // Register a flaky tool that fails on first attempt with transient readiness error
            toolRegistry.registerTool({
                id: 'flaky_desktop_tool',
                name: 'Flaky Desktop Control',
                riskTier: RISK_TIERS.SAFE_READ,
                schema: { type: 'object', properties: { target: { type: 'string' } } },
                handler: async (p) => {
                    attemptCount++;
                    if (attemptCount === 1) {
                        return { ok: false, error: 'Target window control temporarily unavailable; not ready' };
                    }
                    return { ok: true, status: 'control_invoked', attemptCount };
                }
            }, { allowOverride: true });

            let step1Executions = 0;
            toolRegistry.registerTool({
                id: 'reliable_step1_tool',
                name: 'Reliable Prerequisite Step',
                riskTier: RISK_TIERS.SAFE_READ,
                schema: { type: 'object', properties: {} },
                handler: async () => {
                    step1Executions++;
                    return { ok: true, status: 'step1_complete' };
                }
            }, { allowOverride: true });

            const plan = {
                objective: 'Execute multi-step task with transient obstacle recovery',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: 'Execute Prerequisite Step',
                        toolId: 'reliable_step1_tool',
                        params: {}
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: 'Execute Flaky Step with Reobservation',
                        toolId: 'flaky_desktop_tool',
                        params: { target: 'notepad' },
                        dependsOn: ['step_1'],
                        reobserve: async (step, failure) => {
                            reobservedCalls++;
                            return { reobservedState: 'window_now_ready', failureReason: failure.reason };
                        }
                    }
                ]
            };

            coordinator.planner.plan = async () => plan;

            const result = await coordinator.executeRequest('run obstacle test');
            assert.equal(result.ok, true, 'Workflow should recover and complete');
            assert.equal(result.status, 'completed');
            assert.equal(result.executedSteps.length, 2);

            // Crucial verification: Prerequisite step was executed EXACTLY ONCE
            assert.equal(step1Executions, 1, 'Prerequisite step must NOT be replayed on subsequent retry!');

            // Flaky step executed twice (failed once, recovered on retry 2)
            assert.equal(attemptCount, 2, 'Flaky tool should have executed initial attempt + 1 retry');

            // Reobservation hook was invoked before retry
            assert.equal(reobservedCalls, 1, 'Reobservation hook must be invoked prior to retry');

            const recoveryReceipt = result.executedSteps[1].recovery;
            assert.ok(recoveryReceipt, 'Recovery receipt must be recorded');
            assert.equal(recoveryReceipt.recovered, true);
            assert.equal(recoveryReceipt.reobserved, true);
            assert.equal(recoveryReceipt.attempts, 1);
        } finally {
            cleanup();
        }
    });

    await t.test('Criterion 6: Capability F — Consequential Timeout Outcome Halts Fail-Closed as Uncertain', async () => {
        const { coordinator, toolRegistry, cleanup } = createTestHarness();
        try {
            toolRegistry.registerTool({
                id: 'consequential_timeout_tool',
                name: 'Consequential External Action',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                schema: { type: 'object', properties: {} },
                handler: async () => {
                    return { ok: false, timedOut: true, error: 'Network request timed out with in-flight side effects' };
                }
            }, { allowOverride: true });

            const plan = {
                objective: 'Execute consequential action with timeout',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: 'Consequential Step',
                        toolId: 'consequential_timeout_tool',
                        isConsequential: true,
                        params: {}
                    }
                ]
            };
            coordinator.planner.plan = async () => plan;

            const result = await coordinator.executeRequest('run timeout test');
            assert.equal(result.ok, false);
            assert.equal(result.uncertain, true, 'Outcome must be flagged as uncertain');
            assert.equal(result.lifecycleState, TASK_STATES.AWAITING_RECONCILIATION);

            // Progress report should indicate task is blocked awaiting user reconciliation
            const progress = coordinator.getTaskProgress(result.taskId);
            assert.equal(progress.isBlocked, true);
            assert.equal(progress.hasUncertainOutcome, true);
            assert.equal(progress.needsUserInput, true);
            assert.equal(progress.canSafelyResume, false, 'Uncertain task cannot safely resume without reconciliation');
        } finally {
            cleanup();
        }
    });

    await t.test('Criterion 7: Capability F — Immediate Task Cancellation Preserves Verified Checkpoints', async () => {
        const { coordinator, toolRegistry, cleanup } = createTestHarness();
        try {
            let step1Done = false;
            let step2Started = false;

            toolRegistry.registerTool({
                id: 'step1_tool',
                name: 'Step 1 Tool',
                riskTier: RISK_TIERS.SAFE_READ,
                schema: { type: 'object' },
                handler: async () => {
                    step1Done = true;
                    return { ok: true, status: 'step1_done' };
                }
            }, { allowOverride: true });

            toolRegistry.registerTool({
                id: 'step2_long_tool',
                name: 'Step 2 Long Tool',
                riskTier: RISK_TIERS.SAFE_READ,
                schema: { type: 'object' },
                handler: async (p, ctx) => {
                    step2Started = true;
                    // Cancel during step 2 execution
                    coordinator.cancelTask(ctx.taskId, 'User clicked stop button');
                    await new Promise((r) => setTimeout(r, 80));
                    return { ok: true, status: 'step2_done' };
                }
            }, { allowOverride: true });

            toolRegistry.registerTool({
                id: 'step3_tool',
                name: 'Step 3 Tool',
                riskTier: RISK_TIERS.SAFE_READ,
                schema: { type: 'object' },
                handler: async () => {
                    throw new Error('Step 3 must never be executed after cancellation!');
                }
            }, { allowOverride: true });

            const plan = {
                objective: 'Test cancellation pipeline',
                type: 'plan',
                steps: [
                    { index: 1, id: 'step_1', title: 'Step 1', toolId: 'step1_tool', params: {} },
                    { index: 2, id: 'step_2', title: 'Step 2', toolId: 'step2_long_tool', params: {}, dependsOn: ['step_1'] },
                    { index: 3, id: 'step_3', title: 'Step 3', toolId: 'step3_tool', params: {}, dependsOn: ['step_2'] }
                ]
            };
            coordinator.planner.plan = async () => plan;

            const result = await coordinator.executeRequest('run cancel test');
            assert.equal(result.ok, false);
            assert.equal(result.cancelled, true);

            // Step 1 completed before cancellation
            assert.equal(step1Done, true);
            assert.equal(step2Started, true);

            // Step 3 was never dispatched
            const progress = coordinator.getTaskProgress(result.taskId);
            assert.equal(progress.status, TASK_STATUSES.CANCELLED);
            assert.equal(progress.completedAndVerifiedSteps.length, 1);
            assert.equal(progress.remainingSteps.length, 2);
            assert.ok(progress.whatIsDoingNow.includes('Cancelled by user'));
        } finally {
            cleanup();
        }
    });

    await t.test('Criterion 8: Capability E — Transparent Task Continuity Progress Reporting', async () => {
        const { coordinator, continuityStore, cleanup } = createTestHarness();
        try {
            const taskId = 'task_continuity_test_101';
            continuityStore.saveCheckpoint({
                taskId,
                userRequest: 'Transfer data from browser to notes and verify',
                plan: {
                    steps: [
                        { id: 'step_1', index: 1, title: 'Extract browser data', toolId: 'browser_extract' },
                        { id: 'step_2', index: 2, title: 'Open Notepad', toolId: 'desktop_launch_app' },
                        { id: 'step_3', index: 3, title: 'Type content into Notepad', toolId: 'desktop_type_text' },
                        { id: 'step_4', index: 4, title: 'Save Notepad file', toolId: 'desktop_save_document' }
                    ]
                },
                currentStepIndex: 2,
                completedSteps: [
                    { id: 'step_1', index: 1, title: 'Extract browser data', toolId: 'browser_extract', verified: true, result: { ok: true, status: 'extracted' } },
                    { id: 'step_2', index: 2, title: 'Open Notepad', toolId: 'desktop_launch_app', verified: true, result: { ok: true, status: 'launched' } }
                ],
                status: TASK_STATUSES.INTERRUPTED,
                error: 'Application session paused'
            });

            const progress = coordinator.getTaskProgress(taskId);
            assert.equal(progress.ok, true);
            assert.equal(progress.taskId, taskId);
            assert.equal(progress.status, TASK_STATUSES.INTERRUPTED);
            assert.equal(progress.completedAndVerifiedSteps.length, 2);
            assert.equal(progress.remainingSteps.length, 2);
            assert.equal(progress.remainingSteps[0].id, 'step_3');
            assert.equal(progress.remainingSteps[1].id, 'step_4');
            assert.equal(progress.canSafelyResume, true, 'Interrupted task with verified steps should safely resume');
            assert.ok(progress.humanReadableSummary.includes('Progress: 2 of 4 steps completed and verified'));
            assert.ok(progress.humanReadableSummary.includes('Can Safely Resume: Yes'));
        } finally {
            cleanup();
        }
    });

});
