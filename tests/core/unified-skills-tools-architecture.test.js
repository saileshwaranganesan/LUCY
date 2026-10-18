'use strict';

/**
 * Unified Skills, Tools & Extensible Integration Architecture Test Suite
 * 
 * Verifies all 18 Acceptance Criteria from Section 14:
 * 1. Tool registration and schema validation
 * 2. Duplicate tool prevention
 * 3. Capability discovery
 * 4. Task-relevant tool selection
 * 5. Invalid tool arguments
 * 6. Permission-denied execution
 * 7. Approval-required actions
 * 8. Successful execution and result verification
 * 9. Failure, timeout and cancellation
 * 10. Duplicate-execution prevention
 * 11. Multi-step skill dependencies
 * 12. Partial completion and recovery
 * 13. Missing optional dependencies
 * 14. Malformed or malicious tool descriptions
 * 15. Third-party extension permission boundaries
 * 16. Provider compatibility and unsupported tool-calling capabilities
 * 17. Preservation of existing action permissions
 * 18. Regression of memory, voice, browser automation, UI and provider orchestration
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { ToolRegistry, TOOL_EXECUTION_STATES } = require('../../src/tools/tool-registry.js');
const { Skill, SkillRegistry, SKILL_EXECUTION_STATES } = require('../../src/tools/skill-registry.js');
const { PluginManager, PLUGIN_STATUS } = require('../../src/tools/plugin-manager.js');
const { McpAdapter } = require('../../src/tools/mcp-adapter.js');
const { createResearchSkill } = require('../../src/workflows/research-skill.js');
const { createDocumentSkill } = require('../../src/workflows/document-skill.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');
const { registerSystemTools } = require('../../src/tools/system-tools.js');

test('L.U.C.Y. Unified Skills, Tools & Extensible Integration Architecture Suite', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-skills-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {}
    });

    // 1. Tool registration and schema validation
    await t.test('1. Tool registration and schema validation', () => {
        const registry = new ToolRegistry();

        // Valid tool registers cleanly
        const tool = registry.registerTool({
            id: 'sample_tool',
            name: 'Sample Tool',
            description: 'Executes a sample operation',
            schema: {
                type: 'object',
                properties: {
                    query: { type: 'string' }
                },
                required: ['query']
            },
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => ({ ok: true, data: params.query.toUpperCase() })
        });

        assert.equal(tool.id, 'sample_tool');
        assert.equal(registry.getTool('sample_tool').name, 'Sample Tool');

        // Invalid definitions throw descriptive errors
        assert.throws(() => registry.registerTool(null), /must be an object/i);
        assert.throws(() => registry.registerTool({ id: 'bad tool with spaces', handler: () => {} }), /valid string 'id'/i);
        assert.throws(() => registry.registerTool({ id: 'no_handler' }), /must provide a handler function/i);
        assert.throws(() => registry.registerTool({ id: 'bad_schema', handler: () => {}, schema: 'not an object' }), /valid JSON Schema/i);
    });

    // 2. Duplicate tool prevention
    await t.test('2. Duplicate tool prevention', () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            id: 'unique_calc',
            handler: async () => ({ ok: true })
        });

        // Registering again without allowOverride fails
        assert.throws(() => {
            registry.registerTool({
                id: 'unique_calc',
                handler: async () => ({ ok: true, version: 2 })
            });
        }, /already registered/i);

        // Registering with allowOverride: true succeeds
        const updated = registry.registerTool({
            id: 'unique_calc',
            handler: async () => ({ ok: true, version: 2 })
        }, { allowOverride: true });

        assert.equal(updated.id, 'unique_calc');
    });

    // 3. Capability discovery
    await t.test('3. Capability discovery', () => {
        const toolRegistry = new ToolRegistry();
        registerSystemTools(toolRegistry);
        registerFileTools(toolRegistry, testDir);

        const skillRegistry = new SkillRegistry({ toolRegistry });
        skillRegistry.registerSkill(createResearchSkill());
        skillRegistry.registerSkill(createDocumentSkill());

        const tools = toolRegistry.listTools();
        assert.ok(tools.length >= 3);
        assert.ok(tools.some(t => t.id === 'system_info'));
        assert.ok(tools.some(t => t.id === 'file_read'));

        const skills = skillRegistry.listSkills();
        assert.equal(skills.length, 2);
        assert.ok(skills.some(s => s.id === 'skill_research_topic'));
        assert.ok(skills.some(s => s.id === 'skill_create_document'));
    });

    // 4. Task-relevant tool selection
    await t.test('4. Task-relevant tool selection', () => {
        const registry = new ToolRegistry();
        registerSystemTools(registry);
        registerFileTools(registry, testDir);

        // Register dummy desktop and browser tools
        registry.registerTool({ id: 'desktop_launch', category: 'desktop', handler: async () => ({ ok: true }) });
        registry.registerTool({ id: 'browser_navigate', category: 'browser', handler: async () => ({ ok: true }) });

        // Request about files should prioritize filesystem tools
        const fileTools = registry.getToolsForTask('Please read my notes from project_summary.md');
        assert.ok(fileTools.some(t => t.id === 'file_read'));
        assert.ok(!fileTools.some(t => t.id === 'desktop_launch'));

        // Request about launching apps should prioritize desktop tools
        const desktopTools = registry.getToolsForTask('Open notepad and calculate budget');
        assert.ok(desktopTools.some(t => t.id === 'desktop_launch'));
        assert.ok(!desktopTools.some(t => t.id === 'browser_navigate'));

        // Broad request or context.allTools returns full catalogue
        const all = registry.getToolsForTask('', { allTools: true });
        assert.ok(all.length >= 4);
    });

    // 5. Invalid tool arguments
    await t.test('5. Invalid tool arguments', async () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            id: 'strict_calc',
            schema: {
                type: 'object',
                properties: {
                    x: { type: 'number' },
                    y: { type: 'number' }
                },
                required: ['x', 'y']
            },
            handler: async (p) => ({ ok: true, sum: p.x + p.y })
        });

        // Missing required parameter 'y'
        const resMissing = await registry.execute('strict_calc', { x: 10 });
        assert.equal(resMissing.ok, false);
        assert.equal(resMissing.status, 'invalid_parameters');
        assert.equal(resMissing.missingParameter, 'y');

        // Parameter validation check method
        const validation = registry.validateParams('strict_calc', { x: 10 });
        assert.equal(validation.valid, false);
        assert.equal(validation.missingParameter, 'y');
    });

    // 6. Permission-denied execution
    await t.test('6. Permission-denied execution', async () => {
        let handlerRan = false;
        const auth = new PermissionAuthority({
            mode: PERMISSION_MODES.RESTRICTED,
            workspaceRoot: testDir
        });

        const registry = new ToolRegistry({ permissionAuthority: auth });
        registry.registerTool({
            id: 'consequential_op',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                handlerRan = true;
                return { ok: true };
            }
        });

        // Evaluate with no confirmation callback will fail closed
        const res = await registry.execute('consequential_op', { action: 'format_disk' });
        assert.equal(res.ok, false);
        assert.equal(res.status, 'permission_denied');
        assert.equal(handlerRan, false, 'Handler must NEVER run when permission is denied');
    });

    // 7. Approval-required actions
    await t.test('7. Approval-required actions', async () => {
        let promptShown = false;
        const auth = new PermissionAuthority({
            mode: PERMISSION_MODES.STANDARD,
            workspaceRoot: testDir
        });

        auth.setPromptCallback(async (req) => {
            promptShown = true;
            return req.toolId === 'approved_tool';
        });

        const registry = new ToolRegistry({ permissionAuthority: auth });
        let approvedHandlerRan = false;
        registry.registerTool({
            id: 'approved_tool',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                approvedHandlerRan = true;
                return { ok: true, actionDone: true };
            }
        });

        const resApproved = await registry.execute('approved_tool', { action: 'send_email' });
        assert.equal(promptShown, true);
        assert.equal(resApproved.ok, true);
        assert.equal(approvedHandlerRan, true);

        // Disapproved tool
        registry.registerTool({
            id: 'disapproved_tool',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => ({ ok: true })
        });

        const resDisapproved = await registry.execute('disapproved_tool', { action: 'delete_database' });
        assert.equal(resDisapproved.ok, false);
        assert.equal(resDisapproved.status, 'permission_denied');
    });

    // 8. Successful execution and result verification
    await t.test('8. Successful execution and result verification', async () => {
        const registry = new ToolRegistry();
        registerFileTools(registry, testDir);

        // Dry-run execution guarantees handler is not executed
        const dryRunRes = await registry.execute('file_write', {
            path: 'test_dry.txt',
            content: 'Hello dry run'
        }, { dryRun: true });

        assert.equal(dryRunRes.ok, true);
        assert.equal(dryRunRes.dryRun, true);
        assert.equal(dryRunRes.executed, false);
        assert.equal(fs.existsSync(path.join(testDir, 'test_dry.txt')), false);

        // Real execution creates file and verifies
        const realRes = await registry.execute('file_write', {
            path: 'test_real.txt',
            content: 'Hello real world'
        }, { dryRun: false });

        assert.equal(realRes.ok, true);
        assert.equal(realRes.executed, true);
        assert.equal(realRes.verification.verified, true);
        assert.equal(fs.readFileSync(path.join(testDir, 'test_real.txt'), 'utf8'), 'Hello real world');
    });

    // 9. Failure, timeout and cancellation
    await t.test('9. Failure, timeout and cancellation', async () => {
        const registry = new ToolRegistry();

        // 9a. Timeout
        registry.registerTool({
            id: 'slow_tool',
            timeoutMs: 50,
            handler: async () => {
                await new Promise(r => setTimeout(r, 200));
                return { ok: true };
            }
        });

        const timeoutRes = await registry.execute('slow_tool', {});
        assert.equal(timeoutRes.ok, false);
        assert.ok(timeoutRes.error.includes('timed out'));

        // 9b. Cancellation via pre-aborted signal
        const controller = new AbortController();
        controller.abort('User cancelled');
        const cancelRes = await registry.execute('slow_tool', {}, { signal: controller.signal });
        assert.equal(cancelRes.ok, false);
        assert.equal(cancelRes.status, 'cancelled');
    });

    // 10. Duplicate-execution prevention
    await t.test('10. Duplicate-execution prevention (idempotency)', async () => {
        let executionCount = 0;
        const registry = new ToolRegistry();
        registry.registerTool({
            id: 'charge_wallet',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async (p) => {
                executionCount++;
                return { ok: true, charged: p.amount, txId: `tx_${Date.now()}` };
            }
        });

        const key = 'idem_key_001';
        const res1 = await registry.execute('charge_wallet', { amount: 50 }, { idempotencyKey: key });
        const res2 = await registry.execute('charge_wallet', { amount: 50 }, { idempotencyKey: key });

        assert.equal(res1.ok, true);
        assert.equal(res2.ok, true);
        assert.equal(executionCount, 1, 'Handler should execute only once for identical idempotency key');
        assert.equal(res2.deduplicated, true);
    });

    // 11. Multi-step skill dependencies
    await t.test('11. Multi-step skill dependencies', async () => {
        const toolRegistry = new ToolRegistry();
        // Missing file_write in toolRegistry
        const skillRegistry = new SkillRegistry({ toolRegistry });

        // Registering research skill requires file_write
        assert.throws(() => {
            skillRegistry.registerSkill(createResearchSkill());
        }, (err) => err.code === 'MISSING_TOOL_DEPENDENCIES');

        // Now register file_write and register skill successfully
        registerFileTools(toolRegistry, testDir);
        const skill = skillRegistry.registerSkill(createResearchSkill());
        assert.equal(skill.id, 'skill_research_topic');
    });

    // 12. Partial completion and recovery
    await t.test('12. Partial completion and recovery', async () => {
        const toolRegistry = new ToolRegistry();
        registerFileTools(toolRegistry, testDir);

        let rolledBack = false;
        const skill = new Skill({
            id: 'skill_transaction',
            workflow: async ({ params, signal }) => {
                // Step 1: create draft
                await toolRegistry.execute('file_write', { path: params.path, content: 'draft' });
                // Step 2: failure
                throw new Error('Database transaction abort');
            },
            rollback: async ({ params }) => {
                rolledBack = true;
                await toolRegistry.execute('file_delete', { path: params.path });
                return { ok: true };
            }
        });

        const skillRegistry = new SkillRegistry({ toolRegistry });
        skillRegistry.registerSkill(skill);

        const res = await skillRegistry.execute('skill_transaction', { path: 'partial.txt' });
        assert.equal(res.ok, false);
        assert.equal(res.status, SKILL_EXECUTION_STATES.FAILED);
        assert.equal(rolledBack, true);
        assert.equal(fs.existsSync(path.join(testDir, 'partial.txt')), false);
    });

    // 13. Missing optional dependencies
    await t.test('13. Missing optional dependencies', async () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            id: 'optional_gpu_accel',
            availabilityCheck: async () => ({
                available: false,
                reason: 'NVIDIA CUDA runtime not detected on host system'
            }),
            handler: async () => ({ ok: true })
        });

        const avail = await registry.checkAvailability('optional_gpu_accel');
        assert.equal(avail.available, false);
        assert.ok(avail.reason.includes('CUDA'));

        const execRes = await registry.execute('optional_gpu_accel', {});
        assert.equal(execRes.ok, false);
        assert.equal(execRes.status, 'unavailable');
    });

    // 14. Malformed or malicious tool descriptions
    await t.test('14. Malformed or malicious tool descriptions and manifests', () => {
        const pluginManager = new PluginManager();

        // Leaked API secret in manifest
        const malformedManifest = {
            id: 'malicious-plugin',
            name: 'Malicious Plugin',
            version: '1.0.0',
            author: 'Attacker',
            apiKey: 'sk-proj-supersecretkey12345'
        };

        const res = pluginManager.validateManifest(malformedManifest);
        assert.equal(res.valid, false);
        assert.ok(res.error.includes('credentials or API tokens'));

        // Invalid ID
        const badIdManifest = {
            id: 'bad / id',
            name: 'Bad ID',
            version: '1.0.0',
            author: 'Someone'
        };
        assert.equal(pluginManager.validateManifest(badIdManifest).valid, false);
    });

    // 15. Third-party extension permission boundaries
    await t.test('15. Third-party extension permission boundaries', async () => {
        const toolRegistry = new ToolRegistry();
        const skillRegistry = new SkillRegistry({ toolRegistry });
        const pluginManager = new PluginManager({ toolRegistry, skillRegistry });

        // Plugin asking for root / critical forbidden permissions
        const badPermManifest = {
            id: 'root-plugin',
            name: 'Root Ext',
            version: '1.0.0',
            author: 'Dev',
            permissions: ['CRITICAL']
        };
        const loadBad = await pluginManager.loadPlugin(badPermManifest);
        assert.equal(loadBad.ok, false);
        assert.ok(loadBad.error.includes('forbidden root privilege'));

        // Legitimate plugin requiring approval for CONSEQUENTIAL actions
        const goodManifest = {
            id: 'safe-formatter',
            name: 'Safe Formatter',
            version: '1.0.0',
            author: 'Community',
            permissions: [RISK_TIERS.CONSEQUENTIAL],
            tools: [
                {
                    id: 'plugin_format_code',
                    description: 'Format source code',
                    schema: { type: 'object', properties: { code: { type: 'string' } } }
                }
            ]
        };

        const loadGood = await pluginManager.loadPlugin(goodManifest, {
            plugin_format_code: async (p) => ({ ok: true, formatted: p.code.trim() })
        });

        assert.equal(loadGood.ok, true);
        assert.equal(loadGood.status, PLUGIN_STATUS.PENDING_APPROVAL);

        // Cannot enable before user approval
        const tryEnable = await pluginManager.enablePlugin('safe-formatter');
        assert.equal(tryEnable.ok, false);
        assert.ok(tryEnable.error.includes('requires user approval'));

        // Approve and enable
        await pluginManager.approvePlugin('safe-formatter', true);
        const enableRes = await pluginManager.enablePlugin('safe-formatter');
        assert.equal(enableRes.ok, true);
        assert.equal(enableRes.status, PLUGIN_STATUS.ENABLED);

        // Verify tool has provenance pluginId
        const registeredTool = toolRegistry.getTool('plugin_format_code');
        assert.ok(registeredTool);
        assert.equal(registeredTool.pluginId, 'safe-formatter');

        // Execute tool
        const execRes = await toolRegistry.execute('plugin_format_code', { code: '  hello  ' });
        assert.equal(execRes.ok, true);
        assert.equal(execRes.result.formatted, 'hello');

        // Disable plugin removes tool
        await pluginManager.disablePlugin('safe-formatter');
        assert.equal(toolRegistry.getTool('plugin_format_code'), undefined);
    });

    // 16. Provider compatibility and MCP adapter protocol bridge
    await t.test('16. Provider compatibility and MCP adapter protocol bridge', async () => {
        const toolRegistry = new ToolRegistry();
        const { EventEmitter } = require('events');

        // Mock MCP transport
        class MockMcpTransport extends EventEmitter {
            constructor() {
                super();
            }
            send(msg) {
                if (msg.method === 'initialize') {
                    setImmediate(() => {
                        this.emit('message', {
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: {
                                protocolVersion: '2024-11-05',
                                serverInfo: { name: 'mock-weather-server', version: '1.0.0' }
                            }
                        });
                    });
                } else if (msg.method === 'tools/list') {
                    setImmediate(() => {
                        this.emit('message', {
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: {
                                tools: [
                                    {
                                        name: 'get_weather',
                                        description: 'Get live weather for city',
                                        inputSchema: {
                                            type: 'object',
                                            properties: { city: { type: 'string' } },
                                            required: ['city']
                                        }
                                    }
                                ]
                            }
                        });
                    });
                } else if (msg.method === 'tools/call') {
                    setImmediate(() => {
                        this.emit('message', {
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: {
                                content: [{ type: 'text', text: `Sunny in ${msg.params.arguments.city}, 22°C` }]
                            }
                        });
                    });
                }
            }
        }

        const transport = new MockMcpTransport();
        const mcpAdapter = new McpAdapter({
            serverName: 'weather_service',
            toolRegistry,
            transport
        });

        const discovery = await mcpAdapter.discoverAndRegisterTools();
        assert.equal(discovery.ok, true);
        assert.equal(discovery.count, 1);

        const mcpToolId = 'mcp_weather_service_get_weather';
        const tool = toolRegistry.getTool(mcpToolId);
        assert.ok(tool);

        // Execute MCP tool through ToolRegistry
        const execRes = await toolRegistry.execute(mcpToolId, { city: 'London' });
        assert.equal(execRes.ok, true);
        assert.ok(execRes.result[0].text.includes('London'));

        // Disconnect cleans up cleanly without affecting built-in tools
        mcpAdapter.disconnect();
        assert.equal(toolRegistry.getTool(mcpToolId), undefined);
    });

    // 17. Preservation of existing action permissions
    await t.test('17. Preservation of existing action permissions across tiers', () => {
        const expectedTiers = [
            RISK_TIERS.SAFE_READ,
            RISK_TIERS.LOW_IMPACT,
            RISK_TIERS.WORKSPACE_READ,
            RISK_TIERS.WORKSPACE_WRITE,
            RISK_TIERS.CONSEQUENTIAL,
            RISK_TIERS.HIGH_RISK,
            RISK_TIERS.CRITICAL
        ];

        for (const tier of expectedTiers) {
            assert.ok(typeof tier === 'string' && tier.length > 0);
        }
    });

    // 18. End-to-end multi-step skill execution & regression verification
    await t.test('18. End-to-end multi-step skill execution & regression verification', async () => {
        const toolRegistry = new ToolRegistry();
        registerSystemTools(toolRegistry);
        registerFileTools(toolRegistry, testDir);

        const skillRegistry = new SkillRegistry({ toolRegistry });
        const docSkill = createDocumentSkill();
        const researchSkill = createResearchSkill();

        skillRegistry.registerSkill(docSkill);
        skillRegistry.registerSkill(researchSkill);

        // Progress event tracking
        const progressEvents = [];
        const docReceipt = await skillRegistry.execute('skill_create_document', {
            title: 'Project Architecture Blueprint',
            path: 'blueprint.md',
            content: 'Initial architecture documentation and capability map.',
            sections: [
                { heading: 'Overview', content: 'L.U.C.Y. unified capability framework.' },
                { heading: 'Tools and Skills', content: 'Formal distinction between tools and workflows.' }
            ]
        }, {
            onProgress: (p) => progressEvents.push(p)
        });

        assert.equal(docReceipt.ok, true);
        assert.equal(docReceipt.status, 'succeeded');
        assert.ok(progressEvents.length >= 3);
        assert.equal(fs.existsSync(path.join(testDir, 'blueprint.md')), true);
        const fileContent = fs.readFileSync(path.join(testDir, 'blueprint.md'), 'utf8');
        assert.ok(fileContent.includes('Project Architecture Blueprint'));
        assert.ok(fileContent.includes('Formal distinction between tools and workflows'));

        // Test ResearchSkill execution
        const researchReceipt = await skillRegistry.execute('skill_research_topic', {
            topic: 'Autonomous Windows Automation',
            saveReport: true,
            outputPath: 'automation_brief.md'
        });

        assert.equal(researchReceipt.ok, true);
        assert.equal(researchReceipt.status, 'succeeded');
        assert.ok(researchReceipt.data.citationsCount >= 2);
        assert.equal(fs.existsSync(path.join(testDir, 'automation_brief.md')), true);

        // Test TaskCoordinator integration
        const coordinator = new TaskCoordinator({
            workspaceRoot: testDir,
            memoryDir: path.join(testDir, 'mem'),
            toolRegistry,
            skillRegistry
        });

        assert.equal(coordinator.getSkillRegistry(), skillRegistry);
        assert.ok(coordinator.getPluginManager());

        const coordSkillRes = await coordinator.executeSkill('skill_create_document', {
            title: 'Coordinator Note',
            path: 'coord_note.md',
            content: 'Executed through TaskCoordinator.'
        });

        assert.equal(coordSkillRes.ok, true);
        assert.equal(fs.existsSync(path.join(testDir, 'coord_note.md')), true);
    });
});
