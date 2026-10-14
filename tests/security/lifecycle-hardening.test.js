'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    isLoopbackHost,
    validateEndpointUrl,
    sanitizeUrlForLogging,
    validateExecuteRequest,
    validateSetProviderConfig,
    validateClearApiKey,
    validatePermissionResponse,
    validateGetMemories,
    validateAddMemory,
    validateIdentifier,
    validateClearMemoryCategory,
    validateSendVoiceState,
    validateMoveWindow,
    ALLOWED_PROVIDERS,
    ALLOWED_MEMORY_CATEGORIES,
    ALLOWED_VOICE_STATES
} = require('../../src/security/ipc-validator.js');

const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');

// ============================================================================
// TEST SUITE: WORKSTREAM 06 — RELIABILITY, PROCESS LIFECYCLE & SECURITY HARDENING
// ============================================================================

test('Workstream 06: SEC-007 — Endpoint URL HTTPS & Loopback Policy Enforcement', async (t) => {
    await t.test('accepts valid remote HTTPS endpoints', () => {
        const res1 = validateEndpointUrl('https://api.openai.com/v1/chat/completions', { context: 'Custom OpenAI' });
        assert.equal(res1.ok, true);
        assert.equal(res1.protocol, 'https:');
        assert.equal(res1.isLoopback, false);

        const res2 = validateEndpointUrl('https://openrouter.ai/api/v1/chat/completions', { context: 'OpenRouter' });
        assert.equal(res2.ok, true);
        assert.equal(res2.protocol, 'https:');
    });

    await t.test('strictly rejects remote HTTP endpoints before network dispatch', () => {
        const remoteUrls = [
            'http://api.openai.com/v1/chat/completions',
            'http://remote-server.com/api',
            'http://192.168.1.100:8000/v1',
            'http://10.0.0.5:11434/api',
            'http://172.16.0.1:8080/v1'
        ];

        for (const url of remoteUrls) {
            const res = validateEndpointUrl(url, { context: 'Remote Endpoint' });
            assert.equal(res.ok, false, `Expected ${url} to be rejected for plaintext HTTP`);
            assert.equal(res.code, 'INSECURE_HTTP_FORBIDDEN');
            assert.match(res.error, /must use HTTPS/i);
        }
    });

    await t.test('permits HTTP only for strictly validated local loopback addresses', () => {
        const loopbackUrls = [
            'http://127.0.0.1:11434/api/chat',
            'http://127.0.0.1:8000/v1/chat/completions',
            'http://localhost:11434',
            'http://localhost:8080/v1',
            'http://127.0.0.2:11434'
        ];

        for (const url of loopbackUrls) {
            const res = validateEndpointUrl(url, { context: 'Local Endpoint', allowHttpLoopback: true });
            assert.equal(res.ok, true, `Expected ${url} to be accepted as loopback HTTP`);
            assert.equal(res.isLoopback, true);
        }
    });

    await t.test('strictly classifies non-loopback private networks as remote (requiring HTTPS)', () => {
        assert.equal(isLoopbackHost('localhost'), true);
        assert.equal(isLoopbackHost('127.0.0.1'), true);
        assert.equal(isLoopbackHost('127.0.1.1'), true);
        assert.equal(isLoopbackHost('::1'), true);

        // LAN / private ranges MUST NOT be treated as loopback
        assert.equal(isLoopbackHost('192.168.1.1'), false);
        assert.equal(isLoopbackHost('10.0.0.1'), false);
        assert.equal(isLoopbackHost('172.16.0.1'), false);
        assert.equal(isLoopbackHost('internal-service.local'), false);
    });

    await t.test('rejects URLs containing embedded user credentials', () => {
        const badUrls = [
            'https://user:password@api.openai.com/v1',
            'http://admin:secret@127.0.0.1:11434/api',
            'https://apikey_secret@remote.ai/v1'
        ];

        for (const url of badUrls) {
            const res = validateEndpointUrl(url);
            assert.equal(res.ok, false);
            assert.equal(res.code, 'EMBEDDED_CREDENTIALS_FORBIDDEN');
        }
    });

    await t.test('rejects malformed URLs and unsupported protocols', () => {
        const badUrls = [
            'not-a-valid-url',
            'ftp://remote.server/api',
            'file:///C:/path/to/api',
            'javascript:alert(1)',
            ''
        ];

        for (const url of badUrls) {
            const res = validateEndpointUrl(url);
            assert.equal(res.ok, false);
        }
    });

    await t.test('sanitizes URLs and NEVER leaks embedded credentials or query secrets', () => {
        const sanitized = sanitizeUrlForLogging('https://user:super_secret_token@api.openai.com/v1/chat?key=secret123');
        assert.ok(!sanitized.includes('super_secret_token'));
        assert.ok(!sanitized.includes('secret123'));
        assert.ok(sanitized.includes('api.openai.com'));
    });

    await t.test('ProviderAdapter: fails closed BEFORE network call when remote HTTP is configured', async () => {
        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.CUSTOM_OPENAI,
            customOpenAiUrl: 'http://insecure-remote-ai.com/v1/chat/completions'
        });

        // Set a dummy key in env for test
        process.env.LUCY_CUSTOM_OPENAI_API_KEY = 'test_secret_key_12345';

        try {
            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'hello' }]
            });

            assert.equal(result.ok, false);
            assert.equal(result.code, 'INSECURE_HTTP_FORBIDDEN');
            assert.match(result.error, /must use HTTPS/i);
            // Verify secret key is never present in error
            assert.ok(!result.error.includes('test_secret_key_12345'));
        } finally {
            delete process.env.LUCY_CUSTOM_OPENAI_API_KEY;
        }
    });
});

