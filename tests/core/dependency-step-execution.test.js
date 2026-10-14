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
});
