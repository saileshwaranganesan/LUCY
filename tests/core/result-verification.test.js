'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { ResultVerifier, VERIFICATION_STATUSES } = require('../../src/core/result-verifier.js');

test('Workstream 3: Result Verification Layer', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy-verify-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    const verifier = new ResultVerifier({ workspaceRoot: testDir });

    await t.test('1. Deterministic file write verification: checks presence, byte size, and exact readback', async () => {
        const relPath = 'verified_output.txt';
        const absPath = path.join(testDir, relPath);
        const content = 'Deterministic file content verification string.';
        fs.writeFileSync(absPath, content, 'utf8');

        const step = {
            toolId: 'file_write',
            params: { path: relPath, content }
        };
        const toolResult = {
            ok: true,
            status: 'write_success',
            path: absPath,
            result: { path: absPath, bytesWritten: Buffer.byteLength(content, 'utf8') }
        };

        const outcome = await verifier.verify(step, toolResult);

        assert.equal(outcome.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(outcome.verified, true);
        assert.equal(outcome.method, 'file_write_deterministic_readback');
        assert.equal(outcome.evidence.sizeBytes, Buffer.byteLength(content, 'utf8'));
    });

    await t.test('2. False-success prevention: Tool claiming success when file is missing FAILS verification', async () => {
        const step = {
            toolId: 'file_write',
            params: { path: 'ghost_file.txt', content: 'Should exist but does not' }
        };
        // Fabricated tool result falsely claiming success
        const toolResult = {
            ok: true,
            status: 'write_success',
            result: { bytesWritten: 50 }
        };

        const outcome = await verifier.verify(step, toolResult);

        assert.equal(outcome.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(outcome.verified, false);
        assert.equal(outcome.method, 'file_write_disk_check');
        assert.match(outcome.failureReason, /does not exist on disk/i);
    });

    await t.test('3. False-success prevention: File content mismatch fails verification', async () => {
        const relPath = 'mismatched_file.txt';
        const absPath = path.join(testDir, relPath);
        fs.writeFileSync(absPath, 'Corrupted or wrong content', 'utf8');

        const step = {
            toolId: 'file_write',
            params: { path: relPath, content: 'Expected genuine content' }
        };
        const toolResult = {
            ok: true,
            status: 'write_success',
            path: absPath
        };

        const outcome = await verifier.verify(step, toolResult);

        assert.equal(outcome.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(outcome.verified, false);
        assert.match(outcome.failureReason, /mismatch/i);
    });

    await t.test('4. Inconclusive handling: Absent result data returns inconclusive and NEVER reports success', async () => {
        const step = {
            toolId: 'file_read',
            params: { path: 'empty_payload.txt' }
        };
        // Tool says ok: true but result payload is missing content string
        const toolResult = {
            ok: true,
            status: 'read_done',
            result: {}
        };

        const outcome = await verifier.verify(step, toolResult);

        assert.equal(outcome.status, VERIFICATION_STATUSES.INCONCLUSIVE);
        assert.equal(outcome.verified, false, 'Inconclusive results must never be marked as verified: true');
        assert.match(outcome.failureReason, /no content string/i);
    });

    await t.test('5. Browser navigation verification: checks HTTP status, URL correctness, and CAPTCHA gates', async () => {
        const step = {
            toolId: 'browser_navigate',
            params: { url: 'https://example.com/docs' }
        };

        // 5a. Successful navigation
        const goodResult = {
            ok: true,
            result: { url: 'https://example.com/docs', httpStatus: 200, title: 'Example Documentation' }
        };
        const goodOutcome = await verifier.verify(step, goodResult);
        assert.equal(goodOutcome.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(goodOutcome.verified, true);

        // 5b. HTTP 404 error page fails verification
        const errResult = {
            ok: true,
            result: { url: 'https://example.com/docs', httpStatus: 404, title: 'Page Not Found' }
        };
        const errOutcome = await verifier.verify(step, errResult);
        assert.equal(errOutcome.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(errOutcome.verified, false);

        // 5c. CAPTCHA security challenge fails verification
        const captchaResult = {
            ok: true,
            result: { url: 'https://example.com/docs', httpStatus: 200, title: 'Attention Required! Cloudflare CAPTCHA' }
        };
        const captchaOutcome = await verifier.verify(step, captchaResult);
        assert.equal(captchaOutcome.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(captchaOutcome.verified, false);
        assert.match(captchaOutcome.failureReason, /CAPTCHA/i);
    });

    await t.test('6. Desktop app launch verification with DesktopManager process confirmation', async () => {
        let inspectedPid = null;
        const mockDesktopManager = {
            isProcessRunning: async (pid) => {
                inspectedPid = pid;
                return pid === 12345;
            }
        };

        const appVerifier = new ResultVerifier({
            workspaceRoot: testDir,
            desktopManager: mockDesktopManager
        });

        const step = {
            toolId: 'desktop_launch_app',
            params: { executable: 'notepad.exe' }
        };

        // 6a. Process confirmed alive
        const runningResult = {
            ok: true,
            result: { pid: 12345, launched: true, executable: 'notepad.exe' }
        };
        const runningOutcome = await appVerifier.verify(step, runningResult);
        assert.equal(runningOutcome.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(runningOutcome.verified, true);
        assert.equal(inspectedPid, 12345);

        // 6b. Process died immediately after launch (crashed process)
        const deadResult = {
            ok: true,
            result: { pid: 99999, launched: true, executable: 'notepad.exe' }
        };
        const deadOutcome = await appVerifier.verify(step, deadResult);
        assert.equal(deadOutcome.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(deadOutcome.verified, false);
        assert.match(deadOutcome.failureReason, /not active/i);
    });

    await t.test('7. Dry-run verification: simulated receipts verified without disk mutation', async () => {
        const step = {
            toolId: 'file_write',
            params: { path: 'dry_run_doc.txt', content: 'Simulation only' }
        };
        const simResult = {
            ok: true,
            dryRun: true,
            result: { simulatedAction: 'write', bytesExpected: 15 }
        };

        const outcome = await verifier.verify(step, simResult, { dryRun: true });

        assert.equal(outcome.status, VERIFICATION_STATUSES.VERIFIED);
        assert.equal(outcome.verified, true);
        assert.equal(outcome.method, 'dry_run_simulation_check');

        // Verify disk was NOT mutated
        assert.equal(fs.existsSync(path.join(testDir, 'dry_run_doc.txt')), false);
    });

    await t.test('8. Verification exception safety: unexpected errors fail-closed and return verified: false', async () => {
        const step = { toolId: 'file_write', params: { path: 'any.txt' } };
        // Malformed object triggering an exception in verification
        const brokenResult = {
            ok: true,
            get result() {
                throw new Error('Unexpected corruption during property evaluation');
            }
        };

        const outcome = await verifier.verify(step, brokenResult);

        assert.equal(outcome.status, VERIFICATION_STATUSES.FAILED);
        assert.equal(outcome.verified, false);
        assert.equal(outcome.method, 'verification_exception_handler');
        assert.match(outcome.failureReason, /Verification exception/i);
    });
});