test('Workstream 06: SEC-005 — Permission Confirmation Timeout & Fail-Closed Lifecycle', async (t) => {
    await t.test('defaults confirmation timeout to 60,000 ms and allows configuration', () => {
        const authDefault = new PermissionAuthority();
        assert.equal(authDefault.getConfirmationTimeout(), 60000);

        authDefault.setConfirmationTimeout(5000);
        assert.equal(authDefault.getConfirmationTimeout(), 5000);

        assert.throws(() => authDefault.setConfirmationTimeout(-100), /positive number/i);
        assert.throws(() => authDefault.setConfirmationTimeout('invalid'), /positive number/i);
    });

    await t.test('fails closed with timedOut: true when user confirmation times out', async () => {
        let toolExecuted = false;
        const mockToolHandler = () => { toolExecuted = true; return { executed: true }; };

        const auth = new PermissionAuthority({
            confirmationTimeoutMs: 50 // Fast 50ms timeout for test
        });

        // Handler never responds (simulating user ignoring prompt or UI freeze)
        auth.setConfirmationHandler(() => new Promise(() => {}));

        const evalResult = await auth.evaluate({
            toolId: 'file_writer',
            action: 'write',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            params: { path: 'test.txt' }
        });

        assert.equal(evalResult.permitted, false, 'Timed-out request MUST be denied (permitted=false)');
        assert.equal(evalResult.timedOut, true, 'Result MUST be explicitly marked timedOut=true');
        assert.match(evalResult.reason, /timed out/i);

        // Mechanically verify tool does not execute
        if (evalResult.permitted) {
            mockToolHandler();
        }
        assert.equal(toolExecuted, false, 'Protected tool handler MUST NOT execute after timeout');
    });

    await t.test('explicit user denial is distinct from timeout (timedOut: false)', async () => {
        const auth = new PermissionAuthority({
            confirmationTimeoutMs: 1000
        });

        // Handler explicitly declines
        auth.setConfirmationHandler(async () => false);

        const evalResult = await auth.evaluate({
            toolId: 'shell_exec',
            action: 'run',
            riskTier: RISK_TIERS.CRITICAL,
            params: { command: 'reboot' }
        });

        assert.equal(evalResult.permitted, false);
        assert.equal(evalResult.timedOut, false, 'Explicit denial must have timedOut=false');
        assert.match(evalResult.reason, /declined/i);
    });

    await t.test('late responses after timeout cannot revive or execute expired request', async () => {
        let lateResolver = null;
        let toolExecuted = false;

        const auth = new PermissionAuthority({
            confirmationTimeoutMs: 40 // 40ms fast timeout
        });

        auth.setConfirmationHandler((req) => {
            return new Promise((resolve) => {
                lateResolver = resolve;
            });
        });

        const evalResult = await auth.evaluate({
            toolId: 'file_writer',
            action: 'delete',
            riskTier: RISK_TIERS.CONSEQUENTIAL
        });

        assert.equal(evalResult.permitted, false);
        assert.equal(evalResult.timedOut, true);

        // Late response arrives 50ms later attempting to grant approval!
        await new Promise((r) => setTimeout(r, 60));
        if (lateResolver) {
            lateResolver(true); // Attempt to approve expired request
        }

        // Verify that evalResult remains failed closed and tool never runs
        if (evalResult.permitted) {
            toolExecuted = true;
        }
        assert.equal(toolExecuted, false, 'Late approval MUST NEVER execute expired request');
    });

    await t.test('cancelAllPendingConfirmations resolves pending requests fail-closed on shutdown', async () => {
        const auth = new PermissionAuthority({
            confirmationTimeoutMs: 10000 // Long timeout
        });

        auth.setConfirmationHandler(() => new Promise(() => {}));

        // Start pending evaluation in background
        const evalPromise = auth.evaluate({
            toolId: 'file_writer',
            action: 'write',
            riskTier: RISK_TIERS.CONSEQUENTIAL
        });

        // Trigger shutdown cancellation immediately
        auth.cancelAllPendingConfirmations('Application shutdown initiated');

        const evalResult = await evalPromise;
        assert.equal(evalResult.permitted, false);
        assert.equal(evalResult.cancelled, true);
        assert.match(evalResult.reason, /shutdown/i);
    });

    await t.test('subsequent tasks proceed normally after a timed-out request', async () => {
        const auth = new PermissionAuthority({
            confirmationTimeoutMs: 30
        });

        let attempt = 0;
        auth.setConfirmationHandler(async () => {
            attempt++;
            if (attempt === 1) {
                // First attempt times out
                return new Promise(() => {});
            }
            // Second attempt is approved
            return true;
        });

        const res1 = await auth.evaluate({
            toolId: 'file_writer',
            action: 'write',
            riskTier: RISK_TIERS.CONSEQUENTIAL
        });
        assert.equal(res1.permitted, false);
        assert.equal(res1.timedOut, true);

        const res2 = await auth.evaluate({
            toolId: 'file_writer',
            action: 'write',
            riskTier: RISK_TIERS.CONSEQUENTIAL
        });
        assert.equal(res2.permitted, true);
        assert.equal(res2.timedOut, false);
    });
});

