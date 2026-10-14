'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { BrowserManager } = require('../../src/tools/browser-manager.js');
const { registerBrowserTools } = require('../../src/tools/browser-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');

test('Safe Browser Automation: Playwright Integration & Permission Enforcement', async (t) => {
    let server = null;
    let serverUrl = '';
    let browserManager = null;
    let toolRegistry = null;
    let permissionAuthority = null;

    // 1. Setup local mock web server for offline testing
    await new Promise((resolve) => {
        server = http.createServer((req, res) => {
            if (req.url === '/about') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><head><title>About Page</title></head><body><h1>About L.U.C.Y.</h1><p id="about-text">Dedicated assistant.</p></body></html>`);
                return;
            }

            if (req.url === '/captcha') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><head><title>Verification Required</title></head><body><div class="cf-turnstile">Cloudflare verification</div><p>Checking your browser...</p></body></html>`);
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html>
            <html>
            <head><title>L.U.C.Y. Test Portal</title></head>
            <body>
                <h1>L.U.C.Y. Offline Test Portal</h1>
                <p id="intro">Safe automated browser verification.</p>
                <form id="test-form">
                    <input id="user-input" type="text" placeholder="Username" />
                    <input id="pass-input" type="password" placeholder="Password" />
                    <button id="submit-btn" type="submit">Submit Information</button>
                </form>
                <div id="output-area">Default State</div>
                <a id="nav-link" href="/about">Go to About</a>
                <script>
                    document.getElementById('test-form').addEventListener('submit', (e) => {
                        e.preventDefault();
                        document.getElementById('output-area').textContent = 'Form Submitted: ' + document.getElementById('user-input').value;
                    });
                </script>
            </body>
            </html>`);
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

    t.after(async () => {
        if (browserManager) {
            await browserManager.closeAll().catch(() => {});
        }
        if (server) {
            await new Promise((r) => server.close(r));
        }
    });

    // Test 1: Navigation
    await t.test('navigates to local URL and verifies page title and status', async () => {
        const result = await toolRegistry.execute('browser_navigate', { url: serverUrl });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'navigation_success');
        assert.equal(result.result.title, 'L.U.C.Y. Test Portal');
        assert.equal(result.result.httpStatus, 200);
        assert.equal(result.verification.verified, true);
    });

    // Test 2: Extraction
    await t.test('extracts visible text and links from page without coordinate clicks', async () => {
        const textResult = await toolRegistry.execute('browser_extract', { selector: '#intro' });
        assert.equal(textResult.ok, true);
        assert.equal(textResult.result.content, 'Safe automated browser verification.');

        const linksResult = await toolRegistry.execute('browser_extract', { format: 'links' });
        assert.equal(linksResult.ok, true);
        assert.ok(linksResult.result.links.length > 0);
        assert.equal(linksResult.result.links[0].text, 'Go to About');
    });

    // Test 3: Form filling with credential protection
    await t.test('fills form input and masks password secrets from logs', async () => {
        // Form filling requires confirmation under standard mode
        let prompted = false;
        permissionAuthority.setConfirmationHandler(async (req) => {
            prompted = true;
            return true; // Authorize
        });

        const fillUser = await toolRegistry.execute('browser_fill', {
            selector: '#user-input',
            value: 'lucy_agent'
        });
        assert.equal(prompted, true);
        assert.equal(fillUser.ok, true);
        assert.equal(fillUser.result.verifiedValue, 'lucy_agent');

        const fillPass = await toolRegistry.execute('browser_fill', {
            selector: '#pass-input',
            value: 'super_secret_password_123'
        });
        assert.equal(fillPass.ok, true);
        assert.equal(fillPass.result.verifiedValue, '[REDACTED_SECRET]', 'Password MUST be masked');
    });

    // Test 4: Element clicking and DOM interaction
    await t.test('clicks element using robust selector and verifies outcome', async () => {
        permissionAuthority.setConfirmationHandler(async () => true);

        const clickResult = await toolRegistry.execute('browser_click', {
            selector: '#submit-btn'
        });
        assert.equal(clickResult.ok, true);

        // Verify output area updated
        const extractUpdated = await toolRegistry.execute('browser_extract', { selector: '#output-area' });
        assert.equal(extractUpdated.result.content, 'Form Submitted: lucy_agent');
    });

    // Test 5: Permission gate denial halts consequential browser action
    await t.test('halts browser action when user denies confirmation', async () => {
        permissionAuthority.setConfirmationHandler(async () => false); // Deny!

        const deniedResult = await toolRegistry.execute('browser_fill', {
            selector: '#user-input',
            value: 'malicious_overwrite'
        });
        assert.equal(deniedResult.ok, false);
        assert.equal(deniedResult.status, 'permission_denied');

        // Check value on page was NOT changed
        const extractValue = await toolRegistry.execute('browser_extract', { selector: '#user-input' });
        assert.equal(extractValue.result.content, 'lucy_agent');
    });

    // Test 6: Mechanical dry-run isolation
    await t.test('strictly simulates browser action without mutating page in dry-run mode', async () => {
        const dryRunResult = await toolRegistry.execute('browser_fill', {
            selector: '#user-input',
            value: 'dry_run_test_value'
        }, { dryRun: true });

        assert.equal(dryRunResult.ok, true);
        assert.equal(dryRunResult.dryRun, true);
        assert.equal(dryRunResult.executed, false);
        assert.equal(dryRunResult.simulatedDetails.simulatedAction, 'fill');

        // Page DOM must still have original value
        const verifyDom = await toolRegistry.execute('browser_extract', { selector: '#user-input' });
        assert.equal(verifyDom.result.content, 'lucy_agent');
    });

    // Test 7: Bot/CAPTCHA challenge fail-closed protection
    await t.test('detects security barrier / CAPTCHA and fails closed without bypassing', async () => {
        const captchaResult = await toolRegistry.execute('browser_navigate', {
            url: `${serverUrl}/captcha`
        });

        assert.equal(captchaResult.ok, false);
        assert.equal(captchaResult.status, 'security_gate_detected');
        assert.ok(captchaResult.error.includes('barrier detected'));
        assert.equal(captchaResult.result.gateType, 'Cloudflare / Turnstile');
    });

    // Test 8: Page screenshot capture
    await t.test('captures page screenshot artifact', async () => {
        const screenshotResult = await toolRegistry.execute('browser_screenshot', {});
        assert.equal(screenshotResult.ok, true);
        assert.equal(screenshotResult.result.status, 'screenshot_captured');
        assert.ok(screenshotResult.result.byteLength > 100);
    });

    // Test 9: Clean browser closure
    await t.test('closes browser context cleanly', async () => {
        const closeResult = await toolRegistry.execute('browser_close', {});
        assert.equal(closeResult.ok, true);
        assert.equal(closeResult.result.status, 'browser_closed');
    });
});
