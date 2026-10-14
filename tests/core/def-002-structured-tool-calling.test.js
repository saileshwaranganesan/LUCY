'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { validateToolArguments } = require('../../src/tools/schema-validator.js');

test('DEF-002: Reliable Structured Tool Calling and Schema Validation', async (t) => {
    const originalFetch = globalThis.fetch;
    const testDir = path.join(os.tmpdir(), `lucy-def002-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        globalThis.fetch = originalFetch;
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    // 1. Schema Validator Unit Tests
    await t.test('Schema Validator: checks types, required fields, and enums', () => {
        const schema = {
            type: 'object',
            properties: {
                targetPath: { type: 'string' },
                count: { type: 'number' },
                mode: { type: 'string', enum: ['read', 'write', 'append'] },
                optionalFlag: { type: 'boolean' }
            },
            required: ['targetPath', 'count']
        };

        // Valid arguments
        const validRes = validateToolArguments(schema, { targetPath: 'C:\\test.txt', count: 5, mode: 'read' });
        assert.equal(validRes.valid, true);

        // Missing required field
        const missingRes = validateToolArguments(schema, { count: 5 });
        assert.equal(missingRes.valid, false);
        assert.equal(missingRes.missingParameter, 'targetPath');

        // Type mismatch
        const typeRes = validateToolArguments(schema, { targetPath: 'C:\\test.txt', count: 'five' });
        assert.equal(typeRes.valid, false);
        assert.match(typeRes.error, /count.*must be a number/i);

        // Enum violation
        const enumRes = validateToolArguments(schema, { targetPath: 'C:\\test.txt', count: 5, mode: 'delete' });
        assert.equal(enumRes.valid, false);
        assert.match(enumRes.error, /mode.*must be one of/i);

        // Non-object parameters
        const nonObjRes = validateToolArguments(schema, 'not-an-object');
        assert.equal(nonObjRes.valid, false);
    });

    // 2. Native Structured Tool Calling for Google Gemini
    await t.test('Gemini: serializes tool declarations and parses native functionCall response', async () => {
        let sentBody = null;
        globalThis.fetch = async (url, options) => {
            sentBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                name: 'file_read',
                                args: { path: 'notes.txt' }
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
        process.env.LUCY_GEMINI_API_KEY = 'test_gemini_key';

        try {
            const tools = [{
                id: 'file_read',
                description: 'Read file contents',
                schema: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path']
                }
            }];

            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'Read notes.txt' }],
                tools
            });

            assert.equal(result.ok, true);
            assert.equal(result.hasToolCalls, true);
            assert.equal(result.toolCalls.length, 1);
            assert.equal(result.toolCalls[0].name, 'file_read');
            assert.deepEqual(result.toolCalls[0].arguments, { path: 'notes.txt' });

            // Verify body sent to Gemini API
            assert.ok(sentBody.tools);
            assert.equal(sentBody.tools[0].functionDeclarations[0].name, 'file_read');
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // 3. Native Structured Tool Calling for OpenAI / OpenRouter
    await t.test('OpenRouter: serializes tools in OpenAI format and parses tool_calls', async () => {
        let sentBody = null;
        globalThis.fetch = async (url, options) => {
            sentBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant',
                        tool_calls: [{
                            id: 'call_123',
                            type: 'function',
                            function: {
                                name: 'system_info',
                                arguments: '{"detailed":true}'
                            }
                        }]
                    }
                }],
                usage: { prompt_tokens: 20, completion_tokens: 12 }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.OPENROUTER,
            model: 'openai/gpt-4o'
        });
        process.env.LUCY_OPENROUTER_API_KEY = 'test_openrouter_key';

        try {
            const tools = [{
                id: 'system_info',
                description: 'Get system information',
                schema: {
                    type: 'object',
                    properties: { detailed: { type: 'boolean' } }
                }
            }];

            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'Inspect system' }],
                tools
            });

            assert.equal(result.ok, true);
            assert.equal(result.hasToolCalls, true);
            assert.equal(result.toolCalls[0].name, 'system_info');
            assert.deepEqual(result.toolCalls[0].arguments, { detailed: true });

            // Verify OpenAI tools schema
            assert.equal(sentBody.tools[0].type, 'function');
            assert.equal(sentBody.tools[0].function.name, 'system_info');
        } finally {
            delete process.env.LUCY_OPENROUTER_API_KEY;
        }
    });

    // 4. Native Structured Tool Calling for Ollama
    await t.test('Ollama: passes tools to /api/chat and parses message.tool_calls', async () => {
        let sentBody = null;
        globalThis.fetch = async (url, options) => {
            assert.match(url, /\/api\/chat$/);
            sentBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                message: {
                    role: 'assistant',
                    tool_calls: [{
                        function: {
                            name: 'desktop_launch_app',
                            arguments: { executable: 'calc.exe' }
                        }
                    }]
                },
                prompt_eval_count: 25,
                eval_count: 15
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.OLLAMA,
            model: 'llama3.1'
        });

        const tools = [{
            id: 'desktop_launch_app',
            description: 'Launch application',
            schema: {
                type: 'object',
                properties: { executable: { type: 'string' } },
                required: ['executable']
            }
        }];

        const result = await adapter.complete({
            messages: [{ role: 'user', content: 'Open calculator' }],
            tools
        });

        assert.equal(result.ok, true);
        assert.equal(result.hasToolCalls, true);
        assert.equal(result.toolCalls[0].name, 'desktop_launch_app');
        assert.deepEqual(result.toolCalls[0].arguments, { executable: 'calc.exe' });
        assert.ok(sentBody.tools);
        assert.equal(sentBody.tools[0].function.name, 'desktop_launch_app');
    });

    // 5. Native Structured Tool Calling for Hugging Face
    await t.test('Hugging Face: passes tools and parses tool_calls', async () => {
        let sentBody = null;
        globalThis.fetch = async (url, options) => {
            sentBody = JSON.parse(options.body);
            return new Response(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant',
                        tool_calls: [{
                            function: {
                                name: 'file_read',
                                arguments: '{"path":"report.md"}'
                            }
                        }]
                    }
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.HUGGINGFACE,
            model: 'meta-llama/Llama-3.3-70B-Instruct'
        });
        process.env.LUCY_HUGGINGFACE_API_KEY = 'test_hf_token';

        try {
            const tools = [{
                id: 'file_read',
                description: 'Read file',
                schema: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path']
                }
            }];

            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'Read report' }],
                tools
            });

            assert.equal(result.ok, true);
            assert.equal(result.hasToolCalls, true);
            assert.equal(result.toolCalls[0].name, 'file_read');
            assert.deepEqual(result.toolCalls[0].arguments, { path: 'report.md' });
        } finally {
            delete process.env.LUCY_HUGGINGFACE_API_KEY;
        }
    });

    // 6. TaskPlanner integrates Native Tool Calls and validates against registered schemas
    await t.test('TaskPlanner: validates native tool call arguments against schema, rejecting invalid params fail-closed', async () => {
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool({
            id: 'file_write',
            name: 'Write File',
            description: 'Write file content',
            riskTier: RISK_TIERS.WORKSPACE_WRITE,
            schema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' }
                },
                required: ['path', 'content']
            },
            handler: async () => ({ ok: true, status: 'written' })
        });

        // Case A: Model returns valid tool call
        globalThis.fetch = async () => new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'file_write',
                            args: { path: 'test.txt', content: 'hello world' }
                        }
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_gemini_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const planValid = await planner.plan('Write hello world to test.txt');

            assert.equal(planValid.type, 'plan');
            assert.equal(planValid.steps.length, 1);
            assert.equal(planValid.steps[0].toolId, 'file_write');
            assert.equal(planValid.steps[0].params.path, 'test.txt');

            // Case B: Model returns missing required parameter
            globalThis.fetch = async () => new Response(JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                name: 'file_write',
                                args: { path: 'test.txt' } // Missing 'content'
                            }
                        }]
                    }
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });

            const planInvalid = await planner.plan('Write to test.txt');
            assert.equal(planInvalid.type, 'invalid_plan');
            assert.match(planInvalid.error, /Missing required parameter: 'content'/i);
            assert.equal(planInvalid.steps.length, 0);

            // Case C: Model proposes unknown/unregistered tool
            globalThis.fetch = async () => new Response(JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                name: 'arbitrary_dangerous_tool',
                                args: { cmd: 'rm -rf' }
                            }
                        }]
                    }
                }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });

            const planUnknown = await planner.plan('Run dangerous tool');
            assert.equal(planUnknown.type, 'unsupported');
            assert.match(planUnknown.error, /Unknown tool: arbitrary_dangerous_tool/i);
            assert.equal(planUnknown.steps.length, 0);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // 7. Fallback behavior when model returns structured JSON text instead of native function calls
    await t.test('TaskPlanner: validates structured JSON fallback and safely executes only validated tools', async () => {
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool({
            id: 'desktop_launch_app',
            name: 'Launch Desktop App',
            description: 'Launch application',
            riskTier: RISK_TIERS.WORKSPACE_WRITE,
            schema: {
                type: 'object',
                properties: { executable: { type: 'string' } },
                required: ['executable']
            },
            handler: async () => ({ ok: true, status: 'launched' })
        });

        // Mock text response containing JSON markdown
        globalThis.fetch = async () => new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        text: '```json\n{\n  "objective": "Launch Notepad",\n  "type": "plan",\n  "steps": [\n    {\n      "title": "Open Notepad",\n      "toolId": "desktop_launch_app",\n      "params": { "executable": "notepad.exe" }\n    }\n  ]\n}\n```'
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_gemini_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const plan = await planner.plan('Can you please start notepad for me?');

            assert.equal(plan.type, 'plan');
            assert.equal(plan.steps.length, 1);
            assert.equal(plan.steps[0].toolId, 'desktop_launch_app');
            assert.equal(plan.steps[0].params.executable, 'notepad.exe');
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    // 8. Permission Authority Enforcement on Model-Generated Plans
    await t.test('Permission Enforcement: model output cannot bypass permission authority', async () => {
        const permissionAuth = new PermissionAuthority({
            mode: PERMISSION_MODES.STANDARD,
            workspaceRoot: testDir
        });
        const toolRegistry = new ToolRegistry({ permissionAuthority: permissionAuth });

        let executionAttempted = false;
        toolRegistry.registerTool({
            id: 'consequential_system_tool',
            name: 'Consequential System Tool',
            description: 'Performs consequential changes',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            schema: {
                type: 'object',
                properties: { target: { type: 'string' } },
                required: ['target']
            },
            handler: async () => {
                executionAttempted = true;
                return { ok: true, status: 'executed' };
            }
        });

        // Mock model that plans this consequential tool
        globalThis.fetch = async () => new Response(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'consequential_system_tool',
                            args: { target: 'system_registry' }
                        }
                    }]
                }
            }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_gemini_key';

        try {
            const planner = new TaskPlanner({ providerAdapter: adapter, toolRegistry });
            const coordinator = new TaskCoordinator({
                permissionAuthority: permissionAuth,
                toolRegistry,
                providerAdapter: adapter,
                planner,
                memoryDir: path.join(testDir, 'isolated-mem')
            });

            // Execute with denied confirmation: must halt fail-closed
            permissionAuth.setConfirmationHandler(async () => false);
            const result = await coordinator.executeRequest('Modify system registry');
            assert.equal(result.ok, false);
            assert.equal(result.status, 'failed');
            assert.match(result.error, /confirmation|denied|declined/i);
            assert.equal(executionAttempted, false, 'Handler must not be executed when permission confirmation is required');
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });
});