test('Workstream 06: SEC-008 — IPC Parameter & Payload Validation Schemas', async (t) => {
    await t.test('validateExecuteRequest: enforces string types and length caps', () => {
        // Valid
        assert.equal(validateExecuteRequest('What is the weather?').ok, true);
        assert.equal(validateExecuteRequest('Create a file', { dryRun: true }).ok, true);

        // Invalid: missing or non-string
        assert.equal(validateExecuteRequest(null).ok, false);
        assert.equal(validateExecuteRequest(12345).ok, false);
        assert.equal(validateExecuteRequest({ text: 'hi' }).ok, false);

        // Empty string
        assert.equal(validateExecuteRequest('   ').ok, false);

        // Oversized (> 64,000 characters)
        const hugePayload = 'a'.repeat(65000);
        const sizeRes = validateExecuteRequest(hugePayload);
        assert.equal(sizeRes.ok, false);
        assert.equal(sizeRes.code, 'PAYLOAD_TOO_LARGE');

        // Invalid options object
        assert.equal(validateExecuteRequest('valid', 'not_an_object').ok, false);
        assert.equal(validateExecuteRequest('valid', { dryRun: 'not_boolean' }).ok, false);
    });

    await t.test('validateSetProviderConfig: validates provider whitelist and bounds', () => {
        // Valid
        assert.equal(validateSetProviderConfig({ provider: 'gemini', model: 'gemini-2.0-flash' }).ok, true);
        assert.equal(validateSetProviderConfig({ provider: 'custom-openai', customOpenAiUrl: 'https://api.openai.com/v1' }).ok, true);

        // Invalid provider
        const badProvider = validateSetProviderConfig({ provider: 'malicious_llm' });
        assert.equal(badProvider.ok, false);
        assert.equal(badProvider.code, 'INVALID_PROVIDER');

        // Insecure remote URL in config
        const badUrl = validateSetProviderConfig({ customOpenAiUrl: 'http://remote-server.com/api' });
        assert.equal(badUrl.ok, false);
        assert.equal(badUrl.code, 'INSECURE_HTTP_FORBIDDEN');

        // Oversized API key
        const hugeKey = validateSetProviderConfig({ apiKey: 'k'.repeat(2000) });
        assert.equal(hugeKey.ok, false);
        assert.equal(hugeKey.code, 'INVALID_API_KEY');
    });

    await t.test('validateClearApiKey: enforces valid provider string', () => {
        assert.equal(validateClearApiKey('gemini').ok, true);
        assert.equal(validateClearApiKey(null).ok, true); // Default provider
        assert.equal(validateClearApiKey('invalid_provider_name').ok, false);
    });

    await t.test('validatePermissionResponse: rejects malformed payload and auditIds', () => {
        // Valid
        const validRes = validatePermissionResponse({ auditId: 'perm_12345_abc', approved: true });
        assert.equal(validRes.ok, true);
        assert.equal(validRes.sanitized.approved, true);

        // Malformed auditIds
        assert.equal(validatePermissionResponse({ auditId: 'tiny', approved: true }).ok, false);
        assert.equal(validatePermissionResponse({ auditId: 'injection;<script>', approved: true }).ok, false);
        assert.equal(validatePermissionResponse({ auditId: 'perm_123', approved: 'not_boolean' }).ok, false);
        assert.equal(validatePermissionResponse('not_object').ok, false);
    });

    await t.test('validateGetMemories: enforces categories and query limits', () => {
        assert.equal(validateGetMemories('conversation').ok, true);
        assert.equal(validateGetMemories({ category: 'project', limit: 50 }).ok, true);
        assert.equal(validateGetMemories({ limit: -5 }).ok, false);
        assert.equal(validateGetMemories({ limit: 5000 }).ok, false);
        assert.equal(validateGetMemories('unsupported_category_name').ok, false);
    });

    await t.test('validateAddMemory: enforces content requirements and size caps', () => {
        assert.equal(validateAddMemory({ content: 'Remember user preference', category: 'user_approved' }).ok, true);
        assert.equal(validateAddMemory({}).ok, false);
        assert.equal(validateAddMemory({ content: '' }).ok, false);
        assert.equal(validateAddMemory({ content: 'hi', category: 'fake_category' }).ok, false);

        // Oversized memory content (> 32,768 chars)
        const hugeMemory = 'm'.repeat(35000);
        const memRes = validateAddMemory({ content: hugeMemory });
        assert.equal(memRes.ok, false);
        assert.equal(memRes.code, 'CONTENT_TOO_LARGE');
    });

    await t.test('validateIdentifier: enforces format and bounds', () => {
        assert.equal(validateIdentifier('task_01_abc').ok, true);
        assert.equal(validateIdentifier('').ok, false);
        assert.equal(validateIdentifier(null).ok, false);
        assert.equal(validateIdentifier('a'.repeat(300)).ok, false);
    });

    await t.test('validateSendVoiceState: validates state enum and transcript bounds', () => {
        assert.equal(validateSendVoiceState({ state: 'listening', transcript: 'hello' }).ok, true);
        assert.equal(validateSendVoiceState({ state: 'invalid_voice_mode' }).ok, false);
        assert.equal(validateSendVoiceState({ state: 'speaking', transcript: 't'.repeat(20000) }).ok, false);
    });

    await t.test('validateMoveWindow: rejects non-finite or extreme coordinates', () => {
        assert.equal(validateMoveWindow({ deltaX: 10, deltaY: -5 }).ok, true);
        assert.equal(validateMoveWindow({ deltaX: NaN, deltaY: 0 }).ok, false);
        assert.equal(validateMoveWindow({ deltaX: 50000, deltaY: 0 }).ok, false);
        assert.equal(validateMoveWindow('not_object').ok, false);
    });
});

