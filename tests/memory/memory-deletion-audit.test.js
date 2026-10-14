'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SqliteMemoryAdapter } = require('../../src/memory/sqlite-adapter.js');
const { MemoryStore, MEMORY_CATEGORIES, MEMORY_TYPES, MEMORY_SOURCES } = require('../../src/memory/memory-store.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');

test('Forensic Audit: Memory Deletion & Task Continuity Fixes', async (t) => {
    const testDir = path.join(os.tmpdir(), `lucy_del_audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });

    t.after(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {}
    });

    await t.test('1. SqliteMemoryAdapter: Delete conversation record by exact ID without deleting other empty-key records', async () => {
        const dbPath = path.join(testDir, 'empty_key_test.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testDir, dbPath });
        await adapter.init();

        // Insert 3 conversation turns (all have key: '')
        const mem1 = adapter.insertMemory({
            id: 'mem_conv_01',
            category: MEMORY_CATEGORIES.CONVERSATION,
            key: '',
            content: 'User: How is the weather today?',
            type: MEMORY_TYPES.CONVERSATION_TURN
        });
        const mem2 = adapter.insertMemory({
            id: 'mem_conv_02',
            category: MEMORY_CATEGORIES.CONVERSATION,
            key: '',
            content: 'Assistant: It is sunny and 72 degrees.',
            type: MEMORY_TYPES.CONVERSATION_TURN
        });
        const mem3 = adapter.insertMemory({
            id: 'mem_conv_03',
            category: MEMORY_CATEGORIES.CONVERSATION,
            key: '',
            content: 'User: Thank you!',
            type: MEMORY_TYPES.CONVERSATION_TURN
        });

        assert.equal(adapter.getCategoryCounts().total, 3, 'Should have 3 records initially');

        // Delete mem2 by ID
        const deleted = adapter.deleteMemory('mem_conv_02');
        assert.equal(deleted, true, 'deleteMemory should report true for existing ID');

        // Confirm mem2 is gone
        assert.equal(adapter.getMemoryById('mem_conv_02'), null, 'Deleted record must not be found');
        assert.equal(adapter.getCategoryCounts().total, 2, 'Total count should now be 2');

        // CRITICAL CHECK: mem1 and mem3 must still exist!
        // Under the old bug, if key was empty, deleting with empty key wiped all empty keys or failed completely.
        const mem1Fetched = adapter.getMemoryById('mem_conv_01');
        const mem3Fetched = adapter.getMemoryById('mem_conv_03');
        assert.ok(mem1Fetched, 'mem_conv_01 must remain intact');
        assert.ok(mem3Fetched, 'mem_conv_03 must remain intact');
        assert.equal(mem1Fetched.content, 'User: How is the weather today?');
        assert.equal(mem3Fetched.content, 'User: Thank you!');

        // Deleting non-existent ID fails closed
        const deletedAgain = adapter.deleteMemory('mem_conv_02');
        assert.equal(deletedAgain, false, 'Deleting already-deleted record should return false');
        const deletedInvalid = adapter.deleteMemory('nonexistent_id');
        assert.equal(deletedInvalid, false, 'Deleting non-existent ID should return false');

        adapter.close();
    });

    await t.test('2. SqliteMemoryAdapter: Persistence across close and reopen', async () => {
        const dbPath = path.join(testDir, 'reopen_test.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testDir, dbPath });
        await adapter.init();

        adapter.insertMemory({
            id: 'mem_persist_01',
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'theme_color',
            content: 'User prefers dark emerald theme',
            type: MEMORY_TYPES.CONFIRMED_FACT
        });
        adapter.insertMemory({
            id: 'mem_persist_02',
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'temp_record',
            content: 'Temporary record to delete',
            type: MEMORY_TYPES.CONFIRMED_FACT
        });

        assert.equal(adapter.getCategoryCounts().total, 2);
        const delRes = adapter.deleteMemory('mem_persist_02');
        assert.equal(delRes, true);
        assert.equal(adapter.getCategoryCounts().total, 1);

        adapter.close();

        // Reopen new adapter instance on same file
        const adapter2 = new SqliteMemoryAdapter({ memoryDir: testDir, dbPath });
        await adapter2.init();

        assert.equal(adapter2.getCategoryCounts().total, 1, 'Persisted count must be 1 after reopen');
        assert.equal(adapter2.getMemoryById('mem_persist_02'), null, 'Deleted record must stay gone');
        const surviving = adapter2.getMemoryById('mem_persist_01');
        assert.ok(surviving, 'Surviving record must exist');
        assert.equal(surviving.key, 'theme_color');

        adapter2.close();
    });

    await t.test('3. MemoryStore: Deletion by ID synchronizes SQLite and in-memory list with no resurrection', async () => {
        const storeDir = path.join(testDir, 'store_sync');
        fs.mkdirSync(storeDir, { recursive: true });

        // Initialize SQLite adapter
        const sqliteAdapter = new SqliteMemoryAdapter({
            memoryDir: storeDir,
            dbPath: path.join(storeDir, 'lucy-memory.sqlite')
        });
        await sqliteAdapter.init();

        const store = new MemoryStore({
            memoryDir: storeDir,
            sqliteAdapter
        });
        await store.initSqlite();

        // Add memories via MemoryStore
        const c1 = store.addMemory({
            category: MEMORY_CATEGORIES.CONVERSATION,
            key: '',
            content: 'What is relativity?',
            type: MEMORY_TYPES.CONVERSATION_TURN,
            source: MEMORY_SOURCES.DIRECT_USER_INPUT
        });

        const c2 = store.addMemory({
            category: MEMORY_CATEGORIES.CONVERSATION,
            key: '',
            content: 'Relativity is a physical theory of spacetime.',
            type: MEMORY_TYPES.CONVERSATION_TURN,
            source: MEMORY_SOURCES.INFERRED
        });

        const u1 = store.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'favorite_animal',
            content: 'Fairy dragon',
            type: MEMORY_TYPES.CONFIRMED_FACT,
            source: MEMORY_SOURCES.USER_EXPLICIT
        });

        assert.equal(store.memories.length, 3);
        assert.equal(sqliteAdapter.getCategoryCounts().total, 3);

        // Delete conversation record c1 by exact ID
        const delRes = store.deleteMemory(c1.id);
        assert.equal(delRes, true, 'MemoryStore.deleteMemory should return true for c1.id');

        // In-memory verification
        assert.equal(store.memories.length, 2);
        assert.equal(store.memories.find(m => m.id === c1.id), undefined);
        assert.ok(store.memories.find(m => m.id === c2.id));
        assert.ok(store.memories.find(m => m.id === u1.id));

        // SQLite verification
        assert.equal(sqliteAdapter.getCategoryCounts().total, 2);
        assert.equal(sqliteAdapter.getMemoryById(c1.id), null);

        // Delete non-existent ID fails closed
        const delNonExistent = store.deleteMemory('mem_fake_id_9999');
        assert.equal(delNonExistent, false, 'Non-existent ID deletion must return false');

        // Test reload / restart scenario: re-initialize a new MemoryStore pointing to same SQLite and JSON
        const store2 = new MemoryStore({
            memoryDir: storeDir,
            sqliteAdapter
        });
        await store2.initSqlite();

        // Deleted item must NOT be resurrected from JSON or anywhere else
        assert.equal(store2.memories.length, 2, 'Reloaded store must still have 2 items');
        assert.equal(store2.memories.find(m => m.id === c1.id), undefined, 'c1 must NOT be resurrected');
        assert.ok(store2.memories.find(m => m.id === c2.id), 'c2 must persist');

        sqliteAdapter.close();
    });

    await t.test('4. TaskCoordinator: deleteMemory and discardTask integration', async () => {
        const coordDir = path.join(testDir, 'coord_test');
        fs.mkdirSync(coordDir, { recursive: true });

        const memoryStore = new MemoryStore({ memoryDir: coordDir, enableSqlite: true });
        const sqliteAdapter = new SqliteMemoryAdapter({
            memoryDir: coordDir,
            dbPath: path.join(coordDir, 'coordinator.sqlite')
        });
        await sqliteAdapter.init();
        await memoryStore.initSqlite(sqliteAdapter);

        const taskContinuityStore = new TaskContinuityStore({
            storeDir: coordDir,
            sqliteAdapter
        });

        const coordinator = new TaskCoordinator({
            memoryStore,
            taskContinuityStore
        });

        // Add a test memory
        const mem = coordinator.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'test_pref',
            content: 'dark mode active',
            type: MEMORY_TYPES.CONFIRMED_FACT
        });

        // Deleting non-existent memory returns false (fail-closed)
        const fakeDel = coordinator.deleteMemory('nonexistent_id');
        assert.equal(fakeDel, false, 'Deleting bogus ID must return false');

        // Deleting legitimate memory returns true
        const realDel = coordinator.deleteMemory(mem.id);
        assert.equal(realDel, true, 'Deleting valid ID must return true');

        // Test checkpoint discard
        sqliteAdapter.saveTaskCheckpoint({
            taskId: 'task_audit_stuck_01',
            objective: 'Interrupted test task',
            status: TASK_STATUSES.IN_PROGRESS,
            currentStepIndex: 0,
            totalSteps: 3,
            steps: []
        });
        taskContinuityStore.syncFromSqlite();

        const checkpoints = coordinator.getInterruptedTasks();
        const found = checkpoints.some(c => c.taskId === 'task_audit_stuck_01');
        assert.equal(found, true, 'Checkpoint should be retrievable before discard');

        // Discard valid checkpoint
        const discardResult = coordinator.discardTask('task_audit_stuck_01');
        assert.equal(discardResult, true, 'discardTask should return true');

        // Confirm discarded
        const remaining = coordinator.getInterruptedTasks();
        assert.equal(remaining.some(c => c.taskId === 'task_audit_stuck_01'), false, 'Discarded task must be gone');

        // Discarding again returns false
        const discardAgain = coordinator.discardTask('task_audit_stuck_01');
        assert.equal(discardAgain, false, 'Discarding already-discarded task must return false');

        sqliteAdapter.close();
    });

    await t.test('5. TaskCoordinator: Conversational early-exits terminate checkpoint cleanly (no 0/0 stuck tasks)', async () => {
        const coordDir = path.join(testDir, 'coord_exit_test');
        fs.mkdirSync(coordDir, { recursive: true });

        const memoryStore = new MemoryStore({ memoryDir: coordDir });
        const taskContinuityStore = new TaskContinuityStore({ storeDir: coordDir });

        const coordinator = new TaskCoordinator({
            memoryStore,
            taskContinuityStore
        });

        // Mock planner that returns early conversational answer (0 executable steps)
        coordinator.planner = {
            plan: async (userPrompt) => ({
                type: 'conversation',
                goal: userPrompt,
                confidence: 0.95,
                steps: [], // 0 steps
                replyText: 'Relativity explains gravitation as spacetime curvature.'
            })
        };

        const result = await coordinator.executeRequest('What is the theory of general relativity?');
        assert.equal(result.ok, true, 'Request must succeed');
        assert.equal(result.status, 'completed', 'Task status must be completed');
        assert.equal(result.executedSteps.length, 0);

        // Checkpoint verification: must NOT be in_progress
        const interrupted = coordinator.getInterruptedTasks();
        const stuck = interrupted.some(c => c.taskId === result.taskId);
        assert.equal(stuck, false, 'Early conversational exit must NOT leave task stuck in interrupted list');
    });
});
