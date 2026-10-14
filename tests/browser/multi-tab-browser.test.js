'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { BrowserManager } = require('../../src/tools/browser-manager.js');
const { registerBrowserTools } = require('../../src/tools/browser-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');

test('Batch 02: Multi-Tab Browser Automation & Lifecycle Management', async (t) => {
    let server = null;
    let serverUrl = '';
    let browserManager = null;
    let toolRegistry = null;
    let permissionAuthority = null;
    let taskPlanner = null;

    // 1. Setup local mock web server for offline multi-tab testing
    await new Promise((resolve) => {
        server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            const reqPath = (req.url || '').split('?')[0];
            if (reqPath === '/page1') {
                res.end(`<!DOCTYPE html><html><head><title>Page One</title></head><body><h1 id="heading">Welcome to Page One</h1></body></html>`);
            } else if (reqPath === '/page2') {
                res.end(`<!DOCTYPE html><html><head><title>Page Two</title></head><body><h1 id="heading">Welcome to Page Two</h1></body></html>`);
            } else if (reqPath === '/page3') {
                res.end(`<!DOCTYPE html><html><head><title>Page Three</title></head><body><h1 id="heading">Welcome to Page Three</h1></body></html>`);
            } else {
                res.end(`<!DOCTYPE html><html><head><title>Default Portal</title></head><body><h1>Default</h1></body></html>`);
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            serverUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    browserManager = new BrowserManager({ headless: true });
    permissionAuthority = new PermissionAuthority({
        mode: PERMISSION_MODES.STANDARD,
        workspaceRoot: path.resolve(__dirname, '../../')
    });
    toolRegistry = new ToolRegistry({ permissionAuthority });
    registerBrowserTools(toolRegistry, browserManager);
    taskPlanner = new TaskPlanner({ toolRegistry });

    t.after(async () => {
        if (browserManager) {
            await browserManager.closeAll().catch(() => {});
        }
        if (server) {
            await new Promise((r) => server.close(r));
        }
    });

    // Test 1: Opening new tabs and navigating
    await t.test('opens initial page then spawns new tab with distinct URL', async () => {
        const nav1 = await toolRegistry.execute('browser_navigate', { url: `${serverUrl}/page1` });
        assert.equal(nav1.ok, true);
        assert.equal(nav1.result.title, 'Page One');

        const tab2 = await toolRegistry.execute('browser_new_tab', { url: `${serverUrl}/page2` });
        assert.equal(tab2.ok, true);
        assert.equal(tab2.result.status, 'new_tab_opened');
        assert.equal(tab2.result.tabIndex, 1);
        assert.equal(tab2.result.totalTabs, 2);
        assert.equal(tab2.result.title, 'Page Two');

        // Verify active page is now tab 2
        const extractActive = await toolRegistry.execute('browser_extract', { selector: '#heading' });
        assert.equal(extractActive.ok, true);
        assert.equal(extractActive.result.content, 'Welcome to Page Two');
    });

    // Test 2: Listing open tabs and their status
    await t.test('lists all open tabs with accurate URLs, titles, and active flags', async () => {
        const listResult = await toolRegistry.execute('browser_list_tabs', {});
        assert.equal(listResult.ok, true);
        assert.equal(listResult.result.totalTabs, 2);
        assert.equal(listResult.result.activeIndex, 1);

        const tabs = listResult.result.tabs;
        assert.equal(tabs.length, 2);
        assert.equal(tabs[0].title, 'Page One');
        assert.equal(tabs[0].isActive, false);
        assert.equal(tabs[1].title, 'Page Two');
        assert.equal(tabs[1].isActive, true);
    });

    // Test 3: Switching active tabs
    await t.test('switches active tab back to index 0 and reflects in subsequent operations', async () => {
        const switchResult = await toolRegistry.execute('browser_switch_tab', { index: 0 });
        assert.equal(switchResult.ok, true);
        assert.equal(switchResult.result.status, 'tab_switched');
        assert.equal(switchResult.result.activeIndex, 0);

        // Verification: extract now pulls from Page One
        const extractPage1 = await toolRegistry.execute('browser_extract', { selector: '#heading' });
        assert.equal(extractPage1.result.content, 'Welcome to Page One');
    });

    // Test 4: Handling invalid or out-of-bounds tab indices gracefully
    await t.test('rejects out of bounds and non-integer tab indices fail-closed', async () => {
        const outOfBounds = await toolRegistry.execute('browser_switch_tab', { index: 99 });
        assert.equal(outOfBounds.ok, false);
        assert.equal(outOfBounds.result.status, 'tab_out_of_bounds');

        const negativeIndex = await toolRegistry.execute('browser_switch_tab', { index: -1 });
        assert.equal(negativeIndex.ok, false);

        const invalidType = await toolRegistry.execute('browser_switch_tab', { index: 'not-an-int' });
        assert.equal(invalidType.ok, false);
        assert.equal(invalidType.result.status, 'invalid_index');
    });

    // Test 5: Closing specific and active tabs safely
    await t.test('closes tabs safely, managing remaining tabs and active tab fallback', async () => {
        // Open a 3rd tab
        const tab3 = await toolRegistry.execute('browser_new_tab', { url: `${serverUrl}/page3` });
        assert.equal(tab3.ok, true);
        assert.equal(tab3.result.totalTabs, 3);
        assert.equal(tab3.result.tabIndex, 2);

        // Close middle tab (index 1 = Page Two)
        const closeMiddle = await toolRegistry.execute('browser_close_tab', { index: 1 });
        assert.equal(closeMiddle.ok, true);
        assert.equal(closeMiddle.result.closedIndex, 1);
        assert.equal(closeMiddle.result.remainingTabs, 2);

        // Verify tabs list shows 2 tabs remaining
        const listAfterClose = await toolRegistry.execute('browser_list_tabs', {});
        assert.equal(listAfterClose.result.totalTabs, 2);

        // Close currently active tab (omitted index)
        const closeActive = await toolRegistry.execute('browser_close_tab', {});
        assert.equal(closeActive.ok, true);
        assert.equal(closeActive.result.remainingTabs, 1);
        assert.equal(closeActive.result.activeIndex, 0);

        // Remaining active tab is Page One
        const remainingExtract = await toolRegistry.execute('browser_extract', { selector: '#heading' });
        assert.equal(remainingExtract.result.content, 'Welcome to Page One');
    });

    // Test 6: Handling empty tab list and lifecycle recovery
    await t.test('handles closure of all tabs and transparently recovers when requested', async () => {
        // Close the last remaining tab
        const closeLast = await toolRegistry.execute('browser_close_tab', { index: 0 });
        assert.equal(closeLast.ok, true);
        assert.equal(closeLast.result.remainingTabs, 0);

        // Attempting to close when none open returns clear error
        const closeWhenEmpty = await toolRegistry.execute('browser_close_tab', {});
        assert.equal(closeWhenEmpty.ok, false);
        assert.equal(closeWhenEmpty.result.status, 'no_tabs_open');

        // Opening a new tab automatically revives the session
        const reviveTab = await toolRegistry.execute('browser_new_tab', { url: `${serverUrl}/page1` });
        assert.equal(reviveTab.ok, true);
        assert.equal(reviveTab.result.totalTabs, 1);
        assert.equal(reviveTab.result.title, 'Page One');
    });

    // Test 7: Mechanical dry-run isolation
    await t.test('simulates tab operations without mutating state in dry-run mode', async () => {
        const dryNewTab = await toolRegistry.execute('browser_new_tab', {
            url: `${serverUrl}/page2`
        }, { dryRun: true });
        assert.equal(dryNewTab.ok, true);
        assert.equal(dryNewTab.dryRun, true);
        assert.equal(dryNewTab.executed, false);
        assert.equal(dryNewTab.simulatedDetails.simulatedAction, 'new_tab');

        const dryListTabs = await toolRegistry.execute('browser_list_tabs', {}, { dryRun: true });
        assert.equal(dryListTabs.ok, true);
        assert.equal(dryListTabs.simulatedDetails.simulatedAction, 'list_tabs');

        const drySwitch = await toolRegistry.execute('browser_switch_tab', { index: 0 }, { dryRun: true });
        assert.equal(drySwitch.ok, true);
        assert.equal(drySwitch.simulatedDetails.simulatedAction, 'switch_tab');

        const dryClose = await toolRegistry.execute('browser_close_tab', { index: 0 }, { dryRun: true });
        assert.equal(dryClose.ok, true);
        assert.equal(dryClose.simulatedDetails.simulatedAction, 'close_tab');

        // State remains untouched: exactly 1 tab remains open
        const verifyCount = await toolRegistry.execute('browser_list_tabs', {});
        assert.equal(verifyCount.result.totalTabs, 1);
    });

    // Test 8: TaskPlanner Natural Language Intent Recognition for Tab Management
    await t.test('plans multi-tab directives correctly via TaskPlanner', async () => {
        const planNewTab = await taskPlanner.plan(`open new tab for ${serverUrl}/page2`);
        assert.equal(planNewTab.type, 'plan');
        assert.equal(planNewTab.steps[0].toolId, 'browser_new_tab');
        assert.equal(planNewTab.steps[0].params.url, `${serverUrl}/page2`);

        const planListTabs = await taskPlanner.plan('list open browser tabs');
        assert.equal(planListTabs.type, 'plan');
        assert.equal(planListTabs.steps[0].toolId, 'browser_list_tabs');

        const planSwitch = await taskPlanner.plan('switch to tab 2');
        assert.equal(planSwitch.type, 'plan');
        assert.equal(planSwitch.steps[0].toolId, 'browser_switch_tab');
        assert.equal(planSwitch.steps[0].params.index, 2);

        const planSwitchMissing = await taskPlanner.plan('switch tab');
        assert.equal(planSwitchMissing.type, 'clarification');
        assert.deepEqual(planSwitchMissing.missingParameters, ['index']);

        const planCloseTab = await taskPlanner.plan('close tab 1');
        assert.equal(planCloseTab.type, 'plan');
        assert.equal(planCloseTab.steps[0].toolId, 'browser_close_tab');
        assert.equal(planCloseTab.steps[0].params.index, 1);

        const planCloseActive = await taskPlanner.plan('close active tab');
        assert.equal(planCloseActive.type, 'plan');
        assert.equal(planCloseActive.steps[0].toolId, 'browser_close_tab');
    });

    // Test 9: Stable tab identifiers (creation, switching, querying current tab)
    await t.test('creates tabs with stable identifiers and inspects active tab via browser_current_tab', async () => {
        // Current state: 1 tab open (Page One)
        const current = await toolRegistry.execute('browser_current_tab', {});
        assert.equal(current.ok, true);
        assert.equal(typeof current.result.tabId, 'string');
        assert.ok(current.result.tabId.startsWith('tab_'));
        assert.equal(current.result.title, 'Page One');

        // Create second tab with stable ID
        const tab2 = await toolRegistry.execute('browser_new_tab', { url: `${serverUrl}/page2` });
        assert.equal(tab2.ok, true);
        const tab2Id = tab2.result.tabId;
        assert.equal(typeof tab2Id, 'string');

        // Verify current tab is now tab2
        const current2 = await toolRegistry.execute('browser_current_tab', {});
        assert.equal(current2.ok, true);
        assert.equal(current2.result.tabId, tab2Id);
        assert.equal(current2.result.title, 'Page Two');

        // Switch back to tab 1 using stable tabId
        const tab1Id = current.result.tabId;
        const switchBack = await toolRegistry.execute('browser_switch_tab', { target: tab1Id });
        assert.equal(switchBack.ok, true);
        assert.equal(switchBack.result.tabId, tab1Id);

        // Verify current tab is tab 1
        const currentAfterSwitch = await toolRegistry.execute('browser_current_tab', {});
        assert.equal(currentAfterSwitch.result.tabId, tab1Id);
        assert.equal(currentAfterSwitch.result.title, 'Page One');
    });

    // Test 10: Closing requested tab only by stable identifier
    await t.test('closes requested tab only by stable identifier without closing unrelated tabs', async () => {
        const listBefore = await toolRegistry.execute('browser_list_tabs', {});
        assert.equal(listBefore.result.totalTabs, 2);

        // Open a 3rd tab
        const tab3 = await toolRegistry.execute('browser_new_tab', { url: `${serverUrl}/page3` });
        assert.equal(tab3.ok, true);
        const tab3Id = tab3.result.tabId;

        // Close tab 2 by stable tabId
        const listCurrent = await toolRegistry.execute('browser_list_tabs', {});
        const tab2Info = listCurrent.result.tabs.find(t => t.title === 'Page Two');
        assert.ok(tab2Info);

        const closeResult = await toolRegistry.execute('browser_close_tab', { target: tab2Info.id });
        assert.equal(closeResult.ok, true);
        assert.equal(closeResult.result.closedTabId, tab2Info.id);
        assert.equal(closeResult.result.remainingTabs, 2);

        // Confirm remaining tabs are Page One and Page Three
        const listAfter = await toolRegistry.execute('browser_list_tabs', {});
        const remainingTitles = listAfter.result.tabs.map(t => t.title);
        assert.ok(remainingTitles.includes('Page One'));
        assert.ok(remainingTitles.includes('Page Three'));
        assert.ok(!remainingTitles.includes('Page Two'));
    });

    // Test 11: Rejecting nonexistent and stale tab identifiers
    await t.test('rejects nonexistent and stale tab identifiers fail-closed', async () => {
        // Nonexistent identifier
        const nonexistent = await toolRegistry.execute('browser_switch_tab', { target: 'tab_99999' });
        assert.equal(nonexistent.ok, false);
        assert.equal(nonexistent.result.status, 'tab_not_found');

        const closeNonexistent = await toolRegistry.execute('browser_close_tab', { target: 'tab_99999' });
        assert.equal(closeNonexistent.ok, false);
        assert.equal(closeNonexistent.result.status, 'tab_not_found');

        // Create a temporary tab, close it, then attempt to switch to stale identifier
        const tempTab = await toolRegistry.execute('browser_new_tab', { url: `${serverUrl}/page2` });
        const staleId = tempTab.result.tabId;
        const closeTemp = await toolRegistry.execute('browser_close_tab', { target: staleId });
        assert.equal(closeTemp.ok, true);

        // Stale identifier access rejected
        const staleSwitch = await toolRegistry.execute('browser_switch_tab', { target: staleId });
        assert.equal(staleSwitch.ok, false);
        assert.equal(staleSwitch.result.status, 'tab_not_found');

        const staleClose = await toolRegistry.execute('browser_close_tab', { target: staleId });
        assert.equal(staleClose.ok, false);
        assert.equal(staleClose.result.status, 'tab_not_found');
    });

    // Test 12: Rejecting unsafe URL schemes
    await t.test('strictly rejects unsafe URL schemes fail-closed', async () => {
        const unsafeSchemes = [
            'javascript:alert(1)',
            'data:text/html,<h1>dangerous</h1>',
            'vbscript:msgbox(1)'
        ];

        for (const unsafeUrl of unsafeSchemes) {
            const navReject = await toolRegistry.execute('browser_navigate', { url: unsafeUrl });
            assert.equal(navReject.ok, false);
            assert.equal(navReject.result.status, 'forbidden_protocol');

            const tabReject = await toolRegistry.execute('browser_new_tab', { url: unsafeUrl });
            assert.equal(tabReject.ok, false);
            assert.equal(tabReject.result.status, 'forbidden_protocol');
        }
    });

    // Test 13: Ensuring listing tabs does not change the active tab
    await t.test('ensures listing tabs does not alter the active tab', async () => {
        // Set active tab to Page Three
        const listBefore = await toolRegistry.execute('browser_list_tabs', {});
        const page3Tab = listBefore.result.tabs.find(t => t.title === 'Page Three');
        assert.ok(page3Tab);

        await toolRegistry.execute('browser_switch_tab', { target: page3Tab.id });
        const activeBefore = await toolRegistry.execute('browser_current_tab', {});
        assert.equal(activeBefore.result.tabId, page3Tab.id);

        // Call browser_list_tabs
        const listResult = await toolRegistry.execute('browser_list_tabs', {});
        assert.equal(listResult.ok, true);

        // Verify active tab remains strictly Page Three
        const activeAfter = await toolRegistry.execute('browser_current_tab', {});
        assert.equal(activeAfter.result.tabId, page3Tab.id);
        assert.equal(activeAfter.result.title, 'Page Three');

        const content = await toolRegistry.execute('browser_extract', { selector: '#heading' });
        assert.equal(content.result.content, 'Welcome to Page Three');
    });

    // Test 14: Ensuring tool outputs do not contain secrets
    await t.test('ensures tool outputs do not leak passwords, tokens, or query secrets', async () => {
        const secretUrl = `${serverUrl}/page1?token=SUPER_SECRET_TOKEN_XYZ&apiKey=MY_SECRET_KEY_123&password=secretpassword`;
        const navSecret = await toolRegistry.execute('browser_navigate', { url: secretUrl });
        assert.equal(navSecret.ok, true);
        assert.ok(!navSecret.result.url.includes('SUPER_SECRET_TOKEN_XYZ'), 'Token must not appear in result URL');
        assert.ok(!navSecret.result.url.includes('MY_SECRET_KEY_123'), 'ApiKey must not appear in result URL');
        assert.ok(!navSecret.result.url.includes('secretpassword'), 'Password must not appear in result URL');
        assert.ok(navSecret.result.url.includes('[REDACTED_SECRET]'), 'Secret must be masked with [REDACTED_SECRET]');

        // List tabs output sanitization
        const listTabs = await toolRegistry.execute('browser_list_tabs', {});
        const activeTab = listTabs.result.tabs.find(t => t.isActive);
        assert.ok(!activeTab.url.includes('SUPER_SECRET_TOKEN_XYZ'));
        assert.ok(activeTab.url.includes('[REDACTED_SECRET]'));

        // Current tab output sanitization
        const currentTab = await toolRegistry.execute('browser_current_tab', {});
        assert.ok(!currentTab.result.url.includes('SUPER_SECRET_TOKEN_XYZ'));
        assert.ok(currentTab.result.url.includes('[REDACTED_SECRET]'));
    });

    // Test 15: Handling browser disconnection and operation failures gracefully
    await t.test('handles browser disconnection and operation failures gracefully', async () => {
        // Disconnect browser session
        await browserManager.closeAll();

        // Querying current tab when disconnected returns clean failure without crash
        const currentWhenClosed = await toolRegistry.execute('browser_current_tab', {});
        assert.equal(currentWhenClosed.ok, false);
        assert.equal(currentWhenClosed.result.status, 'no_active_tab');

        // Switching tab when disconnected returns clean failure
        const switchWhenClosed = await toolRegistry.execute('browser_switch_tab', { target: 'tab_1' });
        assert.equal(switchWhenClosed.ok, false);
        assert.equal(switchWhenClosed.result.status, 'no_tabs_open');

        // Recovery: opening a new tab automatically re-establishes session
        const reopen = await toolRegistry.execute('browser_new_tab', { url: `${serverUrl}/page1` });
        assert.equal(reopen.ok, true);
        assert.equal(reopen.result.title, 'Page One');
    });

    // Test 16: Preserving single-tab operations and backward compatibility
    await t.test('preserves single-tab navigation, extraction, and screenshot operations', async () => {
        // Single-tab navigation
        const nav = await toolRegistry.execute('browser_navigate', { url: `${serverUrl}/page2` });
        assert.equal(nav.ok, true);
        assert.equal(nav.result.title, 'Page Two');

        // Single-tab extraction
        const extract = await toolRegistry.execute('browser_extract', { selector: '#heading' });
        assert.equal(extract.ok, true);
        assert.equal(extract.result.content, 'Welcome to Page Two');

        // Single-tab screenshot
        const screenshot = await toolRegistry.execute('browser_screenshot', {});
        assert.equal(screenshot.ok, true);
        assert.ok(screenshot.result.byteLength > 0);
    });
});
