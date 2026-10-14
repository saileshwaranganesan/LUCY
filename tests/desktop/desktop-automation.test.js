'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { DesktopAutomationManager, SAFE_APP_ALLOWLIST } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');

test('Native Desktop Automation: Unit & Integration Test Suite', async (suite) => {

    // ==========================================
    // 1. UNIT TESTS (MOCKS & PERMISSION LOGIC)
    // ==========================================

    await suite.test('Unit: Tool Registration and Risk Tier Classifications', () => {
        const mockManager = {
            listApps: async () => [],
            launchApp: async () => ({}),
            inspectUI: async () => ({}),
            findElement: async () => ({}),
            typeText: async () => ({}),
            clickElement: async () => ({}),
            takeScreenshot: async () => ({}),
            closeApp: async () => ({}),
            validateExecutable: () => ({ safe: true, isAllowlisted: true, resolvedPath: 'notepad.exe' })
        };

        const registry = new ToolRegistry();
        registerDesktopTools(registry, mockManager);

        const tools = registry.listTools();
        const toolIds = tools.map(t => t.id);

        assert.ok(toolIds.includes('desktop_list_apps'));
        assert.ok(toolIds.includes('desktop_launch_app'));
        assert.ok(toolIds.includes('desktop_inspect_ui'));
        assert.ok(toolIds.includes('desktop_find_element'));
        assert.ok(toolIds.includes('desktop_type_text'));
        assert.ok(toolIds.includes('desktop_click_element'));
        assert.ok(toolIds.includes('desktop_take_screenshot'));
        assert.ok(toolIds.includes('desktop_close_app'));

        // Validate Risk Tiers
        assert.equal(registry.getTool('desktop_list_apps').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_inspect_ui').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_find_element').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_take_screenshot').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_launch_app').riskTier, RISK_TIERS.WORKSPACE_WRITE);
        assert.equal(registry.getTool('desktop_type_text').riskTier, RISK_TIERS.CONSEQUENTIAL);
        assert.equal(registry.getTool('desktop_click_element').riskTier, RISK_TIERS.CONSEQUENTIAL);
        assert.equal(registry.getTool('desktop_close_app').riskTier, RISK_TIERS.CONSEQUENTIAL);
    });

    await suite.test('Unit: Executable Allowlist and Validation', () => {
        const manager = new DesktopAutomationManager();

        // Valid allowlisted apps
        for (const app of ['notepad', 'notepad.exe', 'calc', 'calc.exe', 'calculator.exe']) {
            const res = manager.validateExecutable(app);
            assert.equal(res.safe, true);
            assert.equal(res.isAllowlisted, true);
        }

        // Existing system binaries with absolute paths
        const systemNotepad = 'C:\\Windows\\notepad.exe';
        if (fs.existsSync(systemNotepad)) {
            const res = manager.validateExecutable(systemNotepad);
            assert.equal(res.safe, true);
        }

        // Empty or non-allowlisted unverified paths must throw
        assert.throws(() => manager.validateExecutable(''), /cannot be empty/i);
        assert.throws(() => manager.validateExecutable('untrusted_malware.exe'), /neither in the safe allowlist/i);
    });

    await suite.test('Unit: Mechanical Dry-Run Isolation (No Worker Execution)', async () => {
        let realActionCalled = false;
        const mockManager = {
            launchApp: async () => { realActionCalled = true; throw new Error('REAL LAUNCH CALLED IN DRY RUN!'); },
            typeText: async () => { realActionCalled = true; throw new Error('REAL TYPE CALLED IN DRY RUN!'); },
            clickElement: async () => { realActionCalled = true; throw new Error('REAL CLICK CALLED IN DRY RUN!'); },
            closeApp: async () => { realActionCalled = true; throw new Error('REAL CLOSE CALLED IN DRY RUN!'); },
            validateExecutable: (p) => ({ safe: true, isAllowlisted: true, resolvedPath: p })
        };

        const registry = new ToolRegistry();
        registerDesktopTools(registry, mockManager);

        // Execute launch in dry-run mode
        const launchSim = await registry.execute('desktop_launch_app', { executable: 'notepad.exe' }, { dryRun: true });
        assert.equal(launchSim.dryRun, true);
        assert.equal(launchSim.executed, false);
        assert.equal(launchSim.simulatedDetails.simulatedAction, 'launch_app');
        assert.equal(realActionCalled, false);

        // Execute typing in dry-run mode
        const typeSim = await registry.execute('desktop_type_text', { target: 'notepad', text: 'secret text' }, { dryRun: true });
        assert.equal(typeSim.dryRun, true);
        assert.equal(typeSim.executed, false);
        assert.equal(typeSim.simulatedDetails.simulatedAction, 'type_text');
        assert.equal(realActionCalled, false);

        // Execute click in dry-run mode
        const clickSim = await registry.execute('desktop_click_element', { target: 'notepad', name: 'Delete All' }, { dryRun: true });
        assert.equal(clickSim.dryRun, true);
        assert.equal(clickSim.executed, false);
        assert.equal(clickSim.simulatedDetails.simulatedAction, 'click_element');
        assert.equal(clickSim.simulatedDetails.isConsequential, true);
        assert.equal(realActionCalled, false);

        // Execute close in dry-run mode
        const closeSim = await registry.execute('desktop_close_app', { target: 'notepad' }, { dryRun: true });
        assert.equal(closeSim.dryRun, true);
        assert.equal(closeSim.executed, false);
        assert.equal(closeSim.simulatedDetails.simulatedAction, 'close_app');
        assert.equal(realActionCalled, false);
    });

    await suite.test('Unit: Permission Authority Gating and Denied Action Fail-Closed', async () => {
        const permissionAuthority = new PermissionAuthority({ mode: PERMISSION_MODES.STANDARD });
        let confirmationRequested = false;

        // Configure confirmation handler that denies the request
        permissionAuthority.setConfirmationHandler(async (req) => {
            confirmationRequested = true;
            return false; // Denied by user!
        });

        const mockManager = {
            typeText: async () => { throw new Error('MUTATION SHOULD NOT OCCUR WHEN DENIED'); },
            validateExecutable: (p) => ({ safe: true, isAllowlisted: true, resolvedPath: p })
        };

        const registry = new ToolRegistry({ permissionAuthority });
        registerDesktopTools(registry, mockManager);

        // Attempting consequential typing when user denies must fail-closed
        const deniedRes = await registry.execute('desktop_type_text', { target: 'notepad', text: 'test' });
        assert.equal(deniedRes.ok, false);
        assert.equal(deniedRes.status, 'permission_denied');
        assert.equal(confirmationRequested, true);
    });

    await suite.test('Unit: TaskPlanner Direct Intent Recognition for Desktop Operations', async () => {
        const planner = new TaskPlanner();

        // 1. List apps
        const listPlan = await planner.plan('list running apps');
        assert.equal(listPlan.type, 'plan');
        assert.equal(listPlan.steps[0].toolId, 'desktop_list_apps');

        // 2. Open notepad
        const openNotepadPlan = await planner.plan('open notepad');
        assert.equal(openNotepadPlan.type, 'plan');
        assert.equal(openNotepadPlan.steps[0].toolId, 'desktop_launch_app');
        assert.equal(openNotepadPlan.steps[0].params.executable, 'notepad.exe');

        // 3. Open calculator
        const openCalcPlan = await planner.plan('launch calculator');
        assert.equal(openCalcPlan.type, 'plan');
        assert.equal(openCalcPlan.steps[0].toolId, 'desktop_launch_app');
        assert.equal(openCalcPlan.steps[0].params.executable, 'calc.exe');

        // 4. Type text in notepad
        const typePlan = await planner.plan('type hello world in notepad');
        assert.equal(typePlan.type, 'plan');
        assert.equal(typePlan.steps[0].toolId, 'desktop_type_text');
        assert.equal(typePlan.steps[0].params.target, 'notepad');
        assert.equal(typePlan.steps[0].params.text, 'hello world');

        // 5. Click in calculator
        const clickPlan = await planner.plan('click Five in Calculator');
        assert.equal(clickPlan.type, 'plan');
        assert.equal(clickPlan.steps[0].toolId, 'desktop_click_element');
        assert.equal(clickPlan.steps[0].params.target, 'Calculator');
        assert.equal(clickPlan.steps[0].params.name, 'Five');

        // 6. Close app
        const closePlan = await planner.plan('close notepad');
        assert.equal(closePlan.type, 'plan');
        assert.equal(closePlan.steps[0].toolId, 'desktop_close_app');
        assert.equal(closePlan.steps[0].params.target, 'Notepad');
    });

    // ==========================================
    // 2. INTEGRATION TESTS (REAL LOCAL APPS)
    // ==========================================

    let realManager = null;

    suite.before(() => {
        realManager = new DesktopAutomationManager();
    });

    suite.after(() => {
        if (realManager) {
            realManager.cleanup();
        }
    });

    await suite.test('Integration: Native UIA Worker Handshake and Discovery', async () => {
        await realManager.ensureWorker();
        assert.equal(realManager.isReady, true);

        const pingRes = await realManager.sendCommand('ping');
        assert.equal(pingRes.pong, true);
        assert.ok(typeof pingRes.windowsCount === 'number');

        const apps = await realManager.listApps();
        assert.ok(Array.isArray(apps));
        // Verify structure of discovered windows
        for (const app of apps) {
            assert.ok(typeof app.name === 'string');
            assert.ok(typeof app.pid === 'number');
            assert.ok(typeof app.appId === 'string');
        }
    });

    await suite.test('Integration: Live Harmless Notepad Automation Flow', async () => {
        // 1. Launch notepad
        const launchRes = await realManager.launchApp('notepad.exe');
        assert.ok(launchRes.appId);
        assert.ok(launchRes.pid > 0);

        // Allow window to initialize
        await new Promise(r => setTimeout(r, 1200));

        // 2. Discover in app list
        const apps = await realManager.listApps();
        const notepadApp = apps.find(a => (a.name || '').includes('Notepad') || a.processName === 'notepad' || a.processName === 'Notepad');
        assert.ok(notepadApp, 'Launched Notepad should be visible in desktop window list');

        // 3. Inspect UI tree
        const tree = await realManager.inspectUI('Notepad', { maxDepth: 2 });
        assert.ok(tree);
        assert.ok(tree.name.includes('Notepad'));

        // 4. Type harmless test text
        const testText = 'L.U.C.Y. Desktop Automation Test Baseline ' + Date.now();
        const typeRes = await realManager.typeText('Notepad', testText);
        assert.equal(typeRes.success, true);
        assert.equal(typeRes.verified, true);
        assert.equal(typeRes.readText, testText);

        // 5. Find element
        const found = await realManager.findElement('Notepad', { name: 'Text editor' });
        assert.ok(found);
        assert.equal(found.name, 'Text editor');

        // 6. Take screenshot
        const shot = await realManager.takeScreenshot('Notepad');
        assert.ok(shot);
        assert.equal(shot.format, 'png');
        assert.ok(shot.width > 0 && shot.height > 0);
        assert.ok(typeof shot.base64 === 'string' && shot.base64.length > 500);

        // 7. Close Notepad
        const closeRes = await realManager.closeApp({ pid: notepadApp.pid });
        assert.ok(closeRes);
        assert.equal(closeRes.closed, true);
    });

    await suite.test('Integration: Live Harmless Calculator Automation Flow', async () => {
        // 1. Launch Calculator
        const launchRes = await realManager.launchApp('calc.exe');
        assert.ok(launchRes.appId);

        // Allow calculator window to settle
        await new Promise(r => setTimeout(r, 1500));

        // 2. Find Calculator in apps
        const apps = await realManager.listApps();
        const calcApp = apps.find(a => (a.name || '').toLowerCase().includes('calculator') || (a.processName || '').toLowerCase().includes('calculator'));

        if (calcApp) {
            // 3. Inspect Calculator UI
            const tree = await realManager.inspectUI('Calculator', { maxDepth: 2 });
            assert.ok(tree);

            // 4. Find button (Five, Clear, or num5Button)
            let btn = await realManager.findElement('Calculator', { automationId: 'num5Button' });
            if (!btn) btn = await realManager.findElement('Calculator', { name: 'Five' });
            if (!btn) btn = await realManager.findElement('Calculator', { name: 'Clear' });

            if (btn) {
                // 5. Click button via UI Automation InvokePattern
                const clickRes = await realManager.clickElement('Calculator', {
                    name: btn.name,
                    automationId: btn.automationId
                });
                assert.equal(clickRes.success, true);
                assert.equal(clickRes.verified, true);
            }

            // 6. Close Calculator
            const closeRes = await realManager.closeApp({ pid: calcApp.pid });
            assert.ok(closeRes);
            assert.equal(closeRes.closed, true);
        }
    });
});
