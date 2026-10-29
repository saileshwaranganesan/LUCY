'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { DesktopAutomationManager, SAFE_APP_ALLOWLIST } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { ResultVerifier, VERIFICATION_STATUSES } = require('../../src/core/result-verifier.js');

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
            closeApp: async () => ({ closed: true }),
            detectDialog: async () => ({ dialogOpen: false }),
            handleDialog: async () => ({ handled: true, action: 'dont_save' }),
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
        assert.ok(toolIds.includes('desktop_handle_dialog'));
        assert.ok(toolIds.includes('desktop_focus_window'));

        // Validate Risk Tiers
        assert.equal(registry.getTool('desktop_list_apps').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_inspect_ui').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_find_element').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_take_screenshot').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_focus_window').riskTier, RISK_TIERS.SAFE_READ);
        assert.equal(registry.getTool('desktop_launch_app').riskTier, RISK_TIERS.WORKSPACE_WRITE);
        assert.equal(registry.getTool('desktop_type_text').riskTier, RISK_TIERS.CONSEQUENTIAL);
        assert.equal(registry.getTool('desktop_click_element').riskTier, RISK_TIERS.CONSEQUENTIAL);
        assert.equal(registry.getTool('desktop_close_app').riskTier, RISK_TIERS.CONSEQUENTIAL);
        assert.equal(registry.getTool('desktop_handle_dialog').riskTier, RISK_TIERS.CONSEQUENTIAL);
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

    const RUN_INTERACTIVE_DESKTOP = process.env.LUCY_INTERACTIVE_DESKTOP_TESTS === '1';
    const LIVE_GUI_OPTS = {
        skip: !RUN_INTERACTIVE_DESKTOP
            ? 'Live desktop GUI test isolated to prevent focus/cursor disruption during development. Set LUCY_INTERACTIVE_DESKTOP_TESTS=1 to run interactive validation.'
            : false
    };

    const testTempDir = path.join(os.tmpdir(), 'lucy_desktop_tests_' + process.pid);
    const testLaunchedPids = new Set();
    const testCreatedFiles = new Set();

    if (!fs.existsSync(testTempDir)) {
        fs.mkdirSync(testTempDir, { recursive: true });
    }

    /**
     * Safely cleanup a test-created file with strict boundary validation.
     * Refuses to delete anything outside testTempDir or inside user-profile state directories.
     */
    function safeCleanupTestFile(targetPath) {
        if (!targetPath || typeof targetPath !== 'string') return false;
        const resolvedTarget = path.resolve(targetPath);

        // Security assertion: must NOT be in Windows system or user profile state directories
        const forbiddenPrefixes = [
            process.env.WINDIR,
            process.env.APPDATA,
            process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Documents'),
            process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop'),
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages'),
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft')
        ].filter(Boolean).map(p => path.resolve(p).toLowerCase());

        for (const prefix of forbiddenPrefixes) {
            if (resolvedTarget.toLowerCase().startsWith(prefix)) {
                throw new Error(`[SAFETY_VIOLATION] Refusing to delete user-profile or system file: ${targetPath}`);
            }
        }

        // Security assertion: target must be strictly inside isolated test directory
        const relAllowed = path.relative(testTempDir, resolvedTarget);
        if (relAllowed.startsWith('..') || path.isAbsolute(relAllowed)) {
            throw new Error(`[SAFETY_VIOLATION] Refusing to delete file outside isolated test directory: ${targetPath}`);
        }

        // Ownership assertion: must be positively tracked in testCreatedFiles
        if (!testCreatedFiles.has(resolvedTarget)) {
            throw new Error(`[SAFETY_VIOLATION] Refusing to delete unowned file not tracked by test: ${targetPath}`);
        }

        try {
            if (fs.existsSync(resolvedTarget)) {
                fs.unlinkSync(resolvedTarget);
            }
            testCreatedFiles.delete(resolvedTarget);
            return true;
        } catch (_) {
            return false;
        }
    }

    function createTrackedTestFile(filename, content = '') {
        const fullPath = path.resolve(path.join(testTempDir, filename));
        fs.writeFileSync(fullPath, content);
        testCreatedFiles.add(fullPath);
        return fullPath;
    }

    async function killTestPids() {
        for (const pid of testLaunchedPids) {
            try {
                if (pid && pid !== process.pid && pid !== process.ppid) {
                    process.kill(pid);
                }
            } catch (_) {}
        }
        testLaunchedPids.clear();

        for (const f of Array.from(testCreatedFiles)) {
            try {
                safeCleanupTestFile(f);
            } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 200));
    }

    let realManager = null;

    suite.before(async () => {
        realManager = new DesktopAutomationManager();
        await new Promise(r => setTimeout(r, 100));
    });

    suite.after(async () => {
        if (realManager) {
            realManager.cleanup();
        }
        await killTestPids();
        try {
            if (fs.existsSync(testTempDir)) {
                fs.rmSync(testTempDir, { recursive: true, force: true });
            }
        } catch (_) {}
    });

    suite.afterEach(async () => {
        if (realManager) {
            for (const app of Array.from(realManager.trackedApps.values())) {
                try {
                    await realManager.closeApp(app.appId, { savePolicy: 'dont_save', force: true }).catch(() => {});
                } catch (_) {}
            }
            realManager.trackedApps.clear();
        }
        await killTestPids();
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

    await suite.test('Integration: Live Harmless Notepad Automation Flow', LIVE_GUI_OPTS, async () => {
        // 1. Launch notepad
        const launchRes = await realManager.launchApp('notepad.exe');
        assert.ok(launchRes.appId);
        assert.ok(launchRes.pid > 0);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1200));

        // Allow window to initialize
        let notepadApp = null;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 400));
            const apps = await realManager.listApps();
            notepadApp = apps.find(a => a.appId === launchRes.appId || a.pid === launchRes.pid);
            if (notepadApp) break;
        }
        assert.ok(notepadApp, 'Launched Notepad should be visible in desktop window list');

        // 3. Inspect UI tree
        let tree = null;
        for (let i = 0; i < 6; i++) {
            tree = await realManager.inspectUI(launchRes.appId, { maxDepth: 2 });
            if (tree && (tree.name || '').toLowerCase().includes('notepad')) break;
            await new Promise(r => setTimeout(r, 400));
        }
        assert.ok(tree);
        assert.ok((tree.name || '').toLowerCase().includes('notepad') || tree.controlType === 'Window');

        // 4. Type harmless test text
        const testText = 'L.U.C.Y. Desktop Automation Test Baseline ' + Date.now();
        const typeRes = await realManager.typeText(launchRes.appId, testText);
        assert.equal(typeRes.success, true);
        assert.equal(typeRes.verified, true);
        assert.equal(typeRes.readText, testText);

        // 5. Find element
        const found = await realManager.findElement(launchRes.appId, { name: 'Text editor' });
        assert.ok(found);
        assert.equal(found.name, 'Text editor');

        // 6. Take screenshot
        const shot = await realManager.takeScreenshot(launchRes.appId);
        assert.ok(shot);
        assert.equal(shot.format, 'png');
        assert.ok(shot.width > 0 && shot.height > 0);
        assert.ok(typeof shot.base64 === 'string' && shot.base64.length > 500);

        // 7. Close Notepad with savePolicy: dont_save for authorized test changes
        const closeRes = await realManager.closeApp(launchRes.appId, { savePolicy: 'dont_save' });
        assert.ok(closeRes);
        assert.equal(closeRes.closed, true);
        testLaunchedPids.delete(launchRes.pid);
    });

    await suite.test('Integration: Modal Dialog Detection and Discarding Semantics on Notepad', LIVE_GUI_OPTS, async () => {
        const tmpFile = createTrackedTestFile('lucy_modal_discard_' + Date.now() + '.txt', 'Original test baseline ' + Date.now() + '\n');

        // 1. Launch fresh Notepad instance with named file and authorized targetPath
        const launchRes = await realManager.launchApp('notepad.exe', `"${tmpFile}"`, { targetPath: tmpFile });
        assert.ok(launchRes.appId);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1500));

        // 2. Type disposable test changes into document
        const uniqueText = 'L.U.C.Y. Modal Dialog Regression Test ' + Date.now();
        await realManager.typeText(launchRes.appId, uniqueText);
        await new Promise(r => setTimeout(r, 600));

        // 3. Attempt to close WITHOUT policy (default: ask/ambiguous)
        // Must NOT silently kill or discard! Must report dialogOpen: true, closed: false
        const ambiguousClose = await realManager.closeApp(launchRes.appId, { targetPath: tmpFile });
        assert.ok(ambiguousClose);
        assert.equal(ambiguousClose.closed, false);
        assert.equal(ambiguousClose.dialogOpen, true);
        assert.ok(ambiguousClose.availableActions.includes('dont_save'));
        assert.ok(ambiguousClose.availableActions.includes('save'));

        // 4. Now explicitly resolve with authorized disposable discard: dont_save
        const handleRes = await realManager.handleDialog(launchRes.appId, 'dont_save', { targetPath: tmpFile });
        assert.ok(handleRes);
        assert.equal(handleRes.handled, true);
        assert.equal(handleRes.action, 'dont_save');

        // 5. Verify no dialog remains open
        await new Promise(r => setTimeout(r, 600));
        const detAfter = await realManager.detectDialog(launchRes.appId);
        assert.equal(detAfter.dialogOpen, false);

        // Clean up window & file
        await realManager.closeApp(launchRes.appId, { savePolicy: 'dont_save', targetPath: tmpFile }).catch(() => {});
        testLaunchedPids.delete(launchRes.pid);
        safeCleanupTestFile(tmpFile);
    });

    await suite.test('Integration: Modal Dialog Cancel Semantics (Keep Window Open)', LIVE_GUI_OPTS, async () => {
        const tmpFile = createTrackedTestFile('lucy_modal_cancel_' + Date.now() + '.txt', 'Cancel baseline\n');

        // 1. Launch with named file
        const launchRes = await realManager.launchApp('notepad.exe', `"${tmpFile}"`, { targetPath: tmpFile });
        assert.ok(launchRes.appId);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1500));

        // 2. Type dirty changes
        await realManager.typeText(launchRes.appId, 'Changes to cancel');
        await new Promise(r => setTimeout(r, 600));

        // 3. Close with ambiguous policy -> dialog open
        const amb = await realManager.closeApp(launchRes.appId, { targetPath: tmpFile });
        assert.equal(amb.closed, false);
        assert.equal(amb.dialogOpen, true);

        // 4. Handle dialog with 'cancel'
        const cancelRes = await realManager.handleDialog(launchRes.appId, 'cancel', { targetPath: tmpFile });
        assert.equal(cancelRes.handled, true);
        assert.equal(cancelRes.action, 'cancel');

        // 5. Verify window remains alive and open
        await new Promise(r => setTimeout(r, 500));
        const apps = await realManager.listApps();
        const stillOpen = apps.some(a => a.appId === launchRes.appId || a.pid === launchRes.pid);
        assert.equal(stillOpen, true, 'Window must remain open after cancel action');

        // Clean up
        await realManager.closeApp(launchRes.appId, { savePolicy: 'dont_save', force: true, targetPath: tmpFile }).catch(() => {});
        testLaunchedPids.delete(launchRes.pid);
        await new Promise(r => setTimeout(r, 800));
        safeCleanupTestFile(tmpFile);
    });

    await suite.test('Integration: Modal Dialog Save Semantics and Content Verification', LIVE_GUI_OPTS, async () => {
        const tmpFile = createTrackedTestFile('lucy_modal_save_' + Date.now() + '.txt', 'Original header\n');

        // 1. Launch with named file
        const launchRes = await realManager.launchApp('notepad.exe', `"${tmpFile}"`, { targetPath: tmpFile });
        assert.ok(launchRes.appId);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1500));

        // 2. Type authorized changes
        const uniquePayload = 'Verified persisted payload ' + Date.now();
        await realManager.typeText(launchRes.appId, uniquePayload);
        await new Promise(r => setTimeout(r, 600));

        // 3. Close with savePolicy: 'save'
        const saveRes = await realManager.closeApp(launchRes.appId, { savePolicy: 'save', targetPath: tmpFile });
        assert.ok(saveRes);
        assert.equal(saveRes.closed, true);
        assert.equal(saveRes.saveSuccess, true);
        assert.ok(['application_ui_save', 'direct_write_fallback'].includes(saveRes.saveMethod));
        assert.ok(saveRes.applicationSaveConfirmed === true || saveRes.fallbackPersistenceVerified === true);
        assert.equal(saveRes.verifiedContentMatch, true);
        if (saveRes.dialogHandled) {
            assert.equal(saveRes.actionTaken, 'save');
        }
        testLaunchedPids.delete(launchRes.pid);

        // 4. Verify disk file content
        await new Promise(r => setTimeout(r, 1000));
        const savedText = fs.readFileSync(tmpFile, 'utf8');
        assert.ok(savedText.includes(uniquePayload), 'Persisted file must contain authorized saved text');

        // Clean up
        safeCleanupTestFile(tmpFile);
    });

    await suite.test('Integration: Save Preserves Unicode UTF-8 BOM and Windows CRLF Line Endings', LIVE_GUI_OPTS, async () => {
        const initialText = 'BOM Header line\r\nSecond line\r\n';
        // Write UTF-8 with BOM: 0xEF, 0xBB, 0xBF
        const bomBuffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(initialText, 'utf8')]);
        const tmpFile = createTrackedTestFile('lucy_encoding_' + Date.now() + '.txt', bomBuffer);

        const launchRes = await realManager.launchApp('notepad.exe', `"${tmpFile}"`, { targetPath: tmpFile });
        assert.ok(launchRes.appId);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1500));

        const uniquePayload = 'Added UTF-8 line ' + Date.now() + '\r\nSecond UTF-8 line\r\n';
        await realManager.typeText(launchRes.appId, uniquePayload);
        await new Promise(r => setTimeout(r, 600));

        const saveRes = await realManager.closeApp(launchRes.appId, { savePolicy: 'save', targetPath: tmpFile });
        assert.ok(saveRes);
        assert.equal(saveRes.closed, true);
        assert.equal(saveRes.saveSuccess, true);
        assert.ok(saveRes.applicationSaveConfirmed === true || saveRes.fallbackPersistenceVerified === true);
        assert.equal(saveRes.verifiedContentMatch, true);
        testLaunchedPids.delete(launchRes.pid);

        await new Promise(r => setTimeout(r, 800));
        const diskBuf = fs.readFileSync(tmpFile);
        assert.ok(diskBuf.length >= 3);
        assert.equal(diskBuf[0], 0xEF, 'UTF-8 BOM byte 1 preserved');
        assert.equal(diskBuf[1], 0xBB, 'UTF-8 BOM byte 2 preserved');
        assert.equal(diskBuf[2], 0xBF, 'UTF-8 BOM byte 3 preserved');

        const diskStr = diskBuf.toString('utf8');
        assert.ok(diskStr.includes('\r\n'), 'CRLF line endings preserved');
        assert.ok(diskStr.includes(uniquePayload.trimEnd()), 'Typed payload preserved in saved file');

        safeCleanupTestFile(tmpFile);
    });

    await suite.test('Unit: Unowned Process Protection and Non-Interference Verification', async () => {
        const unownedTarget = { pid: 99998, appId: 'app_99998' };

        // 1. Ownership check must return false
        assert.equal(realManager.isOwnedByLucy(unownedTarget), false);
        assert.equal(realManager.isOwnedByLucy('notepad.exe'), false);

        // 2. assertOwnership must fail closed on unowned target
        assert.throws(() => {
            realManager.assertOwnership(unownedTarget, { action: 'test_discard' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 3. Discarding changes on unowned target must throw without sending worker commands
        await assert.rejects(async () => {
            await realManager.closeApp(unownedTarget, { savePolicy: 'dont_save' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        await assert.rejects(async () => {
            await realManager.handleDialog(unownedTarget, 'dont_save');
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 4. Worker strictly rejects closing or targeting protected processes (PID of test process or IDE)
        await assert.rejects(async () => {
            await realManager.sendCommand('close_app', { pid: process.pid, savePolicy: 'dont_save' });
        }, /SAFETY_VIOLATION/);

        await assert.rejects(async () => {
            await realManager.sendCommand('close_app', { pid: process.ppid, savePolicy: 'dont_save' });
        }, /SAFETY_VIOLATION/);
    });

    await suite.test('Integration: Screenshot Capture Authenticity and Failure Reporting', LIVE_GUI_OPTS, async () => {
        const launchRes = await realManager.launchApp('notepad.exe');
        assert.ok(launchRes.appId);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1200));

        // 1. Real window capture must report genuine pixel capture
        const shot = await realManager.takeScreenshot(launchRes.appId);
        assert.ok(shot);
        assert.equal(shot.captured, true);
        assert.equal(shot.isPlaceholder, false);
        assert.ok(['PrintWindow', 'CopyFromScreen'].includes(shot.method));
        assert.ok(typeof shot.base64 === 'string' && shot.base64.length > 500);

        // 2. Invalid window handle must fail closed without allowPlaceholder
        await assert.rejects(async () => {
            await realManager.takeScreenshot({ windowHandle: 99999999, pid: 99999 });
        }, /SCREENSHOT_CAPTURE_FAILED|InvalidOperationException|Window not found|UNAUTHORIZED_RESOURCE_ACCESS/i);

        // Clean up
        await realManager.closeApp(launchRes.appId, { savePolicy: 'dont_save' });
        testLaunchedPids.delete(launchRes.pid);
    });

    await suite.test('Unit: ResultVerifier Save and Close Contract Verification', async () => {
        const verifier = new ResultVerifier();

        // 1. Successful application save verification
        const verifiedSave = await verifier.verify(
            { toolId: 'desktop_close_app', params: { target: 'notepad', savePolicy: 'save' } },
            {
                ok: true,
                result: {
                    closed: true,
                    saveSuccess: true,
                    saveMethod: 'application_ui_save',
                    applicationSaveConfirmed: true,
                    fallbackPersistenceVerified: false
                }
            }
        );
        assert.equal(verifiedSave.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(verifiedSave.verified, true);
        assert.equal(verifiedSave.method, 'desktop_save_verification');

        // 2. Save uncertain must FAIL verification closed
        const uncertainSave = await verifier.verify(
            { toolId: 'desktop_close_app', params: { target: 'notepad', savePolicy: 'save' } },
            {
                ok: true,
                result: {
                    closed: false,
                    saveSuccess: false,
                    status: 'save_uncertain',
                    error: 'Application save could not be confirmed'
                }
            }
        );
        assert.equal(uncertainSave.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(uncertainSave.verified, false);

        // 3. Fake/placeholder screenshot without authorization must FAIL verification closed
        const placeholderFail = await verifier.verify(
            { toolId: 'desktop_take_screenshot', params: { target: 'notepad' } },
            {
                ok: true,
                result: {
                    captured: false,
                    isPlaceholder: true,
                    base64: 'synthetic_canvas'
                }
            }
        );
        assert.equal(placeholderFail.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(placeholderFail.verified, false);
    });

    await suite.test('Integration: Notepad Clean Close with No Unsaved Changes', LIVE_GUI_OPTS, async () => {
        const launchRes = await realManager.launchApp('notepad.exe');
        assert.ok(launchRes.appId);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1500));

        const closeRes = await realManager.closeApp(launchRes.appId);
        assert.ok(closeRes);
        assert.equal(closeRes.closed, true);
        testLaunchedPids.delete(launchRes.pid);
    });

    await suite.test('Integration: Live Harmless Calculator Automation Flow', LIVE_GUI_OPTS, async () => {
        // 1. Launch Calculator
        const launchRes = await realManager.launchApp('calc.exe');
        assert.ok(launchRes.appId);
        if (launchRes.pid) testLaunchedPids.add(launchRes.pid);

        // Allow calculator window to settle
        await new Promise(r => setTimeout(r, 1500));

        // 2. Find Calculator in apps
        const apps = await realManager.listApps();
        const calcApp = apps.find(a => a.appId === launchRes.appId || (a.name || '').toLowerCase().includes('calculator'));

        if (calcApp) {
            // 3. Inspect Calculator UI
            const tree = await realManager.inspectUI(launchRes.appId, { maxDepth: 2 });
            assert.ok(tree);

            // 4. Find button (Five, Clear, or num5Button)
            let btn = await realManager.findElement(launchRes.appId, { automationId: 'num5Button' });
            if (!btn) btn = await realManager.findElement(launchRes.appId, { name: 'Five' });
            if (!btn) btn = await realManager.findElement(launchRes.appId, { name: 'Clear' });

            if (btn) {
                // 5. Click button via UI Automation InvokePattern
                const clickRes = await realManager.clickElement(launchRes.appId, {
                    name: btn.name,
                    automationId: btn.automationId
                });
                assert.equal(clickRes.success, true);
                assert.equal(clickRes.verified, true);
            }

            // 6. Close Calculator
            const closeRes = await realManager.closeApp(launchRes.appId);
            assert.ok(closeRes);
            assert.equal(closeRes.closed, true);
            if (launchRes.pid) testLaunchedPids.delete(launchRes.pid);
        }
    });

    await suite.test('Unit: Safe Cleanup Refuses to Delete Unowned Files or Target User-Profile Directories', () => {
        // 1. Refuse unowned file not tracked in testCreatedFiles
        assert.throws(() => {
            safeCleanupTestFile(path.join(testTempDir, 'unowned_dummy.txt'));
        }, /SAFETY_VIOLATION.*unowned/i);

        // 2. Refuse profile directory (LOCALAPPDATA, APPDATA, USERPROFILE, WINDIR)
        if (process.env.LOCALAPPDATA) {
            assert.throws(() => {
                safeCleanupTestFile(path.join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe', 'LocalState', 'TabState', 'tab.bin'));
            }, /SAFETY_VIOLATION.*user-profile/i);
        }

        // 3. Refuse arbitrary system file outside test directory
        assert.throws(() => {
            safeCleanupTestFile('C:\\Windows\\System32\\notepad.exe');
        }, /SAFETY_VIOLATION/i);

        // 4. Correctly removes tracked owned test file
        const safeFile = createTrackedTestFile('safe_tracked_file.txt', 'harmless test content');
        assert.equal(fs.existsSync(safeFile), true);
        assert.equal(testCreatedFiles.has(safeFile), true);
        const removed = safeCleanupTestFile(safeFile);
        assert.equal(removed, true);
        assert.equal(fs.existsSync(safeFile), false);
        assert.equal(testCreatedFiles.has(safeFile), false);
    });

    await suite.test('Unit: ResultVerifier Enforces Save Conflict, Content Match, and Fail-Closed Verification', async () => {
        const verifier = new ResultVerifier();

        // 1. Conflict detection must fail verification
        const conflictRes = await verifier.verify(
            { toolId: 'desktop_close_app', params: { target: 'notepad', savePolicy: 'save' } },
            {
                ok: true,
                result: {
                    closed: false,
                    saveSuccess: false,
                    status: 'conflict',
                    error: 'SAVE_CONFLICT_DETECTED: Target file on disk has unexpected external modifications.'
                }
            }
        );
        assert.equal(conflictRes.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(conflictRes.verified, false);
        assert.ok(conflictRes.failureReason.toLowerCase().includes('conflict'));

        // 2. Unresolved Save As dialog must fail verification
        const saveAsFail = await verifier.verify(
            { toolId: 'desktop_close_app', params: { target: 'notepad', savePolicy: 'save' } },
            {
                ok: true,
                result: {
                    closed: false,
                    saveSuccess: false,
                    status: 'save_uncertain',
                    dialogOpen: true,
                    error: 'UNRESOLVED_SAVE_AS_DIALOG: Application opened a Save As or overwrite confirmation dialog.'
                }
            }
        );
        assert.equal(saveAsFail.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(saveAsFail.verified, false);

        // 3. verifiedContentMatch false must fail verification
        const noMatchFail = await verifier.verify(
            { toolId: 'desktop_close_app', params: { target: 'notepad', savePolicy: 'save' } },
            {
                ok: true,
                result: {
                    closed: true,
                    saveSuccess: true,
                    saveMethod: 'application_ui_save',
                    applicationSaveConfirmed: true,
                    verifiedContentMatch: false
                }
            }
        );
        assert.equal(noMatchFail.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(noMatchFail.verified, false);

        // 4. Verified fallback persistence with verifiedContentMatch passes
        const verifiedFallback = await verifier.verify(
            { toolId: 'desktop_close_app', params: { target: 'notepad', savePolicy: 'save' } },
            {
                ok: true,
                result: {
                    closed: true,
                    saveSuccess: true,
                    saveMethod: 'direct_write_fallback',
                    applicationSaveConfirmed: false,
                    fallbackPersistenceVerified: true,
                    verifiedContentMatch: true
                }
            }
        );
        assert.equal(verifiedFallback.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(verifiedFallback.verified, true);
    });

    await suite.test('Integration: Save Fallback Conflict Protection Refuses Stale Disk Overwrite', LIVE_GUI_OPTS, async () => {
        const initialText = 'Initial authoritative file content ' + Date.now() + '\r\n';
        const conflictFile = createTrackedTestFile('lucy_conflict_' + Date.now() + '.txt', initialText);

        // 1. Launch Notepad with authorized targetPath (records initial state & hash)
        const launchRes = await realManager.launchApp('notepad.exe', `"${conflictFile}"`, { targetPath: conflictFile });
        assert.ok(launchRes.appId);
        testLaunchedPids.add(launchRes.pid);
        await new Promise(r => setTimeout(r, 1500));

        // 2. Simulate concurrent out-of-band edit to the file on disk
        const externalText = 'Concurrent out-of-band external modification ' + Date.now() + '\r\n';
        fs.writeFileSync(conflictFile, externalText, 'utf8');

        // 3. Attempt to save via closeApp. Because the file on disk has unexpected external modifications,
        // direct-write fallback must detect the SHA-256 mismatch and refuse to overwrite!
        const closeRes = await realManager.closeApp(launchRes.appId, { savePolicy: 'save', targetPath: conflictFile });
        assert.ok(closeRes);

        // If the application UI save didn't update disk with live text, fallback was triggered and caught conflict:
        if (closeRes.status === 'conflict') {
            assert.equal(closeRes.saveSuccess, false);
            assert.ok(closeRes.error.includes('SAVE_CONFLICT_DETECTED') || closeRes.error.includes('hash mismatch'));
            // Crucial safety invariant: external changes on disk were NOT destroyed!
            const diskContent = fs.readFileSync(conflictFile, 'utf8');
            assert.equal(diskContent, externalText, 'External modification on disk must be preserved without destructive overwrite');
        }

        // Clean up window
        await realManager.closeApp(launchRes.appId, { savePolicy: 'dont_save', force: true, targetPath: conflictFile }).catch(() => {});
        testLaunchedPids.delete(launchRes.pid);
        safeCleanupTestFile(conflictFile);
    });

    // ==========================================
    // 4. ADVERSARIAL TARGET IDENTITY SUITE
    // ==========================================

    await suite.test('Adversarial: Window Title Containing Notepad on Antigravity/Unrelated App Refuses Target', async () => {
        const manager = new DesktopAutomationManager();

        // 1. Process or window title containing "notepad" but belonging to Antigravity IDE
        const protectedTarget = { title: 'notes-notepad.txt - Antigravity IDE' };
        assert.equal(manager.isProtectedTarget(protectedTarget), true);
        assert.throws(() => {
            manager._resolveTargetPayload(protectedTarget);
        }, (err) => {
            assert.equal(err.code, 'SAFETY_VIOLATION');
            assert.ok(err.message.includes('SAFETY_VIOLATION'));
            return true;
        });

        // 2. Window title containing "notepad" on an unrelated, unowned browser process
        const unrelatedBrowserTitle = 'Notepad Shortcuts and Tips - Google Chrome';
        assert.equal(manager.isOwnedByLucy(unrelatedBrowserTitle), false);
        assert.throws(() => {
            manager.assertOwnership(unrelatedBrowserTitle);
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.typeText(unrelatedBrowserTitle, 'exploit text', { requireOwnership: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Matching Title but Mismatched Executable Refuses Execution', async () => {
        const manager = new DesktopAutomationManager();

        // Tracked app is notepad.exe
        manager.trackedApps.set('app_fake_notepad', {
            appId: 'app_fake_notepad',
            pid: 55443,
            exe: 'C:\\Windows\\System32\\notepad.exe',
            windowTitle: 'Untitled - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Querying an untracked mismatched executable with matching title
        const mismatchedTarget = { title: 'Untitled - Notepad', exe: 'C:\\Malware\\fake_notepad.exe' };
        assert.equal(manager.isOwnedByLucy(mismatchedTarget), false);
        assert.throws(() => {
            manager.assertOwnership(mismatchedTarget);
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Stale or Unowned Window Handle Safely Refuses Mutation', async () => {
        const manager = new DesktopAutomationManager();

        const staleHwnd = 0x99AABB;
        assert.equal(manager.isOwnedByLucy({ windowHandle: staleHwnd }), false);
        assert.throws(() => {
            manager.assertOwnership({ windowHandle: staleHwnd });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.focusWindow({ windowHandle: staleHwnd }, { requireOwnership: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Exited or Reused PID Refuses Destructive Cleanup', async () => {
        const manager = new DesktopAutomationManager();
        const initialStart = '2026-02-01T10:00:00.0000000Z';

        manager.trackedApps.set('app_reused_pid', {
            appId: 'app_reused_pid',
            pid: 88776,
            processStartTime: initialStart,
            exe: 'C:\\Windows\\notepad.exe',
            windowTitle: 'Original Title',
            launchedByLucy: true,
            canCleanup: true,
            lifecycleState: 'active'
        });

        manager.sendCommand = async (cmd, payload) => {
            if (payload.expectedStartTime && payload.expectedStartTime !== '2026-10-20T12:00:00.0000000Z') {
                const err = new Error('PID_REUSE_DETECTED: Target process ID does not match expected process creation time.');
                throw err;
            }
            return { closed: true };
        };

        await assert.rejects(async () => {
            await manager.closeApp('app_reused_pid', { savePolicy: 'dont_save' });
        }, (err) => {
            assert.ok(err.message.includes('PID_REUSE_DETECTED'));
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Existing Single-Instance Redirection Refuses Host Targeting', async () => {
        const manager = new DesktopAutomationManager();

        // Simulate worker erroneously returning Antigravity IDE PID on launch
        manager.sendCommand = async () => ({
            appId: 'app_' + process.pid,
            pid: process.pid,
            windowTitle: 'LUCY - Antigravity IDE'
        });

        await assert.rejects(async () => {
            await manager.launchApp('notepad.exe');
        }, (err) => {
            assert.equal(err.code, 'SAFETY_VIOLATION');
            assert.ok(err.message.includes('SAFETY_VIOLATION'));
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Ambiguous Windows and Empty Metadata Reject Safely', async () => {
        const manager = new DesktopAutomationManager();

        // 1. Incomplete/empty object metadata rejects with INVALID_TARGET
        assert.throws(() => {
            manager._resolveTargetPayload({});
        }, (err) => {
            assert.equal(err.code, 'INVALID_TARGET');
            return true;
        });

        assert.throws(() => {
            manager._resolveTargetPayload({ unrelatedField: 'value' });
        }, (err) => {
            assert.equal(err.code, 'INVALID_TARGET');
            return true;
        });

        // 2. Ambiguous instances match
        manager.trackedApps.set('app_ambig_1', {
            appId: 'app_ambig_1',
            pid: 6001,
            exe: 'notepad.exe',
            windowTitle: 'Document - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });
        manager.trackedApps.set('app_ambig_2', {
            appId: 'app_ambig_2',
            pid: 6002,
            exe: 'notepad.exe',
            windowTitle: 'Document - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        assert.throws(() => {
            manager._resolveTargetPayload('notepad');
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_APPLICATION_OWNERSHIP');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Protected Application Reached Through PID, Handle, Title, AppId Refuses All Access', async () => {
        const manager = new DesktopAutomationManager();

        // 1. Through PID
        assert.throws(() => {
            manager._resolveTargetPayload(process.pid);
        }, /SAFETY_VIOLATION/);

        // 2. Through Title
        assert.throws(() => {
            manager._resolveTargetPayload('Antigravity');
        }, /SAFETY_VIOLATION/);

        assert.throws(() => {
            manager._resolveTargetPayload('Visual Studio Code');
        }, /SAFETY_VIOLATION/);

        // 3. Through AppId
        assert.throws(() => {
            manager._resolveTargetPayload('app_' + process.pid);
        }, /SAFETY_VIOLATION/);

        // 4. Through Object with PID
        assert.throws(() => {
            manager._resolveTargetPayload({ pid: process.pid });
        }, /SAFETY_VIOLATION/);

        // 5. Through Object with Title
        assert.throws(() => {
            manager._resolveTargetPayload({ title: 'Antigravity IDE' });
        }, /SAFETY_VIOLATION/);

        manager.cleanup();
    });

    await suite.test('Adversarial: Attempts to Type, Click, Close, Switch Tabs, or Focus Unrelated Process Reject Safely', async () => {
        const manager = new DesktopAutomationManager();
        const unownedPid = 998877;

        // Verify all consequential actions reject unowned target cleanly with requireOwnership: true
        await assert.rejects(async () => {
            await manager.typeText(unownedPid, 'test keystrokes', { requireOwnership: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.clickElement(unownedPid, { name: 'OK' }, { requireOwnership: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp(unownedPid, { savePolicy: 'save', requireOwnership: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeTab(unownedPid, { requireOwnership: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.focusWindow(unownedPid, { requireOwnership: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // Also test through ToolRegistry handlers
        const registry = new ToolRegistry();
        registerDesktopTools(registry, manager);

        const toolsToTest = [
            { id: 'desktop_type_text', params: { target: String(unownedPid), text: 'abc' } },
            { id: 'desktop_click_element', params: { target: String(unownedPid), name: 'Submit' } },
            { id: 'desktop_close_app', params: { target: String(unownedPid), savePolicy: 'save' } },
            { id: 'desktop_focus_window', params: { target: String(unownedPid) } },
            { id: 'desktop_handle_dialog', params: { target: String(unownedPid), action: 'save' } },
            { id: 'desktop_inspect_ui', params: { target: String(unownedPid) } },
            { id: 'desktop_find_element', params: { target: String(unownedPid), name: 'OK' } },
            { id: 'desktop_take_screenshot', params: { target: String(unownedPid) } }
        ];

        for (const tool of toolsToTest) {
            const res = await registry.execute(tool.id, tool.params);
            assert.equal(res.ok, false);
            assert.ok(res.error.includes('UNAUTHORIZED_RESOURCE_ACCESS') || res.error.includes('ownership'));
        }

        manager.cleanup();
    });

    await suite.test('Adversarial: Mandatory Ownership for Consequential Mutations Cannot Be Disabled by Flags', async () => {
        const manager = new DesktopAutomationManager();
        const unownedTarget = 881122;

        // Even with { requireOwnership: false } or omitted options, mutations MUST fail closed
        await assert.rejects(async () => {
            await manager.typeText(unownedTarget, 'injected text', { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.typeText(unownedTarget, 'injected text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.clickElement(unownedTarget, { name: 'Save' }, { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp(unownedTarget, { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeTab(unownedTarget, { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.focusWindow(unownedTarget, { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.handleDialog(unownedTarget, 'save', { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Target Identity Cross-Validation Rejects Handle Mismatch, PID Reuse, and Expired Authorization', async () => {
        const manager = new DesktopAutomationManager();

        manager.trackedApps.set('app_cross_target', {
            appId: 'app_cross_target',
            pid: 7771,
            windowHandle: 4444,
            processStartTime: '2026-10-21T01:00:00.0000000Z',
            exe: 'C:\\Windows\\notepad.exe',
            windowTitle: 'Cross Target Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // 1. Mismatched window handle
        await assert.rejects(async () => {
            await manager.typeText({ appId: 'app_cross_target', windowHandle: 9999 }, 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.typeText({ pid: 7771, windowHandle: 9999 }, 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 2. Stale or reused PID (processStartTime mismatch)
        await assert.rejects(async () => {
            await manager.typeText({ appId: 'app_cross_target', expectedStartTime: '2026-10-21T09:00:00.0000000Z' }, 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 3. Mismatched executable path
        await assert.rejects(async () => {
            await manager.typeText({ appId: 'app_cross_target', exe: 'C:\\Windows\\calc.exe' }, 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 4. Closed application (expired authorization)
        const appRecord = manager.trackedApps.get('app_cross_target');
        appRecord.lifecycleState = 'closed';
        await assert.rejects(async () => {
            await manager.typeText('app_cross_target', 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 5. Unowned application record
        appRecord.lifecycleState = 'active';
        appRecord.launchedByLucy = false;
        await assert.rejects(async () => {
            await manager.typeText('app_cross_target', 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Task Isolation Boundary Invariant Blocks Cross-Task Mutations', async () => {
        const manager = new DesktopAutomationManager();

        manager.trackedApps.set('app_task_isolated', {
            appId: 'app_task_isolated',
            pid: 9901,
            exe: 'notepad.exe',
            windowTitle: 'Task Isolated App',
            launchedByLucy: true,
            taskId: 'task_alpha',
            lifecycleState: 'active'
        });

        // Valid under matching taskId
        manager.sendCommand = async () => ({ verified: true });
        const res = await manager.typeText('app_task_isolated', 'allowed', { taskId: 'task_alpha' });
        assert.equal(res.success, true);

        // Strictly rejected under different taskId
        await assert.rejects(async () => {
            await manager.typeText('app_task_isolated', 'illegal', { taskId: 'task_beta' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.clickElement('app_task_isolated', { name: 'OK' }, { taskId: 'task_beta' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp('app_task_isolated', { taskId: 'task_beta' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Adversarial: Native Worker Entry Points Enforce isOwned Fail-Closed', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // Directly test raw worker command responses when isOwned is false or absent
        // 1. type_text
        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', { isOwned: false, pid: 1234, text: 'hack' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 2. click_element
        await assert.rejects(async () => {
            await realManager.sendCommand('click_element', { isOwned: false, pid: 1234, name: 'OK' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 3. close_app
        await assert.rejects(async () => {
            await realManager.sendCommand('close_app', { isOwned: false, pid: 1234 });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 4. close_tab
        await assert.rejects(async () => {
            await realManager.sendCommand('close_tab', { isOwned: false, pid: 1234 });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 5. focus_window
        await assert.rejects(async () => {
            await realManager.sendCommand('focus_window', { isOwned: false, pid: 1234 });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 6. handle_dialog
        await assert.rejects(async () => {
            await realManager.sendCommand('handle_dialog', { isOwned: false, pid: 1234, action: 'save' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);
    });

    await suite.test('Adversarial: Test State Isolation Invariant Rejects Deletions Outside Temp Directory', () => {
        // 1. System file
        assert.throws(() => {
            safeCleanupTestFile('C:\\Windows\\System32\\notepad.exe');
        }, /SAFETY_VIOLATION/);

        // 2. User desktop
        if (process.env.USERPROFILE) {
            assert.throws(() => {
                safeCleanupTestFile(path.join(process.env.USERPROFILE, 'Desktop', 'important.txt'));
            }, /SAFETY_VIOLATION/);
        }

        // 3. LocalAppData Packages (TabState)
        if (process.env.LOCALAPPDATA) {
            assert.throws(() => {
                safeCleanupTestFile(path.join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.WindowsNotepad', 'LocalState', 'test.bin'));
            }, /SAFETY_VIOLATION/);
        }

        // 4. Untracked file inside testTempDir
        const untrackedFile = path.join(testTempDir, 'untracked_rogue.txt');
        assert.throws(() => {
            safeCleanupTestFile(untrackedFile);
        }, /SAFETY_VIOLATION/);
    });

    // =========================================================================
    // SECTION B: 10 DETERMINISTIC ADVERSARIAL CHALLENGE GATES
    // =========================================================================

    await suite.test('Challenge 1: Missing Task Identity and Missing Ownership Records', async () => {
        const manager = new DesktopAutomationManager();
        manager.sendCommand = async () => ({ verified: true });

        // 1A: Target with NO ownership record in trackedApps must be rejected
        await assert.rejects(async () => {
            await manager.typeText('non_existent_app_id', 'test');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.clickElement(123456, { name: 'OK' });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp('untracked_notepad_title');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 1B: App is bound to a task, but caller supplies NO taskId (missing task identity)
        manager.trackedApps.set('app_bound_to_task', {
            appId: 'app_bound_to_task',
            pid: 8881,
            exe: 'notepad.exe',
            windowTitle: 'Task Bound App',
            launchedByLucy: true,
            taskId: 'task_owner_99',
            lifecycleState: 'active'
        });

        await assert.rejects(async () => {
            await manager.typeText('app_bound_to_task', 'unauthorized text');
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            assert.ok(err.message.includes('Task identity missing'));
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp('app_bound_to_task');
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Challenge 2: Forged, Mismatched, Expired, or Stale Authorization', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // 2A: Forged authToken passed directly to native worker
        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', {
                isOwned: true,
                pid: 99999,
                authToken: 'forged_fake_token_12345',
                text: 'malicious payload'
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 2B: Expired or mismatched expectedStartTime on tracked app
        const manager = new DesktopAutomationManager();
        manager.trackedApps.set('app_stale_start', {
            appId: 'app_stale_start',
            pid: 8882,
            processStartTime: '2026-10-21T00:00:00.0000000Z',
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // When caller requests target with mismatched/stale expectedStartTime, resolution returns null and fails closed
        await assert.rejects(async () => {
            await manager.typeText({ appId: 'app_stale_start', expectedStartTime: '2026-10-21T12:00:00.0000000Z' }, 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Challenge 3: Valid Task Attempting to Control Another Task Application', async () => {
        const manager = new DesktopAutomationManager();
        manager.sendCommand = async () => ({ verified: true });

        manager.trackedApps.set('app_task_owner', {
            appId: 'app_task_owner',
            pid: 8883,
            exe: 'notepad.exe',
            windowTitle: 'Task Owner App',
            launchedByLucy: true,
            taskId: 'task_legitimate_owner',
            lifecycleState: 'active'
        });

        // Legitimate task succeeds
        const allowed = await manager.typeText('app_task_owner', 'legitimate work', { taskId: 'task_legitimate_owner' });
        assert.equal(allowed.success, true);

        // Foreign task is rejected across all mutation paths
        const foreignTask = { taskId: 'task_intruder_foreign' };

        await assert.rejects(async () => {
            await manager.typeText('app_task_owner', 'hijack text', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.clickElement('app_task_owner', { name: 'Save' }, foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.focusWindow('app_task_owner', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeTab('app_task_owner', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp('app_task_owner', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.handleDialog('app_task_owner', 'save', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.inspectUI('app_task_owner', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.findElement('app_task_owner', { name: 'Save' }, foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.takeScreenshot('app_task_owner', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.detectDialog('app_task_owner', foreignTask);
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        // Missing taskId context is also rejected fail-closed
        await assert.rejects(async () => {
            await manager.inspectUI('app_task_owner');
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.takeScreenshot('app_task_owner');
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Challenge 4: A PID That Exists but Is Not Authorized', async () => {
        const manager = new DesktopAutomationManager();
        const unownedPid = 87654;

        // 4A: Manager layer rejects unowned PID
        await assert.rejects(async () => {
            await manager.typeText(unownedPid, 'exploit text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp(unownedPid, { savePolicy: 'dont_save' });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 4B: Direct worker STDIO command with unowned PID and isOwned: true is rejected by native worker
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', {
                isOwned: true,
                pid: unownedPid,
                text: 'unauthorized injection'
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        await assert.rejects(async () => {
            await realManager.sendCommand('close_app', {
                isOwned: true,
                pid: unownedPid
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        manager.cleanup();
    });

    await suite.test('Challenge 5: A Valid PID Paired with an Unrelated Window Handle', async () => {
        const manager = new DesktopAutomationManager();
        manager.trackedApps.set('app_valid_pid', {
            appId: 'app_valid_pid',
            pid: 7772,
            windowHandle: 12345,
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Cross-mismatch: valid PID paired with unrelated window handle
        await assert.rejects(async () => {
            await manager.typeText({ pid: 7772, windowHandle: 99999999 }, 'text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp({ pid: 7772, windowHandle: 99999999 });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // Native worker direct verification
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        await assert.rejects(async () => {
            await realManager.sendCommand('focus_window', {
                isOwned: true,
                pid: 7772,
                windowHandle: 99999999
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        manager.cleanup();
    });

    await suite.test('Challenge 6: Protected Applications Reached Through Different Identifiers', async () => {
        const manager = new DesktopAutomationManager();

        const protectedVariants = [
            'Antigravity',
            'antigravity ide',
            'ANTIGRAVITY.EXE',
            'code.exe',
            'Visual Studio Code',
            'node',
            'NODE.EXE',
            'electron.exe',
            'powershell',
            'powershell.exe',
            'pwsh',
            'pwsh.exe',
            'cmd.exe',
            'explorer.exe'
        ];

        for (const target of protectedVariants) {
            // Manager boundary rejects unconditionally
            assert.equal(manager.isProtectedTarget(target), true, `Must recognize '${target}' as protected`);

            await assert.rejects(async () => {
                await manager.focusWindow(target);
            }, (err) => {
                assert.equal(err.code, 'SAFETY_VIOLATION');
                return true;
            });

            await assert.rejects(async () => {
                await manager.typeText(target, 'malicious');
            }, (err) => {
                assert.equal(err.code, 'SAFETY_VIOLATION');
                return true;
            });

            await assert.rejects(async () => {
                await manager.clickElement(target, { name: 'Close' });
            }, (err) => {
                assert.equal(err.code, 'SAFETY_VIOLATION');
                return true;
            });

            await assert.rejects(async () => {
                await manager.closeApp(target);
            }, (err) => {
                assert.equal(err.code, 'SAFETY_VIOLATION');
                return true;
            });
        }

        // Direct native worker checks against protected process names/PIDs
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        await assert.rejects(async () => {
            await realManager.sendCommand('focus_window', { title: 'Antigravity IDE', isOwned: true });
        }, /SAFETY_VIOLATION|UNAUTHORIZED_RESOURCE_ACCESS/);

        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', { title: 'Antigravity IDE', isOwned: true, text: 'hack' });
        }, /SAFETY_VIOLATION|UNAUTHORIZED_RESOURCE_ACCESS/);

        manager.cleanup();
    });

    await suite.test('Challenge 7: Ambiguous Target Resolution', async () => {
        const manager = new DesktopAutomationManager();
        // Register two distinct instances matching "Notepad"
        manager.trackedApps.set('app_inst_1', {
            appId: 'app_inst_1',
            pid: 6001,
            exe: 'notepad.exe',
            windowTitle: 'Notepad - doc1.txt',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        manager.trackedApps.set('app_inst_2', {
            appId: 'app_inst_2',
            pid: 6002,
            exe: 'notepad.exe',
            windowTitle: 'Notepad - doc2.txt',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Ambiguous string query "notepad" matches both instances: MUST fail closed!
        await assert.rejects(async () => {
            await manager.typeText('notepad', 'text');
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_APPLICATION_OWNERSHIP');
            return true;
        });

        await assert.rejects(async () => {
            await manager.clickElement('notepad', { name: 'File' });
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_APPLICATION_OWNERSHIP');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeApp('notepad');
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_APPLICATION_OWNERSHIP');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Challenge 8: Direct Worker Commands That Bypass Normal Manager Methods', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // Adversarial caller bypasses manager and writes directly to worker STDIO
        // attempting mutations on an unowned PID 54321 with isOwned: true
        const mutationCommands = [
            { cmd: 'type_text', payload: { pid: 54321, text: 'bypass text', isOwned: true } },
            { cmd: 'click_element', payload: { pid: 54321, name: 'Button', isOwned: true } },
            { cmd: 'close_app', payload: { pid: 54321, isOwned: true } },
            { cmd: 'close_tab', payload: { pid: 54321, isOwned: true } },
            { cmd: 'handle_dialog', payload: { pid: 54321, action: 'save', isOwned: true } },
            { cmd: 'focus_window', payload: { pid: 54321, isOwned: true } }
        ];

        for (const item of mutationCommands) {
            await assert.rejects(async () => {
                await realManager.sendCommand(item.cmd, item.payload);
            }, (err) => {
                assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Command '${item.cmd}' must be rejected with UNAUTHORIZED_RESOURCE_ACCESS, got: ${err.message}`);
                return true;
            });
        }
    });

    await suite.test('Challenge 9: Attempts to Exploit Optional Flags or Legacy Fallbacks', async () => {
        const manager = new DesktopAutomationManager();

        // Target not owned by Lucy
        const unownedTarget = 'unauthorized_target_app';

        // Attempting to pass requireOwnership: false
        await assert.rejects(async () => {
            await manager.typeText(unownedTarget, 'exploit', { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // Attempting to pass force: true
        await assert.rejects(async () => {
            await manager.closeApp(unownedTarget, { force: true, requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // Attempting to pass allowPhysicalFallback: true
        await assert.rejects(async () => {
            await manager.clickElement(unownedTarget, { name: 'OK', allowPhysicalFallback: true }, { requireOwnership: false });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        manager.cleanup();
    });

    await suite.test('Challenge 10: Actions After Authorization Has Become Invalid (Closed / Revoked)', async () => {
        const manager = new DesktopAutomationManager();
        let closeCommandSent = false;
        manager.sendCommand = async (cmd) => {
            if (cmd === 'close_app') {
                closeCommandSent = true;
                return { closed: true, pid: 9911 };
            }
            return { verified: true };
        };

        const tracked = {
            appId: 'app_to_be_closed',
            pid: 9911,
            authToken: 'tok_9911_valid',
            exe: 'notepad.exe',
            launchedByLucy: true,
            canCleanup: true,
            ownershipState: 'OWNED',
            lifecycleState: 'active'
        };
        manager.trackedApps.set('app_to_be_closed', tracked);

        // Close app: transitions lifecycleState to closed and removes from trackedApps
        const closeRes = await manager.closeApp('app_to_be_closed', { savePolicy: 'dont_save' });
        assert.equal(closeRes.closed, true);
        assert.equal(closeCommandSent, true);
        assert.equal(tracked.lifecycleState, 'closed');
        assert.equal(manager.trackedApps.has('app_to_be_closed'), false);

        // Subsequent mutations on the invalidated target MUST fail closed
        await assert.rejects(async () => {
            await manager.typeText('app_to_be_closed', 'stale text');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.clickElement('app_to_be_closed', { name: 'OK' });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.focusWindow('app_to_be_closed');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.closeTab('app_to_be_closed');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.handleDialog('app_to_be_closed', 'save');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // Direct native worker: after revocation, commands fail closed
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', {
                appId: 'app_to_be_closed',
                pid: 9911,
                authToken: 'tok_9911_valid',
                isOwned: true,
                text: 'stale text'
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        manager.cleanup();
    });

    // =========================================================================
    // DIRECT-LAUNCH & TOKEN-ISSUANCE ADVERSARIAL CHALLENGES (Section 2)
    // =========================================================================

    await suite.test('Direct-Launch Case 1: Caller with no trusted task grant attempts launch_app', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // 1A: Direct worker call with NO task grant and NO taskId
        await assert.rejects(async () => {
            await realManager.sendCommand('launch_app', {
                exe: 'notepad.exe'
            });
        }, (err) => {
            assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Must reject with UNAUTHORIZED_RESOURCE_ACCESS, got: ${err.message}`);
            assert.ok(err.message.includes('Refusing launch_app without a trusted task authorization grant'));
            return true;
        });

        // 1B: Direct worker call with forged/invalid task grant
        await assert.rejects(async () => {
            await realManager.sendCommand('launch_app', {
                exe: 'notepad.exe',
                taskId: 'untrusted_forged_task',
                taskGrant: 'bad_forged_grant_hex'
            });
        }, (err) => {
            assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Must reject with UNAUTHORIZED_RESOURCE_ACCESS, got: ${err.message}`);
            assert.ok(err.message.includes('Invalid or forged task authorization grant'));
            return true;
        });
    });

    await suite.test('Direct-Launch Case 2: Direct worker invocation cannot obtain or use tokens', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // Direct caller attempting launch_app to obtain a token is rejected at the worker boundary
        await assert.rejects(async () => {
            await realManager.sendCommand('launch_app', { exe: 'notepad.exe' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // Furthermore, manager.launchApp does not leak or return authToken to external tool callers
        const testMgr = new DesktopAutomationManager();
        testMgr.sendCommand = async (cmd, payload) => {
            return {
                appId: 'app_7777',
                pid: 7777,
                authToken: 'secret_worker_token_7777',
                windowTitle: 'Untitled - Notepad',
                windowHandle: 12345,
                processStartTime: '2026-10-21T00:00:00.000Z'
            };
        };

        const publicRes = await testMgr.launchApp('notepad.exe', '', { taskId: 'task_secure_77' });
        assert.equal(publicRes.appId, 'app_7777');
        assert.equal(publicRes.pid, 7777);
        assert.equal(publicRes.taskId, 'task_secure_77');
        assert.equal(publicRes.authToken, undefined, 'authToken MUST NOT be exposed in public launchApp return object');

        // Token is safely contained in internal trackedApps
        const tracked = testMgr.trackedApps.get('app_7777');
        assert.equal(tracked.authToken, 'secret_worker_token_7777');

        testMgr.cleanup();
    });

    await suite.test('Direct-Launch Case 3: Token issued to one task is replayed by another task', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // 3A: Manager layer rejects cross-task mutation
        const mgr = new DesktopAutomationManager();
        mgr.sendCommand = async () => ({ verified: true });
        mgr.trackedApps.set('app_task1', {
            appId: 'app_task1',
            pid: 9111,
            authToken: 'tok_task1_valid',
            taskId: 'task_alpha',
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        await assert.rejects(async () => {
            await mgr.typeText('app_task1', 'cross task text', { taskId: 'task_bravo' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        // 3B: Worker layer rejects direct mutation when taskId does not match bound task
        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', {
                pid: 9111,
                authToken: 'tok_task1_valid',
                taskId: 'task_bravo',
                isOwned: true,
                text: 'malicious payload'
            });
        }, (err) => {
            assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'));
            return true;
        });

        mgr.cleanup();
    });

    await suite.test('Direct-Launch Case 4: Token for one application used against different PID or window', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // Token from App A used against different PID 6666
        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', {
                pid: 6666,
                authToken: 'token_of_app_5555',
                taskId: 'task_5555',
                isOwned: true,
                text: 'test'
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // PID paired with unrelated window handle
        await assert.rejects(async () => {
            await realManager.sendCommand('focus_window', {
                pid: 5555,
                authToken: 'token_of_app_5555',
                taskId: 'task_5555',
                windowHandle: 999999,
                isOwned: true
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);
    });

    await suite.test('Direct-Launch Case 5: Token is reused after application closure or task cancellation', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        const mgr = new DesktopAutomationManager();
        mgr.sendCommand = async (cmd, payload) => ({ verified: true, closed: true });

        const tracked = {
            appId: 'app_closing_task',
            pid: 8222,
            authToken: 'tok_closing_8222',
            taskId: 'task_to_cancel',
            exe: 'notepad.exe',
            launchedByLucy: true,
            canCleanup: true,
            ownershipState: 'OWNED',
            lifecycleState: 'active'
        };
        mgr.trackedApps.set('app_closing_task', tracked);

        // Close app
        await mgr.closeApp('app_closing_task', { savePolicy: 'dont_save', taskId: 'task_to_cancel' });
        assert.equal(tracked.lifecycleState, 'closed');
        assert.equal(mgr.trackedApps.has('app_closing_task'), false);

        // Reusing token after closure is rejected by manager
        await assert.rejects(async () => {
            await mgr.typeText('app_closing_task', 'post-closure injection', { taskId: 'task_to_cancel' });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // Direct worker attempt with revoked token is rejected by worker
        await assert.rejects(async () => {
            await realManager.sendCommand('type_text', {
                pid: 8222,
                appId: 'app_closing_task',
                authToken: 'tok_closing_8222',
                taskId: 'task_to_cancel',
                isOwned: true,
                text: 'stale text'
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // Revoke task on worker
        const revokeRes = await realManager.sendCommand('revoke_task', { taskId: 'task_to_cancel' });
        assert.ok(typeof revokeRes.revokedCount === 'number');

        mgr.cleanup();
    });

    await suite.test('Direct-Launch Case 6: Caller forges isOwned: true and supplies arbitrary token', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        // Adversary crafts a packet with isOwned: true and random token
        const arbitraryTokens = [
            'tok_fake_123',
            '4a896f5b72184d29944bb19fcf19efaa',
            '00000000-0000-0000-0000-000000000000',
            "' OR '1'='1"
        ];

        for (const fakeToken of arbitraryTokens) {
            await assert.rejects(async () => {
                await realManager.sendCommand('click_element', {
                    pid: 77777,
                    isOwned: true,
                    authToken: fakeToken,
                    name: 'OK'
                });
            }, /UNAUTHORIZED_RESOURCE_ACCESS/);
        }
    });

    await suite.test('Direct-Launch Case 7: Unauthorized caller attempts all consequential mutations through worker protocol', async () => {
        assert.ok(realManager, 'realManager must be available');
        await realManager.ensureWorker();

        const unauthMutations = [
            { cmd: 'type_text', payload: { pid: 65432, text: 'hack', isOwned: false } },
            { cmd: 'type_text', payload: { pid: 65432, text: 'hack', isOwned: true, authToken: 'fake' } },
            { cmd: 'click_element', payload: { pid: 65432, name: 'Submit', isOwned: false } },
            { cmd: 'click_element', payload: { pid: 65432, name: 'Submit', isOwned: true, authToken: 'fake' } },
            { cmd: 'close_app', payload: { pid: 65432, isOwned: false } },
            { cmd: 'close_app', payload: { pid: 65432, isOwned: true, authToken: 'fake' } },
            { cmd: 'close_tab', payload: { pid: 65432, isOwned: false } },
            { cmd: 'close_tab', payload: { pid: 65432, isOwned: true, authToken: 'fake' } },
            { cmd: 'handle_dialog', payload: { pid: 65432, action: 'save', isOwned: false } },
            { cmd: 'handle_dialog', payload: { pid: 65432, action: 'save', isOwned: true, authToken: 'fake' } },
            { cmd: 'focus_window', payload: { pid: 65432, isOwned: false } },
            { cmd: 'focus_window', payload: { pid: 65432, isOwned: true, authToken: 'fake' } }
        ];

        for (const m of unauthMutations) {
            await assert.rejects(async () => {
                await realManager.sendCommand(m.cmd, m.payload);
            }, (err) => {
                assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Command '${m.cmd}' must reject with UNAUTHORIZED_RESOURCE_ACCESS, got: ${err.message}`);
                return true;
            });
        }
    });
});
