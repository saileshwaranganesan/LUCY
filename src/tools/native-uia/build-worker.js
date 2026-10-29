'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const srcFile = path.join(dir, 'LucyUiaWorker.cs');

function isVirtualAsarPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.includes('app.asar') && !normalized.includes('app.asar.unpacked');
}

/**
 * Resolves the location of LucyUiaWorker.exe across development and packaged Electron environments.
 * Checks unpacked asar paths, extraResources, process.execPath, and local development directories.
 * Guarantees that the returned path is never an unspawnable virtual ASAR path.
 */
function resolveExeFile() {
    const isPackagedAsar = dir.includes('app.asar');
    const unpackedPath = path.join(dir.replace('app.asar', 'app.asar.unpacked'), 'LucyUiaWorker.exe');

    // 1. If running inside asar, check the unpacked asar path
    if (isPackagedAsar && fs.existsSync(unpackedPath)) {
        return unpackedPath;
    }

    // 2. Check Electron resources directory (extraResources in electron-builder)
    const resourceCandidates = [];
    if (process.resourcesPath) {
        resourceCandidates.push(
            path.join(process.resourcesPath, 'native-uia', 'LucyUiaWorker.exe'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'tools', 'native-uia', 'LucyUiaWorker.exe'),
            path.join(process.resourcesPath, 'LucyUiaWorker.exe')
        );
    }

    // 3. Check paths relative to process.execPath (covers portable & unpacked distributions)
    if (process.execPath) {
        const execDir = path.dirname(process.execPath);
        resourceCandidates.push(
            path.join(execDir, 'resources', 'native-uia', 'LucyUiaWorker.exe'),
            path.join(execDir, 'resources', 'app.asar.unpacked', 'src', 'tools', 'native-uia', 'LucyUiaWorker.exe'),
            path.join(execDir, 'native-uia', 'LucyUiaWorker.exe')
        );
    }

    // 4. Check PORTABLE_EXECUTABLE_DIR if present
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        resourceCandidates.push(
            path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'resources', 'native-uia', 'LucyUiaWorker.exe'),
            path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'native-uia', 'LucyUiaWorker.exe')
        );
    }

    for (const candidate of resourceCandidates) {
        if (!isVirtualAsarPath(candidate) && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    // 5. In development mode (not inside asar), check local directory
    if (!isPackagedAsar) {
        return path.join(dir, 'LucyUiaWorker.exe');
    }

    // 6. In packaged asar mode, default to unpackedPath (never an internal virtual asar path)
    return unpackedPath;
}

const exeFile = resolveExeFile();

const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const wpfLib = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF';

function ensureWorkerBuilt(force = false) {
    const currentExe = resolveExeFile();
    const srcStat = fs.existsSync(srcFile) ? fs.statSync(srcFile) : null;
    const exeStat = fs.existsSync(currentExe) ? fs.statSync(currentExe) : null;
    const isUpToDate = !force && exeStat && srcStat && (exeStat.mtimeMs >= srcStat.mtimeMs) && !isVirtualAsarPath(currentExe);
    if (isUpToDate) {
        const check = verifyWorkerBinary(currentExe);
        if (check.valid) {
            return currentExe;
        }
    }

    // If running in packaged asar mode, compiling is not supported (binary must be pre-packaged)
    if (dir.includes('app.asar')) {
        if (fs.existsSync(currentExe) && !isVirtualAsarPath(currentExe)) return currentExe;
        throw new Error(`Packaged LucyUiaWorker.exe not found at ${currentExe}`);
    }

    if (!fs.existsSync(cscPath)) {
        throw new Error(`C# compiler not found at ${cscPath}`);
    }

    const args = [
        '/nologo',
        '/target:exe',
        `/out:${currentExe}`,
        `/lib:${wpfLib}`,
        '/r:System.dll,System.Core.dll,System.Drawing.dll,System.Web.Extensions.dll,UIAutomationClient.dll,UIAutomationTypes.dll,WindowsBase.dll',
        srcFile
    ];

    try {
        execFileSync(cscPath, args, { stdio: 'pipe' });
        return currentExe;
    } catch (err) {
        throw new Error(`Failed to compile LucyUiaWorker.cs: ${err.stdout?.toString() || err.stderr?.toString() || err.message}`);
    }
}

/**
 * Verifies the integrity, PE architecture, timestamp freshness, and hash of LucyUiaWorker.exe.
 * Detects missing or stale executables.
 * @param {string} [customExePath]
 * @returns {{ valid: boolean, path: string, length?: number, mtime?: string, hash?: string, isUpToDate?: boolean, architecture?: string, error?: string }}
 */
function verifyWorkerBinary(customExePath) {
    const crypto = require('crypto');
    const targetExe = customExePath || resolveExeFile();

    if (isVirtualAsarPath(targetExe)) {
        return {
            valid: false,
            path: targetExe,
            error: `LucyUiaWorker is located in an unspawnable virtual ASAR path: '${targetExe}'`
        };
    }

    if (!fs.existsSync(targetExe)) {
        return {
            valid: false,
            path: targetExe,
            error: `LucyUiaWorker binary does not exist at '${targetExe}'`
        };
    }

    const stat = fs.statSync(targetExe);
    if (stat.size < 1024) {
        return {
            valid: false,
            path: targetExe,
            length: stat.size,
            error: `LucyUiaWorker binary is abnormally small (${stat.size} bytes)`
        };
    }

    // Inspect PE header for valid Windows PE executable
    try {
        const fd = fs.openSync(targetExe, 'r');
        const buffer = Buffer.alloc(512);
        fs.readSync(fd, buffer, 0, 512, 0);
        fs.closeSync(fd);

        // Check MZ header
        if (buffer[0] !== 0x4D || buffer[1] !== 0x5A) {
            return {
                valid: false,
                path: targetExe,
                error: `LucyUiaWorker binary missing MZ DOS header signature`
            };
        }

        const peOffset = buffer.readUInt32LE(0x3C);
        if (peOffset > 0 && peOffset + 6 < stat.size) {
            const peBuffer = Buffer.alloc(24);
            const peFd = fs.openSync(targetExe, 'r');
            fs.readSync(peFd, peBuffer, 0, 24, peOffset);
            fs.closeSync(peFd);

            // Check PE\0\0
            if (peBuffer[0] !== 0x50 || peBuffer[1] !== 0x45 || peBuffer[2] !== 0x00 || peBuffer[3] !== 0x00) {
                return {
                    valid: false,
                    path: targetExe,
                    error: `LucyUiaWorker binary missing PE signature`
                };
            }

            const machine = peBuffer.readUInt16LE(4);
            let architecture = 'unknown';
            if (machine === 0x8664) architecture = 'x64';
            else if (machine === 0x014c) architecture = 'x86';
            else if (machine === 0xaa64) architecture = 'arm64';

            // Check timestamp freshness against source if source exists (development mode)
            let isUpToDate = true;
            if (fs.existsSync(srcFile) && !dir.includes('app.asar')) {
                const srcStat = fs.statSync(srcFile);
                if (stat.mtimeMs < srcStat.mtimeMs) {
                    isUpToDate = false;
                }
            }

            // Compute SHA256 hash
            const fileData = fs.readFileSync(targetExe);
            const hash = crypto.createHash('sha256').update(fileData).digest('hex');

            return {
                valid: true,
                path: targetExe,
                length: stat.size,
                mtime: stat.mtime.toISOString(),
                hash,
                isUpToDate,
                architecture
            };
        }
    } catch (err) {
        return {
            valid: false,
            path: targetExe,
            error: `Failed to inspect LucyUiaWorker PE header: ${err.message}`
        };
    }

    return {
        valid: false,
        path: targetExe,
        error: `Could not verify PE header structure for LucyUiaWorker`
    };
}

if (require.main === module) {
    const force = process.argv.includes('--force');
    const out = ensureWorkerBuilt(force);
    const verification = verifyWorkerBinary(out);
    console.log(`LucyUiaWorker built successfully: ${out}`);
    console.log(`Integrity Verification: ${JSON.stringify(verification, null, 2)}`);
}

module.exports = {
    resolveExeFile,
    ensureWorkerBuilt,
    verifyWorkerBinary,
    exeFile,
    isVirtualAsarPath
};

