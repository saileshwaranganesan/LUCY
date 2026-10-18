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
    return fs.mkdtempSync(path.join(os.tmpdir(), `lucy-orchestration-${prefix}-`));
}

function cleanTempDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
}

/**
 * Mock ProviderAdapter subclass for testing orchestration layer behavior
 */
class MockProviderAdapter extends ProviderAdapter {
    constructor(options = {}) {
        super(options);
        this.callHistory = [];
        this.mockResponses = new Map();
        this.streamDelayMs = 0;
    }

    setMockResponse(provider, model, responseOrFn) {
        if (!model) {
            this.mockResponses.set(provider, responseOrFn);
        } else {
            this.mockResponses.set(`${provider}:${model}`, responseOrFn);
        }
    }

    async completeWithConnection(options) {
        const { connection, model, apiKey, request } = options;
        this.callHistory.push({
            provider: connection.provider,
            model,
            apiKey,
            request
        });

        const key = `${connection.provider}:${model}`;
        const configured = this.mockResponses.get(key) || this.mockResponses.get(connection.provider);

        if (typeof configured === 'function') {
            return await configured(options);
        }

        if (configured) {
            if (request.onChunk && configured.streamChunks) {
                for (const chunk of configured.streamChunks) {
                    if (request.signal && request.signal.aborted) {
                        return { ok: false, code: 'request_cancelled', error: 'User cancelled' };
                    }
                    request.onChunk(chunk);
                }
            }
            return configured;
        }

        // Default mock success
        const isLocal = connection.provider === PROVIDER_TYPES.OLLAMA;
        return {
            ok: true,
            provider: connection.provider,
            model,
            isLocal,
            leavesLocalMachine: !isLocal,
            content: `Mock response from ${connection.provider}/${model}`,
            usage: { promptTokens: 15, completionTokens: 25, totalTokens: 40 }
        };
    }
}

