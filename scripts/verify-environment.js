#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

const PE_CONSTANTS = {
  MACHINE_I386: 0x014c,   // x86 / AnyCPU .NET
  MACHINE_AMD64: 0x8664,  // x64
  MACHINE_ARM64: 0xaa64,  // ARM64
  MACHINE_IA64: 0x0200    // Intel Itanium
};

const MACHINE_NAMES = {
  [PE_CONSTANTS.MACHINE_I386]: 'IMAGE_FILE_MACHINE_I386 (x86 / AnyCPU)',
  [PE_CONSTANTS.MACHINE_AMD64]: 'IMAGE_FILE_MACHINE_AMD64 (x64)',
  [PE_CONSTANTS.MACHINE_ARM64]: 'IMAGE_FILE_MACHINE_ARM64 (ARM64)',
  [PE_CONSTANTS.MACHINE_IA64]: 'IMAGE_FILE_MACHINE_IA64 (IA64)'
};

function sanitizePath(filePath, repoRoot) {
  if (!filePath || typeof filePath !== 'string') return '';
  if (repoRoot && filePath.startsWith(repoRoot)) {
    return path.relative(repoRoot, filePath).replace(/\\/g, '/');
  }
  return path.basename(filePath);
}

/**
 * Validates a Windows PE binary header using bounded, dependency-free parsing.
 * 
 * Verifies:
 * 1. Physical presence and minimum size bounds.
 * 2. DOS header "MZ" signature (0x4D, 0x5A).
 * 3. Bounded PE header offset (e_lfanew at 0x3C) strictly within file size.
 * 4. PE signature "PE\0\0" (0x50, 0x45, 0x00, 0x00).
 * 5. Target machine architecture against expected machine types.
 * 
 * Note: This constitutes structural validation only. It does not provide
 * cryptographic integrity, digital signature verification, or runtime safety guarantees.
 */
