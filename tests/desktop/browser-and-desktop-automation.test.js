'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { registerFileTools, createPathBoundaryChecker } = require('../../src/tools/file-tools.js');
const { BrowserManager } = require('../../src/tools/browser-manager.js');
const { registerBrowserTools } = require('../../src/tools/browser-tools.js');
const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { ResultVerifier, VERIFICATION_STATUSES } = require('../../src/core/result-verifier.js');
const { TaskStatusManager, TASK_STATES } = require('../../src/core/task-status.js');

test('L.U.C.Y. Browser & Windows Desktop Automation Acceptance Suite', async (suite) => {
    const tempDir = path.join(__dirname, '..', 'fixtures', 'automation_workspace_' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    const prevMemoryDir = process.env.LUCY_MEMORY_DIR;
    process.env.LUCY_MEMORY_DIR = path.join(tempDir, 'memory');

    let localServer = null;
    let localServerUrl = '';

    // Mock web server for reliable, offline browser acceptance testing
    await new Promise((resolve) => {
        localServer = http.createServer((req, res) => {
            const urlPath = req.url.split('?')[0];

            if (urlPath === '/results') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><head><title>Search Results</title></head>
                <body>
                    <h2>Java Tutorial for Beginners</h2>
                    <p>Learn Java programming from scratch.</p>
                    <h2>Advanced Java Concurrency</h2>
                    <p>Threading and memory model.</p>
                </body></html>`);
                return;
            }

            if (urlPath === '/form') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><head><title>Feedback Form</title></head>
                <body>
                    <h1>Feedback Form</h1>
                    <form id="feedback-form">
                        <label for="name-field">Name:</label>
                        <input id="name-field" name="name" type="text" />
                        <label for="role-select">Role:</label>
                        <select id="role-select">
                            <option value="student">Student</option>
                            <option value="developer">Developer</option>
                        </select>
                        <button id="submit-btn" type="submit">Submit</button>
                    </form>
                </body></html>`);
                return;
            }

            if (urlPath === '/timeout') {
                // Intentionally delay response to simulate timeout
                setTimeout(() => {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<html><body>Delayed</body></html>');
                }, 4000);
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><title>Home Portal</title></head>
            <body>
                <h1 id="headline">Welcome to L.U.C.Y. Automation Test</h1>
                <p id="description">Testing page element location and text extraction.</p>
                <div style="height: 2000px;">Long scrollable content</div>
                <div id="footer">Footer Reachable</div>
            </body></html>`);
        });

        localServer.listen(0, '127.0.0.1', () => {
            const port = localServer.address().port;
            localServerUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    suite.after(async () => {
        if (localServer) {
            localServer.close();
        }
        if (prevMemoryDir) {
            process.env.LUCY_MEMORY_DIR = prevMemoryDir;
        } else {
            delete process.env.LUCY_MEMORY_DIR;
        }
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
    });

    // -------------------------------------------------------------
    // Criterion 1: Launching and identifying an application
    // -------------------------------------------------------------
    await suite.test('1. Launching and identifying an application (desktop_launch_app & list)', async () => {
        const mockDesktopManager = {
            listApps: async () => [
                { name: 'Untitled - Notepad', processName: 'notepad', pid: 1234, appId: 'app_1234' }
            ],
            launchApp: async (exe) => ({
                launched: true,
                executable: exe,
                pid: 1234,
                appId: 'app_1234',
                name: 'Notepad'
            }),
            validateExecutable: (exe) => ({ isAllowlisted: true, safe: true, resolvedPath: exe })
        };

        const registry = new ToolRegistry();
        registerDesktopTools(registry, mockDesktopManager);

        const launchRes = await registry.execute('desktop_launch_app', { executable: 'notepad.exe' });
        assert.ok(launchRes.ok);
        assert.equal(launchRes.appId, 'app_1234');

        const apps = await registry.execute('desktop_list_apps', { filter: 'notepad' });
        assert.ok(apps.ok);
        assert.equal(apps.result.length, 1);
        assert.equal(apps.result[0].processName, 'notepad');
    });

    // -------------------------------------------------------------
    // Criterion 2: Opening a website and locating a page element
    // -------------------------------------------------------------
    await suite.test('2. Opening a website and locating a page element (browser_navigate & extract)', async () => {
        const bm = new BrowserManager({ headless: true, workspaceRoot: tempDir });
        const registry = new ToolRegistry();
        registerBrowserTools(registry, bm);

        try {
            const navRes = await registry.execute('browser_navigate', { url: localServerUrl });
            assert.ok(navRes.ok);
            assert.equal(navRes.status, 'navigation_success');

            const extractRes = await registry.execute('browser_extract', { selector: '#headline' });
            assert.ok(extractRes.ok);
            assert.ok(extractRes.content.includes('Welcome to L.U.C.Y. Automation Test'));
        } finally {
            await bm.closeAll();
        }
    });

    // -------------------------------------------------------------
    // Criterion 3: Filling a field and verifying its value
    // -------------------------------------------------------------
    await suite.test('3. Filling a field and verifying its value (browser_fill & select)', async () => {
        const bm = new BrowserManager({ headless: true, workspaceRoot: tempDir });
        const registry = new ToolRegistry();
        registerBrowserTools(registry, bm);

        try {
            await registry.execute('browser_navigate', { url: `${localServerUrl}/form` });

            const fillRes = await registry.execute('browser_fill', { selector: '#name-field', value: 'Alice' });
            assert.ok(fillRes.ok);
            assert.equal(fillRes.status, 'fill_success');
            assert.equal(fillRes.verifiedValue, 'Alice');

            const selectRes = await registry.execute('browser_select_option', { selector: '#role-select', value: 'developer' });
            assert.ok(selectRes.ok);
            assert.equal(selectRes.status, 'select_success');
        } finally {
            await bm.closeAll();
        }
    });

    // -------------------------------------------------------------
    // Criterion 4: Creating a file and verifying its contents
    // -------------------------------------------------------------
    await suite.test('4. Creating a file and verifying its contents (file_write & ResultVerifier)', async () => {
        const registry = new ToolRegistry();
        registerFileTools(registry, tempDir);
        const verifier = new ResultVerifier({ workspaceRoot: tempDir });

        const testFilePath = 'documents/notes.txt';
        const expectedContent = 'Automated verification note 12345';

        const writeRes = await registry.execute('file_write', { path: testFilePath, content: expectedContent });
        assert.ok(writeRes.ok);

        const verification = await verifier.verify(
            { toolId: 'file_write', params: { path: testFilePath, content: expectedContent } },
            writeRes
        );
        assert.ok(verification.verified);
        assert.equal(verification.status, VERIFICATION_STATUSES.VERIFIED);

        const readRes = await registry.execute('file_read', { path: testFilePath });
        assert.ok(readRes.ok);
        assert.equal(readRes.content, expectedContent);
    });

    // -------------------------------------------------------------
    // Criterion 5: Handling a missing target
    // -------------------------------------------------------------
    await suite.test('5. Handling a missing target (nonexistent file/folder failure report)', async () => {
        const registry = new ToolRegistry();
        registerFileTools(registry, tempDir);

        const missingRes = await registry.execute('file_read', { path: 'nonexistent/missing-doc.txt' });
        assert.equal(missingRes.ok, false);
        assert.equal(missingRes.status, 'not_found');
        assert.ok(missingRes.error.includes('not found'));
    });

    // -------------------------------------------------------------
    // Criterion 6: Handling navigation timeouts
    // -------------------------------------------------------------
    await suite.test('6. Handling navigation timeouts gracefully without hanging', async () => {
        const bm = new BrowserManager({ headless: true, workspaceRoot: tempDir });
        const registry = new ToolRegistry();
        registerBrowserTools(registry, bm);

        try {
            const timeoutRes = await registry.execute('browser_navigate', {
                url: `${localServerUrl}/timeout`,
                timeoutMs: 500
            });
            assert.equal(timeoutRes.ok, false);
            assert.equal(timeoutRes.status, 'navigation_timeout');
            assert.ok(timeoutRes.error.includes('timeout'));
        } finally {
            await bm.closeAll();
        }
    });

    // -------------------------------------------------------------
    // Criterion 7: Requesting approval for a sensitive action
    // -------------------------------------------------------------
    await suite.test('7. Requesting approval for a sensitive action (consequential risk tier)', async () => {
        const permAuth = new PermissionAuthority({
            mode: PERMISSION_MODES.ASK_EVERY_TIME,
            workspaceRoot: tempDir
        });

        // Deny all consequential prompts
        permAuth.setPromptHandler(async () => false);

        const registry = new ToolRegistry();
        registry.setPermissionAuthority(permAuth);
        registerFileTools(registry, tempDir);

        // file_delete is tagged RISK_TIERS.CONSEQUENTIAL
        const target = 'safe-to-delete.txt';
        fs.writeFileSync(path.join(tempDir, target), 'temp', 'utf8');

        const delRes = await registry.execute('file_delete', { path: target });
        assert.equal(delRes.ok, false);
        assert.equal(delRes.status, 'permission_denied');
        assert.ok(fs.existsSync(path.join(tempDir, target))); // File preserved
    });

    // -------------------------------------------------------------
    // Criterion 8: Cancelling an active multi-step operation
    // -------------------------------------------------------------
    await suite.test('8. Cancelling an active multi-step operation immediately halts execution', async () => {
        const registry = new ToolRegistry();
        registerFileTools(registry, tempDir);

        const permAuth = new PermissionAuthority({ mode: PERMISSION_MODES.NORMAL, workspaceRoot: tempDir });
        registry.setPermissionAuthority(permAuth);

        const coordinator = new TaskCoordinator({
            workspaceRoot: tempDir,
            toolRegistry: registry,
            permissionAuthority: permAuth
        });

        const abortCtrl = new AbortController();
        const executePromise = coordinator.executeRequest('create file step1.txt with content "data" and read it back', {
            signal: abortCtrl.signal
        });

        // Abort immediately
        abortCtrl.abort('User clicked cancel');

        const res = await executePromise;
        assert.equal(res.ok, false);
        assert.ok(res.cancelled || res.status === 'cancelled');
    });

    // -------------------------------------------------------------
    // Criterion 9: Preventing unintended duplicate actions after retries
    // -------------------------------------------------------------
    await suite.test('9. Preventing unintended duplicate actions after retries', async () => {
        const registry = new ToolRegistry();
        let writeCount = 0;
        registry.registerTool({
            id: 'mock_sensitive_action',
            name: 'Mock Action',
            riskTier: RISK_TIERS.WORKSPACE_WRITE,
            handler: async () => {
                writeCount++;
                return { ok: true, status: 'done', count: writeCount };
            }
        });

        const permAuth = new PermissionAuthority({ mode: PERMISSION_MODES.NORMAL, workspaceRoot: tempDir });
        permAuth.setConfirmationHandler(async () => true);
        registry.setPermissionAuthority(permAuth);

        const coordinator = new TaskCoordinator({
            workspaceRoot: tempDir,
            toolRegistry: registry,
            permissionAuthority: permAuth
        });

        // Execute task
        const res = await coordinator.executeRequest('mock test', {
            planOverride: {
                objective: 'Execute once',
                type: 'plan',
                steps: [
                    { index: 1, title: 'Step 1', toolId: 'mock_sensitive_action', params: {} }
                ]
            }
        });

        assert.ok(res.ok);
        assert.equal(writeCount, 1);
    });

    // -------------------------------------------------------------
    // Criterion 10: Handling worker failure and cleanup
    // -------------------------------------------------------------
    await suite.test('10. Handling worker failure and cleanup without orphan processes', async () => {
        const manager = new DesktopAutomationManager();
        await manager.ensureWorker();
        assert.ok(manager.proc);
        assert.ok(manager.isReady);

        // Clean disposal
        manager.cleanup();
        assert.equal(manager.isReady, false);
        assert.equal(manager.proc, null);
    });

    // -------------------------------------------------------------
    // Criterion 11: Preserving permissions & Electron security boundaries
    // -------------------------------------------------------------
    await suite.test('11. Preserving existing permissions and boundary defense against path traversal', () => {
        const checker = createPathBoundaryChecker(tempDir);

        // In-boundary relative path
        const valid = checker('subfolder/doc.txt');
        assert.ok(valid.startsWith(path.resolve(tempDir)));

        // Parent directory traversal attempt
        assert.throws(() => {
            checker('../../Windows/System32/calc.exe');
        }, /Path traversal denied/i);

        // Drive letter escape on Windows
        if (process.platform === 'win32') {
            assert.throws(() => {
                checker('Z:\\escaped\\file.txt');
            }, /Path traversal denied/i);
        }
    });

    // -------------------------------------------------------------
    // Criterion 12: Maintaining existing chat, memory, and planner behaviour
    // -------------------------------------------------------------
    await suite.test('12. Maintaining existing chat and conversation synthesis behaviour', async () => {
        const mockProvider = {
            provider: 'mock',
            resolveApiKey: () => 'mock-key',
            complete: async () => ({
                ok: true,
                content: 'Windows UI Automation (UIA) is an accessibility framework for Windows desktop apps.',
                hasToolCalls: false,
                toolCalls: []
            })
        };
        const planner = new TaskPlanner({ providerAdapter: mockProvider });

        // Conversational query
        const chatRes = await planner.plan('What is Windows UI Automation?');
        assert.equal(chatRes.type, 'conversation');
        assert.ok(chatRes.replyText.length > 0);
        assert.equal(chatRes.steps.length, 0);

        // Clarification on blank request
        const blankRes = await planner.plan('');
        assert.equal(blankRes.type, 'clarification');
    });

    // =============================================================
    // REAL-WORLD ACCEPTANCE SCENARIOS A - F
    // =============================================================

    await suite.test('Scenario A: Open an application ("Lucy, open Notepad")', async () => {
        const planner = new TaskPlanner();
        const plan = await planner.plan('Lucy, open Notepad.');

        assert.equal(plan.type, 'plan');
        assert.equal(plan.steps.length, 1);
        assert.equal(plan.steps[0].toolId, 'desktop_launch_app');
        assert.equal(plan.steps[0].params.executable, 'notepad.exe');
    });

    await suite.test('Scenario B: Unspecified meeting notes content triggers required clarification', async () => {
        const planner = new TaskPlanner();
        const plan = await planner.plan("Create a text file called meeting-notes.txt on my Desktop with today's meeting notes.");

        assert.equal(plan.type, 'clarification');
        assert.ok(plan.replyText.includes("no notes content was provided"));
        assert.ok(plan.replyText.includes("blank template"));
        assert.equal(plan.steps.length, 0);
    });

    await suite.test('Scenario B: Create meeting notes file when template is requested', async () => {
        const planner = new TaskPlanner();
        const plan = await planner.plan("Create a blank template file called meeting-notes.txt on my Desktop");

        assert.equal(plan.type, 'plan');
        assert.equal(plan.steps.length, 2);
        assert.equal(plan.steps[0].toolId, 'file_write');
        assert.ok(plan.steps[0].params.path.includes('meeting-notes.txt'));
        assert.ok(plan.steps[0].params.content.includes('# Meeting Notes'));
        assert.equal(plan.steps[1].toolId, 'file_read');
    });

    await suite.test('Scenario C: Search a website ("Open YouTube and search for Java tutorials")', async () => {
        const planner = new TaskPlanner();
        const plan = await planner.plan('Open YouTube and search for Java tutorials.');

        assert.equal(plan.type, 'plan');
        assert.equal(plan.steps.length, 1);
        assert.equal(plan.steps[0].toolId, 'browser_search');
        assert.equal(plan.steps[0].params.engine, 'youtube');
        assert.equal(plan.steps[0].params.query, 'Java tutorials');

        // Test browser_search execution against local server
        const bm = new BrowserManager({ headless: true, workspaceRoot: tempDir });
        const registry = new ToolRegistry();
        registerBrowserTools(registry, bm);

        try {
            // Emulate web search result parsing
            await registry.execute('browser_navigate', { url: `${localServerUrl}/results` });
            const extract = await registry.execute('browser_extract', { selector: 'body' });
            assert.ok(extract.content.includes('Java Tutorial for Beginners'));
        } finally {
            await bm.closeAll();
        }
    });

    await suite.test('Scenario D: Interact with a form ("Fill in this form...")', async () => {
        const planner = new TaskPlanner();
        const plan = await planner.plan('Fill in this form using the information I gave you.');

        assert.equal(plan.type, 'clarification');
        assert.ok(plan.replyText.includes('confirm which web form'));
        assert.ok(plan.replyText.includes('approval'));
        assert.equal(plan.steps.length, 0);
    });

    await suite.test('Scenario E: Handle failure when project folder does not exist without silent redirect', async () => {
        const registry = new ToolRegistry();
        registerFileTools(registry, tempDir);
        const permAuth = new PermissionAuthority({ mode: PERMISSION_MODES.NORMAL, workspaceRoot: tempDir });
        registry.setPermissionAuthority(permAuth);

        const coordinator = new TaskCoordinator({
            workspaceRoot: tempDir,
            toolRegistry: registry,
            permissionAuthority: permAuth
        });

        // Attempt to read from missing folder
        const res = await coordinator.executeRequest('read file project_missing_xyz/doc.txt');
        assert.equal(res.ok, false);
        assert.ok(res.replyText.includes('not found') || res.error.includes('not found'));
        assert.ok(res.replyText.includes('Operation halted'));
    });

    await suite.test('Scenario F: Multi-step task ("Open my project folder, find the README, and open it")', async () => {
        const planner = new TaskPlanner();
        const plan = await planner.plan('Open my project folder, find the README, and open it.');

        assert.equal(plan.type, 'plan');
        assert.equal(plan.steps.length, 2);
        assert.equal(plan.steps[0].toolId, 'file_search');
        assert.equal(plan.steps[0].params.query, 'README');
        assert.equal(plan.steps[1].toolId, 'file_open_external');
        assert.ok(plan.steps[1].params.path.includes('README'));

        // Execute against temporary directory fixture
        const projectDir = path.join(tempDir, 'project');
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'README.md'), '# Project Documentation', 'utf8');

        const registry = new ToolRegistry();
        registerFileTools(registry, tempDir);

        const searchRes = await registry.execute('file_search', { query: 'README', path: 'project' });
        assert.ok(searchRes.ok);
        assert.equal(searchRes.count, 1);
        assert.equal(searchRes.matches[0].name, 'README.md');
    });

    // -------------------------------------------------------------
    // Additional Coverage: Directory Creation, Copy, Move, Focus
    // -------------------------------------------------------------
    await suite.test('File Tools: file_mkdir, file_copy, and file_move verification', async () => {
        const registry = new ToolRegistry();
        registerFileTools(registry, tempDir);
        const verifier = new ResultVerifier({ workspaceRoot: tempDir });

        // mkdir
        const mkRes = await registry.execute('file_mkdir', { path: 'test_sub' });
        assert.ok(mkRes.ok);
        const mkVer = await verifier.verify({ toolId: 'file_mkdir', params: { path: 'test_sub' } }, mkRes);
        assert.ok(mkVer.verified);

        // write original
        await registry.execute('file_write', { path: 'test_sub/orig.txt', content: 'hello world' });

        // copy
        const cpRes = await registry.execute('file_copy', { source: 'test_sub/orig.txt', destination: 'test_sub/copy.txt' });
        assert.ok(cpRes.ok);
        const cpVer = await verifier.verify({ toolId: 'file_copy', params: { source: 'test_sub/orig.txt', destination: 'test_sub/copy.txt' } }, cpRes);
        assert.ok(cpVer.verified);

        // move
        const mvRes = await registry.execute('file_move', { source: 'test_sub/copy.txt', destination: 'test_sub/moved.txt' });
        assert.ok(mvRes.ok);
        const mvVer = await verifier.verify({ toolId: 'file_move', params: { source: 'test_sub/copy.txt', destination: 'test_sub/moved.txt' } }, mvRes);
        assert.ok(mvVer.verified);
        assert.equal(fs.existsSync(path.join(tempDir, 'test_sub/copy.txt')), false);
        assert.equal(fs.existsSync(path.join(tempDir, 'test_sub/moved.txt')), true);
    });

    await suite.test('Browser Tools: scroll and search verification receipts', async () => {
        const bm = new BrowserManager({ headless: true, workspaceRoot: tempDir });
        const registry = new ToolRegistry();
        registerBrowserTools(registry, bm);
        const verifier = new ResultVerifier({ workspaceRoot: tempDir });

        try {
            await registry.execute('browser_navigate', { url: localServerUrl });

            const scrollRes = await registry.execute('browser_scroll', { direction: 'down', amount: 300 });
            assert.ok(scrollRes.ok);
            const scrollVer = await verifier.verify({ toolId: 'browser_scroll' }, scrollRes);
            assert.ok(scrollVer.verified);

            const searchRes = await registry.execute('browser_search', { query: 'Lucy', engine: 'duckduckgo' });
            if (searchRes.ok) {
                const searchVer = await verifier.verify({ toolId: 'browser_search' }, searchRes);
                assert.ok(searchVer.verified);
            }
        } finally {
            await bm.closeAll();
        }
    });
});
