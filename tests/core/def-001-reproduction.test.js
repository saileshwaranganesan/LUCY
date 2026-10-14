'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { TaskPlanner } = require('../../src/core/task-planner.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { CredentialStore } = require('../../src/security/credential-store.js');

test('DEF-001: Task Intent Planning — Generative Content vs Literal Arguments', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-def001-eval-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    });

    const credStore = new CredentialStore({ storeDir: path.join(testDir, 'creds') });
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool({
        id: 'desktop_launch_app',
        name: 'Launch Desktop App',
        description: 'Launch application',
        schema: {
            type: 'object',
            properties: { executable: { type: 'string' } },
            required: ['executable']
        },
        handler: async () => ({ ok: true, status: 'launched', verification: { verified: true } })
    });
    toolRegistry.registerTool({
        id: 'desktop_type_text',
        name: 'Type Text',
        description: 'Type text into active desktop application',
        schema: {
            type: 'object',
            properties: { target: { type: 'string' }, text: { type: 'string' } },
            required: ['target', 'text']
        },
        handler: async () => ({ ok: true, status: 'typed', verification: { verified: true } })
    });

    // Mock provider adapter that generates content
    const mockProvider = new ProviderAdapter({
        credentialStore: credStore,
        provider: PROVIDER_TYPES.GEMINI
    });
    mockProvider.resolveApiKey = () => 'mock-api-key';
    mockProvider.complete = async ({ messages }) => {
        const userMsg = messages.find((m) => m.role === 'user');
        if (userMsg && userMsg.content.includes('thank-you letter to Bob')) {
            return {
                ok: true,
                content: 'Dear Bob,\n\nThank you so much for your assistance today! I really appreciate your time and support.\n\nBest regards,\nUser'
            };
        }
        return {
            ok: true,
            content: 'Default synthesized content'
        };
    };

    const planner = new TaskPlanner({ providerAdapter: mockProvider, toolRegistry });

    await t.test('1. Compound generative request composes text via model instead of literal instruction typing', async () => {
        const plan = await planner.plan('Open Notepad and type a thank-you letter to Bob');

        assert.equal(plan.type, 'plan');
        assert.equal(plan.steps.length, 2);
        assert.equal(plan.steps[0].toolId, 'desktop_launch_app');
        assert.equal(plan.steps[0].params.executable, 'notepad.exe');
        assert.equal(plan.steps[1].toolId, 'desktop_type_text');

        const typedText = plan.steps[1].params.text;
        // Verify that typedText is NOT literally "a thank-you letter to Bob"
        assert.notEqual(typedText, 'a thank-you letter to Bob', 'Must not type the prompt instruction literally');
        assert.match(typedText, /Dear Bob/i, 'Must contain composed letter greeting');
        assert.match(typedText, /Thank you/i, 'Must contain composed thank-you content');
    });

    await t.test('2. Literal quoted instruction preserves exact text without invoking generative composition', async () => {
        let providerCalled = false;
        const originalComplete = mockProvider.complete;
        mockProvider.complete = async (args) => {
            providerCalled = true;
            return originalComplete(args);
        };

        const plan = await planner.plan("Open Notepad and type 'Hello World'");

        assert.equal(plan.type, 'plan');
        assert.equal(plan.steps.length, 2);
        assert.equal(plan.steps[1].params.text, 'Hello World');
        assert.equal(providerCalled, false, 'Literal quoted text must not invoke LLM composition');

        mockProvider.complete = originalComplete;
    });

    await t.test('3. Unconfigured provider for generative request returns honest notification', async () => {
        const unconfiguredProvider = new ProviderAdapter({
            credentialStore: credStore,
            provider: PROVIDER_TYPES.GEMINI
        });
        unconfiguredProvider.resolveApiKey = () => null;

        const unconfiguredPlanner = new TaskPlanner({ providerAdapter: unconfiguredProvider, toolRegistry });
        const plan = await unconfiguredPlanner.plan('Open Notepad and type a thank-you letter to Bob');

        assert.equal(plan.type, 'unconfigured_provider');
        assert.match(plan.replyText, /requires an AI provider/i);
        assert.equal(plan.steps.length, 0);
    });
});
