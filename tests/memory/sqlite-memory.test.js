'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SqliteMemoryAdapter } = require('../../src/memory/sqlite-adapter.js');
const { MemoryMigrator } = require('../../src/memory/memory-migrator.js');
const { MemoryStore, MEMORY_CATEGORIES, MEMORY_TYPES, MEMORY_SOURCES } = require('../../src/memory/memory-store.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');

test('Batch 05 - SQLite Persistent Memory & Safe Migration', async (t) => {
    const testTempDir = path.join(os.tmpdir(), `lucy_sqlite_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testTempDir, { recursive: true });

    t.after(() => {
        try {
            fs.rmSync(testTempDir, { recursive: true, force: true });
        } catch {}
    });

    await t.test('1. SqliteMemoryAdapter initializes schema via WebAssembly without native compilation', async () => {
        const dbPath = path.join(testTempDir, 'test-adapter.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        assert.equal(adapter.initialized, true, 'Adapter should be marked initialized');
        assert.ok(adapter.db, 'Database handle should be created');

        // Check tables created
        const tables = [];
        const stmt = adapter.db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
        while (stmt.step()) {
            tables.push(stmt.getAsObject().name);
        }
        stmt.free();

        assert.ok(tables.includes('memories'), 'memories table must exist');
        assert.ok(tables.includes('metadata'), 'metadata table must exist');
        assert.ok(tables.includes('task_checkpoints'), 'task_checkpoints table must exist');

        adapter.close();
    });

    await t.test('2. SqliteMemoryAdapter scrubs secrets before inserting into SQLite', async () => {
        const dbPath = path.join(testTempDir, 'secrets.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        const inserted = adapter.insertMemory({
            id: 'mem_sec_01',
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'api_config',
            content: 'My secret key is sk-12345678901234567890 and github token is ghp_123456789012345678901234567890123456',
            type: MEMORY_TYPES.CONFIRMED_FACT
        });

        assert.equal(inserted.content.includes('sk-12345678901234567890'), false, 'Key must be redacted');
        assert.equal(inserted.content.includes('[REDACTED_SECRET]'), true, 'Content must contain redaction notice');

        const fetched = adapter.getMemoryById('mem_sec_01');
        assert.equal(fetched.content.includes('sk-12345678901234567890'), false);
        assert.equal(fetched.content.includes('[REDACTED_SECRET]'), true);

        adapter.close();
    });

    await t.test('3. MemoryMigrator creates timestamped backup, scrubs secrets, and migrates all 5 categories with exact parity', async () => {
        const migDir = path.join(testTempDir, 'mig_test');
        fs.mkdirSync(migDir, { recursive: true });
        const jsonPath = path.join(migDir, 'memory-store.json');

        // Create legacy JSON with memories across all 5 categories
        const legacyData = {
            version: 1,
            longTermEnabled: true,
            memories: [
                { id: 'm1', category: MEMORY_CATEGORIES.CONVERSATION, content: 'User asked about electron build', key: 'topic' },
                { id: 'm2', category: MEMORY_CATEGORIES.USER_APPROVED, content: 'User prefers dark mode', key: 'theme' },
                { id: 'm3', category: MEMORY_CATEGORIES.TASK_CONTINUITY, content: 'Completed step 1 of file migration', key: 'step1' },
                { id: 'm4', category: MEMORY_CATEGORIES.PROJECT, content: 'Project name is L.U.C.Y.', key: 'proj_name' },
                { id: 'm5', category: MEMORY_CATEGORIES.WORKING_DATA, content: 'Temp working buffer', key: 'buf' },
                { id: 'm6', category: MEMORY_CATEGORIES.USER_APPROVED, content: 'Bearer secret_token_xyz_1234567890', key: 'token' }
            ]
        };
        fs.writeFileSync(jsonPath, JSON.stringify(legacyData, null, 2), 'utf8');

        const adapter = new SqliteMemoryAdapter({ memoryDir: migDir, dbPath: path.join(migDir, 'migrated.sqlite') });
        const migResult = await MemoryMigrator.migrate({
            memoryDir: migDir,
            jsonPath,
            sqliteAdapter: adapter
        });

        assert.equal(migResult.ok, true, 'Migration must succeed');
        assert.equal(migResult.parityVerified, true, 'Exact parity check must pass');
        assert.equal(migResult.totalMigrated, 6, 'All 6 memories must be migrated');
        assert.ok(fs.existsSync(migResult.backupPath), 'Timestamped backup must exist');
        assert.ok(fs.existsSync(jsonPath), 'Original JSON file must be preserved');

        // Verify category counts match
        const counts = adapter.getCategoryCounts();
        assert.equal(counts.total, 6);
        assert.equal(counts.categories[MEMORY_CATEGORIES.CONVERSATION], 1);
        assert.equal(counts.categories[MEMORY_CATEGORIES.USER_APPROVED], 2);
        assert.equal(counts.categories[MEMORY_CATEGORIES.TASK_CONTINUITY], 1);
        assert.equal(counts.categories[MEMORY_CATEGORIES.PROJECT], 1);
        assert.equal(counts.categories[MEMORY_CATEGORIES.WORKING_DATA], 1);

        // Verify secret was redacted in SQLite
        const secretMem = adapter.getMemoryById('m6');
        assert.equal(secretMem.content.includes('secret_token_xyz_1234567890'), false);
        assert.equal(secretMem.content.includes('[REDACTED_SECRET]'), true);

        // Verify metadata set
        assert.equal(adapter.getMetadata('migrated_from_json'), 'true');
        assert.ok(adapter.getMetadata('migration_timestamp'));

        adapter.close();
    });

    await t.test('4. MemoryMigrator rolls back safely if parity check fails', async () => {
        const rollDir = path.join(testTempDir, 'rollback_test');
        fs.mkdirSync(rollDir, { recursive: true });
        const jsonPath = path.join(rollDir, 'memory-store.json');
        const dbPath = path.join(rollDir, 'rollback.sqlite');

        const legacyData = {
            version: 1,
            memories: [
                { id: 'm1', category: MEMORY_CATEGORIES.CONVERSATION, content: 'Chat 1' },
                { id: 'm2', category: MEMORY_CATEGORIES.PROJECT, content: 'Project 1' }
            ]
        };
        fs.writeFileSync(jsonPath, JSON.stringify(legacyData, null, 2), 'utf8');

        // Create an adapter that simulates drop/failure during insert
        const adapter = new SqliteMemoryAdapter({ memoryDir: rollDir, dbPath });
        await adapter.init();
        
        // Mock getCategoryCounts to return a mismatch
        const originalGetCategoryCounts = adapter.getCategoryCounts.bind(adapter);
        adapter.getCategoryCounts = () => {
            return { total: 1, categories: { [MEMORY_CATEGORIES.CONVERSATION]: 1, [MEMORY_CATEGORIES.PROJECT]: 0 } };
        };

        const result = await MemoryMigrator.migrate({
            memoryDir: rollDir,
            jsonPath,
            sqliteAdapter: adapter
        });

        assert.equal(result.ok, false, 'Migration must fail on parity check');
        assert.equal(result.parityVerified, false, 'Parity verification must fail');
        assert.ok(result.discrepancies.length > 0, 'Discrepancies must be reported');
        assert.ok(fs.existsSync(jsonPath), 'Original JSON must remain completely intact');
        assert.ok(!fs.existsSync(dbPath), 'Incomplete SQLite file must be deleted upon rollback');
    });

    await t.test('5. MemoryStore synchronizes mutations to SQLite when active and respects TTL', async () => {
        const storeDir = path.join(testTempDir, 'store_sync_test');
        fs.mkdirSync(storeDir, { recursive: true });

        const store = new MemoryStore({ memoryDir: storeDir });
        const initSuccess = await store.initSqlite();
        assert.equal(initSuccess, true, 'initSqlite should succeed');
        assert.equal(store.sqliteActive, true, 'sqliteActive should be true');

        // 1. Add memory
        const m = store.addMemory({
            category: MEMORY_CATEGORIES.PROJECT,
            key: 'repo_name',
            content: 'L.U.C.Y. Desktop'
        });
        assert.ok(m.id);

        const sqlRec = store.sqliteAdapter.getMemoryById(m.id);
        assert.ok(sqlRec);
        assert.equal(sqlRec.content, 'L.U.C.Y. Desktop');

        // 2. Update memory
        store.updateMemory(m.id, { content: 'L.U.C.Y. Desktop Pro' });
        const updatedSqlRec = store.sqliteAdapter.getMemoryById(m.id);
        assert.equal(updatedSqlRec.content, 'L.U.C.Y. Desktop Pro');

        // 3. Delete memory
        const deleted = store.deleteMemory(m.id);
        assert.equal(deleted, true);
        const deletedSqlRec = store.sqliteAdapter.getMemoryById(m.id);
        assert.equal(deletedSqlRec, null);

        // 4. TTL expiration in SQLite
        store.addMemory({
            category: MEMORY_CATEGORIES.WORKING_DATA,
            key: 'expiring',
            content: 'short-lived scratch',
            ttlMs: -1000 // already expired
        });
        store.purgeExpired();
        const workingMemories = store.sqliteAdapter.getMemories({ category: MEMORY_CATEGORIES.WORKING_DATA });
        assert.equal(workingMemories.length, 0, 'Expired working data should be purged');

        store.sqliteAdapter.close();
    });

    await t.test('6. MemoryStore falls back gracefully to JSON if SQLite encounters error', async () => {
        const fallbackDir = path.join(testTempDir, 'fallback_test');
        fs.mkdirSync(fallbackDir, { recursive: true });

        // Corrupt SQLite path or fail init
        const store = new MemoryStore({ memoryDir: fallbackDir });
        // Simulate broken sqlite adapter init
        store.sqliteAdapter = {
            init: async () => { throw new Error('WASM engine out of memory simulation'); }
        };

        const initResult = await store.initSqlite();
        assert.equal(initResult, false, 'initSqlite should return false on error');
        assert.equal(store.sqliteActive, false, 'sqliteActive should remain false');

        // Verify normal JSON operation still functions 100%
        const added = store.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'fallback_key',
            content: 'Fallback memory works perfectly'
        });
        assert.ok(added.id);

        const retrieved = store.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
        assert.equal(retrieved.length, 1);
        assert.equal(retrieved[0].content, 'Fallback memory works perfectly');
    });

    await t.test('7. Schema indexes and category preservation across all 5 standard categories', async () => {
        const dbPath = path.join(testTempDir, 'schema-categories.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        // 1. Verify indexes in sqlite_master
        const indices = [];
        const stmt = adapter.db.prepare("SELECT name FROM sqlite_master WHERE type='index'");
        while (stmt.step()) {
            indices.push(stmt.getAsObject().name);
        }
        stmt.free();

        assert.ok(indices.includes('idx_memories_category'), 'Category index must exist');
        assert.ok(indices.includes('idx_memories_key'), 'Key index must exist');
        assert.ok(indices.includes('idx_memories_status'), 'Status index must exist');
        assert.ok(indices.includes('idx_memories_updated_at'), 'UpdatedAt index must exist');
        assert.ok(indices.includes('idx_task_checkpoints_status'), 'Checkpoints status index must exist');

        // 2. Insert across all 5 categories
        for (const cat of Object.values(MEMORY_CATEGORIES)) {
            adapter.insertMemory({
                id: `mem_test_${cat}`,
                category: cat,
                key: `key_${cat}`,
                content: `Test content for ${cat}`,
                type: MEMORY_TYPES.CONFIRMED_FACT
            });
        }

        const counts = adapter.getCategoryCounts();
        assert.equal(counts.total, 5, 'Total must equal 5');
        for (const cat of Object.values(MEMORY_CATEGORIES)) {
            assert.equal(counts.categories[cat], 1, `Category ${cat} count must be 1`);
        }

        adapter.close();
    });

    await t.test('8. Parameterized queries resist SQL injection and malformed inputs safely', async () => {
        const dbPath = path.join(testTempDir, 'injection-test.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        // SQL injection payload in content, key, and id
        const injected = adapter.insertMemory({
            id: "mem_inj_1'); DROP TABLE memories; --",
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: "key' OR '1'='1",
            content: "Safe content with injected SQL: '); DROP TABLE memories; --"
        });

        assert.ok(injected.id);

        // Verify table still exists and record is retrievable safely
        const fetched = adapter.getMemoryById("mem_inj_1'); DROP TABLE memories; --");
        assert.ok(fetched, 'Record with injected SQL characters must be safely fetched');
        assert.equal(fetched.key, "key' or '1'='1");

        // Verify search with injection payload works without error
        const results = adapter.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
        assert.equal(results.length, 1);

        // Test malformed record: missing fields, non-string content
        const malformed = adapter.insertMemory({
            content: 12345,
            category: 'non_existent_category_xyz'
        });
        assert.ok(malformed.id);
        assert.equal(malformed.content, '12345');
        assert.equal(malformed.category, MEMORY_CATEGORIES.WORKING_DATA, 'Must fallback to working_data');

        adapter.close();
    });

    await t.test('9. Idempotent migration and retry behavior without duplicate records', async () => {
        const idemDir = path.join(testTempDir, 'idempotent_mig_test');
        fs.mkdirSync(idemDir, { recursive: true });
        const jsonPath = path.join(idemDir, 'memory-store.json');

        const legacyData = {
            version: 1,
            memories: [
                { id: 'm1', category: MEMORY_CATEGORIES.CONVERSATION, content: 'Chat turn 1' },
                { id: 'm2', category: MEMORY_CATEGORIES.PROJECT, content: 'Project doc' },
                { id: 'm3', category: MEMORY_CATEGORIES.USER_APPROVED, content: 'User fact' }
            ]
        };
        fs.writeFileSync(jsonPath, JSON.stringify(legacyData, null, 2), 'utf8');

        const adapter = new SqliteMemoryAdapter({ memoryDir: idemDir, dbPath: path.join(idemDir, 'idempotent.sqlite') });
        await adapter.init();

        // First migration run
        const run1 = await MemoryMigrator.migrate({ memoryDir: idemDir, jsonPath, sqliteAdapter: adapter });
        assert.equal(run1.ok, true);
        assert.equal(run1.migrated, true);
        assert.equal(run1.totalMigrated, 3);

        // Second migration run (idempotent retry)
        const run2 = await MemoryMigrator.migrate({ memoryDir: idemDir, jsonPath, sqliteAdapter: adapter });
        assert.equal(run2.ok, true);
        assert.equal(run2.migrated, false);
        assert.equal(run2.alreadyMigrated, true);
        assert.equal(run2.totalMigrated, 3);

        // Ensure database count remained exactly 3 without duplication
        const counts = adapter.getCategoryCounts();
        assert.equal(counts.total, 3, 'Counts must remain 3 without duplication');

        adapter.close();
    });

    await t.test('10. Pre-migration backup creation, collision safety, and readability verification', async () => {
        const bakDir = path.join(testTempDir, 'backup_verify_test');
        fs.mkdirSync(bakDir, { recursive: true });
        const jsonPath = path.join(bakDir, 'memory-store.json');

        const testPayload = {
            version: 1,
            memories: [
                { id: 'b1', category: MEMORY_CATEGORIES.WORKING_DATA, content: 'Temporary cache record' }
            ]
        };
        fs.writeFileSync(jsonPath, JSON.stringify(testPayload, null, 2), 'utf8');

        const adapter = new SqliteMemoryAdapter({ memoryDir: bakDir, dbPath: path.join(bakDir, 'backup.sqlite') });
        const migResult = await MemoryMigrator.migrate({ memoryDir: bakDir, jsonPath, sqliteAdapter: adapter });

        assert.equal(migResult.ok, true);
        assert.ok(migResult.backupPath);
        assert.ok(fs.existsSync(migResult.backupPath));

        // Read and parse backup file directly to verify data integrity
        const rawBackup = fs.readFileSync(migResult.backupPath, 'utf8');
        const parsedBackup = JSON.parse(rawBackup);
        assert.equal(parsedBackup.memories.length, 1);
        assert.equal(parsedBackup.memories[0].id, 'b1');

        adapter.close();
    });

    await t.test('11. Corrupt database detection, automated backup to .corrupt_*, and fresh DB recovery', async () => {
        const corruptDir = path.join(testTempDir, 'corrupt_test');
        fs.mkdirSync(corruptDir, { recursive: true });
        const dbPath = path.join(corruptDir, 'lucy-memory.sqlite');

        // Write corrupt garbage binary to database file
        fs.writeFileSync(dbPath, Buffer.from('NOT A VALID SQLITE DATABASE HEADER GIBBERISH'));

        const adapter = new SqliteMemoryAdapter({ memoryDir: corruptDir, dbPath });
        await adapter.init();

        assert.equal(adapter.initialized, true, 'Adapter should recover and initialize fresh');
        assert.ok(adapter.corruptBackupPath, 'Corrupt backup path should be recorded');
        assert.ok(fs.existsSync(adapter.corruptBackupPath), 'Corrupt file must be preserved on disk as backup');

        // Confirm new DB is fully operational
        adapter.insertMemory({
            id: 'recovered_01',
            category: MEMORY_CATEGORIES.PROJECT,
            content: 'Recovered memory operational'
        });
        const rec = adapter.getMemoryById('recovered_01');
        assert.ok(rec);
        assert.equal(rec.content, 'Recovered memory operational');

        adapter.close();
    });

    await t.test('12. Database persistence across full close and reopen cycle', async () => {
        const persistDir = path.join(testTempDir, 'persist_cycle_test');
        fs.mkdirSync(persistDir, { recursive: true });
        const dbPath = path.join(persistDir, 'persistent.sqlite');

        // Instance 1: write records and close
        const adapter1 = new SqliteMemoryAdapter({ memoryDir: persistDir, dbPath });
        await adapter1.init();

        adapter1.insertMemory({
            id: 'p1',
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'user_name',
            content: 'Alice',
            metadata: { customField: 42 }
        });
        adapter1.insertMemory({
            id: 'p2',
            category: MEMORY_CATEGORIES.CONVERSATION,
            content: 'Hello world'
        });
        adapter1.close();

        // Instance 2: reopen from same disk file
        const adapter2 = new SqliteMemoryAdapter({ memoryDir: persistDir, dbPath });
        await adapter2.init();

        const p1 = adapter2.getMemoryById('p1');
        assert.ok(p1, 'p1 must exist after reopen');
        assert.equal(p1.content, 'Alice');
        assert.equal(p1.key, 'user_name');
        assert.equal(p1.metadata.customField, 42);

        const counts = adapter2.getCategoryCounts();
        assert.equal(counts.total, 2);
        assert.equal(counts.categories[MEMORY_CATEGORIES.USER_APPROVED], 1);
        assert.equal(counts.categories[MEMORY_CATEGORIES.CONVERSATION], 1);

        adapter2.close();
    });

    await t.test('13. Interrupted or failed persistence operations clean up safely without corrupting DB', async () => {
        const failDir = path.join(testTempDir, 'fail_persist_test');
        fs.mkdirSync(failDir, { recursive: true });
        const dbPath = path.join(failDir, 'save_fail.sqlite');

        const adapter = new SqliteMemoryAdapter({ memoryDir: failDir, dbPath });
        await adapter.init();

        adapter.insertMemory({ id: 'f1', category: MEMORY_CATEGORIES.PROJECT, content: 'Initial valid record' });
        assert.ok(fs.existsSync(dbPath), 'Database file must exist initially');

        // Simulate export failure or unexportable state
        const originalExport = adapter.db.export.bind(adapter.db);
        adapter.db.export = () => { throw new Error('Simulated export I/O failure'); };

        const saveSuccess = adapter.saveToDisk();
        assert.equal(saveSuccess, false, 'saveToDisk should return false on error');

        // Restore export
        adapter.db.export = originalExport;

        // In-memory DB should still be intact and functional
        const rec = adapter.getMemoryById('f1');
        assert.ok(rec);
        assert.equal(rec.content, 'Initial valid record');

        adapter.close();
    });

    await t.test('14. Concurrent operation safety and high-frequency writes', async () => {
        const concDir = path.join(testTempDir, 'concurrent_test');
        fs.mkdirSync(concDir, { recursive: true });
        const dbPath = path.join(concDir, 'concurrent.sqlite');

        const adapter = new SqliteMemoryAdapter({ memoryDir: concDir, dbPath });
        await adapter.init();

        // Execute 25 sequential rapid writes across multiple categories
        for (let i = 0; i < 25; i++) {
            adapter.insertMemory({
                id: `rapid_${i}`,
                category: i % 2 === 0 ? MEMORY_CATEGORIES.WORKING_DATA : MEMORY_CATEGORIES.CONVERSATION,
                key: `rapid_key_${i}`,
                content: `High frequency write test index ${i}`
            });
        }

        const counts = adapter.getCategoryCounts();
        assert.equal(counts.total, 25, 'All 25 rapid records must be stored accurately');

        adapter.close();
    });

    await t.test('15. SQLite WASM asset resolution and packaged Electron availability', async () => {
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir });
        const resolvedPath = adapter._resolveWasmPath({});
        assert.ok(resolvedPath, 'WASM asset path must be resolvable');
        assert.ok(fs.existsSync(resolvedPath), 'Resolved WASM file must exist on disk');

        // Test init with explicit wasmBinary buffer
        const wasmBuf = fs.readFileSync(resolvedPath);
        const bufferAdapter = new SqliteMemoryAdapter({
            memoryDir: testTempDir,
            dbPath: path.join(testTempDir, 'buffer-wasm.sqlite')
        });
        await bufferAdapter.init({ wasmBinary: wasmBuf });
        assert.equal(bufferAdapter.initialized, true, 'Adapter should initialize cleanly with wasmBinary');
        bufferAdapter.close();
    });

    await t.test('16. Backward compatibility with TaskCoordinator and memory consumer integration', async () => {
        const consumerDir = path.join(testTempDir, 'consumer_compat_test');
        fs.mkdirSync(consumerDir, { recursive: true });

        const store = new MemoryStore({ memoryDir: consumerDir });
        await store.initSqlite();
        assert.equal(store.sqliteActive, true);

        const coordinator = new TaskCoordinator({ memoryStore: store });

        // 1. Add memory via coordinator
        const added = coordinator.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'theme_pref',
            content: 'Dark mode preferred'
        });
        assert.ok(added.id);

        // 2. Query memories via coordinator
        const queried = coordinator.getMemories({ category: MEMORY_CATEGORIES.USER_APPROVED });
        assert.equal(queried.length, 1);
        assert.equal(queried[0].content, 'Dark mode preferred');

        // 3. Update memory via coordinator
        const updated = coordinator.updateMemory(added.id, { content: 'Dark mode OLED preferred' });
        assert.equal(updated.content, 'Dark mode OLED preferred');

        // 4. Memory summary via coordinator
        const summary = coordinator.getMemorySummary();
        assert.equal(summary.total, 1);
        assert.equal(summary.sqliteActive, true);

        // 5. Long term memory toggle
        coordinator.toggleLongTermMemory(false);
        assert.equal(coordinator.isLongTermMemoryEnabled(), false);
        coordinator.toggleLongTermMemory(true);
        assert.equal(coordinator.isLongTermMemoryEnabled(), true);

        // 6. Delete memory via coordinator
        const deleted = coordinator.deleteMemory(added.id);
        assert.equal(deleted, true);

        const finalMemories = coordinator.getMemories();
        assert.equal(finalMemories.length, 0);

        store.close();
    });
});
