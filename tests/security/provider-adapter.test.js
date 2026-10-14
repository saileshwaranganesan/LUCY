'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { CredentialStore } = require('../../src/security/credential-store.js');

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

test('Provider Adapter: Security, Cost Tracking, and Fail-Closed Behavior', async (t) => {
    const tempStoreDir = path.join(os.tmpdir(), `lucy-provider-test-${Date.now()}`);
    const store = new CredentialStore({ storeDir: tempStoreDir });

    t.after(() => {
        fs.rmSync(tempStoreDir, { recursive: true, force: true });
    });

    await t.test('fails closed when required API key is missing', async () => {
        delete process.env.LUCY_GEMINI_API_KEY;

        const adapter = new ProviderAdapter({
            credentialStore: store,
            provider: PROVIDER_TYPES.GEMINI
        });

        const result = await adapter.complete({
            messages: [{ role: 'user', content: 'Hello' }]
        });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'missing_credentials');
        assert.ok(result.error.includes('Missing API key'));
        assert.deepEqual(result.usage, { status: 'unknown' });
        assert.deepEqual(result.cost, { status: 'unknown' });
    });

    await t.test('does NOT fall back to a secondary paid provider on failure', async () => {
        store.setSecret('gemini_api_key', 'invalid-test-key');

        const adapter = new ProviderAdapter({
            credentialStore: store,
            provider: PROVIDER_TYPES.GEMINI
        });

        const result = await adapter.complete({
            messages: [{ role: 'user', content: 'Ping' }]
        });

        // Provider must report the error for Gemini, never secretly switch to OpenRouter or OpenAI
        assert.equal(result.ok, false);
        assert.equal(result.provider, PROVIDER_TYPES.GEMINI);
        assert.equal(adapter.allowPaidFallback, false);
    });

    await t.test('formats usage accurately and reports unknown instead of zero when missing', () => {
        const adapter = new ProviderAdapter();

        // 1. Completely missing usage
        const missingUsage = adapter._formatUsage(null);
        assert.deepEqual(missingUsage, { status: 'unknown' });

        const missingCost = adapter._formatCost(missingUsage);
        assert.deepEqual(missingCost, { status: 'unknown' });

        // 2. Empty object usage
        const emptyUsage = adapter._formatUsage({});
        assert.deepEqual(emptyUsage, { status: 'unknown' });

        // 3. Valid reported usage
        const reported = adapter._formatUsage({
            promptTokenCount: 1500,
            candidatesTokenCount: 200
        });
        assert.equal(reported.status, 'reported');
        assert.equal(reported.promptTokens, 1500);
        assert.equal(reported.completionTokens, 200);
        assert.equal(reported.totalTokens, 1700);

        // 4. Cost calculation for Gemini 2.0 Flash
        adapter.setProvider(PROVIDER_TYPES.GEMINI);
        const cost = adapter._formatCost(reported);
        assert.equal(cost.status, 'estimated');
        assert.ok(cost.amount > 0);
        assert.equal(cost.currency, 'USD');
    });
});
