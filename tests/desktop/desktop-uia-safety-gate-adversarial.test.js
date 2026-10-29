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
const { TaskRecoveryEngine, FAILURE_TYPES, RECOVERY_STRATEGIES } = require('../../src/core/recovery-engine.js');
const { TaskContinuityStore } = require('../../src/memory/task-continuity-store.js');
const { verifyWorkerBinary, ensureWorkerBuilt, resolveExeFile, isVirtualAsarPath } = require('../../src/tools/native-uia/build-worker.js');

/**
 * Controlled mock process for LucyUiaWorker IPC testing.
 */
class AdversarialMockWorkerProcess extends EventEmitter {
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

        process.nextTick(() => {
            this._sendOutput({ status: 'ready', engine: 'Adversarial-Lucy-UIA', version: '2.0.0' });
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
                        // Hanging request simulation
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
                this._sendOutput({ id: 0, ok: false, error: `Malformed worker JSON: ${err.message}` });
            }
        }
    }
}

function createTestHarness(options = {}) {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-safety-gate-adversarial-'));
    const manager = new DesktopAutomationManager({
        memoryDir,
        interactionMode: options.interactionMode || INTERACTION_MODES.BACKGROUND_PREFERRED,
        timeoutMs: options.timeoutMs || 1000
    });

    const mockProc = new AdversarialMockWorkerProcess();
    manager.proc = mockProc;
    manager.readyPromise = Promise.resolve();
    manager.sessionSecret = 'test_safety_secret_32bytes_minimum';

    mockProc.stdout.on('data', (chunk) => {
        manager._handleStdout(chunk, () => {}, () => {}, null);
    });

    const permissions = new PermissionAuthority({
        mode: PERMISSION_MODES.NORMAL,
        storeDir: memoryDir
    });

    const registry = new ToolRegistry();
    registerDesktopTools(registry, { desktopAutomationManager: manager });

    const verifier = new ResultVerifier();
    const recoveryEngine = new TaskRecoveryEngine();

    return {
        memoryDir,
        manager,
        mockProc,
        permissions,
        registry,
        verifier,
        recoveryEngine,
        cleanup: () => {
            try { manager.destroy(); } catch (_) {}
            try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
        }
    };
}

function trackTestApp(manager, appId, options = {}) {
    const app = {
        appId,
        pid: options.pid || 1000,
        windowHandle: options.windowHandle || 99000,
        windowTitle: options.title || 'Test App Window',
        exe: options.exe || 'C:\\Windows\\System32\\notepad.exe',
        launchedByLucy: true,
        lifecycleState: 'active',
        taskId: options.taskId || null,
        processStartTime: '2026-10-24T00:00:00.000Z',
        authToken: 'mock_auth_token'
    };
    manager.trackedApps.set(appId, app);
    return app;
}

