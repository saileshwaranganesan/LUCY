import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'verify-environment.js');

function createPeFixture(options = {}) {
  const totalSize = options.totalSize ?? 1024;
  const dosMagic = options.dosMagic ?? [0x4d, 0x5a]; // 'MZ'
  const peOffset = options.peOffset ?? 0x80;
  const peMagic = options.peMagic ?? [0x50, 0x45, 0x00, 0x00]; // 'PE\0\0'
  const machine = options.machine ?? 0x014c; // IMAGE_FILE_MACHINE_I386

  const buf = Buffer.alloc(totalSize, 0);

  if (totalSize >= 2) {
    buf[0] = dosMagic[0];
    buf[1] = dosMagic[1];
  }

  if (totalSize >= 0x40 && options.omitElfanew !== true) {
    buf.writeUInt32LE(peOffset, 0x3c);
  }

  if (options.omitPeSig !== true && peOffset + 4 <= totalSize && peOffset >= 0) {
    for (let i = 0; i < peMagic.length; i++) {
      buf[peOffset + i] = peMagic[i];
    }
  }

  if (options.omitMachine !== true && peOffset + 6 <= totalSize && peOffset >= 0) {
    buf.writeUInt16LE(machine, peOffset + 4);
  }

  return buf;
}

describe('L.U.C.Y. Engineering Environment Self-Verification Harness', () => {
  it('scripts/verify-environment.js exists and executes cleanly with exit code 0', () => {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' }
    });

    assert.equal(res.status, 0, `Script failed with code ${res.status}: ${res.stderr || res.stdout}`);
    assert.ok(res.stdout.trim().length > 0, 'Script produced output');

    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true, `Environment reported unhealthy: ${JSON.stringify(report)}`);
    assert.ok(Array.isArray(report.checks), 'Report contains checks array');
    assert.equal(report.checksPassed, report.checksTotal, 'All checks passed');
    assert.equal(report.checksTotal, report.checks.length, 'Reported total matches checks count');
    assert.ok(report.checks.length >= 5, 'Report contains at least 5 verification checks');

    const checkNames = report.checks.map(c => c.name);
    assert.ok(checkNames.includes('node_version'), 'Checks node version');
    assert.ok(checkNames.includes('native_uia_worker'), 'Checks native UIA worker binary');
    assert.ok(checkNames.includes('core_entry_points'), 'Checks core application entry points');
    assert.ok(checkNames.includes('security_rules'), 'Checks security and rule configuration');
    assert.ok(checkNames.includes('workspace_customizations'), 'Checks .agents workspace customizations');

    for (const check of report.checks) {
      assert.equal(check.passed, true, `Check ${check.name} failed: ${check.message}`);
    }
  });

  it('programmatic checkEnvironment function returns complete diagnostic report', async () => {
    const { checkEnvironment } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);
    assert.equal(typeof checkEnvironment, 'function', 'checkEnvironment is exported as a function');

    const report = checkEnvironment(REPO_ROOT);
    assert.equal(report.ok, true);
    assert.ok(report.timestamp);
    assert.ok(report.platform);
    assert.equal(report.checksPassed, report.checksTotal);
  });

  it('validates authentic and synthetic PE headers successfully', async () => {
    const { validatePeBinary, PE_CONSTANTS } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);
    assert.equal(typeof validatePeBinary, 'function', 'validatePeBinary is exported');

    // 1. Synthetic valid PE buffer
    const validBuf = createPeFixture({ totalSize: 2048, peOffset: 0x80, machine: PE_CONSTANTS.MACHINE_I386 });
    const resBuf = validatePeBinary(validBuf, { minSize: 1000, expectedMachine: PE_CONSTANTS.MACHINE_I386 });
    assert.equal(resBuf.ok, true, 'Valid synthetic PE buffer must pass validation');
    assert.equal(resBuf.machine, PE_CONSTANTS.MACHINE_I386);
    assert.match(resBuf.message, /Structural validation only/i, 'Must disclose structural validation boundary');

    // 2. Physical LucyUiaWorker.exe on disk
    const workerPath = path.join(REPO_ROOT, 'src', 'tools', 'native-uia', 'LucyUiaWorker.exe');
    if (fs.existsSync(workerPath)) {
      const resFile = validatePeBinary(workerPath, { repoRoot: REPO_ROOT, expectedMachine: PE_CONSTANTS.MACHINE_I386 });
      assert.equal(resFile.ok, true, 'Physical worker binary must pass PE header validation');
      assert.equal(resFile.machine, PE_CONSTANTS.MACHINE_I386);
      assert.equal(resFile.peOffset, 0x80);
      assert.match(resFile.message, /LucyUiaWorker\.exe structurally verified/i);
    }
  });

  it('rejects invalid DOS signatures fail-closed without crashing', async () => {
    const { validatePeBinary } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);
    const badDosBuf = createPeFixture({ dosMagic: [0x58, 0x58] }); // 'XX'
    const res = validatePeBinary(badDosBuf);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ERR_INVALID_DOS_SIGNATURE');
    assert.match(res.error, /missing MZ signature/i);
  });

  it('rejects invalid PE signatures fail-closed without crashing', async () => {
    const { validatePeBinary } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);
    const badPeBuf = createPeFixture({ peMagic: [0x4e, 0x45, 0x00, 0x00] }); // 'NE\0\0'
    const res = validatePeBinary(badPeBuf);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ERR_INVALID_PE_SIGNATURE');
    assert.match(res.error, /missing PE\\0\\0 signature/i);
  });

  it('rejects out-of-bounds PE header offsets fail-closed', async () => {
    const { validatePeBinary } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);

    // Case 1: Offset points far past file length
    const farOffsetBuf = createPeFixture({ totalSize: 512, peOffset: 4096 });
    const resFar = validatePeBinary(farOffsetBuf, { minSize: 100 });
    assert.equal(resFar.ok, false);
    assert.equal(resFar.code, 'ERR_PE_OFFSET_OUT_OF_BOUNDS');
    assert.match(resFar.error, /out-of-bounds PE header offset/i);

    // Case 2: Offset overlaps DOS header (< 64 bytes)
    const lowOffsetBuf = createPeFixture({ totalSize: 512, peOffset: 32 });
    const resLow = validatePeBinary(lowOffsetBuf, { minSize: 100 });
    assert.equal(resLow.ok, false);
    assert.equal(resLow.code, 'ERR_PE_OFFSET_OUT_OF_BOUNDS');

    // Case 3: Offset + 24 extends beyond end of file
    const boundaryBuf = createPeFixture({ totalSize: 1000, peOffset: 990 });
    const resBoundary = validatePeBinary(boundaryBuf, { minSize: 100 });
    assert.equal(resBoundary.ok, false);
    assert.equal(resBoundary.code, 'ERR_PE_OFFSET_OUT_OF_BOUNDS');
  });

  it('rejects truncated files fail-closed', async () => {
    const { validatePeBinary } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);

    // 0 bytes
    const res0 = validatePeBinary(Buffer.alloc(0), { minSize: 0 });
    assert.equal(res0.ok, false);
    assert.equal(res0.code, 'ERR_TRUNCATED_DOS_HEADER');

    // 32 bytes (less than 64-byte DOS header)
    const res32 = validatePeBinary(Buffer.alloc(32, 0x4d), { minSize: 0 });
    assert.equal(res32.ok, false);
    assert.equal(res32.code, 'ERR_TRUNCATED_DOS_HEADER');
    assert.match(res32.error, /smaller than 64-byte DOS header/i);

    // 500 bytes when minSize is 1000
    const resSmall = validatePeBinary(Buffer.alloc(500), { minSize: 1000 });
    assert.equal(resSmall.ok, false);
    assert.equal(resSmall.code, 'ERR_TOO_SMALL');
  });

  it('rejects unexpected machine architecture fail-closed', async () => {
    const { validatePeBinary, PE_CONSTANTS } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);

    // Create AMD64 binary when expecting i386 (actual packaged worker)
    const x64Buf = createPeFixture({ machine: PE_CONSTANTS.MACHINE_AMD64 });
    const res = validatePeBinary(x64Buf, { expectedMachine: PE_CONSTANTS.MACHINE_I386 });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ERR_UNEXPECTED_MACHINE_ARCH');
    assert.equal(res.machine, PE_CONSTANTS.MACHINE_AMD64);
    assert.match(res.error, /incorrect machine architecture/i);
    assert.match(res.error, /IMAGE_FILE_MACHINE_AMD64/i);
  });

  it('detects missing or non-PE worker binary and fails closed', async () => {
    const { checkEnvironment } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-env-test-'));

    try {
      // 1. Missing worker entirely
      const reportMissing = checkEnvironment(tempDir);
      assert.equal(reportMissing.ok, false);
      const workerCheckMissing = reportMissing.checks.find(c => c.name === 'native_uia_worker');
      assert.equal(workerCheckMissing.passed, false);
      assert.match(workerCheckMissing.message, /not found/i);
      assert.match(workerCheckMissing.message, /Action: Run 'npm run build:worker'/i);

      // 2. Dummy file without PE MZ signature
      const workerDir = path.join(tempDir, 'src', 'tools', 'native-uia');
      fs.mkdirSync(workerDir, { recursive: true });
      const dummyPath = path.join(workerDir, 'LucyUiaWorker.exe');
      fs.writeFileSync(dummyPath, Buffer.alloc(2000, 'X')); // 'X' is not MZ

      const reportDummy = checkEnvironment(tempDir);
      assert.equal(reportDummy.ok, false);
      const workerCheckDummy = reportDummy.checks.find(c => c.name === 'native_uia_worker');
      assert.equal(workerCheckDummy.passed, false);
      assert.match(workerCheckDummy.message, /missing MZ signature/i);
      assert.match(workerCheckDummy.message, /Action: Recompile via 'npm run build:worker'/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects missing or empty core entry points and fails closed', async () => {
    const { checkEnvironment } = await import(`file://${SCRIPT_PATH.replace(/\\/g, '/')}`);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-env-test2-'));

    try {
      const report = checkEnvironment(tempDir);
      assert.equal(report.ok, false);
      const entryCheck = report.checks.find(c => c.name === 'core_entry_points');
      assert.equal(entryCheck.passed, false);
      assert.match(entryCheck.message, /Defective entry points/i);
      assert.match(entryCheck.message, /Action: Restore missing or truncated source files/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('CLI exits with code 1 when verifying an invalid directory via --dir', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-env-cli-'));
    try {
      const res = spawnSync(process.execPath, [SCRIPT_PATH, '--json', '--dir', tempDir], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      });

      assert.equal(res.status, 1, 'Expected exit code 1 on failed environment check');
      const report = JSON.parse(res.stdout);
      assert.equal(report.ok, false);
      assert.ok(report.checksPassed < report.checksTotal);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
