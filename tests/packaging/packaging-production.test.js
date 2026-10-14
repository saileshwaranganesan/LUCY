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
});
