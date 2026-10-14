'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const srcFile = path.join(dir, 'LucyUiaWorker.cs');

/**
 * Resolves the location of LucyUiaWorker.exe across development and packaged Electron environments.
 * Checks unpacked asar paths, extraResources, and local development directories.
 */
function resolveExeFile() {
    // 1. If running inside asar, resolve the unpacked asar path
    if (dir.includes('app.asar')) {
        const unpackedPath = path.join(dir.replace('app.asar', 'app.asar.unpacked'), 'LucyUiaWorker.exe');
        if (fs.existsSync(unpackedPath)) {
            return unpackedPath;
        }
    }

    // 2. Check Electron resources directory (extraResources in electron-builder)
    if (process.resourcesPath) {
        const resUnpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'tools', 'native-uia', 'LucyUiaWorker.exe');
        if (fs.existsSync(resUnpacked)) {
            return resUnpacked;
        }
        const resDirect = path.join(process.resourcesPath, 'native-uia', 'LucyUiaWorker.exe');
        if (fs.existsSync(resDirect)) {
            return resDirect;
        }
        const resRoot = path.join(process.resourcesPath, 'LucyUiaWorker.exe');
        if (fs.existsSync(resRoot)) {
            return resRoot;
        }
    }

    // 3. Fallback to current directory (development mode & test runners)
    return path.join(dir, 'LucyUiaWorker.exe');
}

const exeFile = resolveExeFile();

const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const wpfLib = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF';

function ensureWorkerBuilt(force = false) {
    const currentExe = resolveExeFile();
    if (!force && fs.existsSync(currentExe)) {
        return currentExe;
    }

    // If running in packaged asar mode, compiling is not supported (binary must be pre-packaged)
    if (dir.includes('app.asar')) {
        if (fs.existsSync(currentExe)) return currentExe;
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
        throw new Error(`Failed to compile LucyUiaWorker.cs: ${err.stderr?.toString() || err.message}`);
    }
}

if (require.main === module) {
    const force = process.argv.includes('--force');
    const out = ensureWorkerBuilt(force);
    console.log(`LucyUiaWorker built successfully: ${out}`);
}

module.exports = {
    resolveExeFile,
    ensureWorkerBuilt,
    exeFile
};
