'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { DesktopAutomationManager, SAFE_APP_ALLOWLIST, INTERACTION_MODES } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { ResultVerifier, VERIFICATION_STATUSES } = require('../../src/core/result-verifier.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { TaskRecoveryEngine } = require('../../src/core/recovery-engine.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { MemoryStore } = require('../../src/memory/memory-store.js');
const { TaskStatusManager, TASK_STATES } = require('../../src/core/task-status.js');
const { ContextBudgetManager } = require('../../src/core/context-budget.js');

/**
 * Deterministic Mock LucyUiaWorker process simulating native Windows UIA IPC responses.
 */
class MockWorkerProcess extends EventEmitter {
    constructor() {
        super();
        this.stdin = {
            write: (chunk) => this._handleInput(chunk)
        };
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.killed = false;
        this.handlers = new Map();
        this.defaultHandler = null;

        process.nextTick(() => {
            this._sendOutput({ status: 'ready', engine: 'Mock-Lucy-UIA', version: '1.0.0' });
        });
    }

    _sendOutput(obj) {
        this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
    }

    _handleInput(chunk) {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const req = JSON.parse(trimmed);
                if (req.cmd === 'init_session') {
                    this._sendOutput({ id: req.id, ok: true, result: { initialized: true } });
                    continue;
                }

                if (this.handlers.has(req.cmd)) {
                    const fn = this.handlers.get(req.cmd);
                    const res = fn(req);
                    if (res === undefined) {
                        // Simulate hanging/timeout by not responding
                        return;
                    }
                    if (res && res.__raw) {
                        this._sendOutput(res.payload);
                    } else if (res && res.error) {
                        this._sendOutput({ id: req.id, ok: false, error: res.error });
                    } else {
                        this._sendOutput({ id: req.id, ok: true, result: res });
                    }
                } else if (this.defaultHandler) {
                    const res = this.defaultHandler(req);
                    this._sendOutput({ id: req.id, ok: !res?.error, result: res?.result, error: res?.error });
                } else {
                    this._sendOutput({ id: req.id, ok: true, result: { verified: true } });
                }
            } catch (err) {
                this._sendOutput({ id: 0, ok: false, error: `Malformed worker JSON: ${err.message}` });
            }
        }
    }

    setHandler(cmd, fn) {
        this.handlers.set(cmd, fn);
    }

    kill() {
        this.killed = true;
        this.emit('close', 0);
    }
}

/**
 * Helper to build an isolated test environment with custom storage and mocked worker
 */
