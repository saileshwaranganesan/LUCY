'use strict';

/**
 * Patch electron-builder (app-builder-lib) to respect unpackDirName: false.
 *
 * Upstream electron-builder documentation states:
 * "If set explicitly to false, it will use the Windows temp directory ($PLUGINSDIR)
 *  that is unique to each launch of the portable application."
 *
 * However, app-builder-lib/out/targets/nsis/NsisTarget.js has a known bug where
 * `!unpackDirName` evaluates to true when `unpackDirName === false`, generating
 * a static ksuid instead of allowing $PLUGINSDIR. This patch corrects that check.
 *
 * Invariant: Fails closed with an explicit error if upstream code changes or
 * cannot be verified, preventing silent packaging with broken isolation.
 */

const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
const pkgFile = path.resolve(__dirname, '../node_modules/app-builder-lib/package.json');

function applyPatch(options = {}) {
    const strict = options.strict !== false;

    if (!fs.existsSync(targetFile)) {
        const msg = `[patch-electron-builder] Target file missing: ${targetFile}`;
        if (strict) {
            throw new Error(msg);
        }
        console.warn(msg);
        return false;
    }

    let pkgVersion = 'unknown';
    if (fs.existsSync(pkgFile)) {
        try {
            pkgVersion = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
        } catch (_) {}
    }

    const content = fs.readFileSync(targetFile, 'utf8');
    const buggyCode = 'if (typeof unpackDirName === "string" || !unpackDirName) {';
    const patchedCode = 'if (unpackDirName !== false && (typeof unpackDirName === "string" || !unpackDirName)) {';

    if (content.includes(buggyCode)) {
        const updated = content.replace(buggyCode, patchedCode);
        fs.writeFileSync(targetFile, updated, 'utf8');
        console.log(`[patch-electron-builder] Successfully patched NsisTarget.js (app-builder-lib v${pkgVersion}) to support unpackDirName: false.`);
        return true;
    }

    if (content.includes(patchedCode)) {
        console.log(`[patch-electron-builder] NsisTarget.js (app-builder-lib v${pkgVersion}) is verified already patched.`);
        return true;
    }

    // Neither pattern found: upstream source changed or unexpected version
    const errorMsg = `[patch-electron-builder] FATAL: Unexpected source in NsisTarget.js (app-builder-lib v${pkgVersion}). Neither target buggy pattern nor patched pattern was found. Refusing to package with unverified portable extraction.`;
    console.error(errorMsg);
    if (strict) {
        throw new Error(errorMsg);
    }
    return false;
}

if (require.main === module) {
    try {
        applyPatch({ strict: true });
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { applyPatch };