function validatePeBinary(target, options = {}) {
  const repoRoot = options.repoRoot || null;
  const minSize = options.minSize ?? 1000;

  let expectedMachines = [PE_CONSTANTS.MACHINE_I386];
  if (options.expectedMachines && Array.isArray(options.expectedMachines)) {
    expectedMachines = options.expectedMachines;
  } else if (options.expectedMachine !== undefined) {
    expectedMachines = [options.expectedMachine];
  }

  let buf = null;
  let fileSize = 0;
  let fd = null;
  const isBuffer = Buffer.isBuffer(target);
  const targetLabel = isBuffer ? '<in-memory buffer>' : sanitizePath(target, repoRoot);

  try {
    if (isBuffer) {
      buf = target;
      fileSize = buf.length;
    } else {
      if (typeof target !== 'string') {
        return {
          ok: false,
          code: 'ERR_INVALID_TARGET',
          error: 'Target must be a file path string or Buffer'
        };
      }

      let stat;
      try {
        stat = fs.statSync(target);
      } catch (err) {
        return {
          ok: false,
          code: 'ERR_FILE_NOT_FOUND',
          error: `${targetLabel} not found: ${err.message}. Action: Run 'npm run build:worker' to compile the native worker.`
        };
      }

      if (!stat.isFile()) {
        return {
          ok: false,
          code: 'ERR_NOT_A_FILE',
          error: `${targetLabel} is not a regular file`
        };
      }
      fileSize = stat.size;
    }

    if (minSize > 0 && fileSize < minSize) {
      return {
        ok: false,
        code: 'ERR_TOO_SMALL',
        fileSize,
        error: `${targetLabel} is too small (${fileSize} bytes, minimum required: ${minSize} bytes). Action: Recompile via 'npm run build:worker'.`
      };
    }

    if (fileSize < 64) {
      return {
        ok: false,
        code: 'ERR_TRUNCATED_DOS_HEADER',
        fileSize,
        error: `${targetLabel} is truncated (${fileSize} bytes, smaller than 64-byte DOS header). Action: Recompile via 'npm run build:worker'.`
      };
    }

    let dosHeaderBuf;
    if (isBuffer) {
      dosHeaderBuf = buf.subarray(0, 64);
    } else {
      fd = fs.openSync(target, 'r');
      dosHeaderBuf = Buffer.alloc(64);
      fs.readSync(fd, dosHeaderBuf, 0, 64, 0);
    }

    // Check DOS magic ("MZ" = 0x4D, 0x5A)
    if (dosHeaderBuf[0] !== 0x4D || dosHeaderBuf[1] !== 0x5A) {
      return {
        ok: false,
        code: 'ERR_INVALID_DOS_SIGNATURE',
        fileSize,
        error: `${targetLabel} is not a valid Windows executable (missing MZ signature). Action: Recompile via 'npm run build:worker'.`
      };
    }

    // Read e_lfanew (PE header offset) at offset 0x3C
    const peOffset = dosHeaderBuf.readUInt32LE(0x3C);

    // Bounds-check PE header offset
    if (peOffset < 64 || peOffset + 24 > fileSize) {
      return {
        ok: false,
        code: 'ERR_PE_OFFSET_OUT_OF_BOUNDS',
        fileSize,
        peOffset,
        error: `${targetLabel} has out-of-bounds PE header offset 0x${peOffset.toString(16)} (file size: ${fileSize} bytes). Action: Recompile via 'npm run build:worker'.`
      };
    }

    // Read PE signature and COFF machine
    let peHeaderBuf;
    if (isBuffer) {
      peHeaderBuf = buf.subarray(peOffset, peOffset + 24);
    } else {
      peHeaderBuf = Buffer.alloc(24);
      fs.readSync(fd, peHeaderBuf, 0, 24, peOffset);
    }

    // Check "PE\0\0" = 0x50, 0x45, 0x00, 0x00
    if (peHeaderBuf[0] !== 0x50 || peHeaderBuf[1] !== 0x45 || peHeaderBuf[2] !== 0x00 || peHeaderBuf[3] !== 0x00) {
      return {
        ok: false,
        code: 'ERR_INVALID_PE_SIGNATURE',
        fileSize,
        peOffset,
        error: `${targetLabel} has invalid PE signature at offset 0x${peOffset.toString(16)} (missing PE\\0\\0 signature). Action: Recompile via 'npm run build:worker'.`
      };
    }

    // Read COFF Machine (2 bytes at peOffset + 4)
    const machine = peHeaderBuf.readUInt16LE(4);
    const machineName = MACHINE_NAMES[machine] || `unknown (0x${machine.toString(16)})`;

    if (!expectedMachines.includes(machine)) {
      const expectedNames = expectedMachines.map(m => `0x${m.toString(16)} (${MACHINE_NAMES[m] || 'unknown'})`).join(' or ');
      return {
        ok: false,
        code: 'ERR_UNEXPECTED_MACHINE_ARCH',
        fileSize,
        peOffset,
        machine,
        machineName,
        error: `${targetLabel} has incorrect machine architecture: 0x${machine.toString(16)} (${machineName}), expected ${expectedNames}. Action: Recompile via 'npm run build:worker'.`
      };
    }

    return {
      ok: true,
      fileSize,
      peOffset,
      machine,
      machineName,
      message: `${targetLabel} structurally verified PE binary (${fileSize} bytes, PE offset 0x${peOffset.toString(16)}, machine: ${machineName}). Note: Structural validation only; does not provide cryptographic integrity or runtime safety guarantees.`
    };
  } catch (err) {
    return {
      ok: false,
      code: 'ERR_PE_VALIDATION_EXCEPTION',
      error: `Error validating PE header for ${targetLabel}: ${err.message}`
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function checkEnvironment(repoRoot = DEFAULT_REPO_ROOT, options = {}) {
  const checks = [];

  // 1. Node.js version
  const [major] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node_version',
    passed: major >= 20,
    message: major >= 20
      ? `Node.js v${process.versions.node} (required >= 20)`
      : `Node.js v${process.versions.node} is unsupported (required >= 20). Action: Upgrade Node.js runtime to version 20 or higher.`
  });

  // 2. Native UIA worker binary
  const workerRel = path.join('src', 'tools', 'native-uia', 'LucyUiaWorker.exe');
  const workerPath = path.join(repoRoot, workerRel);
  const peRes = validatePeBinary(workerPath, {
    repoRoot,
    minSize: 1000,
    expectedMachine: PE_CONSTANTS.MACHINE_I386
  });
  checks.push({
    name: 'native_uia_worker',
    passed: peRes.ok,
    message: peRes.ok ? peRes.message : peRes.error
  });

  // 3. Core entry points
  const entryPoints = [
    'src/main/index.js',
    'src/main/preload.js',
    'src/core/task-coordinator.js',
    'src/core/task-planner.js',
    'src/security/ipc-validator.js'
  ];
  const invalidEntries = [];
  for (const rel of entryPoints) {
    const full = path.join(repoRoot, rel);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size < 20) {
        invalidEntries.push(`${rel} (empty or invalid)`);
      }
    } catch {
      invalidEntries.push(`${rel} (missing)`);
    }
  }
  checks.push({
    name: 'core_entry_points',
    passed: invalidEntries.length === 0,
    message: invalidEntries.length === 0
      ? `All ${entryPoints.length} core entry points verified with valid non-empty files`
      : `Defective entry points: ${invalidEntries.join(', ')}. Action: Restore missing or truncated source files from git.`
  });

  // 4. Security rules & authoritative guidelines
  const agentsMd = path.join(repoRoot, 'AGENTS.md');
  let rulesOk = false;
  let rulesMsg = '';
  if (fs.existsSync(agentsMd)) {
    const content = fs.readFileSync(agentsMd, 'utf8');
    const hasSingleAuth = content.includes('Single Authority Model');
    const hasIpc = content.includes('IPC Security Boundary');
    rulesOk = hasSingleAuth && hasIpc;
    rulesMsg = rulesOk
      ? 'AGENTS.md contains verified Single Authority & IPC security boundaries'
      : 'AGENTS.md missing required architectural invariant declarations. Action: Ensure AGENTS.md defines Single Authority Model and IPC Security Boundary.';
  } else {
    rulesMsg = 'AGENTS.md not found at repository root. Action: Restore AGENTS.md from git.';
  }
  checks.push({
    name: 'security_rules',
    passed: rulesOk,
    message: rulesMsg
  });

  // 5. Workspace customizations (.agents)
  const docsRule = path.join(repoRoot, '.agents', 'rules', 'authoritative-docs.md');
  const workflowSkill = path.join(repoRoot, '.agents', 'skills', 'lucy-workflow', 'SKILL.md');
  const customizationsOk = fs.existsSync(docsRule) && fs.existsSync(workflowSkill);
  checks.push({
    name: 'workspace_customizations',
    passed: customizationsOk,
    message: customizationsOk
      ? 'Workspace customization root (.agents) verified with authoritative-docs and lucy-workflow'
      : 'Workspace customization files (.agents) missing or incomplete. Action: Restore .agents directory with authoritative-docs.md and SKILL.md.'
  });

  const passedCount = checks.filter(c => c.passed).length;
  const ok = passedCount === checks.length;
  return {
    ok,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    checksPassed: passedCount,
    checksTotal: checks.length,
    checks
  };
}

