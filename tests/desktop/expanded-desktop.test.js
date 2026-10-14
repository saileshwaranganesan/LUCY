'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');

test('Implementation 01: Curated Desktop Application Control & Security Gates', async (suite) => {
    const manager = new DesktopAutomationManager();

    // 1. An approved application is accepted
    await suite.test('1. An approved application is accepted and resolves to trusted binary', () => {
        const approved = [
            { id: 'notepad', expected: 'notepad.exe' },
            { id: 'calc', expected: 'calc.exe' },
            { id: 'calculator', expected: 'calc.exe' },
            { id: 'mspaint', expected: 'mspaint.exe' },
            { id: 'paint', expected: 'mspaint.exe' },
            { id: 'chrome', expected: 'chrome.exe' },
            { id: 'google chrome', expected: 'chrome.exe' },
            { id: 'msedge', expected: 'msedge.exe' },
            { id: 'edge', expected: 'msedge.exe' },
            { id: 'firefox', expected: 'firefox.exe' },
            { id: 'code', expected: 'code.exe' },
            { id: 'vs code', expected: 'code.exe' },
            { id: 'wt', expected: 'wt.exe' },
            { id: 'terminal', expected: 'wt.exe' },
            { id: 'taskmgr', expected: 'taskmgr.exe' },
            { id: 'task manager', expected: 'taskmgr.exe' },
            { id: 'snippingtool', expected: 'snippingtool.exe' },
            { id: 'vlc', expected: 'vlc.exe' },
            { id: 'spotify', expected: 'spotify.exe' },
            { id: 'explorer', expected: 'explorer.exe' }
        ];

        for (const item of approved) {
            const result = manager.validateExecutable(item.id);
            assert.equal(result.safe, true, `Expected ${item.id} to be safe`);
            assert.equal(result.isAllowlisted, true, `Expected ${item.id} to be allowlisted`);
            assert.equal(result.resolvedPath, item.expected, `Expected ${item.id} to resolve to ${item.expected}`);
        }
    });

    // 2. An unknown application is rejected
    await suite.test('2. An unknown application is rejected safely', () => {
        const unapproved = ['malware.exe', 'unknown_app.exe', 'cryptominer.exe', 'hacks.exe', 'payload'];

        for (const target of unapproved) {
            assert.throws(
                () => manager.validateExecutable(target),
                (err) => {
                    assert.equal(err.code, 'APP_NOT_ALLOWLISTED');
                    assert.match(err.message, /not in the curated allowlist/i);
                    return true;
                },
                `Expected unknown app '${target}' to be rejected with APP_NOT_ALLOWLISTED`
            );
        }
    });

    // 3. A malformed request is rejected
    await suite.test('3. A malformed request is rejected with structured errors', () => {
        const malformedRequests = [
            null,
            undefined,
            '',
            '   ',
            123,
            {},
            ['notepad.exe'],
            'notepad.exe\0malicious'
        ];

        for (const req of malformedRequests) {
            assert.throws(
                () => manager.validateExecutable(req),
                (err) => {
                    assert.ok(['INVALID_REQUEST', 'INVALID_ARGUMENTS'].includes(err.code));
                    assert.ok(err.message.length > 0);
                    return true;
                },
                `Expected malformed request '${JSON.stringify(req)}' to be rejected`
            );
        }
    });

    // 4. An unauthorized executable path cannot be injected
    await suite.test('4. An unauthorized executable path cannot be injected', () => {
        const unauthorizedPaths = [
            '../../evil.exe',
            '..\\..\\evil.exe',
            'C:\\Windows\\System32\\regedit.exe',
            'C:\\Windows\\System32\\diskpart.exe',
            'C:\\Windows\\System32\\format.com',
            'C:\\Windows\\System32\\vssadmin.exe',
            'C:\\Windows\\System32\\rundll32.exe',
            'C:\\Windows\\System32\\mshta.exe',
            'C:\\Windows\\System32\\wscript.exe',
            'C:\\Windows\\System32\\cscript.exe'
        ];

        for (const p of unauthorizedPaths) {
            assert.throws(
                () => manager.validateExecutable(p),
                (err) => {
                    assert.ok(['APP_NOT_ALLOWLISTED', 'EXECUTABLE_UNAVAILABLE'].includes(err.code));
                    return true;
                },
                `Expected unauthorized path '${p}' to be blocked`
            );
        }
    });

    // 5. Shell-command injection attempts are rejected or rendered harmless
    await suite.test('5. Shell-command injection attempts in paths and arguments are rejected', () => {
        const maliciousPaths = [
            'notepad.exe & calc.exe',
            'calc.exe | whoami',
            'notepad.exe; start calc',
            'notepad.exe ` calc.exe',
            'notepad.exe $ evil',
            'notepad.exe > output.txt',
            'notepad.exe\ncalc.exe'
        ];

        for (const target of maliciousPaths) {
            assert.throws(
                () => manager.validateExecutable(target),
                (err) => {
                    assert.equal(err.code, 'INVALID_ARGUMENTS');
                    assert.match(err.message, /(malicious|command chaining)/i);
                    return true;
                }
            );
        }

        // Test argument injection
        const maliciousArgs = [
            'file.txt & whoami',
            'file.txt | net user',
            'file.txt; calc.exe',
            'file.txt\r\ncalc.exe',
            'file.txt\0evil',
            'file.txt > output.txt',
            'file.txt `calc`'
        ];

        for (const arg of maliciousArgs) {
            assert.throws(
                () => manager.validateArguments('notepad.exe', arg),
                (err) => {
                    assert.equal(err.code, 'INVALID_ARGUMENTS');
                    assert.match(err.message, /Shell-command injection/i);
                    return true;
                }
            );
        }

        // Test shell binary switches
        const dangerousShellSwitches = [
            '/c calc.exe',
            '/k start calc',
            '-Command Write-Host Evil',
            '-enc VABlAHMAdAA=',
            '-ExecutionPolicy Bypass -File evil.ps1'
        ];

        for (const sw of dangerousShellSwitches) {
            assert.throws(
                () => manager.validateArguments('cmd.exe', sw),
                (err) => {
                    assert.equal(err.code, 'INVALID_ARGUMENTS');
                    assert.match(err.message, /Arbitrary shell command execution/i);
                    return true;
                }
            );
            assert.throws(
                () => manager.validateArguments('powershell.exe', sw),
                (err) => {
                    assert.equal(err.code, 'INVALID_ARGUMENTS');
                    assert.match(err.message, /Arbitrary shell command execution/i);
                    return true;
                }
            );
        }

        // Safe arguments format cleanly
        const safeArgs = manager.validateArguments('notepad.exe', 'my notes.txt');
        assert.equal(safeArgs, '"my notes.txt"');

        const safeArray = manager.validateArguments('notepad.exe', ['notes.txt', 'file2.txt']);
        assert.equal(safeArray, 'notes.txt file2.txt');
    });

    // 6. Application launch failures are handled correctly
    await suite.test('6. Application launch failures are handled correctly without unhandled exceptions', async () => {
        // Create a manager instance with a mock sendCommand that simulates worker launch failure
        const mockManager = new DesktopAutomationManager();
        mockManager.ensureWorker = async () => {};
        mockManager.sendCommand = async (cmd, payload) => {
            if (cmd === 'launch_app') {
                throw new Error('Failed to launch application (Win32 Error 2)');
            }
            return {};
        };

        await assert.rejects(
            async () => await mockManager.launchApp('calc.exe'),
            (err) => {
                assert.equal(err.code, 'EXECUTABLE_UNAVAILABLE');
                assert.match(err.message, /Failed to launch application/i);
                return true;
            }
        );

        // General worker failure
        mockManager.sendCommand = async () => {
            throw new Error('Process creation failed (Win32 Error 5)');
        };

        await assert.rejects(
            async () => await mockManager.launchApp('notepad.exe'),
            (err) => {
                assert.equal(err.code, 'LAUNCH_FAILED');
                assert.match(err.message, /Failed to launch application/i);
                return true;
            }
        );
    });

    // 7. Existing desktop-control behavior remains compatible
    await suite.test('7. Existing desktop-control behavior and TaskPlanner natural language remain compatible', async () => {
        const planner = new TaskPlanner();

        const cases = [
            { req: 'open chrome', expectedExe: 'chrome.exe' },
            { req: 'launch vs code', expectedExe: 'code.exe' },
            { req: 'start terminal', expectedExe: 'wt.exe' },
            { req: 'open task manager', expectedExe: 'taskmgr.exe' },
            { req: 'launch snipping tool', expectedExe: 'snippingtool.exe' },
            { req: 'open vlc', expectedExe: 'vlc.exe' },
            { req: 'open edge', expectedExe: 'msedge.exe' },
            { req: 'open notepad', expectedExe: 'notepad.exe' },
            { req: 'launch calculator', expectedExe: 'calc.exe' }
        ];

        for (const c of cases) {
            const plan = await planner.plan(c.req);
            assert.equal(plan.type, 'plan');
            assert.equal(plan.steps.length, 1);
            assert.equal(plan.steps[0].toolId, 'desktop_launch_app');
            assert.equal(plan.steps[0].params.executable, c.expectedExe);
        }

        // Mechanical dry-run isolation remains intact
        const registry = new ToolRegistry();
        registerDesktopTools(registry, manager);

        const dryRunResult = await registry.execute('desktop_launch_app', { executable: 'notepad' }, { dryRun: true });
        assert.equal(dryRunResult.ok, true);
        assert.equal(dryRunResult.dryRun, true);
        assert.equal(dryRunResult.status, 'dry_run_simulated');
        assert.equal(dryRunResult.simulatedDetails.targetExecutable, 'notepad.exe');
        assert.equal(dryRunResult.simulatedDetails.isAllowlisted, true);
    });

    // 8. Security validation occurs before process execution
    await suite.test('8. Security validation occurs before any worker command or process execution', async () => {
        let workerCommandDispatched = false;
        const mockManager = new DesktopAutomationManager();
        mockManager.ensureWorker = async () => {};
        mockManager.sendCommand = async () => {
            workerCommandDispatched = true;
            return { appId: 'app_9999', pid: 9999 };
        };

        // 1. Rejected executable must NOT dispatch to worker
        assert.throws(() => mockManager.validateExecutable('evil_trojan.exe'));
        await assert.rejects(async () => await mockManager.launchApp('evil_trojan.exe'));
        assert.equal(workerCommandDispatched, false, 'Worker must NOT be called for unallowlisted app');

        // 2. Rejected arguments must NOT dispatch to worker
        await assert.rejects(async () => await mockManager.launchApp('notepad.exe', 'notes.txt & calc.exe'));
        assert.equal(workerCommandDispatched, false, 'Worker must NOT be called for injected arguments');

        // 3. Valid app dispatches
        const successResult = await mockManager.launchApp('notepad', 'safe.txt');
        assert.equal(workerCommandDispatched, true);
        assert.equal(successResult.ok, true);
        assert.equal(successResult.status, 'launched');
    });
});
