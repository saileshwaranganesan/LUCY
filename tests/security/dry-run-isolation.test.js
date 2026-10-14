'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, RISK_TIERS } = require('../../src/security/permission-authority.js');

test('Security & Reliability: Dry-Run Tool Execution Safety & Permission Enforcement', async (t) => {
    await t.test('dry-run mode is MECHANICALLY incapable of executing real tool handler', async () => {
        const authority = new PermissionAuthority();
        const registry = new ToolRegistry({ permissionAuthority: authority });

        let realHandlerInvoked = false;
        let sideEffectExecuted = false;

        // Register a simulated destructive tool
        registry.registerTool({
            id: 'destructive_file_remover',
            name: 'Destructive File Remover',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async (params) => {
                realHandlerInvoked = true;
                sideEffectExecuted = true;
                return { ok: true, deleted: params.path };
            },
            dryRunSimulate: async (params) => {
                return {
                    simulatedEffect: `Would delete file: ${params.path}`,
                    bytesFreed: 1024
                };
            }
        });

        // Execute WITH dryRun: true
        const result = await registry.execute('destructive_file_remover', {
            path: 'C:\\Users\\admin\\Desktop\\important_data.txt'
        }, { dryRun: true });

        // Assert that the real handler was NOT called
        assert.equal(realHandlerInvoked, false, 'REAL TOOL HANDLER MUST NEVER BE INVOKED IN DRY-RUN');
        assert.equal(sideEffectExecuted, false, 'SIDE EFFECT MUST NEVER EXECUTE IN DRY-RUN');
        assert.equal(result.ok, true);
        assert.equal(result.dryRun, true);
        assert.equal(result.executed, false);
        assert.equal(result.status, 'dry_run_simulated');
        assert.equal(result.simulatedDetails.simulatedEffect, 'Would delete file: C:\\Users\\admin\\Desktop\\important_data.txt');
    });

    await t.test('unauthorized consequential operation fails closed when confirmation is declined', async () => {
        const authority = new PermissionAuthority();
        // Set confirmation handler that rejects permission
        authority.setConfirmationHandler(async () => false);

        const registry = new ToolRegistry({ permissionAuthority: authority });

        let realActionExecuted = false;
        registry.registerTool({
            id: 'shell_command_runner',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            handler: async () => {
                realActionExecuted = true;
                return { ok: true };
            }
        });

        // Run WITHOUT dryRun (real run) where user declines
        const result = await registry.execute('shell_command_runner', { command: 'format C:' }, { dryRun: false });

        assert.equal(realActionExecuted, false, 'Action must not execute when user declines');
        assert.equal(result.ok, false);
        assert.equal(result.status, 'permission_denied');
        assert.ok(result.error.includes('declined'));
    });

    await t.test('fails closed when consequential action has no interactive confirmation handler', async () => {
        const authority = new PermissionAuthority();
        // No confirmation handler installed
        const registry = new ToolRegistry({ permissionAuthority: authority });

        let realActionExecuted = false;
        registry.registerTool({
            id: 'external_mailer',
            riskTier: RISK_TIERS.CRITICAL,
            handler: async () => {
                realActionExecuted = true;
                return { ok: true };
            }
        });

        const result = await registry.execute('external_mailer', { to: 'external@victim.com' }, { dryRun: false });

        assert.equal(realActionExecuted, false, 'Must fail closed when no confirmation handler exists');
        assert.equal(result.ok, false);
        assert.equal(result.status, 'permission_denied');
        assert.ok(result.error.includes('No interactive confirmation handler'));
    });
});
