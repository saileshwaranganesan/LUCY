'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { DesktopAutomationManager, SAFE_APP_ALLOWLIST, INTERACTION_MODES } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { ResultVerifier, VERIFICATION_STATUSES } = require('../../src/core/result-verifier.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { verifyWorkerBinary, resolveExeFile } = require('../../src/tools/native-uia/build-worker.js');

/**
 * Controlled mock process for LucyUiaWorker that simulates IPC responses
 * with deterministic behavior for all resolution, recovery, and postcondition scenarios.
 */
class MockWorkerProcess extends EventEmitter {
    constructor() {
        super();
        this.stdin = {
            write: (chunk) => this._handleInput(chunk)
        };
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.killed = false;
        this.handlers = new Map();
        this.defaultHandler = null;

        // Auto-emit ready on next tick
        process.nextTick(() => {
            this._sendOutput({ status: 'ready', engine: 'Mock-Lucy-UIA', version: '1.0.0' });
        });
    }

    _sendOutput(obj) {
        this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
    }

    _handleInput(chunk) {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const req = JSON.parse(trimmed);
                if (req.cmd === 'init_session') {
                    this._sendOutput({ id: req.id, ok: true, result: { initialized: true } });
                    continue;
                }

                if (this.handlers.has(req.cmd)) {
                    const fn = this.handlers.get(req.cmd);
                    const res = fn(req);
                    if (res === undefined) {
                        // Simulate hanging/timeout by not sending any output
                        return;
                    }
                    if (res && res.__raw) {
                        this._sendOutput(res.payload);
                    } else if (res && res.error) {
                        this._sendOutput({ id: req.id, ok: false, error: res.error });
                    } else {
                        this._sendOutput({ id: req.id, ok: true, result: res });
                    }
                } else if (this.defaultHandler) {
                    const res = this.defaultHandler(req);
                    this._sendOutput({ id: req.id, ok: !res?.error, result: res?.result, error: res?.error });
                } else {
                    this._sendOutput({ id: req.id, ok: true, result: { verified: true } });
                }
            } catch (err) {
                // Malformed request input
                this._sendOutput({ id: 0, ok: false, error: `Malformed worker JSON: ${err.message}` });
            }
        }
    }

    setHandler(cmd, fn) {
        this.handlers.set(cmd, fn);
    }

    kill() {
        this.killed = true;
        this.emit('close', 0);
    }
}

/**
 * Creates a DesktopAutomationManager with an injected mock worker.
 */
function createMockManager(options = {}) {
    const mockProc = new MockWorkerProcess();
    const manager = new DesktopAutomationManager({
        timeoutMs: options.timeoutMs || 1000,
        interactionMode: options.interactionMode || INTERACTION_MODES.NON_INTRUSIVE
    });
    manager.proc = mockProc;
    manager.isReady = true;
    manager.readyPromise = Promise.resolve();

    mockProc.stdout.on('data', (chunk) => {
        manager._handleStdout(chunk, () => {}, () => {}, null);
    });

    // Register a tracked app for ownership assertions
    const testApp = {
        appId: 'app_1234',
        pid: 1234,
        windowHandle: 99991,
        windowTitle: 'Test Target Window',
        exe: 'C:\\Windows\\System32\\notepad.exe',
        launchedByLucy: true,
        lifecycleState: 'active',
        taskId: options.taskId || 'task_test_1',
        processStartTime: '2026-10-24T00:00:00.000Z',
        authToken: 'mock_auth_token_1234'
    };
    manager.trackedApps.set('app_1234', testApp);

    return { manager, mockProc, testApp };
}

