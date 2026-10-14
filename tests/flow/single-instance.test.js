'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

test('SEC-004: Real Electron Single-Instance Lock Prevents Concurrent Running Instances', async () => {
    const electronBinary = path.join(
        __dirname,
        '../../node_modules/electron/dist/electron.exe'
    );
    const appDir = path.resolve(__dirname, '../../');
    const testUserDataDir = path.join(os.tmpdir(), `lucy-lock-test-${Date.now()}`);
    fs.mkdirSync(testUserDataDir, { recursive: true });

    // 1. Launch Primary Electron instance with isolated user-data-dir
    const primaryChild = spawn(electronBinary, ['.', `--user-data-dir=${testUserDataDir}`], {
        cwd: appDir,
        env: {
            ...process.env,
            ELECTRON_ENABLE_LOGGING: '1',
            LUCY_SMOKE_TEST: 'false'
        },
        windowsHide: true
    });

    let primaryStderr = '';
    primaryChild.stderr.on('data', (d) => { primaryStderr += d.toString(); });

    // Give primary process a moment to acquire the single instance lock
    await new Promise((r) => setTimeout(r, 2500));

    try {
        // 2. Launch Secondary Electron instance targeting the same user-data-dir
        const secondaryExitPromise = new Promise((resolve, reject) => {
            const secondaryChild = spawn(electronBinary, ['.', `--user-data-dir=${testUserDataDir}`], {
                cwd: appDir,
                env: {
                    ...process.env,
                    ELECTRON_ENABLE_LOGGING: '1',
                    LUCY_SMOKE_TEST: 'false'
                },
                windowsHide: true
            });

            let secondaryStdout = '';
            let secondaryStderr = '';
            secondaryChild.stdout.on('data', (d) => { secondaryStdout += d.toString(); });
            secondaryChild.stderr.on('data', (d) => { secondaryStderr += d.toString(); });

            const timer = setTimeout(() => {
                secondaryChild.kill();
                reject(new Error(`Secondary instance did not exit within 8 seconds as expected for single instance lock. Stderr: ${secondaryStderr}`));
            }, 8000);

            secondaryChild.on('exit', (code) => {
                clearTimeout(timer);
                resolve({ code, stdout: secondaryStdout, stderr: secondaryStderr });
            });

            secondaryChild.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const secondaryResult = await secondaryExitPromise;
        // Secondary instance must have exited cleanly with code 0
        assert.equal(secondaryResult.code, 0, 'Secondary instance must exit with code 0 after being denied lock');
        console.log('   ✔ Secondary instance exited cleanly with code 0 (single instance lock held by primary).');

    } finally {
        // Clean up primary instance
        primaryChild.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        try { primaryChild.kill('SIGKILL'); } catch (_) {}
        try { fs.rmSync(testUserDataDir, { recursive: true, force: true }); } catch (_) {}
    }
});
