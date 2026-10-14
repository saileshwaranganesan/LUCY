'use strict';

/**
 * whisper.cpp Runtime & Speech Model Provisioning Script for L.U.C.Y. (REQ-027)
 * 
 * Verifies and provisions official, upstream whisper.cpp Windows x64 binaries
 * and ggml speech model weights.
 * 
 * Upstream Sources:
 * - Binary: https://github.com/ggml-org/whisper.cpp (tag b5454, MIT License)
 * - Model: https://huggingface.co/ggerganov/whisper.cpp (ggml-tiny.en.bin, MIT License)
 * 
 * Security:
 * - Downloads ONLY from official upstream GitHub releases and official Hugging Face repository.
 * - Cryptographically verifies SHA-256 checksums before unpacking or deploying.
 * - Stores binaries and models in application-owned locations outside Git tracking.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const MODELS_DIR = path.join(PROJECT_ROOT, 'models', 'whisper');

const PROVISION_CONFIG = Object.freeze({
    binary: {
        name: 'whisper-cli.exe',
        version: 'b5454',
        license: 'MIT',
        arch: 'win-x64',
        url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
        archiveSha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
        targetExe: path.join(BIN_DIR, 'whisper-cli.exe'),
        targetSha256: '331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366',
        expectedSize: 479744
    },
    model: {
        name: 'ggml-tiny.en.bin',
        license: 'MIT',
        sizeBytes: 77704715,
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
        targetPath: path.join(MODELS_DIR, 'ggml-tiny.en.bin'),
        targetSha1: 'c78c86eb1a8faa21b369bcd33207cc90d64ae9df',
        targetSha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f'
    }
});

function computeHash(filePath, algorithm = 'sha256') {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return crypto.createHash(algorithm).update(buf).digest('hex').toLowerCase();
}

function verifyBinaryIntegrity() {
    const { targetExe, targetSha256 } = PROVISION_CONFIG.binary;
    if (!fs.existsSync(targetExe)) {
        return { ok: false, reason: `Binary not found at ${targetExe}` };
    }
    const hash = computeHash(targetExe, 'sha256');
    if (hash !== targetSha256.toLowerCase()) {
        return { ok: false, reason: `SHA-256 mismatch for ${targetExe}. Expected ${targetSha256}, got ${hash}` };
    }
    return { ok: true, path: targetExe, sha256: hash };
}

function verifyModelIntegrity() {
    const { targetPath, targetSha256, targetSha1, sizeBytes } = PROVISION_CONFIG.model;
    if (!fs.existsSync(targetPath)) {
        return { ok: false, reason: `Model not found at ${targetPath}` };
    }
    const stat = fs.statSync(targetPath);
    if (stat.size !== sizeBytes) {
        return { ok: false, reason: `Model size mismatch: expected ${sizeBytes} bytes, got ${stat.size}` };
    }
    const sha256 = computeHash(targetPath, 'sha256');
    if (sha256 !== targetSha256.toLowerCase()) {
        return { ok: false, reason: `SHA-256 mismatch for ${targetPath}. Expected ${targetSha256}, got ${sha256}` };
    }
    const sha1 = computeHash(targetPath, 'sha1');
    if (sha1 !== targetSha1.toLowerCase()) {
        return { ok: false, reason: `SHA-1 mismatch for ${targetPath}. Expected ${targetSha1}, got ${sha1}` };
    }
    return { ok: true, path: targetPath, sha256, sha1, sizeBytes: stat.size };
}

function downloadFile(url, destPath, options = {}) {
    return new Promise((resolve, reject) => {
        const partPath = `${destPath}.part`;
        let startBytes = 0;
        if (options.resumable !== false && fs.existsSync(partPath)) {
            try {
                startBytes = fs.statSync(partPath).size;
            } catch (_) {
                startBytes = 0;
            }
        }

        const headers = options.headers ? { ...options.headers } : {};
        if (startBytes > 0) {
            headers['Range'] = `bytes=${startBytes}-`;
        }

        const client = url.startsWith('http:') ? http : https;
        const req = client.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, destPath, options).then(resolve).catch(reject);
            }

            if (res.statusCode === 416) {
                // Range Not Satisfiable, restart download from scratch
                try { fs.unlinkSync(partPath); } catch (_) {}
                return downloadFile(url, destPath, { ...options, resumable: false }).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200 && res.statusCode !== 206) {
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }

            const isResume = (res.statusCode === 206);
            let downloadedBytes = isResume ? startBytes : 0;
            let totalBytes = null;

            if (res.headers['content-range']) {
                const match = res.headers['content-range'].match(/\/(\d+)/);
                if (match) totalBytes = parseInt(match[1], 10);
            } else if (res.headers['content-length']) {
                totalBytes = parseInt(res.headers['content-length'], 10) + (isResume ? startBytes : 0);
            }

            const writeFlag = isResume ? 'a' : 'w';
            const fileStream = fs.createWriteStream(partPath, { flags: writeFlag });

            res.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (typeof options.onProgress === 'function') {
                    const percent = totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null;
                    options.onProgress({
                        downloadedBytes,
                        totalBytes,
                        percent
                    });
                }
            });

            res.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close(() => {
                    try {
                        if (fs.existsSync(destPath)) {
                            fs.unlinkSync(destPath);
                        }
                        fs.renameSync(partPath, destPath);
                        resolve({ destPath, sizeBytes: downloadedBytes });
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            fileStream.on('error', (err) => {
                reject(err);
            });
        });

        req.on('error', reject);
    });
}

function extractZip(zipPath, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force"`;
        execSync(cmd, { stdio: 'inherit' });
    } else {
        execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'inherit' });
    }
}

async function provisionAll(options = {}) {
    console.log('=== L.U.C.Y. Offline Voice Provisioning ===\n');

    // 1. Verify existing assets
    const binaryStatus = verifyBinaryIntegrity();
    const modelStatus = verifyModelIntegrity();

    if (options.verifyOnly) {
        console.log('Binary verification:', binaryStatus.ok ? 'PASS' : `FAIL (${binaryStatus.reason})`);
        console.log('Model verification: ', modelStatus.ok ? 'PASS' : `FAIL (${modelStatus.reason})`);
        const allOk = binaryStatus.ok && modelStatus.ok;
        if (!allOk) {
            console.error('\nVerification failed. Run without --verify-only to provision missing assets.');
            process.exit(1);
        }
        console.log('\nAll offline speech recognition assets verified cryptographically.');
        return;
    }

    // 2. Provision binary if needed
    if (binaryStatus.ok) {
        console.log(`[PASS] whisper.cpp binary already verified at: ${binaryStatus.path}`);
    } else {
        console.log(`[PROVISION] Fetching whisper.cpp ${PROVISION_CONFIG.binary.version} release from upstream GitHub...`);
        fs.mkdirSync(BIN_DIR, { recursive: true });
        const tmpZip = path.join(PROJECT_ROOT, 'scratch', `whisper-bin-${Date.now()}.zip`);
        fs.mkdirSync(path.dirname(tmpZip), { recursive: true });
        try {
            await downloadFile(PROVISION_CONFIG.binary.url, tmpZip);
            const downloadedZipSha256 = computeHash(tmpZip, 'sha256');
            if (downloadedZipSha256 !== PROVISION_CONFIG.binary.archiveSha256.toLowerCase()) {
                throw new Error(`Zip checksum verification failed! Expected ${PROVISION_CONFIG.binary.archiveSha256}, got ${downloadedZipSha256}`);
            }
            console.log('[PROVISION] Zip archive verified. Extracting binaries...');
            extractZip(tmpZip, BIN_DIR);
            const postExtractCheck = verifyBinaryIntegrity();
            if (!postExtractCheck.ok) {
                throw new Error(`Extracted binary validation failed: ${postExtractCheck.reason}`);
            }
            console.log(`[PASS] Extracted and verified whisper-cli.exe (SHA-256: ${postExtractCheck.sha256})`);
        } finally {
            if (fs.existsSync(tmpZip)) {
                try { fs.unlinkSync(tmpZip); } catch (_) {}
            }
        }
    }

    // 3. Provision model if needed
    if (modelStatus.ok) {
        console.log(`[PASS] Speech model already verified at: ${modelStatus.path}`);
        console.log(`       Size: ${(modelStatus.sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
    } else {
        console.log(`[PROVISION] Fetching ${PROVISION_CONFIG.model.name} from official Hugging Face repository...`);
        fs.mkdirSync(MODELS_DIR, { recursive: true });
        const tmpModel = path.join(PROJECT_ROOT, 'scratch', `model-download-${Date.now()}.bin`);
        fs.mkdirSync(path.dirname(tmpModel), { recursive: true });
        try {
            await downloadFile(PROVISION_CONFIG.model.url, tmpModel);
            const downloadedSha256 = computeHash(tmpModel, 'sha256');
            if (downloadedSha256 !== PROVISION_CONFIG.model.targetSha256.toLowerCase()) {
                throw new Error(`Model checksum mismatch! Expected ${PROVISION_CONFIG.model.targetSha256}, got ${downloadedSha256}`);
            }
            fs.copyFileSync(tmpModel, PROVISION_CONFIG.model.targetPath);
            const postModelCheck = verifyModelIntegrity();
            if (!postModelCheck.ok) {
                throw new Error(`Installed model validation failed: ${postModelCheck.reason}`);
            }
            console.log(`[PASS] Installed and verified ${PROVISION_CONFIG.model.name} (SHA-256: ${postModelCheck.sha256})`);
        } finally {
            if (fs.existsSync(tmpModel)) {
                try { fs.unlinkSync(tmpModel); } catch (_) {}
            }
        }
    }

    console.log('\n=== Offline Speech Recognition Provisioning Complete ===');
    console.log(`Binary:  ${PROVISION_CONFIG.binary.targetExe}`);
    console.log(`Version: ${PROVISION_CONFIG.binary.version} (win-x64, MIT License)`);
    console.log(`Model:   ${PROVISION_CONFIG.model.targetPath}`);
    console.log(`Format:  16kHz 16-bit mono WAV`);
    console.log(`Network: 100% offline, zero cloud streaming`);
}

if (require.main === module) {
    const isVerifyOnly = process.argv.includes('--verify-only');
    provisionAll({ verifyOnly: isVerifyOnly }).catch((err) => {
        console.error('\n[FATAL] Provisioning failed:', err.message);
        process.exit(1);
    });
}

function getOfflineVoiceStatus() {
    const binary = verifyBinaryIntegrity();
    const model = verifyModelIntegrity();
    return {
        binary,
        model,
        offlineReady: Boolean(binary && binary.ok && model && model.ok)
    };
}

module.exports = {
    PROVISION_CONFIG,
    computeHash,
    downloadFile,
    verifyBinaryIntegrity,
    verifyModelIntegrity,
    getOfflineVoiceStatus,
    provisionAll
};
