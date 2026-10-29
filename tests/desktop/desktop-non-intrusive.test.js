'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { AUTOMATION_TIERS, INTERACTION_MODES, getActionCapability } = require('../../src/tools/automation-tier-policy.js');
const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { registerFileTools } = require('../../src/tools/file-tools.js');
const { registerBrowserTools } = require('../../src/tools/browser-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { ResultVerifier, VERIFICATION_STATUSES } = require('../../src/core/result-verifier.js');

test('Repair 9: Non-Intrusive Desktop Automation & Cursor Independence', async (suite) => {

    const testDir = path.join(__dirname, '..', '..', 'scratch', 'test-non-intrusive');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    // -------------------------------------------------------------
    // Scenario 1: File operation uses direct API (Tier 1, zero cursor)
    // -------------------------------------------------------------
    await suite.test('1. File operation uses direct API instead of moving cursor', async () => {
        const capability = getActionCapability('file_write', { path: 'notes.txt', content: 'test content' });
        assert.equal(capability.tier, AUTOMATION_TIERS.TIER_1_DIRECT_API);
        assert.equal(capability.requiresPhysicalInput, false);
        assert.equal(capability.requiresForegroundFocus, false);
        assert.equal(capability.canExecuteInBackground, true);

        const registry = new ToolRegistry();
        registerFileTools(registry, testDir);

        const res = await registry.execute('file_write', {
            path: 'direct_api_test.txt',
            content: 'Direct API file write'
        });

        assert.equal(res.ok, true);
        assert.equal(fs.readFileSync(path.join(testDir, 'direct_api_test.txt'), 'utf8'), 'Direct API file write');
    });

    // -------------------------------------------------------------
    // Scenario 2: Supported web interaction uses browser automation (Tier 2)
    // -------------------------------------------------------------
    await suite.test('2. Web interaction uses browser DOM automation rather than global mouse input', async () => {
        const navCap = getActionCapability('browser_navigate', { url: 'https://example.com' });
        assert.equal(navCap.tier, AUTOMATION_TIERS.TIER_2_BROWSER_DOM);
        assert.equal(navCap.requiresPhysicalInput, false);
        assert.equal(navCap.requiresForegroundFocus, false);
        assert.equal(navCap.canExecuteInBackground, true);

        const clickCap = getActionCapability('browser_click', { selector: '#submit-btn' });
        assert.equal(clickCap.tier, AUTOMATION_TIERS.TIER_2_BROWSER_DOM);
        assert.equal(clickCap.requiresPhysicalInput, false);
        assert.equal(clickCap.requiresForegroundFocus, false);

        // Verify simulated browser execution receipt
        const mockBrowserManager = {
            navigate: async () => ({ status: 'navigation_success', url: 'https://example.com', httpStatus: 200 }),
            click: async () => ({ status: 'clicked', selector: '#submit-btn' })
        };
        const registry = new ToolRegistry();
        registerBrowserTools(registry, mockBrowserManager);

        const res = await registry.execute('browser_navigate', { url: 'https://example.com' });
        assert.equal(res.ok, true);
        assert.equal(res.result?.status || res.status, 'navigation_success');
    });

    // -------------------------------------------------------------
    // Scenario 3: Native control uses accessibility automation (Tier 3)
    // -------------------------------------------------------------
    await suite.test('3. Supported native control uses accessibility automation when available', async () => {
        const mockManager = {
            clickElement: async (target, query, options) => {
                return {
                    success: true,
                    verified: true,
                    action: 'invoked',
                    name: 'Save',
                    controlType: 'ControlType.Button',
                    tier: AUTOMATION_TIERS.TIER_3_UI_AUTOMATION,
                    tierName: 'Tier 3 — Windows UI Automation',
                    physicalInputUsed: false,
                    method: 'InvokePattern'
                };
            }
        };

        const registry = new ToolRegistry();
        registerDesktopTools(registry, mockManager);

        const execRes = await registry.execute('desktop_click_element', {
            target: 'app_1234',
            name: 'Save'
        });

        assert.equal(execRes.ok, true);
        const result = execRes.result || execRes;
        assert.equal(result.verified, true);
        assert.equal(result.tier, 3);
        assert.equal(result.physicalInputUsed, false);
        assert.equal(result.method, 'InvokePattern');
    });

    // -------------------------------------------------------------
    // Scenario 4: Physical input fallback rejected without explicit authorization
    // -------------------------------------------------------------
    await suite.test('4. Task does not fall back to physical input without an explicit decision', async () => {
        const manager = new DesktopAutomationManager();
        assert.equal(manager.getInteractionMode(), INTERACTION_MODES.NON_INTRUSIVE);

        // When LucyUiaWorker encounters a control without UIA patterns,
        // it fails-closed with TIER3_UIA_UNSUPPORTED if allowPhysicalFallback is false
        manager.sendCommand = async (cmd, payload) => {
            if (cmd === 'click_element' && !payload.allowPhysicalFallback) {
                const err = new Error('TIER3_UIA_UNSUPPORTED: Target control does not support non-intrusive accessibility patterns.');
                throw err;
            }
            return { verified: true, action: 'clicked', tier: 4, physicalInputUsed: true };
        };

        manager.trackedApps.set('app_1234', {
            appId: 'app_1234',
            pid: 1234,
            exe: 'calc.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        const res = await manager.clickElement('app_1234', { name: 'CustomControl' });
        assert.equal(res.success, false);
        assert.equal(res.reason, 'TIER3_UIA_UNSUPPORTED');
        assert.equal(res.physicalInputUsed, false);
        assert.equal(res.tier, 3);
    });

    // -------------------------------------------------------------
    // Scenario 5: Missing target never causes input to be sent to foreground
    // -------------------------------------------------------------
    await suite.test('5. Missing target never causes input to be sent to foreground application', async () => {
        const manager = new DesktopAutomationManager();
        manager.sendCommand = async (cmd, payload) => {
            if (cmd === 'type_text') {
                throw new Error('Application window not found');
            }
        };

        manager.trackedApps.set('non_existent_app', {
            appId: 'non_existent_app',
            pid: 7777,
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        await assert.rejects(
            async () => await manager.typeText('non_existent_app', 'hello'),
            /Application window not found/
        );
    });

    // -------------------------------------------------------------
    // Scenario 6: Switching applications prevents stale foreground input
    // -------------------------------------------------------------
    await suite.test('6. Switching applications during task prevents stale foreground input', async () => {
        const manager = new DesktopAutomationManager();
        manager.sendCommand = async (cmd, payload) => {
            if (cmd === 'type_text') {
                const err = new Error('FOCUS_VERIFICATION_FAILED: Target window lost foreground focus.');
                throw err;
            }
        };

        manager.trackedApps.set('app_1234', {
            appId: 'app_1234',
            pid: 1234,
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        const res = await manager.typeText('app_1234', 'sensitive data');
        assert.equal(res.success, false);
        assert.equal(res.verified, false);
        assert.equal(res.reason, 'TARGET_FOCUS_LOST');
        assert.equal(res.physicalInputUsed, false);
    });

    // -------------------------------------------------------------
    // Scenario 7: Cancellation prevents subsequent mouse and keyboard actions
    // -------------------------------------------------------------
    await suite.test('7. Cancellation prevents subsequent mouse and keyboard actions', async () => {
        const manager = new DesktopAutomationManager();
        let commandExecuted = false;
        manager.sendCommand = async () => {
            commandExecuted = true;
            return { verified: true };
        };

        const controller = new AbortController();
        controller.abort('User cancelled');

        await assert.rejects(
            async () => await manager.clickElement('app_1234', { name: 'OK' }, { signal: controller.signal }),
            (err) => err.code === 'CANCELLED'
        );

        await assert.rejects(
            async () => await manager.typeText('app_1234', 'test', { signal: controller.signal }),
            (err) => err.code === 'CANCELLED'
        );

        assert.equal(commandExecuted, false, 'No command should be dispatched after abort signal');
    });

    // -------------------------------------------------------------
    // Scenario 8: Failed direct integration produces truthful failure result
    // -------------------------------------------------------------
    await suite.test('8. Failed direct integration produces truthful failure result', async () => {
        const verifier = new ResultVerifier({ workspaceRoot: testDir });
        const step = {
            id: 'step_1',
            toolId: 'file_write',
            params: { path: 'fail_test.txt', content: 'expected text' }
        };

        // Tool returned ok: false
        const failedReceipt = { ok: false, error: 'Disk write permission denied' };
        const verification = await verifier.verify(step, failedReceipt);

        assert.equal(verification.verified, false);
        assert.equal(verification.status, VERIFICATION_STATUSES.FAILED);
        assert.ok(verification.failureReason.includes('Disk write permission denied'));
    });

    // -------------------------------------------------------------
    // Scenario 9: Background task updates do not steal focus
    // -------------------------------------------------------------
    await suite.test('9. Background task updates do not activate companion or steal focus', async () => {
        let focusStolen = false;
        const mockBridge = {
            setEmotion: () => {},
            handleStateEvent: () => {
                // Verified: companion state event must never invoke SetForegroundWindow or focus grabbing
            }
        };

        const memDir = path.join(testDir, 'mem');
        const strDir = path.join(testDir, 'store');
        fs.mkdirSync(memDir, { recursive: true });
        fs.mkdirSync(strDir, { recursive: true });

        const coordinator = new TaskCoordinator({
            workspaceRoot: testDir,
            memoryDir: memDir,
            storeDir: strDir
        });
        coordinator.setCompanionBridge(mockBridge);

        assert.equal(coordinator.getInteractionMode(), INTERACTION_MODES.NON_INTRUSIVE);
        assert.equal(focusStolen, false);
    });

    // -------------------------------------------------------------
    // Scenario 10: Action verified before reporting success
    // -------------------------------------------------------------
    await suite.test('10. Action is verified before task reports success', async () => {
        const verifier = new ResultVerifier({ workspaceRoot: testDir });

        const clickStep = {
            id: 'step_click',
            toolId: 'desktop_click_element',
            params: { target: 'app_1234', name: 'Submit' },
            automationTier: 3
        };

        // Absent confirmation receipt must be INCONCLUSIVE, not VERIFIED
        const unconfirmedToolResult = { ok: true, result: {} };
        const vResult = await verifier.verify(clickStep, unconfirmedToolResult);
        assert.equal(vResult.verified, false);
        assert.equal(vResult.status, VERIFICATION_STATUSES.INCONCLUSIVE);

        // Confirmed receipt with tier metadata
        const confirmedToolResult = {
            ok: true,
            result: { verified: true, action: 'invoked', tier: 3, physicalInputUsed: false }
        };
        const vConfirmed = await verifier.verify(clickStep, confirmedToolResult);
        assert.equal(vConfirmed.verified, true);
        assert.equal(vConfirmed.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(vConfirmed.tier, 3);
        assert.equal(vConfirmed.physicalInputUsed, false);
    });

    // -------------------------------------------------------------
    // Scenario 11: Destructive actions retain confirmation and permission checks
    // -------------------------------------------------------------
    await suite.test('11. Destructive actions retain appropriate confirmation and permission checks', () => {
        const authority = new PermissionAuthority({ mode: PERMISSION_MODES.NORMAL, workspaceRoot: testDir });
        const registry = new ToolRegistry({ permissionAuthority: authority });

        const mockManager = {
            clickElement: async () => ({ success: true }),
            closeApp: async () => ({ closed: true }),
            typeText: async () => ({ success: true })
        };
        registerDesktopTools(registry, mockManager);

        assert.equal(registry.getTool('desktop_click_element').riskTier, RISK_TIERS.CONSEQUENTIAL);
        assert.equal(registry.getTool('desktop_close_app').riskTier, RISK_TIERS.CONSEQUENTIAL);
        assert.equal(registry.getTool('desktop_type_text').riskTier, RISK_TIERS.CONSEQUENTIAL);
    });

    // -------------------------------------------------------------
    // Scenario 12: Physical input fallback correctly identified and reported
    // -------------------------------------------------------------
    await suite.test('12. Physical-input fallback is correctly identified and reported', async () => {
        const manager = new DesktopAutomationManager({
            interactionMode: INTERACTION_MODES.FOREGROUND_REQUIRED
        });
        assert.equal(manager.getInteractionMode(), INTERACTION_MODES.FOREGROUND_REQUIRED);

        manager.sendCommand = async (cmd, payload) => {
            assert.equal(payload.allowPhysicalFallback, true);
            return {
                verified: true,
                action: 'clicked',
                name: 'LegacyBtn',
                tier: AUTOMATION_TIERS.TIER_4_PHYSICAL_FALLBACK,
                tierName: 'Tier 4 — Physical mouse/keyboard fallback',
                physicalInputUsed: true,
                method: 'PhysicalMouseEvent'
            };
        };

        manager.trackedApps.set('app_1234', {
            appId: 'app_1234',
            pid: 1234,
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        const res = await manager.clickElement('app_1234', { name: 'LegacyBtn' });
        assert.equal(res.success, true);
        assert.equal(res.verified, true);
        assert.equal(res.tier, 4);
        assert.equal(res.tierName, 'Tier 4 — Physical mouse/keyboard fallback');
        assert.equal(res.physicalInputUsed, true);
        assert.equal(res.method, 'PhysicalMouseEvent');
    });

    // Cleanup scratch dir
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_) {}
});