// CLI Execution guard: only execute CLI when directly run as entry point
if (require.main === module || (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))) {
  const isJson = process.argv.includes('--json');
  let targetRoot = DEFAULT_REPO_ROOT;
  const dirIdx = process.argv.indexOf('--dir');
  if (dirIdx !== -1 && process.argv[dirIdx + 1]) {
    targetRoot = path.resolve(process.argv[dirIdx + 1]);
  }

  const report = checkEnvironment(targetRoot);

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== L.U.C.Y. Engineering Environment Verification ===\n');
    console.log(`Timestamp: ${report.timestamp}`);
    console.log(`Platform:  ${report.platform} (${report.arch}) | Node: ${report.nodeVersion}\n`);

    for (const c of report.checks) {
      const mark = c.passed ? '✔ PASS' : '✖ FAIL';
      console.log(`  [${mark}] ${c.name.padEnd(26)} : ${c.message}`);
    }

    console.log(`\nOverall Status: ${report.ok ? `HEALTHY (${report.checksPassed}/${report.checksTotal} checks passed)` : `UNHEALTHY (${report.checksPassed}/${report.checksTotal} passed)`}\n`);
  }

  process.exit(report.ok ? 0 : 1);
}

module.exports = {
  checkEnvironment,
  validatePeBinary,
  PE_CONSTANTS,
  sanitizePath
};