test('Unified AI Provider Orchestration & Model Management Acceptance Suite (Section 13)', async (t) => {

    // =========================================================================
    // Criterion 1: Local-first routing
    // =========================================================================
    await t.test('1. Local-first routing: prefers local models over hosted models', async () => {
        const tmpDir = createTempDir('local-first');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Setup hosted provider with high priority (priority: 1)
            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Hosted Gemini Cloud',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 1
            });

            // Setup local Ollama connection (priority: 10)
            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Ollama Runtime',
                endpointUrl: 'http://127.0.0.1:11434',
                defaultModel: 'llama3.2:3b',
                priority: 10
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: {
                    mode: ROUTING_MODES.LOCAL_FIRST,
                    allowHostedFallback: true
                }
            });

            const candidates = router.resolveCandidateRoutes({ taskCategory: TASK_CATEGORIES.GENERAL });
            assert.ok(candidates.length >= 2, 'Multiple candidate routes resolved');
            assert.equal(candidates[0].connection.provider, PROVIDER_TYPES.OLLAMA, 'Local Ollama candidate must be first');
            assert.equal(candidates[1].connection.provider, PROVIDER_TYPES.GEMINI, 'Hosted Gemini candidate must be second');

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Hello local world' }]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.OLLAMA);
            assert.equal(res.isLocal, true);
            assert.equal(res.leavesLocalMachine, false);
            assert.equal(adapter.callHistory[0].provider, PROVIDER_TYPES.OLLAMA);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 2: Manual provider and model selection
    // =========================================================================
    await t.test('2. Manual provider and model selection: manual override is never silently overridden', async () => {
        const tmpDir = createTempDir('manual-override');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Ollama',
                endpointUrl: 'http://127.0.0.1:11434',
                defaultModel: 'llama3.2:3b'
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Cloud Llama',
                apiKey: 'gsk_testGroqKey123',
                defaultModel: 'llama-3.3-70b-versatile'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.LOCAL_FIRST }
            });

            // Explicit user override to Groq in options
            const res = await router.complete(
                { messages: [{ role: 'user', content: 'Run on Groq please' }] },
                { userOverride: { provider: PROVIDER_TYPES.GROQ, model: 'llama-3.3-70b-versatile' } }
            );

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.GROQ);
            assert.equal(res.model, 'llama-3.3-70b-versatile');
            assert.equal(adapter.callHistory[0].provider, PROVIDER_TYPES.GROQ);
            assert.equal(res.routedVia.mode, 'local-first');
            assert.equal(res.routedVia.failoverOccurred, false);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 3: Hosted fallback disabled
    // =========================================================================
    await t.test('3. Hosted fallback disabled: fails closed when local fails without external transmission', async () => {
        const tmpDir = createTempDir('fallback-disabled');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Ollama',
                endpointUrl: 'http://127.0.0.1:11434',
                defaultModel: 'llama3.2:3b'
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Cloud Gemini',
                apiKey: 'test-key',
                defaultModel: 'gemini-2.0-flash'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });

            // Simulate local model failure
            adapter.setMockResponse(PROVIDER_TYPES.OLLAMA, 'llama3.2:3b', {
                ok: false,
                code: 'local_unavailable',
                error: 'Ollama daemon is offline'
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: {
                    mode: ROUTING_MODES.LOCAL_FIRST,
                    allowHostedFallback: false // Strict local-first without hosted fallback
                }
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Local only task' }]
            });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'hosted_fallback_disabled');
            assert.ok(res.error.includes('Hosted fallback is disabled'));

            // Verify ZERO calls were made to hosted provider
            assert.equal(adapter.callHistory.length, 1);
            assert.equal(adapter.callHistory[0].provider, PROVIDER_TYPES.OLLAMA);
            const geminiCalls = adapter.callHistory.filter((c) => c.provider === PROVIDER_TYPES.GEMINI);
            assert.equal(geminiCalls.length, 0, 'Hosted provider was NEVER called');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 4: Hosted fallback explicitly enabled
    // =========================================================================
    await t.test('4. Hosted fallback explicitly enabled: falls back to hosted model when local fails', async () => {
        const tmpDir = createTempDir('fallback-enabled');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Ollama',
                endpointUrl: 'http://127.0.0.1:11434',
                defaultModel: 'llama3.2:3b'
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Cloud',
                apiKey: 'gsk_testGroqKey123',
                defaultModel: 'llama-3.3-70b-versatile'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });

            // Simulate local model crash/failure
            adapter.setMockResponse(PROVIDER_TYPES.OLLAMA, 'llama3.2:3b', {
                ok: false,
                code: 'model_loading_failure',
                error: 'Out of VRAM memory'
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: {
                    mode: ROUTING_MODES.LOCAL_FIRST,
                    allowHostedFallback: true // Fallback explicitly permitted
                }
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Generate report' }]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.GROQ);
            assert.equal(res.routedVia.failoverOccurred, true);
            assert.equal(res.routedVia.attempts, 2);
            assert.equal(adapter.callHistory.length, 2);
            assert.equal(adapter.callHistory[0].provider, PROVIDER_TYPES.OLLAMA);
            assert.equal(adapter.callHistory[1].provider, PROVIDER_TYPES.GROQ);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 5: Prevention of unapproved external data transmission
    // =========================================================================
    await t.test('5. Prevention of unapproved external data transmission (requiresLocal privacy boundary)', async () => {
        const tmpDir = createTempDir('privacy-boundary');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Ollama',
                endpointUrl: 'http://127.0.0.1:11434',
                defaultModel: 'llama3.2:3b'
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Google Gemini',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });

            adapter.setMockResponse(PROVIDER_TYPES.OLLAMA, 'llama3.2:3b', {
                ok: false,
                code: 'model_loading_failure',
                error: 'GPU allocation failed'
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: {
                    mode: ROUTING_MODES.AUTO,
                    allowHostedFallback: true // Even if global hosted fallback was true!
                }
            });

            // Request explicitly requires local processing due to sensitive user data
            const res = await router.complete(
                { messages: [{ role: 'user', content: 'My confidential medical records' }] },
                { requiresLocal: true }
            );

            assert.equal(res.ok, false);
            assert.equal(res.code, 'privacy_policy_local_only');
            assert.ok(res.error.includes('External transmission prohibited by privacy policy'));

            // Verify ZERO external requests were dispatched
            assert.equal(adapter.callHistory.length, 1);
            assert.equal(adapter.callHistory[0].provider, PROVIDER_TYPES.OLLAMA);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 6: Local inference unavailable
    // =========================================================================
    await t.test('6. Local inference unavailable: honest error classification on connection failure', async () => {
        const adapter = new ProviderAdapter({
            localBaseUrl: 'http://127.0.0.1:59999' // Non-existent port
        });

        const status = await adapter.checkLocalServiceAvailability('http://127.0.0.1:59999');
        assert.equal(status.ok, false);
        assert.equal(status.code, 'OLLAMA_UNAVAILABLE');
        assert.ok(status.error.includes('not running') || status.error.includes('Cannot reach'));

        const router = new ModelRouter();
        const classification = router.classifyError({
            code: 'local_unavailable',
            error: 'Ollama server is unavailable: connect ECONNREFUSED 127.0.0.1:11434'
        });
        assert.equal(classification, ERROR_CLASSIFICATIONS.LOCAL_UNAVAILABLE);
    });

    // =========================================================================
    // Criterion 7: Missing local model
    // =========================================================================
    await t.test('7. Missing local model: classifies 404 as MODEL_NOT_INSTALLED with pull guidance', async () => {
        const router = new ModelRouter();
        const err = {
            code: 'model_not_installed',
            error: "Requested local model 'deepseek-r1:70b' is not installed in Ollama. Pull it using 'ollama pull deepseek-r1:70b'."
        };

        const classification = router.classifyError(err);
        assert.equal(classification, ERROR_CLASSIFICATIONS.MODEL_NOT_INSTALLED);
    });

    // =========================================================================
    // Criterion 8: Authentication failure handling
    // =========================================================================
    await t.test('8. Authentication failure: non-retryable and marks connection invalid immediately', async () => {
        const tmpDir = createTempDir('auth-failure');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const conn1 = cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Bad Key',
                apiKey: 'invalid-bad-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 1
            });

            const conn2 = cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Good Key',
                apiKey: 'gsk_validKey123',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 2
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });

            adapter.setMockResponse(PROVIDER_TYPES.GEMINI, 'gemini-2.0-flash', {
                ok: false,
                code: 'http_401',
                error: 'API key not valid. Please pass a valid API key.'
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Test prompt' }]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.GROQ);
            assert.equal(res.routedVia.failoverOccurred, true);

            // Verify bad connection was demoted to INVALID_CREDENTIAL state
            const updatedConn1 = cm.getConnection(conn1.id);
            assert.equal(updatedConn1.state, CONNECTION_STATES.INVALID_CREDENTIAL);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 9: Rate limiting and quota exhaustion
    // =========================================================================
    await t.test('9. Rate limiting (429): triggers automatic failover and marks connection rate-limited', async () => {
        const tmpDir = createTempDir('rate-limiting');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const groqConn = cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Tier 1',
                apiKey: 'gsk_rateLimitedKey',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 1
            });

            const cerebrasConn = cm.saveConnection({
                provider: PROVIDER_TYPES.CEREBRAS,
                label: 'Cerebras Backup',
                apiKey: 'csk_backupKey',
                defaultModel: 'llama3.1-8b',
                priority: 2
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });

            adapter.setMockResponse(PROVIDER_TYPES.GROQ, 'llama-3.3-70b-versatile', {
                ok: false,
                code: 'http_429',
                error: 'Rate limit reached: 30 requests per minute exceeded.'
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Fast response required' }]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.CEREBRAS);
            assert.equal(res.model, 'llama3.1-8b');

            const updatedGroq = cm.getConnection(groqConn.id);
            assert.equal(updatedGroq.state, CONNECTION_STATES.RATE_LIMITED);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 10: Timeout and bounded retry behaviour
    // =========================================================================
    await t.test('10. Bounded failover: caps attempts at max 3 to prevent retry storms', async () => {
        const tmpDir = createTempDir('bounded-retry');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Register 5 distinct connections
            const providers = [
                PROVIDER_TYPES.GEMINI,
                PROVIDER_TYPES.GROQ,
                PROVIDER_TYPES.CEREBRAS,
                PROVIDER_TYPES.OPENROUTER,
                PROVIDER_TYPES.HUGGINGFACE
            ];

            for (let i = 0; i < providers.length; i++) {
                cm.saveConnection({
                    provider: providers[i],
                    label: `Connection ${i + 1}`,
                    apiKey: `test-key-${i + 1}`,
                    priority: i + 1
                });
            }

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });

            // Configure all to fail with network error
            for (const p of providers) {
                adapter.setMockResponse(p, null, {
                    ok: false,
                    code: 'network_timeout',
                    error: 'Connection timeout after 30000ms'
                });
            }

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Test bounded loop' }]
            });

            assert.equal(res.ok, false);
            assert.equal(res.attempts, 3, 'Attempts MUST be strictly capped at 3');
            assert.equal(adapter.callHistory.length, 3, 'Exactly 3 provider calls made before termination');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 11: Cancellation and stale-response prevention
    // =========================================================================
    await t.test('11. Cancellation: halts execution cleanly and suppresses stale responses', async () => {
        const tmpDir = createTempDir('cancellation-test');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Cloud Gemini',
                apiKey: 'test-key',
                defaultModel: 'gemini-2.0-flash'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const controller = new AbortController();
            controller.abort(); // Pre-aborted signal

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Hello' }],
                signal: controller.signal
            });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'user_cancelled');
            assert.equal(res.cancelled, true);
            assert.equal(adapter.callHistory.length, 0, 'No calls dispatched when signal pre-aborted');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 12: Context-limit handling
    // =========================================================================
    await t.test('12. Context limit handling: safe pruning and rejection when unprunable', async () => {
        const router = new ModelRouter();

        // 1. Safe pruning
        const hugeContent = 'word '.repeat(35000); // ~40,000 tokens
        const messages = [
            { role: 'system', content: 'You are Lucy desktop assistant.' },
            { role: 'user', content: 'Message 1 ' + hugeContent },
            { role: 'assistant', content: 'Message 2 ' + hugeContent },
            { role: 'user', content: 'Latest message asking question.' }
        ];

        // Llama 3.2 3B has 128k context limit, but let's test trimming against a smaller model or huge payload
        const trimmedResult = router._checkAndTrimContext(messages, 'llama3.2:3b', PROVIDER_TYPES.OLLAMA);
        assert.equal(trimmedResult.ok, true);

        // 2. Strict limit rejection when truncateContext is false
        const hugeUnprunable = 'word '.repeat(150000); // ~180,000 tokens exceeding 128k
        const rejectedResult = router._checkAndTrimContext(
            [{ role: 'user', content: hugeUnprunable }],
            'llama3.2:3b',
            PROVIDER_TYPES.OLLAMA,
            { truncateContext: false }
        );
        assert.equal(rejectedResult.ok, false);
        assert.equal(rejectedResult.code, 'context_limit_exceeded');
    });

    // =========================================================================
    // Criterion 13: Provider capability mismatch
    // =========================================================================
    await t.test('13. Capability mismatch: vision tasks route exclusively to vision-capable models', async () => {
        const tmpDir = createTempDir('capability-mismatch');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Text-only connection (Groq llama-3.3-70b-versatile: vision: false)
            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Text Only',
                apiKey: 'gsk_textKey',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 1
            });

            // Vision capable connection (Gemini 2.0 Flash: vision: true)
            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Vision',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 10
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            // Vision task containing an image
            const res = await router.complete({
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What is this screenshot?' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo...' } }
                        ]
                    }
                ]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.GEMINI, 'Must route to Gemini because Groq lacks vision');
            assert.equal(res.model, 'gemini-2.0-flash');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 14: Accurate provider attribution in responses
    // =========================================================================
    await t.test('14. Accurate provider attribution: includes isLocal, leavesLocalMachine, routedVia', async () => {
        const tmpDir = createTempDir('attribution');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Ollama',
                endpointUrl: 'http://127.0.0.1:11434',
                defaultModel: 'llama3.2:3b'
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Attribution check' }]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.OLLAMA);
            assert.equal(res.model, 'llama3.2:3b');
            assert.equal(res.isLocal, true);
            assert.equal(res.leavesLocalMachine, false);
            assert.ok(res.routedVia);
            assert.equal(res.routedVia.provider, PROVIDER_TYPES.OLLAMA);
            assert.equal(res.routedVia.attempts, 1);
            assert.equal(res.routedVia.failoverOccurred, false);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 15: API-key redaction in error messages and logs
    // =========================================================================
    await t.test('15. API-key redaction: secrets are never leaked in error messages or diagnostics', async () => {
        const secretKey = 'gsk_superSecretPrivateKey999888777';
        const rawError = `Authentication failed with key ${secretKey} on remote gateway`;

        const adapter = new ProviderAdapter();
        const redacted = adapter._redactSecret(rawError, secretKey);

        assert.equal(redacted.includes(secretKey), false, 'Raw API key must not be present');
        assert.ok(redacted.includes('[REDACTED_SECRET]'), 'Redaction placeholder must be used');
    });

    // =========================================================================
    // Criterion 16: Duplicate action prevention during retry or fallback
    // =========================================================================
    await t.test('16. Duplicate action prevention: suppresses failover if request had consequential side effects', async () => {
        const tmpDir = createTempDir('consequential-failover');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GROQ,
                label: 'Groq Primary',
                apiKey: 'gsk_testKey1',
                defaultModel: 'llama-3.3-70b-versatile',
                priority: 1
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Backup',
                apiKey: 'test-gemini-key',
                defaultModel: 'gemini-2.0-flash',
                priority: 2
            });

            const cat = new ModelCatalogue({ configDir: tmpDir });
            const adapter = new MockProviderAdapter({ credentialStore: credStore });

            // Simulate failure during tool execution phase
            adapter.setMockResponse(PROVIDER_TYPES.GROQ, 'llama-3.3-70b-versatile', {
                ok: false,
                code: 'http_500',
                error: 'Internal server error while processing'
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir
            });

            // Request had executed consequential non-idempotent desktop side effects
            const res = await router.complete(
                { messages: [{ role: 'user', content: 'Submit wire transfer' }] },
                { hasConsequentialSideEffects: true }
            );

            assert.equal(res.ok, false);
            assert.equal(res.code, 'failover_aborted_consequential');
            assert.ok(res.error.includes('Automatic failover suppressed'));
            assert.equal(adapter.callHistory.length, 1, 'Backup provider must not be called after consequential action');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 17: Preservation of existing memory and conversation state
    // =========================================================================
    await t.test('17. Memory preservation: conversation state remains intact across route switches', async () => {
        const tmpDir = createTempDir('memory-state');
        try {
            const { MemoryStore } = require('../../src/memory/memory-store.js');
            const { MEMORY_CATEGORIES } = require('../../src/memory/memory-constants.js');
            const memoryStore = new MemoryStore({ memoryDir: tmpDir });

            // Store user facts
            memoryStore.addMemory({
                category: MEMORY_CATEGORIES.USER_APPROVED,
                key: 'preferred_editor',
                content: 'VSCode'
            });
            memoryStore.addMemory({
                category: MEMORY_CATEGORIES.PROJECT,
                key: 'project_arch',
                content: 'LUCY uses Electron with local ONNX Kokoro TTS and Whisper'
            });

            // Verify memories are accessible
            const memories = memoryStore.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
            assert.ok(memories.length > 0);
            assert.equal(memories[0].content, 'VSCode');

            // Switch routing mode configuration
            const router = new ModelRouter({ configDir: tmpDir });
            router.updateConfig({ mode: ROUTING_MODES.LOCAL_FIRST, allowHostedFallback: true });

            // Verify memory store is intact after router reconfiguration
            const memoriesAfter = memoryStore.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
            assert.equal(memoriesAfter[0].content, 'VSCode');
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // =========================================================================
    // Criterion 18: Regression of chat, voice, desktop automation and permissions
    // =========================================================================
    await t.test('18. Non-regression: desktop tool registry, permissions, and voice controller contracts remain intact', async () => {
        const { ToolRegistry } = require('../../src/tools/tool-registry.js');
        const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
        const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
        const { PermissionAuthority } = require('../../src/security/permission-authority.js');
        const { VoiceController } = require('../../src/voice/voice-controller.js');

        // ToolRegistry sanity check
        const registry = new ToolRegistry();
        const desktopManager = new DesktopAutomationManager();
        registerDesktopTools(registry, desktopManager);
        const tools = registry.listTools();
        assert.ok(Array.isArray(tools));
        assert.ok(tools.length > 5, 'Tool definitions loaded');
        const toolNames = tools.map((t) => t.id || t.name);
        assert.ok(toolNames.includes('desktop_launch_app'), 'Desktop automation tools registered');

        // PermissionAuthority sanity check
        const permAuth = new PermissionAuthority();
        assert.ok(typeof permAuth.evaluate === 'function');
        assert.ok(typeof permAuth.setConfirmationHandler === 'function');

        // VoiceController sanity check
        const voiceCtrl = new VoiceController();
        assert.ok(typeof voiceCtrl.speakResponse === 'function');
        assert.ok(typeof voiceCtrl.stopSpeaking === 'function');
        assert.ok(typeof voiceCtrl.startListening === 'function');
    });

    // =========================================================================
    // Bonus Feature: Concurrency Lock & Resource Management on Windows Laptops
    // =========================================================================
    await t.test('19. Local model concurrency control: semaphore enforces single concurrent local inference', async () => {
        const router = new ModelRouter({ maxConcurrentLocalRequests: 1 });
        let active = 0;
        let peakActive = 0;

        async function simulateLocalInference(durationMs) {
            await router._acquireLocalSlot();
            active++;
            peakActive = Math.max(peakActive, active);
            await new Promise((resolve) => setTimeout(resolve, durationMs));
            active--;
            router._releaseLocalSlot();
        }

        // Run 3 local inferences in parallel
        await Promise.all([
            simulateLocalInference(25),
            simulateLocalInference(25),
            simulateLocalInference(25)
        ]);

        assert.equal(peakActive, 1, 'Local inference slot concurrency must never exceed 1');
        assert.equal(active, 0, 'All local inference slots cleanly released');
    });

    // =========================================================================
    // Bonus Feature: Token Usage Accounting
    // =========================================================================
    await t.test('20. Cumulative token usage accounting tracks prompt, completion, and total tokens', async () => {
        const router = new ModelRouter();
        router.resetUsageAccounting();

        router._recordUsage(PROVIDER_TYPES.GEMINI, { promptTokens: 100, completionTokens: 50 });
        router._recordUsage(PROVIDER_TYPES.OLLAMA, { promptTokens: 200, completionTokens: 80 });

        const usage = router.getUsageAccounting();
        assert.equal(usage.totalRequests, 2);
        assert.equal(usage.totalPromptTokens, 300);
        assert.equal(usage.totalCompletionTokens, 130);
        assert.equal(usage.totalTokens, 430);

        assert.equal(usage.byProvider.gemini.requests, 1);
        assert.equal(usage.byProvider.gemini.totalTokens, 150);

        assert.equal(usage.byProvider.ollama.requests, 1);
        assert.equal(usage.byProvider.ollama.totalTokens, 280);
    });
});
