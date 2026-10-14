'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore } = require('../../src/memory/memory-store.js');
const { SqliteMemoryAdapter } = require('../../src/memory/sqlite-adapter.js');
const { TaskContinuityStore } = require('../../src/memory/task-continuity-store.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { isTestEnvironment } = require('../../src/memory/memory-constants.js');

test('Workstream 1A — Storage Test Isolation Guard & Regression Suite', async (t) => {
    const testTempDir = path.join(os.tmpdir(), `lucy_guard_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testTempDir, { recursive: true });

    t.after(() => {
        try {
            fs.rmSync(testTempDir, { recursive: true, force: true });
        } catch {}
    });

    await t.test('1. Environment detection identifies node test runner as test environment', () => {
        assert.equal(isTestEnvironment(), true, 'Must identify current process as test environment');
    });

    await t.test('2. MemoryStore throws TestIsolationViolation when instantiated without explicit isolated dir', () => {
        assert.throws(
            () => new MemoryStore(),
            (err) => {
                assert.match(err.message, /\[TestIsolationViolation\]/);
                assert.match(err.message, /MemoryStore/);
                return true;
            },
            'Should throw TestIsolationViolation when MemoryStore is instantiated without options'
        );
    });

    await t.test('3. SqliteMemoryAdapter throws TestIsolationViolation when instantiated without explicit isolated dir', () => {
        assert.throws(
            () => new SqliteMemoryAdapter(),
            (err) => {
                assert.match(err.message, /\[TestIsolationViolation\]/);
                assert.match(err.message, /SqliteMemoryAdapter/);
                return true;
            },
            'Should throw TestIsolationViolation when SqliteMemoryAdapter is instantiated without options'
        );
    });

    await t.test('4. TaskContinuityStore throws TestIsolationViolation when instantiated without explicit isolated dir', () => {
        assert.throws(
            () => new TaskContinuityStore(),
            (err) => {
                assert.match(err.message, /\[TestIsolationViolation\]/);
                assert.match(err.message, /TaskContinuityStore/);
                return true;
            },
            'Should throw TestIsolationViolation when TaskContinuityStore is instantiated without options'
        );
    });

    await t.test('5. TaskCoordinator throws TestIsolationViolation when instantiated without explicit storage or isolated dir', () => {
        assert.throws(
            () => new TaskCoordinator(),
            (err) => {
                assert.match(err.message, /\[TestIsolationViolation\]/);
                return true;
            },
            'Should throw TestIsolationViolation when TaskCoordinator is instantiated without storage isolation options'
        );
    });

    await t.test('6. All components instantiate successfully with explicit isolated directory', async () => {
        const isolatedDir = path.join(testTempDir, 'isolated_explicit');
        fs.mkdirSync(isolatedDir, { recursive: true });

        const memStore = new MemoryStore({ memoryDir: isolatedDir });
        assert.equal(memStore.memoryDir, isolatedDir);

        const sqliteAdapter = new SqliteMemoryAdapter({ memoryDir: isolatedDir });
        assert.equal(sqliteAdapter.memoryDir, isolatedDir);

        const continuityStore = new TaskContinuityStore({ storeDir: isolatedDir });
        assert.equal(continuityStore.storeDir, isolatedDir);

        const coordinator = new TaskCoordinator({ memoryDir: isolatedDir });
        assert.equal(coordinator.memoryStore.memoryDir, isolatedDir);
        assert.equal(coordinator.taskContinuityStore.storeDir, isolatedDir);
    });

    await t.test('7. Environment variable LUCY_MEMORY_DIR enables global isolation override for tests', () => {
        const envDir = path.join(testTempDir, 'env_isolated');
        fs.mkdirSync(envDir, { recursive: true });

        const prevEnv = process.env.LUCY_MEMORY_DIR;
        try {
            process.env.LUCY_MEMORY_DIR = envDir;

            const memStore = new MemoryStore();
            assert.equal(memStore.memoryDir, envDir);

            const sqliteAdapter = new SqliteMemoryAdapter();
            assert.equal(sqliteAdapter.memoryDir, envDir);

            const continuityStore = new TaskContinuityStore();
            assert.equal(continuityStore.storeDir, envDir);

            const coordinator = new TaskCoordinator();
            assert.equal(coordinator.memoryStore.memoryDir, envDir);
            assert.equal(coordinator.taskContinuityStore.storeDir, envDir);
        } finally {
            if (prevEnv !== undefined) {
                process.env.LUCY_MEMORY_DIR = prevEnv;
            } else {
                delete process.env.LUCY_MEMORY_DIR;
            }
        }
    });

    await t.test('8. Atomic save cleanup: TaskContinuityStore cleans up temp file when save fails', () => {
        const atomicDir = path.join(testTempDir, 'atomic_continuity');
        fs.mkdirSync(atomicDir, { recursive: true });

        const store = new TaskContinuityStore({ storeDir: atomicDir });
        // Make filePath a directory so renameSync fails with EISDIR / EPERM
        fs.mkdirSync(path.join(atomicDir, 'task-checkpoints.json'), { recursive: true });

        const saved = store.save();
        assert.equal(saved, false, 'Save should return false on rename failure');

        // Verify no leftover .tmp_* files exist in atomicDir
        const files = fs.readdirSync(atomicDir);
        const tempFiles = files.filter(f => f.includes('.tmp_'));
        assert.equal(tempFiles.length, 0, 'Orphaned temp files must be removed on failure');
    });
});
