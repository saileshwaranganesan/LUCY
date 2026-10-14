'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES } = require('../../src/core/task-status.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');
const { registerSystemTools } = require('../../src/tools/system-tools.js');

test('Phase C: Complete Verified End-to-End Pipeline & Single Authority Architecture', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-flow-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const credStore = new CredentialStore({ storeDir: path.join(testDir, 'creds') });
    const permissionAuth = new PermissionAuthority({
        mode: PERMISSION_MODES.STANDARD,
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

    const coordinator = new TaskCoordinator({
        statusManager,
        permissionAuthority: permissionAuth,
        toolRegistry,
        providerAdapter,
        memoryDir: path.join(testDir, 'memory')
    });
    coordinator.setCompanionBridge(companionBridge);

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    await t.test('Complete Pipeline: Request -> Planning -> Permission -> Execution -> Verification -> Response', async () => {
        // User request: inspect system status
        const request = 'Inspect system status';
        const result = await coordinator.executeRequest(request);

        assert.equal(result.ok, true, 'Task execution must succeed');
        assert.equal(result.status, 'completed');
        assert.equal(result.verification.verified, true, 'Result must be verified');
        assert.equal(result.verification.allStepsVerified, true);
        assert.equal(result.executedSteps.length, 1);

        const step = result.executedSteps[0];
        assert.equal(step.toolId, 'system_info');
        assert.equal(step.verified, true);
        assert.equal(step.result.status, 'completed');
        assert.ok(step.result.result.platform, 'Must include verified platform info');

        // Companion layer must reflect the completion event
        const companionVisual = companionBridge.getVisualState();
        assert.equal(companionVisual.emotion, 'happy');
        assert.ok(companionVisual.speechBubble.includes('successfully'));
    });

    await t.test('Safe File Operations: Write and Read verified within workspace boundary', async () => {
        // Prepare file write using auto-approved sandbox or explicit confirmation
        permissionAuth.setMode(PERMISSION_MODES.AUTONOMOUS_SANDBOX);

        // 1. Direct tool test: Write file
        const writeRes = await toolRegistry.execute('file_write', {
            path: 'test_doc.txt',
            content: 'L.U.C.Y. verified file content test.'
        });

        assert.equal(writeRes.ok, true);
        assert.equal(writeRes.verification.verified, true);
        assert.equal(writeRes.result.bytesWritten > 0, true);

        // 2. Read file through Coordinator
        const readRequest = 'Read file test_doc.txt';
        const readResult = await coordinator.executeRequest(readRequest);

        assert.equal(readResult.ok, true);
        assert.equal(readResult.executedSteps.length, 1);
        assert.equal(readResult.executedSteps[0].result.result.content, 'L.U.C.Y. verified file content test.');
        assert.equal(readResult.executedSteps[0].verified, true);
    });

    await t.test('Boundary Defense: Rejects path traversal escaping workspace', async () => {
        const forbiddenPath = '../../Windows/System32/drivers/etc/hosts';
        const escapeRes = await toolRegistry.execute('file_read', { path: forbiddenPath });

        assert.equal(escapeRes.ok, false);
        assert.ok(escapeRes.error.includes('Path traversal denied'));
    });

    await t.test('Companion Zero Independent Brain Guarantee', async () => {
        // Companion cannot run tools or plan on its own
        assert.equal(typeof companionBridge.tools, 'undefined');
        assert.equal(typeof companionBridge.executeTool, 'undefined');

        // Forwarded user interactions on companion go directly to TaskCoordinator
        let interceptedRequest = null;
        const originalExecute = coordinator.executeRequest.bind(coordinator);
        coordinator.executeRequest = async (text) => {
            interceptedRequest = text;
            return { ok: true, forwarded: true };
        };

        companionBridge.handleUserInteraction('submit_request', { text: 'Hello Lucy' });
        assert.equal(interceptedRequest, 'Hello Lucy', 'Companion must forward user input strictly to coordinator');

        coordinator.executeRequest = originalExecute;
    });

    await t.test('Consequential action confirmation gate stops execution when denied', async () => {
        permissionAuth.setMode(PERMISSION_MODES.STANDARD);
        permissionAuth.setConfirmationHandler(async () => false); // User declines

        const deleteRes = await toolRegistry.execute('file_delete', { path: 'test_doc.txt' });
        assert.equal(deleteRes.ok, false);
        assert.equal(deleteRes.status, 'permission_denied');

        // File must still exist on disk!
        assert.equal(fs.existsSync(path.join(testDir, 'test_doc.txt')), true, 'File must not be deleted');
    });
});
