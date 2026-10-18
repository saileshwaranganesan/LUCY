'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { CredentialStore } = require('../../src/security/credential-store.js');
const { ConnectionManager } = require('../../src/providers/connection-manager.js');
const { ModelCatalogue } = require('../../src/providers/model-catalogue.js');
const { ModelRouter, ROUTING_MODES, TASK_CATEGORIES } = require('../../src/providers/model-router.js');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { TASK_STATES, TASK_STATUSES } = require('../../src/core/task-status.js');

function createTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lucy-repair1-${prefix}-`));
}

function cleanTempDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
}

class MockProviderAdapter extends ProviderAdapter {
    constructor(options = {}) {
        super(options);
        this.mockResponses = new Map();
        this.callHistory = [];
    }

    setMockResponse(key, responseOrFn) {
        this.mockResponses.set(key, responseOrFn);
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
            return configured;
        }

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

test('Repair 1 Acceptance Suite: AI Model and Structured Tool-Calling Compatibility', async (t) => {
    const originalFetch = globalThis.fetch;
    const testDir = createTempDir('suite');

    t.after(() => {
        globalThis.fetch = originalFetch;
        cleanTempDir(testDir);
    });

    // -------------------------------------------------------------------------
    // Scenario 1: Ordinary text chat using a compatible text-generation route
    // -------------------------------------------------------------------------
    await t.test('Scenario 1: Ordinary text chat uses text-generation route without requiring tools', async () => {
        let sentTools = 'NOT_SET';
        globalThis.fetch = async (url, options) => {
            const body = JSON.parse(options.body || '{}');
            sentTools = body.tools || null;
            return new Response(JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{ text: 'Photosynthesis is the process by which green plants transform light energy into chemical energy.' }]
                    }
                }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter });
            const coordinator = new TaskCoordinator({
                providerAdapter: adapter,
                planner,
                memoryDir: path.join(testDir, 'mem1')
            });

            const result = await coordinator.executeRequest('What is photosynthesis?');
            assert.equal(result.ok, true);
            assert.equal(result.status, 'completed');
            assert.match(result.replyText, /photosynthesis/i);
            assert.equal(result.executedSteps.length, 0);
            assert.equal(sentTools, null, 'Ordinary informational chat must NOT send tools schema');
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 2: A structured task using a model with confirmed tool-calling support
    // -------------------------------------------------------------------------
    await t.test('Scenario 2: Structured task using model with confirmed tool-calling executes tool', async () => {
        const toolRegistry = new ToolRegistry();
        let toolExecuted = false;
        toolRegistry.registerTool({
            id: 'custom_inspect_tool',
            name: 'Custom Inspect Tool',
            description: 'Custom inspect tool for testing',
            riskTier: RISK_TIERS.READ_ONLY,
            schema: {
                type: 'object',
                properties: { verbose: { type: 'boolean' } }
            },
            handler: async (args) => {
                toolExecuted = true;
                return { ok: true, status: 'operational', verbose: args.verbose };
            }
        });

        globalThis.fetch = async (url, options) => {
            return new Response(JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                name: 'custom_inspect_tool',
                                args: { verbose: true }
                            }
                        }]
                    }
                }],
                usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 10 }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const coordinator = new TaskCoordinator({
                providerAdapter: adapter,
                planner,
                toolRegistry,
                memoryDir: path.join(testDir, 'mem2')
            });

            const result = await coordinator.executeRequest('Please execute custom inspect tool with verbose option');
            assert.equal(result.ok, true);
            assert.equal(toolExecuted, true);
            assert.equal(result.executedSteps.length, 1);
            assert.equal(result.executedSteps[0].toolId, 'custom_inspect_tool');
            assert.equal(result.executedSteps[0].verified, true);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Model supporting text generation but not structured tool calling
    // -------------------------------------------------------------------------
    await t.test('Scenario 3: Text-only model succeeds for chat, fails actionably for tool tasks', async () => {
        const tmpDir = createTempDir('scenario-3');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Register text-only model (tool_calling: false)
            const cat = new ModelCatalogue();
            cat.registerCustomModel({
                id: 'text-gen-only',
                name: 'Text Generation Only',
                provider: PROVIDER_TYPES.OLLAMA,
                capabilities: { text: true, tool_calling: false, vision: false },
                pricing: { type: 'free' },
                isFreeEligible: true
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Text Only',
                defaultModel: 'text-gen-only',
                endpointUrl: 'http://127.0.0.1:11434',
                priority: 10
            });

            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.LOCAL_FIRST, allowHostedFallback: false }
            });

            // 1. Ordinary conversational chat routes successfully to the text-only model
            const chatCandidates = router.resolveCandidateRoutes({ isBasicText: true, requiresToolCalling: false });
            assert.ok(chatCandidates.length > 0);
            assert.equal(chatCandidates[0].model, 'text-gen-only');

            // 2. Structured task requiring tool calling is rejected with actionable error
            const toolCandidates = router.resolveCandidateRoutes({ requiresToolCalling: true, hasTools: true });
            assert.equal(toolCandidates.length, 0);

            const toolRes = await router.complete({
                messages: [{ role: 'user', content: 'Launch notepad' }],
                tools: [{ id: 'desktop_launch_app', description: 'Launch an app' }]
            }, { requiresToolCalling: true });

            assert.equal(toolRes.ok, false);
            assert.equal(toolRes.code, 'no_tool_route');
            assert.match(toolRes.error, /requires structured tool execution/i);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 4: No compatible model available
    // -------------------------------------------------------------------------
    await t.test('Scenario 4: Returns actionable error when no compatible model is configured', async () => {
        const tmpDir = createTempDir('scenario-4');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Configure model that does NOT support tool calling
            const cat = new ModelCatalogue();
            cat.registerCustomModel({
                id: 'llava:7b',
                name: 'LLaVA (Vision only, no tools)',
                provider: PROVIDER_TYPES.OLLAMA,
                capabilities: { text: true, tool_calling: false, vision: true },
                pricing: { type: 'free' },
                isFreeEligible: true
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Ollama Vision',
                defaultModel: 'llava:7b',
                endpointUrl: 'http://127.0.0.1:11434',
                priority: 10
            });

            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.LOCAL_FIRST, allowHostedFallback: false }
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Read file notes.txt' }],
                tools: [{ id: 'file_read', description: 'Read file' }]
            }, { requiresToolCalling: true });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'no_tool_route');
            assert.match(res.error, /no configured model supports function calling/i);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 5: Invalid credentials truthfully reported
    // -------------------------------------------------------------------------
    await t.test('Scenario 5: Invalid credentials reported honestly as authentication failure', async () => {
        const tmpDir = createTempDir('scenario-5');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Cloud',
                defaultModel: 'gemini-2.0-flash',
                apiKey: 'invalid_gemini_key',
                priority: 1
            });

            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            adapter.setMockResponse(PROVIDER_TYPES.GEMINI, () => ({
                ok: false,
                code: 'authentication_failed',
                error: 'Authentication failed: Invalid API key (HTTP 401).'
            }));

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: new ModelCatalogue(),
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.HOSTED_FIRST, allowHostedFallback: false }
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Launch notepad' }],
                tools: [{ id: 'launch', description: 'launch app' }]
            }, { requiresToolCalling: true });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'authentication_failed');
            assert.match(res.error, /authentication failed|invalid/i);
            assert.doesNotMatch(res.error, /no configured model supports function calling/i);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 6: Provider unavailable or network timeout
    // -------------------------------------------------------------------------
    await t.test('Scenario 6: Provider unreachable triggers clean failover to next free route', async () => {
        const tmpDir = createTempDir('scenario-6');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            // Local Ollama (priority 10)
            cm.saveConnection({
                provider: PROVIDER_TYPES.OLLAMA,
                label: 'Local Ollama',
                defaultModel: 'llama3.2:3b',
                endpointUrl: 'http://127.0.0.1:11434',
                priority: 10
            });

            // Hosted Gemini (priority 1)
            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Hosted Gemini',
                defaultModel: 'gemini-2.0-flash',
                apiKey: 'valid-gemini-key',
                priority: 1
            });

            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            // Ollama fails with connection refused
            adapter.setMockResponse(PROVIDER_TYPES.OLLAMA, () => ({
                ok: false,
                code: 'provider_unreachable',
                error: 'Cannot connect to Ollama runtime (ECONNREFUSED)'
            }));
            // Gemini succeeds
            adapter.setMockResponse(PROVIDER_TYPES.GEMINI, {
                ok: true,
                provider: PROVIDER_TYPES.GEMINI,
                model: 'gemini-2.0-flash',
                isLocal: false,
                leavesLocalMachine: true,
                content: 'Failover response from Gemini'
            });

            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: new ModelCatalogue(),
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.LOCAL_FIRST, allowHostedFallback: true }
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Inspect status' }]
            });

            assert.equal(res.ok, true);
            assert.equal(res.provider, PROVIDER_TYPES.GEMINI);
            assert.equal(res.routedVia.failoverOccurred, true);
            assert.equal(res.leavesLocalMachine, true);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 7: Free-only routing with no paid fallback
    // -------------------------------------------------------------------------
    await t.test('Scenario 7: Free-only policy strictly enforced; paid models rejected', async () => {
        const tmpDir = createTempDir('scenario-7');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            const cat = new ModelCatalogue();
            cat.registerCustomModel({
                id: 'paid-gpt-4o',
                name: 'GPT-4o (Paid)',
                provider: PROVIDER_TYPES.OPENROUTER,
                capabilities: { text: true, tool_calling: true, vision: true },
                pricing: { type: 'paid', promptPerMillion: 2.50 },
                isFreeEligible: false
            });

            cm.saveConnection({
                provider: PROVIDER_TYPES.OPENROUTER,
                label: 'Paid OpenRouter',
                defaultModel: 'paid-gpt-4o',
                apiKey: 'paid_key',
                priority: 10
            });

            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: cat,
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.HOSTED_FIRST, allowHostedFallback: false }
            });

            const res = await router.complete({
                messages: [{ role: 'user', content: 'Execute command' }]
            });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'no_free_route');
            assert.match(res.error, /free-only/i);
        } finally {
            cleanTempDir(tmpDir);
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 8: Unsupported tool name
    // -------------------------------------------------------------------------
    await t.test('Scenario 8: Unsupported tool requested by model is rejected fail-closed', async () => {
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool({
            id: 'registered_allowed_tool',
            name: 'Allowed Tool',
            description: 'Allowed tool',
            riskTier: RISK_TIERS.READ_ONLY,
            schema: { type: 'object', properties: {} },
            handler: async () => ({ ok: true })
        });

        globalThis.fetch = async () => new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'unregistered_exploit_tool',
                            args: { param: 'test' }
                        }
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const plan = await planner.plan('Execute exploit');

            assert.equal(plan.type, 'unsupported');
            assert.match(plan.replyText, /unregistered tool/i);
            assert.equal(plan.steps.length, 0);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 9: Invalid or malicious tool arguments
    // -------------------------------------------------------------------------
    await t.test('Scenario 9: Schema violation in tool arguments is rejected fail-closed', async () => {
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool({
            id: 'bounded_file_read',
            name: 'Read File',
            description: 'Read file content',
            riskTier: RISK_TIERS.READ_ONLY,
            schema: {
                type: 'object',
                properties: {
                    lines: { type: 'number' },
                    path: { type: 'string' }
                },
                required: ['lines', 'path']
            },
            handler: async () => ({ ok: true })
        });

        globalThis.fetch = async () => new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'bounded_file_read',
                            args: { path: 'valid.txt', lines: 'MALICIOUS_NON_NUMBER' }
                        }
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const plan = await planner.plan('Read 10 lines from valid.txt');

            assert.equal(plan.type, 'invalid_plan');
            assert.match(plan.replyText, /invalid parameters|must be a number/i);
            assert.equal(plan.steps.length, 0);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 10: Unauthorized or confirmation-required action blocked
    // -------------------------------------------------------------------------
    await t.test('Scenario 10: Consequential action without user confirmation is blocked', async () => {
        const permissionAuth = new PermissionAuthority({
            mode: PERMISSION_MODES.STANDARD,
            workspaceRoot: testDir
        });
        const toolRegistry = new ToolRegistry({ permissionAuthority: permissionAuth });
        let actionExecuted = false;

        toolRegistry.registerTool({
            id: 'destructive_action',
            name: 'Destructive Action',
            description: 'Deletes system items',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            schema: {
                type: 'object',
                properties: { target: { type: 'string' } },
                required: ['target']
            },
            handler: async () => {
                actionExecuted = true;
                return { ok: true, status: 'deleted' };
            }
        });

        globalThis.fetch = async () => new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'destructive_action',
                            args: { target: 'all_data' }
                        }
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const coordinator = new TaskCoordinator({
                providerAdapter: adapter,
                planner,
                toolRegistry,
                permissionAuthority: permissionAuth,
                memoryDir: path.join(testDir, 'mem10')
            });

            // User declines confirmation
            permissionAuth.setConfirmationHandler(async () => false);

            const result = await coordinator.executeRequest('Execute destructive action');
            assert.equal(result.ok, false);
            assert.equal(actionExecuted, false, 'Handler must not execute when confirmation is denied');
            assert.match(result.error, /confirmation|denied|declined/i);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 11: Successful tool execution with actual result returned to model
    // -------------------------------------------------------------------------
    await t.test('Scenario 11: Tool execution result is returned to model for follow-up synthesis', async () => {
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool({
            id: 'get_cpu_temp',
            name: 'Get CPU Temp',
            description: 'Gets current CPU temperature',
            riskTier: RISK_TIERS.READ_ONLY,
            schema: { type: 'object', properties: {} },
            handler: async () => ({ ok: true, tempCelsius: 48.5, fanRpm: 1200 })
        });

        let callCount = 0;
        let followUpReceiptReceived = false;

        globalThis.fetch = async (url, options) => {
            callCount++;
            const body = JSON.parse(options.body || '{}');

            if (callCount === 1) {
                // First call: model returns tool call
                return new Response(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{
                                functionCall: {
                                    name: 'get_cpu_temp',
                                    args: {}
                                }
                            }]
                        }
                    }]
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            } else {
                // Follow-up synthesis call: model receives actual tool execution output
                const userMsg = body.contents?.find((c) => c.role === 'user')?.parts?.[0]?.text || '';
                if (userMsg.includes('48.5') || userMsg.includes('fanRpm')) {
                    followUpReceiptReceived = true;
                }
                return new Response(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{ text: 'Your CPU is running comfortably cool at 48.5°C with fan speed at 1200 RPM.' }]
                        }
                    }]
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const coordinator = new TaskCoordinator({
                providerAdapter: adapter,
                planner,
                toolRegistry,
                memoryDir: path.join(testDir, 'mem11')
            });

            const result = await coordinator.executeRequest('Check CPU temperature', { synthesizeResponse: true });
            assert.equal(result.ok, true);
            assert.equal(callCount, 2, 'Must perform follow-up call to synthesize response');
            assert.equal(followUpReceiptReceived, true, 'Execution receipts must be sent to model in follow-up call');
            assert.match(result.replyText, /48\.5°C/i);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 12: Failed tool execution without false success response
    // -------------------------------------------------------------------------
    await t.test('Scenario 12: Failed tool execution halts task and never reports false success', async () => {
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool({
            id: 'failing_storage_tool',
            name: 'Storage Tool',
            description: 'Writes to storage',
            riskTier: RISK_TIERS.WORKSPACE_WRITE,
            schema: { type: 'object', properties: {} },
            handler: async () => ({ ok: false, error: 'Storage device is write-protected' })
        });

        globalThis.fetch = async () => new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'failing_storage_tool',
                            args: {}
                        }
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const coordinator = new TaskCoordinator({
                providerAdapter: adapter,
                planner,
                toolRegistry,
                memoryDir: path.join(testDir, 'mem12')
            });

            const result = await coordinator.executeRequest('Write to storage device');
            assert.equal(result.ok, false);
            assert.equal(result.status, 'failed');
            assert.match(result.error, /write-protected/i);
            assert.equal(result.verification.verified, false);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 13: Multi-step execution
    // -------------------------------------------------------------------------
    await t.test('Scenario 13: Multi-step execution chains verified steps sequentially', async () => {
        const toolRegistry = new ToolRegistry();
        const executionOrder = [];

        toolRegistry.registerTool({
            id: 'step_create',
            name: 'Step Create',
            description: 'Create resource',
            riskTier: RISK_TIERS.WORKSPACE_WRITE,
            schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            handler: async (args) => {
                executionOrder.push(`create_${args.name}`);
                return { ok: true, createdId: 'res_999' };
            }
        });

        toolRegistry.registerTool({
            id: 'step_verify',
            name: 'Step Verify',
            description: 'Verify resource',
            riskTier: RISK_TIERS.READ_ONLY,
            schema: { type: 'object', properties: { resId: { type: 'string' } }, required: ['resId'] },
            handler: async (args) => {
                executionOrder.push(`verify_${args.resId}`);
                return { ok: true, valid: true };
            }
        });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const coordinator = new TaskCoordinator({
                providerAdapter: adapter,
                planner,
                toolRegistry,
                memoryDir: path.join(testDir, 'mem13')
            });

            const plan = {
                objective: 'Create and verify resource',
                type: 'plan',
                steps: [
                    { index: 1, title: 'Create resource', toolId: 'step_create', params: { name: 'alpha' }, expectedOutcome: 'Created' },
                    { index: 2, title: 'Verify resource', toolId: 'step_verify', params: { resId: 'res_999' }, expectedOutcome: 'Verified', dependsOn: ['step_1'] }
                ]
            };

            const result = await coordinator.executeRequest('Create and verify resource', { planOverride: plan });
            assert.equal(result.ok, true);
            assert.equal(result.executedSteps.length, 2);
            assert.deepEqual(executionOrder, ['create_alpha', 'verify_res_999']);
            assert.equal(result.executedSteps[0].verified, true);
            assert.equal(result.executedSteps[1].verified, true);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 14: Cancellation and recovery without duplicate side effects
    // -------------------------------------------------------------------------
    await t.test('Scenario 14: Cancellation halts execution cleanly without executing subsequent steps', async () => {
        const toolRegistry = new ToolRegistry();
        let step1Executed = false;
        let step2Executed = false;

        const abortController = new AbortController();

        toolRegistry.registerTool({
            id: 'cancel_step_1',
            name: 'Step 1',
            description: 'First step',
            riskTier: RISK_TIERS.READ_ONLY,
            schema: { type: 'object', properties: {} },
            handler: async () => {
                step1Executed = true;
                // Trigger cancellation during step 1
                abortController.abort();
                return { ok: true, status: 'step1_done' };
            }
        });

        toolRegistry.registerTool({
            id: 'cancel_step_2',
            name: 'Step 2',
            description: 'Second step',
            riskTier: RISK_TIERS.WORKSPACE_WRITE,
            schema: { type: 'object', properties: {} },
            handler: async () => {
                step2Executed = true;
                return { ok: true, status: 'step2_done' };
            }
        });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const coordinator = new TaskCoordinator({
                providerAdapter: adapter,
                planner,
                toolRegistry,
                memoryDir: path.join(testDir, 'mem14')
            });

            const plan = {
                objective: 'Multi-step cancellable task',
                type: 'plan',
                steps: [
                    { id: 'step_1', index: 1, title: 'Step 1', toolId: 'cancel_step_1', params: {}, expectedOutcome: 'Done', isConsequential: true },
                    { id: 'step_2', index: 2, title: 'Step 2', toolId: 'cancel_step_2', params: {}, expectedOutcome: 'Done', dependsOn: ['step_1'], isConsequential: true }
                ]
            };

            const result = await coordinator.executeRequest('Multi-step cancellable task', { planOverride: plan, signal: abortController.signal });
            assert.equal(result.ok, false);
            assert.equal(result.cancelled, true);
            assert.equal(result.status, 'cancelled');
            assert.equal(step1Executed, true);
            assert.equal(step2Executed, false, 'Step 2 must NOT be executed after cancellation');
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 15: Correct routing diagnostics for both success and failure
    // -------------------------------------------------------------------------
    await t.test('Scenario 15: Correct routing diagnostics captured for success and failure', async () => {
        const tmpDir = createTempDir('scenario-15');
        try {
            const credStore = new CredentialStore({ storageDir: tmpDir });
            const cm = new ConnectionManager({ configDir: tmpDir, credentialStore: credStore });
            cm.init();

            cm.saveConnection({
                provider: PROVIDER_TYPES.GEMINI,
                label: 'Gemini Diag',
                defaultModel: 'gemini-2.0-flash',
                apiKey: 'diag-key',
                priority: 1
            });

            const adapter = new MockProviderAdapter({ credentialStore: credStore });
            const router = new ModelRouter({
                providerAdapter: adapter,
                connectionManager: cm,
                modelCatalogue: new ModelCatalogue(),
                configDir: tmpDir,
                defaultConfig: { mode: ROUTING_MODES.HOSTED_FIRST, allowHostedFallback: false }
            });

            // 1. Success dispatch: verify routing diagnostics metadata
            adapter.setMockResponse(PROVIDER_TYPES.GEMINI, {
                ok: true,
                provider: PROVIDER_TYPES.GEMINI,
                model: 'gemini-2.0-flash',
                isLocal: false,
                leavesLocalMachine: true,
                content: 'Diag success reply'
            });

            const successRes = await router.complete({ messages: [{ role: 'user', content: 'Diagnostic check' }] });
            assert.equal(successRes.ok, true);
            assert.ok(successRes.routedVia, 'Successful dispatch must include routedVia diagnostics');
            assert.equal(successRes.routedVia.provider, PROVIDER_TYPES.GEMINI);
            assert.equal(successRes.routedVia.model, 'gemini-2.0-flash');
            assert.equal(successRes.routedVia.failoverOccurred, false);
            assert.equal(successRes.isLocal, false);
            assert.equal(successRes.leavesLocalMachine, true);

            // 2. Failure dispatch: verify error classification diagnostics
            adapter.setMockResponse(PROVIDER_TYPES.GEMINI, () => ({
                ok: false,
                code: 'http_500',
                error: 'Internal Server Error'
            }));

            const failRes = await router.complete({ messages: [{ role: 'user', content: 'Diagnostic fail check' }] });
            assert.equal(failRes.ok, false);

            const diags = router.getDiagnostics();
            assert.ok(diags.length >= 1, 'Diagnostic history must record failed attempts');
            assert.ok(diags.some((d) => d.provider === PROVIDER_TYPES.GEMINI || d.outcome === 'failed'));
        } finally {
            cleanTempDir(tmpDir);
        }
    });
});