test('Desktop UIA Target Resolution, Dynamic Recovery & Verified Execution Suite', async (suite) => {

    // ----------------------------------------------------------------------------------
    // Case 1: Exact AutomationId match in the correct window
    // ----------------------------------------------------------------------------------
    await suite.test('1. Exact AutomationId match in the correct window', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            assert.equal(req.automationId, 'save_button');
            assert.equal(req.pid, 1234);
            return {
                matched: true,
                success: true,
                strategy: 'exact_automation_id',
                attempts: 1,
                resolvedTarget: {
                    name: 'Save Document',
                    automationId: 'save_button',
                    controlType: 'Button',
                    className: 'Button',
                    isEnabled: true,
                    bounds: { x: 100, y: 150, width: 80, height: 30 }
                },
                rejectedCandidates: []
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            automationId: 'save_button',
            action: 'click',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, true);
        assert.equal(receipt.matched, true);
        assert.equal(receipt.strategy, 'exact_automation_id');
        assert.equal(receipt.attempts, 1);
        assert.equal(receipt.resolvedTarget.automationId, 'save_button');
        assert.equal(receipt.resolvedTarget.bounds.x, 100);
    });

    // ----------------------------------------------------------------------------------
    // Case 2: Missing or stale AutomationId with a unique, structurally valid semantic match
    // ----------------------------------------------------------------------------------
    await suite.test('2. Missing or stale AutomationId with a unique semantic match', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            assert.equal(req.name, 'Save');
            assert.equal(req.controlType, 'Button');
            return {
                matched: true,
                success: true,
                strategy: 'semantic_structural_match',
                attempts: 1,
                resolvedTarget: {
                    name: 'Save',
                    automationId: '', // AutomationId is empty/missing on target control
                    controlType: 'Button',
                    className: 'WPFButton',
                    isEnabled: true,
                    bounds: { x: 200, y: 300, width: 75, height: 25 }
                },
                rejectedCandidates: []
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            name: 'Save',
            controlType: 'Button',
            action: 'click',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, true);
        assert.equal(receipt.strategy, 'semantic_structural_match');
        assert.equal(receipt.resolvedTarget.name, 'Save');
    });

    // ----------------------------------------------------------------------------------
    // Case 3: Duplicate control names in the same window (Ambiguity Check)
    // ----------------------------------------------------------------------------------
    await suite.test('3. Duplicate control names in the same window fails closed (AMBIGUOUS_TARGET)', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            return {
                matched: false,
                success: false,
                strategy: 'none',
                attempts: 1,
                ambiguityCount: 2,
                errorCode: 'AMBIGUOUS_TARGET',
                errorMessage: "AMBIGUOUS_TARGET: Multiple (2) elements matched semantic Name 'Close' within target window.",
                resolvedTarget: null,
                rejectedCandidates: ['Duplicate candidate A', 'Duplicate candidate B']
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            name: 'Close',
            action: 'click',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, false);
        assert.equal(receipt.matched, false);
        assert.equal(receipt.errorCode, 'AMBIGUOUS_TARGET');
        assert.equal(receipt.ambiguityCount, 2);
        assert.equal(receipt.resolvedTarget, null);
    });

    // ----------------------------------------------------------------------------------
    // Case 4: Identical names in different windows (Window Scope Isolation)
    // ----------------------------------------------------------------------------------
    await suite.test('4. Identical names in different windows: constrained strictly to target window', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            // Worker enforces that search is strictly constrained to the authorized windowHandle
            assert.equal(req.windowHandle, 99991);
            return {
                matched: true,
                success: true,
                strategy: 'exact_automation_id',
                attempts: 1,
                resolvedTarget: {
                    name: 'Options',
                    automationId: 'btn_options',
                    controlType: 'Button',
                    bounds: { x: 50, y: 50, width: 100, height: 30 }
                },
                rejectedCandidates: []
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            name: 'Options',
            automationId: 'btn_options',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, true);
        assert.equal(receipt.resolvedTarget.name, 'Options');
    });

    // ----------------------------------------------------------------------------------
    // Case 5: A matching control in the wrong process
    // ----------------------------------------------------------------------------------
    await suite.test('5. Matching control in the wrong process is rejected fail-closed', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            return {
                matched: false,
                success: false,
                errorCode: 'WRONG_PROCESS',
                errorMessage: 'WRONG_PROCESS: Candidate belongs to PID 9999, not target PID 1234',
                rejectedCandidates: ['WRONG_PROCESS: Candidate belongs to PID 9999, not target PID 1234']
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            automationId: 'btn_target',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, false);
        assert.equal(receipt.errorCode, 'WRONG_PROCESS');
        assert.ok(receipt.rejectedCandidates[0].includes('WRONG_PROCESS'));
    });

    // ----------------------------------------------------------------------------------
    // Case 6: A candidate outside the authorized target-window bounds
    // ----------------------------------------------------------------------------------
    await suite.test('6. Candidate outside authorized target-window bounds is rejected', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            return {
                matched: false,
                success: false,
                errorCode: 'OUTSIDE_WINDOW_BOUNDS',
                errorMessage: 'OUTSIDE_WINDOW_BOUNDS: Target control was located outside the authorized target window bounds.',
                rejectedCandidates: ['OUTSIDE_WINDOW_BOUNDS: Candidate bounds are outside window bounds']
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            name: 'Offscreen Button',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, false);
        assert.equal(receipt.errorCode, 'OUTSIDE_WINDOW_BOUNDS');
    });

    // ----------------------------------------------------------------------------------
    // Case 7: Localized window or control names
    // ----------------------------------------------------------------------------------
    await suite.test('7. Localized control names (UTF-8 unicode) match accurately without assumptions', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            assert.equal(req.name, 'Enregistrer');
            return {
                matched: true,
                success: true,
                strategy: 'semantic_structural_match',
                attempts: 1,
                resolvedTarget: {
                    name: 'Enregistrer',
                    controlType: 'Button',
                    isEnabled: true
                }
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            name: 'Enregistrer',
            controlType: 'Button',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, true);
        assert.equal(receipt.resolvedTarget.name, 'Enregistrer');
    });

    // ----------------------------------------------------------------------------------
    // Case 8: Virtualized controls that disappear and are recreated (Dynamic Anchor Recovery)
    // ----------------------------------------------------------------------------------
    await suite.test('8. Virtualized controls recovering across retry loop (dynamic_anchor_recovered)', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            return {
                matched: true,
                success: true,
                strategy: 'dynamic_anchor_recovered',
                attempts: 2,
                resolvedTarget: {
                    name: 'ListItem 42',
                    automationId: 'item_42',
                    controlType: 'ListItem',
                    isEnabled: true
                },
                rejectedCandidates: ['ELEMENT_STALE: Element reference is invalid or stale']
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            automationId: 'item_42',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, true);
        assert.equal(receipt.strategy, 'dynamic_anchor_recovered');
        assert.equal(receipt.attempts, 2);
        assert.ok(receipt.rejectedCandidates[0].includes('ELEMENT_STALE'));
    });

    // ----------------------------------------------------------------------------------
    // Case 9: Stale bounding rectangles after a window moves or resizes
    // ----------------------------------------------------------------------------------
    await suite.test('9. Fresh geometry recalculation rejects stale cached coordinates', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            assert.deepEqual(req.expectedBoundingBox, [100, 100, 50, 50]);
            // Returns current fresh geometry reflecting window move to (400, 400)
            return {
                matched: true,
                success: true,
                strategy: 'semantic_structural_match',
                attempts: 1,
                resolvedTarget: {
                    name: 'OK',
                    automationId: 'btn_ok',
                    controlType: 'Button',
                    bounds: { x: 400, y: 400, width: 50, height: 50 },
                    windowBounds: { x: 350, y: 350, width: 800, height: 600 }
                }
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            name: 'OK',
            expectedBoundingBox: [100, 100, 50, 50],
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, true);
        assert.equal(receipt.resolvedTarget.bounds.x, 400); // Fresh coordinates
    });

    // ----------------------------------------------------------------------------------
    // Case 10: Target that changes between resolution and execution
    // ----------------------------------------------------------------------------------
    await suite.test('10. Target changing to disabled between resolution and execution fails closed', async () => {
        const { manager, mockProc } = createMockManager();

        // Target initially resolved, but click_element re-checks state and fails closed
        mockProc.setHandler('click_element', (req) => {
            return {
                error: 'ELEMENT_DISABLED: Target control was found but is disabled and cannot accept interaction.'
            };
        });

        await assert.rejects(async () => {
            await manager.clickElement('app_1234', {
                name: 'Submit',
                automationId: 'btn_submit'
            }, { taskId: 'task_test_1' });
        }, /ELEMENT_DISABLED/);
    });

    // ----------------------------------------------------------------------------------
    // Case 11: A disabled or non-interactable candidate
    // ----------------------------------------------------------------------------------
    await suite.test('11. Disabled candidate rejected during resolution for interactive actions', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            assert.equal(req.action, 'click');
            return {
                matched: false,
                success: false,
                errorCode: 'ELEMENT_DISABLED',
                errorMessage: "ELEMENT_DISABLED: Target control was found but is disabled and cannot accept interaction.",
                rejectedCandidates: ["ELEMENT_DISABLED: Candidate 'btn_next' is disabled."]
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            automationId: 'btn_next',
            action: 'click',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, false);
        assert.equal(receipt.errorCode, 'ELEMENT_DISABLED');
    });

    // ----------------------------------------------------------------------------------
    // Case 12: Visually similar decoy with incompatible UIA semantics
    // ----------------------------------------------------------------------------------
    await suite.test('12. Visually similar decoy with incompatible UIA semantics rejected (CONTROL_INCOMPATIBLE)', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            return {
                matched: false,
                success: false,
                errorCode: 'CONTROL_INCOMPATIBLE',
                errorMessage: "CONTROL_INCOMPATIBLE: Control does not support Invoke, Toggle, SelectionItem, ExpandCollapse, or BM_CLICK patterns",
                rejectedCandidates: ["CONTROL_INCOMPATIBLE: Control does not support Invoke, Toggle, SelectionItem, ExpandCollapse, or BM_CLICK patterns"]
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            name: 'Delete All',
            action: 'click',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, false);
        assert.equal(receipt.errorCode, 'CONTROL_INCOMPATIBLE');
    });

    // ----------------------------------------------------------------------------------
    // Case 13: Multiple equally plausible candidates
    // ----------------------------------------------------------------------------------
    await suite.test('13. Multiple equally plausible candidates fail closed without arbitrary guessing', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', (req) => {
            return {
                matched: false,
                success: false,
                ambiguityCount: 3,
                errorCode: 'AMBIGUOUS_TARGET',
                errorMessage: "AMBIGUOUS_TARGET: Multiple (3) elements matched criteria within target window.",
                rejectedCandidates: ['Candidate 1', 'Candidate 2', 'Candidate 3']
            };
        });

        const receipt = await manager.resolveTarget('app_1234', {
            controlType: 'Button',
            action: 'click',
            taskId: 'task_test_1'
        });

        assert.equal(receipt.success, false);
        assert.equal(receipt.errorCode, 'AMBIGUOUS_TARGET');
        assert.equal(receipt.ambiguityCount, 3);
    });

    // ----------------------------------------------------------------------------------
    // Case 14: Candidate whose control type is incompatible with requested action
    // ----------------------------------------------------------------------------------
    await suite.test('14. Candidate whose control type is incompatible with action fails closed', async () => {
        const { manager, mockProc } = createMockManager();

        // Attempting to type into a Button
        mockProc.setHandler('type_text', (req) => {
            return {
                error: "CONTROL_INCOMPATIBLE: Control of type 'ControlType.Button' is not an editable field for text entry"
            };
        });

        await assert.rejects(async () => {
            await manager.typeText('app_1234', 'Hello', {
                automationId: 'btn_submit',
                taskId: 'task_test_1'
            });
        }, /CONTROL_INCOMPATIBLE/);
    });

    // ----------------------------------------------------------------------------------
    // Case 15: Permission denial after successful target resolution
    // ----------------------------------------------------------------------------------
    await suite.test('15. Permission denial after successful target resolution halts fail-closed', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('resolve_target', () => ({
            matched: true,
            success: true,
            strategy: 'exact_automation_id',
            resolvedTarget: { name: 'Dangerous Action', automationId: 'btn_dangerous' }
        }));

        // 1. Target resolution succeeds (read-only)
        const receipt = await manager.resolveTarget('app_1234', {
            automationId: 'btn_dangerous',
            taskId: 'task_test_1'
        });
        assert.equal(receipt.success, true);

        // 2. Action authorization evaluation through PermissionAuthority strictly fails closed
        const authority = new PermissionAuthority({ mode: PERMISSION_MODES.STRICT });
        const evalRes = await authority.evaluate({
            toolId: 'desktop_click_element',
            action: 'click',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            params: {
                target: 'app_1234',
                automationId: 'btn_dangerous'
            }
        });

        assert.equal(evalRes.permitted, false);
        assert.equal(evalRes.requiresConfirmation, true);
    });

    // ----------------------------------------------------------------------------------
    // Case 16: A consequential action requiring confirmation
    // ----------------------------------------------------------------------------------
    await suite.test('16. Consequential action strictly requires user confirmation', async () => {
        const registry = new ToolRegistry();
        const { manager } = createMockManager();
        registerDesktopTools(registry, manager);

        const clickTool = registry.getTool('desktop_click_element');
        assert.equal(clickTool.riskTier, RISK_TIERS.CONSEQUENTIAL);

        const authority = new PermissionAuthority({ mode: PERMISSION_MODES.STANDARD });
        const evalRes = await authority.evaluate({
            toolId: 'desktop_click_element',
            action: 'click',
            riskTier: clickTool.riskTier,
            params: {
                target: 'app_1234',
                name: 'Delete File'
            }
        });

        assert.equal(evalRes.permitted, false);
        assert.equal(evalRes.requiresConfirmation, true);
    });

    // ----------------------------------------------------------------------------------
    // Case 17: Cancellation during target recovery
    // ----------------------------------------------------------------------------------
    await suite.test('17. Cancellation during target recovery halts immediately (CANCELLED)', async () => {
        const { manager } = createMockManager();
        const ac = new AbortController();
        ac.abort();

        await assert.rejects(async () => {
            await manager.resolveTarget('app_1234', { name: 'CancelMe' }, {
                signal: ac.signal,
                taskId: 'task_test_1'
            });
        }, (err) => {
            assert.equal(err.code, 'CANCELLED');
            return true;
        });
    });

    // ----------------------------------------------------------------------------------
    // Case 18: Timeout during target recovery
    // ----------------------------------------------------------------------------------
    await suite.test('18. Timeout during target recovery triggers structured failure', async () => {
        const { manager, mockProc } = createMockManager({ timeoutMs: 50 });

        mockProc.setHandler('resolve_target', () => {
            // Never responds to simulate hanging recovery
            return undefined;
        });

        await assert.rejects(async () => {
            await manager.resolveTarget('app_1234', { name: 'HangingControl' }, { taskId: 'task_test_1' });
        }, /timed out/i);
    });

    // ----------------------------------------------------------------------------------
    // Case 19: Late worker response after request has timed out or been superseded
    // ----------------------------------------------------------------------------------
    await suite.test('19. Late worker response after timeout is dropped and cannot overwrite state', async () => {
        const { manager, mockProc } = createMockManager({ timeoutMs: 30 });

        let capturedReqId = 0;
        mockProc.setHandler('resolve_target', (req) => {
            capturedReqId = req.id;
            // Delay sending response until after manager timed out
            setTimeout(() => {
                mockProc._sendOutput({
                    id: capturedReqId,
                    ok: true,
                    result: { success: true, matched: true, strategy: 'late_compromise' }
                });
            }, 60);
            return undefined;
        });

        await assert.rejects(async () => {
            await manager.resolveTarget('app_1234', { name: 'LateControl' }, { taskId: 'task_test_1' });
        }, /timed out/i);

        // Wait for late response to arrive on mockProc stdout
        await new Promise(r => setTimeout(r, 80));

        // Invariant: pendingRequests is clean, late response was safely ignored
        assert.equal(manager.pendingRequests.has(capturedReqId), false);
    });

    // ----------------------------------------------------------------------------------
    // Case 20: Postcondition that confirms success
    // ----------------------------------------------------------------------------------
    await suite.test('20. Postcondition confirms success and returns verified receipt', async () => {
        const { manager, mockProc } = createMockManager();
        const verifier = new ResultVerifier();

        mockProc.setHandler('click_element', () => ({
            verified: true,
            postconditionStatus: 'VERIFIED',
            postconditionDetail: 'ToggleState transitioned from Off to On',
            action: 'toggled',
            name: 'Enable Audio',
            controlType: 'CheckBox'
        }));

        const result = await manager.clickElement('app_1234', { name: 'Enable Audio' }, { taskId: 'task_test_1' });
        assert.equal(result.verified, true);
        assert.equal(result.postconditionStatus, 'VERIFIED');

        const verification = await verifier.verify({ toolId: 'desktop_click_element', params: { target: 'app_1234' } }, result);
        assert.equal(verification.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(verification.verified, true);
    });

    // ----------------------------------------------------------------------------------
    // Case 21: Postcondition that confirms failure
    // ----------------------------------------------------------------------------------
    await suite.test('21. Postcondition confirms failure when state transition does not occur', async () => {
        const { manager, mockProc } = createMockManager();
        const verifier = new ResultVerifier();

        mockProc.setHandler('click_element', () => ({
            verified: false,
            postconditionStatus: 'FAILED',
            postconditionDetail: 'ToggleState failed to transition: remained Off',
            action: 'toggled',
            name: 'Mute Microphone',
            controlType: 'CheckBox'
        }));

        const result = await manager.clickElement('app_1234', { name: 'Mute Microphone' }, { taskId: 'task_test_1' });
        assert.equal(result.verified, false);
        assert.equal(result.postconditionStatus, 'FAILED');

        const verification = await verifier.verify({ toolId: 'desktop_click_element', params: { target: 'app_1234' } }, result);
        assert.equal(verification.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(verification.verified, false);
    });

    // ----------------------------------------------------------------------------------
    // Case 22: Postcondition that cannot establish the outcome (UNVERIFIABLE)
    // ----------------------------------------------------------------------------------
    await suite.test('22. Postcondition that cannot establish outcome reports INCONCLUSIVE', async () => {
        const { manager, mockProc } = createMockManager();
        const verifier = new ResultVerifier();

        mockProc.setHandler('click_element', () => ({
            verified: false,
            postconditionStatus: 'UNVERIFIABLE',
            postconditionDetail: 'Provider exposes no state transition',
            action: 'clicked'
        }));

        const result = await manager.clickElement('app_1234', { name: 'CustomControl' }, { taskId: 'task_test_1' });
        assert.equal(result.postconditionStatus, 'UNVERIFIABLE');

        const verification = await verifier.verify({ toolId: 'desktop_click_element', params: { target: 'app_1234' } }, result);
        assert.equal(verification.status, VERIFICATION_STATUSES.INCONCLUSIVE);
        assert.equal(verification.verified, false);
    });

    // ----------------------------------------------------------------------------------
    // Case 23: An uncertain consequential action that must not be retried
    // ----------------------------------------------------------------------------------
    await suite.test('23. Uncertain consequential action preserves AWAITING_RECONCILIATION and is never retried', async () => {
        const registry = new ToolRegistry();
        const { manager } = createMockManager();
        registerDesktopTools(registry, manager);
        const clickTool = registry.getTool('desktop_click_element');
        assert.equal(clickTool.riskTier, RISK_TIERS.CONSEQUENTIAL);

        const authority = new PermissionAuthority();
        const evalRes = await authority.evaluate({
            toolId: 'desktop_click_element',
            action: 'click',
            riskTier: clickTool.riskTier,
            params: { target: 'app_1234', name: 'Submit Purchase' }
        });
        assert.equal(evalRes.requiresConfirmation, true);

        // Verification receipt with inconclusive status must preserve fail-closed state
        const verifier = new ResultVerifier();
        const inconclusiveReceipt = {
            ok: true,
            postconditionStatus: 'UNVERIFIABLE',
            verified: false
        };

        const v = await verifier.verify({
            toolId: 'desktop_click_element',
            params: { target: 'app_1234', name: 'Submit Purchase' }
        }, inconclusiveReceipt);

        assert.equal(v.status, VERIFICATION_STATUSES.INCONCLUSIVE);
        assert.equal(v.verified, false);
    });

    // ----------------------------------------------------------------------------------
    // Case 24: Malformed worker requests and unexpected provider errors
    // ----------------------------------------------------------------------------------
    await suite.test('24. Malformed worker requests produce structured errors without crashing worker', async () => {
        const { manager, mockProc } = createMockManager();

        mockProc.setHandler('click_element', (req) => {
            return {
                error: 'COM_EXCEPTION: (0x80040154) Class not registered'
            };
        });

        await assert.rejects(async () => {
            await manager.clickElement('app_1234', { name: 'BadElem' }, { taskId: 'task_test_1' });
        }, /COM_EXCEPTION/);

        // Worker remains ready and able to handle subsequent commands
        assert.equal(manager.isReady, true);
    });

    // ----------------------------------------------------------------------------------
    // Case 25: Secret redaction in recovery receipts and diagnostics
    // ----------------------------------------------------------------------------------
    await suite.test('25. Secret redaction in receipts, readText, and diagnostics', async () => {
        const { manager, mockProc } = createMockManager();
        const verifier = new ResultVerifier();

        mockProc.setHandler('type_text', (req) => {
            assert.equal(req.isSecret, true);
            return {
                verified: true,
                postconditionStatus: 'VERIFIED',
                method: 'ValuePattern',
                readText: '[REDACTED]',
                isSecret: true
            };
        });

        const result = await manager.typeText('app_1234', 'SuperSecretPassword123!', {
            isSecret: true,
            taskId: 'task_test_1'
        });

        assert.equal(result.isSecret, true);
        assert.equal(result.readText, '[REDACTED]');
        assert.ok(!JSON.stringify(result).includes('SuperSecretPassword123!'));

        // Verify result verifier redacts secret text
        const verification = await verifier.verify({
            toolId: 'desktop_type_text',
            params: { target: 'app_1234', text: 'SuperSecretPassword123!', isSecret: true }
        }, result);

        assert.equal(verification.verified, true);
        assert.ok(!JSON.stringify(verification).includes('SuperSecretPassword123!'));
    });

    // ----------------------------------------------------------------------------------
    // Case 26: Worker build or packaging check that detects a stale or missing executable
    // ----------------------------------------------------------------------------------
    await suite.test('26. Worker build and packaging verification detects missing or stale executable', () => {
        // 1. Missing executable check
        const missingCheck = verifyWorkerBinary(path.join(os.tmpdir(), 'non_existent_worker.exe'));
        assert.equal(missingCheck.valid, false);
        assert.ok(missingCheck.error.includes('does not exist'));

        // 2. Virtual ASAR path check
        const virtualCheck = verifyWorkerBinary('C:\\app\\resources\\app.asar\\src\\tools\\native-uia\\LucyUiaWorker.exe');
        assert.equal(virtualCheck.valid, false);
        assert.ok(virtualCheck.error.includes('unspawnable virtual ASAR path'));

        // 3. Real compiled binary check
        const realExe = resolveExeFile();
        if (fs.existsSync(realExe)) {
            const realCheck = verifyWorkerBinary(realExe);
            assert.equal(realCheck.valid, true);
            assert.ok(realCheck.length > 1024);
            assert.ok(['x86', 'x64', 'arm64'].includes(realCheck.architecture));
            assert.ok(typeof realCheck.hash === 'string' && realCheck.hash.length === 64);
        }
    });

    // ----------------------------------------------------------------------------------
    // Case 27: Regression coverage for reconciliation, concurrency, authorization, and continuity
    // ----------------------------------------------------------------------------------
    await suite.test('27. Regression coverage: Single authority model, task boundary isolation, and fail-closed reconciliation', async () => {
        const { manager } = createMockManager({ taskId: 'task_alpha' });

        // A. Cross-task mutation violation: task_beta cannot modify app owned by task_alpha
        assert.throws(() => {
            manager.assertOwnership('app_1234', { taskId: 'task_beta', action: 'click_element' });
        }, /TASK_BOUNDARY_VIOLATION/);

        // B. Protected IDE process safety boundary
        assert.throws(() => {
            manager.assertOwnership('antigravity', { taskId: 'task_alpha', action: 'click_element' });
        }, /SAFETY_VIOLATION/);

        // C. Ambiguous application ownership
        manager.trackedApps.set('app_5678', {
            appId: 'app_5678',
            pid: 5678,
            windowTitle: 'Test Target Window',
            exe: 'C:\\Windows\\System32\\notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active',
            taskId: 'task_alpha'
        });

        assert.throws(() => {
            // Target by common window title matches both app_1234 and app_5678
            manager.assertOwnership('Test Target Window', { taskId: 'task_alpha', action: 'click_element' });
        }, /AMBIGUOUS_APPLICATION_OWNERSHIP/);
    });

});
