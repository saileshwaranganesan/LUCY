'use strict';

/**
 * L.U.C.Y. Phase 8 Final Safety Gate:
 * Discard Authorization vs. Force Termination Regression Suite
 * 
 * Verifies strict separation between:
 * 1. Process termination (force-kill) vs. Document discard (dont_save)
 * 2. Untrusted tool arguments vs. Authoritative PermissionAuthority grants
 * 3. Ordinary production requests vs. Trusted disposable test scopes
 * 4. Target matching to prevent cross-target authorization reuse
 * 5. Fail-closed ambiguity handling and cancellation preservation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { TaskRecoveryEngine, FAILURE_TYPES, RECOVERY_STRATEGIES } = require('../../src/core/recovery-engine.js');

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
        this.receivedCommands = [];
    }

    setHandler(action, handler) {
        this.handlers.set(action, handler);
    }

    handleRequest(req) {
        this.receivedCommands.push(req);
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

function createHarness(options = {}) {
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

    const authority = new PermissionAuthority({
        mode: options.permissionMode || PERMISSION_MODES.STANDARD
    });
    const registry = new ToolRegistry({ permissionAuthority: authority });
    registerDesktopTools(registry, manager);

    return { mockProc, manager, authority, registry };
}

test('L.U.C.Y. Phase 8 Final Safety Gate: Discard Authorization vs. Force Termination', async (suite) => {

    // =========================================================================
    // SCENARIO 1: allowForceKill: true with dont_save
    // Required: Reject unless discard authorization is independently established
    // =========================================================================
    await suite.test('Scenario 1: allowForceKill / force does NOT authorize dont_save', async () => {
        const { mockProc, manager } = createHarness();

        manager.trackedApps.set('app_user_1', {
            appId: 'app_user_1',
            pid: 5001,
            processName: 'notepad.exe',
            windowTitle: 'financial_report.txt - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // 1a. Attempting handleDialog with action: 'dont_save' and force: true
        await assert.rejects(async () => {
            await manager.handleDialog('app_user_1', 'dont_save', { force: true, allowForceKill: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_DISCARD_ACTION');
            return true;
        }, 'Force termination flag must NOT authorize discarding unsaved changes in handleDialog');

        // 1b. Attempting closeApp with savePolicy: 'dont_save' and force: true
        await assert.rejects(async () => {
            await manager.closeApp('app_user_1', { savePolicy: 'dont_save', force: true });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_DISCARD_ACTION');
            return true;
        }, 'Force termination flag must NOT authorize discarding unsaved changes in closeApp');

        // Verify no discard command was executed by worker
        const discardCommands = mockProc.receivedCommands.filter(c => c.action === 'dont_save' || c.savePolicy === 'dont_save');
        assert.equal(discardCommands.length, 0, 'Worker must never receive discard command when unauthorized');
    });

    // =========================================================================
    // SCENARIO 2: userAuthorizedDiscard: true supplied ONLY in untrusted tool payload
    // Required: Reject unless trusted authorization is verified
    // =========================================================================
    await suite.test('Scenario 2: userAuthorizedDiscard supplied only in untrusted tool payload is rejected', async () => {
        const { manager, authority, registry } = createHarness();

        manager.trackedApps.set('app_user_2', {
            appId: 'app_user_2',
            pid: 5002,
            processName: 'notepad.exe',
            windowTitle: 'project_notes.txt - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Set confirmation handler that rejects or does not approve
        authority.setConfirmationHandler(async () => {
            return false; // User denies permission
        });

        // Untrusted model tool call attempting to manufacture authorization via params
        const res = await registry.execute('desktop_handle_dialog', {
            target: 'app_user_2',
            action: 'dont_save',
            userAuthorizedDiscard: true // Manufactured by untrusted model
        });

        assert.equal(res.ok, false);
        assert.equal(res.status, 'permission_denied');

        // App remains active and protected
        const app = manager.getTrackedApp('app_user_2');
        assert.ok(app);
        assert.equal(app.lifecycleState, 'active');
    });

    // =========================================================================
    // SCENARIO 3: disposableTestDoc: true supplied by ordinary production request
    // Required: Reject unless a trusted test scope independently authorizes it
    // =========================================================================
    await suite.test('Scenario 3: disposableTestDoc in tool params on user document is rejected', async () => {
        const { manager, authority, registry } = createHarness();

        // Normal user document (NOT launched with isDisposableTest)
        manager.trackedApps.set('app_user_3', {
            appId: 'app_user_3',
            pid: 5003,
            processName: 'notepad.exe',
            windowTitle: 'personal_diary.txt - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Confirmation handler auto-approves consequential tier, BUT explicitly does NOT
        // authorize discard; tool handler must verify that disposableTestDoc is rejected.
        authority.setConfirmationHandler(async () => ({ confirmed: true, userAuthorizedDiscard: false }));

        // Tool execution with params claiming disposableTestDoc
        const res = await registry.execute('desktop_handle_dialog', {
            target: 'app_user_3',
            action: 'dont_save',
            disposableTestDoc: true // Claimed by model without trusted test scope
        });

        assert.equal(res.ok, false);
        assert.equal(res.status, 'execution_failed');
        assert.ok(res.error.includes('UNAUTHORIZED_DISCARD_ACTION'));

        // Document preserved
        assert.equal(manager.getTrackedApp('app_user_3').lifecycleState, 'active');
    });

    // =========================================================================
    // SCENARIO 4: Trusted user explicitly authorizes discarding a known document
    // Required: Permit only the intended discard operation
    // =========================================================================
    await suite.test('Scenario 4: Explicit user confirmation authorizes discard for the intended document', async () => {
        const { mockProc, manager, authority, registry } = createHarness();

        mockProc.setHandler('handle_dialog', (req) => {
            assert.equal(req.action, 'dont_save');
            assert.equal(req.userAuthorizedDiscard, true);
            return { handled: true, action: 'dont_save', processExited: true };
        });

        manager.trackedApps.set('app_user_4', {
            appId: 'app_user_4',
            pid: 5004,
            processName: 'notepad.exe',
            windowTitle: 'draft_memo.txt - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        let promptReceived = null;
        authority.setConfirmationHandler(async (req) => {
            promptReceived = req;
            return true; // Explicit user grant
        });

        const res = await registry.execute('desktop_handle_dialog', {
            target: 'app_user_4',
            action: 'dont_save'
        });

        assert.equal(res.ok, true);
        assert.ok(promptReceived, 'User confirmation handler must be invoked');
        assert.equal(promptReceived.target, 'app_user_4');
        assert.equal(promptReceived.action, 'dont_save');

        // Document closed and cleaned up
        assert.equal(manager.getTrackedApp('app_user_4'), null);
    });

    // =========================================================================
    // SCENARIO 5: Trusted disposable test document closed within authorized test scope
    // Required: Permit test operation within that scope
    // =========================================================================
    await suite.test('Scenario 5: Tracked disposable test document permits discard within test scope', async () => {
        const { mockProc, manager } = createHarness();

        mockProc.setHandler('handle_dialog', (req) => {
            assert.equal(req.action, 'dont_save');
            assert.equal(req.disposableTestDoc, true);
            return { handled: true, action: 'dont_save', processExited: true };
        });

        // App launched under verified test scope (recorded on internal trackedRecord)
        manager.trackedApps.set('app_test_5', {
            appId: 'app_test_5',
            pid: 5005,
            processName: 'notepad.exe',
            windowTitle: 'temp_test.txt - Notepad',
            launchedByLucy: true,
            isDisposableTest: true,
            lifecycleState: 'active'
        });

        const res = await manager.handleDialog('app_test_5', 'dont_save');
        assert.equal(res.handled, true);
        assert.equal(res.action, 'dont_save');
        assert.equal(manager.getTrackedApp('app_test_5'), null);
    });

    // =========================================================================
    // SCENARIO 6: Force termination is authorized, but discard is NOT
    // Required: Do not discard unsaved data; leave dialog/process intact or report dialog
    // =========================================================================
    await suite.test('Scenario 6: Force termination authorized without discard does NOT discard unsaved work', async () => {
        const { mockProc, manager } = createHarness();

        mockProc.setHandler('close_app', (req) => {
            // Worker detects unsaved changes and reports dialog open without discarding
            return {
                closed: false,
                dialogOpen: true,
                dialogTitle: 'Unsaved Changes',
                availableActions: ['save', 'dont_save', 'cancel']
            };
        });

        manager.trackedApps.set('app_user_6', {
            appId: 'app_user_6',
            pid: 5006,
            processName: 'notepad.exe',
            windowTitle: 'important_data.txt - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // User asks to close with force, but does NOT authorize discarding data
        const res = await manager.closeApp('app_user_6', { force: true });

        // Must report dialogOpen: true, closed: false. Must NOT discard!
        assert.equal(res.closed, false);
        assert.equal(res.dialogOpen, true);
        assert.ok(manager.getTrackedApp('app_user_6'), 'Application must remain tracked');
    });

    // =========================================================================
    // SCENARIO 7: Dialog meaning is ambiguous
    // Required: Fail closed and request reconciliation
    // =========================================================================
    await suite.test('Scenario 7: Ambiguous confirmation dialog fails closed and routes to reconciliation', async () => {
        const { manager } = createHarness();

        manager.trackedApps.set('app_user_7', {
            appId: 'app_user_7',
            pid: 5007,
            processName: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        await assert.rejects(async () => {
            await manager.handleDialog('app_user_7', 'dont_save', { isAmbiguous: true });
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_CONFIRMATION_DIALOG');
            return true;
        });

        const engine = new TaskRecoveryEngine();
        const classification = engine.classifyFailure(
            { code: 'AMBIGUOUS_CONFIRMATION_DIALOG', message: 'Ambiguous dialog intent' },
            { step: { isConsequential: true, idempotent: false } }
        );

        assert.equal(classification.type, FAILURE_TYPES.TIMEOUT_UNCERTAIN);
        assert.equal(classification.suggestedStrategy, RECOVERY_STRATEGIES.AWAIT_RECONCILIATION);
        assert.equal(classification.recoverable, false);
    });

    // =========================================================================
    // SCENARIO 8: User cancels while authorization is pending
    // Required: Stop subsequent actions and preserve checkpoints
    // =========================================================================
    await suite.test('Scenario 8: Cancellation while confirmation is pending halts fail-closed', async () => {
        const { manager, authority, registry } = createHarness();

        manager.trackedApps.set('app_user_8', {
            appId: 'app_user_8',
            pid: 5008,
            processName: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Cancellation signal
        const controller = new AbortController();

        authority.setConfirmationHandler(async () => {
            controller.abort(); // Cancel during prompt
            const err = new Error('User clicked cancel');
            err.code = 'CONFIRMATION_CANCELLED';
            throw err;
        });

        const res = await registry.execute('desktop_handle_dialog', {
            target: 'app_user_8',
            action: 'dont_save'
        }, { signal: controller.signal });

        assert.equal(res.ok, false);
        assert.equal(res.status, 'permission_denied');

        // Document preserved
        assert.equal(manager.getTrackedApp('app_user_8').lifecycleState, 'active');
    });

    // =========================================================================
    // SCENARIO 9: Authorization for one application/document is reused against another
    // Required: Reject the mismatched target
    // =========================================================================
    await suite.test('Scenario 9: Authorization for Target A cannot be reused against Target B', async () => {
        const { manager, authority, registry } = createHarness();

        manager.trackedApps.set('app_target_A', {
            appId: 'app_target_A',
            pid: 5009,
            processName: 'notepad.exe',
            windowTitle: 'Document A - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        manager.trackedApps.set('app_target_B', {
            appId: 'app_target_B',
            pid: 5010,
            processName: 'notepad.exe',
            windowTitle: 'Document B - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Stale permission decision that authorized Target A
        const staleDecisionForA = {
            permitted: true,
            requiresConfirmation: true,
            action: 'dont_save',
            target: 'app_target_A' // Specifically granted for Target A
        };

        // Model attempts to invoke handle_dialog on Target B using decision from Target A
        await assert.rejects(async () => {
            await manager.handleDialog('app_target_B', 'dont_save', {
                authorizedTarget: staleDecisionForA.target,
                userAuthorizedDiscard: true
            });
        }, (err) => {
            assert.equal(err.code, 'TARGET_AUTHORIZATION_MISMATCH');
            assert.ok(err.message.includes('app_target_A'));
            assert.ok(err.message.includes('app_target_B'));
            return true;
        });

        // RecoveryEngine classification
        const engine = new TaskRecoveryEngine();
        const classification = engine.classifyFailure(
            { code: 'TARGET_AUTHORIZATION_MISMATCH', message: 'Target mismatch' },
            { step: { isConsequential: true } }
        );
        assert.equal(classification.type, FAILURE_TYPES.PERMISSION_DENIED);
        assert.equal(classification.recoverable, false);
        assert.equal(classification.suggestedStrategy, RECOVERY_STRATEGIES.FAIL_CLOSED);

        // Both documents remain active and safe
        assert.ok(manager.getTrackedApp('app_target_A'));
        assert.ok(manager.getTrackedApp('app_target_B'));
    });

    // =========================================================================
    // SCENARIO 10: Model attempts to bypass gate through alternative tool arguments
    // Required: Enforce the same authorization invariant
    // =========================================================================
    await suite.test('Scenario 10: Model alternative bypass arguments fail closed', async () => {
        const { manager, authority, registry } = createHarness();
        authority.setConfirmationHandler(async () => ({ confirmed: true, userAuthorizedDiscard: false }));

        manager.trackedApps.set('app_user_10', {
            appId: 'app_user_10',
            pid: 5011,
            processName: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Bypass attempt 1: desktop_close_app with savePolicy: 'dont_save' and force: true
        const bypass1 = await registry.execute('desktop_close_app', {
            target: 'app_user_10',
            savePolicy: 'dont_save',
            force: true
        });
        assert.equal(bypass1.ok, false);
        assert.ok(bypass1.error.includes('UNAUTHORIZED_DISCARD_ACTION'));

        // Bypass attempt 2: desktop_handle_dialog with allowForceKill: true and force: true
        const bypass2 = await registry.execute('desktop_handle_dialog', {
            target: 'app_user_10',
            action: 'dont_save',
            force: true,
            allowForceKill: true
        });
        assert.equal(bypass2.ok, false);
        assert.ok(bypass2.error.includes('UNAUTHORIZED_DISCARD_ACTION'));

        // Document remains protected
        assert.ok(manager.getTrackedApp('app_user_10'));
    });
});
