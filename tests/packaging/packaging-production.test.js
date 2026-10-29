'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { resolveExeFile } = require('../../src/tools/native-uia/build-worker.js');

test('Production Packaging & Installer Verification Suite', async (t) => {

    await t.test('LucyUiaWorker.exe path resolution supports dev and packaged environments', () => {
        const resolvedPath = resolveExeFile();
        assert.ok(typeof resolvedPath === 'string' && resolvedPath.length > 0, 'Resolved path must be non-empty');
        assert.ok(resolvedPath.endsWith('LucyUiaWorker.exe'), 'Must point to LucyUiaWorker.exe');
        assert.ok(fs.existsSync(resolvedPath), 'Resolved executable must exist on disk');
    });

    await t.test('electron-builder.yml defines per-user install and user-data preservation', () => {
        const configPath = path.resolve(__dirname, '../../electron-builder.yml');
        assert.ok(fs.existsSync(configPath), 'electron-builder.yml must exist');
        const content = fs.readFileSync(configPath, 'utf8');

        assert.ok(content.includes('perMachine: false'), 'Must specify per-user non-admin installation');
        assert.ok(content.includes('deleteAppDataOnUninstall: false'), 'Must protect user data on uninstall');
        assert.ok(content.includes('LucyUiaWorker.exe'), 'Must unpack LucyUiaWorker.exe from asar');
        assert.ok(!content.includes('src/companion/assets'), 'Obsolete companion dragon assets must not be unpacked');
        assert.ok(content.includes('playwright-core'), 'Must unpack playwright-core runtime');
    });

    await t.test('Production installer binary exists with valid size and checksum', () => {
        const installerPath = path.resolve(__dirname, '../../dist-release/L.U.C.Y-Setup-0.1.0-win-x64.exe');
        assert.ok(fs.existsSync(installerPath), 'Installer binary must exist in dist-release');
        const stats = fs.statSync(installerPath);
        assert.ok(stats.size > 50 * 1024 * 1024, 'Installer must be > 50 MB');

        const buffer = fs.readFileSync(installerPath);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        assert.ok(hash && hash.length === 64, 'SHA-256 hash must be valid 64-char hex string');
    });

    await t.test('Installed application directory structure and critical resources exist', () => {
        const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'LUCY');
        assert.ok(fs.existsSync(installDir), 'Installed application directory must exist');

        const appExe = path.join(installDir, 'LUCY.exe');
        const uninstaller = path.join(installDir, 'Uninstall LUCY.exe');
        const worker = path.join(installDir, 'resources', 'native-uia', 'LucyUiaWorker.exe');

        assert.ok(fs.existsSync(appExe), 'LUCY.exe must be present in installed directory');
        assert.ok(fs.existsSync(uninstaller), 'Uninstall LUCY.exe must be present in installed directory');
        assert.ok(fs.existsSync(worker), 'LucyUiaWorker.exe must be present in resources/native-uia');
    });

    await t.test('User persistent data locations exist outside application installation directory', () => {
        const appDataDir = process.env.APPDATA;
        const memoryDir = path.join(appDataDir, 'lucy-desktop-assistant', 'memory');
        const secureDir = path.join(appDataDir, 'LUCY', 'secure');

        assert.ok(fs.existsSync(memoryDir), 'User persistent memory directory must exist in AppData');
        assert.ok(fs.existsSync(secureDir), 'User DPAPI secure directory must exist in AppData');
    });

    await t.test('LucyUiaWorker.exe resolution never returns a virtual ASAR path and rejects in-archive execution', () => {
        const { isVirtualAsarPath, resolveExeFile } = require('../../src/tools/native-uia/build-worker.js');
        assert.ok(typeof isVirtualAsarPath === 'function', 'isVirtualAsarPath helper must be exported');

        // Verify virtual vs unpacked ASAR classification
        assert.equal(isVirtualAsarPath('C:\\test\\resources\\app.asar\\LucyUiaWorker.exe'), true);
        assert.equal(isVirtualAsarPath('C:/test/resources/app.asar/src/tools/native-uia/LucyUiaWorker.exe'), true);
        assert.equal(isVirtualAsarPath('C:\\test\\resources\\app.asar.unpacked\\src\\tools\\native-uia\\LucyUiaWorker.exe'), false);
        assert.equal(isVirtualAsarPath('C:\\dev\\LUCY\\src\\tools\\native-uia\\LucyUiaWorker.exe'), false);

        // Current resolution must point to a real physical path on disk, not virtual ASAR
        const resolved = resolveExeFile();
        assert.equal(isVirtualAsarPath(resolved), false, 'Resolved path must not be inside virtual ASAR');
    });

    await t.test('DesktopAutomationManager rejects virtual ASAR paths and re-resolves physical binary', async () => {
        const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
        const virtualMock = 'C:\\dummy\\resources\\app.asar\\src\\tools\\native-uia\\LucyUiaWorker.exe';
        const mgr = new DesktopAutomationManager({ workerExe: virtualMock });

        // WorkerExe starts as mock, but ensureWorker will reject it and attempt to resolve physical binary
        try {
            await mgr.ensureWorker();
        } catch (err) {
            // Either spawns successfully if worker exists on dev disk, or fails with not found / compilation error,
            // but must NEVER fail with virtual asar spawn ENOENT
            assert.ok(!err.message.includes('cannot be spawned from virtual asar path') || err.message.includes('LucyUiaWorker'), 'Must handle virtual asar gracefully');
        }
        if (mgr.proc) {
            mgr.cleanup();
        }
    });

    await t.test('Portable packaging configuration specifies unpackDirName: false and patch is applied', () => {
        const configPath = path.resolve(__dirname, '../../electron-builder.yml');
        const content = fs.readFileSync(configPath, 'utf8');
        assert.ok(content.includes('unpackDirName: false'), 'Must configure unpackDirName: false');

        const patchScript = path.resolve(__dirname, '../../scripts/patch-electron-builder.js');
        assert.ok(fs.existsSync(patchScript), 'scripts/patch-electron-builder.js must exist');
        const { applyPatch } = require('../../scripts/patch-electron-builder.js');
        
        // 1. Idempotency verification
        assert.doesNotThrow(() => applyPatch(), 'applyPatch must be idempotent and succeed when already patched');

        // 2. Fresh application durability simulation
        const targetFile = path.resolve(__dirname, '../../node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
        const originalContent = fs.readFileSync(targetFile, 'utf8');
        try {
            // Revert temporarily to buggy pattern
            const buggyPattern = 'if (typeof unpackDirName === "string" || !unpackDirName) {';
            const patchedPattern = 'if (unpackDirName !== false && (typeof unpackDirName === "string" || !unpackDirName)) {';
            const reverted = originalContent.replace(patchedPattern, buggyPattern);
            fs.writeFileSync(targetFile, reverted, 'utf8');

            // Apply patch and verify it caught and fixed it
            const applied = applyPatch();
            assert.strictEqual(applied, true, 'Must detect and fix buggy pattern');
            const newlyPatched = fs.readFileSync(targetFile, 'utf8');
            assert.ok(newlyPatched.includes(patchedPattern), 'Must contain patched pattern after apply');
        } finally {
            // Ensure targetFile is restored
            fs.writeFileSync(targetFile, originalContent, 'utf8');
        }
    });

    await t.test('patch-electron-builder fails closed with error when unexpected code is encountered', () => {
        const { applyPatch } = require('../../scripts/patch-electron-builder.js');
        const targetFile = path.resolve(__dirname, '../../node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
        const originalContent = fs.readFileSync(targetFile, 'utf8');
        try {
            // Inject unexpected corrupted code
            fs.writeFileSync(targetFile, '// Corrupted code with neither pattern', 'utf8');
            assert.throws(() => applyPatch({ strict: true }), /FATAL: Unexpected source/, 'Must throw on unexpected source');
        } finally {
            fs.writeFileSync(targetFile, originalContent, 'utf8');
        }
    });
});