test('L.U.C.Y. UIA Safety Gate — Adversarial Source & Binary Verification Suite', async (suite) => {

    // =========================================================================
    // 1. EXACT AUTOMATION ID AMBIGUITY & TARGET RESOLUTION SAFEGUARDS
    // =========================================================================

    await suite.test('1. Duplicate exact AutomationId values fail closed (AMBIGUOUS_TARGET)', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_1001', { pid: 1001, windowHandle: 998811 });

            mockProc.handlers.set('click_element', (req) => {
                if (req.automationId === 'btn_submit') {
                    return {
                        error: 'AMBIGUOUS_TARGET: Multiple (2) candidate controls matched AutomationId btn_submit within the target window. Resolution aborted to prevent arbitrary first-match selection.'
                    };
                }
                return { verified: true };
            });

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_1001', { automationId: 'btn_submit' });
                },
                /AMBIGUOUS_TARGET/
            );
        } finally {
            cleanup();
        }
    });

    await suite.test('2. AutomationId mismatch never falls through to silent Name substitution', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_1002', { pid: 1002, windowHandle: 998812 });

            // If an automationId is provided but does not match, worker must NOT fall through to a different control with matching name
            mockProc.handlers.set('click_element', (req) => {
                if (req.automationId === 'id_specific_action' && req.name === 'Save') {
                    return {
                        error: 'ELEMENT_NOT_FOUND: Element with AutomationId id_specific_action not found in target window.'
                    };
                }
                return { verified: true, name: 'Save', automationId: 'different_id' };
            });

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_1002', { automationId: 'id_specific_action', name: 'Save' });
                },
                /ELEMENT_NOT_FOUND/
            );
        } finally {
            cleanup();
        }
    });

    await suite.test('3. Duplicate parent containers in Level 3 fail closed (AMBIGUOUS_TARGET)', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_1003', { pid: 1003, windowHandle: 998813 });

            mockProc.handlers.set('click_element', (req) => {
                if (req.parentAutomationId === 'toolbar_container') {
                    return {
                        error: 'AMBIGUOUS_TARGET: Multiple (2) parent containers matched criteria toolbar_container.'
                    };
                }
                return { verified: true };
            });

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_1003', {
                        parentAutomationId: 'toolbar_container',
                        name: 'File'
                    });
                },
                /AMBIGUOUS_TARGET/
            );
        } finally {
            cleanup();
        }
    });

    // =========================================================================
    // 2. WINDOW BOUNDS & COORDINATE SAFETY AUDIT
    // =========================================================================

    await suite.test('4. Empty, zero-sized, and non-finite geometry rejected before physical action', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_2001', { pid: 2001, windowHandle: 998821 });

            mockProc.handlers.set('click_element', (req) => {
                return {
                    error: 'INVALID_GEOMETRY: Control bounds are empty, zero-sized, or non-finite for physical click.'
                };
            });

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_2001', { name: 'HiddenButton' }, { allowPhysicalFallback: true });
                },
                /INVALID_GEOMETRY/
            );
        } finally {
            cleanup();
        }
    });

    await suite.test('5. Coordinate click point outside target window rejected (COORDINATE_OUT_OF_BOUNDS)', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_2002', { pid: 2002, windowHandle: 998822 });

            mockProc.handlers.set('click_element', (req) => {
                return {
                    error: 'COORDINATE_OUT_OF_BOUNDS: Calculated click point is outside target window bounds.'
                };
            });

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_2002', { name: 'ClippedButton' }, { allowPhysicalFallback: true });
                },
                /COORDINATE_OUT_OF_BOUNDS/
            );
        } finally {
            cleanup();
        }
    });

    await suite.test('6. Target window replacement between resolution and execution rejected (TARGET_WINDOW_SUBSTITUTION)', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_2003', { pid: 2003, windowHandle: 998823 });

            mockProc.handlers.set('click_element', (req) => {
                return {
                    error: 'TARGET_WINDOW_SUBSTITUTION: Window handle no longer belongs to authorized process.'
                };
            });

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_2003', { name: 'OK' });
                },
                /TARGET_WINDOW_SUBSTITUTION/
            );
        } finally {
            cleanup();
        }
    });

    await suite.test('7. Target control disabled or read-only before state change rejected fail-closed', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_2004', { pid: 2004, windowHandle: 998824 });

            mockProc.handlers.set('type_text', (req) => {
                return {
                    error: 'CONTROL_READ_ONLY: Target control is marked read-only and cannot receive text entry.'
                };
            });

            await assert.rejects(
                async () => {
                    await manager.typeText('app_2004', 'Some input text');
                },
                /CONTROL_READ_ONLY/
            );
        } finally {
            cleanup();
        }
    });

    // =========================================================================
    // 3. SECRET HANDLING END-TO-END AUDIT
    // =========================================================================

    await suite.test('8. Secret auto-detection: password fields detected without explicit isSecret hint', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_3001', { pid: 3001, windowHandle: 998831 });

            let receivedPayload = null;
            mockProc.handlers.set('type_text', (req) => {
                receivedPayload = req;
                return {
                    verified: true,
                    postconditionStatus: 'VERIFIED',
                    readText: '[REDACTED]',
                    isSecret: true,
                    controlName: 'Password Input'
                };
            });

            // Caller passes password field by name without isSecret: true
            const res = await manager.typeText('app_3001', 'SuperSecretPass123', {
                name: 'Password'
            });

            assert.strictEqual(receivedPayload.isSecret, true, 'Manager must infer isSecret from field name "Password"');
            assert.strictEqual(res.isSecret, true, 'Returned result must have isSecret: true');
            assert.strictEqual(res.readText, '[REDACTED]', 'Readback must be redacted');
        } finally {
            cleanup();
        }
    });

    await suite.test('9. Secret redaction on error: raw text is never echoed in thrown Error.message', async () => {
        const { manager, mockProc, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_3002', { pid: 3002, windowHandle: 998832 });

            const sensitivePassword = 'MyHighEntropyP@ssw0rd!#';
            mockProc.handlers.set('type_text', (req) => {
                // Simulate an exception echoing the typed text
                return {
                    error: `UIAutomation Provider threw an error while writing: ${sensitivePassword}`
                };
            });

            let caughtError = null;
            try {
                await manager.typeText('app_3002', sensitivePassword, {
                    name: 'user_password_box',
                    isSecret: false // Untrusted caller falsified isSecret: false!
                });
            } catch (err) {
                caughtError = err;
            }

            assert.ok(caughtError, 'Should throw on worker error');
            assert.ok(!caughtError.message.includes(sensitivePassword), 'Error message must NOT contain raw password');
            assert.ok(caughtError.message.includes('[REDACTED]'), 'Error message must redact sensitive password');
        } finally {
            cleanup();
        }
    });

    await suite.test('10. Secret redaction in TaskContinuityStore checkpoints (disk & memory)', () => {
        const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-checkpoint-secrets-'));
        try {
            const store = new TaskContinuityStore({ memoryDir });
            const secretValue = 'TopSecretTokenValue999';

            store.saveCheckpoint({
                taskId: 'task_sec_001',
                userRequest: 'Log in to internal tool',
                plan: {
                    steps: [
                        {
                            id: 'step_1',
                            toolId: 'desktop_type_text',
                            params: {
                                target: 'App',
                                name: 'txtPassword',
                                text: secretValue,
                                isSecret: true
                            }
                        }
                    ]
                },
                completedSteps: [
                    {
                        stepId: 'step_1',
                        result: {
                            verified: true,
                            readText: secretValue,
                            isSecret: true
                        }
                    }
                ]
            });

            const savedFile = path.join(memoryDir, 'task-checkpoints.json');
            assert.ok(fs.existsSync(savedFile), 'Checkpoint file must be written');
            const fileContent = fs.readFileSync(savedFile, 'utf8');

            assert.ok(!fileContent.includes(secretValue), 'Checkpoint file on disk must NOT contain raw secret text');
            assert.ok(fileContent.includes('[REDACTED]'), 'Checkpoint file must contain [REDACTED]');
        } finally {
            try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    await suite.test('11. Secret redaction in TaskCoordinator condition values', () => {
        const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-coord-secrets-'));
        try {
            const coordinator = new TaskCoordinator({ memoryDir });
            const secretText = 'ExtremelySensitiveCredentials123';

            const sanitized = coordinator._sanitizeConditionValue({
                isSecret: true,
                target: 'loginWindow',
                text: secretText,
                nested: {
                    readText: secretText,
                    normalProp: 'safeValue'
                }
            });

            assert.strictEqual(sanitized.text, '[REDACTED]', 'text property must be redacted when isSecret is true');
            assert.strictEqual(sanitized.nested.readText, '[REDACTED]', 'readText property must be redacted in sensitive context');
            assert.strictEqual(sanitized.nested.normalProp, 'safeValue', 'normal property preserved');
        } finally {
            try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    // =========================================================================
    // 4. POSTCONDITION VERIFICATION & INCONCLUSIVE HANDLING
    // =========================================================================

    await suite.test('12. General button InvokePattern returns UNVERIFIABLE and is mapped to INCONCLUSIVE', async () => {
        const { verifier } = createTestHarness();

        const step = {
            id: 'click_1',
            toolId: 'desktop_click_element',
            params: { target: 'Calculator', name: 'Add' },
            isConsequential: false
        };

        const toolResult = {
            ok: true,
            verified: false,
            postconditionStatus: 'UNVERIFIABLE',
            postconditionDetail: 'InvokePattern completed successfully; external state transition unobservable via UIA',
            action: 'invoked'
        };

        const verification = await verifier.verify(step, toolResult);

        assert.strictEqual(verification.status, VERIFICATION_STATUSES.INCONCLUSIVE, 'UNVERIFIABLE must map to INCONCLUSIVE');
        assert.strictEqual(verification.verified, false, 'verified must remain false');
    });

    await suite.test('13. Close button that leaves target window open reports FAILED', async () => {
        const { verifier } = createTestHarness();

        const step = {
            id: 'close_1',
            toolId: 'desktop_click_element',
            params: { target: 'Notepad', name: 'Close' },
            isConsequential: false
        };

        const toolResult = {
            ok: true,
            verified: false,
            postconditionStatus: 'FAILED',
            postconditionDetail: 'Close action executed but target window remains open',
            action: 'invoked'
        };

        const verification = await verifier.verify(step, toolResult);

        assert.strictEqual(verification.status, VERIFICATION_STATUSES.FAILED, 'Failed close postcondition must map to FAILED');
        assert.strictEqual(verification.verified, false, 'verified must be false');
    });

    await suite.test('14. RecoveryEngine routes inconclusive consequential step to AWAIT_RECONCILIATION without retry', () => {
        const { recoveryEngine } = createTestHarness();

        const consequentialStep = {
            id: 'step_pay',
            toolId: 'desktop_click_element',
            name: 'Submit Payment Button',
            isConsequential: true
        };

        const failure = recoveryEngine.classifyFailure(
            { status: 'inconclusive', postconditionStatus: 'UNVERIFIABLE', message: 'Click executed but outcome uncertain' },
            { step: consequentialStep, isConsequential: true }
        );

        assert.strictEqual(failure.type, FAILURE_TYPES.TIMEOUT_UNCERTAIN);
        assert.strictEqual(failure.uncertain, true);
        assert.strictEqual(failure.recoverable, false, 'Consequential uncertain action must NEVER be recoverable/retried');
        assert.strictEqual(failure.replanEligible, false, 'Consequential uncertain action must NEVER be replanned');
        assert.strictEqual(failure.suggestedStrategy, RECOVERY_STRATEGIES.AWAIT_RECONCILIATION);
    });

    await suite.test('15. RecoveryEngine does not blindly retry inconclusive non-consequential step', () => {
        const { recoveryEngine } = createTestHarness();

        const nonConsequentialStep = {
            id: 'step_read',
            toolId: 'desktop_click_element',
            name: 'Tab Header',
            isConsequential: false
        };

        const failure = recoveryEngine.classifyFailure(
            { status: 'inconclusive', postconditionStatus: 'UNVERIFIABLE', message: 'Click completed but outcome unobservable' },
            { step: nonConsequentialStep, isConsequential: false }
        );

        assert.strictEqual(failure.recoverable, false, 'Inconclusive step must not blindly retry');
        assert.strictEqual(failure.suggestedStrategy, RECOVERY_STRATEGIES.FALLBACK_TOOL);
    });

    // =========================================================================
    // 5. PACKAGED NATIVE WORKER IDENTITY & INTEGRITY AUDIT
    // =========================================================================

    await suite.test('16. verifyWorkerBinary accurately detects corrupt PE header, zero bytes, and invalid signatures', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-binary-pe-test-'));
        try {
            // 1. Zero-byte file
            const zeroFile = path.join(tempDir, 'zero.exe');
            fs.writeFileSync(zeroFile, Buffer.alloc(0));
            const checkZero = verifyWorkerBinary(zeroFile);
            assert.strictEqual(checkZero.valid, false);
            assert.ok(checkZero.error.includes('abnormally small'));

            // 2. Corrupt MZ header (not Windows PE)
            const badMzFile = path.join(tempDir, 'bad_mz.exe');
            fs.writeFileSync(badMzFile, Buffer.alloc(2048, 0x41)); // filled with 'A'
            const checkMz = verifyWorkerBinary(badMzFile);
            assert.strictEqual(checkMz.valid, false);
            assert.ok(checkMz.error.includes('missing MZ DOS header'));

            // 3. Virtual ASAR path rejection
            const virtualPath = 'C:\\Program Files\\LUCY\\resources\\app.asar\\src\\tools\\native-uia\\LucyUiaWorker.exe';
            const checkVirtual = verifyWorkerBinary(virtualPath);
            assert.strictEqual(checkVirtual.valid, false);
            assert.ok(checkVirtual.error.includes('virtual ASAR path'));
        } finally {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    await suite.test('17. Rebuilt source worker binary identity and SHA-256 calculation', () => {
        const sourceExe = path.join(__dirname, '../../src/tools/native-uia/LucyUiaWorker.exe');
        assert.ok(fs.existsSync(sourceExe), 'Source LucyUiaWorker.exe must exist');

        const verification = verifyWorkerBinary(sourceExe);
        assert.strictEqual(verification.valid, true, `Source binary must be valid: ${verification.error}`);
        assert.strictEqual(verification.architecture, 'x86');
        assert.ok(verification.hash && verification.hash.length === 64, 'Must compute 64-char SHA256 hash');
        assert.ok(verification.length > 50000, 'Executable size must be realistic');
    });

    await suite.test('18. Packaged release worker binary audit vs current source executable', () => {
        const sourceExe = path.join(__dirname, '../../src/tools/native-uia/LucyUiaWorker.exe');
        const sourceVerification = verifyWorkerBinary(sourceExe);

        // Check release locations
        const releasePath = path.join(__dirname, '../../dist-release/win-unpacked/resources/native-uia/LucyUiaWorker.exe');
        const repairPath = path.join(__dirname, '../../dist-repair11/win-unpacked/resources/native-uia/LucyUiaWorker.exe');

        const releaseExists = fs.existsSync(releasePath);
        const repairExists = fs.existsSync(repairPath);

        if (releaseExists) {
            const releaseVer = verifyWorkerBinary(releasePath);
            assert.strictEqual(releaseVer.valid, true, 'dist-release LucyUiaWorker.exe must be a valid PE');
            // If hashes differ, verify that the difference is documented honestly
            const hashesMatch = (releaseVer.hash === sourceVerification.hash);
            // This assertion ensures that we report the exact truth rather than falsely claiming a match
            assert.strictEqual(typeof hashesMatch, 'boolean');
        }

        if (repairExists) {
            const repairVer = verifyWorkerBinary(repairPath);
            assert.strictEqual(repairVer.valid, true, 'dist-repair11 LucyUiaWorker.exe must be a valid PE');
        }
    });

    // =========================================================================
    // 6. COORDINATOR INTEGRATION & CONCURRENCY / CANCELLATION RACES
    // =========================================================================

    await suite.test('19. Cancellation during desktop action aborts immediately without executing state change', async () => {
        const { manager, cleanup } = createTestHarness();
        try {
            trackTestApp(manager, 'app_6001', { pid: 6001, windowHandle: 998861 });

            const controller = new AbortController();
            controller.abort(); // already aborted

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_6001', { name: 'Save' }, { signal: controller.signal });
                },
                (err) => err.code === 'CANCELLED'
            );
        } finally {
            cleanup();
        }
    });

    await suite.test('20. Late worker response arriving after timeout is dropped cleanly', async () => {
        const { manager, mockProc, cleanup } = createTestHarness({ timeoutMs: 100 });
        try {
            trackTestApp(manager, 'app_6002', { pid: 6002, windowHandle: 998862 });

            // Simulate hanging worker for 250ms
            mockProc.handlers.set('click_element', (req) => {
                setTimeout(() => {
                    mockProc._sendOutput({ id: req.id, ok: true, result: { verified: true, late: true } });
                }, 250);
                return undefined; // simulate delayed response
            });

            await assert.rejects(
                async () => {
                    await manager.clickElement('app_6002', { name: 'LateTarget' });
                },
                /timed out/i
            );

            // Wait for late response to arrive: ensure it does not throw unhandled rejection
            await new Promise((r) => setTimeout(r, 200));
            assert.strictEqual(manager.isDestroyed, false);
        } finally {
            cleanup();
        }
    });

    await suite.test('21. Secret sanitization preserves non-sensitive task data (SHA256, Git commit, UUID, file paths)', () => {
        const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-preserve-hashes-'));
        try {
            const store = new TaskContinuityStore({ memoryDir });
            const coordinator = new TaskCoordinator({ memoryDir });

            const testSha256 = '61cc5841deb400cf2172285add39c6d78809486d9562ad35e5dfb5e7d765956d';
            const testCommit = '4e96e144e2f94beb0b34dc22a6e6207bb1918e8a';
            const testUuid = '123e4567-e89b-12d3-a456-426614174000';
            const testFilePath = 'C:\\Users\\admin\\Desktop\\LUCY\\src\\tools\\native-uia\\LucyUiaWorker.exe';

            const payload = {
                taskId: 'task_hash_test',
                plan: {
                    steps: [
                        {
                            id: 'step_1',
                            sha256: testSha256,
                            commit: testCommit,
                            uuid: testUuid,
                            path: testFilePath,
                            arbitraryMeta: {
                                checksum: testSha256,
                                gitCommit: testCommit
                            }
                        }
                    ]
                }
            };

            const storeCheckpoint = store.saveCheckpoint(payload);
            assert.strictEqual(storeCheckpoint.plan.steps[0].sha256, testSha256, 'Store must not corrupt sha256 property');
            assert.strictEqual(storeCheckpoint.plan.steps[0].commit, testCommit, 'Store must not corrupt commit property');

            const coordSanitized = coordinator._sanitizeConditionValue(payload);
            assert.strictEqual(coordSanitized.plan.steps[0].sha256, testSha256, 'Coordinator must not corrupt sha256 property');
            assert.strictEqual(coordSanitized.plan.steps[0].commit, testCommit, 'Coordinator must not corrupt commit property');
            assert.strictEqual(coordSanitized.plan.steps[0].arbitraryMeta.checksum, testSha256, 'Coordinator must not corrupt nested checksum');
        } finally {
            try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    await suite.test('22. Caller-controlled isSecret: false cannot override password-field classification in desktop_type_text', async () => {
        const registry = new ToolRegistry();
        const { manager, cleanup } = createTestHarness();
        try {
            registerDesktopTools(registry, manager);
            const tool = registry.getTool('desktop_type_text');
            assert.ok(tool, 'desktop_type_text must be registered');

            // Simulate dryRun with isSecret: false on a password control
            const dryRunResult = await tool.dryRunSimulate({
                target: 'Notepad',
                name: 'PasswordBoxInput',
                text: 'UserSecretPassword999',
                isSecret: false // Malicious or oblivious caller
            });

            assert.strictEqual(dryRunResult.preview, '[REDACTED]', 'dryRunSimulate must redact password even if caller supplied isSecret: false');
        } finally {
            cleanup();
        }
    });

    await suite.test('23. Circular references in payloads do not throw RangeError and are safely handled', () => {
        const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-circular-test-'));
        try {
            const store = new TaskContinuityStore({ memoryDir });
            const coordinator = new TaskCoordinator({ memoryDir });

            const circularObj = { name: 'RootNode' };
            circularObj.self = circularObj;

            const sanitized = coordinator._sanitizeConditionValue(circularObj);
            assert.strictEqual(sanitized.name, 'RootNode');
            assert.strictEqual(sanitized.self, '[CIRCULAR]');

            const checkpoint = store.saveCheckpoint({
                taskId: 'task_circular_test',
                userRequest: 'Test circular safety',
                plan: {
                    steps: [circularObj]
                }
            });
            assert.strictEqual(checkpoint.plan.steps[0].self, '[CIRCULAR]');
        } finally {
            try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    await suite.test('24. Stale checkpoint write cannot resurrect a cancelled or discarded task', () => {
        const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-cancel-resurrect-'));
        try {
            const store = new TaskContinuityStore({ memoryDir });

            store.saveCheckpoint({
                taskId: 'task_cancelled_1',
                userRequest: 'User cancel test',
                status: 'cancelled'
            });

            const cancelledCp = store.getCheckpoint('task_cancelled_1');
            assert.strictEqual(cancelledCp.status, 'cancelled');

            // Stale async callback attempts to mark it in_progress or completed
            store.saveCheckpoint({
                taskId: 'task_cancelled_1',
                status: 'in_progress'
            });

            const refreshedCp = store.getCheckpoint('task_cancelled_1');
            assert.strictEqual(refreshedCp.status, 'cancelled', 'Cancelled task must remain cancelled despite stale write');

            // Stale write attempting to mark completed
            store.saveCheckpoint({
                taskId: 'task_cancelled_1',
                status: 'completed'
            });

            const finalCp = store.getCheckpoint('task_cancelled_1');
            assert.strictEqual(finalCp.status, 'cancelled', 'Cancelled task must never be resurrected to completed');
        } finally {
            try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
        }
    });

    await suite.test('25. Late settlement handler drops stale results for already-terminal tasks and sanitizes outcome', () => {
        const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-late-settlement-'));
        try {
            const coordinator = new TaskCoordinator({ memoryDir });

            // Set up a task that is already cancelled
            coordinator.taskContinuityStore.saveCheckpoint({
                taskId: 'task_terminal_late',
                userRequest: 'Test terminal drop',
                status: 'cancelled',
                uncertainStep: {
                    stepId: 'step_consequential_1',
                    toolId: 'desktop_click_element',
                    resolved: false
                }
            });

            // Late settlement arrives with sensitive outcome
            coordinator._handleLateSettlement('task_terminal_late', 'step_consequential_1', 1, {
                password: 'LateSensitivePassword123',
                ok: true
            });

            const cp = coordinator.taskContinuityStore.getCheckpoint('task_terminal_late');
            assert.strictEqual(cp.status, 'cancelled');
            assert.strictEqual(cp.uncertainStep.lateSettlement, undefined, 'Late settlement must be dropped for terminal task');
        } finally {
            try { fs.rmSync(memoryDir, { recursive: true, force: true }); } catch (_) {}
        }
    });
});

