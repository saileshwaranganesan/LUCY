'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { CredentialStore } = require('../../src/security/credential-store.js');
const { ConnectionManager, CONNECTION_STATES } = require('../../src/providers/connection-manager.js');
const { ModelCatalogue, PROVIDER_TYPES } = require('../../src/providers/model-catalogue.js');
const { ModelRouter, ROUTING_MODES, TASK_CATEGORIES, ERROR_CLASSIFICATIONS } = require('../../src/providers/model-router.js');
const { ProviderAdapter } = require('../../src/providers/provider-adapter.js');

function createTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lucy-test-${prefix}-`));
}

function cleanTempDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
}

test('Multi-Provider AI Routing & Multi-Key Management Acceptance Suite', async (t) => {

    await t.test('1. Adding multiple keys to one provider', async () => {
        const tmpDir = createTempDir('multi-key');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn1 = cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Personal Key',
                apiKey: 'AIzaSyTestKeyAlpha123456789',
                defaultModel: 'gemini-2.0-flash',
                priority: 10
            });

            const conn2 = cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Work Project Key',
                apiKey: 'AIzaSyTestKeyBeta987654321',
                defaultModel: 'gemini-2.0-flash',
                priority: 20
            });

            assert.notEqual(conn1.id, conn2.id);
            assert.equal(conn1.provider, PROVIDER_TYPES.GEMINI);
            assert.equal(conn2.provider, PROVIDER_TYPES.GEMINI);

            const list = cm.listSanitizedConnections();
            const geminiConns = list.filter((c) => c.provider === PROVIDER_TYPES.GEMINI);
            assert.equal(geminiConns.length, 2);

            assert.equal(cm.getApiKey(conn1.id), 'AIzaSyTestKeyAlpha123456789');
            assert.equal(cm.getApiKey(conn2.id), 'AIzaSyTestKeyBeta987654321');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('2. Secure credential persistence across application restart', async () => {
        const tmpDir = createTempDir('persistence');
        try {
            const credStore1 = new CredentialStore({ storageDir: tmpDir });
            const cm1 = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore1 });
            cm1.init();

            const saved = cm1.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Cloud High Priority',
                apiKey: 'gsk_testGroqKeySecretValue12345678',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 15
            });

            // Simulate application restart with new instances
            const credStore2 = new CredentialStore({ storageDir: tmpDir });
            const cm2 = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore2 });
            cm2.init();

            const conn = cm2.getConnection(saved.id);
            assert.ok(conn, 'Connection metadata reloaded from disk');
            assert.equal(conn.label, 'Groq Cloud High Priority');
            assert.equal(conn.provider, PROVIDER_TYPES.GROQ);
            assert.equal(conn.priority, 15);

            // Secret retrieved safely from DPAPI store
            const secret = cm2.getApiKey(saved.id);
            assert.equal(secret, 'gsk_testGroqKeySecretValue12345678');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('3. Replacing and deleting credentials', async () => {
        const tmpDir = createTempDir('replace-delete');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn = cm.saveConnection({
                provider: PROVIDER_TYPES.CEREBRAS,
                label: 'Fast Cerebras',
                apiKey: 'csk-initialKey12345678',
                defaultModel: 'llama3.1-8b'
            });

            // Replace secret
            cm.updateConnection(conn.id, {
                apiKey: 'csk-updatedSecretReplacement9999',
                label: 'Updated Cerebras'
            });

            assert.equal(cm.getApiKey(conn.id), 'csk-updatedSecretReplacement9999');
            assert.equal(cm.getConnection(conn.id).label, 'Updated Cerebras');

            // Delete connection
            const deleted = cm.deleteConnection(conn.id);
            assert.equal(deleted, true);
            assert.equal(cm.getConnection(conn.id), null);
            assert.equal(cm.getApiKey(conn.id), null);
            assert.equal(credStore.hasSecret(`conn_${conn.id}_key`), false);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('4. Preventing secret exposure through logs and IPC', async () => {
        const tmpDir = createTempDir('sanitization');
        try {
            const secretKey = 'gsk_SuperSecretKeyMustNeverAppearPlaintext';
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn = cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Sensitive Connection',
                apiKey: secretKey,
                defaultModel: 'llama-3.3-70b-versatile'
            });

            // Sanitized list exposed to renderer/IPC
            const sanitizedList = cm.listSanitizedConnections();
            const connSanitized = sanitizedList.find((c) => c.id === conn.id);

            assert.ok(connSanitized);
            assert.ok(!connSanitized.apiKey, 'Never contains plaintext apiKey');
            assert.ok(connSanitized.maskedKey.startsWith('••••'), 'Masked key format');
            assert.ok(!JSON.stringify(sanitizedList).includes(secretKey), 'Secret not in JSON serialized IPC output');

            // Metadata file on disk never contains the secret
            const rawJson = fs.readFileSync(path.join(tmpDir, 'connections.json'), 'utf8');
            assert.ok(!rawJson.includes(secretKey), 'Secret not in renderer-accessible connections.json');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('5. Selecting an explicitly requested model', async () => {
        const tmpDir = createTempDir('explicit-override');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Main',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash'
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Speed',
                apiKey: 'test-groq-key',
                defaultModel: 'llama-3.3-70b-versatile'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            // User explicitly requested Groq llama-3.3-70b-versatile
            const resolution = router.resolveRoute({
                overrideProvider: PROVIDER_TYPES.GROQ,
                overrideModel: 'llama-3.3-70b-versatile'
            });

            assert.equal(resolution.provider, PROVIDER_TYPES.GROQ);
            assert.equal(resolution.model, 'llama-3.3-70b-versatile');
            assert.equal(resolution.reason, 'explicit_user_override');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('6. Selecting a model according to automatic policy', async () => {
        const tmpDir = createTempDir('auto-policy');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Llama 70B',
                apiKey: 'test-groq-key',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 20
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini 2.0 Flash',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 10
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            // Reasoning task category resolves to strong reasoning model
            const reasoningRoute = router.resolveRoute({ taskCategory: TASK_CATEGORIES.REASONING });
            assert.ok(reasoningRoute.model, 'Selected reasoning model');
            assert.ok(reasoningRoute.connection, 'Selected valid connection');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('7. Rejecting incompatible vision and tool-calling routes', async () => {
        const tmpDir = createTempDir('capability-gating');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Text-only connection
            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Text Only',
                apiKey: 'test-groq-key',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 50 // higher priority!
            });

            // Multimodal vision connection
            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Vision',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 10
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            // Request with image MUST select the vision model, even though Groq has higher priority
            const visionRoute = router.resolveRoute({ hasImages: true });
            assert.equal(visionRoute.provider, PROVIDER_TYPES.GEMINI);
            assert.equal(visionRoute.model, 'gemini-2.0-flash');

            // Explicitly attempting to force a text-only model on an image request throws
            assert.throws(() => {
                router.resolveRoute({
                    hasImages: true,
                    overrideProvider: PROVIDER_TYPES.GROQ,
                    overrideModel: 'llama-3.3-70b-versatile'
                });
            }, /does not support required visual\/image input/);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('8. Falling back after a temporary provider failure', async () => {
        const tmpDir = createTempDir('failover-temp');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn1 = cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Primary',
                apiKey: 'test-groq-key',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 10
            });

            const conn2 = cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Backup',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 20
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });

            let attempts = 0;
            adapter.completeWithConnection = async ({ connection }) => {
                attempts++;
                if (connection.id === conn1.id) {
                    return {
                        ok: false,
                        code: 'http_503',
                        error: 'Service Temporarily Unavailable'
                    };
                }
                return {
                    ok: true,
                    provider: connection.provider,
                    model: 'gemini-2.0-flash',
                    content: 'Success from backup provider!'
                };
            };

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const result = await router.complete({
                messages: [{ role: 'user', content: 'hello' }]
            });

            assert.equal(result.ok, true);
            assert.equal(result.provider, PROVIDER_TYPES.GEMINI);
            assert.equal(result.content, 'Success from backup provider!');
            assert.equal(attempts, 2, 'Failed over on 503');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('9. Handling rate limits and cooldowns', async () => {
        const tmpDir = createTempDir('rate-limit-cooldown');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn = cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Free Tier',
                apiKey: 'test-groq-key',
                defaultModel: 'llama-3.3-70b-versatile'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });

            adapter.completeWithConnection = async () => {
                return {
                    ok: false,
                    code: 'http_429',
                    error: 'Rate limit exceeded: please wait 60s'
                };
            };

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const result = await router.complete({
                messages: [{ role: 'user', content: 'test' }]
            });

            assert.equal(result.ok, false);
            assert.equal(result.code, 'http_429');

            // Connection is in cooldown and marked as RATE_LIMITED
            assert.equal(conn.state, CONNECTION_STATES.RATE_LIMITED);
            assert.ok(conn.cooldownUntil > Date.now());
            assert.equal(cm.isConnectionAvailable(conn.id), false);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('10. Handling invalid credentials without infinite retries', async () => {
        const tmpDir = createTempDir('invalid-credentials');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn = cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Bad Key Gemini',
                apiKey: 'invalid-key-xyz',
                defaultModel: 'gemini-2.0-flash'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });

            let callCount = 0;
            adapter.completeWithConnection = async () => {
                callCount++;
                return {
                    ok: false,
                    code: 'http_401',
                    error: 'API_KEY_INVALID'
                };
            };

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const result = await router.complete({
                messages: [{ role: 'user', content: 'test' }]
            });

            assert.equal(result.ok, false);
            assert.equal(callCount, 1, 'Never retries invalid credentials in a loop');
            assert.equal(conn.state, CONNECTION_STATES.INVALID_CREDENTIAL);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('11. Respecting free-only mode', async () => {
        const tmpDir = createTempDir('free-only');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Register paid custom model
            cm.saveConnection({
                provider: PROVIDER_TYPES.CUSTOM_OPENAI,
                label: 'Paid GPT-4o',
                apiKey: 'sk-paid-key',
                defaultModel: 'gpt-4o'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.FREE_ONLY }
            });

            // In free_only mode, paid connection must be rejected
            assert.throws(() => {
                router.resolveRoute();
            }, /No eligible active AI connections available/);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('12. Blocking paid fallback when pricing or eligibility is unknown', async () => {
        const tmpDir = createTempDir('unknown-pricing');
        try {
            const cat = new ModelCatalogue({ configDir: tmpDir });

            // Unknown model registered without verified free status
            cat.registerCustomModel({
                provider: 'custom-openai',
                id: 'unknown-mystery-model',
                pricing: { type: 'unknown' }
            });

            assert.equal(cat.isFreeEligible('unknown-mystery-model'), false, 'Unknown pricing is NEVER treated as free');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('13. Honoring local-only mode', async () => {
        const tmpDir = createTempDir('local-only');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Remote Gemini connection configured
            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Remote Gemini',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.LOCAL_ONLY }
            });

            // Local only fails honestly rather than dispatching to Gemini
            assert.throws(() => {
                router.resolveRoute();
            }, /Local-only mode active, but no local inference connection/);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('14. Honoring request cancellation', async () => {
        const tmpDir = createTempDir('cancellation');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini',
                apiKey: 'test-key',
                defaultModel: 'gemini-2.0-flash'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const controller = new AbortController();
            controller.abort(); // Cancelled before dispatch

            const res = await router.complete({
                messages: [{ role: 'user', content: 'test' }],
                signal: controller.signal
            });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'user_cancelled');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('15. Preventing duplicate consequential tool execution', async () => {
        const tmpDir = createTempDir('consequential-safety');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq 1',
                apiKey: 'test-groq-key',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 10
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini 2',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 20
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });

            let attempts = 0;
            adapter.completeWithConnection = async () => {
                attempts++;
                return {
                    ok: false,
                    code: 'http_500',
                    error: 'Server internal error after partial stream'
                };
            };

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            // When consequential side effects have already occurred, failover is aborted
            const res = await router.complete(
                { messages: [{ role: 'user', content: 'execute delete file' }] },
                { hasConsequentialSideEffects: true }
            );

            assert.equal(res.ok, false);
            assert.equal(res.code, 'failover_aborted_consequential');
            assert.equal(attempts, 1, 'Does not rerun request against secondary provider');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('16. Recovering an unavailable connection', async () => {
        const tmpDir = createTempDir('recovery');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn = cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Recoverable Conn',
                apiKey: 'test-groq-key',
                defaultModel: 'llama-3.3-70b-versatile'
            });

            // Mark failed with temporary rate limit
            cm.markFailed(conn.id, 'rate_limited', '429 Rate limit', 1); // 1 second cooldown
            assert.equal(cm.isConnectionAvailable(conn.id), false);

            // Wait for cooldown
            await new Promise((r) => setTimeout(r, 1100));
            assert.equal(cm.isConnectionAvailable(conn.id), true, 'Recovers after cooldown');

            // Explicitly mark healthy
            cm.markHealthy(conn.id);
            assert.equal(cm.getConnection(conn.id).state, CONNECTION_STATES.CONNECTED);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('17. Correctly reporting the model and provider actually used', async () => {
        const tmpDir = createTempDir('reporting');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn = cm.saveConnection({
                provider: PROVIDER_TYPES.CEREBRAS,
                label: 'Cerebras Fast Inference',
                apiKey: 'test-key',
                defaultModel: 'llama3.1-8b'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new ProviderAdapter({ credentialStore: credStore });

            adapter.completeWithConnection = async () => ({
                ok: true,
                provider: PROVIDER_TYPES.CEREBRAS,
                model: 'llama3.1-8b',
                content: 'Fast response',
                usage: { promptTokens: 10, completionTokens: 5 }
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'hi' }]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.CEREBRAS);
            assert.equal(res.model, 'llama3.1-8b');
            assert.equal(res.connectionLabel, 'Cerebras Fast Inference');

            const lastRoute = router.getLastUsedRoute();
            assert.equal(lastRoute.provider, PROVIDER_TYPES.CEREBRAS);
            assert.equal(lastRoute.model, 'llama3.1-8b');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('18. Handling unavailable catalogue endpoints', async () => {
        const tmpDir = createTempDir('catalogue-fallback');
        try {
            const cat = new ModelCatalogue({ configDir: tmpDir });

            // Attempt to refresh local models with an unreachable endpoint
            const res = await cat.refreshLocalModels('http://127.0.0.1:54321');
            assert.equal(res.ok, false);

            // Catalogue preserves built-in known models gracefully
            const models = cat.listModels();
            assert.ok(models.length > 5, 'Built-in models remain fully available');
            assert.ok(cat.getModel('gemini-2.0-flash'), 'Gemini model exists');
            assert.ok(cat.getModel('llama-3.3-70b-versatile'), 'Groq model exists');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('19. Preserving existing provider configuration', async () => {
        const tmpDir = createTempDir('legacy-migration');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            // Legacy single key stored directly under gemini_api_key
            credStore.setSecret('gemini_api_key', 'legacy_gemini_api_key_value_123');

            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Verifies migration into a connection while preserving the key
            const conns = cm.listSanitizedConnections();
            const migrated = conns.find((c) => c.provider === PROVIDER_TYPES.GEMINI);
            assert.ok(migrated, 'Legacy key automatically migrated to a connection');
            assert.equal(cm.getApiKey(migrated.id), 'legacy_gemini_api_key_value_123');
            assert.equal(credStore.getSecret('gemini_api_key'), 'legacy_gemini_api_key_value_123', 'Legacy key preserved');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    await t.test('20. Verifying packaged-app credential access without bundling secrets', async () => {
        // Verify source files and configs do NOT contain hardcoded API keys
        const providerAdapterSrc = fs.readFileSync(path.join(__dirname, '../../src/providers/provider-adapter.js'), 'utf8');
        const connectionManagerSrc = fs.readFileSync(path.join(__dirname, '../../src/providers/connection-manager.js'), 'utf8');
        const modelRouterSrc = fs.readFileSync(path.join(__dirname, '../../src/providers/model-router.js'), 'utf8');

        // Check for common real key patterns (e.g. AIza, sk-, gsk_)
        assert.ok(!providerAdapterSrc.includes('AIzaSy'), 'No hardcoded Gemini keys in provider-adapter.js');
        assert.ok(!connectionManagerSrc.includes('AIzaSy'), 'No hardcoded Gemini keys in connection-manager.js');
        assert.ok(!modelRouterSrc.includes('AIzaSy'), 'No hardcoded Gemini keys in model-router.js');
        assert.ok(!connectionManagerSrc.includes('gsk_'), 'No hardcoded Groq keys in connection-manager.js');
    });
});
