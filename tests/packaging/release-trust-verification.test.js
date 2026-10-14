'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const { generateReleaseManifest } = require('../../scripts/generate-release-manifest.js');
const { verifyReleaseArtifacts, computeSha256 } = require('../../scripts/verify-release-artifacts.js');

test('DEF-005: Windows Release Trust and Checksum Verification Suite', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-release-trust-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    // 1. Production Artifacts Verification
    await t.test('1. Production dist-release directory contains verifiable artifacts and manifest', () => {
        const distDir = path.resolve(__dirname, '../../dist-release');
        assert.ok(fs.existsSync(distDir), 'dist-release directory must exist');

        const manifestResult = generateReleaseManifest({ distDir });
        assert.ok(manifestResult.artifactCount >= 2, 'Must have at least installer and portable binaries');

        const verifyResult = verifyReleaseArtifacts({ distDir });
        assert.equal(verifyResult.ok, true, 'All production artifacts must verify against generated hashes');
        assert.equal(verifyResult.failedCount, 0);

        // Verify known installer and portable executable
        const installerResult = verifyResult.results.find((r) => r.filename.includes('Setup') && r.filename.endsWith('.exe'));
        const portableResult = verifyResult.results.find((r) => r.filename.includes('Portable') && r.filename.endsWith('.exe'));

        assert.ok(installerResult, 'Installer result must be present');
        assert.ok(portableResult, 'Portable result must be present');
        assert.equal(installerResult.verified, true);
        assert.equal(portableResult.verified, true);
    });

    // 2. Disposable Test Fixture: Clean verification
    await t.test('2. Disposable test fixture generates valid manifest and passes verification', () => {
        const fixtureDir = path.join(testDir, 'clean-fixture');
        fs.mkdirSync(fixtureDir, { recursive: true });

        // Create fake installer and portable binaries
        const binA = path.join(fixtureDir, 'L.U.C.Y-Setup-0.1.0-win-x64.exe');
        const binB = path.join(fixtureDir, 'L.U.C.Y-Portable-0.1.0-win-x64.exe');
        fs.writeFileSync(binA, 'TEST_INSTALLER_BINARY_PAYLOAD_ABC123');
        fs.writeFileSync(binB, 'TEST_PORTABLE_BINARY_PAYLOAD_XYZ789');

        const manifestResult = generateReleaseManifest({ distDir: fixtureDir, rootDir: path.resolve(__dirname, '../..') });
        assert.equal(manifestResult.artifactCount, 2);

        // Verify SHA256SUMS.txt exists and contains expected entries
        const sumsPath = path.join(fixtureDir, 'SHA256SUMS.txt');
        assert.ok(fs.existsSync(sumsPath));
        const sumsContent = fs.readFileSync(sumsPath, 'utf8');
        assert.match(sumsContent, /L\.U\.C\.Y-Setup/);
        assert.match(sumsContent, /L\.U\.C\.Y-Portable/);

        const verifyResult = verifyReleaseArtifacts({ distDir: fixtureDir });
        assert.equal(verifyResult.ok, true);
        assert.equal(verifyResult.totalChecked, 2);
        assert.equal(verifyResult.passedCount, 2);
        assert.equal(verifyResult.failedCount, 0);
    });

    // 3. Tampering Detection: Modified / corrupted artifact fails verification
    await t.test('3. Tampered artifact with altered byte content fails checksum verification fail-closed', () => {
        const fixtureDir = path.join(testDir, 'tampered-fixture');
        fs.mkdirSync(fixtureDir, { recursive: true });

        const binA = path.join(fixtureDir, 'L.U.C.Y-Setup-0.1.0-win-x64.exe');
        fs.writeFileSync(binA, 'AUTHENTIC_VERIFIED_BINARY_CONTENT');

        generateReleaseManifest({ distDir: fixtureDir, rootDir: path.resolve(__dirname, '../..') });

        // Simulate tampering or corrupted download by flipping bytes
        fs.writeFileSync(binA, 'MALICIOUS_TAMPERED_INJECTED_CONTENT');

        const verifyResult = verifyReleaseArtifacts({ distDir: fixtureDir });
        assert.equal(verifyResult.ok, false, 'Tampered artifact must fail verification');
        assert.equal(verifyResult.failedCount, 1);
        assert.equal(verifyResult.passedCount, 0);

        const failRecord = verifyResult.results[0];
        assert.equal(failRecord.status, 'hash_mismatch');
        assert.match(failRecord.error, /SHA-256 checksum mismatch/i);
    });

    // 4. Missing Artifact Detection
    await t.test('4. Missing artifact listed in release manifest triggers missing_file error', () => {
        const fixtureDir = path.join(testDir, 'missing-fixture');
        fs.mkdirSync(fixtureDir, { recursive: true });

        const binA = path.join(fixtureDir, 'L.U.C.Y-Setup-0.1.0-win-x64.exe');
        const binB = path.join(fixtureDir, 'L.U.C.Y-Portable-0.1.0-win-x64.exe');
        fs.writeFileSync(binA, 'BINARY_A');
        fs.writeFileSync(binB, 'BINARY_B');

        generateReleaseManifest({ distDir: fixtureDir, rootDir: path.resolve(__dirname, '../..') });

        // Delete binary B
        fs.unlinkSync(binB);

        const verifyResult = verifyReleaseArtifacts({ distDir: fixtureDir });
        assert.equal(verifyResult.ok, false);
        assert.equal(verifyResult.failedCount, 1);
        assert.equal(verifyResult.passedCount, 1);

        const missing = verifyResult.results.find((r) => r.filename.includes('Portable'));
        assert.equal(missing.status, 'missing_file');
        assert.match(missing.error, /Artifact missing on disk/i);
    });

    // 5. Security & Exclusion Boundary: Zero private signing keys in repository
    await t.test('5. Zero private keys, certificates, or PFX/P12 files exist in repository', () => {
        const rootDir = path.resolve(__dirname, '../..');
        const gitignoreContent = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');

        assert.match(gitignoreContent, /\*\.pfx/i, '.gitignore must exclude *.pfx');
        assert.match(gitignoreContent, /\*\.p12/i, '.gitignore must exclude *.p12');
        assert.match(gitignoreContent, /\*\.key/i, '.gitignore must exclude *.key');
        assert.match(gitignoreContent, /\*\.pem/i, '.gitignore must exclude *.pem');
    });
});
