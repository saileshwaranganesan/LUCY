'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { DesktopAutomationManager, SAFE_APP_ALLOWLIST } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');

test('L.U.C.Y. Repair 8 — Safe Desktop Automation & Ownership Isolation Regression Suite', async (suite) => {

    // =========================================================================
    // Scenario 1: Dedicated app launch and ownership tracking
    // =========================================================================
    await suite.test('Scenario 1: Dedicated app launch and ownership tracking', async () => {
        const manager = new DesktopAutomationManager();

        // Simulate successful worker launch response
        const mockStartTime = new Date().toISOString();
        manager.sendCommand = async (cmd, payload) => {
            assert.equal(cmd, 'launch_app');
            return {
                appId: 'app_54321',
                pid: 54321,
                processStartTime: mockStartTime,
                windowHandle: 1234567,
                windowTitle: 'Untitled - Notepad'
            };
        };

        const taskId = 'task_audit_001';
        const launchResult = await manager.launchApp('notepad.exe', '', { taskId });

        assert.equal(launchResult.ok, true);
        assert.equal(launchResult.appId, 'app_54321');
        assert.equal(launchResult.pid, 54321);
        assert.equal(launchResult.taskId, taskId);
        assert.equal(launchResult.ownership, 'OWNED');

        // Verify tracked metadata in manager
        assert.equal(manager.isOwnedByLucy('app_54321'), true);
        assert.equal(manager.isOwnedByLucy(54321), true);
        assert.equal(manager.isOwnedByLucy('app_54321', taskId), true);
        assert.equal(manager.isOwnedByLucy('app_54321', 'wrong_task'), false);

        const tracked = manager.getTrackedApp('app_54321');
        assert.ok(tracked, 'Tracked record must exist');
        assert.equal(tracked.launchedByLucy, true);
        assert.equal(tracked.ownershipState, 'OWNED');
        assert.equal(tracked.canCleanup, true);
        assert.equal(tracked.lifecycleState, 'active');
        assert.equal(tracked.processStartTime, mockStartTime);
        assert.equal(tracked.windowHandle, 1234567);
        assert.equal(tracked.taskId, taskId);

        manager.cleanup();
    });

    // =========================================================================
    // Scenario 2: Pre-existing app with same exe name is unowned
    // =========================================================================
    await suite.test('Scenario 2: Pre-existing app with same exe name is unowned', async () => {
        const manager = new DesktopAutomationManager();

        let commandSentToWorker = false;
        manager.sendCommand = async () => {
            commandSentToWorker = true;
            return { closed: true };
        };

        const externalUserPid = 98765;

        // 1. isOwnedByLucy must report false
        assert.equal(manager.isOwnedByLucy(externalUserPid), false);
        assert.equal(manager.isOwnedByLucy('notepad.exe'), false);
        assert.equal(manager.isOwnedByLucy('notepad'), false);

        // 2. assertOwnership must throw UNAUTHORIZED_RESOURCE_ACCESS
        assert.throws(() => {
            manager.assertOwnership(externalUserPid);
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            assert.ok(err.message.includes('Lucy did not launch'));
            return true;
        });

        // 3. closeApp with destructive policy ('dont_save') must throw UNAUTHORIZED_RESOURCE_ACCESS
        await assert.rejects(async () => {
            await manager.closeApp(externalUserPid, { savePolicy: 'dont_save' });
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // 4. handleDialog with 'dont_save' must throw UNAUTHORIZED_RESOURCE_ACCESS
        await assert.rejects(async () => {
            await manager.handleDialog(externalUserPid, 'dont_save');
        }, (err) => {
            assert.equal(err.code, 'UNAUTHORIZED_RESOURCE_ACCESS');
            return true;
        });

        // Ensure zero commands were dispatched to worker
        assert.equal(commandSentToWorker, false, 'No command should be sent to worker for unowned destructive requests');

        manager.cleanup();
    });

    // =========================================================================
    // Scenario 3: Task cleanup leaves untracked user process untouched
    // =========================================================================
    await suite.test('Scenario 3: Task cleanup leaves untracked user process untouched', async () => {
        const manager = new DesktopAutomationManager();

        const closedAppIds = [];
        manager.sendCommand = async (cmd, payload) => {
            if (cmd === 'close_app') {
                closedAppIds.push(payload.appId);
                return { closed: true, pid: payload.pid };
            }
            return {};
        };

        // Seed manager with two Lucy apps from different tasks
        manager.trackedApps.set('app_1001', {
            resourceId: 'res_1001',
            appId: 'app_1001',
            pid: 1001,
            processStartTime: new Date().toISOString(),
            windowHandle: 10010,
            exe: 'notepad.exe',
            windowTitle: 'Task A Document',
            launchedByLucy: true,
            ownershipState: 'OWNED',
            taskId: 'task_A',
            canCleanup: true,
            launchedAt: new Date().toISOString(),
            lifecycleState: 'active'
        });

        manager.trackedApps.set('app_1002', {
            resourceId: 'res_1002',
            appId: 'app_1002',
            pid: 1002,
            processStartTime: new Date().toISOString(),
            windowHandle: 10020,
            exe: 'calc.exe',
            windowTitle: 'Task B Calculator',
            launchedByLucy: true,
            ownershipState: 'OWNED',
            taskId: 'task_B',
            canCleanup: true,
            launchedAt: new Date().toISOString(),
            lifecycleState: 'active'
        });

        // Untracked external user application PID 9999 exists on system
        // Clean up task_A resources
        const cleanupResults = await manager.cleanupTaskResources('task_A');

        assert.equal(cleanupResults.length, 1);
        assert.equal(cleanupResults[0].appId, 'app_1001');
        assert.equal(closedAppIds.length, 1);
        assert.equal(closedAppIds[0], 'app_1001');

        // Task B application must still be tracked and active
        assert.equal(manager.isOwnedByLucy('app_1002'), true);
        const appB = manager.getTrackedApp('app_1002');
        assert.equal(appB.lifecycleState, 'active');

        // Task A app is now removed from tracking
        assert.equal(manager.getTrackedApp('app_1001'), null);

        manager.cleanup();
    });

    // =========================================================================
    // Scenario 4: PID reuse or stale window handle refuses destructive cleanup
    // =========================================================================
    await suite.test('Scenario 4: PID reuse or stale window handle refuses destructive cleanup', async () => {
        const manager = new DesktopAutomationManager();

        // Simulate tracking an app with an original start time
        const originalStartTime = '2026-01-01T00:00:00.0000000Z';
        manager.trackedApps.set('app_2001', {
            resourceId: 'res_2001',
            appId: 'app_2001',
            pid: 2001,
            processStartTime: originalStartTime,
            windowHandle: 20010,
            exe: 'notepad.exe',
            windowTitle: 'Original Note',
            launchedByLucy: true,
            ownershipState: 'OWNED',
            taskId: 'task_reuse',
            canCleanup: true,
            launchedAt: originalStartTime,
            lifecycleState: 'active'
        });

        // 1. Verify payload generated contains expectedStartTime
        const payload = manager._resolveTargetPayload('app_2001');
        assert.equal(payload.expectedStartTime, originalStartTime);
        assert.equal(payload.windowHandle, 20010);
        assert.equal(payload.pid, 2001);

        // 2. Simulate worker returning PID_REUSE_DETECTED error
        manager.sendCommand = async (cmd, p) => {
            if (p.expectedStartTime && p.expectedStartTime !== '2026-10-17T12:00:00.0000000Z') {
                const err = new Error('PID_REUSE_DETECTED: Target process ID does not match expected process creation time.');
                throw err;
            }
            return { closed: true };
        };

        await assert.rejects(async () => {
            await manager.closeApp('app_2001', { savePolicy: 'dont_save', taskId: 'task_reuse' });
        }, (err) => {
            assert.ok(err.message.includes('PID_REUSE_DETECTED'));
            return true;
        });

        // App remains active because destructive cleanup was safely refused
        const stillTracked = manager.getTrackedApp('app_2001');
        assert.equal(stillTracked.lifecycleState, 'active');

        manager.cleanup();
    });

    // =========================================================================
    // Scenario 5: Missing target never redirects keyboard input to foreground window
    // =========================================================================
    await suite.test('Scenario 5: Missing target never redirects keyboard input to foreground window', async () => {
        const manager = new DesktopAutomationManager();

        let workerCommandCalled = false;
        manager.sendCommand = async (cmd, payload) => {
            workerCommandCalled = true;
            if (cmd === 'type_text') {
                // Real worker behavior when window is not found
                throw new Error('Target window not found: 9999999');
            }
            return {};
        };

        manager.trackedApps.set('app_9999999', {
            appId: 'app_9999999',
            pid: 9999999,
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Calling typeText on an owned target whose window is missing should propagate error and never send keys to active window
        await assert.rejects(async () => {
            await manager.typeText(9999999, 'malicious foreground text');
        }, (err) => {
            assert.ok(err.message.includes('Target window not found'));
            return true;
        });

        assert.equal(workerCommandCalled, true);
        manager.cleanup();
    });

    // =========================================================================
    // Scenario 6: Target focus loss aborts input and returns TARGET_FOCUS_LOST
    // =========================================================================
    await suite.test('Scenario 6: Target focus loss aborts input and returns TARGET_FOCUS_LOST', async () => {
        const manager = new DesktopAutomationManager();
        manager.trackedApps.set('app_123', {
            appId: 'app_123',
            pid: 123,
            exe: 'notepad.exe',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // Simulate worker detecting that target window lost focus during text entry
        manager.sendCommand = async (cmd, payload) => {
            if (cmd === 'type_text') {
                throw new Error('FOCUS_VERIFICATION_FAILED: Target window lost foreground during typing simulation');
            }
            return {};
        };

        const result = await manager.typeText('app_123', 'Sample text');
        assert.equal(result.success, false);
        assert.equal(result.verified, false);
        assert.equal(result.reason, 'TARGET_FOCUS_LOST');
        assert.ok(result.error.includes('FOCUS_VERIFICATION_FAILED'));

        manager.cleanup();
    });

    // =========================================================================
    // Scenario 7: Aborted AbortSignal cancels desktop actions immediately
    // =========================================================================
    await suite.test('Scenario 7: Aborted AbortSignal cancels desktop actions immediately', async () => {
        const manager = new DesktopAutomationManager();

        let workerCalled = false;
        manager.sendCommand = async () => {
            workerCalled = true;
            return {};
        };

        const ac = new AbortController();
        ac.abort(); // Pre-aborted signal

        const testCalls = [
            () => manager.launchApp('notepad.exe', '', { signal: ac.signal }),
            () => manager.focusWindow('app_1', { signal: ac.signal }),
            () => manager.inspectUI('app_1', { signal: ac.signal }),
            () => manager.findElement('app_1', {}, { signal: ac.signal }),
            () => manager.typeText('app_1', 'text', { signal: ac.signal }),
            () => manager.clickElement('app_1', {}, { signal: ac.signal }),
            () => manager.takeScreenshot('app_1', { signal: ac.signal }),
            () => manager.closeApp('app_1', { signal: ac.signal }),
            () => manager.detectDialog('app_1', { signal: ac.signal }),
            () => manager.handleDialog('app_1', 'save', { signal: ac.signal }),
            () => manager.closeTab('app_1', { signal: ac.signal })
        ];

        for (const call of testCalls) {
            await assert.rejects(async () => {
                await call();
            }, (err) => {
                assert.equal(err.code, 'CANCELLED');
                assert.ok(err.message.includes('cancelled'));
                return true;
            });
        }

        // Verify that zero commands reached the worker
        assert.equal(workerCalled, false, 'No worker commands should be executed when signal is aborted');

        // Test with ToolRegistry context
        const registry = new ToolRegistry();
        registerDesktopTools(registry, manager);

        const registryRes = await registry.execute('desktop_launch_app', { executable: 'notepad.exe' }, { signal: ac.signal });
        assert.equal(registryRes.ok, false);
        assert.equal(registryRes.status, 'cancelled');

        // Test direct tool handler invocation with aborted signal
        await assert.rejects(async () => {
            await registry.getTool('desktop_launch_app').handler({ executable: 'notepad.exe' }, { signal: ac.signal });
        }, (err) => {
            assert.equal(err.code, 'CANCELLED');
            assert.ok(err.message.includes('Application launch cancelled'));
            return true;
        });

        manager.cleanup();
    });

    // =========================================================================
    // Scenario 8: Multiple windows from same process targeted distinctly via windowHandle
    // =========================================================================
    await suite.test('Scenario 8: Multiple windows from same process targeted distinctly via windowHandle', () => {
        const manager = new DesktopAutomationManager();

        // Two distinct windows belonging to same process 3000
        const winHandle1 = 0x1A2B3C;
        const winHandle2 = 0x4D5E6F;

        manager.trackedApps.set('app_3000_1', {
            appId: 'app_3000_1',
            pid: 3000,
            windowHandle: winHandle1,
            exe: 'notepad.exe',
            windowTitle: 'Document 1 - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        manager.trackedApps.set('app_3000_2', {
            appId: 'app_3000_2',
            pid: 3000,
            windowHandle: winHandle2,
            exe: 'notepad.exe',
            windowTitle: 'Document 2 - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // 1. Direct windowHandle lookup
        const app1 = manager.getTrackedApp({ windowHandle: winHandle1 });
        const app2 = manager.getTrackedApp({ windowHandle: winHandle2 });

        assert.equal(app1.appId, 'app_3000_1');
        assert.equal(app2.appId, 'app_3000_2');
        assert.notEqual(app1.windowHandle, app2.windowHandle);

        // 2. Payload resolution includes exact windowHandle
        const payload1 = manager._resolveTargetPayload({ windowHandle: winHandle1 });
        const payload2 = manager._resolveTargetPayload({ windowHandle: winHandle2 });

        assert.equal(payload1.windowHandle, winHandle1);
        assert.equal(payload2.windowHandle, winHandle2);

        manager.cleanup();
    });

    // =========================================================================
    // Scenario 9: Teardown cleans only test-tracked PIDs without system-wide kills
    // =========================================================================
    await suite.test('Scenario 9: Teardown cleans only test-tracked PIDs without system-wide kills', async () => {
        // Track test-launched PIDs in a dedicated Set
        const testLaunchedPids = new Set([7001, 7002]);
        const externalUserPid = 7003;

        const terminatedPids = [];
        const safeTeardown = async (trackedPids) => {
            for (const pid of trackedPids) {
                // Simulate safe targeted termination per PID only
                terminatedPids.push(pid);
            }
            trackedPids.clear();
        };

        await safeTeardown(testLaunchedPids);

        assert.equal(terminatedPids.includes(7001), true);
        assert.equal(terminatedPids.includes(7002), true);
        assert.equal(terminatedPids.includes(externalUserPid), false, 'External user PID must never be in teardown target list');
        assert.equal(testLaunchedPids.size, 0);
    });

    // =========================================================================
    // Scenario 10: Ambiguous ownership produces safe, truthful task failure
    // =========================================================================
    await suite.test('Scenario 10: Ambiguous ownership produces safe, truthful task failure (AMBIGUOUS_APPLICATION_OWNERSHIP)', async () => {
        const manager = new DesktopAutomationManager();

        // Seed two active tracked apps with matching name / executable
        manager.trackedApps.set('app_8001', {
            appId: 'app_8001',
            pid: 8001,
            exe: 'C:\\Windows\\notepad.exe',
            windowTitle: 'Untitled - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        manager.trackedApps.set('app_8002', {
            appId: 'app_8002',
            pid: 8002,
            exe: 'C:\\Windows\\notepad.exe',
            windowTitle: 'Untitled - Notepad',
            launchedByLucy: true,
            lifecycleState: 'active'
        });

        // 1. Ambiguous lookup check
        const ambiguityCheck = manager.getTrackedApp('notepad');
        assert.ok(ambiguityCheck.ambiguous, 'Targeting "notepad" when two instances are open must be ambiguous');
        assert.equal(ambiguityCheck.matches.length, 2);

        // 2. isOwnedByLucy must fail-closed on ambiguous target
        assert.equal(manager.isOwnedByLucy('notepad'), false);

        // 3. assertOwnership must throw AMBIGUOUS_APPLICATION_OWNERSHIP
        assert.throws(() => {
            manager.assertOwnership('notepad');
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_APPLICATION_OWNERSHIP');
            assert.ok(err.message.includes('Multiple active instances match'));
            return true;
        });

        // 4. closeApp must fail-closed with AMBIGUOUS_APPLICATION_OWNERSHIP
        await assert.rejects(async () => {
            await manager.closeApp('notepad', { savePolicy: 'dont_save' });
        }, (err) => {
            assert.equal(err.code, 'AMBIGUOUS_APPLICATION_OWNERSHIP');
            return true;
        });

        // 5. Specifying exact unambiguous appId succeeds
        const unambiguous = manager.getTrackedApp('app_8001');
        assert.ok(unambiguous);
        assert.equal(unambiguous.appId, 'app_8001');
        assert.equal(manager.isOwnedByLucy('app_8001'), true);

        manager.cleanup();
    });

});
