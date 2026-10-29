'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');

test('Workstream 2: Dependency-Aware Step Execution', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-dep-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    await t.test('1. Dependency ordering: Step 2 depends on Step 1 and executes only after Step 1 succeeds', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const callOrder = [];

        tr.registerTool({
            id: 'setup_step',
            name: 'Setup Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                callOrder.push('step_1');
                return { ok: true, status: 'setup_ready', result: { ready: true }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'dependent_step',
            name: 'Dependent Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                callOrder.push('step_2');
                return { ok: true, status: 'work_done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Ordered execution',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Setup', toolId: 'setup_step', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Work', toolId: 'dependent_step', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_1')
        });

        const res = await coordinator.executeRequest('Run ordered workflow');

        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.deepEqual(callOrder, ['step_1', 'step_2']);
        assert.equal(res.executedSteps.length, 2);
        assert.equal(res.executedSteps[0].verified, true);
        assert.equal(res.executedSteps[1].verified, true);
    });

    await t.test('2. Failed prerequisite halts execution: Step 2 consequential action is NEVER executed', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let consequentialActionExecuted = false;

        tr.registerTool({
            id: 'failing_prereq',
            name: 'Failing Prerequisite',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                return { ok: false, error: 'Database connection failed', verification: { verified: false } };
            }
        });

        tr.registerTool({
            id: 'consequential_action',
            name: 'Consequential Action',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                consequentialActionExecuted = true;
                return { ok: true, status: 'written', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Halt on prerequisite failure',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Prereq', toolId: 'failing_prereq', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Consequential Write', toolId: 'consequential_action', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_2')
        });

        const res = await coordinator.executeRequest('Run failing prerequisite workflow');

        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(consequentialActionExecuted, false, 'Consequential action MUST NOT execute when prerequisite failed!');
        assert.equal(res.executedSteps.length, 1);
        assert.equal(res.executedSteps[0].verified, false);
    });

    await t.test('3. Dynamic parameter resolution across dependent step outputs', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'generate_artifact',
            name: 'Generate Artifact',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'generated',
                result: { artifactPath: 'output/report.json', recordCount: 42 },
                verification: { verified: true }
            })
        });

        let receivedPath = null;
        tr.registerTool({
            id: 'process_artifact',
            name: 'Process Artifact',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => {
                receivedPath = params.targetPath;
                return { ok: true, status: 'processed', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Parameter interpolation',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Generate', toolId: 'generate_artifact', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Process',
                    toolId: 'process_artifact',
                    params: { targetPath: '{{step_1.result.artifactPath}}' },
                    dependsOn: ['step_1']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_3')
        });

        const res = await coordinator.executeRequest('Test parameter interpolation');

        assert.equal(res.ok, true);
        assert.equal(receivedPath, 'output/report.json');
        assert.equal(res.executedSteps[1].params.targetPath, 'output/report.json');
    });

    await t.test('4. Safe read-only operations can execute in parallel when permitted', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let runningConcurrent = 0;
        let maxConcurrent = 0;

        tr.registerTool({
            id: 'read_op_1',
            name: 'Read Operation 1',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                runningConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, runningConcurrent);
                await new Promise((r) => setTimeout(r, 60));
                runningConcurrent--;
                return { ok: true, status: 'read_1_done', result: { a: 1 }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'read_op_2',
            name: 'Read Operation 2',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                runningConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, runningConcurrent);
                await new Promise((r) => setTimeout(r, 60));
                runningConcurrent--;
                return { ok: true, status: 'read_2_done', result: { b: 2 }, verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Concurrent safe reads',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Read 1', toolId: 'read_op_1', params: {}, parallel: true, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Read 2', toolId: 'read_op_2', params: {}, parallel: true, dependsOn: [] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_4')
        });

        const res = await coordinator.executeRequest('Run parallel safe reads', { allowParallel: true });

        assert.equal(res.ok, true);
        assert.equal(res.executedSteps.length, 2);
        assert.ok(maxConcurrent >= 2, `Expected concurrent execution (maxConcurrent: ${maxConcurrent})`);
    });

    await t.test('5. Authorization boundary: Consequential steps strictly require permission confirmation', async () => {
        let confirmationPromptReceived = false;

        const pa = new PermissionAuthority({
            mode: PERMISSION_MODES.STRICT,
            workspaceRoot: testDir,
            confirmationHandler: async (req) => {
                confirmationPromptReceived = true;
                return { confirmed: false, reason: 'Denied by security policy in test' };
            }
        });

        const tr = new ToolRegistry({ permissionAuthority: pa });
        registerFileTools(tr, testDir);

        const planner = new TaskPlanner({ toolRegistry: tr });
        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner,
            memoryDir: path.join(testDir, 'mem_dep_5')
        });

        const res = await coordinator.executeRequest('write file secret.txt with content "confidential"');

        assert.equal(confirmationPromptReceived, true, 'User confirmation must be invoked for consequential write');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.match(res.error, /permission|declined/i);
    });

    await t.test('6. Multi-dependency convergence: Step 3 depends on Step 1 and Step 2, receiving both outputs', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'fetch_user_profile',
            name: 'Fetch User',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'fetched',
                result: { username: 'alice', role: 'admin' },
                verification: { verified: true }
            })
        });

        tr.registerTool({
            id: 'fetch_system_metrics',
            name: 'Fetch Metrics',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'fetched',
                result: { cpuLoad: '12%', memoryFreeMb: 4096 },
                verification: { verified: true }
            })
        });

        let mergedPayload = null;
        tr.registerTool({
            id: 'generate_summary_report',
            name: 'Generate Summary',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => {
                mergedPayload = params;
                return { ok: true, status: 'report_created', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Combine multiple prerequisites',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Fetch User', toolId: 'fetch_user_profile', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Fetch Metrics', toolId: 'fetch_system_metrics', params: {}, dependsOn: [] },
                {
                    id: 'step_3',
                    index: 3,
                    title: 'Generate Summary',
                    toolId: 'generate_summary_report',
                    params: {
                        user: '{{step_1.result.username}}',
                        role: '{{step_1.result.role}}',
                        cpu: '{{step_2.result.cpuLoad}}',
                        mem: '{{step_2.result.memoryFreeMb}}'
                    },
                    dependsOn: ['step_1', 'step_2']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_6')
        });

        const res = await coordinator.executeRequest('Generate combined report');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(res.executedSteps.length, 3);
        assert.equal(mergedPayload.user, 'alice');
        assert.equal(mergedPayload.role, 'admin');
        assert.equal(mergedPayload.cpu, '12%');
        assert.equal(mergedPayload.mem, '4096');
    });

    await t.test('7. Completion order differs from declaration order without breaking dependency correctness', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        const executionOrder = [];

        tr.registerTool({
            id: 'dep_step_a',
            name: 'Step A',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                executionOrder.push('step_a');
                return { ok: true, status: 'done_a', result: { valA: 'Alpha' }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'dep_step_b',
            name: 'Step B',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                executionOrder.push('step_b');
                return { ok: true, status: 'done_b', result: { valB: 'Beta' }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'dep_step_c',
            name: 'Step C',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => {
                executionOrder.push('step_c');
                return { ok: true, status: 'done_c', result: { merged: `${params.a}-${params.b}` }, verification: { verified: true } };
            }
        });

        // Declared out of topological order: Step C is declared FIRST in the array, but depends on A and B
        const customPlan = {
            objective: 'Out of order declaration',
            type: 'plan',
            steps: [
                {
                    id: 'step_c',
                    index: 1,
                    title: 'Step C (depends on A & B)',
                    toolId: 'dep_step_c',
                    params: { a: '{{step_a.result.valA}}', b: '{{step_b.result.valB}}' },
                    dependsOn: ['step_a', 'step_b']
                },
                { id: 'step_a', index: 2, title: 'Step A', toolId: 'dep_step_a', params: {}, dependsOn: [] },
                { id: 'step_b', index: 3, title: 'Step B', toolId: 'dep_step_b', params: {}, dependsOn: [] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_7')
        });

        const res = await coordinator.executeRequest('Execute topological plan');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        // Both prerequisites step_a and step_b must execute BEFORE dependent step_c
        assert.deepEqual(executionOrder, ['step_a', 'step_b', 'step_c']);
        assert.equal(res.executedSteps[2].params.a, 'Alpha');
        assert.equal(res.executedSteps[2].params.b, 'Beta');
    });

    await t.test('8. One prerequisite fails in multi-dependency plan: downstream step never executes', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let downstreamExecuted = false;

        tr.registerTool({
            id: 'success_prereq',
            name: 'Success Prereq',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', result: { data: 123 }, verification: { verified: true } })
        });

        tr.registerTool({
            id: 'failed_prereq',
            name: 'Failed Prereq',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: false, error: 'Network socket closed', verification: { verified: false } })
        });

        tr.registerTool({
            id: 'downstream_task',
            name: 'Downstream Task',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                downstreamExecuted = true;
                return { ok: true, status: 'should_not_run', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Prereq failure block',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'success_prereq', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2', toolId: 'failed_prereq', params: {}, dependsOn: [] },
                { id: 'step_3', index: 3, title: 'Step 3', toolId: 'downstream_task', params: {}, dependsOn: ['step_1', 'step_2'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_8')
        });

        const res = await coordinator.executeRequest('Test partial prerequisite failure');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(downstreamExecuted, false, 'Downstream step must NOT execute if any prerequisite failed');
        assert.equal(res.partiallyCompleted, true, 'Should truthfully report partial completion since step 1 succeeded');
    });

    await t.test('9. In-flight cancellation of prerequisite halts execution and marks task cancelled', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let step3Executed = false;

        const ac = new AbortController();

        tr.registerTool({
            id: 'long_running_step_1',
            name: 'Long Running Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                ac.abort('User cancelled during step 1');
                return { ok: true, status: 'aborted_after', verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'cancelled_downstream',
            name: 'Cancelled Downstream',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step3Executed = true;
                return { ok: true, status: 'ran', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Cancellation test',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'long_running_step_1', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2', toolId: 'cancelled_downstream', params: {}, dependsOn: ['step_1'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_9')
        });

        const res = await coordinator.executeRequest('Test cancellation', { signal: ac.signal });
        assert.equal(res.ok, false);
        assert.equal(res.status, 'cancelled');
        assert.equal(res.cancelled, true);
        assert.equal(step3Executed, false, 'Dependent step must NEVER execute after cancellation');
    });

    await t.test('10. Unknown dependency IDs are rejected before execution fail-closed', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let toolExecuted = false;

        tr.registerTool({
            id: 'any_tool',
            name: 'Any Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                toolExecuted = true;
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Unknown dep test',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'any_tool', params: {}, dependsOn: ['phantom_step_999'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_10')
        });

        const res = await coordinator.executeRequest('Unknown dep');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(toolExecuted, false, 'No tools may execute when plan has unknown dependency');
        assert.match(res.error, /unknown dependency reference/i);
    });

    await t.test('11. Cyclic dependencies are rejected before execution fail-closed', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let toolExecuted = false;

        tr.registerTool({
            id: 'cycle_tool',
            name: 'Cycle Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                toolExecuted = true;
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Cyclic plan',
            type: 'plan',
            steps: [
                { id: 'step_a', index: 1, title: 'Step A', toolId: 'cycle_tool', params: {}, dependsOn: ['step_b'] },
                { id: 'step_b', index: 2, title: 'Step B', toolId: 'cycle_tool', params: {}, dependsOn: ['step_a'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_11')
        });

        const res = await coordinator.executeRequest('Cyclic plan');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(toolExecuted, false, 'No tools may execute when plan contains cycles');
        assert.match(res.error, /cyclic dependency detected/i);
    });

    await t.test('12. Self-dependency is rejected before execution fail-closed', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let toolExecuted = false;

        tr.registerTool({
            id: 'self_dep_tool',
            name: 'Self Dep Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                toolExecuted = true;
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Self dep plan',
            type: 'plan',
            steps: [
                { id: 'step_self', index: 1, title: 'Step Self', toolId: 'self_dep_tool', params: {}, dependsOn: ['step_self'] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_12')
        });

        const res = await coordinator.executeRequest('Self dep');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(toolExecuted, false);
        assert.match(res.error, /cannot depend on itself/i);
    });

    await t.test('13. Duplicate step IDs are rejected before execution fail-closed', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let toolExecuted = false;

        tr.registerTool({
            id: 'dup_tool',
            name: 'Dup Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                toolExecuted = true;
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Duplicate ID plan',
            type: 'plan',
            steps: [
                { id: 'duplicate_step', index: 1, title: 'Step 1', toolId: 'dup_tool', params: {}, dependsOn: [] },
                { id: 'duplicate_step', index: 2, title: 'Step 2', toolId: 'dup_tool', params: {}, dependsOn: [] }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_13')
        });

        const res = await coordinator.executeRequest('Duplicate step ID');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(toolExecuted, false);
        assert.match(res.error, /duplicate step id detected/i);
    });

    await t.test('14. Missing or invalid prerequisite outputs cause explicit parameter resolution failure without tool execution', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let tool2Executed = false;

        tr.registerTool({
            id: 'producer_incomplete',
            name: 'Incomplete Producer',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'done',
                result: { otherKey: 'not_what_was_expected' },
                verification: { verified: true }
            })
        });

        tr.registerTool({
            id: 'consumer_tool',
            name: 'Consumer Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                tool2Executed = true;
                return { ok: true, status: 'consumed', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Missing output interpolation',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Producer', toolId: 'producer_incomplete', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Consumer',
                    toolId: 'consumer_tool',
                    params: { requiredFile: '{{step_1.result.expectedFilePath}}' },
                    dependsOn: ['step_1']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_14')
        });

        const res = await coordinator.executeRequest('Missing output test');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(tool2Executed, false, 'Consumer tool must NEVER execute with unresolvable parameter');
        assert.equal(res.executedSteps.length, 2);
        assert.equal(res.executedSteps[1].verified, false);
        assert.equal(res.executedSteps[1].result.status, 'parameter_resolution_failed');
        assert.match(res.error, /parameter resolution failed/i);
    });

    await t.test('15. Consequential safeguards on multi-dependency: denied confirmation halts execution fail-closed', async () => {
        let confirmationHandlerCalled = false;
        const pa = new PermissionAuthority({
            mode: PERMISSION_MODES.STANDARD,
            workspaceRoot: testDir,
            confirmationHandler: async () => {
                confirmationHandlerCalled = true;
                return false; // Denied by user
            }
        });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'read_config_1',
            name: 'Read Config 1',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'done', result: { port: 8080 }, verification: { verified: true } })
        });

        tr.registerTool({
            id: 'read_config_2',
            name: 'Read Config 2',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'done', result: { host: 'localhost' }, verification: { verified: true } })
        });

        let consequentialRan = false;
        tr.registerTool({
            id: 'consequential_deploy',
            name: 'Consequential Deploy',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                consequentialRan = true;
                return { ok: true, status: 'deployed', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Consequential deploy with multi-prereqs',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Read 1', toolId: 'read_config_1', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Read 2', toolId: 'read_config_2', params: {}, dependsOn: [] },
                {
                    id: 'step_3',
                    index: 3,
                    title: 'Deploy',
                    toolId: 'consequential_deploy',
                    params: { endpoint: 'http://{{step_2.result.host}}:{{step_1.result.port}}' },
                    dependsOn: ['step_1', 'step_2']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_15')
        });

        const res = await coordinator.executeRequest('Run consequential multi-dependency');
        assert.equal(confirmationHandlerCalled, true);
        assert.equal(consequentialRan, false, 'Consequential action must not execute when denied');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(res.partiallyCompleted, true, 'Steps 1 and 2 succeeded, so task is partially completed');
    });

    await t.test('16. Multi-dependency with bounded retry: prerequisite recovers and downstream receives recovered data', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let flakyStepAttempts = 0;
        tr.registerTool({
            id: 'flaky_fetch',
            name: 'Flaky Fetch',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                flakyStepAttempts++;
                if (flakyStepAttempts === 1) {
                    return { ok: false, error: 'Connection reset by peer (ECONNRESET)', verification: { verified: false } };
                }
                return { ok: true, status: 'recovered', result: { token: 'rec_tok_9988' }, verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'stable_fetch',
            name: 'Stable Fetch',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', result: { url: 'https://api.internal' }, verification: { verified: true } })
        });

        let downstreamReceived = null;
        tr.registerTool({
            id: 'final_consumer',
            name: 'Final Consumer',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => {
                downstreamReceived = params;
                return { ok: true, status: 'all_done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Recovery and multi-dependency',
            type: 'plan',
            steps: [
                { id: 'step_flaky', index: 1, title: 'Flaky Step', toolId: 'flaky_fetch', params: {}, dependsOn: [] },
                { id: 'step_stable', index: 2, title: 'Stable Step', toolId: 'stable_fetch', params: {}, dependsOn: [] },
                {
                    id: 'step_consumer',
                    index: 3,
                    title: 'Consumer Step',
                    toolId: 'final_consumer',
                    params: { auth: '{{step_flaky.result.token}}', endpoint: '{{step_stable.result.url}}' },
                    dependsOn: ['step_flaky', 'step_stable']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_16')
        });

        const res = await coordinator.executeRequest('Run recovery multi-dependency');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(flakyStepAttempts, 2, 'Should have retried flaky prerequisite once');
        assert.equal(downstreamReceived.auth, 'rec_tok_9988');
        assert.equal(downstreamReceived.endpoint, 'https://api.internal');
        assert.equal(res.executedSteps[0].recovery.recovered, true);
    });

    await t.test('17. Condition true executes the step (Req 1)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let step2Ran = false;

        tr.registerTool({
            id: 'check_status_tool',
            name: 'Check Status',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'ready',
                result: { ready: true, code: 200 },
                verification: { verified: true }
            })
        });

        tr.registerTool({
            id: 'conditional_action_tool',
            name: 'Conditional Action',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step2Ran = true;
                return { ok: true, status: 'executed', result: { action: 'done' }, verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Condition true execution',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Check', toolId: 'check_status_tool', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Action',
                    toolId: 'conditional_action_tool',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.ready', op: 'eq', value: true },
                    onFalse: 'skip'
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_17')
        });

        const res = await coordinator.executeRequest('Run true condition');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(step2Ran, true);
        assert.equal(res.executedSteps.length, 2);
        assert.equal(res.executedSteps[1].condition.met, true);
        assert.equal(res.executedSteps[1].condition.action, 'execute');
        assert.equal(res.executedSteps[1].skipped, undefined);
    });

    await t.test('18. Condition false with onFalse: skip records a genuine skipped state (Req 2)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let step2Ran = false;
        let step3Ran = false;

        tr.registerTool({
            id: 'flag_provider',
            name: 'Flag Provider',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'ok',
                result: { enabled: false },
                verification: { verified: true }
            })
        });

        tr.registerTool({
            id: 'skipped_tool',
            name: 'Skipped Tool',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step2Ran = true;
                return { ok: true, status: 'should_not_run', verification: { verified: true } };
            }
        });

        tr.registerTool({
            id: 'trailing_step',
            name: 'Trailing Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step3Ran = true;
                return { ok: true, status: 'trailing_done', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Condition skip execution',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Check Flag', toolId: 'flag_provider', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Optional Step',
                    toolId: 'skipped_tool',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.enabled', op: 'eq', value: true },
                    onFalse: 'skip'
                },
                {
                    id: 'step_3',
                    index: 3,
                    title: 'Trailing Action',
                    toolId: 'trailing_step',
                    params: {},
                    dependsOn: ['step_1']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_18')
        });

        const res = await coordinator.executeRequest('Run skip condition');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(step2Ran, false, 'Skipped tool must never be called');
        assert.equal(step3Ran, true, 'Subsequent unconditional step should execute');
        assert.equal(res.executedSteps.length, 3);
        const skippedReceipt = res.executedSteps[1];
        assert.equal(skippedReceipt.status, 'skipped');
        assert.equal(skippedReceipt.skipped, true);
        assert.equal(skippedReceipt.toolExecuted, false);
        assert.equal(skippedReceipt.condition.met, false);
        assert.equal(skippedReceipt.condition.action, 'skip');
        assert.equal(coordinator.statusManager.getStepSummary().skipped, 1);
    });

    await t.test('19. Condition false with onFalse: fail records failure and prevents unsafe downstream execution (Req 3)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let step3Ran = false;

        tr.registerTool({
            id: 'health_check',
            name: 'Health Check',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'degraded',
                result: { status: 'degraded' },
                verification: { verified: true }
            })
        });

        tr.registerTool({
            id: 'guarded_step',
            name: 'Guarded Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'guard_passed', verification: { verified: true } })
        });

        tr.registerTool({
            id: 'consequential_downstream',
            name: 'Consequential Downstream',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                step3Ran = true;
                return { ok: true, status: 'mutated', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Condition fail execution',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Check Health', toolId: 'health_check', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Require Healthy',
                    toolId: 'guarded_step',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.status', op: 'eq', value: 'healthy' },
                    onFalse: 'fail'
                },
                {
                    id: 'step_3',
                    index: 3,
                    title: 'Downstream Consequential',
                    toolId: 'consequential_downstream',
                    params: {},
                    dependsOn: ['step_2']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_19')
        });

        const res = await coordinator.executeRequest('Run fail condition');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(step3Ran, false, 'Downstream consequential step must NEVER execute');
        assert.equal(res.executedSteps.length, 2);
        assert.equal(res.executedSteps[1].status, 'failed');
        assert.equal(res.executedSteps[1].condition.met, false);
        assert.equal(res.executedSteps[1].condition.action, 'fail');
    });

    await t.test('20. Downstream step that depends on a skipped step behaves according to contract (Req 4)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'gate_check',
            name: 'Gate Check',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', result: { active: false }, verification: { verified: true } })
        });

        tr.registerTool({
            id: 'producer_opt',
            name: 'Optional Producer',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', result: { generatedKey: 'key_123' }, verification: { verified: true } })
        });

        let consumerRan = false;
        tr.registerTool({
            id: 'consumer_opt',
            name: 'Consumer of Optional',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                consumerRan = true;
                return { ok: true, status: 'done', verification: { verified: true } };
            }
        });

        // Subcase 4A: Downstream depends on skipped step AND requires its output -> fails closed!
        const planWithRequiredOutput = {
            objective: 'Required output from skipped step',
            type: 'plan',
            steps: [
                { id: 'step_gate', index: 1, title: 'Gate', toolId: 'gate_check', params: {}, dependsOn: [] },
                {
                    id: 'step_opt',
                    index: 2,
                    title: 'Optional Producer',
                    toolId: 'producer_opt',
                    params: {},
                    dependsOn: ['step_gate'],
                    condition: { ref: 'step_gate.result.active', op: 'eq', value: true },
                    onFalse: 'skip'
                },
                {
                    id: 'step_consumer',
                    index: 3,
                    title: 'Consumer',
                    toolId: 'consumer_opt',
                    params: { key: '{{step_opt.result.generatedKey}}' },
                    dependsOn: ['step_opt']
                }
            ]
        };

        const coordinatorA = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planWithRequiredOutput },
            memoryDir: path.join(testDir, 'mem_dep_20a')
        });

        const resA = await coordinatorA.executeRequest('Run skipped prerequisite with required output');
        assert.equal(resA.ok, false);
        assert.equal(resA.status, 'failed');
        assert.equal(consumerRan, false, 'Consumer must not run when prerequisite was skipped and output missing');
        assert.match(resA.error, /was skipped and produced no usable outputs/i);

        // Subcase 4B: Downstream depends on skipped step for sequencing but does NOT require its output -> succeeds!
        let pureSequenceRan = false;
        tr.registerTool({
            id: 'pure_sequence_tool',
            name: 'Pure Sequence',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                pureSequenceRan = true;
                return { ok: true, status: 'sequence_done', verification: { verified: true } };
            }
        });

        const planPureSequence = {
            objective: 'Sequencing after skipped step',
            type: 'plan',
            steps: [
                { id: 'step_gate2', index: 1, title: 'Gate', toolId: 'gate_check', params: {}, dependsOn: [] },
                {
                    id: 'step_opt2',
                    index: 2,
                    title: 'Optional Producer',
                    toolId: 'producer_opt',
                    params: {},
                    dependsOn: ['step_gate2'],
                    condition: { ref: 'step_gate2.result.active', op: 'eq', value: true },
                    onFalse: 'skip'
                },
                {
                    id: 'step_seq',
                    index: 3,
                    title: 'Sequenced Step',
                    toolId: 'pure_sequence_tool',
                    params: { mode: 'default' },
                    dependsOn: ['step_opt2']
                }
            ]
        };

        const coordinatorB = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planPureSequence },
            memoryDir: path.join(testDir, 'mem_dep_20b')
        });

        const resB = await coordinatorB.executeRequest('Run pure sequence after skipped step');
        assert.equal(resB.ok, true);
        assert.equal(resB.status, 'completed');
        assert.equal(pureSequenceRan, true);
        assert.equal(resB.executedSteps[1].status, 'skipped');
        assert.equal(resB.executedSteps[2].status, 'completed');
    });

    await t.test('21. Missing condition output fails closed (Req 5)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let step2Ran = false;

        tr.registerTool({
            id: 'partial_output_producer',
            name: 'Partial Producer',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'ok',
                result: { foo: 1 },
                verification: { verified: true }
            })
        });

        tr.registerTool({
            id: 'dependent_candidate',
            name: 'Dependent Candidate',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                step2Ran = true;
                return { ok: true, status: 'ran', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Missing condition output',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Produce Partial', toolId: 'partial_output_producer', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Check Missing Field',
                    toolId: 'dependent_candidate',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.missingField.nested', op: 'eq', value: 'target' },
                    onFalse: 'skip'
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_21')
        });

        const res = await coordinator.executeRequest('Run missing condition field');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(step2Ran, false);
        assert.match(res.error, /did not produce expected output field/i);
    });

    await t.test('22. Invalid condition schema and unsupported operators are rejected (Req 6)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'noop_tool',
            name: 'Noop',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', verification: { verified: true } })
        });

        // Case 6A: Unsupported operator (eval_js)
        const planBadOp = {
            objective: 'Bad operator',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'noop_tool', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Step 2',
                    toolId: 'noop_tool',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.ok', op: 'eval_js', value: '1+1' }
                }
            ]
        };

        const coordA = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planBadOp },
            memoryDir: path.join(testDir, 'mem_dep_22a')
        });
        const resA = await coordA.executeRequest('Run bad op');
        assert.equal(resA.ok, false);
        assert.match(resA.error, /unsupported operator 'eval_js'/i);

        // Case 6B: Invalid onFalse action ('delete')
        const planBadOnFalse = {
            objective: 'Bad onFalse',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'noop_tool', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Step 2',
                    toolId: 'noop_tool',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.ok', op: 'eq', value: true },
                    onFalse: 'delete'
                }
            ]
        };

        const coordB = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planBadOnFalse },
            memoryDir: path.join(testDir, 'mem_dep_22b')
        });
        const resB = await coordB.executeRequest('Run bad onFalse');
        assert.equal(resB.ok, false);
        assert.match(resB.error, /Invalid onFalse/i);
    });

    await t.test('23. Condition references to unexecuted or undeclared dependencies are handled according to explicit contract (Req 7)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'noop_tool',
            name: 'Noop',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', verification: { verified: true } })
        });

        // Case 7A: Condition references step_1 but step_1 is omitted from dependsOn
        const planUndeclared = {
            objective: 'Undeclared condition dependency',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 'noop_tool', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Step 2',
                    toolId: 'noop_tool',
                    params: {},
                    dependsOn: [], // Missing step_1!
                    condition: { ref: 'step_1.result.ok', op: 'eq', value: true },
                    onFalse: 'skip'
                }
            ]
        };

        const coordA = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planUndeclared },
            memoryDir: path.join(testDir, 'mem_dep_23a')
        });
        const resA = await coordA.executeRequest('Run undeclared condition dep');
        assert.equal(resA.ok, false);
        assert.match(resA.error, /Undeclared dependency reference: step 'step_2' condition references 'step_1'/i);

        // Case 7B: Condition references non-existent step
        const planUnknown = {
            objective: 'Unknown condition dependency',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Step 1',
                    toolId: 'noop_tool',
                    params: {},
                    dependsOn: [],
                    condition: { ref: 'step_ghost.result.ok', op: 'eq', value: true }
                }
            ]
        };

        const coordB = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planUnknown },
            memoryDir: path.join(testDir, 'mem_dep_23b')
        });
        const resB = await coordB.executeRequest('Run unknown condition dep');
        assert.equal(resB.ok, false);
        assert.match(resB.error, /Unknown dependency reference: step 'step_1' condition references non-existent step 'step_ghost'/i);
    });

    await t.test('24. Falsy values (false, 0, and empty string) compare correctly (Req 8)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'falsy_producer',
            name: 'Falsy Producer',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'ok',
                result: {
                    booleanFalse: false,
                    numericZero: 0,
                    emptyStr: ''
                },
                verification: { verified: true }
            })
        });

        const executedStepIds = [];
        tr.registerTool({
            id: 'check_step',
            name: 'Check Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => {
                executedStepIds.push(params.check);
                return { ok: true, status: 'checked', result: { params }, verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Falsy comparisons',
            type: 'plan',
            steps: [
                { id: 'step_producer', index: 1, title: 'Producer', toolId: 'falsy_producer', params: {}, dependsOn: [] },
                // Should execute: booleanFalse eq false
                {
                    id: 'step_bool',
                    index: 2,
                    title: 'Check False',
                    toolId: 'check_step',
                    params: { check: 'bool_ok' },
                    dependsOn: ['step_producer'],
                    condition: { ref: 'step_producer.result.booleanFalse', op: 'eq', value: false },
                    onFalse: 'fail'
                },
                // Should execute: numericZero eq 0
                {
                    id: 'step_zero',
                    index: 3,
                    title: 'Check Zero',
                    toolId: 'check_step',
                    params: { check: 'zero_ok' },
                    dependsOn: ['step_producer'],
                    condition: { ref: 'step_producer.result.numericZero', op: 'eq', value: 0 },
                    onFalse: 'fail'
                },
                // Should execute: emptyStr eq ''
                {
                    id: 'step_str',
                    index: 4,
                    title: 'Check Empty String',
                    toolId: 'check_step',
                    params: { check: 'str_ok' },
                    dependsOn: ['step_producer'],
                    condition: { ref: 'step_producer.result.emptyStr', op: 'eq', value: '' },
                    onFalse: 'fail'
                },
                // Should execute exists on false, 0, and ''
                {
                    id: 'step_exists',
                    index: 5,
                    title: 'Check Exists on Falsy',
                    toolId: 'check_step',
                    params: { check: 'exists_ok' },
                    dependsOn: ['step_producer'],
                    condition: { ref: 'step_producer.result.booleanFalse', op: 'exists' },
                    onFalse: 'fail'
                },
                // Strict equality: booleanFalse should NOT equal numeric 0 -> should skip!
                {
                    id: 'step_strict_mismatch',
                    index: 6,
                    title: 'Check False != 0',
                    toolId: 'check_step',
                    params: { check: 'should_not_run' },
                    dependsOn: ['step_producer'],
                    condition: { ref: 'step_producer.result.booleanFalse', op: 'eq', value: 0 },
                    onFalse: 'skip'
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_24')
        });

        const res = await coordinator.executeRequest('Run falsy comparison checks');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.deepEqual(executedStepIds, ['bool_ok', 'zero_ok', 'str_ok', 'exists_ok']);
        assert.equal(res.executedSteps.find(s => s.id === 'step_strict_mismatch').status, 'skipped');
    });

    await t.test('25. Cancellation and retries do not duplicate conditional or consequential actions (Req 9)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        let condActionExecCount = 0;
        tr.registerTool({
            id: 'cond_step',
            name: 'Conditional Step',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                condActionExecCount++;
                return { ok: true, status: 'ok', result: { ready: true }, verification: { verified: true } };
            }
        });

        let flakyAttempts = 0;
        tr.registerTool({
            id: 'flaky_downstream',
            name: 'Flaky Downstream',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                flakyAttempts++;
                if (flakyAttempts === 1) {
                    return { ok: false, error: 'Network timeout (ETIMEDOUT)', verification: { verified: false } };
                }
                return { ok: true, status: 'recovered', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Retry does not re-execute conditional step',
            type: 'plan',
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Conditional Step',
                    toolId: 'cond_step',
                    params: {},
                    dependsOn: []
                },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Flaky Step',
                    toolId: 'flaky_downstream',
                    params: {},
                    dependsOn: ['step_1']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_25')
        });

        const res = await coordinator.executeRequest('Run retry continuity check');
        assert.equal(res.ok, true);
        assert.equal(flakyAttempts, 2, 'Flaky step retried once');
        assert.equal(condActionExecCount, 1, 'Prerequisite conditional step must NOT be duplicated during retry');
    });

    await t.test('26. Permission denial cannot be bypassed through a conditional branch (Req 10)', async () => {
        let confirmationPrompted = false;
        const pa = new PermissionAuthority({
            mode: PERMISSION_MODES.STANDARD,
            workspaceRoot: testDir,
            confirmationHandler: async () => {
                confirmationPrompted = true;
                return false; // User denies permission
            }
        });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 'check_auth_flag',
            name: 'Check Auth Flag',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({
                ok: true,
                status: 'ok',
                result: { proceed: true },
                verification: { verified: true }
            })
        });

        let writeExecuted = false;
        tr.registerTool({
            id: 'consequential_write_action',
            name: 'Consequential Write',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                writeExecuted = true;
                return { ok: true, status: 'written', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Permission denial on conditional step',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Check Flag', toolId: 'check_auth_flag', params: {}, dependsOn: [] },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Consequential Action',
                    toolId: 'consequential_write_action',
                    params: {},
                    dependsOn: ['step_1'],
                    condition: { ref: 'step_1.result.proceed', op: 'eq', value: true },
                    onFalse: 'skip'
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_26')
        });

        const res = await coordinator.executeRequest('Run consequential conditional branch');
        assert.equal(confirmationPrompted, true, 'User confirmation must be prompted');
        assert.equal(writeExecuted, false, 'Consequential tool must NOT execute when permission is denied');
        assert.equal(res.ok, false);
        assert.equal(res.status, 'failed');
        assert.equal(res.partiallyCompleted, true);
    });

    await t.test('27. Existing unconditional DAG behavior remains unchanged (Req 11)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });

        tr.registerTool({
            id: 't1',
            name: 'T1',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', result: { val1: 'alpha' }, verification: { verified: true } })
        });

        tr.registerTool({
            id: 't2',
            name: 'T2',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => ({ ok: true, status: 'ok', result: { val2: 'beta' }, verification: { verified: true } })
        });

        let receivedBoth = null;
        tr.registerTool({
            id: 't3',
            name: 'T3',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async (params) => {
                receivedBoth = params;
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        const customPlan = {
            objective: 'Standard unconditional DAG',
            type: 'plan',
            steps: [
                { id: 'step_1', index: 1, title: 'Step 1', toolId: 't1', params: {}, dependsOn: [] },
                { id: 'step_2', index: 2, title: 'Step 2', toolId: 't2', params: {}, dependsOn: [] },
                {
                    id: 'step_3',
                    index: 3,
                    title: 'Step 3',
                    toolId: 't3',
                    params: { a: '{{step_1.result.val1}}', b: '{{step_2.result.val2}}' },
                    dependsOn: ['step_1', 'step_2']
                }
            ]
        };

        const coordinator = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => customPlan },
            memoryDir: path.join(testDir, 'mem_dep_27')
        });

        const res = await coordinator.executeRequest('Run unconditional DAG');
        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.deepEqual(receivedBoth, { a: 'alpha', b: 'beta' });
    });

    await t.test('28. Cyclic and invalid plans still fail before tool execution (Req 12)', async () => {
        const pa = new PermissionAuthority({ mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, workspaceRoot: testDir });
        const tr = new ToolRegistry({ permissionAuthority: pa });
        let toolRan = false;

        tr.registerTool({
            id: 'tracker_tool',
            name: 'Tracker',
            riskTier: RISK_TIERS.SAFE_READ,
            handler: async () => {
                toolRan = true;
                return { ok: true, status: 'ok', verification: { verified: true } };
            }
        });

        // Case 12A: Cycle in plan
        const planCycle = {
            objective: 'Cycle plan',
            type: 'plan',
            steps: [
                { id: 'step_a', index: 1, title: 'A', toolId: 'tracker_tool', params: {}, dependsOn: ['step_b'] },
                { id: 'step_b', index: 2, title: 'B', toolId: 'tracker_tool', params: {}, dependsOn: ['step_a'] }
            ]
        };

        const coordA = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planCycle },
            memoryDir: path.join(testDir, 'mem_dep_28a')
        });
        const resA = await coordA.executeRequest('Run cycle plan');
        assert.equal(resA.ok, false);
        assert.equal(toolRan, false, 'No tool must execute on cyclic plan');
        assert.match(resA.error, /cyclic dependency detected/i);

        // Case 12B: Self-reference in condition
        const planSelfCond = {
            objective: 'Self condition plan',
            type: 'plan',
            steps: [
                {
                    id: 'step_self',
                    index: 1,
                    title: 'Self',
                    toolId: 'tracker_tool',
                    params: {},
                    dependsOn: [],
                    condition: { ref: 'step_self.result.done', op: 'eq', value: true }
                }
            ]
        };

        const coordB = new TaskCoordinator({
            permissionAuthority: pa,
            toolRegistry: tr,
            planner: { plan: async () => planSelfCond },
            memoryDir: path.join(testDir, 'mem_dep_28b')
        });
        const resB = await coordB.executeRequest('Run self condition plan');
        assert.equal(resB.ok, false);
        assert.equal(toolRan, false, 'No tool must execute on self-conditioning plan');
        assert.match(resB.error, /cannot condition on itself/i);
    });
});

