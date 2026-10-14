'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function getGitCommit(cwd) {
    try {
        return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return 'unknown';
    }
}

function getGitBranch(cwd) {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return 'unknown';
    }
}

function computeHashes(filePath) {
    const buffer = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const sha512 = crypto.createHash('sha512').update(buffer).digest('hex');
    return { sha256, sha512, sizeBytes: buffer.length };
}

function isGitTreeClean(cwd) {
    try {
        const out = execSync('git status --porcelain', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        return out.length === 0;
    } catch {
        return false;
    }
}

function generateReleaseManifest(options = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const distDir = options.distDir || path.join(rootDir, 'dist-release');

    if (!fs.existsSync(distDir)) {
        throw new Error(`Release directory does not exist: ${distDir}`);
    }

    const packageJsonPath = path.join(rootDir, 'package.json');
    let pkg = { version: '0.1.0', name: 'lucy-desktop-assistant', devDependencies: {} };
    if (fs.existsSync(packageJsonPath)) {
        try {
            pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        } catch {}
    }

    const gitCommit = getGitCommit(rootDir);
    const gitBranch = getGitBranch(rootDir);
    const gitClean = isGitTreeClean(rootDir);

    if (options.enforceCleanTree && !gitClean) {
        throw new Error('Working tree contains uncommitted changes. Production releases require a clean Git working tree.');
    }

    if (options.expectedCommit && gitCommit !== options.expectedCommit) {
        throw new Error(`Git commit mismatch: expected ${options.expectedCommit}, but found ${gitCommit}`);
    }

    const allEntries = fs.readdirSync(distDir);
    const manifestFiles = ['SHA256SUMS.txt', 'release-manifest.json', 'builder-debug.yml'];

    const artifacts = [];
    const sha256Lines = [];
    const seenFilenames = new Set();

    for (const entry of allEntries.sort()) {
        if (manifestFiles.includes(entry)) continue;

        // Security: Prevent path traversal
        if (entry.includes('..') || entry.includes('/') || entry.includes('\\')) {
            throw new Error(`Invalid artifact filename detected (path traversal attempt): ${entry}`);
        }

        if (seenFilenames.has(entry)) {
            throw new Error(`Duplicate artifact entry detected: ${entry}`);
        }
        seenFilenames.add(entry);

        const fullPath = path.join(distDir, entry);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;

        const { sha256, sha512, sizeBytes } = computeHashes(fullPath);

        let type = 'binary';
        if (entry.includes('Setup') && entry.endsWith('.exe')) type = 'installer';
        else if (entry.includes('Portable') && entry.endsWith('.exe')) type = 'portable';
        else if (entry.endsWith('.blockmap')) type = 'blockmap';
        else if (entry.endsWith('.zip')) type = 'archive';

        artifacts.push({
            filename: entry,
            type,
            sizeBytes,
            sha256,
            sha512,
            lastModified: stat.mtime.toISOString()
        });

        // GNU sha256sum format uses two spaces between hash and filename for binary mode
        sha256Lines.push(`${sha256}  ${entry}`);
    }

    if (artifacts.length === 0 && options.allowEmpty !== true) {
        throw new Error(`No release artifacts found in ${distDir}. Manifest must be generated from actual build outputs.`);
    }

    const builderVersion = (pkg.devDependencies && pkg.devDependencies['electron-builder'])
        ? String(pkg.devDependencies['electron-builder']).replace(/^[^0-9]*/, '')
        : '26.15.3';

    const requiredRuntimeAssets = [
        {
            name: 'LucyUiaWorker.exe',
            type: 'native_uia_worker',
            packagedPath: 'resources/native-uia/LucyUiaWorker.exe',
            unpackedAsar: 'app.asar.unpacked/src/tools/native-uia/LucyUiaWorker.exe',
            sourcePath: 'src/tools/native-uia/LucyUiaWorker.cs'
        },
        {
            name: 'whisper-cli.exe',
            type: 'offline_speech_runtime',
            packagedPath: 'resources/bin/whisper-cli.exe',
            license: 'MIT',
            sourceRepo: 'https://github.com/ggml-org/whisper.cpp'
        },
        {
            name: 'ggml-tiny.en.bin',
            type: 'speech_recognition_model',
            packagedPath: 'resources/models/whisper/ggml-tiny.en.bin',
            license: 'MIT',
            sizeBytes: 77704715
        },
        {
            name: 'CelestialFamiliarRenderer',
            type: 'fairy_companion_renderer',
            sourcePath: 'src/ui/companion-renderer.js',
            canonicalIdentity: 'Celestial Fairy Familiar (No dragon assets)'
        },
        {
            name: 'playwright-core',
            type: 'browser_automation',
            packagedPath: 'resources/app.asar.unpacked/node_modules/playwright-core'
        },
        {
            name: 'sql-wasm.wasm',
            type: 'database_runtime',
            packagedPath: 'resources/app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm'
        },
        {
            name: 'LICENSE',
            type: 'license',
            path: 'LICENSE'
        },
        {
            name: 'NOTICE',
            type: 'attributions',
            path: 'NOTICE'
        }
    ];

    const manifest = {
        name: 'L.U.C.Y.',
        version: pkg.version || '0.1.0',
        targetPlatform: 'win-x64',
        builderVersion,
        sourceRevision: {
            commit: gitCommit,
            branch: gitBranch,
            workingTreeClean: gitClean,
            recordedAt: new Date().toISOString()
        },
        signingStatus: {
            signed: false,
            codeSigningCertificate: 'none_configured',
            status: 'unsigned_awaiting_ev_certificate',
            smartScreenNotice: 'Executable is currently distributed without an Extended Validation (EV) digital signature. Microsoft Defender SmartScreen displays an \"Unknown Publisher\" advisory on initial download. Integrity and authenticity must be verified using the SHA-256 checksums below.'
        },
        requiredRuntimeAssets,
        artifacts
    };

    const sha256FilePath = path.join(distDir, 'SHA256SUMS.txt');
    const manifestFilePath = path.join(distDir, 'release-manifest.json');

    fs.writeFileSync(sha256FilePath, sha256Lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(manifestFilePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    return {
        manifest,
        sha256FilePath,
        manifestFilePath,
        artifactCount: artifacts.length
    };
}

if (require.main === module) {
    try {
        const result = generateReleaseManifest();
        console.log('=== L.U.C.Y. Release Manifest & Cryptographic Hashes Generated ===\n');
        console.log(`Source Commit: ${result.manifest.sourceRevision.commit}`);
        console.log(`Artifact Count: ${result.artifactCount}\n`);
        for (const art of result.manifest.artifacts) {
            console.log(`  File:   ${art.filename} (${(art.sizeBytes / (1024 * 1024)).toFixed(2)} MB, type: ${art.type})`);
            console.log(`  SHA256: ${art.sha256}`);
            console.log('');
        }
        console.log(`Wrote: ${result.sha256FilePath}`);
        console.log(`Wrote: ${result.manifestFilePath}`);
    } catch (err) {
        console.error('Error generating release manifest:', err.message);
        process.exit(1);
    }
}

module.exports = {
    computeHashes,
    getGitCommit,
    getGitBranch,
    isGitTreeClean,
    generateReleaseManifest
};
