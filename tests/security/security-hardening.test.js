'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { createPathBoundaryChecker, registerFileTools } = require('../../src/tools/file-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority } = require('../../src/security/permission-authority.js');
const { CredentialStore } = require('../../src/security/credential-store.js');

test('Security Hardening Suite (Workstream 01: SEC-001, SEC-002, SEC-003)', async (t) => {

    // =========================================================================
    // SEC-001: Content-Security-Policy & Window Navigation Restrictions
    // =========================================================================
    await t.test('SEC-001: index.html defines strict Content-Security-Policy meta tag', () => {
        const htmlPath = path.resolve(__dirname, '../../src/ui/index.html');
        const content = fs.readFileSync(htmlPath, 'utf8');

        // Verify CSP meta tag presence
        assert.ok(content.includes('http-equiv="Content-Security-Policy"'), 'CSP meta tag must be present in index.html');

        // Extract CSP policy string
        const match = content.match(/content="([^"]*default-src[^"]*)"/i);
        assert.ok(match, 'CSP policy attribute must be found in index.html');
        const policy = match[1];

        // Verify strict directives
        assert.ok(policy.includes("default-src 'none'"), "Policy must include default-src 'none'");
        assert.ok(policy.includes("script-src 'self'"), "Policy must restrict script-src to 'self'");
        assert.ok(!policy.includes("'unsafe-eval'"), "Policy must NOT permit 'unsafe-eval'");
        assert.ok(policy.includes("connect-src 'none'"), "Policy must restrict connect-src to 'none'");
        assert.ok(policy.includes("frame-ancestors 'none'"), "Policy must prevent frame embedding");
        assert.ok(policy.includes("base-uri 'self'"), "Policy must restrict base-uri to 'self'");
    });

    await t.test('SEC-001: main/index.js enforces navigation restrictions and denies window creation', () => {
        const mainPath = path.resolve(__dirname, '../../src/main/index.js');
        const content = fs.readFileSync(mainPath, 'utf8');

        // Verify will-navigate restriction
        assert.ok(content.includes("will-navigate"), 'main/index.js must attach a will-navigate handler');
        assert.ok(content.includes("parsed.protocol !== 'file:'"), 'will-navigate must prevent navigation away from local file: protocol');

        // Verify setWindowOpenHandler denial
        assert.ok(content.includes("setWindowOpenHandler"), 'main/index.js must attach setWindowOpenHandler');
        assert.ok(content.includes("action: 'deny'"), 'setWindowOpenHandler must deny window creation');
    });

    // =========================================================================
    // SEC-002: Gemini API Key Header Authentication & Disclose Prevention
    // =========================================================================
    await t.test('SEC-002: Gemini API key is sent via x-goog-api-key header and NEVER in URL query string', async () => {
        const secretKey = 'TEST-SECRET-GEMINI-KEY-998877665544';
        let capturedUrl = '';
        let capturedHeaders = {};

        // Mock global fetch
        const originalFetch = global.fetch;
        global.fetch = async (url, options) => {
            capturedUrl = String(url);
            capturedHeaders = options.headers || {};
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{
                        content: { parts: [{ text: 'Mocked safe response from Gemini' }] }
                    }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
                })
            };
        };

        try {
            const adapter = new ProviderAdapter({
                provider: PROVIDER_TYPES.GEMINI
            });

            const res = await adapter._callGemini(
                [{ role: 'user', content: 'Tell me a secret' }],
                [],
                secretKey,
                { temperature: 0.7, maxTokens: 100 }
            );

            assert.equal(res.ok, true);
            assert.equal(res.content, 'Mocked safe response from Gemini');

            // 1. Verify URL is clean: API key must NOT be anywhere in the URL
            assert.ok(!capturedUrl.includes(secretKey), 'API key must NEVER appear in request URL');
            assert.ok(!capturedUrl.includes('key='), 'URL must not contain ?key= parameter');
            assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');

            // 2. Verify Header authentication: key must be in x-goog-api-key
            assert.equal(capturedHeaders['x-goog-api-key'], secretKey, 'API key must be passed in x-goog-api-key header');
            assert.equal(capturedHeaders['Content-Type'], 'application/json');

        } finally {
            global.fetch = originalFetch;
        }
    });

    await t.test('SEC-002: ProviderAdapter redacts secret key from error responses and thrown messages', async () => {
        const secretKey = 'TEST-SECRET-GEMINI-KEY-LEAK-DEFENSE';
        const originalFetch = global.fetch;

        // Mock error response containing the key
        global.fetch = async () => {
            return {
                ok: false,
                status: 403,
                text: async () => `Permission denied for credential ${secretKey} on resource`
            };
        };

        try {
            const adapter = new ProviderAdapter({
                provider: PROVIDER_TYPES.GEMINI
            });

            const res = await adapter._callGemini(
                [{ role: 'user', content: 'Ping' }],
                [],
                secretKey,
                { temperature: 0.7, maxTokens: 100 }
            );

            assert.equal(res.ok, false);
            assert.ok(!res.error.includes(secretKey), 'Error text must NOT disclose the raw API key');
            assert.ok(res.error.includes('[REDACTED_SECRET]'), 'Secret must be masked as [REDACTED_SECRET]');

        } finally {
            global.fetch = originalFetch;
        }
    });

    // =========================================================================
    // SEC-003: Workspace Path Containment & Prefix Edge Case Defense
    // =========================================================================
    await t.test('SEC-003: createPathBoundaryChecker blocks sibling prefix collisions and parent traversal', () => {
        const tempWorkspace = path.join(os.tmpdir(), `lucy-containment-${Date.now()}`);
        fs.mkdirSync(tempWorkspace, { recursive: true });

        try {
            const checker = createPathBoundaryChecker(tempWorkspace);

            // 1. Valid nested paths are permitted
            const valid1 = checker('file.txt');
            assert.equal(valid1, path.resolve(tempWorkspace, 'file.txt'));

            const validNested = checker('subdir/nested/doc.md');
            assert.equal(validNested, path.resolve(tempWorkspace, 'subdir/nested/doc.md'));

            const validSelf = checker('.');
            assert.equal(validSelf, path.resolve(tempWorkspace));

            // 2. Parent directory traversal is blocked
            assert.throws(() => checker('../outside.txt'), /Path traversal denied/);
            assert.throws(() => checker('../../etc/passwd'), /Path traversal denied/);

            // 3. SIBLING DIRECTORY PREFIX COLLISION DEFENSE:
            // Sibling directories sharing name prefix (e.g. workspace + '2') must be BLOCKED!
            const siblingCollision = `../${path.basename(tempWorkspace)}2/secret.txt`;
            assert.throws(() => checker(siblingCollision), /Path traversal denied/);

            const siblingClone = `../${path.basename(tempWorkspace)}_CLONE/test.dat`;
            assert.throws(() => checker(siblingClone), /Path traversal denied/);

            // 4. Absolute paths outside workspace are blocked
            const outsideAbs = process.platform === 'win32'
                ? 'C:\\Windows\\System32\\cmd.exe'
                : '/etc/shadow';
            assert.throws(() => checker(outsideAbs), /Path traversal denied/);

            // 5. Empty or non-string paths are blocked
            assert.throws(() => checker(''), /Path traversal denied/);
            assert.throws(() => checker(null), /Path traversal denied/);
            assert.throws(() => checker(123), /Path traversal denied/);

        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true });
        }
    });

    await t.test('SEC-003: All ToolRegistry file operations enforce hardened boundary checker', async () => {
        const tempWorkspace = path.join(os.tmpdir(), `lucy-tools-containment-${Date.now()}`);
        fs.mkdirSync(tempWorkspace, { recursive: true });

        const authority = new PermissionAuthority({ workspaceRoot: tempWorkspace });
        authority.setConfirmationHandler(async () => true);
        const registry = new ToolRegistry({ permissionAuthority: authority });
        registerFileTools(registry, tempWorkspace);

        try {
            // Write legitimate file inside workspace
            const writeOk = await registry.execute('file_write', {
                path: 'safe.txt',
                content: 'Safe content'
            });
            assert.equal(writeOk.ok, true);

            // Attempt sibling prefix write collision (e.g. ../LUCY2/hacked.txt)
            const siblingPath = `../${path.basename(tempWorkspace)}2/hacked.txt`;
            const writeEscaped = await registry.execute('file_write', {
                path: siblingPath,
                content: 'Malicious content'
            });
            assert.equal(writeEscaped.ok, false);
            assert.ok(writeEscaped.error.includes('Path traversal denied'));

            // Attempt sibling prefix read
            const readEscaped = await registry.execute('file_read', { path: siblingPath });
            assert.equal(readEscaped.ok, false);
            assert.ok(readEscaped.error.includes('Path traversal denied'));

            // Attempt sibling prefix delete
            const delEscaped = await registry.execute('file_delete', { path: siblingPath });
            assert.equal(delEscaped.ok, false);
            assert.ok(delEscaped.error.includes('Path traversal denied'));

            // Attempt sibling prefix list
            const listEscaped = await registry.execute('file_list', { path: `../${path.basename(tempWorkspace)}2` });
            assert.equal(listEscaped.ok, false);
            assert.ok(listEscaped.error.includes('Path traversal denied'));

            // Confirm disk status: escaped file was NEVER created on disk
            const escapedPhysicalPath = path.resolve(tempWorkspace, siblingPath);
            assert.equal(fs.existsSync(escapedPhysicalPath), false, 'Escaped file must not exist on disk');

        } finally {
            fs.rmSync(tempWorkspace, { recursive: true, force: true });
        }
    });
});
