'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CredentialStore } = require('../../src/security/credential-store.js');

test('Security: CredentialStore Windows DPAPI / Secure Cryptographic Storage', async (t) => {
    const tempStoreDir = path.join(os.tmpdir(), `lucy-test-creds-${Date.now()}`);
    const store = new CredentialStore({ storeDir: tempStoreDir });

    t.after(() => {
        fs.rmSync(tempStoreDir, { recursive: true, force: true });
    });

    await t.test('encrypts credentials and does NOT store plaintext or raw Base64', () => {
        const testSecret = 'AIzaSyDemoKeySecret-9876543210';
        store.setSecret('gemini_api_key', testSecret);

        // Check file on disk
        const rawFileContent = fs.readFileSync(store.storePath, 'utf8');
        assert.ok(!rawFileContent.includes(testSecret), 'File on disk MUST NOT contain plaintext secret');

        // Verify that raw base64 of secret is NOT in the file (no naive base64 obfuscation)
        const naiveBase64 = Buffer.from(testSecret).toString('base64');
        assert.ok(!rawFileContent.includes(naiveBase64), 'File on disk MUST NOT contain naive Base64 encoding');

        const parsed = JSON.parse(rawFileContent);
        assert.ok(parsed.gemini_api_key, 'Key entry should exist');
        assert.ok(parsed.gemini_api_key.ciphertext, 'Ciphertext should be stored');
        assert.ok(parsed.gemini_api_key.algorithm, 'Algorithm metadata should exist');
    });

    await t.test('round-trip decryption returns original secret', () => {
        const retrieved = store.getSecret('gemini_api_key');
        assert.equal(retrieved, 'AIzaSyDemoKeySecret-9876543210');
        assert.equal(store.hasSecret('gemini_api_key'), true);
    });

    await t.test('redacts secret values from text output', () => {
        const rawLog = 'Connecting to Gemini with key AIzaSyDemoKeySecret-9876543210 at endpoint';
        const redacted = store.redact(rawLog);
        assert.ok(!redacted.includes('AIzaSyDemoKeySecret-9876543210'), 'Secret must be scrubbed from log');
        assert.ok(redacted.includes('[REDACTED_SECRET]'), 'Placeholder must replace secret');
    });

    await t.test('lists configured keys with zero secret leakage', () => {
        const list = store.listConfiguredKeys();
        assert.equal(list.length, 1);
        assert.equal(list[0].key, 'gemini_api_key');
        assert.equal(list[0].configured, true);
        assert.ok(!('ciphertext' in list[0]));
        assert.ok(!('value' in list[0]));
    });

    await t.test('deletes secrets cleanly from cache and disk', () => {
        store.deleteSecret('gemini_api_key');
        assert.equal(store.hasSecret('gemini_api_key'), false);
        assert.equal(store.getSecret('gemini_api_key'), '');

        const rawFileContent = fs.readFileSync(store.storePath, 'utf8');
        const parsed = JSON.parse(rawFileContent);
        assert.equal(parsed.gemini_api_key, undefined);
    });
});
