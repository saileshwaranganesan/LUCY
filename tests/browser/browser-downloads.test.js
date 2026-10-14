'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('fs');
const crypto = require('crypto');

const { BrowserManager } = require('../../src/tools/browser-manager.js');
const { registerBrowserTools } = require('../../src/tools/browser-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');

test('Batch 03: Secure Browser Downloads & Integrity Verification', async (t) => {
    let server = null;
    let serverUrl = '';
    let browserManager = null;
    let toolRegistry = null;
    let permissionAuthority = null;
    let taskPlanner = null;

    const testWorkspace = path.resolve(__dirname, '../../scratch/test-dl-workspace');
    fs.mkdirSync(testWorkspace, { recursive: true });

    const sampleContent = 'L.U.C.Y. Secure Download Test Payload - 2026';
    const sampleSha256 = crypto.createHash('sha256').update(sampleContent).digest('hex');

    // 1. Setup local mock web server
    await new Promise((resolve) => {
        server = http.createServer((req, res) => {
            const reqPath = req.url.split('?')[0];
            if (reqPath === '/download/report.txt') {
                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="report.txt"'
                });
                res.end(sampleContent);
                return;
            }

            if (reqPath === '/download/direct.dat') {
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                res.end(sampleContent);
                return;
            }

            if (req.url === '/page') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><head><title>Download Portal</title></head><body>
                    <h1>Download Center</h1>
                    <a id="dl-link" href="/download/report.txt" download="report.txt">Download Report</a>
                </body></html>`);
                return;
            }

            res.writeHead(404);
            res.end('Not Found');
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            serverUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    browserManager = new BrowserManager({
        headless: true,
        workspaceRoot: testWorkspace
    });

    permissionAuthority = new PermissionAuthority({
        mode: PERMISSION_MODES.AUTONOMOUS_SANDBOX, // Allows workspace writes in sandbox for autonomous testing
        workspaceRoot: testWorkspace
    });

    toolRegistry = new ToolRegistry({ permissionAuthority });
    registerBrowserTools(toolRegistry, browserManager);
    taskPlanner = new TaskPlanner({ toolRegistry });

    t.after(async () => {
        if (browserManager) {
            await browserManager.closeAll().catch(() => {});
        }
        if (server) {
            await new Promise((r) => server.close(r));
        }
        if (fs.existsSync(testWorkspace)) {
            try { fs.rmSync(testWorkspace, { recursive: true, force: true }); } catch {}
        }
    });

    // Test 1: Secure URL Download and SHA-256 calculation
    await t.test('downloads file into workspace downloads directory with correct hash', async () => {
        const result = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`
        });

        assert.equal(result.ok, true);
        assert.equal(result.result.status, 'download_success');
        assert.equal(result.result.filename, 'report.txt');
        assert.equal(result.result.sha256, sampleSha256);
        assert.ok(fs.existsSync(result.result.destinationPath));
        assert.equal(fs.readFileSync(result.result.destinationPath, 'utf8'), sampleContent);
    });

    // Test 2: SHA-256 Integrity Verification (Match vs Mismatch)
    await t.test('verifies matching hash and fails closed on hash mismatch purging file', async () => {
        // Valid expected SHA-256
        const validMatch = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            expectedSha256: sampleSha256,
            customFilename: 'verified_report.txt'
        });
        assert.equal(validMatch.ok, true);
        assert.equal(validMatch.result.status, 'download_success');
        assert.ok(fs.existsSync(validMatch.result.destinationPath));

        // Invalid expected SHA-256
        const fakeSha = '0000000000000000000000000000000000000000000000000000000000000000';
        const invalidMatch = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            expectedSha256: fakeSha,
            customFilename: 'tampered.txt'
        });

        assert.equal(invalidMatch.ok, false);
        assert.equal(invalidMatch.result.status, 'hash_mismatch');
        assert.ok(invalidMatch.result.error.includes('Integrity check failed'));
        // Verify purged from disk!
        const tamperedPath = path.join(testWorkspace, 'downloads', 'tampered.txt');
        assert.equal(fs.existsSync(tamperedPath), false, 'Tampered file MUST be deleted on hash mismatch');
    });

    // Test 3: Destination Containment & Path Traversal Rejection
    await t.test('rejects path traversal attempts outside workspace fail-closed', async () => {
        const traversalResult = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            destinationDir: '../../evil_dir'
        });

        assert.equal(traversalResult.ok, false);
        assert.equal(traversalResult.result.status, 'path_traversal_denied');
        assert.ok(traversalResult.result.error.includes('Path traversal denied'));
    });

    // Test 4: Malicious and Windows Reserved Filename Sanitization
    await t.test('sanitizes traversal, invalid characters, and reserved Windows device names', async () => {
        // Filename with traversal
        const traversalName = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: '../../evil_script.bat'
        });
        assert.equal(traversalName.ok, true);
        assert.equal(traversalName.result.filename, 'evil_script.bat');
        assert.ok(traversalName.result.destinationPath.startsWith(path.join(testWorkspace, 'downloads')));

        // Windows reserved name (CON)
        const conName = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: 'CON.txt'
        });
        assert.equal(conName.ok, true);
        assert.equal(conName.result.filename, 'safe_CON.txt');

        // Forbidden Windows characters
        const invalidChars = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: 'bad:file*name<test>?.txt'
        });
        assert.equal(invalidChars.ok, true);
        assert.equal(invalidChars.result.filename, 'bad_file_name_test__.txt');
    });

    // Test 5: Collision-Safe Filename Resolution (No Silent Overwrite)
    await t.test('handles filename collisions safely without overwriting existing files', async () => {
        const file1 = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: 'unique_doc.txt'
        });
        assert.equal(file1.result.filename, 'unique_doc.txt');

        const file2 = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: 'unique_doc.txt'
        });
        assert.equal(file2.result.filename, 'unique_doc (1).txt');

        const file3 = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: 'unique_doc.txt'
        });
        assert.equal(file3.result.filename, 'unique_doc (2).txt');

        // All 3 files must exist with intact content
        assert.ok(fs.existsSync(file1.result.destinationPath));
        assert.ok(fs.existsSync(file2.result.destinationPath));
        assert.ok(fs.existsSync(file3.result.destinationPath));
    });

    // Test 6: In-Page Element Click Download
    await t.test('triggers and completes download via page element click', async () => {
        await toolRegistry.execute('browser_navigate', { url: `${serverUrl}/page` });

        const clickDl = await toolRegistry.execute('browser_download', {
            clickSelector: '#dl-link',
            customFilename: 'clicked_report.txt'
        });

        assert.equal(clickDl.ok, true);
        assert.equal(clickDl.result.status, 'download_success');
        assert.equal(clickDl.result.filename, 'clicked_report.txt');
        assert.equal(clickDl.result.sha256, sampleSha256);
    });

    // Test 7: Download Tracking and Listing
    await t.test('tracks and lists session downloads with metadata', async () => {
        const listDl = await toolRegistry.execute('browser_list_downloads', {});
        assert.equal(listDl.ok, true);
        assert.ok(listDl.result.totalDownloads > 0);
        assert.ok(Array.isArray(listDl.result.downloads));
        const completed = listDl.result.downloads.find((d) => d.status === 'completed');
        assert.ok(completed);
        assert.ok(completed.sha256);
    });

    // Test 8: Mechanical Dry-Run Isolation
    await t.test('simulates download action without making network calls or touching disk', async () => {
        const dryRun = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: 'should_not_exist.txt'
        }, { dryRun: true });

        assert.equal(dryRun.ok, true);
        assert.equal(dryRun.dryRun, true);
        assert.equal(dryRun.executed, false);
        assert.equal(dryRun.simulatedDetails.simulatedAction, 'download');
        assert.equal(fs.existsSync(path.join(testWorkspace, 'downloads', 'should_not_exist.txt')), false);
    });

    // Test 9: TaskPlanner Natural Language Parsing
    await t.test('plans download directives correctly via TaskPlanner', async () => {
        const planDl = await taskPlanner.plan(`download file from ${serverUrl}/download/report.txt with hash ${sampleSha256}`);
        assert.equal(planDl.type, 'plan');
        assert.equal(planDl.steps[0].toolId, 'browser_download');
        assert.equal(planDl.steps[0].params.url, `${serverUrl}/download/report.txt`);
        assert.equal(planDl.steps[0].params.expectedSha256, sampleSha256);

        const planDlMissing = await taskPlanner.plan('download file');
        assert.equal(planDlMissing.type, 'clarification');
        assert.deepEqual(planDlMissing.missingParameters, ['url']);

        const planListDl = await taskPlanner.plan('list downloads');
        assert.equal(planListDl.type, 'plan');
        assert.equal(planListDl.steps[0].toolId, 'browser_list_downloads');

        const planCancel = await taskPlanner.plan('cancel download dl_test_99');
        assert.equal(planCancel.type, 'plan');
        assert.equal(planCancel.steps[0].toolId, 'browser_cancel_download');
        assert.equal(planCancel.steps[0].params.downloadId, 'dl_test_99');
    });

    // Test 10: Cancellation and Interrupted Downloads
    await t.test('cancels in-progress downloads, purges temp files, and enforces terminal state', async () => {
        const dlId = `dl_cancel_${Date.now()}`;
        const fakeTempPath = path.join(testWorkspace, 'downloads', 'in_progress.txt.part_123');
        fs.writeFileSync(fakeTempPath, 'partial data');
        const fakeDestPath = path.join(testWorkspace, 'downloads', 'in_progress.txt');
        browserManager.reservedDestinations.add(fakeDestPath);

        browserManager.activeDownloads.set(dlId, {
            id: dlId,
            url: `${serverUrl}/download/report.txt`,
            status: 'in_progress',
            startTime: Date.now(),
            destPath: fakeDestPath,
            tempFilePath: fakeTempPath,
            downloadObj: null
        });

        const cancelRes = await toolRegistry.execute('browser_cancel_download', { downloadId: dlId });
        assert.equal(cancelRes.ok, true);
        assert.equal(cancelRes.result.status, 'download_cancelled');
        assert.equal(fs.existsSync(fakeTempPath), false, 'Temp partial file must be deleted on cancellation');
        assert.equal(browserManager.reservedDestinations.has(fakeDestPath), false, 'Reserved destination must be freed');

        // Cannot cancel an already cancelled download
        const repeatCancel = await toolRegistry.execute('browser_cancel_download', { downloadId: dlId });
        assert.equal(repeatCancel.ok, false);
        assert.equal(repeatCancel.result.status, 'invalid_state');

        // Cancelling nonexistent download returns not_found
        const notFoundCancel = await toolRegistry.execute('browser_cancel_download', { downloadId: 'dl_nonexistent' });
        assert.equal(notFoundCancel.ok, false);
        assert.equal(notFoundCancel.result.status, 'not_found');
    });

    // Test 11: Hashing Failure Handling Without Reporting False Success
    await t.test('handles hashing failure safely and reports failure without false success', async () => {
        const originalCompute = browserManager._computeSha256;
        browserManager._computeSha256 = async () => {
            throw new Error('EACCES: permission denied during file read');
        };

        try {
            const failHashResult = await toolRegistry.execute('browser_download', {
                url: `${serverUrl}/download/report.txt`,
                customFilename: 'hash_failure_test.txt'
            });

            assert.equal(failHashResult.ok, false);
            assert.equal(failHashResult.result.status, 'hashing_failed');
            assert.ok(failHashResult.result.error.includes('Hashing failed'));
            assert.equal(fs.existsSync(path.join(testWorkspace, 'downloads', 'hash_failure_test.txt')), false);
        } finally {
            browserManager._computeSha256 = originalCompute;
        }
    });

    // Test 12: Browser Disconnection and Failure Handling
    await t.test('handles browser failure gracefully and reports download_failed', async () => {
        const disconnectedManager = new BrowserManager({
            headless: true,
            workspaceRoot: testWorkspace
        });
        disconnectedManager.ensurePage = async () => {
            throw new Error('Target closed / browser process disconnected');
        };

        const discRegistry = new ToolRegistry({ permissionAuthority });
        registerBrowserTools(discRegistry, disconnectedManager);

        const dlResult = await discRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`
        });

        assert.equal(dlResult.ok, false);
        assert.equal(dlResult.result.status, 'download_failed');
        assert.ok(dlResult.result.error.includes('browser process disconnected'));
    });

    // Test 13: Concurrent Simultaneous Downloads Targeting Same Filename
    await t.test('handles concurrent simultaneous downloads with identical target names without collisions', async () => {
        const [dl1, dl2] = await Promise.all([
            toolRegistry.execute('browser_download', {
                url: `${serverUrl}/download/report.txt`,
                customFilename: 'concurrent_doc.txt'
            }),
            toolRegistry.execute('browser_download', {
                url: `${serverUrl}/download/report.txt`,
                customFilename: 'concurrent_doc.txt'
            })
        ]);

        assert.equal(dl1.ok, true);
        assert.equal(dl2.ok, true);
        assert.equal(dl1.result.status, 'download_success');
        assert.equal(dl2.result.status, 'download_success');

        // Filenames must be distinct
        assert.notEqual(dl1.result.filename, dl2.result.filename);
        const filenames = [dl1.result.filename, dl2.result.filename].sort();
        assert.deepEqual(filenames, ['concurrent_doc (1).txt', 'concurrent_doc.txt']);

        // Both files must exist on disk and have intact content and valid hashes
        assert.ok(fs.existsSync(dl1.result.destinationPath));
        assert.ok(fs.existsSync(dl2.result.destinationPath));
        assert.equal(fs.readFileSync(dl1.result.destinationPath, 'utf8'), sampleContent);
        assert.equal(fs.readFileSync(dl2.result.destinationPath, 'utf8'), sampleContent);
        assert.equal(dl1.result.sha256, sampleSha256);
        assert.equal(dl2.result.sha256, sampleSha256);
    });

    // Test 14: Downloaded Files Are Never Executed Automatically
    await t.test('confirms downloaded script or binary files are saved but NEVER executed automatically', async () => {
        const execFileResult = await toolRegistry.execute('browser_download', {
            url: `${serverUrl}/download/report.txt`,
            customFilename: 'payload.bat'
        });

        assert.equal(execFileResult.ok, true);
        assert.equal(execFileResult.result.status, 'download_success');
        assert.equal(execFileResult.result.filename, 'payload.bat');
        assert.ok(fs.existsSync(execFileResult.result.destinationPath));

        // Verify the authenticity note states SHA-256 does not attest to content trust or malware absence
        assert.ok(execFileResult.result.verification.authenticityNote.includes('does not attest to content trust or malware absence'));
        assert.equal(execFileResult.result.pid, undefined);
        assert.equal(execFileResult.result.spawned, undefined);
    });

    // Test 15: Sensitive Browser Information and Tokens Are Redacted
    await t.test('redacts sensitive query secrets and rejects embedded credentials fail-closed', async () => {
        // Sensitive query parameters
        const secretUrl = `${serverUrl}/download/report.txt?token=secret_xyz123&apiKey=key_abc987&sessionAuth=sess_456`;
        const secretDl = await toolRegistry.execute('browser_download', {
            url: secretUrl,
            customFilename: 'safe_receipt.txt'
        });

        assert.equal(secretDl.ok, true);
        assert.equal(secretDl.result.status, 'download_success');
        assert.ok(!secretDl.result.url.includes('secret_xyz123'), 'Token must be redacted from receipt URL');
        assert.ok(!secretDl.result.url.includes('key_abc987'), 'API Key must be redacted from receipt URL');
        assert.ok(secretDl.result.url.includes('[REDACTED_SECRET]'), 'Must include [REDACTED_SECRET] placeholder');

        // Verify list_downloads also sanitizes the URL
        const listRes = await toolRegistry.execute('browser_list_downloads', {});
        const listedRecord = listRes.result.downloads.find((d) => d.id === secretDl.result.downloadId);
        assert.ok(listedRecord);
        assert.ok(!listedRecord.url.includes('secret_xyz123'));
        assert.ok(!listedRecord.url.includes('key_abc987'));

        // Embedded credentials (user:pass@host) must be rejected fail-closed
        const credUrl = 'http://admin:superSecretPassword@127.0.0.1/download/report.txt';
        const credDl = await toolRegistry.execute('browser_download', {
            url: credUrl
        });
        assert.equal(credDl.ok, false);
        assert.equal(credDl.result.status, 'embedded_credentials_forbidden');
        assert.ok(credDl.result.error.includes('embedded credentials'));
    });
});

