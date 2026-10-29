'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { MEMORY_CATEGORIES, redactSecrets, assertStorageIsolation } = require('./memory-constants.js');
const { rankMemoryDocuments } = require('./lexical-retriever.js');

/**
 * SqliteMemoryAdapter
 * WebAssembly-powered SQLite database adapter for L.U.C.Y.
 * Leverages sql.js (pure WASM, zero C++ compilation dependencies).
 * Provides disk persistence, transactional integrity, and category indexing.
 */
class SqliteMemoryAdapter {
    constructor(options = {}) {
        this.memoryDir = assertStorageIsolation('SqliteMemoryAdapter', options, ['memoryDir', 'storeDir']);
        this.dbPath = options.dbPath || path.join(this.memoryDir, 'lucy-memory.sqlite');
        this.SQL = null;
        this.db = null;
        this.initialized = false;
        this.corruptBackupPath = null;
    }

    _resolveWasmPath(options = {}) {
        if (options.wasmPath && fs.existsSync(options.wasmPath)) {
            return options.wasmPath;
        }
        if (process.resourcesPath) {
            const unpackedCandidate = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
            if (fs.existsSync(unpackedCandidate)) return unpackedCandidate;
            const resCandidate = path.join(process.resourcesPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
            if (fs.existsSync(resCandidate)) return resCandidate;
        }
        try {
            const resolved = require.resolve('sql.js/dist/sql-wasm.wasm');
            if (fs.existsSync(resolved)) return resolved;
        } catch {}
        const localFallback = path.resolve(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm');
        if (fs.existsSync(localFallback)) return localFallback;
        return null;
    }

    /**
     * Initialize sql.js engine and open or create the SQLite database
     */
    async init(options = {}) {
        if (this.initialized) {
            return this;
        }

        if (!fs.existsSync(this.memoryDir)) {
            fs.mkdirSync(this.memoryDir, { recursive: true });
        }

        const wasmPath = this._resolveWasmPath(options);
        let wasmBinary = options.wasmBinary || undefined;
        if (!wasmBinary && wasmPath && fs.existsSync(wasmPath)) {
            try {
                wasmBinary = fs.readFileSync(wasmPath);
            } catch (err) {
                console.warn('[SqliteMemoryAdapter] Could not read WASM binary directly:', err.message);
            }
        }

        const initOptions = {};
        if (wasmBinary) {
            initOptions.wasmBinary = wasmBinary;
        } else if (wasmPath) {
            initOptions.locateFile = () => wasmPath;
        }

        this.SQL = await initSqlJs(initOptions);

        if (fs.existsSync(this.dbPath)) {
            try {
                const fileBuffer = fs.readFileSync(this.dbPath);
                this.db = new this.SQL.Database(fileBuffer);
                // Sanity check to detect corrupted database headers immediately
                this.db.run('PRAGMA user_version;');
            } catch (err) {
                if (err.code === 'EACCES' || err.code === 'EPERM') {
                    throw new Error(`SQLite database file is inaccessible due to permissions (${err.code}): ${this.dbPath}`);
                }
                console.warn('[SqliteMemoryAdapter] Corrupted DB detected, backing up and creating fresh:', err.message);
                const corruptBackup = `${this.dbPath}.corrupt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                try { fs.renameSync(this.dbPath, corruptBackup); } catch {}
                this.corruptBackupPath = corruptBackup;
                if (this.db) {
                    try { this.db.close(); } catch {}
                }
                this.db = new this.SQL.Database();
            }
        } else {
            this.db = new this.SQL.Database();
        }

        this._createSchema();
        this._cleanupOrphanedTempFiles();
        this.initialized = true;
        return this;
    }

    _createSchema() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                key TEXT,
                content TEXT NOT NULL,
                type TEXT NOT NULL,
                source TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                importance INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT,
                metadata TEXT NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
            CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
            CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
            CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_checkpoints (
                task_id TEXT PRIMARY KEY,
                objective TEXT NOT NULL,
                status TEXT NOT NULL,
                current_step_index INTEGER NOT NULL DEFAULT 0,
                total_steps INTEGER NOT NULL DEFAULT 0,
                steps_json TEXT NOT NULL DEFAULT '[]',
                resumption_state_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_task_checkpoints_status ON task_checkpoints(status);

            CREATE TABLE IF NOT EXISTS project_snapshots (
                project_id TEXT PRIMARY KEY,
                objective TEXT NOT NULL,
                architecture TEXT NOT NULL DEFAULT '',
                tech_stack TEXT NOT NULL DEFAULT '',
                stage TEXT NOT NULL DEFAULT 'proposed',
                snapshot_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_project_snapshots_stage ON project_snapshots(stage);
        `);
    }

    /**
     * Persist current in-memory WebAssembly SQLite database to disk
     */
    saveToDisk() {
        if (!this.db) return false;
        let tempPath = null;
        let success = false;
        try {
            const data = this.db.export();
            if (!data || data.length === 0) {
                throw new Error('Database export produced empty binary payload');
            }
            const buffer = Buffer.from(data);
            tempPath = `${this.dbPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            fs.writeFileSync(tempPath, buffer);
            fs.renameSync(tempPath, this.dbPath);
            success = true;
            return true;
        } catch (err) {
            console.error('[SqliteMemoryAdapter] Failed to save DB to disk:', err.message);
            return false;
        } finally {
            if (!success && tempPath && fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch {}
            }
        }
    }

    /**
     * Safely sweep orphaned .tmp_* files left behind by prior crashes or aborted test writes
     */
    _cleanupOrphanedTempFiles() {
        try {
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) return;
            const base = path.basename(this.dbPath);
            const prefix = `${base}.tmp_`;
            const files = fs.readdirSync(dir);
            const now = Date.now();
            for (const file of files) {
                if (file.startsWith(prefix)) {
                    const fullPath = path.join(dir, file);
                    try {
                        const stat = fs.statSync(fullPath);
                        // Clean files older than 60 seconds to avoid race conditions with active writes
                        if (now - stat.mtimeMs > 60000) {
                            fs.unlinkSync(fullPath);
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }

    /**
     * Insert a memory record into the SQLite database with secret scrubbing
     */
    insertMemory(record, options = { save: true }) {
        if (!this.initialized) throw new Error('Database not initialized');
        if (!record || typeof record !== 'object') {
            throw new Error('Invalid memory record: record must be an object');
        }

        const id = record.id ? String(record.id) : `mem_gen_${Math.random().toString(36).slice(2, 10)}`;
        const category = (record.category && Object.values(MEMORY_CATEGORIES).includes(record.category))
            ? record.category
            : MEMORY_CATEGORIES.WORKING_DATA;
        const rawContent = (record.content !== undefined && record.content !== null)
            ? String(record.content)
            : '';
        const cleanContent = redactSecrets(rawContent.trim());
        const cleanKey = record.key ? String(record.key).trim().toLowerCase() : '';
        const tagsJson = JSON.stringify(Array.isArray(record.tags) ? record.tags : []);
        const metadataJson = JSON.stringify(record.metadata && typeof record.metadata === 'object' ? record.metadata : {});
        const now = new Date().toISOString();

        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO memories (
                id, category, key, content, type, source, tags, importance,
                status, created_at, updated_at, expires_at, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run([
            id,
            category,
            cleanKey,
            cleanContent,
            record.type || 'confirmed_fact',
            record.source || 'user_explicit',
            tagsJson,
            Number(record.importance) || 1,
            record.status || 'active',
            record.createdAt || now,
            record.updatedAt || now,
            record.expiresAt || null,
            metadataJson
        ]);
        stmt.free();

        if (options.save !== false) {
            this.saveToDisk();
        }

        return {
            ...record,
            id,
            category,
            key: cleanKey,
            content: cleanContent
        };
    }

    /**
     * Insert multiple memories in an atomic SQLite transaction
     */
    insertMemoriesBatch(records) {
        if (!this.initialized) throw new Error('Database not initialized');
        if (!Array.isArray(records) || records.length === 0) return [];
        this.db.run('BEGIN TRANSACTION;');
        const inserted = [];
        try {
            for (const rec of records) {
                inserted.push(this.insertMemory(rec, { save: false }));
            }
            this.db.run('COMMIT;');
            this.saveToDisk();
            return inserted;
        } catch (err) {
            try { this.db.run('ROLLBACK;'); } catch {}
            throw err;
        }
    }

    /**
     * Retrieve memories from SQLite matching criteria
     */
    getMemories(options = {}) {
        if (!this.initialized) throw new Error('Database not initialized');
        this.purgeExpired();

        const {
            category = null,
            status = 'active',
            limit = 50,
            offset = 0,
            includeSuperseded = false,
            projectId = null,
            includePreferences = false
        } = options;

        let query = 'SELECT * FROM memories WHERE 1=1';
        const params = [];

        if (status) {
            if (includeSuperseded) {
                query += ' AND (status = ? OR status = "conflict" OR status = "superseded")';
            } else {
                query += ' AND (status = ? OR status = "conflict")';
            }
            params.push(status);
        }

        if (!includeSuperseded) {
            query += ' AND status != "superseded" AND type != "superseded"';
        }

        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }

        query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const stmt = this.db.prepare(query);
        stmt.bind(params);

        let results = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            results.push(this._mapRowToRecord(row));
        }
        stmt.free();

        if (projectId) {
            const norm = String(projectId).trim().toLowerCase();
            results = results.filter((m) => {
                if (m.metadata && m.metadata.projectId && String(m.metadata.projectId).toLowerCase() === norm) return true;
                if (m.key && m.key.toLowerCase().includes(norm)) return true;
                if (m.tags && Array.isArray(m.tags) && m.tags.some((t) => String(t).toLowerCase() === norm)) return true;
                if (includePreferences && (m.category === MEMORY_CATEGORIES.USER_APPROVED || m.type === 'confirmed_fact')) return true;
                return false;
            });
        }

        return results;
    }

    /**
     * Get all memories across all categories (for indexing / migration)
     */
    getAllMemories() {
        if (!this.initialized) throw new Error('Database not initialized');
        this.purgeExpired();

        const stmt = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC');
        const results = [];
        while (stmt.step()) {
            results.push(this._mapRowToRecord(stmt.getAsObject()));
        }
        stmt.free();
        return results;
    }

    /**
     * Search memories with BM25 lexical ranking across categories
     */
    searchMemories(query, options = {}) {
        if (!this.initialized) throw new Error('Database not initialized');
        const {
            category = null,
            status = 'active',
            limit = 20,
            includeSuperseded = false,
            projectId = null,
            includePreferences = false
        } = options;
        const all = this.getAllMemories();
        const pool = all.filter((m) => {
            if (!includeSuperseded && (m.status === 'superseded' || m.type === 'superseded')) return false;
            if (status && m.status !== status && m.status !== 'conflict' && (!includeSuperseded || m.status !== 'superseded')) return false;
            if (category && m.category !== category) return false;
            if (projectId) {
                const norm = String(projectId).trim().toLowerCase();
                const matchesProject = (m.metadata && m.metadata.projectId && String(m.metadata.projectId).toLowerCase() === norm) ||
                    (m.key && m.key.toLowerCase().includes(norm)) ||
                    (m.tags && Array.isArray(m.tags) && m.tags.some((t) => String(t).toLowerCase() === norm));
                if (!matchesProject) {
                    if (includePreferences && (m.category === MEMORY_CATEGORIES.USER_APPROVED || m.type === 'confirmed_fact')) {
                        return true;
                    }
                    return false;
                }
            }
            return true;
        });
        if (!query || !query.trim()) {
            return pool.slice(0, limit);
        }
        return rankMemoryDocuments(pool, query, { limit });
    }

    _mapRowToRecord(row) {
        let tags = [];
        let metadata = {};
        try { tags = JSON.parse(row.tags || '[]'); } catch {}
        try { metadata = JSON.parse(row.metadata || '{}'); } catch {}

        return {
            id: row.id,
            category: row.category,
            key: row.key || '',
            content: row.content,
            type: row.type,
            source: row.source,
            tags,
            importance: row.importance,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            expiresAt: row.expires_at || null,
            metadata
        };
    }

    /**
     * Update an existing memory record by ID or key
     */
    updateMemory(idOrKey, updates = {}) {
        if (!this.initialized) throw new Error('Database not initialized');
        const lookup = String(idOrKey).trim().toLowerCase();

        // Check if exists
        const checkStmt = this.db.prepare('SELECT id, content, type, tags, status, key, metadata FROM memories WHERE id = ? OR key = ? LIMIT 1');
        checkStmt.bind([idOrKey, lookup]);
        if (!checkStmt.step()) {
            checkStmt.free();
            throw new Error(`Memory record ${idOrKey} not found`);
        }
        const existing = checkStmt.getAsObject();
        checkStmt.free();

        const updateObj = typeof updates === 'string' ? { content: updates } : (updates || {});
        const cleanContent = updateObj.content ? redactSecrets(updateObj.content.trim()) : existing.content;
        const newType = updateObj.type || existing.type;
        const newKey = updateObj.key ? updateObj.key.trim().toLowerCase() : existing.key;
        const newStatus = updateObj.status || existing.status;
        const newTags = updateObj.tags ? JSON.stringify(updateObj.tags) : existing.tags;
        let mergedMetadata = {};
        try { mergedMetadata = JSON.parse(existing.metadata || '{}'); } catch {}
        if (updateObj.metadata && typeof updateObj.metadata === 'object') {
            mergedMetadata = { ...mergedMetadata, ...updateObj.metadata };
        }
        const newMetadataJson = JSON.stringify(mergedMetadata);
        const now = new Date().toISOString();

        const updateStmt = this.db.prepare(`
            UPDATE memories
            SET content = ?, type = ?, key = ?, status = ?, tags = ?, metadata = ?, updated_at = ?
            WHERE id = ?
        `);
        updateStmt.run([cleanContent, newType, newKey, newStatus, newTags, newMetadataJson, now, existing.id]);
        updateStmt.free();

        this.saveToDisk();
        return this.getMemoryById(existing.id);
    }

    getMemoryById(id) {
        if (!this.initialized) return null;
        const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ? LIMIT 1');
        stmt.bind([id]);
        let result = null;
        if (stmt.step()) {
            result = this._mapRowToRecord(stmt.getAsObject());
        }
        stmt.free();
        return result;
    }

    /**
     * Delete a memory record by ID or key.
     * Prioritizes exact ID matching; only falls back to non-empty key matching when target is not an explicit ID.
     */
    deleteMemory(idOrKey, options = {}) {
        if (!this.initialized) throw new Error('Database not initialized');
        if (!idOrKey || typeof idOrKey !== 'string' || !idOrKey.trim()) {
            return false;
        }
        const target = idOrKey.trim();
        const isExplicitId = target.startsWith('mem_') || options.exactIdOnly === true;

        // 1. Prioritize exact ID match
        let stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
        stmt.run([target]);
        let deleted = this.db.getRowsModified() > 0;
        stmt.free();

        // 2. Only if not matched by ID, target is NOT an explicit ID, and lookup key is non-empty, match by key (never delete empty keys)
        if (!deleted && !isExplicitId && target.length > 0) {
            stmt = this.db.prepare('DELETE FROM memories WHERE key = ? AND key != ""');
            stmt.run([target.toLowerCase()]);
            deleted = this.db.getRowsModified() > 0;
            stmt.free();
        }

        if (deleted) {
            this.saveToDisk();
        }
        return deleted;
    }

    /**
     * Clear all memories in a given category
     */
    clearCategory(category) {
        if (!this.initialized) throw new Error('Database not initialized');
        const stmt = this.db.prepare('DELETE FROM memories WHERE category = ?');
        stmt.run([category]);
        const count = this.db.getRowsModified();
        stmt.free();
        if (count > 0) {
            this.saveToDisk();
        }
        return { ok: true, removedCount: count };
    }

    /**
     * Get memory counts grouped by category across all 5 standard categories
     */
    getCategoryCounts() {
        if (!this.initialized) throw new Error('Database not initialized');
        this.purgeExpired();

        const counts = {};
        for (const cat of Object.values(MEMORY_CATEGORIES)) {
            counts[cat] = 0;
        }

        const stmt = this.db.prepare('SELECT category, COUNT(*) as count FROM memories GROUP BY category');
        while (stmt.step()) {
            const row = stmt.getAsObject();
            counts[row.category] = Number(row.count) || 0;
        }
        stmt.free();

        let total = 0;
        for (const c of Object.values(counts)) {
            total += c;
        }

        return {
            total,
            categories: counts
        };
    }

    /**
     * Purge expired temporary working data
     */
    purgeExpired() {
        if (!this.db) return 0;
        try {
            const now = new Date().toISOString();
            const stmt = this.db.prepare('DELETE FROM memories WHERE category = ? AND expires_at IS NOT NULL AND expires_at <= ?');
            stmt.run([MEMORY_CATEGORIES.WORKING_DATA, now]);
            const purged = this.db.getRowsModified();
            stmt.free();
            if (purged > 0) {
                this.saveToDisk();
            }
            return purged;
        } catch {
            return 0;
        }
    }

    // Metadata persistence helpers
    getMetadata(key) {
        if (!this.initialized) return null;
        const stmt = this.db.prepare('SELECT value FROM metadata WHERE key = ? LIMIT 1');
        stmt.bind([key]);
        let val = null;
        if (stmt.step()) {
            val = stmt.getAsObject().value;
        }
        stmt.free();
        return val;
    }

    setMetadata(key, value) {
        if (!this.initialized) return false;
        const stmt = this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
        stmt.run([key, String(value)]);
        stmt.free();
        this.saveToDisk();
        return true;
    }

    // Task Checkpoints
    saveTaskCheckpoint(checkpoint) {
        if (!this.initialized) throw new Error('Database not initialized');
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO task_checkpoints (
                task_id, objective, status, current_step_index, total_steps,
                steps_json, resumption_state_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run([
            checkpoint.taskId,
            checkpoint.objective || '',
            checkpoint.status || 'in_progress',
            Number(checkpoint.currentStepIndex) || 0,
            Number(checkpoint.totalSteps) || 0,
            JSON.stringify(checkpoint.steps || []),
            JSON.stringify(checkpoint.resumptionState || {}),
            checkpoint.createdAt || new Date().toISOString(),
            new Date().toISOString()
        ]);
        stmt.free();
        this.saveToDisk();
        return true;
    }

    getTaskCheckpoints(status = null) {
        if (!this.initialized) return [];
        let query = 'SELECT * FROM task_checkpoints';
        const params = [];
        if (status) {
            query += ' WHERE status = ?';
            params.push(status);
        }
        query += ' ORDER BY updated_at DESC';

        const stmt = this.db.prepare(query);
        stmt.bind(params);
        const list = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            list.push({
                taskId: row.task_id,
                objective: row.objective,
                status: row.status,
                currentStepIndex: row.current_step_index,
                totalSteps: row.total_steps,
                steps: JSON.parse(row.steps_json || '[]'),
                resumptionState: JSON.parse(row.resumption_state_json || '{}'),
                createdAt: row.created_at,
                updatedAt: row.updated_at
            });
        }
        stmt.free();
        return list;
    }

    deleteTaskCheckpoint(taskId) {
        if (!this.initialized) return false;
        const stmt = this.db.prepare('DELETE FROM task_checkpoints WHERE task_id = ?');
        stmt.run([taskId]);
        const deleted = this.db.getRowsModified() > 0;
        stmt.free();
        if (deleted) this.saveToDisk();
        return deleted;
    }

    // Project Snapshots Persistence
    saveProjectSnapshot(snapshot) {
        if (!this.initialized) throw new Error('Database not initialized');
        if (!snapshot || typeof snapshot !== 'object' || !snapshot.projectId) {
            throw new Error('Project snapshot must have a valid projectId');
        }
        const projectId = String(snapshot.projectId).trim().toLowerCase();
        const objective = snapshot.objective || '';
        const architecture = snapshot.architecture || '';
        const techStack = snapshot.techStack || '';
        const stage = snapshot.stage || 'proposed';
        const now = new Date().toISOString();
        const snapshotJson = JSON.stringify(snapshot);

        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO project_snapshots (
                project_id, objective, architecture, tech_stack, stage,
                snapshot_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run([
            projectId,
            objective,
            architecture,
            techStack,
            stage,
            snapshotJson,
            snapshot.createdAt || now,
            now
        ]);
        stmt.free();
        this.saveToDisk();
        return { ...snapshot, projectId, updatedAt: now };
    }

    getProjectSnapshot(projectId) {
        if (!this.initialized) return null;
        if (!projectId) return null;
        const stmt = this.db.prepare('SELECT snapshot_json FROM project_snapshots WHERE project_id = ? LIMIT 1');
        stmt.bind([String(projectId).trim().toLowerCase()]);
        let result = null;
        if (stmt.step()) {
            try {
                result = JSON.parse(stmt.getAsObject().snapshot_json);
            } catch {}
        }
        stmt.free();
        return result;
    }

    listProjectSnapshots() {
        if (!this.initialized) return [];
        const stmt = this.db.prepare('SELECT snapshot_json FROM project_snapshots ORDER BY updated_at DESC');
        const results = [];
        while (stmt.step()) {
            try {
                results.push(JSON.parse(stmt.getAsObject().snapshot_json));
            } catch {}
        }
        stmt.free();
        return results;
    }

    deleteProjectSnapshot(projectId) {
        if (!this.initialized) return false;
        if (!projectId) return false;
        const stmt = this.db.prepare('DELETE FROM project_snapshots WHERE project_id = ?');
        stmt.run([String(projectId).trim().toLowerCase()]);
        const deleted = this.db.getRowsModified() > 0;
        stmt.free();
        if (deleted) this.saveToDisk();
        return deleted;
    }

    close() {
        if (this.db) {
            try { this.saveToDisk(); } catch {}
            try { this.db.close(); } catch {}
            this.db = null;
        }
        this.initialized = false;
    }
}

module.exports = {
    SqliteMemoryAdapter
};
