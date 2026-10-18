'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ConnectionManager, CONNECTION_STATES } = require('../../src/providers/connection-manager.js');
const { ModelCatalogue, PROVIDER_TYPES } = require('../../src/providers/model-catalogue.js');
const { ModelRouter, ROUTING_MODES, TASK_CATEGORIES } = require('../../src/providers/model-router.js');
const { ProviderAdapter } = require('../../src/providers/provider-adapter.js');
const { CredentialStore } = require('../../src/security/credential-store.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { TaskCoordinator, TASK_STATUSES } = require('../../src/core/task-coordinator.js');
const { TaskStatusManager, TASK_STATES } = require('../../src/core/task-status.js');
const { PermissionAuthority, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');

function createTestDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lucy-health-test-${prefix}-`));
}

describe('AI Provider Health, Model Routing and Request Execution (Repair 7)', () => {
    let testDir;
    let credStore;
    let connManager;
    let catalogue;
    let router;
    let adapter;

    beforeEach(() => {
        testDir = createTestDir('prov');
        credStore = new CredentialStore({ storageDir: path.join(testDir, 'secure') });
        connManager = new ConnectionManager({
            storageDir: path.join(testDir, 'memory'),
            credentialStore: credStore
        });
        catalogue = new ModelCatalogue();
        router = new ModelRouter({
            configDir: path.join(testDir, 'secure'),
            connectionManager: connManager,
            modelCatalogue: catalogue
        });
        adapter = new ProviderAdapter({
            credentialStore: credStore,
            modelRouter: router
        });
        router.providerAdapter = adapter;
    });

    it('1. Missing credentials: reports state as unconfigured/missing_credentials and rejects route', () => {
        connManager.init();
        connManager.addConnection({
            provider: PROVIDER_TYPES.GEMINI,
            label: 'Unconfigured Gemini',
            apiKey: '',
            models: ['gemini-2.0-flash']
        });

        const conns = connManager.listSanitizedConnections();
        assert.equal(conns[0].hasKey, false);
        assert.equal(conns[0].state, CONNECTION_STATES.NOT_CONFIGURED);
        assert.equal(connManager.isAvailable(conns[0].id), false);

        const routeError = router._buildNoRouteError();
        assert.equal(routeError.code, 'missing_credentials');
        assert.match(routeError.error, /missing API keys/i);
    });

    it('2. Invalid credentials: HTTP 400/401 classifies connection as invalid_credential', async () => {
        connManager.init();
        const conn = connManager.addConnection({
            provider: PROVIDER_TYPES.GEMINI,
            label: 'Invalid Key Gemini',
            apiKey: 'invalid_dummy_key_12345',
            models: ['gemini-2.0-flash']
        });

        assert.equal(conn.state, CONNECTION_STATES.UNVERIFIED);

        // Simulate provider returning invalid API key
        connManager.markFailed(conn.id, 'invalid_credential', 'API_KEY_INVALID: Key is invalid');

        const updated = connManager.getConnection(conn.id);
        assert.equal(updated.state, CONNECTION_STATES.INVALID_CREDENTIAL);
        assert.equal(connManager.isAvailable(conn.id), false);

        // Ensure sanitized output reports invalid key honestly
        const sanitized = connManager.getSanitizedConnection(conn.id);
        assert.equal(sanitized.state, CONNECTION_STATES.INVALID_CREDENTIAL);

        const routeError = router._buildNoRouteError();
        assert.equal(routeError.code, 'invalid_credentials');
        assert.match(routeError.error, /invalid or rejected/i);
    });

    it('3. Valid configured credentials: marks connection connected and enables routing', () => {
        connManager.init();
        const conn = connManager.addConnection({
            provider: PROVIDER_TYPES.GEMINI,
            label: 'Valid Key Gemini',
            apiKey: 'AIzaSyValidKeyTest_abc123',
            models: ['gemini-2.0-flash']
        });

        connManager.markHealthy(conn.id);
        const updated = connManager.getConnection(conn.id);
        assert.equal(updated.state, CONNECTION_STATES.CONNECTED);
        assert.equal(connManager.isAvailable(conn.id), true);

        const candidates = router.resolveCandidateRoutes({ taskCategory: TASK_CATEGORIES.GENERAL });
        assert.equal(candidates.length > 0, true);
        assert.equal(candidates[0].connection.id, conn.id);
    });

    it('4. Provider connectivity failure: marks connection temporarily_unavailable without invalidating key', () => {
        connManager.init();
        const conn = connManager.addConnection({
            provider: PROVIDER_TYPES.GEMINI,
            label: 'Network Flaky Gemini',
            apiKey: 'AIzaSyValidKeyTest_abc123',
            models: ['gemini-2.0-flash']
        });

        connManager.markHealthy(conn.id);
        assert.equal(connManager.getConnection(conn.id).state, CONNECTION_STATES.CONNECTED);

        // Network error occurs
        connManager.markFailed(conn.id, 'temporary_failure', 'fetch failed: ETIMEDOUT');
        const flaky = connManager.getConnection(conn.id);
        assert.equal(flaky.state, CONNECTION_STATES.TEMPORARILY_UNAVAILABLE);
        assert.equal(connManager.isAvailable(conn.id), false); // in 30s cooldown
    });

    it('5. Free-tier eligibility filtering: admits free models and rejects paid models', () => {
        assert.equal(catalogue.isFreeEligible('gemini-2.0-flash', PROVIDER_TYPES.GEMINI), true);
        assert.equal(catalogue.isFreeEligible('meta-llama/llama-3.3-70b-instruct:free', PROVIDER_TYPES.OPENROUTER), true);
        assert.equal(catalogue.isFreeEligible('gpt-4o', PROVIDER_TYPES.OPENAI), false);
        assert.equal(catalogue.isFreeEligible('claude-3-5-sonnet', PROVIDER_TYPES.OPENROUTER), false);
    });

    it('6. Strict Free-Only Mode: rejects paid override with policy_rejection_paid', () => {
        connManager.init();
        connManager.addConnection({
            provider: PROVIDER_TYPES.OPENROUTER,
            label: 'OpenRouter Connection',
            apiKey: 'sk-or-valid-test-key',
            models: ['gpt-4o'] // paid model
        });

        router.updateConfig({ freeOnly: true });

        const err = router._buildNoRouteError({
            freeOnly: true,
            userOverride: { provider: 'openrouter', model: 'gpt-4o' }
        });

        assert.equal(err.code, 'policy_rejection_paid');
        assert.match(err.error, /Strict Free-Only spending policy/i);
    });

    it('7. Model capability matching: basic text does not demand tool calling or vision', () => {
        const basicCheck = router.classifyTask('HI');
        assert.equal(basicCheck.isBasicText, true);
        assert.equal(basicCheck.requiresVision, false);
        assert.equal(basicCheck.requiresToolCalling, false);
        assert.equal(basicCheck.category, TASK_CATEGORIES.GENERAL);

        const visionCheck = router.classifyTask({
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'data:image/png;base64,...' }] }]
        });
        assert.equal(visionCheck.requiresVision, true);
        assert.equal(visionCheck.isBasicText, false);

        const toolsCheck = router.classifyTask({
            messages: [{ role: 'user', content: 'run tool' }],
            tools: [{ type: 'function', function: { name: 'desktop_click' } }]
        });
        assert.equal(toolsCheck.requiresToolCalling, true);
        assert.equal(toolsCheck.isBasicText, false);
    });

    it('8. Basic text request routing: resolves route without requiring tool calling', () => {
        connManager.init();
        connManager.addConnection({
            provider: PROVIDER_TYPES.GEMINI,
            label: 'Gemini Text Connection',
            apiKey: 'AIzaSyValid_abc',
            models: ['gemini-2.0-flash']
        });

        const candidates = router.resolveCandidateRoutes({
            taskCategory: TASK_CATEGORIES.GENERAL,
            requiresVision: false,
            requiresToolCalling: false
        });

        assert.equal(candidates.length > 0, true);
        assert.equal(candidates[0].model, 'gemini-2.0-flash');
    });

    it('9. no_route diagnostic event contains complete metadata without empty parentheses', async () => {
        connManager.init(); // no connections added

        const res = await router.complete({ messages: [{ role: 'user', content: 'HI' }] });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'no_configured_connection');

        const diagnostics = router.getDiagnostics();
        assert.equal(diagnostics.length > 0, true);

        const lastDiag = diagnostics[0];
        assert.equal(lastDiag.outcome, 'no_route');
        assert.ok(lastDiag.provider, 'Provider must not be empty');
        assert.ok(lastDiag.model, 'Model must not be empty');
        assert.ok(lastDiag.reason, 'Reason must not be empty');
        assert.notEqual(lastDiag.reason.trim(), '');
    });

    it('10. Credential changes invalidate stale validation results', () => {
        connManager.init();
        const conn = connManager.addConnection({
            provider: PROVIDER_TYPES.GEMINI,
            label: 'Primary Gemini',
            apiKey: 'AIzaSyInitialValid',
            models: ['gemini-2.0-flash']
        });

        connManager.markHealthy(conn.id);
        assert.equal(connManager.getConnection(conn.id).state, CONNECTION_STATES.CONNECTED);

        // User updates credential
        connManager.updateConnection({
            id: conn.id,
            apiKey: 'AIzaSyNewDifferentKey'
        });

        const refreshed = connManager.getConnection(conn.id);
        assert.equal(refreshed.state, CONNECTION_STATES.UNVERIFIED);
        assert.equal(refreshed.lastTestedAt, null);
    });

    it('11. Prevention of secret leakage: secrets are redacted in errors and diagnostics', () => {
        const secret = 'AIzaSy123456789012345678901234567890123';
        credStore.setSecret('gemini_api_key', secret);
        const rawErr = `Authentication failed for key ${secret}: 401 Unauthorized`;
        const redacted = connManager._sanitizeErrorMessage(rawErr);

        assert.equal(redacted.includes(secret), false);
        assert.match(redacted, /\[REDACTED_SECRET\]/);
    });

    it('12. TaskCoordinator records FAILED terminal state when provider is unconfigured or fails', async () => {
        const statusManager = new TaskStatusManager();
        const permAuthority = new PermissionAuthority({
            mode: PERMISSION_MODES.STANDARD,
            workspaceRoot: testDir
        });
        const toolRegistry = new ToolRegistry({ permissionAuthority: permAuthority });

        const planner = new TaskPlanner({
            providerAdapter: adapter,
            toolRegistry
        });

        process.env.LUCY_MEMORY_DIR = path.join(testDir, 'memory');
        const coordinator = new TaskCoordinator({
            statusManager,
            permissionAuthority: permAuthority,
            taskPlanner: planner,
            providerAdapter: adapter,
            storageDir: testDir,
            memoryDir: path.join(testDir, 'memory')
        });

        // Execute "HI" with no valid credentials configured
        const result = await coordinator.executeRequest('HI');
        assert.equal(result.ok, false);
        assert.equal(result.status, 'unconfigured_provider');
        assert.equal(statusManager.state, TASK_STATES.FAILED);
        assert.ok(result.replyText.length > 0);
    });
});
