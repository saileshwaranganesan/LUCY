'use strict';

/**
 * L.U.C.Y. Phase 8 Finalization — Targeted Safety & Real-World Verification Suite
 * 
 * Verifies Priority One & Priority Two Safety Boundaries:
 * 1. Unsaved-document protection: never silently discard unsaved user changes.
 * 2. Disposable test scope: allows explicit discard only under verified test scope.
 * 3. Ambiguous confirmation dialog handling: halts fail-closed without guessing.
 * 4. Cancellation while waiting for authorization: immediate abort with clean state.
 * 5. Destructive action authorization boundaries: fails closed without proper grant.
 * 6. Browser overlay classification: distinguishes harmless, consent, auth, consequential, and unknown overlays.
 * 7. Non-silent overlay handling: forbids silent acceptance/rejection of consent, auth, or purchases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const EventEmitter = require('events');

const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager');
const { BrowserManager } = require('../../src/tools/browser-manager');
const { TaskRecoveryEngine, FAILURE_TYPES, RECOVERY_STRATEGIES } = require('../../src/core/recovery-engine');

class MockWorkerProcess extends EventEmitter {
    constructor() {
        super();
        this.stdin = {
            write: (chunk) => {
                const lines = chunk.toString('utf8').split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const req = JSON.parse(line.trim());
                        this.handleRequest(req);
                    } catch (_) {}
                }
            }
        };
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.handlers = new Map();
    }

    setHandler(action, handler) {
        this.handlers.set(action, handler);
    }

    handleRequest(req) {
        const id = req.id;
        const cmd = req.cmd || req.action;
        setImmediate(() => {
            if (this.handlers.has(cmd)) {
                try {
                    const res = this.handlers.get(cmd)(req);
                    this.sendSuccess(id, res);
                } catch (err) {
                    this.sendError(id, err.message);
                }
            } else {
                this.sendSuccess(id, { ok: true, verified: true });
            }
        });
    }

    sendSuccess(id, result) {
        this.stdout.emit('data', Buffer.from(JSON.stringify({ id, ok: true, result }) + '\n'));
    }

    sendError(id, error) {
        this.stdout.emit('data', Buffer.from(JSON.stringify({ id, ok: false, error }) + '\n'));
    }
}

function createMockManager() {
    const mockProc = new MockWorkerProcess();
    const manager = new DesktopAutomationManager({
        workerExe: 'dummy.exe',
        timeoutMs: 3000
    });
    manager.proc = mockProc;
    manager.isReady = true;
    manager.readyPromise = Promise.resolve();
    mockProc.stdout.on('data', (chunk) => {
        manager._handleStdout(chunk, () => {}, () => {}, null);
    });
    return { mockProc, manager };
}

test('L.U.C.Y. Phase 8 Safety Corrections & Verification Suite', async (t) => {

    // =========================================================================
    // PRIORITY ONE: UNSAVED-DOCUMENT SAFETY & CONFIRMATION DIALOG GATES
    // =========================================================================

    await t.test('1. Unexpected unsaved-changes dialog on user document: fails closed and protects unsaved work', async () => {
        const { mockProc, manager } = createMockManager();

        // User document launched by Lucy
        manager.trackedApps.set('app_user_doc', {
            appId: 'app_user_doc',
            pid: 4001,
            processName: 'notepad.exe',
            windowTitle: 'important_user_notes.txt - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Attempting to invoke dont_save without explicit user authorization or disposable test scope
        await assert.rejects(async () => {
            await manager.handleDialog('app_user_doc', 'dont_save');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_DISCARD_ACTION');
            assert.ok(err.message.includes('Cannot discard unsaved changes without explicit user authorization'));
            return true;
        });

        // Assert user application remains tracked and active
        const app = manager.getTrackedApp('app_user_doc');
        assert.ok(app, 'User document application must remain tracked');
        assert.equal(app.lifecycleState, 'active', 'User document must remain active and protected');
    });

    await t.test('2. Known disposable test document: authorized dismissal succeeds under explicit test scope', async () => {
        const { mockProc, manager } = createMockManager();

        mockProc.setHandler('handle_dialog', (req) => {
            assert.equal(req.action, 'dont_save');
            assert.equal(req.disposableTestDoc, true);
            return {
                handled: true,
                action: 'dont_save',
                dialogTitle: 'Unsaved Changes',
                processExited: true
            };
        });

        // Test document tagged with disposable scope
        manager.trackedApps.set('app_test_doc', {
            appId: 'app_test_doc',
            pid: 4002,
            processName: 'notepad.exe',
            windowTitle: 'test_temp.txt - Notepad',
            launchedByLucy: true,
            isDisposableTest: true,
            lifecycleState: 'active'
        });

        const res = await manager.handleDialog('app_test_doc', 'dont_save', { disposableTestDoc: true });
        assert.equal(res.handled, true);
        assert.equal(res.action, 'dont_save');
        assert.equal(res.processExited, true);

        // App state untracked upon process exit
        assert.equal(manager.getTrackedApp('app_test_doc'), null);
    });

    await t.test('3. User explicitly authorized discarding: dismissal succeeds with userAuthorizedDiscard flag', async () => {
        const { mockProc, manager } = createMockManager();

        mockProc.setHandler('handle_dialog', (req) => {
            assert.equal(req.action, 'dont_save');
            assert.equal(req.userAuthorizedDiscard, true);
            return {
                handled: true,
                action: 'dont_save',
                dialogTitle: 'Unsaved Changes',
                processExited: true
            };
        });

        manager.trackedApps.set('app_confirmed_discard', {
            appId: 'app_confirmed_discard',
            pid: 4003,
            processName: 'notepad.exe',
            windowTitle: 'Untitled - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        const res = await manager.handleDialog('app_confirmed_discard', 'dont_save', { userAuthorizedDiscard: true });
        assert.equal(res.handled, true);
        assert.equal(res.action, 'dont_save');
        assert.equal(manager.getTrackedApp('app_confirmed_discard'), null);
    });

    await t.test('4. Ambiguous confirmation dialog: halts fail-closed without arbitrary guessing', async () => {
        const mockProc = new MockWorkerProcess();
        const manager = new DesktopAutomationManager({ workerExe: 'dummy.exe' });
        manager.proc = mockProc;
        manager.isReady = true;

        manager.trackedApps.set('app_ambig', {
            appId: 'app_ambig',
            pid: 4004,
            processName: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // When isAmbiguous flag is set
        await assert.rejects(async () => {
            await manager.handleDialog('app_ambig', 'dont_save', { isAmbiguous: true });
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_CONFIRMATION_DIALOG');
            return true;
        });

        // RecoveryEngine classification
        const recoveryEngine = new TaskRecoveryEngine();
        const classification = recoveryEngine.classifyFailure(
            { code: 'AMBIGUOUS_CONFIRMATION_DIALOG', message: 'Ambiguous confirmation dialog' },
            { step: { isConsequential: true, idempotent: false } }
        );

        assert.equal(classification.type, FAILURE_TYPES.TIMEOUT_UNCERTAIN);
        assert.equal(classification.suggestedStrategy, RECOVERY_STRATEGIES.AWAIT_RECONCILIATION);
        assert.equal(classification.recoverable, false);
    });

    await t.test('5. Cancellation while waiting for dialog handling: halts immediately and throws CANCELLED', async () => {
        const mockProc = new MockWorkerProcess();
        const manager = new DesktopAutomationManager({ workerExe: 'dummy.exe' });
        manager.proc = mockProc;
        manager.isReady = true;

        manager.trackedApps.set('app_cancel', {
            appId: 'app_cancel',
            pid: 4005,
            processName: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        const abortController = new AbortController();
        abortController.abort(); // already aborted

        await assert.rejects(async () => {
            await manager.handleDialog('app_cancel', 'cancel', { signal: abortController.signal });
        }, (err) => {
            assert.equal(err.code, 'CANCELLED');
            return true;
        });
    });

    await t.test('6. Unowned application: destructive dialog action fails closed with UNAUTHORIZED_RESOURCE_ACCESS', async () => {
        const mockProc = new MockWorkerProcess();
        const manager = new DesktopAutomationManager({ workerExe: 'dummy.exe' });
        manager.proc = mockProc;
        manager.isReady = true;

        // Target not launched by Lucy
        await assert.rejects(async () => {
            await manager.handleDialog('external_pid_9999', 'dont_save');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });
    });

    // =========================================================================
    // PRIORITY TWO: BROWSER OVERLAY RECOVERY & SAFETY BOUNDARIES
    // =========================================================================

    await t.test('7. Harmless promotional overlay: safely dismissed without requiring user decision', async () => {
        const browserManager = new BrowserManager({ headless: true });
        let server;
        const port = 34601;
        const html = `<!DOCTYPE html>
<html>
<head><title>Harmless Overlay Test</title></head>
<body>
    <div id="promo" class="modal" role="dialog" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;">
        <h2>Special Announcement</h2>
        <button id="close-promo" class="close" onclick="document.getElementById('promo').remove();">Close</button>
    </div>
    <div id="content" style="padding:40px;">
        <button id="target-btn" onclick="document.getElementById('status').innerText = 'Clicked!';">Click Me</button>
        <span id="status">Waiting</span>
    </div>
</body>
</html>`;

        await new Promise((res) => {
            server = http.createServer((req, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
            server.listen(port, '127.0.0.1', res);
        });

        try {
            await browserManager.navigate(`http://127.0.0.1:${port}/`);
            const inspect = await browserManager.inspectPage();
            assert.equal(inspect.dialogOpen, true);
            assert.equal(inspect.dialog.overlayType, 'harmless_promotional');
            assert.equal(inspect.dialog.dismissible, true);
            assert.equal(inspect.dialog.requiresUserDecision, false);

            // Click should automatically dismiss the harmless promo and click target
            const clickRes = await browserManager.click('#target-btn');
            assert.equal(clickRes.ok, true);
            assert.equal(clickRes.recoveredFromOverlay, true);

            const status = await browserManager.extract({ selector: '#status', format: 'text' });
            assert.equal(status.text.trim(), 'Clicked!');
        } finally {
            server.close();
            await browserManager.closeAll();
        }
    });

    await t.test('8. Cookie/privacy consent dialog: NOT silently accepted or dismissed; requires user decision', async () => {
        const browserManager = new BrowserManager({ headless: true });
        let server;
        const port = 34602;
        const html = `<!DOCTYPE html>
<html>
<head><title>Consent Overlay Test</title></head>
<body>
    <div id="cookie-banner" class="cookie-banner" role="dialog" aria-modal="true" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;">
        <h2>We Value Your Privacy</h2>
        <p>We and our partners use cookies for tracking and advertising.</p>
        <button id="accept-all">Accept All</button>
        <button id="reject-all">Reject All</button>
    </div>
    <div id="content" style="padding:40px;">
        <button id="main-btn">Main Button</button>
    </div>
</body>
</html>`;

        await new Promise((res) => {
            server = http.createServer((req, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
            server.listen(port, '127.0.0.1', res);
        });

        try {
            await browserManager.navigate(`http://127.0.0.1:${port}/`);
            const inspect = await browserManager.inspectPage();
            assert.equal(inspect.dialogOpen, true);
            assert.equal(inspect.dialog.overlayType, 'privacy_consent');
            assert.equal(inspect.dialog.dismissible, false);
            assert.equal(inspect.dialog.requiresUserDecision, true);

            // Clicking target element MUST FAIL CLOSED and refuse to silently accept cookies
            await assert.rejects(async () => {
                await browserManager.click('#main-btn');
            }, (err) => {
                assert.equal(err.code, 'OVERLAY_REQUIRES_USER_DECISION');
                assert.equal(err.overlayType, 'privacy_consent');
                return true;
            });
        } finally {
            server.close();
            await browserManager.closeAll();
        }
    });

    await t.test('9. Authentication prompt overlay: NOT silently bypassed; requires user credentials', async () => {
        const browserManager = new BrowserManager({ headless: true });
        let server;
        const port = 34603;
        const html = `<!DOCTYPE html>
<html>
<head><title>Auth Overlay Test</title></head>
<body>
    <div id="login-modal" class="modal" role="dialog" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;">
        <h2>Sign In to Continue</h2>
        <input type="text" name="username" placeholder="Username" />
        <input type="password" name="password" placeholder="Password" />
        <button id="submit-login">Sign In</button>
    </div>
    <div id="content" style="padding:40px;">
        <button id="dashboard-btn">Open Dashboard</button>
    </div>
</body>
</html>`;

        await new Promise((res) => {
            server = http.createServer((req, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
            server.listen(port, '127.0.0.1', res);
        });

        try {
            await browserManager.navigate(`http://127.0.0.1:${port}/`);
            const inspect = await browserManager.inspectPage();
            assert.equal(inspect.dialogOpen, true);
            assert.equal(inspect.dialog.overlayType, 'authentication');
            assert.equal(inspect.dialog.dismissible, false);
            assert.equal(inspect.dialog.requiresUserDecision, true);

            await assert.rejects(async () => {
                await browserManager.click('#dashboard-btn');
            }, (err) => {
                assert.equal(err.code, 'OVERLAY_REQUIRES_USER_DECISION');
                assert.equal(err.overlayType, 'authentication');
                return true;
            });
        } finally {
            server.close();
            await browserManager.closeAll();
        }
    });

    await t.test('10. Consequential confirmation overlay: NOT silently dismissed or confirmed; halts fail-closed', async () => {
        const browserManager = new BrowserManager({ headless: true });
        let server;
        const port = 34604;
        const html = `<!DOCTYPE html>
<html>
<head><title>Payment Overlay Test</title></head>
<body>
    <div id="checkout-modal" class="modal" role="dialog" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;">
        <h2>Payment Required</h2>
        <p>Total: $49.99 for annual subscription</p>
        <button id="pay-now">Pay Now</button>
    </div>
    <div id="content" style="padding:40px;">
        <button id="view-article">Read Article</button>
    </div>
</body>
</html>`;

        await new Promise((res) => {
            server = http.createServer((req, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
            server.listen(port, '127.0.0.1', res);
        });

        try {
            await browserManager.navigate(`http://127.0.0.1:${port}/`);
            const inspect = await browserManager.inspectPage();
            assert.equal(inspect.dialogOpen, true);
            assert.equal(inspect.dialog.overlayType, 'consequential');
            assert.equal(inspect.dialog.dismissible, false);
            assert.equal(inspect.dialog.requiresUserDecision, true);

            await assert.rejects(async () => {
                await browserManager.click('#view-article');
            }, (err) => {
                assert.equal(err.code, 'OVERLAY_REQUIRES_USER_DECISION');
                assert.equal(err.overlayType, 'consequential');
                return true;
            });
        } finally {
            server.close();
            await browserManager.closeAll();
        }
    });

    await t.test('11. Unknown overlay: cannot establish harmlessness; halts fail-closed', async () => {
        const browserManager = new BrowserManager({ headless: true });
        let server;
        const port = 34605;
        const html = `<!DOCTYPE html>
<html>
<head><title>Unknown Overlay Test</title></head>
<body>
    <div id="custom-dialog" class="modal" role="dialog" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;">
        <h2>Important Notice</h2>
        <p>Custom dialog without clear dismissal semantics.</p>
        <button id="btn-option-a">Option A</button>
        <button id="btn-option-b">Option B</button>
    </div>
    <div id="content" style="padding:40px;">
        <button id="background-btn">Background Action</button>
    </div>
</body>
</html>`;

        await new Promise((res) => {
            server = http.createServer((req, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(html); });
            server.listen(port, '127.0.0.1', res);
        });

        try {
            await browserManager.navigate(`http://127.0.0.1:${port}/`);
            const inspect = await browserManager.inspectPage();
            assert.equal(inspect.dialogOpen, true);
            assert.equal(inspect.dialog.overlayType, 'unknown');
            assert.equal(inspect.dialog.dismissible, false);
            assert.equal(inspect.dialog.requiresUserDecision, true);

            await assert.rejects(async () => {
                await browserManager.click('#background-btn');
            }, (err) => {
                assert.equal(err.code, 'OVERLAY_REQUIRES_USER_DECISION');
                assert.equal(err.overlayType, 'unknown');
                return true;
            });
        } finally {
            server.close();
            await browserManager.closeAll();
        }
    });
});
