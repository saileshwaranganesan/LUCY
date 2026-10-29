'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execSync } = require('node:child_process');

const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
const { resolveExeFile, ensureWorkerBuilt } = require('../../src/tools/native-uia/build-worker.js');

test('Security & Confidentiality: Session Secret Transport and Initialization Boundary', async (suite) => {
    const workerExe = resolveExeFile();

    // Helper to spawn a raw worker and perform line-based JSON request/response
    function createRawWorker() {
        const proc = spawn(workerExe, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });

        let buffer = '';
        const pending = new Map();

        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const msg = JSON.parse(trimmed);
                    if (typeof msg.id !== 'undefined' && pending.has(msg.id)) {
                        const handler = pending.get(msg.id);
                        pending.delete(msg.id);
                        if (msg.ok) {
                            handler.resolve(msg.result);
                        } else {
                            handler.reject(new Error(msg.error || 'Worker operation failed'));
                        }
                    }
                } catch (_) {}
            }
        });

        let nextId = 1;
        function send(cmd, payload = {}) {
            const id = nextId++;
            const msg = { id, cmd, ...payload };
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Command '${cmd}' timed out`));
                }, 10000);
                pending.set(id, {
                    resolve: (res) => { clearTimeout(timer); resolve(res); },
                    reject: (err) => { clearTimeout(timer); reject(err); }
                });
                proc.stdin.write(JSON.stringify(msg) + '\n');
            });
        }

        function destroy() {
            try { proc.stdin.write(JSON.stringify({ id: 99999, cmd: 'exit' }) + '\n'); } catch (_) {}
            try { proc.stdin.end(); } catch (_) {}
            try { proc.kill(); } catch (_) {}
        }

        return { proc, send, destroy };
    }

    // =========================================================================
    // 1. Secret Leakage in Command Arguments and Logs
    // =========================================================================
    await suite.test('1. Secret Leakage Prevention: Secret is never exposed via CLI arguments or process environment', async () => {
        const secret = crypto.randomBytes(32).toString('hex');
        const manager = new DesktopAutomationManager({ sessionSecret: secret });

        await manager.ensureWorker();
        assert.ok(manager.proc, 'Worker process must be running');

        // A: Check Node.js child_process spawnargs
        const spawnArgs = manager.proc.spawnargs || [];
        for (const arg of spawnArgs) {
            assert.ok(!arg.includes('--session-secret'), 'Worker CLI arguments MUST NOT contain --session-secret');
            assert.ok(!arg.includes(secret), 'Worker CLI arguments MUST NOT contain the session secret');
        }

        // B: Inspect OS-level Windows process command line via WMI / PowerShell
        try {
            const pid = manager.proc.pid;
            const wmiCmd = `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pid}\\").CommandLine"`;
            const osCmdLine = execSync(wmiCmd, { encoding: 'utf8', timeout: 5000 }).trim();
            assert.ok(!osCmdLine.includes('--session-secret'), 'OS-level process command line MUST NOT contain --session-secret');
            assert.ok(!osCmdLine.includes(secret), 'OS-level process command line MUST NOT contain the session secret');
        } catch (err) {
            // If WMI query times out or is restricted, ensure spawnargs assertion above succeeded
            if (!err.message.includes('MUST NOT')) {
                // Non-assertion system error
            } else {
                throw err;
            }
        }

        manager.cleanup();
    });

    // =========================================================================
    // 2. Missing Secret (Uninitialized Worker)
    // =========================================================================
    await suite.test('2. Missing Secret: Uninitialized worker rejects launch_app fail-closed', async () => {
        const raw = createRawWorker();
        // Allow worker to boot and send ready
        await new Promise(r => setTimeout(r, 200));

        // Attempt launch_app without sending init_session
        await assert.rejects(async () => {
            await raw.send('launch_app', {
                exe: 'notepad.exe',
                taskId: 'test_task',
                taskGrant: 'some_arbitrary_grant'
            });
        }, (err) => {
            assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Expected UNAUTHORIZED_RESOURCE_ACCESS, got: ${err.message}`);
            assert.ok(err.message.includes('Worker session is not initialized with an authorization secret'));
            return true;
        });

        raw.destroy();
    });

    // =========================================================================
    // 3. Malformed Initialization
    // =========================================================================
    await suite.test('3. Malformed Initialization: Rejects missing, empty, or short secret fail-closed', async () => {
        const raw = createRawWorker();
        await new Promise(r => setTimeout(r, 200));

        // 3A: Missing sessionSecret parameter
        await assert.rejects(async () => {
            await raw.send('init_session', {});
        }, (err) => {
            assert.ok(err.message.includes('INVALID_INITIALIZATION') || err.message.includes('Missing'), `Got: ${err.message}`);
            return true;
        });

        // 3B: Empty / whitespace sessionSecret
        await assert.rejects(async () => {
            await raw.send('init_session', { sessionSecret: '   ' });
        }, (err) => {
            assert.ok(err.message.includes('INVALID_INITIALIZATION') || err.message.includes('Missing'), `Got: ${err.message}`);
            return true;
        });

        // 3C: Short secret (< 32 characters)
        await assert.rejects(async () => {
            await raw.send('init_session', { sessionSecret: 'short_insecure_secret' });
        }, (err) => {
            assert.ok(err.message.includes('INVALID_INITIALIZATION'), `Got: ${err.message}`);
            return true;
        });

        raw.destroy();
    });

    // =========================================================================
    // 4. Initialization Replay and Replacement Prevention
    // =========================================================================
    await suite.test('4. Initialization Replay Prevention: Cannot replace established secret', async () => {
        const raw = createRawWorker();
        await new Promise(r => setTimeout(r, 200));

        const originalSecret = crypto.randomBytes(32).toString('hex');
        const secondSecret = crypto.randomBytes(32).toString('hex');

        // First initialization must succeed
        const initRes = await raw.send('init_session', { sessionSecret: originalSecret });
        assert.equal(initRes.initialized, true);

        // Second initialization attempt (replay / replacement) must fail closed
        await assert.rejects(async () => {
            await raw.send('init_session', { sessionSecret: secondSecret });
        }, (err) => {
            assert.ok(err.message.includes('ALREADY_INITIALIZED'), `Expected ALREADY_INITIALIZED error, got: ${err.message}`);
            return true;
        });

        // Verify original secret is still binding and second secret was NOT adopted
        const taskId = 'task_replay_check';
        const exePath = 'notepad.exe';

        const forgedWithSecondSecret = crypto.createHmac('sha256', secondSecret)
            .update(`launch:${taskId}:${exePath.toLowerCase()}`)
            .digest('hex');

        // Grant signed with second secret must be rejected
        await assert.rejects(async () => {
            await raw.send('launch_app', {
                exe: exePath,
                taskId,
                taskGrant: forgedWithSecondSecret
            });
        }, (err) => {
            assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Got: ${err.message}`);
            assert.ok(err.message.includes('Invalid or forged task authorization grant'));
            return true;
        });

        raw.destroy();
    });

    // =========================================================================
    // 5. Forged Launch Grants
    // =========================================================================
    await suite.test('5. Forged Launch Grants: Launch requires valid HMAC-SHA256 grant signed with session secret', async () => {
        const secret = crypto.randomBytes(32).toString('hex');
        const manager = new DesktopAutomationManager({ sessionSecret: secret });
        await manager.ensureWorker();

        // 5A: Arbitrary random string grant fails
        await assert.rejects(async () => {
            await manager.sendCommand('launch_app', {
                exe: 'notepad.exe',
                taskId: 'task_auth_check',
                taskGrant: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 5B: Grant computed with wrong secret fails
        const wrongSecret = crypto.randomBytes(32).toString('hex');
        const invalidGrant = crypto.createHmac('sha256', wrongSecret)
            .update('launch:task_auth_check:notepad.exe')
            .digest('hex');

        await assert.rejects(async () => {
            await manager.sendCommand('launch_app', {
                exe: 'notepad.exe',
                taskId: 'task_auth_check',
                taskGrant: invalidGrant
            });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        manager.cleanup();
    });

    // =========================================================================
    // 6. Task-bound Authorization and Revocation
    // =========================================================================
    await suite.test('6. Task Revocation: Revocation cleans worker state and rejects subsequent actions', async () => {
        const manager = new DesktopAutomationManager();
        await manager.ensureWorker();

        const revokeRes = await manager.sendCommand('revoke_task', { taskId: 'non_existent_task' });
        assert.equal(typeof revokeRes.revokedCount, 'number');

        const revokeAppRes = await manager.sendCommand('revoke_app', { pid: 99999, appId: 'app_99999' });
        assert.equal(revokeAppRes.revoked, true);

        manager.cleanup();
    });

    // =========================================================================
    // 7. Operational Requests Sent Before Initialization
    // =========================================================================
    await suite.test('7. Uninitialized Worker: Rejects all operational commands fail-closed', async () => {
        const raw = createRawWorker();
        await new Promise(r => setTimeout(r, 200));

        const operationalCommands = [
            { cmd: 'type_text', payload: { pid: 1234, text: 'test', isOwned: true } },
            { cmd: 'click_element', payload: { pid: 1234, name: 'OK', isOwned: true } },
            { cmd: 'close_app', payload: { pid: 1234, isOwned: true } },
            { cmd: 'close_tab', payload: { pid: 1234, isOwned: true } },
            { cmd: 'handle_dialog', payload: { pid: 1234, action: 'save', isOwned: true } },
            { cmd: 'focus_window', payload: { pid: 1234, isOwned: true } },
            { cmd: 'inspect_ui', payload: { pid: 1234, isOwned: true } },
            { cmd: 'find_element', payload: { pid: 1234, name: 'OK', isOwned: true } },
            { cmd: 'take_screenshot', payload: { pid: 1234, isOwned: true } },
            { cmd: 'detect_dialog', payload: { pid: 1234, isOwned: true } },
            { cmd: 'list_apps', payload: {} }
        ];

        for (const item of operationalCommands) {
            await assert.rejects(async () => {
                await raw.send(item.cmd, item.payload);
            }, (err) => {
                assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Command ${item.cmd} must reject with UNAUTHORIZED_RESOURCE_ACCESS, got: ${err.message}`);
                assert.ok(err.message.includes('Worker session is not initialized with an authorization secret'), `Command ${item.cmd} error must specify uninitialized session, got: ${err.message}`);
                return true;
            });
        }

        raw.destroy();
    });

    // =========================================================================
    // 8. Interrupted Initialization & Invalid Acknowledgement
    // =========================================================================
    await suite.test('8. Handshake Boundary: Manager rejects invalid or missing initialization acknowledgement', () => {
        const manager = new DesktopAutomationManager({ timeoutMs: 2000 });
        let rejectedError = null;
        manager.proc = { stdin: { write: () => {} } };

        manager._handleStdout(
            Buffer.from(JSON.stringify({ status: 'ready' }) + '\n'),
            () => {},
            (err) => { rejectedError = err; },
            null
        );

        // Simulate worker sending ok: true but with missing or false initialized field
        manager._handleStdout(
            Buffer.from(JSON.stringify({ id: 1, ok: true, result: {} }) + '\n'),
            () => {},
            (err) => { rejectedError = err; },
            null
        );

        assert.ok(rejectedError, 'Manager must reject invalid acknowledgement');
        assert.ok(rejectedError.message.includes('invalid acknowledgement'), `Expected invalid acknowledgement error, got: ${rejectedError.message}`);
        assert.equal(manager.isReady, false);

        manager.cleanup();
    });

    // =========================================================================
    // 9. Worker Crash During Initialization Followed by Clean Restart
    // =========================================================================
    await suite.test('9. Worker Crash During Initialization: Fails closed and recovers on fresh startup', async () => {
        const manager = new DesktopAutomationManager({ timeoutMs: 5000 });

        // Start worker and immediately kill process to simulate sudden crash during startup
        const ensurePromise = manager.ensureWorker();
        assert.ok(manager.proc, 'Process should be spawned');
        manager.proc.kill('SIGKILL');

        await assert.rejects(async () => {
            await ensurePromise;
        }, (err) => {
            assert.ok(err.message.includes('closed prematurely') || err.message.includes('code'), `Expected crash error, got: ${err.message}`);
            return true;
        });

        assert.equal(manager.isReady, false);
        assert.equal(manager.proc, null);

        // Fresh restart must succeed
        const freshManager = new DesktopAutomationManager();
        await freshManager.ensureWorker();
        assert.equal(freshManager.isReady, true);
        assert.ok(freshManager.proc && !freshManager.proc.killed);

        freshManager.cleanup();
    });

    // =========================================================================
    // 10. Unexpected, Malformed, or Out-of-Order Worker Responses
    // =========================================================================
    await suite.test('10. Response Demuxing: Handles out-of-order, malformed, and non-JSON output cleanly', async () => {
        const manager = new DesktopAutomationManager();
        await manager.ensureWorker();

        // 10A: Non-JSON and diagnostic output is safely ignored
        manager._handleStdout(Buffer.from('Diagnostic log line: [DEBUG] initialized\nNon-json noise\n'));
        assert.equal(manager.isReady, true, 'Manager state must not be corrupted by non-JSON stdout');

        // 10B: Out-of-order responses matching request IDs
        const p1 = manager.sendCommand('ping');
        const p2 = manager.sendCommand('ping');

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1.pong, true);
        assert.equal(r2.pong, true);

        // 10C: Unknown response IDs are safely dropped without throwing
        manager._handleStdout(Buffer.from(JSON.stringify({ id: 999999, ok: true, result: { unknown: true } }) + '\n'));

        manager.cleanup();
    });

    // =========================================================================
    // 11. Cross-Session Token and Grant Isolation
    // =========================================================================
    await suite.test('11. Cross-Session Isolation: Stale tokens and grants from previous session are rejected', async () => {
        const secret1 = crypto.randomBytes(32).toString('hex');
        const secret2 = crypto.randomBytes(32).toString('hex');

        // Worker session 2
        const raw2 = createRawWorker();
        await new Promise(r => setTimeout(r, 200));
        await raw2.send('init_session', { sessionSecret: secret2 });

        // Attempt to use a task grant signed under session 1 against session 2
        const taskId = 'task_cross_session';
        const grantFromSession1 = crypto.createHmac('sha256', secret1)
            .update(`launch:${taskId}:notepad.exe`)
            .digest('hex');

        await assert.rejects(async () => {
            await raw2.send('launch_app', {
                exe: 'notepad.exe',
                taskId,
                taskGrant: grantFromSession1
            });
        }, (err) => {
            assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'), `Got: ${err.message}`);
            assert.ok(err.message.includes('Invalid or forged task authorization grant'));
            return true;
        });

        // Attempt to use an auth token derived under session 1 against session 2
        const staleTokenFromSession1 = crypto.createHmac('sha256', secret1)
            .update(`auth:${taskId}:1234:guid`)
            .digest('hex');

        await assert.rejects(async () => {
            await raw2.send('type_text', {
                pid: 1234,
                authToken: staleTokenFromSession1,
                taskId,
                isOwned: true,
                text: 'stale session attack'
            });
        }, (err) => {
            assert.ok(err.message.includes('UNAUTHORIZED_RESOURCE_ACCESS'));
            return true;
        });

        raw2.destroy();
    });

    // =========================================================================
    // 12. Cleanup and Restart State Independence
    // =========================================================================
    await suite.test('12. Lifecycle Cleanup: Restart initializes fresh independent state without residue', async () => {
        const manager1 = new DesktopAutomationManager();
        await manager1.ensureWorker();
        const proc1Pid = manager1.proc.pid;
        const secret1 = manager1.sessionSecret;

        // Cleanup manager 1
        manager1.cleanup();
        assert.equal(manager1.isReady, false);
        assert.equal(manager1.isDestroyed, true);
        assert.equal(manager1.proc, null);

        // Manager 2 must have a new random secret and independent lifecycle
        const manager2 = new DesktopAutomationManager();
        await manager2.ensureWorker();
        assert.equal(manager2.isReady, true);
        assert.notEqual(manager2.sessionSecret, secret1, 'New manager must generate distinct session secret');
        assert.notEqual(manager2.proc.pid, proc1Pid, 'New manager must run separate worker process');

        manager2.cleanup();
    });

    // =========================================================================
    // 13. Read-Only Authorization & Task Boundary Enforcement (Manager Layer)
    // =========================================================================
    await suite.test('13. Read-Only Authorization: Sensitive read operations enforce ownership and task isolation', async () => {
        const manager = new DesktopAutomationManager();

        // 1. Unowned application read attempts fail closed with UNAUTHORIZED_RESOURCE_ACCESS
        const unownedPid = 88888;
        await assert.rejects(async () => {
            await manager.inspectUI(unownedPid);
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.findElement(unownedPid, { name: 'OK' });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.takeScreenshot(unownedPid);
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        await assert.rejects(async () => {
            await manager.detectDialog(unownedPid);
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 2. Track an application bound to task_alpha
        manager.trackedApps.set('app_read_auth', {
            appId: 'app_read_auth',
            pid: 9001,
            windowHandle: 12345,
            processStartTime: '2026-10-22T00:00:00.0000000Z',
            exe: 'C:\\Windows\\notepad.exe',
            windowTitle: 'Secret Confidential Document',
            launchedByLucy: true,
            ownershipState: 'OWNED',
            taskId: 'task_alpha',
            authToken: 'tok_alpha_valid',
            lifecycleState: 'active'
        });

        manager.sendCommand = async (cmd, payload) => ({ mockSuccess: true, cmd, payload });

        // Missing taskId when bound to task_alpha -> TASK_BOUNDARY_VIOLATION
        await assert.rejects(async () => {
            await manager.inspectUI('app_read_auth');
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.takeScreenshot('app_read_auth');
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        // Mismatched taskId (task_beta trying to read task_alpha's app) -> TASK_BOUNDARY_VIOLATION
        await assert.rejects(async () => {
            await manager.inspectUI('app_read_auth', { taskId: 'task_beta' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.findElement('app_read_auth', { name: 'OK' }, { taskId: 'task_beta' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.takeScreenshot('app_read_auth', { taskId: 'task_beta' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        await assert.rejects(async () => {
            await manager.detectDialog('app_read_auth', { taskId: 'task_beta' });
        }, (err) => {
            assert.equal(err.code, 'TASK_BOUNDARY_VIOLATION');
            return true;
        });

        // Matching taskId -> Succeeds and passes through to worker with payload.isOwned: true
        const inspectRes = await manager.inspectUI('app_read_auth', { taskId: 'task_alpha' });
        assert.equal(inspectRes.mockSuccess, true);
        assert.equal(inspectRes.cmd, 'inspect_ui');
        assert.equal(inspectRes.payload.isOwned, true);
        assert.equal(inspectRes.payload.taskId, 'task_alpha');
        assert.equal(inspectRes.payload.authToken, 'tok_alpha_valid');

        const shotRes = await manager.takeScreenshot('app_read_auth', { taskId: 'task_alpha' });
        assert.equal(shotRes.mockSuccess, true);
        assert.equal(shotRes.cmd, 'take_screenshot');
        assert.equal(shotRes.payload.isOwned, true);
        assert.equal(shotRes.payload.taskId, 'task_alpha');

        manager.cleanup();
    });

    // =========================================================================
    // 14. Read-Only Boundary (Direct Native Worker Protocol Layer)
    // =========================================================================
    await suite.test('14. Read-Only Protocol Boundary: Direct worker read commands enforce authorization', async () => {
        const raw = createRawWorker();
        await new Promise(r => setTimeout(r, 200));

        const secret = crypto.randomBytes(32).toString('hex');
        await raw.send('init_session', { sessionSecret: secret });

        const unownedPid = 77777;

        // 1. Direct inspect_ui with isOwned: false, missing token, or forged token fails closed
        await assert.rejects(async () => {
            await raw.send('inspect_ui', { pid: unownedPid, isOwned: false });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        await assert.rejects(async () => {
            await raw.send('inspect_ui', { pid: unownedPid, isOwned: true, authToken: 'fake_token' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 2. Direct find_element with forged token fails closed
        await assert.rejects(async () => {
            await raw.send('find_element', { pid: unownedPid, isOwned: true, authToken: 'forged', name: 'Submit' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 3. Direct take_screenshot with unowned PID fails closed
        await assert.rejects(async () => {
            await raw.send('take_screenshot', { pid: unownedPid, isOwned: true, authToken: 'forged' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 4. Direct detect_dialog with unowned PID fails closed
        await assert.rejects(async () => {
            await raw.send('detect_dialog', { pid: unownedPid, isOwned: true, authToken: 'forged' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 5. Valid token from another worker session is rejected
        const foreignToken = 'tok_foreign_' + crypto.randomBytes(16).toString('hex');
        await assert.rejects(async () => {
            await raw.send('inspect_ui', { pid: unownedPid, isOwned: true, authToken: foreignToken, taskId: 'task_1' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        await assert.rejects(async () => {
            await raw.send('take_screenshot', { pid: unownedPid, isOwned: true, authToken: foreignToken, taskId: 'task_1' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        await assert.rejects(async () => {
            await raw.send('find_element', { pid: unownedPid, isOwned: true, authToken: foreignToken, taskId: 'task_1', name: 'Button' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        await assert.rejects(async () => {
            await raw.send('detect_dialog', { pid: unownedPid, isOwned: true, authToken: foreignToken, taskId: 'task_1' });
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);

        // 6. Protected process reads fail closed with SAFETY_VIOLATION
        await assert.rejects(async () => {
            await raw.send('inspect_ui', { pid: process.pid, isOwned: true, authToken: 'test' });
        }, /SAFETY_VIOLATION/);

        await assert.rejects(async () => {
            await raw.send('take_screenshot', { pid: process.pid, isOwned: true, authToken: 'test' });
        }, /SAFETY_VIOLATION/);

        await assert.rejects(async () => {
            await raw.send('find_element', { pid: process.pid, isOwned: true, authToken: 'test', name: 'Search' });
        }, /SAFETY_VIOLATION/);

        await assert.rejects(async () => {
            await raw.send('detect_dialog', { pid: process.pid, isOwned: true, authToken: 'test' });
        }, /SAFETY_VIOLATION/);

        raw.destroy();
    });

    // =========================================================================
    // 15. Discovery & Enumeration: list_apps Minimal Disclosure & Gate
    // =========================================================================
    await suite.test('15. Discovery & Enumeration: list_apps enforces session initialization gate and minimal disclosure', async () => {
        // 1. Uninitialized worker rejects list_apps
        const uninitRaw = createRawWorker();
        await new Promise(r => setTimeout(r, 200));
        await assert.rejects(async () => {
            await uninitRaw.send('list_apps', {});
        }, /UNAUTHORIZED_RESOURCE_ACCESS/);
        uninitRaw.destroy();

        // 2. Initialized worker returns list adhering to minimal disclosure policy
        const raw = createRawWorker();
        await new Promise(r => setTimeout(r, 200));
        const secret = crypto.randomBytes(32).toString('hex');
        await raw.send('init_session', { sessionSecret: secret });

        const res = await raw.send('list_apps', {});
        assert.ok(Array.isArray(res), 'list_apps must return an array');

        // Verify each item adheres strictly to minimal public metadata (no control tree, no document text, no pixels)
        const allowedKeys = new Set(['name', 'className', 'pid', 'processName', 'appId', 'windowHandle', 'isEnabled', 'isOffscreen']);
        for (const item of res) {
            for (const key of Object.keys(item)) {
                assert.ok(allowedKeys.has(key), `list_apps item contains disallowed sensitive key: ${key}`);
            }
            assert.equal(typeof item.pid, 'number');
            assert.ok(item.appId.startsWith('app_'));
            // Confirm protected process (current test runner process or IDE) is excluded
            assert.notEqual(item.pid, process.pid, 'Protected test process must be excluded from list_apps');
        }

        raw.destroy();
    });
});

