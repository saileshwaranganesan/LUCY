'use strict';

/**
 * L.U.C.Y. Phase 10 Acceptance Test Suite:
 * End-to-End Real-World Task Verification & Obstacle Recovery
 * 
 * Verifies:
 * 1. Missing Parameter Clarification: Requests missing essential inputs return focused clarification.
 * 2. Primary Acceptance Scenario: Real Browser -> Real Disk File -> Real Notepad -> Native UIA Verification.
 * 3. Controlled Interruption & Safe Resumption: Cancelled task resumes from checkpoint without replaying steps.
 * 4. Browser Obstacle Handling: Harmless overlays handled deterministically without stalling.
 * 5. File Verification Safeguards: Missing or empty files fail-closed without false success.
 * 6. Consequential Action Authorization: Unapproved operations remain strictly blocked.
 * 7. Transparent Task Progress: getTaskProgress provides clear human-readable & structured status.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES } = require('../../src/core/task-status.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');
const { registerSystemTools } = require('../../src/tools/system-tools.js');
const { registerBrowserTools } = require('../../src/tools/browser-tools.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { BrowserManager } = require('../../src/tools/browser-manager.js');
const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { TaskRecoveryEngine } = require('../../src/core/recovery-engine.js');
const { ResultVerifier } = require('../../src/core/result-verifier.js');

// Helper to launch a local deterministic HTTP server
function startLocalResearchServer(contentHtml) {
    return new Promise((resolve, reject) => {
        let requestCount = 0;
        const server = http.createServer((req, res) => {
            if (req.url && req.url.includes('/research')) {
                requestCount++;
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(contentHtml);
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const url = `http://127.0.0.1:${port}/research`;
            resolve({
                server,
                url,
                getRequestCount: () => requestCount,
                close: () => new Promise((r) => server.close(r))
            });
        });
        server.on('error', reject);
    });
}

// Helper to create the real-world execution harness
async function createRealWorldHarness(customOptions = {}) {
    const testDir = path.join(os.tmpdir(), `lucy-phase10-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });

    const credStore = new CredentialStore({ storeDir: path.join(testDir, 'creds') });
    const permissionAuth = new PermissionAuthority({
        mode: customOptions.permissionMode || PERMISSION_MODES.STANDARD,
        workspaceRoot: testDir,
        confirmationHandler: customOptions.confirmationHandler || (async () => ({ confirmed: true, userAuthorizedDiscard: false }))
    });

    const toolRegistry = new ToolRegistry({ permissionAuthority: permissionAuth });
    registerFileTools(toolRegistry, testDir);
    registerSystemTools(toolRegistry);

    const desktopManager = new DesktopAutomationManager({ workspaceRoot: testDir });
    registerDesktopTools(toolRegistry, desktopManager);

    const browserManager = new BrowserManager({ headless: true });
    registerBrowserTools(toolRegistry, browserManager);

    const providerAdapter = new ProviderAdapter({
        credentialStore: credStore,
        provider: PROVIDER_TYPES.GEMINI
    });

    const statusManager = new TaskStatusManager();
    const companionBridge = new CompanionBridge();
    const continuityStore = new TaskContinuityStore({ storeDir: path.join(testDir, 'memory') });
    const recoveryEngine = new TaskRecoveryEngine({ maxRetries: 2, baseBackoffMs: 50 });
    const resultVerifier = new ResultVerifier({
        workspaceRoot: testDir,
        desktopManager,
        browserManager
    });

    const coordinator = new TaskCoordinator({
        workspaceRoot: testDir,
        memoryDir: path.join(testDir, 'memory'),
        permissionAuthority: permissionAuth,
        desktopManager,
        browserManager,
        toolRegistry,
        statusManager,
        companionBridge,
        taskContinuityStore: continuityStore,
        recoveryEngine,
        resultVerifier,
        providerAdapter
    });

    const activeAppIds = [];
    const activePids = [];
    const cleanup = async () => {
        // Collect exact test-spawned application IDs and PIDs from desktopManager tracking
        if (desktopManager?.trackedApps) {
            for (const [appId, app] of desktopManager.trackedApps.entries()) {
                if (!activeAppIds.includes(appId)) {
                    activeAppIds.push(appId);
                }
                if (app?.pid && !activePids.includes(app.pid)) {
                    activePids.push(app.pid);
                }
            }
        }
        // Gracefully close only tracked test applications via UIA
        for (const appId of activeAppIds) {
            try {
                await desktopManager.closeApp(appId, {
                    savePolicy: 'dont_save',
                    trustedTestScope: true,
                    disposableTestDoc: true,
                    userAuthorizedDiscard: true
                });
            } catch (_) {}
        }
        // Terminate ONLY tracked test PIDs if still alive, never broad taskkill
        for (const pid of activePids) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch (_) {}
        }
        // Terminate only this test harness's own LucyUiaWorker child process
        try {
            if (desktopManager?.proc && !desktopManager.proc.killed) {
                desktopManager.proc.kill();
            }
        } catch (_) {}
        try {
            await browserManager.closeAll();
        } catch (_) {}
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {}
    };

    return {
        coordinator,
        desktopManager,
        browserManager,
        toolRegistry,
        permissionAuth,
        continuityStore,
        statusManager,
        resultVerifier,
        testDir,
        activeAppIds,
        activePids,
        cleanup
    };
}

test('L.U.C.Y. Phase 10 Real-World Acceptance Suite', { timeout: 180000 }, async (t) => {

    await t.test('Criterion 1: Missing Parameter Clarification on Abstract Natural Language Prompt', async () => {
        const harness = await createRealWorldHarness();
        try {
            const promptWithPlaceholders = 'Research the provided topic, extract the important facts, save a clearly formatted summary in a text file in the designated test workspace, open that saved file in Notepad, and verify that the saved contents are correct.';
            
            const response = await harness.coordinator.executeRequest(promptWithPlaceholders);
            
            assert.strictEqual(response.ok, true, 'Clarification response should report ok: true');
            assert.strictEqual(response.plan?.type, 'clarification', 'Plan type must be clarification');
            assert.ok(response.plan?.missingParameters?.includes('topic'), 'Missing parameters must list topic');
            assert.ok(response.plan?.missingParameters?.includes('destination_path'), 'Missing parameters must list destination_path');
            assert.ok(typeof response.plan?.replyText === 'string', 'Reply text must be provided for user guidance');
            assert.strictEqual(response.plan?.steps?.length, 0, 'No steps must be executed for underspecified requests');
        } finally {
            await harness.cleanup();
        }
    });

    await t.test('Criterion 2: Primary Acceptance Scenario: Real Browser -> Disk File -> Real Notepad -> Native UIA Readback', { timeout: 60000 }, async () => {
        const fixtureHtml = `<!DOCTYPE html>
<html>
<head><title>Quantum Computing Breakthroughs 2026</title></head>
<body>
    <h1>Quantum Information Science Report</h1>
    <section id="discoveries">
        <p>Fact 1: Superconducting qubits demonstrated 99.99% two-qubit gate fidelity.</p>
        <p>Fact 2: Quantum error correction threshold exceeded using topological surface codes.</p>
        <p>Fact 3: Fault-tolerant quantum advantage achieved for molecular simulation.</p>
    </section>
</body>
</html>`;

        const server = await startLocalResearchServer(fixtureHtml);
        const harness = await createRealWorldHarness();

        try {
            await harness.desktopManager.ensureWorker();

            const targetRelPath = 'notes/quantum_summary.txt';
            const userPrompt = `Research ${server.url}, extract the important facts, save a clearly formatted summary to ${targetRelPath}, open that saved file in Notepad, and verify that the saved contents are correct`;

            const result = await harness.coordinator.executeRequest(userPrompt);

            // 1. Verify top-level execution outcome
            assert.strictEqual(result.ok, true, `Execution must succeed: ${result.error || ''}`);
            assert.strictEqual(result.status, TASK_STATUSES.COMPLETED, 'Task status must be COMPLETED');

            const completedSteps = result.completedSteps || result.executedSteps || [];
            assert.strictEqual(completedSteps.length, 6, 'All 6 workflow steps must complete and verify');

            // 2. Verify Step 1: Real Browser Navigation
            const step1 = completedSteps[0];
            assert.strictEqual(step1.toolId, 'browser_navigate');
            assert.strictEqual(step1.verified, true);
            assert.strictEqual(step1.result.ok, true);
            assert.strictEqual(step1.result.url, server.url);

            // 3. Verify Step 2: Real Browser Extraction
            const step2 = completedSteps[1];
            assert.strictEqual(step2.toolId, 'browser_extract');
            assert.strictEqual(step2.verified, true);
            assert.strictEqual(step2.result.ok, true);
            const extractedText = step2.result.text || step2.result.content;
            assert.ok(extractedText.includes('Superconducting qubits demonstrated 99.99%'), 'Extracted text must contain Fact 1');
            assert.ok(extractedText.includes('Quantum error correction threshold exceeded'), 'Extracted text must contain Fact 2');

            // 4. Verify Step 3: Filesystem Writing
            const step3 = completedSteps[2];
            assert.strictEqual(step3.toolId, 'file_write');
            assert.strictEqual(step3.verified, true);
            assert.strictEqual(step3.result.ok, true);

            // 5. Verify Step 4: Filesystem Readback Verification
            const step4 = completedSteps[3];
            assert.strictEqual(step4.toolId, 'file_read');
            assert.strictEqual(step4.verified, true);
            assert.strictEqual(step4.result.ok, true);

            // 6. Verify Step 5: Real Windows Notepad Launch
            const step5 = completedSteps[4];
            assert.strictEqual(step5.toolId, 'desktop_launch_app');
            assert.strictEqual(step5.verified, true);
            assert.strictEqual(step5.result.ok, true);
            assert.ok(step5.result.pid > 0, 'Notepad must have valid Windows PID > 0');
            assert.ok(step5.result.appId.startsWith('app_'), 'Notepad must have valid appId');
            assert.ok(step5.result.windowHandle > 0, 'Notepad must have a valid Win32 HWND');
            harness.activeAppIds.push(step5.result.appId);
            harness.activePids.push(step5.result.pid);

            // 7. Verify Step 6: Native UI Automation Readback
            const step6 = completedSteps[5];
            assert.strictEqual(step6.toolId, 'desktop_inspect_control');
            assert.strictEqual(step6.verified, true);
            assert.strictEqual(step6.result.ok, true);
            assert.strictEqual(step6.result.ready, true, 'Notepad window must be active and ready');
            assert.strictEqual(step6.result.controlFound, true, 'Notepad editor control must be located');
            
            // Read element value directly from UIA result
            const uiaElement = step6.result.element;
            assert.ok(uiaElement, 'UIA element must be present in inspection receipt');
            assert.ok(uiaElement.value.includes('Superconducting qubits'), 'UIA readback must confirm document text in Notepad');

            // 8. Independent Verification on Disk
            const expectedDiskPath = path.resolve(harness.testDir, targetRelPath);
            assert.ok(fs.existsSync(expectedDiskPath), `File must exist on disk at ${expectedDiskPath}`);
            
            const diskContent = fs.readFileSync(expectedDiskPath, 'utf8');
            assert.ok(diskContent.length > 0, 'Saved file must not be empty');
            assert.ok(diskContent.includes('Superconducting qubits demonstrated 99.99%'), 'Disk file must contain Fact 1');
            assert.ok(diskContent.includes('molecular simulation'), 'Disk file must contain Fact 3');

            const fileSha256 = crypto.createHash('sha256').update(diskContent, 'utf8').digest('hex');
            assert.ok(fileSha256.length === 64, 'SHA-256 hash of saved document must be valid');
        } finally {
            await server.close();
            await harness.cleanup();
        }
    });

    await t.test('Criterion 3: Controlled Interruption and Safe Resumption without Replaying Completed Steps', { timeout: 60000 }, async () => {
        const fixtureHtml = `<!DOCTYPE html>
<html>
<head><title>Interruption and Resumption Test</title></head>
<body>
    <article>
        <h1>Resilience Verification</h1>
        <p>Checkpoint Fact Alpha: Mission continuity preserved across transient interruptions.</p>
        <p>Checkpoint Fact Beta: Completed steps remain permanently verified.</p>
    </article>
</body>
</html>`;

        const server = await startLocalResearchServer(fixtureHtml);
        const harness = await createRealWorldHarness();

        try {
            await harness.desktopManager.ensureWorker();

            const targetRelPath = 'resilience/continuity_data.txt';
            const userPrompt = `Research ${server.url}, extract facts, save to ${targetRelPath}, open in notepad, and verify`;
            const taskId = 'task_continuity_' + Date.now();

            let interrupted = false;

            // Hook on coordinator status transitions to cancel right when step 3 (file_write) is about to execute
            const onTransition = (data) => {
                if (data.to === TASK_STATES.EXECUTING_TOOL && (data.currentTool === 'file_write' || data.step === 3) && !interrupted) {
                    interrupted = true;
                    harness.coordinator.cancelTask(taskId, 'Controlled interruption before disk write');
                }
            };

            harness.statusManager.on('stateChanged', onTransition);

            let initialResult;
            try {
                initialResult = await harness.coordinator.executeRequest(userPrompt, { taskId });
            } catch (err) {
                initialResult = { ok: false, error: err.message, status: 'cancelled' };
            } finally {
                harness.statusManager.off('stateChanged', onTransition);
            }

            // 2. Verify task was interrupted / cancelled cleanly
            const inspectionBeforeResume = harness.continuityStore.inspectTaskForResume(taskId);
            assert.ok(inspectionBeforeResume.completedCount >= 2, 'At least 2 steps must be verified before interruption');
            assert.ok(inspectionBeforeResume.pendingCount >= 1, 'Remaining steps must remain pending');
            assert.strictEqual(inspectionBeforeResume.isResumable, true, 'Task must be flagged as resumable');

            // Verify network-level evidence: server received exactly 1 request before interruption
            assert.strictEqual(server.getRequestCount(), 1, 'Server must have received exactly 1 request during initial execution');

            // Check that the output file does NOT yet exist on disk
            const expectedDiskPath = path.resolve(harness.testDir, targetRelPath);
            assert.strictEqual(fs.existsSync(expectedDiskPath), false, 'File must not exist on disk before resume');

            // 3. Resume task execution
            const resumeResult = await harness.coordinator.resumeTask(taskId);
            assert.strictEqual(resumeResult.ok, true, `Resumed task must succeed: ${resumeResult.error || ''}`);
            assert.strictEqual(resumeResult.status, TASK_STATUSES.COMPLETED, 'Resumed task must reach COMPLETED state');

            // 4. Confirm completed steps were NOT replayed
            // A. Network socket proof: server request count remains 1 (no re-navigation)
            assert.strictEqual(server.getRequestCount(), 1, 'Server must NOT receive additional requests during resume (proves zero navigation replay)');

            // B. Execution receipt proof: resumeResult.executedSteps contains ONLY pending steps (steps 3 through 6)
            assert.strictEqual(resumeResult.executedSteps.length, 4, 'Resumed execution must execute ONLY the 4 pending steps');
            assert.strictEqual(resumeResult.executedSteps.some(s => s.toolId === 'browser_navigate'), false, 'browser_navigate must NOT be replayed on resume');
            assert.strictEqual(resumeResult.executedSteps.some(s => s.toolId === 'browser_extract'), false, 'browser_extract must NOT be replayed on resume');

            const finalCheckpoint = harness.continuityStore.getCheckpoint(taskId);
            assert.strictEqual(finalCheckpoint.status, TASK_STATUSES.COMPLETED);
            
            // Step 1 and Step 2 must retain their original receipts without duplicate replay
            const step1Receipt = finalCheckpoint.completedSteps.find(s => s.toolId === 'browser_navigate');
            const step2Receipt = finalCheckpoint.completedSteps.find(s => s.toolId === 'browser_extract');
            assert.ok(step1Receipt, 'Step 1 receipt must exist');
            assert.ok(step2Receipt, 'Step 2 receipt must exist');

            // 5. Confirm remaining steps completed and document exists on disk
            assert.ok(fs.existsSync(expectedDiskPath), 'Output file must exist on disk after resumption');
            const diskText = fs.readFileSync(expectedDiskPath, 'utf8');
            assert.ok(diskText.includes('Checkpoint Fact Alpha'), 'Output file must contain extracted content');

            // Track any open notepad appId/pid for safe process-specific cleanup
            const step5Receipt = finalCheckpoint.completedSteps.find(s => s.toolId === 'desktop_launch_app');
            if (step5Receipt?.result?.appId) {
                harness.activeAppIds.push(step5Receipt.result.appId);
            }
            if (step5Receipt?.result?.pid) {
                harness.activePids.push(step5Receipt.result.pid);
            }
        } finally {
            await server.close();
            await harness.cleanup();
        }
    });

    await t.test('Criterion 4: Browser Obstacle Handling with Harmless Promotional Banner', { timeout: 30000 }, async () => {
        const fixtureWithBanner = `<!DOCTYPE html>
<html>
<head><title>Page with Banner</title></head>
<body>
    <div id="newsletter-banner" style="width:100%;background:#fde047;padding:10px;text-align:center;">
        <span>Subscribe to our scientific bulletin!</span>
        <button id="close-banner" aria-label="Close" onclick="this.parentElement.style.display='none'">✕</button>
    </div>
    <main>
        <h1>Astrophysics Data Portal</h1>
        <p>Observable Universe radius is approximately 46.5 billion light-years.</p>
    </main>
</body>
</html>`;

        const server = await startLocalResearchServer(fixtureWithBanner);
        const harness = await createRealWorldHarness();

        try {
            const navResult = await harness.browserManager.navigate(server.url);
            assert.strictEqual(navResult.ok, true);

            const extractResult = await harness.browserManager.extract({ selector: 'main', format: 'text' });
            assert.strictEqual(extractResult.ok, true);
            assert.ok(extractResult.text.includes('46.5 billion light-years'), 'Content extracted cleanly past overlay');
        } finally {
            await server.close();
            await harness.cleanup();
        }
    });

    await t.test('Criterion 5: File Verification Gate Rejects Missing or Truncated Files', async () => {
        const harness = await createRealWorldHarness();

        try {
            const nonExistentPath = 'missing/file_does_not_exist.txt';
            const missingStep = {
                toolId: 'file_write',
                params: { path: nonExistentPath, content: 'Some intended text' }
            };
            const failedResult = {
                ok: false,
                path: nonExistentPath,
                error: 'ENOENT: no such file or directory'
            };

            const verification = await harness.resultVerifier.verify(missingStep, failedResult, {
                workspaceRoot: harness.testDir
            });

            assert.strictEqual(verification.verified, false, 'Missing file must not be verified');
            assert.strictEqual(verification.status, 'failed', 'Verification status must be failed');
            assert.ok(verification.failureReason, 'Failure reason must be documented');
        } finally {
            await harness.cleanup();
        }
    });

    await t.test('Criterion 6: Consequential Action Safeguards Strictly Require User Authorization', async () => {
        // Create harness with confirmation handler rejecting the action
        const harness = await createRealWorldHarness({
            permissionMode: PERMISSION_MODES.STRICT,
            confirmationHandler: async () => ({ confirmed: false, userAuthorizedDiscard: false })
        });

        try {
            const auth = harness.permissionAuth;
            const evalResult = await auth.evaluate({
                toolId: 'desktop_type_text',
                riskTier: RISK_TIERS.CONSEQUENTIAL,
                params: {
                    target: 'app_mock_123',
                    text: 'unauthorized text mutation'
                }
            });

            assert.strictEqual(evalResult.permitted, false, 'Unapproved consequential desktop typing must be blocked');
            assert.ok(evalResult.reason.toLowerCase().includes('denied') || evalResult.reason.toLowerCase().includes('rejected') || evalResult.reason.toLowerCase().includes('declined'), 'Rejection reason must be stated');
        } finally {
            await harness.cleanup();
        }
    });

    await t.test('Criterion 7: Transparent Task Continuity Progress Reporting (getTaskProgress)', async () => {
        const harness = await createRealWorldHarness();

        try {
            const taskId = 'task_progress_audit_' + Date.now();
            harness.continuityStore.saveCheckpoint({
                taskId,
                userRequest: 'Multi-step research and audit workflow',
                plan: {
                    steps: [
                        { id: 'step_1', index: 1, title: 'Navigate to target', toolId: 'browser_navigate', params: { url: 'https://example.com' } },
                        { id: 'step_2', index: 2, title: 'Extract content', toolId: 'browser_extract', params: { selector: 'body' } },
                        { id: 'step_3', index: 3, title: 'Save findings', toolId: 'file_write', params: { path: 'audit.txt', content: 'data' } }
                    ]
                },
                currentStepIndex: 1,
                completedSteps: [
                    { id: 'step_1', index: 1, title: 'Navigate to target', toolId: 'browser_navigate', verified: true, result: { ok: true, status: 'navigated' } }
                ],
                status: TASK_STATUSES.INTERRUPTED,
                error: 'Interrupted for audit'
            });

            const progress = harness.coordinator.getTaskProgress(taskId);

            assert.ok(progress, 'Progress object must be returned');
            assert.strictEqual(progress.ok, true);
            assert.strictEqual(progress.taskId, taskId);
            assert.strictEqual(progress.completedAndVerifiedSteps.length, 1);
            assert.strictEqual(progress.remainingSteps.length, 2);
            assert.strictEqual(progress.canSafelyResume, true);
            assert.ok(typeof progress.humanReadableSummary === 'string', 'Summary must be human-readable string');
            assert.ok(progress.humanReadableSummary.includes('Progress: 1 of 3 steps completed and verified'), 'Summary must reflect step counts');
        } finally {
            await harness.cleanup();
        }
    });

    await t.test('Criterion 8: Workspace Task Organization and File Audit with Real Directory & File Operations', async () => {
        const harness = await createRealWorldHarness();

        try {
            // Seed real files into workspace
            const rawDir = path.join(harness.testDir, 'raw_data');
            fs.mkdirSync(rawDir, { recursive: true });
            fs.writeFileSync(path.join(rawDir, 'telemetry.log'), 'SENSOR_A_OK: voltage=3.3V', 'utf8');

            const userPrompt = 'organize files: copy raw_data/telemetry.log to backup/telemetry_archive.log and verify';
            const result = await harness.coordinator.executeRequest(userPrompt);

            assert.strictEqual(result.ok, true, `Workspace organization must succeed: ${result.error || ''}`);
            assert.strictEqual(result.status, TASK_STATUSES.COMPLETED, 'Task status must be COMPLETED');

            // Verify physical file creation on disk
            const targetFile = path.join(harness.testDir, 'backup', 'telemetry_archive.log');
            assert.ok(fs.existsSync(targetFile), `Target file must physically exist on disk at ${targetFile}`);
            assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), 'SENSOR_A_OK: voltage=3.3V');

            // Verify all planned steps completed and verified
            const completed = result.completedSteps || result.executedSteps || [];
            assert.strictEqual(completed.length, 3, 'Must complete file_mkdir, file_copy, and file_read');
            assert.ok(completed.every(s => s.verified === true), 'All organization steps must be verified');
        } finally {
            await harness.cleanup();
        }
    });

});