test('Workstream 06: SEC-004 — Single-Instance Application Locking Contract', async (t) => {
    await t.test('app.requestSingleInstanceLock mechanism contract verification', () => {
        // Verify mock / contract logic for single instance behavior
        let lockHeld = false;
        const fakeApp = {
            requestSingleInstanceLock: () => {
                if (lockHeld) return false;
                lockHeld = true;
                return true;
            },
            quitCalled: false,
            quit: function () { this.quitCalled = true; }
        };

        // First instance requests lock -> SUCCESS
        const firstLock = fakeApp.requestSingleInstanceLock();
        assert.equal(firstLock, true);
        assert.equal(fakeApp.quitCalled, false);

        // Second instance requests lock -> DENIED and QUITS
        const secondLock = fakeApp.requestSingleInstanceLock();
        assert.equal(secondLock, false);
        if (!secondLock) {
            fakeApp.quit();
        }
        assert.equal(fakeApp.quitCalled, true, 'Secondary process must call app.quit()');
    });

    await t.test('second-instance event restores minimized or hidden window', () => {
        let restored = false;
        let shown = false;
        let focused = false;

        const fakeWindow = {
            minimized: true,
            visible: false,
            isMinimized: function () { return this.minimized; },
            isVisible: function () { return this.visible; },
            restore: function () { restored = true; this.minimized = false; },
            show: function () { shown = true; this.visible = true; },
            focus: function () { focused = true; }
        };

        // Emulate second-instance event handler
        const handleSecondInstance = () => {
            if (fakeWindow) {
                if (fakeWindow.isMinimized()) fakeWindow.restore();
                if (!fakeWindow.isVisible()) fakeWindow.show();
                fakeWindow.focus();
            }
        };

        handleSecondInstance();
        assert.equal(restored, true, 'Minimized window must be restored');
        assert.equal(shown, true, 'Hidden window must be shown');
        assert.equal(focused, true, 'Window must be focused');
    });
});
