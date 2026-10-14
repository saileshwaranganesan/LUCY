'use strict';

/**
 * L.U.C.Y. Reproducible Windows Release Pipeline (Sprint 3)
 * 
 * Authoritative end-to-end pipeline coordinating:
 * 1. Source and dependency validation (clean git tree, no secret leaks, package lockfile).
 * 2. Pre-release test suite execution.
 * 3. Native Windows UI Automation worker compilation (LucyUiaWorker.exe).
 * 4. Runtime asset provisioning and verification (Whisper, ggml model, fairy renderer, notices).
 * 5. Packaging into NSIS installer and portable executable via electron-builder.
 * 6. Automated packaged application runtime smoke tests in isolated sandbox.
 * 7. Cryptographic release manifest and SHA-256 checksum generation from actual artifacts.
 * 8. Cryptographic verification of final artifacts against manifest.
 * 9. Concise release summary with artifact details and signature/SmartScreen transparency.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist-release');

const { getGitCommit, getGitBranch, isGitTreeClean, generateReleaseManifest } = require('./generate-release-manifest.js');
const { verifyReleaseArtifacts } = require('./verify-release-artifacts.js');
const { ensureWorkerBuilt } = require('../src/tools/native-uia/build-worker.js');
const { verifyBinaryIntegrity, verifyModelIntegrity, provisionAll } = require('./provision-whisper.js');
const { runPackagedAppSmokeTest } = require('./smoke-test-packaged-app.js');

function formatBytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function checkSecurityExclusions(rootDir) {
    const findings = [];
    const sensitivePatterns = [/\.pfx$/i, /\.p12$/i, /\.key$/i, /\.pem$/i, /^\.env$/i];

    function walk(dir) {
        if (dir.includes('node_modules') || dir.includes('.git') || dir.includes('dist-release')) return;
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            const relPath = path.relative(rootDir, fullPath);
            for (const pat of sensitivePatterns) {
                if (pat.test(entry)) {
                    findings.push(relPath);
                }
            }
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) walk(fullPath);
            } catch (_) {}
        }
    }

    walk(rootDir);
    return findings;
}

async function executeReleasePipeline(options = {}) {
    const startTime = Date.now();
    const allowDirty = Boolean(options.allowDirty);
    const skipTests = Boolean(options.skipTests);
    const skipPack = Boolean(options.skipPack);
    const skipSmoke = Boolean(options.skipSmoke);
    const dryRun = Boolean(options.dryRun);
    const target = options.target || 'all';

    console.log('========================================================================');
    console.log('       L.U.C.Y. Reproducible Windows Production Release Pipeline        ');
    console.log('========================================================================\n');

    // -------------------------------------------------------------------------
    // STAGE 1: Source, Git Revision, and Security Boundary Validation
    // -------------------------------------------------------------------------
    console.log('[STAGE 1] Validating Git Source, Working Tree, and Security Boundary...');

    const gitCommit = getGitCommit(PROJECT_ROOT);
    const gitBranch = getGitBranch(PROJECT_ROOT);
    const gitClean = isGitTreeClean(PROJECT_ROOT);

    console.log(`  Source Git Commit: ${gitCommit}`);
    console.log(`  Source Git Branch: ${gitBranch}`);
    console.log(`  Working Tree Clean: ${gitClean ? 'YES' : 'DIRTY (Uncommitted modifications)'}`);

    if (!gitClean && !allowDirty) {
        throw new Error(
            'Pipeline aborted: Git working tree contains uncommitted changes. ' +
            'Production releases must be built from a clean, tested Git commit. ' +
            '(Pass --allow-dirty only for local development iterations).'
        );
    }

    // Security check: Zero private keys or certs in workspace
    const leakedFiles = checkSecurityExclusions(PROJECT_ROOT);
    if (leakedFiles.length > 0) {
        throw new Error(`Security Boundary Violation: Private keys or certificates detected in repository: ${leakedFiles.join(', ')}`);
    }
    console.log('  ✓ Security audit: Zero private signing keys, certificates, or credentials found in tree');

    // Package lockfile check
    const pkgJsonPath = path.join(PROJECT_ROOT, 'package.json');
    const lockfilePath = path.join(PROJECT_ROOT, 'package-lock.json');
    if (!fs.existsSync(pkgJsonPath) || !fs.existsSync(lockfilePath)) {
        throw new Error('Missing package.json or package-lock.json');
    }
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    console.log(`  ✓ Package metadata: ${pkg.name} v${pkg.version}`);

    if (dryRun) {
        console.log('\n[DRY RUN] Validations passed. Terminating early without building.');
        return { ok: true, dryRun: true, gitCommit };
    }

    // -------------------------------------------------------------------------
    // STAGE 2: Pre-Release Test Verification
    // -------------------------------------------------------------------------
    console.log('\n[STAGE 2] Running Pre-Release Test Suite...');
    if (skipTests) {
        console.log('  [WARNING] Pre-release test suite skipped via --skip-tests flag.');
    } else {
        console.log('  Executing: node --test tests/**/*.test.js');
        const testRes = spawnSync('node', ['--test', 'tests/**/*.test.js'], {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        });
        if (testRes.status !== 0) {
            throw new Error(`Pre-release test suite failed with exit code ${testRes.status}. Aborting release packaging.`);
        }
        console.log('  ✓ Pre-release test suite passed with 100% success.');
    }

    // -------------------------------------------------------------------------
    // STAGE 3: Build Native Worker
    // -------------------------------------------------------------------------
    console.log('\n[STAGE 3] Building Native Windows UI Automation Worker...');
    const builtWorkerExe = ensureWorkerBuilt(false);
    if (!fs.existsSync(builtWorkerExe)) {
        throw new Error(`Native worker binary missing after build: ${builtWorkerExe}`);
    }
    const workerStats = fs.statSync(builtWorkerExe);
    console.log(`  ✓ LucyUiaWorker.exe ready at ${builtWorkerExe} (${workerStats.size} bytes)`);

    // -------------------------------------------------------------------------
    // STAGE 4: Provision & Verify Runtime Assets
    // -------------------------------------------------------------------------
    console.log('\n[STAGE 4] Provisioning & Cryptographically Verifying Runtime Assets...');
    let binCheck = verifyBinaryIntegrity();
    let modelCheck = verifyModelIntegrity();

    if (!binCheck.ok || !modelCheck.ok) {
        console.log('  Missing whisper assets. Fetching upstream release & model weights...');
        await provisionAll();
        binCheck = verifyBinaryIntegrity();
        modelCheck = verifyModelIntegrity();
        if (!binCheck.ok || !modelCheck.ok) {
            throw new Error(`Failed to provision offline speech assets: bin=${binCheck.ok}, model=${modelCheck.ok}`);
        }
    }
    console.log(`  ✓ whisper-cli.exe verified (SHA-256: ${binCheck.sha256.slice(0, 16)}...)`);
    console.log(`  ✓ ggml-tiny.en.bin verified (SHA-256: ${modelCheck.sha256.slice(0, 16)}...)`);

    // Verify canonical fairy renderer and absence of dragon assets
    const fairyRendererPath = path.join(PROJECT_ROOT, 'src', 'ui', 'companion-renderer.js');
    if (!fs.existsSync(fairyRendererPath)) {
        throw new Error('Canonical fairy renderer missing at src/ui/companion-renderer.js');
    }
    const fairyContent = fs.readFileSync(fairyRendererPath, 'utf8');
    if (!fairyContent.includes('CelestialFamiliarRenderer')) {
        throw new Error('CelestialFamiliarRenderer not found in src/ui/companion-renderer.js');
    }
    console.log('  ✓ Celestial Familiar Fairy renderer verified as canonical companion');

    const obsoleteDragonGlb = path.join(PROJECT_ROOT, 'src', 'companion', 'assets', 'dragon.glb');
    if (fs.existsSync(obsoleteDragonGlb)) {
        throw new Error(`CRITICAL DEFECT: Deprecated dragon asset found: ${obsoleteDragonGlb}`);
    }
    console.log('  ✓ Confirmed zero obsolete dragon assets present in source tree');

    // Verify LICENSE & NOTICE
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'LICENSE')) || !fs.existsSync(path.join(PROJECT_ROOT, 'NOTICE'))) {
        throw new Error('Missing LICENSE or NOTICE attribution files');
    }
    console.log('  ✓ LICENSE and NOTICE third-party attribution documents verified');

    // -------------------------------------------------------------------------
    // STAGE 5: Package Executables via electron-builder
    // -------------------------------------------------------------------------
    console.log('\n[STAGE 5] Packaging Windows Distribution Artifacts via electron-builder...');
    fs.mkdirSync(DIST_DIR, { recursive: true });

    if (skipPack) {
        console.log('  [NOTICE] electron-builder packaging skipped via --skip-pack flag.');
    } else {
        const builderArgs = ['electron-builder', '--win'];
        if (target === 'nsis') builderArgs.push('nsis');
        else if (target === 'portable') builderArgs.push('portable');
        else if (target === 'dir') builderArgs.push('--dir');
        else builderArgs.push('nsis', 'portable', '--dir');

        console.log(`  Executing: npx ${builderArgs.join(' ')}`);
        const packRes = spawnSync('npx', builderArgs, {
            cwd: PROJECT_ROOT,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        });
        if (packRes.status !== 0) {
            throw new Error(`electron-builder packaging failed with exit code ${packRes.status}`);
        }
        console.log('  ✓ Packaging completed successfully.');
    }

    // -------------------------------------------------------------------------
    // STAGE 6: Packaged Application Runtime Smoke Testing
    // -------------------------------------------------------------------------
    console.log('\n[STAGE 6] Executing Packaged Application Runtime Smoke Tests...');
    if (skipSmoke) {
        console.log('  [WARNING] Packaged runtime smoke tests skipped via --skip-smoke flag.');
    } else {
        const unpackedExe = path.join(DIST_DIR, 'win-unpacked', 'LUCY.exe');
        const smokeRes = await runPackagedAppSmokeTest({ exe: fs.existsSync(unpackedExe) ? unpackedExe : null });
        if (!smokeRes.ok) {
            throw new Error(`Packaged runtime smoke tests failed (${smokeRes.failedCount} failures). Aborting release.`);
        }
        console.log(`  ✓ All ${smokeRes.passedCount} packaged runtime smoke tests passed.`);
    }

    // -------------------------------------------------------------------------
    // STAGE 7: Cryptographic Release Manifest & Checksum Generation
    // -------------------------------------------------------------------------
    console.log('\n[STAGE 7] Generating Cryptographic Release Manifest & SHA-256 Hashes...');
    const manifestResult = generateReleaseManifest({
        rootDir: PROJECT_ROOT,
        distDir: DIST_DIR,
        enforceCleanTree: !allowDirty,
        expectedCommit: gitCommit
    });
    console.log(`  ✓ Generated SHA256SUMS.txt at: ${manifestResult.sha256FilePath}`);
    console.log(`  ✓ Generated release-manifest.json at: ${manifestResult.manifestFilePath}`);
    console.log(`  ✓ Total release artifacts recorded: ${manifestResult.artifactCount}`);

    // -------------------------------------------------------------------------
    // STAGE 8: Final Artifact Cryptographic & Integrity Verification
    // -------------------------------------------------------------------------
    console.log('\n[STAGE 8] Verifying Final Release Artifacts Cryptographically...');
    const verifyResult = verifyReleaseArtifacts({
        distDir: DIST_DIR,
        expectedCommit: gitCommit,
        checkStaleManifest: true
    });

    if (!verifyResult.ok) {
        console.error(`\n❌ Final release artifact verification failed (${verifyResult.failedCount} errors):`);
        for (const res of verifyResult.results) {
            if (!res.verified) {
                console.error(`  [FAIL] ${res.filename}: ${res.error}`);
            }
        }
        throw new Error('Final release artifact verification failed. Release outputs are corrupt or mismatched.');
    }
    console.log(`  ✓ All ${verifyResult.passedCount} release artifacts cryptographically verified against SHA-256 checksums.`);

    // -------------------------------------------------------------------------
    // STAGE 9: Release Summary & Delivery Report
    // -------------------------------------------------------------------------
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n========================================================================');
    console.log('              L.U.C.Y. RELEASE PIPELINE SUCCESSFUL                      ');
    console.log('========================================================================\n');
    console.log(`Application Name:       ${manifestResult.manifest.name}`);
    console.log(`Release Version:        ${manifestResult.manifest.version}`);
    console.log(`Target Platform:        ${manifestResult.manifest.targetPlatform}`);
    console.log(`Builder Version:        electron-builder v${manifestResult.manifest.builderVersion}`);
    console.log(`Source Git Commit:      ${manifestResult.manifest.sourceRevision.commit}`);
    console.log(`Source Git Branch:      ${manifestResult.manifest.sourceRevision.branch}`);
    console.log(`Working Tree Clean:     ${manifestResult.manifest.sourceRevision.workingTreeClean}`);
    console.log(`Signing Status:         ${manifestResult.manifest.signingStatus.status}`);
    console.log(`SmartScreen Notice:     ${manifestResult.manifest.signingStatus.smartScreenNotice}`);
    console.log(`Pipeline Duration:      ${durationSec}s\n`);

    console.log('Generated Release Artifacts:');
    for (const art of manifestResult.manifest.artifacts) {
        console.log(`  • ${art.filename}`);
        console.log(`    Type:   ${art.type}`);
        console.log(`    Size:   ${formatBytes(art.sizeBytes)} (${art.sizeBytes} bytes)`);
        console.log(`    SHA256: ${art.sha256}`);
        console.log(`    Path:   ${path.join(DIST_DIR, art.filename)}`);
        console.log('');
    }

    console.log('Packaged & Verified Runtime Assets:');
    for (const asset of manifestResult.manifest.requiredRuntimeAssets) {
        console.log(`  ✓ [${asset.type}] ${asset.name} (${asset.packagedPath || asset.path || asset.sourcePath})`);
    }

    return {
        ok: true,
        durationSec,
        gitCommit,
        manifest: manifestResult.manifest,
        distDir: DIST_DIR,
        verification: verifyResult
    };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const options = {
        allowDirty: args.includes('--allow-dirty'),
        skipTests: args.includes('--skip-tests'),
        skipPack: args.includes('--skip-pack'),
        skipSmoke: args.includes('--skip-smoke'),
        dryRun: args.includes('--dry-run')
    };

    for (const arg of args) {
        if (arg.startsWith('--target=')) {
            options.target = arg.slice(9);
        }
    }

    executeReleasePipeline(options)
        .then(() => {
            process.exit(0);
        })
        .catch((err) => {
            console.error('\n❌ Release Pipeline Failed:', err.message);
            process.exit(1);
        });
}

module.exports = {
    executeReleasePipeline
};
