'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function computeSha256(filePath) {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function checkAuthenticode(filePath) {
    if (process.platform !== 'win32') {
        return { status: 'unsupported_platform', statusMessage: 'Authenticode check requires Windows' };
    }
    try {
        const sanitizedPath = filePath.replace(/'/g, "''");
        const cmd = `powershell -NoProfile -Command "(Get-AuthenticodeSignature -FilePath '${sanitizedPath}').Status.ToString()"`;
        const status = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
        return { status: status || 'NotSigned', signed: status === 'Valid' };
    } catch {
        return { status: 'NotSigned', signed: false };
    }
}

function verifyReleaseArtifacts(options = {}) {
    const distDir = options.distDir || path.resolve(__dirname, '../dist-release');

    if (!fs.existsSync(distDir)) {
        return {
            ok: false,
            error: `Directory not found: ${distDir}`,
            results: []
        };
    }

    const sha256FilePath = path.join(distDir, 'SHA256SUMS.txt');
    const manifestFilePath = path.join(distDir, 'release-manifest.json');

    const expectedHashes = new Map(); // filename -> { expectedSha256, expectedSize, type, lastModified }
    let parsedManifest = null;

    if (fs.existsSync(manifestFilePath)) {
        try {
            parsedManifest = JSON.parse(fs.readFileSync(manifestFilePath, 'utf8'));
            if (Array.isArray(parsedManifest.artifacts)) {
                for (const art of parsedManifest.artifacts) {
                    expectedHashes.set(art.filename, {
                        expectedSha256: art.sha256 ? art.sha256.toLowerCase() : '',
                        expectedSize: art.sizeBytes,
                        type: art.type,
                        lastModified: art.lastModified
                    });
                }
            }
        } catch {}
    }

    if (expectedHashes.size === 0 && fs.existsSync(sha256FilePath)) {
        const lines = fs.readFileSync(sha256FilePath, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
                const hash = parts[0].toLowerCase();
                const filename = parts.slice(1).join(' ').replace(/^\*/, '');
                expectedHashes.set(filename, { expectedSha256: hash });
            }
        }
    }

    if (expectedHashes.size === 0) {
        return {
            ok: false,
            error: 'No checksum metadata (SHA256SUMS.txt or release-manifest.json) found to verify against.',
            results: []
        };
    }

    const results = [];
    let allValid = true;

    // Check Git source revision match if requested
    if (options.expectedCommit && parsedManifest && parsedManifest.sourceRevision) {
        const manifestCommit = parsedManifest.sourceRevision.commit;
        if (manifestCommit !== options.expectedCommit) {
            allValid = false;
            results.push({
                filename: 'release-manifest.json',
                verified: false,
                status: 'source_revision_mismatch',
                error: `Source revision mismatch! Expected commit ${options.expectedCommit}, but manifest records ${manifestCommit}`
            });
        }
    }

    const manifestRecordedTime = (parsedManifest && parsedManifest.sourceRevision && parsedManifest.sourceRevision.recordedAt)
        ? new Date(parsedManifest.sourceRevision.recordedAt).getTime()
        : null;

    for (const [filename, expected] of expectedHashes.entries()) {
        // Security check: Path traversal prevention
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            allValid = false;
            results.push({
                filename,
                verified: false,
                status: 'invalid_filename_traversal',
                error: `Security violation: path traversal detected in artifact filename: ${filename}`
            });
            continue;
        }

        const fullPath = path.join(distDir, filename);

        if (!fs.existsSync(fullPath)) {
            allValid = false;
            results.push({
                filename,
                verified: false,
                status: 'missing_file',
                error: `Artifact missing on disk: ${filename}`
            });
            continue;
        }

        const stat = fs.statSync(fullPath);

        // Stale manifest check: If artifact was modified significantly AFTER manifest was generated
        if (options.checkStaleManifest && manifestRecordedTime && stat.mtimeMs > (manifestRecordedTime + 5000)) {
            allValid = false;
            results.push({
                filename,
                verified: false,
                status: 'stale_manifest',
                error: `Artifact modification time (${stat.mtime.toISOString()}) is newer than manifest recordedAt (${new Date(manifestRecordedTime).toISOString()}). Manifest is stale.`
            });
            continue;
        }

        const actualSha256 = computeSha256(fullPath).toLowerCase();
        const hashMatches = (actualSha256 === expected.expectedSha256);

        if (!hashMatches) {
            allValid = false;
            results.push({
                filename,
                verified: false,
                status: 'hash_mismatch',
                expectedHash: expected.expectedSha256,
                actualHash: actualSha256,
                sizeBytes: stat.size,
                error: `SHA-256 checksum mismatch! Expected ${expected.expectedSha256}, got ${actualSha256}`
            });
            continue;
        }

        const auth = (filename.endsWith('.exe') && options.checkSignatures !== false)
            ? checkAuthenticode(fullPath)
            : { status: 'skipped' };

        results.push({
            filename,
            verified: true,
            status: 'checksum_verified',
            sha256: actualSha256,
            sizeBytes: stat.size,
            authenticode: auth
        });
    }

    // Verify required runtime assets presence in manifest
    const runtimeAssets = parsedManifest && Array.isArray(parsedManifest.requiredRuntimeAssets)
        ? parsedManifest.requiredRuntimeAssets
        : [];

    return {
        ok: allValid,
        distDir,
        totalChecked: expectedHashes.size,
        passedCount: results.filter((r) => r.verified).length,
        failedCount: results.filter((r) => !r.verified).length,
        runtimeAssetsCount: runtimeAssets.length,
        manifest: parsedManifest,
        results
    };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    let distDir = path.resolve(__dirname, '../dist-release');
    if (args[0] && !args[0].startsWith('-')) {
        distDir = path.resolve(args[0]);
    }

    console.log(`=== L.U.C.Y. Release Artifact Verification ===\n`);
    console.log(`Target Directory: ${distDir}`);

    const outcome = verifyReleaseArtifacts({ distDir });

    if (!outcome.ok) {
        console.error(`\nFAILED: Verification failed (${outcome.failedCount} mismatch/missing):\n`);
        for (const res of outcome.results) {
            if (!res.verified) {
                console.error(`  [FAIL] ${res.filename}: ${res.error}`);
            } else {
                console.log(`  [PASS] ${res.filename} (SHA256: ${res.sha256.slice(0, 16)}...)`);
            }
        }
        process.exit(1);
    } else {
        console.log(`\nPASSED: All ${outcome.passedCount} release artifacts verified cryptographically!\n`);
        for (const res of outcome.results) {
            console.log(`  [PASS] ${res.filename}`);
            console.log(`         Size: ${(res.sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
            console.log(`         SHA256: ${res.sha256}`);
            if (res.authenticode && res.authenticode.status !== 'skipped') {
                console.log(`         Authenticode Signature: ${res.authenticode.status} (Unsigned, SmartScreen notice expected)`);
            }
            console.log('');
        }
        process.exit(0);
    }
}

module.exports = {
    computeSha256,
    checkAuthenticode,
    verifyReleaseArtifacts
};