function createTestHarness(options = {}) {
    const testDir = path.join(os.tmpdir(), `lucy_workflow_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(testDir, { recursive: true });

    const mockProc = new MockWorkerProcess();
    const desktopManager = new DesktopAutomationManager({
        timeoutMs: options.timeoutMs || 2000,
        interactionMode: options.interactionMode || INTERACTION_MODES.NON_INTRUSIVE
    });
    desktopManager.proc = mockProc;
    desktopManager.isReady = true;
    desktopManager.readyPromise = Promise.resolve();

    mockProc.stdout.on('data', (chunk) => {
        desktopManager._handleStdout(chunk, () => {}, () => {}, null);
    });

    const toolRegistry = new ToolRegistry({ workspaceRoot: testDir });
    registerDesktopTools(toolRegistry, desktopManager);

    const taskContinuityStore = new TaskContinuityStore({ storeDir: path.join(testDir, 'checkpoints') });
    const memoryStore = new MemoryStore({ storeDir: path.join(testDir, 'memory') });
    const statusManager = new TaskStatusManager();
    const permissionAuthority = new PermissionAuthority({
        mode: PERMISSION_MODES.AUTO_ALLOW,
        workspaceRoot: testDir
    });
    const resultVerifier = new ResultVerifier();
    const recoveryEngine = new TaskRecoveryEngine({ maxRetries: 2, initialBackoffMs: 10, maxBackoffMs: 50 });
    const taskPlanner = new TaskPlanner({ toolRegistry });
    const budgetManager = new ContextBudgetManager();

    const coordinator = new TaskCoordinator({
        toolRegistry,
        statusManager,
        permissionAuthority,
        resultVerifier,
        recoveryEngine,
        taskPlanner,
        taskContinuityStore,
        memoryStore,
        budgetManager,
        workspaceRoot: testDir
    });

    const cleanup = () => {
        try { desktopManager.cleanup(); } catch (_) {}
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    };

    return {
        testDir,
        mockProc,
        desktopManager,
        toolRegistry,
        taskContinuityStore,
        memoryStore,
        statusManager,
        resultVerifier,
        taskPlanner,
        coordinator,
        cleanup
    };
}

test('L.U.C.Y. Phase 3: Desktop Workflow Execution & Verification Suite', async (suite) => {

    // =========================================================================
    // 1. Reference Workflow A: Open & Inspect Readiness without typing
    // =========================================================================
    await suite.test('Workflow A: Launch Notepad and inspect readiness without typing', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, desktopManager, cleanup } = harness;

        try {
            // Worker handlers for Launch and Inspect
            mockProc.setHandler('launch_app', (req) => {
                return {
                    appId: 'app_7890',
                    pid: 7890,
                    processStartTime: new Date().toISOString(),
                    windowHandle: 88881,
                    windowTitle: 'Untitled - Notepad'
                };
            });

            let controlFoundLogged = false;
            mockProc.setHandler('find_element', (req) => {
                controlFoundLogged = true;
                return {
                    found: true,
                    name: 'Text Editor',
                    automationId: '15',
                    controlType: 'Edit',
                    className: 'Edit',
                    windowHandle: 88881,
                    isEditable: true,
                    isEnabled: true
                };
            });

            mockProc.setHandler('inspect_ui', (req) => {
                return {
                    elements: [
                        { name: 'Text Editor', controlType: 'Edit', isEditable: true, isEnabled: true, automationId: '15' }
                    ]
                };
            });

            // Execute Workflow A compound instruction
            const request = 'Open Notepad and tell me whether it is ready for me to type.';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, true, 'Workflow A must succeed');
            assert.equal(result.status, 'completed', 'Workflow must complete');
            assert.equal(result.executedSteps.length, 2, 'Must execute exactly 2 steps');

            // Step 1: Launch
            const step1 = result.executedSteps[0];
            assert.equal(step1.toolId, 'desktop_launch_app');
            assert.equal(step1.verified, true);
            assert.equal(step1.result.appId, 'app_7890');
            assert.equal(step1.result.pid, 7890);

            // Step 2: Inspect Control
            const step2 = result.executedSteps[1];
            assert.equal(step2.toolId, 'desktop_inspect_control');
            assert.equal(step2.verified, true);
            assert.equal(step2.params.target, 'app_7890', 'Target must dynamically resolve to step 1 appId');
            assert.equal(step2.result.ready, true, 'Control must be reported as ready');
            assert.equal(step2.result.isEditable, true);
            assert.equal(step2.result.windowResponsive, true);
            assert.equal(step2.result.topLevelWindowFound, true);

            // Verify no typing occurred
            assert.equal(step2.result.textTyped, undefined);

            // Verify workflow execution record
            const record = coordinator.getWorkflowExecutionRecord(result.taskId);
            assert.ok(record);
            assert.equal(record.finalStatus, 'completed');
            assert.equal(record.targetApp.appId, 'app_7890');
            assert.equal(record.targetApp.pid, 7890);
            assert.equal(record.verifiedPostconditions.length, 2);
            assert.ok(record.summary.includes('2/2 steps verified'));
        } finally {
            cleanup();
        }
    });

    // =========================================================================
    // 2. Reference Workflow B: Enter & Verify Harmless Text
    // =========================================================================
    await suite.test('Workflow B: Enter harmless text and verify presence via readback', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, cleanup } = harness;

        try {
            mockProc.setHandler('launch_app', (req) => ({
                appId: 'app_5555',
                pid: 5555,
                processStartTime: new Date().toISOString(),
                windowHandle: 77771,
                windowTitle: 'Untitled - Notepad'
            }));

            const testText = 'LUCY workflow test 123';
            let workerTypeReceived = null;

            mockProc.setHandler('type_text', (req) => {
                workerTypeReceived = req.text;
                return {
                    success: true,
                    verified: true,
                    verifiedMatch: true,
                    readText: testText,
                    postconditionStatus: 'VERIFIED',
                    postconditionDetail: 'Readback text matched expected text',
                    controlName: 'Text Editor'
                };
            });

            const request = `Open Notepad, type \`${testText}\`, and verify that the text is present.`;
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, true);
            assert.equal(result.status, 'completed');
            assert.equal(result.executedSteps.length, 2);
            assert.equal(workerTypeReceived, testText);

            const typeStep = result.executedSteps[1];
            assert.equal(typeStep.toolId, 'desktop_type_text');
            assert.equal(typeStep.verified, true);
            assert.equal(typeStep.params.target, 'app_5555');
            assert.equal(typeStep.verification.status, VERIFICATION_STATUSES.VERIFIED);
        } finally {
            cleanup();
        }
    });

    await suite.test('Workflow B failure: Text mismatch fails verification honestly', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, cleanup } = harness;

        try {
            mockProc.setHandler('launch_app', (req) => ({
                appId: 'app_6666',
                pid: 6666,
                processStartTime: new Date().toISOString(),
                windowHandle: 77772,
                windowTitle: 'Untitled - Notepad'
            }));

            mockProc.setHandler('type_text', (req) => ({
                success: true,
                verified: false,
                verifiedMatch: false,
                readText: 'Unexpected corrupted text',
                postconditionStatus: 'FAILED',
                postconditionDetail: 'Readback text mismatch: expected LUCY workflow test 123, got Unexpected corrupted text'
            }));

            const request = 'Open Notepad, type `LUCY workflow test 123`, and verify that the text is present.';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, false, 'Workflow must fail verification on readback mismatch');
            assert.equal(result.status, 'failed');
            const failedStep = result.failedStep;
            assert.equal(failedStep.toolId, 'desktop_type_text');
            assert.equal(failedStep.verified, false);
            assert.equal(failedStep.verification.status, VERIFICATION_STATUSES.FAILED);
            assert.ok(failedStep.verification.failureReason.includes('mismatch') || failedStep.verification.failureReason.includes('failed'));
        } finally {
            cleanup();
        }
    });

    await suite.test('Workflow B unobservable target: Returns INCONCLUSIVE truthfully without false success', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, cleanup } = harness;

        try {
            mockProc.setHandler('launch_app', (req) => ({
                appId: 'app_7777',
                pid: 7777,
                processStartTime: new Date().toISOString(),
                windowHandle: 77773,
                windowTitle: 'Untitled - Notepad'
            }));

            mockProc.setHandler('type_text', (req) => ({
                success: true,
                verified: false,
                postconditionStatus: 'UNVERIFIABLE',
                postconditionDetail: 'Target control does not support ValuePattern or TextPattern readback'
            }));

            const request = 'Open Notepad, type `LUCY workflow test 123`, and verify that the text is present.';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, false, 'Workflow must not claim success when readback is unobservable');
            const failedStep = result.failedStep;
            assert.equal(failedStep.verification.status, VERIFICATION_STATUSES.INCONCLUSIVE);
            assert.equal(failedStep.verified, false);
            assert.ok(failedStep.verification.failureReason.includes('independently verified') || failedStep.verification.failureReason.includes('UNVERIFIABLE'));
        } finally {
            cleanup();
        }
    });

    // =========================================================================
    // 3. Reference Workflow C: Multi-step DAG Execution with Recovery
    // =========================================================================
    await suite.test('Workflow C: Multi-step DAG executes in topological order and persists checkpoints', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, taskContinuityStore, cleanup } = harness;

        try {
            mockProc.setHandler('launch_app', (req) => ({
                appId: 'app_8888',
                pid: 8888,
                processStartTime: new Date().toISOString(),
                windowHandle: 88882,
                windowTitle: 'Untitled - Notepad'
            }));

            mockProc.setHandler('type_text', (req) => ({
                success: true,
                verified: true,
                readText: 'a test line',
                postconditionStatus: 'VERIFIED'
            }));

            mockProc.setHandler('find_element', (req) => ({
                found: true,
                name: 'Text Editor',
                controlType: 'Edit',
                isEditable: true,
                isEnabled: true
            }));

            mockProc.setHandler('inspect_ui', (req) => ({
                elements: [{ name: 'Text Editor', controlType: 'Edit', isEditable: true, isEnabled: true }]
            }));

            const request = 'Open Notepad, enter "a test line", verify it, then summarize the result.';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, true);
            assert.equal(result.status, 'completed');
            assert.equal(result.executedSteps.length, 3, 'Must execute 3 steps in order');
            assert.equal(result.executedSteps[0].toolId, 'desktop_launch_app');
            assert.equal(result.executedSteps[1].toolId, 'desktop_type_text');
            assert.equal(result.executedSteps[2].toolId, 'desktop_inspect_control');

            // Verify persistence in task continuity store
            const checkpoint = taskContinuityStore.getCheckpoint(result.taskId);
            assert.ok(checkpoint, 'Checkpoint must be saved');
            assert.equal(checkpoint.status, TASK_STATUSES.COMPLETED);
            assert.equal(checkpoint.completedSteps.length, 3);

            // Verify structured record
            const record = coordinator.getWorkflowExecutionRecord(result.taskId);
            assert.equal(record.actionAttempts.length, 3);
            assert.equal(record.finalStatus, 'completed');
            assert.ok(record.summary.includes('3/3 steps verified'));
        } finally {
            cleanup();
        }
    });

    await suite.test('Workflow C recovery: Transient failure triggers bounded recovery with receipt', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, cleanup } = harness;

        try {
            mockProc.setHandler('launch_app', (req) => ({
                appId: 'app_9999',
                pid: 9999,
                processStartTime: new Date().toISOString(),
                windowHandle: 88883,
                windowTitle: 'Untitled - Notepad'
            }));

            let typeAttempts = 0;
            mockProc.setHandler('type_text', (req) => {
                typeAttempts++;
                if (typeAttempts === 1) {
                    // First attempt: simulate transient window focus lock
                    return {
                        ok: false,
                        error: 'Target window temporarily unresponsive (busy)',
                        code: 'BUSY'
                    };
                }
                // Second attempt: succeeds
                return {
                    success: true,
                    verified: true,
                    readText: 'recovery test',
                    postconditionStatus: 'VERIFIED'
                };
            });

            mockProc.setHandler('find_element', (req) => ({
                found: true,
                name: 'Text Editor',
                controlType: 'Edit',
                isEditable: true,
                isEnabled: true
            }));

            const request = 'Open Notepad, enter "recovery test", verify it, then summarize the result.';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, true, 'Task should succeed after bounded recovery');
            assert.equal(typeAttempts, 2, 'Must have attempted retry');

            const typeStep = result.executedSteps[1];
            assert.equal(typeStep.verified, true);
            assert.ok(typeStep.recovery, 'Recovery receipt must be present');
            assert.equal(typeStep.recovery.attempts, 1);
            assert.equal(typeStep.recovery.finalStatus, 'recovered');
        } finally {
            cleanup();
        }
    });

    await suite.test('Workflow C uncertain outcome: Blocks blind retry into awaiting_reconciliation', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, taskContinuityStore, cleanup } = harness;

        try {
            mockProc.setHandler('launch_app', (req) => ({
                appId: 'app_11111',
                pid: 11111,
                processStartTime: new Date().toISOString(),
                windowHandle: 88884,
                windowTitle: 'Untitled - Notepad'
            }));

            // Simulate hanging worker during consequential text entry (timeout)
            mockProc.setHandler('type_text', (req) => {
                return undefined; // simulate hanging request
            });

            const request = 'Open Notepad, enter "consequential timeout test", verify it, then summarize the result.';
            // Set small step timeout to trigger uncertain outcome
            const result = await coordinator.executeRequest(request, { stepTimeoutMs: 150 });

            assert.equal(result.ok, false);
            assert.equal(result.status, 'awaiting_reconciliation');
            assert.equal(result.uncertain, true);

            // Verify checkpoint saved as awaiting_reconciliation
            const checkpoint = taskContinuityStore.getCheckpoint(result.taskId);
            assert.equal(checkpoint.status, TASK_STATUSES.AWAITING_RECONCILIATION);
            assert.ok(checkpoint.uncertainStep);
            assert.equal(checkpoint.uncertainStep.resolved, false);

            // Verify execution record documents uncertain outcome
            const record = coordinator.getWorkflowExecutionRecord(result.taskId);
            assert.equal(record.finalStatus, 'awaiting_reconciliation');
            assert.equal(record.uncertainOutcomes.length, 1);
            assert.ok(record.remainingLimitations.some(l => l.includes('uncertain outcome')));
        } finally {
            cleanup();
        }
    });

    // =========================================================================
    // 4. Target Identity & Safety Checks
    // =========================================================================
    await suite.test('Safety: Unverified step output cannot satisfy downstream template parameter resolution', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, cleanup } = harness;

        try {
            // Step 1 fails to launch
            mockProc.setHandler('launch_app', (req) => ({
                ok: false,
                error: 'Failed to create process',
                pid: 0
            }));

            const request = 'Open Notepad and tell me whether it is ready for me to type.';
            const result = await coordinator.executeRequest(request);

            assert.equal(result.ok, false);
            assert.equal(result.status, 'failed');
            // Downstream step 2 must NEVER have executed
            assert.equal(result.executedSteps.length, 1);
            assert.equal(result.executedSteps[0].toolId, 'desktop_launch_app');
            assert.equal(result.executedSteps[0].verified, false);
        } finally {
            cleanup();
        }
    });

    await suite.test('Safety: Interaction directed at unowned process/window is rejected', async () => {
        const harness = createTestHarness();
        const { desktopManager, cleanup } = harness;

        try {
            // An external process PID that Lucy did not launch
            const unownedPid = 44444;
            assert.equal(desktopManager.isOwnedByLucy(unownedPid), false);

            assert.throws(() => {
                desktopManager.assertOwnership(unownedPid);
            }, (err) => {
                assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
                return true;
            });

            await assert.rejects(async () => {
                await desktopManager.inspectControl(unownedPid, {});
            }, (err) => {
                assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
                return true;
            });
        } finally {
            cleanup();
        }
    });

    await suite.test('Safety: Protected system processes are rejected by allowlist and ownership', async () => {
        const harness = createTestHarness();
        const { desktopManager, cleanup } = harness;

        try {
            // Attempting to launch regedit.exe (administrative/prohibited) or csrss.exe (not allowlisted)
            await assert.rejects(async () => {
                await desktopManager.launchApp('regedit.exe');
            }, (err) => {
                assert.ok(err.code === 'APP_NOT_ALLOWLISTED' || err.message.includes('prohibited') || err.message.includes('allowlist'));
                return true;
            });

            await assert.rejects(async () => {
                await desktopManager.launchApp('csrss.exe');
            }, (err) => {
                assert.ok(err.code === 'APP_NOT_ALLOWLISTED' || err.message.includes('allowlist') || err.message.includes('not permitted'));
                return true;
            });
        } finally {
            cleanup();
        }
    });

    await suite.test('Safety: Cancellation during workflow halts subsequent steps immediately', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, cleanup } = harness;

        try {
            const controller = new AbortController();

            mockProc.setHandler('launch_app', (req) => {
                // Abort during first step
                controller.abort(new Error('User aborted execution'));
                return {
                    appId: 'app_abort',
                    pid: 9911,
                    windowHandle: 1234
                };
            });

            const request = 'Open Notepad, enter "test", verify it, then summarize the result.';
            const result = await coordinator.executeRequest(request, { signal: controller.signal });

            assert.equal(result.ok, false);
            assert.equal(result.cancelled, true);
            assert.ok(result.executedSteps.length <= 1, 'Subsequent steps must not execute after abort');
        } finally {
            cleanup();
        }
    });

    await suite.test('Safety: Workflow execution record scrubs secrets and omits bulky base64 images', async () => {
        const harness = createTestHarness();
        const { mockProc, coordinator, cleanup } = harness;

        try {
            mockProc.setHandler('launch_app', (req) => ({
                appId: 'app_secret_1',
                pid: 12345,
                windowHandle: 1111,
                apiKey: 'sk-1234567890abcdef12345678'
            }));

            // Large base64 mock screenshot string (> 500 chars)
            const largeBase64 = 'data:image/png;base64,' + 'A'.repeat(800);

            mockProc.setHandler('find_element', (req) => ({
                found: true,
                screenshot: largeBase64,
                name: 'Sensitive Field',
                secretToken: 'ghp_123456789012345678901234567890123456'
            }));

            mockProc.setHandler('inspect_ui', (req) => ({
                elements: [{ name: 'Sensitive Field', image: largeBase64 }]
            }));

            const request = 'Open Notepad and tell me whether it is ready for me to type.';
            const result = await coordinator.executeRequest(request);

            const record = coordinator.getWorkflowExecutionRecord(result.taskId);
            assert.ok(record);

            const recordJson = JSON.stringify(record);

            // Verifications:
            // 1. sk- secret is redacted
            assert.ok(!recordJson.includes('sk-1234567890abcdef'), 'API key must be redacted');
            // 2. ghp_ secret is redacted
            assert.ok(!recordJson.includes('ghp_12345678901234567890'), 'GitHub token must be redacted');
            // 3. Bulky base64 screenshot is omitted
            assert.ok(!recordJson.includes('A'.repeat(500)), 'Bulky base64 string must not appear in execution record');
            assert.ok(recordJson.includes('[SCREENSHOT_BASE64_OMITTED]'), 'Bulky base64 must be replaced with placeholder');
        } finally {
            cleanup();
        }
    });

    // =========================================================================
    // 5. Windows Interactive Session Mode (Optional Live End-to-End)
    // =========================================================================
    await suite.test('Environment check: Real interactive desktop vs Headless CI', async (t) => {
        const isInteractiveRequested = process.env.LUCY_INTERACTIVE_TEST === 'true';
        if (!isInteractiveRequested) {
            t.skip('Skipping live Windows desktop worker interaction (set LUCY_INTERACTIVE_TEST=true to run against live desktop UI Automation)');
            return;
        }

        // Live interactive test running against compiled LucyUiaWorker.exe if requested
        const liveManager = new DesktopAutomationManager();
        try {
            await liveManager.initWorker();
            const launch = await liveManager.launchApp('notepad.exe');
            assert.equal(launch.ok, true);
            assert.ok(launch.pid > 0);

            const inspect = await liveManager.inspectControl(launch.appId, { action: 'type' });
            assert.equal(inspect.ok, true);
            assert.equal(inspect.ready, true);

            await liveManager.closeApp(launch.appId, { savePolicy: 'dont_save' });
        } finally {
            liveManager.cleanup();
        }
    });
});
