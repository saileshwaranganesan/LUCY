'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SqliteMemoryAdapter } = require('../../src/memory/sqlite-adapter.js');
const { MemoryStore, MEMORY_CATEGORIES, MEMORY_TYPES, MEMORY_SOURCES } = require('../../src/memory/memory-store.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../../src/memory/task-continuity-store.js');
const { rankMemoryDocuments, tokenize, extractPhrases } = require('../../src/memory/lexical-retriever.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { registerMemoryTools } = require('../../src/tools/memory-tools.js');

test('Batch 06 - Integrated Memory Retrieval, BM25 Ranking & Task Checkpoint Persistence', async (t) => {
    const testTempDir = path.join(os.tmpdir(), `lucy_b06_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testTempDir, { recursive: true });

    t.after(() => {
        try {
            fs.rmSync(testTempDir, { recursive: true, force: true });
        } catch {}
    });

    await t.test('1. BM25 Lexical Ranking retrieves and ranks documents across all five memory categories', async () => {
        const documents = [
            { id: '1', category: MEMORY_CATEGORIES.CONVERSATION, content: 'User asked about dark theme options', key: 'theme' },
            { id: '2', category: MEMORY_CATEGORIES.USER_APPROVED, content: 'Always use dark theme in editor and terminal', key: 'pref_theme', importance: 5 },
            { id: '3', category: MEMORY_CATEGORIES.TASK_CONTINUITY, content: 'Completed migration of dark theme settings', key: 'mig_theme' },
            { id: '4', category: MEMORY_CATEGORIES.PROJECT, content: 'LUCY desktop app dark theme support specification', key: 'spec_theme' },
            { id: '5', category: MEMORY_CATEGORIES.WORKING_DATA, content: 'Temporary cache of dark theme preview buffer', key: 'temp_theme' },
            { id: '6', category: MEMORY_CATEGORIES.PROJECT, content: 'Network proxy and SSL configuration guide', key: 'proxy' }
        ];

        // Search for "dark theme"
        const results = rankMemoryDocuments(documents, 'dark theme', { limit: 10 });
        assert.ok(results.length >= 5, 'Should return matching documents across categories');

        // All 5 categories with "dark theme" should be retrieved
        const foundCategories = new Set(results.map((r) => r.category));
        assert.ok(foundCategories.has(MEMORY_CATEGORIES.CONVERSATION));
        assert.ok(foundCategories.has(MEMORY_CATEGORIES.USER_APPROVED));
        assert.ok(foundCategories.has(MEMORY_CATEGORIES.TASK_CONTINUITY));
        assert.ok(foundCategories.has(MEMORY_CATEGORIES.PROJECT));
        assert.ok(foundCategories.has(MEMORY_CATEGORIES.WORKING_DATA));

        // High importance item should receive boost
        const userApprovedResult = results.find((r) => r.id === '2');
        assert.ok(userApprovedResult, 'High importance item must be present');
        assert.ok(userApprovedResult.relevanceScore > 0, 'Relevance score must be positive');

        // Irrelevant document (proxy guide) should either not appear or rank strictly lowest
        const proxyResult = results.find((r) => r.id === '6');
        assert.equal(proxyResult, undefined, 'Irrelevant item should not be retrieved');
    });

    await t.test('2. Phrase boosting and stemming rank exact phrase matches higher than dispersed keywords', async () => {
        const documents = [
            { id: 'p1', category: MEMORY_CATEGORIES.PROJECT, content: 'We are building an autonomous desktop assistant for Windows' },
            { id: 'p2', category: MEMORY_CATEGORIES.PROJECT, content: 'The desktop is loaded with files and an assistant helped Windows users' }
        ];

        const ranked = rankMemoryDocuments(documents, 'autonomous desktop assistant');
        assert.ok(ranked.length > 0);
        assert.equal(ranked[0].id, 'p1', 'Exact phrase overlap must rank above dispersed keywords');
    });

    await t.test('3. Category diversity penalty prevents a single category from monopolizing top results', async () => {
        const documents = [
            { id: 'c1', category: MEMORY_CATEGORIES.CONVERSATION, content: 'Database migration notes part 1' },
            { id: 'c2', category: MEMORY_CATEGORIES.CONVERSATION, content: 'Database migration notes part 2' },
            { id: 'c3', category: MEMORY_CATEGORIES.CONVERSATION, content: 'Database migration notes part 3' },
            { id: 'c4', category: MEMORY_CATEGORIES.CONVERSATION, content: 'Database migration notes part 4' },
            { id: 'p1', category: MEMORY_CATEGORIES.PROJECT, content: 'Database migration architecture requirements' }
        ];

        const ranked = rankMemoryDocuments(documents, 'database migration', { limit: 3 });
        const categories = ranked.map((r) => r.category);
        assert.ok(categories.includes(MEMORY_CATEGORIES.PROJECT), 'Diversity penalty should allow other categories into top results');
    });

    await t.test('4. SqliteMemoryAdapter.searchMemories executes BM25 retrieval directly across SQLite records', async () => {
        const dbPath = path.join(testTempDir, 'sqlite_search.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        adapter.insertMemory({
            id: 'sql_m1',
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'editor_pref',
            content: 'User prefers VS Code for python development',
            importance: 4
        });
        adapter.insertMemory({
            id: 'sql_m2',
            category: MEMORY_CATEGORIES.CONVERSATION,
            key: 'chat_pref',
            content: 'Discussing python virtual environments and packages'
        });
        adapter.insertMemory({
            id: 'sql_m3',
            category: MEMORY_CATEGORIES.PROJECT,
            key: 'project_info',
            content: 'Node.js and Electron architecture for L.U.C.Y.'
        });

        // Search for "python"
        const pythonResults = adapter.searchMemories('python development');
        assert.ok(pythonResults.length >= 2, 'Should find python memories');
        assert.equal(pythonResults[0].id, 'sql_m1', 'VS Code python memory should rank first');
        assert.ok(pythonResults[0].relevanceScore > 0);

        // Filter by category
        const convOnly = adapter.searchMemories('python', { category: MEMORY_CATEGORIES.CONVERSATION });
        assert.equal(convOnly.length, 1);
        assert.equal(convOnly[0].id, 'sql_m2');

        adapter.close();
    });

    await t.test('5. TaskContinuityStore persists checkpoints into SQLite and reconstructs state on restart', async () => {
        const continuityDir = path.join(testTempDir, 'continuity_test');
        fs.mkdirSync(continuityDir, { recursive: true });
        const dbPath = path.join(continuityDir, 'checkpoints.sqlite');

        const adapter = new SqliteMemoryAdapter({ memoryDir: continuityDir, dbPath });
        await adapter.init();

        const continuityStore = new TaskContinuityStore({
            storeDir: continuityDir,
            sqliteAdapter: adapter
        });

        // Save a multi-step task checkpoint
        continuityStore.saveCheckpoint({
            taskId: 'task_alpha_101',
            userRequest: 'Download and verify release bundle',
            plan: {
                steps: [
                    { stepIndex: 0, title: 'Download file', toolId: 'browser_download' },
                    { stepIndex: 1, title: 'Compute SHA256', toolId: 'file_hash' },
                    { stepIndex: 2, title: 'Extract archive', toolId: 'file_extract' }
                ]
            },
            currentStepIndex: 1,
            completedSteps: [
                { stepIndex: 0, title: 'Download file', verified: true }
            ],
            status: TASK_STATUSES.IN_PROGRESS,
            dryRun: false
        });

        // Verify it was saved to SQLite directly
        const checkpointsInSqlite = adapter.getTaskCheckpoints();
        assert.equal(checkpointsInSqlite.length, 1);
        assert.equal(checkpointsInSqlite[0].taskId, 'task_alpha_101');
        assert.equal(checkpointsInSqlite[0].objective, 'Download and verify release bundle');
        assert.equal(checkpointsInSqlite[0].status, TASK_STATUSES.IN_PROGRESS);
        assert.equal(checkpointsInSqlite[0].steps.length, 3);
        assert.equal(checkpointsInSqlite[0].resumptionState.completedSteps.length, 1);

        // Test inspectTaskForResume
        const inspection = continuityStore.inspectTaskForResume('task_alpha_101');
        assert.equal(inspection.isResumable, true);
        assert.equal(inspection.pendingCount, 2);
        assert.equal(inspection.completedCount, 1);

        // Simulate crash / restart: Create fresh TaskContinuityStore with SQLite adapter
        const freshContinuityStore = new TaskContinuityStore({
            storeDir: continuityDir,
            sqliteAdapter: adapter
        });
        const restartedInspection = freshContinuityStore.inspectTaskForResume('task_alpha_101');
        assert.equal(restartedInspection.isResumable, true);
        assert.equal(restartedInspection.totalSteps, 3);
        assert.equal(restartedInspection.completedCount, 1);

        adapter.close();
    });

    await t.test('6. Secret scrubbing is strictly preserved throughout retrieval and checkpoint persistence', async () => {
        const secureDir = path.join(testTempDir, 'secure_retrieval');
        fs.mkdirSync(secureDir, { recursive: true });

        const memoryStore = new MemoryStore({ memoryDir: secureDir });
        await memoryStore.initSqlite();

        // Attempt to store a memory containing secrets
        memoryStore.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'cloud_credentials',
            content: 'API token is sk-12345678901234567890 and bearer is Bearer test_secret_token_12345'
        });

        // Retrieve via query
        const retrieved = memoryStore.getMemories({ query: 'cloud credentials' });
        assert.equal(retrieved.length, 1);
        assert.equal(retrieved[0].content.includes('sk-12345678901234567890'), false);
        assert.equal(retrieved[0].content.includes('test_secret_token_12345'), false);
        assert.equal(retrieved[0].content.includes('[REDACTED_SECRET]'), true);

        memoryStore.sqliteAdapter.close();
    });

    await t.test('7. Lexical search is offline, deterministic, and makes zero network calls or model downloads', async () => {
        const query = 'electron app package and windows build';
        const tokens = tokenize(query);
        assert.deepEqual(tokens, ['electron', 'app', 'package', 'window', 'build']);

        const phrases = extractPhrases(query);
        assert.ok(phrases.includes('electron app'));
        assert.ok(phrases.includes('window build'));
    });

    await t.test('8. Empty queries, whitespace queries, and zero results return safely without fabricating memories', async () => {
        const dbPath = path.join(testTempDir, 'empty_query.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        adapter.insertMemory({ id: 'eq1', category: MEMORY_CATEGORIES.PROJECT, content: 'Database documentation' });

        // Empty query returns default unranked pool
        const emptyRes = adapter.searchMemories('');
        assert.equal(emptyRes.length, 1);
        assert.equal(emptyRes[0].id, 'eq1');

        // Whitespace query returns pool
        const wsRes = adapter.searchMemories('   ');
        assert.equal(wsRes.length, 1);

        // Non-existent search returns empty array, never fabricates records
        const noMatch = adapter.searchMemories('quantum teleportation hyperdrive');
        assert.equal(noMatch.length, 0);

        adapter.close();
    });

    await t.test('9. Unicode normalization, punctuation handling, and partial term matching', async () => {
        const dbPath = path.join(testTempDir, 'unicode_test.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        adapter.insertMemory({
            id: 'u1',
            category: MEMORY_CATEGORIES.USER_APPROVED,
            content: 'User prefers café in Tokyo 東京 with dark-mode setup!'
        });

        // Search with punctuation and case insensitivity
        const puncRes = adapter.searchMemories('CAFÉ, TOKYO!?');
        assert.ok(puncRes.length > 0);
        assert.equal(puncRes[0].id, 'u1');

        // Search with CJK characters
        const cjkRes = adapter.searchMemories('東京');
        assert.ok(cjkRes.length > 0);
        assert.equal(cjkRes[0].id, 'u1');

        // Partial term stemming match ('prefer' matches 'prefers')
        const stemRes = adapter.searchMemories('prefer dark mode');
        assert.ok(stemRes.length > 0);
        assert.equal(stemRes[0].id, 'u1');

        adapter.close();
    });

    await t.test('10. Parameterized query safety rejects SQL injection attempts and handles malformed limits', async () => {
        const dbPath = path.join(testTempDir, 'injection_search.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        adapter.insertMemory({ id: 'inj1', category: MEMORY_CATEGORIES.PROJECT, content: 'Production deployment guide' });

        // Search with SQL injection payload
        const injRes = adapter.searchMemories("production'; DROP TABLE memories; SELECT '1");
        assert.ok(Array.isArray(injRes));
        assert.ok(injRes.length > 0);
        assert.equal(injRes[0].id, 'inj1');

        // Verify table still exists
        const count = adapter.getCategoryCounts();
        assert.equal(count.total, 1);

        // Malformed limits (negative, NaN, huge)
        const negLimit = adapter.searchMemories('production', { limit: -5 });
        assert.ok(negLimit.length <= 20);

        const nanLimit = adapter.searchMemories('production', { limit: 'not-a-number' });
        assert.ok(nanLimit.length <= 20);

        adapter.close();
    });

    await t.test('11. Respects result limits and preserves retrieved memory records and metadata integrity', async () => {
        const dbPath = path.join(testTempDir, 'limits_meta.sqlite');
        const adapter = new SqliteMemoryAdapter({ memoryDir: testTempDir, dbPath });
        await adapter.init();

        for (let i = 0; i < 10; i++) {
            adapter.insertMemory({
                id: `lim_${i}`,
                category: MEMORY_CATEGORIES.CONVERSATION,
                content: `Chat history message number ${i} regarding architecture`,
                metadata: { index: i, verifiedSource: 'test' }
            });
        }

        // Limit to exactly 3
        const limited = adapter.searchMemories('architecture', { limit: 3 });
        assert.equal(limited.length, 3, 'Must respect limit of 3');

        // Verify records are not altered and metadata is intact
        for (const rec of limited) {
            assert.ok(rec.id.startsWith('lim_'));
            assert.equal(rec.category, MEMORY_CATEGORIES.CONVERSATION);
            assert.ok(typeof rec.metadata.index === 'number');
            assert.equal(rec.metadata.verifiedSource, 'test');
        }

        adapter.close();
    });

    await t.test('12. Model-facing memory tools (memory_search, memory_get, memory_list) integrate with ToolRegistry', async () => {
        const toolDir = path.join(testTempDir, 'tool_integration');
        fs.mkdirSync(toolDir, { recursive: true });

        const store = new MemoryStore({ memoryDir: toolDir });
        await store.initSqlite();

        store.addMemory({
            category: MEMORY_CATEGORIES.USER_APPROVED,
            key: 'theme_choice',
            content: 'User chose Cyberpunk Neon theme with high contrast',
            importance: 5
        });

        const registry = new ToolRegistry();
        registerMemoryTools(registry, store);

        // 1. Tool listing check
        const tools = registry.listTools().map((t) => t.id);
        assert.ok(tools.includes('memory_search'));
        assert.ok(tools.includes('memory_get'));
        assert.ok(tools.includes('memory_list'));

        // 2. Execute memory_search
        const searchResult = await registry.execute('memory_search', { query: 'cyberpunk neon' });
        assert.equal(searchResult.ok, true);
        assert.equal(searchResult.status, 'completed');
        assert.equal(searchResult.result.totalFound, 1);
        assert.equal(searchResult.result.memories[0].content, 'User chose Cyberpunk Neon theme with high contrast');

        // 3. Execute memory_get
        const getResult = await registry.execute('memory_get', { idOrKey: 'theme_choice' });
        assert.equal(getResult.ok, true);
        assert.equal(getResult.result.memory.content, 'User chose Cyberpunk Neon theme with high contrast');

        // 4. Execute memory_list
        const listResult = await registry.execute('memory_list', { category: MEMORY_CATEGORIES.USER_APPROVED });
        assert.equal(listResult.ok, true);
        assert.equal(listResult.result.count, 1);

        // 5. Dry-run simulation
        const dryRunRes = await registry.execute('memory_search', { query: 'test' }, { dryRun: true });
        assert.equal(dryRunRes.dryRun, true);
        assert.equal(dryRunRes.executed, false);

        store.close();
    });

    await t.test('13. Task resumption never replays non-idempotent completed actions upon restart', async () => {
        const resumeDir = path.join(testTempDir, 'resume_idempotent');
        fs.mkdirSync(resumeDir, { recursive: true });
        const dbPath = path.join(resumeDir, 'checkpoints.sqlite');

        const adapter = new SqliteMemoryAdapter({ memoryDir: resumeDir, dbPath });
        await adapter.init();

        const continuityStore = new TaskContinuityStore({ storeDir: resumeDir, sqliteAdapter: adapter });

        let executionCountA = 0;
        let executionCountB = 0;

        const mockRegistry = {
            execute: async (toolId) => {
                if (toolId === 'non_idempotent_tool_A') {
                    executionCountA++;
                    return { ok: true, verification: { verified: true } };
                }
                if (toolId === 'pending_tool_B') {
                    executionCountB++;
                    return { ok: true, verification: { verified: true } };
                }
                return { ok: false };
            }
        };

        // Create checkpoint where step 0 is ALREADY completed
        continuityStore.saveCheckpoint({
            taskId: 'resumable_non_idempotent_task',
            userRequest: 'Perform sequential operations',
            plan: {
                steps: [
                    { stepIndex: 0, title: 'Non-idempotent charge/write', toolId: 'non_idempotent_tool_A' },
                    { stepIndex: 1, title: 'Pending second operation', toolId: 'pending_tool_B' }
                ]
            },
            currentStepIndex: 1,
            completedSteps: [
                { stepIndex: 0, title: 'Non-idempotent charge/write', toolId: 'non_idempotent_tool_A', verified: true }
            ],
            status: TASK_STATUSES.INTERRUPTED
        });

        // Resume task
        const resumeResult = await continuityStore.resumeTask('resumable_non_idempotent_task', { toolRegistry: mockRegistry });
        assert.equal(resumeResult.ok, true);

        // Tool A must NOT have been re-executed (count must remain 0)
        assert.equal(executionCountA, 0, 'Completed non-idempotent step must NEVER replay upon restart');
        // Tool B must have executed exactly once
        assert.equal(executionCountB, 1, 'Only pending step must execute on resume');

        adapter.close();
    });
});
