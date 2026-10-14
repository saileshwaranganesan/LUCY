'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('Smoke Test: Electron Main Process & Desktop Shell Startup', async () => {
    const electronBinary = path.join(
        __dirname,
        '../../node_modules/electron/dist/electron.exe'
    );

    return new Promise((resolve, reject) => {
        let settled = false;
        let stderr = '';

        const child = spawn(electronBinary, ['.'], {
            cwd: path.resolve(__dirname, '../../'),
            env: {
                ...process.env,
                ELECTRON_ENABLE_LOGGING: '1',
                LUCY_SMOKE_TEST: 'true'
            },
            windowsHide: true
        });

        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            assert.ok(!stderr.includes('Uncaught Error'), `Electron process must not have uncaught errors: ${stderr}`);
            resolve();
        }, 4000);

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Failed to spawn electron: ${err.message}`));
        });

        child.on('exit', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            assert.ok(!stderr.includes('Uncaught Error'), `Electron process must not have uncaught errors: ${stderr}`);
            resolve();
        });
    });
});
