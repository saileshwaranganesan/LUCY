'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const { BrowserManager } = require('../../src/tools/browser-manager.js');
const { registerBrowserTools } = require('../../src/tools/browser-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');

test('DEF-004: Persistent Browser Sessions and Profile Lifecycle', async (suite) => {
    let server;
    let baseUrl;
    const testBaseDir = path.join(os.tmpdir(), `lucy-persistent-browser-${Date.now()}`);
    fs.mkdirSync(testBaseDir, { recursive: true });

    suite.before(async () => {
        // Simple local HTTP server simulating a student portal / web application with authentication
        server = http.createServer((req, res) => {
            const cookies = req.headers.cookie || '';
            const url = new URL(req.url, `http://${req.headers.host}`);

            if (url.pathname === '/login') {
                // Set persistent session cookie valid for 1 hour
                res.writeHead(200, {
                    'Content-Type': 'text/html',
                    'Set-Cookie': 'auth_session=student_session_token_xyz; Path=/; Max-Age=3600; HttpOnly'
                });
                res.end(`<html><body><h1 id="status">Login Successful</h1><div id="user">Student User Bob</div></body></html>`);
            } else if (url.pathname === '/profile') {
                const isLoggedIn = cookies.includes('auth_session=student_session_token_xyz');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                if (isLoggedIn) {
                    res.end(`<html><body><h1 id="status">Authenticated Portal</h1><div id="content">Welcome back, Student Bob! Your courses: CS101, MATH200.</div></body></html>`);
                } else {
                    res.end(`<html><body><h1 id="status">Login Required</h1><div id="content">Please log in to access the portal.</div></body></html>`);
                }
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<html><body><h1>Mock Public Home</h1></body></html>`);
            }
        });

        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    suite.after(() => {
        if (server) {
            server.close();
        }
        fs.rmSync(testBaseDir, { recursive: true, force: true });
    });

    // 1. Ephemeral Mode Default
    await suite.test('1. Ephemeral mode is the default and does not persist sessions', async () => {
        const manager1 = new BrowserManager({ headless: true });
        assert.equal(manager1.isPersistent, false, 'Default mode must be ephemeral');

        try {
            await manager1.navigate(`${baseUrl}/login`);
            const text1 = await manager1.extract({ selector: '#status' });
            assert.equal(text1.content, 'Login Successful');

            // Verify logged in on profile
            await manager1.navigate(`${baseUrl}/profile`);
            const profileText1 = await manager1.extract({ selector: '#content' });
            assert.match(profileText1.content, /Welcome back, Student Bob/i);

            // Close session completely
            await manager1.closeAll();

            // Reopen new ephemeral manager: session must be GONE
            const manager2 = new BrowserManager({ headless: true });
            await manager2.navigate(`${baseUrl}/profile`);
            const profileText2 = await manager2.extract({ selector: '#content' });
            assert.match(profileText2.content, /Please log in/i, 'Ephemeral mode must discard session on exit');
            await manager2.closeAll();
        } finally {
            await manager1.closeAll();
        }
    });

    // 2. Persistent Mode Lifecycle & Session Preservation Across Reboots
    await suite.test('2. Persistent mode preserves authentication across browser restarts', async () => {
        const profileDir = path.join(testBaseDir, 'profile-session-test');

        // Session 1: Launch persistent context, login, set localStorage & cookie
        const managerSession1 = new BrowserManager({
            headless: true,
            persistent: true,
            userDataDir: profileDir
        });

        assert.equal(managerSession1.isPersistent, true);
        assert.equal(managerSession1.getProfilePath(), profileDir);

        try {
            await managerSession1.navigate(`${baseUrl}/login`);
            const loginStatus = await managerSession1.extract({ selector: '#status' });
            assert.equal(loginStatus.content, 'Login Successful');

            // Set localStorage in session 1
            const page1 = await managerSession1.ensurePage();
            await page1.evaluate(() => {
                localStorage.setItem('student_portal_token', 'offline_local_storage_key_999');
                localStorage.setItem('last_active_course', 'CS101');
            });

            // Close session 1 completely (simulating app shutdown)
            await managerSession1.closeAll();

            // Profile directory must exist on disk and contain browser state
            assert.equal(fs.existsSync(profileDir), true, 'Profile directory must persist on disk');

            // Session 2: Launch a new BrowserManager pointing to the exact same profileDir
            const managerSession2 = new BrowserManager({
                headless: true,
                persistent: true,
                userDataDir: profileDir
            });

            // Navigate directly to protected profile page
            await managerSession2.navigate(`${baseUrl}/profile`);
            const profileStatus = await managerSession2.extract({ selector: '#content' });
            assert.match(profileStatus.content, /Welcome back, Student Bob/i, 'Persistent cookies must preserve login');

            // Verify localStorage survived restart
            const page2 = await managerSession2.ensurePage();
            const storedToken = await page2.evaluate(() => localStorage.getItem('student_portal_token'));
            const storedCourse = await page2.evaluate(() => localStorage.getItem('last_active_course'));
            assert.equal(storedToken, 'offline_local_storage_key_999', 'localStorage must persist across context restarts');
            assert.equal(storedCourse, 'CS101');

            await managerSession2.closeAll();
        } finally {
            await managerSession1.closeAll();
        }
    });

    // 3. Profile Isolation
    await suite.test('3. Separate profile directories do NOT share authentication sessions', async () => {
        const profileA = path.join(testBaseDir, 'profile-isolated-A');
        const profileB = path.join(testBaseDir, 'profile-isolated-B');

        const managerA = new BrowserManager({ headless: true, persistent: true, userDataDir: profileA });
        const managerB = new BrowserManager({ headless: true, persistent: true, userDataDir: profileB });

        try {
            // Profile A logs in
            await managerA.navigate(`${baseUrl}/login`);
            await managerA.navigate(`${baseUrl}/profile`);
            const textA = await managerA.extract({ selector: '#content' });
            assert.match(textA.content, /Welcome back, Student Bob/i);

            // Profile B navigates to profile: must NOT be logged in
            await managerB.navigate(`${baseUrl}/profile`);
            const textB = await managerB.extract({ selector: '#content' });
            assert.match(textB.content, /Please log in/i, 'Profile B must be completely isolated from Profile A');

            await managerA.closeAll();
            await managerB.closeAll();
        } finally {
            await managerA.closeAll();
            await managerB.closeAll();
        }
    });

    // 4. Multi-Tab Operations in Persistent Mode
    await suite.test('4. Multi-tab workflows function properly in persistent context', async () => {
        const profileDir = path.join(testBaseDir, 'profile-tabs-test');
        const manager = new BrowserManager({ headless: true, persistent: true, userDataDir: profileDir });

        try {
            await manager.navigate(`${baseUrl}/login`);

            // Open tab 2 to profile
            const tab2Res = await manager.newTab(`${baseUrl}/profile`);
            assert.equal(tab2Res.ok, true);

            const tabs = await manager.listTabs();
            assert.equal(tabs.totalTabs, 2);

            // Tab 2 inherits session from persistent context
            const tab2Text = await manager.extract({ selector: '#content' });
            assert.match(tab2Text.content, /Welcome back, Student Bob/i);

            // Close tab 2
            const closeRes = await manager.closeTab(tab2Res.tabId);
            assert.equal(closeRes.ok, true);
            assert.equal(closeRes.remainingTabs, 1);

            await manager.closeAll();
        } finally {
            await manager.closeAll();
        }
    });

    // 5. Shutdown Releases Lock File Cleanly
    await suite.test('5. closeAll() cleanly releases the profile lock for sequential reuse', async () => {
        const profileDir = path.join(testBaseDir, 'profile-lock-release-test');

        const manager1 = new BrowserManager({ headless: true, persistent: true, userDataDir: profileDir });
        await manager1.navigate(`${baseUrl}/`);
        await manager1.closeAll();

        // Immediately launch manager 2 on the same profile directory without errors
        const manager2 = new BrowserManager({ headless: true, persistent: true, userDataDir: profileDir });
        const navRes = await manager2.navigate(`${baseUrl}/`);
        assert.equal(navRes.ok, true);
        await manager2.closeAll();
    });

    // 6. Dynamic Enable and Disable Persistence
    await suite.test('6. Dynamic enablePersistence and disablePersistence toggle modes safely without deleting files', async () => {
        const customDir = path.join(testBaseDir, 'profile-toggle-test');
        const manager = new BrowserManager({ headless: true });

        assert.equal(manager.isPersistent, false);

        // Enable persistence
        const enableRes = await manager.enablePersistence(customDir);
        assert.equal(enableRes.ok, true);
        assert.equal(manager.isPersistent, true);
        assert.equal(manager.getProfilePath(), customDir);

        // Login while persistent
        await manager.navigate(`${baseUrl}/login`);
        await manager.closeAll();

        assert.equal(fs.existsSync(customDir), true, 'Profile files must exist');

        // Disable persistence
        const disableRes = await manager.disablePersistence();
        assert.equal(disableRes.ok, true);
        assert.equal(manager.isPersistent, false);

        // Disabling persistence must NOT delete profile directory on disk
        assert.equal(fs.existsSync(customDir), true, 'Disabling persistence must preserve existing profile on disk');
    });

    // 7. Tool Registration: browser_session_config
    await suite.test('7. browser_session_config tool inspects and toggles session persistence', async () => {
        const registry = new ToolRegistry();
        const profileDir = path.join(testBaseDir, 'profile-tool-test');
        const manager = new BrowserManager({ headless: true, userDataDir: profileDir });
        registerBrowserTools(registry, manager);

        // 1. Inspect status
        const statusRes = await registry.execute('browser_session_config', { action: 'status' });
        assert.equal(statusRes.ok, true);
        assert.equal(statusRes.result.status, 'session_config_status');
        assert.equal(statusRes.result.persistent, false);

        // 2. Enable persistence
        const enableRes = await registry.execute('browser_session_config', {
            action: 'enable',
            userDataDir: profileDir
        });
        assert.equal(enableRes.ok, true);
        assert.equal(enableRes.result.persistent, true);
        assert.equal(manager.isPersistent, true);

        // 3. Dry-run simulation
        const simRes = await registry.execute('browser_session_config', { action: 'status' }, { dryRun: true });
        assert.equal(simRes.ok, true);
        assert.equal(simRes.status, 'dry_run_simulated');
        assert.equal(simRes.executed, false);

        // 4. Disable persistence
        const disableRes = await registry.execute('browser_session_config', { action: 'disable' });
        assert.equal(disableRes.ok, true);
        assert.equal(disableRes.result.persistent, false);
        assert.equal(manager.isPersistent, false);

        await manager.closeAll();
    });
});
