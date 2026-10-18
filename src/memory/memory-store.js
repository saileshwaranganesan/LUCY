'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { rankMemoryDocuments } = require('./lexical-retriever.js');
const { SqliteMemoryAdapter } = require('./sqlite-adapter.js');
const { MemoryMigrator } = require('./memory-migrator.js');

const {
    MEMORY_CATEGORIES,
    MEMORY_TYPES,
    PROJECT_STAGES,
    MEMORY_SOURCES,
    normalizeProjectKey,
    redactSecrets,
    hasSecretLikeContent,
    assertStorageIsolation
} = require('./memory-constants.js');

class MemoryStore {
    constructor(options = {}) {
        this.memoryDir = assertStorageIsolation('MemoryStore', options, ['memoryDir', 'storeDir']);
        this.filePath = options.storagePath || path.join(this.memoryDir, 'memory-store.json');
        this.longTermEnabled = options.longTermEnabled !== false;
        this.sqliteAdapter = options.sqliteAdapter || null;
        this.sqliteActive = Boolean(this.sqliteAdapter && this.sqliteAdapter.initialized);
        this.migrationReport = null;
        this.memories = [];
        this.projectSnapshots = new Map();
        this.corruptBackupPath = null;
        this.loadFailed = false;
        this.loaded = false;

        this._ensureDir();
        this.load();
    }

    async initSqlite() {
        if (this.sqliteActive) return true;
        try {
            if (!this.sqliteAdapter) {
                this.sqliteAdapter = new SqliteMemoryAdapter({ memoryDir: this.memoryDir });
            }
            await this.sqliteAdapter.init();

            // Check if migration is needed from JSON
            if (fs.existsSync(this.filePath)) {
                const alreadyMigrated = this.sqliteAdapter.getMetadata('migrated_from_json') === 'true';
                if (!alreadyMigrated) {
                    const migResult = await MemoryMigrator.migrate({
                        memoryDir: this.memoryDir,
                        jsonPath: this.filePath,
                        sqliteAdapter: this.sqliteAdapter
                    });
                    this.migrationReport = migResult;
                }
            }

            // Sync memories from SQLite
            const all = this.sqliteAdapter.getAllMemories();
            if (Array.isArray(all)) {
                this.memories = all;
            }

            // Sync project snapshots from SQLite
            try {
                const snapshots = this.sqliteAdapter.listProjectSnapshots();
                if (Array.isArray(snapshots)) {
                    for (const s of snapshots) {
                        if (s && s.projectId) {
                            this.projectSnapshots.set(s.projectId, s);
                        }
                    }
                }
            } catch {}

            this.sqliteActive = true;
            this._cleanupOrphanedTempFiles();
            return true;
        } catch (err) {
            console.warn('[MemoryStore] SQLite initialization failed, falling back to JSON store:', err.message);
            this.sqliteActive = false;
            return false;
        }
    }

    _ensureDir() {
        if (!fs.existsSync(this.memoryDir)) {
            fs.mkdirSync(this.memoryDir, { recursive: true });
        }
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                let data = null;
                try {
                    data = JSON.parse(raw);
                } catch (parseErr) {
                    console.error('Failed to parse memory store JSON, backing up corrupted file to preserve data:', parseErr.message);
                    const corruptBackup = `${this.filePath}.corrupt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    try {
                        fs.copyFileSync(this.filePath, corruptBackup);
                        this.corruptBackupPath = corruptBackup;
                    } catch {}
                    this.loadFailed = true;
                    this.memories = [];
                    this.loaded = true;
                    return;
                }

                this.memories = Array.isArray(data.memories) ? data.memories : [];
                if (Array.isArray(data.projectSnapshots)) {
                    for (const s of data.projectSnapshots) {
                        if (s && s.projectId) {
                            this.projectSnapshots.set(s.projectId, s);
                        }
                    }
                }
                if (typeof data.longTermEnabled === 'boolean') {
                    this.longTermEnabled = data.longTermEnabled;
                }
                this.loadFailed = false;
            } else {
                this.memories = [];
            }
            this.loaded = true;
            this.purgeExpired();
            this._cleanupOrphanedTempFiles();
        } catch (err) {
            console.error('Failed to load memory store from disk:', err.message);
            this.memories = [];
            this.loaded = true;
        }
    }

    save() {
        if (this.loadFailed) {
            console.warn('[MemoryStore] Skipping save to prevent overwriting corrupted store that has not been recovered.');
            return false;
        }
        let tempPath = null;
        let success = false;
        try {
            this._ensureDir();
            const payload = {
                version: 2,
                updatedAt: new Date().toISOString(),
                longTermEnabled: this.longTermEnabled,
                memories: this.memories,
                projectSnapshots: Array.from(this.projectSnapshots.values())
            };
            tempPath = `${this.filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tempPath, this.filePath);
            success = true;
            return true;
        } catch (err) {
            console.error('Failed to save memory store to disk:', err.message);
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
            const dir = this.memoryDir || path.dirname(this.filePath);
            if (!fs.existsSync(dir)) return;
            const base = path.basename(this.filePath);
            const prefix = `${base}.tmp_`;
            const files = fs.readdirSync(dir);
            const now = Date.now();
            for (const file of files) {
                if (file.startsWith(prefix)) {
                    const fullPath = path.join(dir, file);
                    try {
                        const stat = fs.statSync(fullPath);
                        if (now - stat.mtimeMs > 60000) {
                            fs.unlinkSync(fullPath);
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }

    isLongTermMemoryEnabled() {
        return this.longTermEnabled;
    }

    setLongTermMemoryEnabled(enabled) {
        this.longTermEnabled = Boolean(enabled);
        this.save();
        return this.longTermEnabled;
    }

    /**
     * Add a memory record.
     * @param {Object} entry 
     * @returns {Object} Added memory entry
     */
    addMemory({
        category = MEMORY_CATEGORIES.WORKING_DATA,
        key = '',
        content = '',
        type = MEMORY_TYPES.CONFIRMED_FACT,
        source = MEMORY_SOURCES.USER_EXPLICIT,
        tags = [],
        ttlMs = null,
        importance = 1,
        metadata = {}
    }) {
        if (!content || typeof content !== 'string' || !content.trim()) {
            throw new Error('Memory content cannot be empty');
        }

        if (!Object.values(MEMORY_CATEGORIES).includes(category)) {
            throw new Error(`Invalid memory category: ${category}`);
        }

        // Long-term memory toggle check
        if (category === MEMORY_CATEGORIES.USER_APPROVED && !this.longTermEnabled) {
            return {
                ok: false,
                rejected: true,
                reason: 'Long-term memory is currently disabled by user'
            };
        }

        // Indirect prompt injection defense:
        // Untrusted external sources (web scrape, external files) cannot write to USER_APPROVED directly.
        if (category === MEMORY_CATEGORIES.USER_APPROVED && source === MEMORY_SOURCES.UNTRUSTED_EXTERNAL) {
            throw new Error('Security Violation: Untrusted external content cannot be written directly into user-approved memory without explicit user approval.');
        }

        // Secret protection: Redact API keys / credentials before storage
        const cleanContent = redactSecrets(content.trim());
        const cleanKey = key ? key.trim().toLowerCase() : '';
        const reqProjectId = (metadata && metadata.projectId) ? String(metadata.projectId).trim().toLowerCase() : '';

        // Deduplication Check (Section 4 & Acceptance Criterion 6)
        // If an active memory with identical content already exists in the same category (and same key/projectId),
        // update its timestamp and observation frequency rather than creating redundant duplicates.
        const duplicate = this.memories.find((m) => {
            if (m.status !== 'active') return false;
            if (m.category !== category) return false;
            if (m.content !== cleanContent) return false;

            const mProj = (m.metadata && m.metadata.projectId) ? String(m.metadata.projectId).trim().toLowerCase() : '';
            if (reqProjectId !== mProj) return false;

            if (cleanKey && m.key && cleanKey !== m.key) return false;
            return true;
        });

        if (duplicate) {
            const now = new Date().toISOString();
            duplicate.updatedAt = now;
            duplicate.importance = Math.max(duplicate.importance, Math.max(1, Math.min(5, Number(importance) || 1)));
            if (!duplicate.metadata) duplicate.metadata = {};
            duplicate.metadata.occurrenceCount = (duplicate.metadata.occurrenceCount || 1) + 1;
            duplicate.metadata.lastObservedAt = now;
            if (metadata && typeof metadata === 'object') {
                duplicate.metadata = { ...duplicate.metadata, ...metadata };
            }
            this.save();
            if (this.sqliteActive && this.sqliteAdapter) {
                try {
                    this.sqliteAdapter.updateMemory(duplicate.id, {
                        importance: duplicate.importance,
                        metadata: duplicate.metadata
                    });
                } catch (err) {
                    console.warn('[MemoryStore] Failed to update deduplicated memory in SQLite:', err.message);
                }
            }
            return { ...duplicate, deduplicated: true };
        }

        // Check for conflicting memory with same key in user_approved or project
        let conflictDetected = false;
        let existingId = null;
        if (cleanKey && (category === MEMORY_CATEGORIES.USER_APPROVED || category === MEMORY_CATEGORIES.PROJECT)) {
            const existing = this.memories.find((m) => m.category === category && m.key === cleanKey && m.status !== 'deleted' && m.status !== 'superseded');
            if (existing) {
                if (existing.content !== cleanContent) {
                    conflictDetected = true;
                    existing.hasConflict = true;
                    existing.conflictWith = cleanContent;
                }
                existingId = existing.id;
            }
        }

        const now = new Date().toISOString();
        const memoryRecord = {
            id: `mem_${randomUUID().slice(0, 8)}`,
            category,
            key: cleanKey,
            content: cleanContent,
            type,
            source,
            tags: Array.isArray(tags) ? tags : [],
            importance: Math.max(1, Math.min(5, Number(importance) || 1)),
            status: conflictDetected ? 'conflict' : 'active',
            createdAt: now,
            updatedAt: now,
            expiresAt: (category === MEMORY_CATEGORIES.WORKING_DATA && ttlMs)
                ? new Date(Date.now() + Number(ttlMs)).toISOString()
                : null,
            metadata: { ...metadata, conflictDetected, previousId: existingId, occurrenceCount: 1 }
        };

        this.memories.push(memoryRecord);
        this.save();
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.insertMemory(memoryRecord);
            } catch (err) {
                console.warn('[MemoryStore] Failed to write memory to SQLite adapter:', err.message);
            }
        }
        return memoryRecord;
    }

    /**
     * Retrieve memories matching category and optional lexical query.
     */
    getMemories(options = {}) {
        this.purgeExpired();
        const opts = typeof options === 'string' ? { category: options } : (options || {});
        const {
            category = null,
            query = '',
            limit = 20,
            includeExpired = false,
            status = 'active',
            includeSuperseded = false,
            projectId = null,
            includePreferences = false
        } = opts;

        let pool = this.memories.filter((m) => {
            if (!includeSuperseded && (m.status === 'superseded' || m.type === MEMORY_TYPES.SUPERSEDED)) return false;
            if (status && m.status !== status && m.status !== 'conflict' && (!includeSuperseded || m.status !== 'superseded')) return false;
            if (category && m.category !== category) return false;
            // Respect disabled long-term memory
            if (!this.longTermEnabled && m.category === MEMORY_CATEGORIES.USER_APPROVED) return false;

            if (projectId) {
                const norm = String(projectId).trim().toLowerCase();
                const matchesProject = (m.metadata && m.metadata.projectId && String(m.metadata.projectId).toLowerCase() === norm) ||
                    (m.key && m.key.toLowerCase().includes(norm)) ||
                    (m.tags && Array.isArray(m.tags) && m.tags.some((t) => String(t).toLowerCase() === norm));
                if (!matchesProject) {
                    if (includePreferences && (m.category === MEMORY_CATEGORIES.USER_APPROVED || m.type === MEMORY_TYPES.CONFIRMED_FACT)) {
                        return true;
                    }
                    return false;
                }
            }

            return true;
        });

        if (query && query.trim()) {
            return rankMemoryDocuments(pool, query, { limit });
        }

        // Default sort by updatedAt descending
        pool.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return pool.slice(0, limit);
    }

    /**
     * Search memories using BM25 lexical ranking across categories.
     * Delegates to SQLite database when active; falls back to in-memory pool.
     */
    searchMemories(query, options = {}) {
        this.purgeExpired();
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                const results = this.sqliteAdapter.searchMemories(query, options);
                if (!this.longTermEnabled) {
                    return results.filter((m) => m.category !== MEMORY_CATEGORIES.USER_APPROVED);
                }
                return results;
            } catch (err) {
                console.warn('[MemoryStore] SQLite search failed, falling back to memory pool:', err.message);
            }
        }
        return this.getMemories({ ...options, query });
    }

    /**
     * Update an existing memory entry by ID or key.
     */
    updateMemory(idOrKey, updates = {}) {
        const lookup = String(idOrKey).trim().toLowerCase();
        const memory = this.memories.find((m) => m.id === idOrKey || m.key === lookup);
        if (!memory) {
            throw new Error(`Memory record ${idOrKey} not found`);
        }

        const updateObj = typeof updates === 'string' ? { content: updates } : (updates || {});

        if (updateObj.content) {
            memory.content = redactSecrets(updateObj.content.trim());
        }
        if (updateObj.type && Object.values(MEMORY_TYPES).includes(updateObj.type)) {
            memory.type = updateObj.type;
        }
        if (updateObj.tags && Array.isArray(updateObj.tags)) {
            memory.tags = updateObj.tags;
        }
        if (updateObj.status) {
            memory.status = updateObj.status;
        }
        if (updateObj.key) {
            memory.key = updateObj.key.trim().toLowerCase();
        }
        if (updateObj.importance !== undefined && updateObj.importance !== null) {
            memory.importance = Math.max(1, Math.min(5, Number(updateObj.importance) || 1));
        }
        if (updateObj.metadata && typeof updateObj.metadata === 'object') {
            memory.metadata = { ...(memory.metadata || {}), ...updateObj.metadata };
        }

        memory.updatedAt = new Date().toISOString();
        this.save();
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.updateMemory(memory.id, updateObj);
            } catch (err) {
                console.warn('[MemoryStore] Failed to update memory in SQLite adapter:', err.message);
            }
        }
        return memory;
    }

    /**
     * Delete a memory record by ID or key.
     * Prioritizes exact ID matching; only falls back to non-empty key matching.
     */
    deleteMemory(idOrKey) {
        if (!idOrKey || typeof idOrKey !== 'string' || !idOrKey.trim()) {
            return false;
        }
        const targetId = idOrKey.trim();
        const lookupKey = targetId.toLowerCase();
        const removed = [];

        // 1. Prioritize exact ID match
        this.memories = this.memories.filter((m) => {
            if (m.id === targetId) {
                removed.push(m);
                return false;
            }
            return true;
        });

        // 2. Only if not matched by ID and lookupKey is non-empty, match by key (never match empty keys)
        if (removed.length === 0 && lookupKey.length > 0) {
            this.memories = this.memories.filter((m) => {
                if (m.key && m.key === lookupKey) {
                    removed.push(m);
                    return false;
                }
                return true;
            });
        }

        if (removed.length === 0) {
            return false;
        }

        this.save();
        if (this.sqliteActive && this.sqliteAdapter) {
            for (const item of removed) {
                try {
                    this.sqliteAdapter.deleteMemory(item.id);
                } catch (err) {
                    console.warn('[MemoryStore] Failed to delete memory from SQLite adapter:', err.message);
                }
            }
        }
        return true;
    }

    /**
     * Clear all memories in a given category.
     */
    clearCategory(category) {
        if (!Object.values(MEMORY_CATEGORIES).includes(category)) {
            throw new Error(`Invalid category: ${category}`);
        }
        const initialCount = this.memories.length;
        this.memories = this.memories.filter((m) => m.category !== category);
        const removed = initialCount - this.memories.length;
        this.save();
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.clearCategory(category);
            } catch (err) {
                console.warn('[MemoryStore] Failed to clear category in SQLite adapter:', err.message);
            }
        }
        return { ok: true, removedCount: removed };
    }

    /**
     * Resolve a memory conflict by choosing the new, previous, or custom content.
     */
    resolveConflict(memoryId, resolutionContent) {
        const memory = this.memories.find((m) => m.id === memoryId);
        if (!memory) {
            throw new Error(`Memory record ${memoryId} not found`);
        }

        memory.content = redactSecrets(resolutionContent.trim());
        memory.status = 'active';
        memory.type = MEMORY_TYPES.CONFIRMED_FACT;
        memory.hasConflict = false;
        delete memory.conflictWith;
        memory.updatedAt = new Date().toISOString();

        this.save();
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.updateMemory(memory.id, {
                    content: memory.content,
                    status: 'active',
                    type: MEMORY_TYPES.CONFIRMED_FACT
                });
            } catch (err) {
                console.warn('[MemoryStore] Failed to update resolved conflict in SQLite adapter:', err.message);
            }
        }
        return memory;
    }

    /**
     * Automatically purge expired temporary working data.
     */
    purgeExpired() {
        const now = Date.now();
        const valid = this.memories.filter((m) => {
            if (m.category === MEMORY_CATEGORIES.WORKING_DATA && m.expiresAt) {
                return new Date(m.expiresAt).getTime() > now;
            }
            return true;
        });

        if (valid.length !== this.memories.length) {
            this.memories = valid;
            this.save();
        }
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.purgeExpired();
            } catch {}
        }
    }

    /**
     * Mark an existing memory (e.g. prior architecture decision or preference)
     * as superseded by a new decision, preserving historical record without active retrieval pollution.
     * @param {string} oldIdOrKey 
     * @param {Object} newEntry 
     * @returns {{ ok: boolean, oldRecord: Object, newRecord: Object }}
     */
    supersedeMemory(oldIdOrKey, newEntry = {}) {
        if (!oldIdOrKey || typeof oldIdOrKey !== 'string') {
            throw new Error('Valid oldIdOrKey required to supersede a memory');
        }
        const lookup = oldIdOrKey.trim().toLowerCase();
        const oldMemory = this.memories.find((m) => m.id === oldIdOrKey || (m.key && m.key.toLowerCase() === lookup));
        if (!oldMemory) {
            throw new Error(`Target memory record to supersede '${oldIdOrKey}' not found`);
        }

        const now = new Date().toISOString();

        // 1. Add the new superseding memory
        const newRecord = this.addMemory({
            category: newEntry.category || oldMemory.category,
            key: newEntry.key || oldMemory.key,
            content: newEntry.content || '',
            type: newEntry.type || MEMORY_TYPES.PROJECT_DECISION,
            source: newEntry.source || MEMORY_SOURCES.USER_EXPLICIT,
            tags: newEntry.tags || oldMemory.tags,
            importance: newEntry.importance || oldMemory.importance,
            metadata: {
                ...(newEntry.metadata || {}),
                supersedes: oldMemory.id,
                projectId: newEntry.projectId || oldMemory.metadata?.projectId || ''
            }
        });

        // 2. Mark the old memory as superseded
        oldMemory.status = 'superseded';
        oldMemory.type = MEMORY_TYPES.SUPERSEDED;
        oldMemory.updatedAt = now;
        if (!oldMemory.metadata) oldMemory.metadata = {};
        oldMemory.metadata.supersededAt = now;
        oldMemory.metadata.supersededBy = newRecord.id;

        this.save();

        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.updateMemory(oldMemory.id, {
                    status: 'superseded',
                    type: MEMORY_TYPES.SUPERSEDED,
                    metadata: oldMemory.metadata
                });
            } catch (err) {
                console.warn('[MemoryStore] Failed to update superseded memory in SQLite:', err.message);
            }
        }

        return {
            ok: true,
            oldRecord: oldMemory,
            newRecord
        };
    }

    /**
     * Save a structured project snapshot for project continuity
     * @param {string} projectId 
     * @param {Object} snapshot 
     */
    saveProjectSnapshot(projectId, snapshot = {}) {
        if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
            throw new Error('Valid projectId is required to save a project snapshot');
        }
        const cleanProjectId = normalizeProjectKey(projectId);
        const now = new Date().toISOString();

        const fullSnapshot = {
            projectId: cleanProjectId,
            objective: snapshot.objective || '',
            architecture: snapshot.architecture || '',
            techStack: snapshot.techStack || '',
            stage: Object.values(PROJECT_STAGES).includes(snapshot.stage) ? snapshot.stage : PROJECT_STAGES.PROPOSED,
            acceptedDecisions: Array.isArray(snapshot.acceptedDecisions) ? snapshot.acceptedDecisions : [],
            rejectedDecisions: Array.isArray(snapshot.rejectedDecisions) ? snapshot.rejectedDecisions : [],
            lastProgress: snapshot.lastProgress || '',
            outstandingTasks: Array.isArray(snapshot.outstandingTasks) ? snapshot.outstandingTasks : [],
            blockers: Array.isArray(snapshot.blockers) ? snapshot.blockers : [],
            docReferences: Array.isArray(snapshot.docReferences) ? snapshot.docReferences : [],
            verifiedStatus: snapshot.verifiedStatus || 'unverified',
            createdAt: snapshot.createdAt || now,
            updatedAt: now
        };

        this.projectSnapshots.set(cleanProjectId, fullSnapshot);

        // Also ensure a corresponding project memory record exists for lexical search
        const contentSummary = `Project [${cleanProjectId}] Objective: ${fullSnapshot.objective}. Architecture: ${fullSnapshot.architecture}. Tech Stack: ${fullSnapshot.techStack}. Stage: ${fullSnapshot.stage}. Decisions: ${fullSnapshot.acceptedDecisions.join('; ')}. Tasks: ${fullSnapshot.outstandingTasks.join('; ')}`;

        const existingMem = this.memories.find((m) => m.category === MEMORY_CATEGORIES.PROJECT && m.key === `snapshot_${cleanProjectId}`);
        if (existingMem) {
            this.updateMemory(existingMem.id, {
                content: contentSummary,
                type: MEMORY_TYPES.PROJECT_SNAPSHOT,
                metadata: { projectId: cleanProjectId, snapshot: fullSnapshot }
            });
        } else {
            this.addMemory({
                category: MEMORY_CATEGORIES.PROJECT,
                key: `snapshot_${cleanProjectId}`,
                content: contentSummary,
                type: MEMORY_TYPES.PROJECT_SNAPSHOT,
                source: MEMORY_SOURCES.USER_EXPLICIT,
                metadata: { projectId: cleanProjectId, snapshot: fullSnapshot }
            });
        }

        this.save();

        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.saveProjectSnapshot(fullSnapshot);
            } catch (err) {
                console.warn('[MemoryStore] Failed to save project snapshot in SQLite:', err.message);
            }
        }

        return fullSnapshot;
    }

    /**
     * Retrieve a project snapshot by project ID
     * @param {string} projectId 
     */
    getProjectSnapshot(projectId) {
        if (!projectId || typeof projectId !== 'string') return null;
        const cleanProjectId = normalizeProjectKey(projectId);

        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                const snap = this.sqliteAdapter.getProjectSnapshot(cleanProjectId);
                if (snap) return snap;
            } catch {}
        }

        if (this.projectSnapshots.has(cleanProjectId)) {
            return this.projectSnapshots.get(cleanProjectId);
        }

        // Fallback to checking memory metadata
        const mem = this.memories.find((m) => m.category === MEMORY_CATEGORIES.PROJECT && m.key === `snapshot_${cleanProjectId}`);
        if (mem && mem.metadata && mem.metadata.snapshot) {
            return mem.metadata.snapshot;
        }

        return null;
    }

    /**
     * List all known projects
     */
    listProjects() {
        const set = new Set();
        for (const pid of this.projectSnapshots.keys()) {
            set.add(pid);
        }
        for (const m of this.memories) {
            if (m.metadata && m.metadata.projectId) {
                set.add(String(m.metadata.projectId).toLowerCase().trim());
            }
            if (m.key && m.key.startsWith('snapshot_')) {
                set.add(m.key.replace(/^snapshot_/, ''));
            }
        }
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                const list = this.sqliteAdapter.listProjectSnapshots();
                for (const s of list) {
                    if (s.projectId) set.add(String(s.projectId).toLowerCase().trim());
                }
            } catch {}
        }
        return Array.from(set).filter(Boolean);
    }

    /**
     * Delete a project snapshot
     * @param {string} projectId 
     */
    deleteProjectSnapshot(projectId) {
        if (!projectId) return false;
        const clean = normalizeProjectKey(projectId);
        this.projectSnapshots.delete(clean);
        this.deleteMemory(`snapshot_${clean}`);
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.deleteProjectSnapshot(clean);
            } catch {}
        }
        this.save();
        return true;
    }

    /**
     * Export memory store into a versioned JSON payload
     */
    exportData() {
        const cleanMemories = this.memories.map((m) => ({
            ...m,
            content: redactSecrets(m.content)
        }));

        const snapshots = [];
        for (const s of this.projectSnapshots.values()) {
            snapshots.push(s);
        }

        return {
            schemaVersion: 2,
            exportedAt: new Date().toISOString(),
            longTermEnabled: this.longTermEnabled,
            summary: this.getSummary(),
            memories: cleanMemories,
            projectSnapshots: snapshots
        };
    }

    /**
     * Import memory data from JSON payload
     * @param {Object} payload 
     * @param {{ merge?: boolean }} options 
     */
    importData(payload = {}, options = {}) {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid import payload: must be an object');
        }
        if (!Array.isArray(payload.memories)) {
            throw new Error('Invalid import payload: missing memories array');
        }

        const merge = Boolean(options.merge);
        const imported = [];

        if (!merge) {
            // Replace completely
            this.memories = [];
            this.projectSnapshots.clear();
            if (this.sqliteActive && this.sqliteAdapter) {
                try {
                    for (const cat of Object.values(MEMORY_CATEGORIES)) {
                        this.sqliteAdapter.clearCategory(cat);
                    }
                } catch {}
            }
        }

        // Import project snapshots if present
        if (Array.isArray(payload.projectSnapshots)) {
            for (const s of payload.projectSnapshots) {
                if (s && s.projectId) {
                    this.saveProjectSnapshot(s.projectId, s);
                }
            }
        }

        for (const item of payload.memories) {
            if (!item || !item.content) continue;
            try {
                const added = this.addMemory({
                    category: item.category || MEMORY_CATEGORIES.WORKING_DATA,
                    key: item.key || '',
                    content: item.content,
                    type: item.type || MEMORY_TYPES.CONFIRMED_FACT,
                    source: item.source || MEMORY_SOURCES.USER_EXPLICIT,
                    tags: item.tags || [],
                    importance: item.importance || 1,
                    metadata: item.metadata || {}
                });
                imported.push(added);
            } catch (err) {
                console.warn('[MemoryStore] Skipped invalid item during import:', err.message);
            }
        }

        if (typeof payload.longTermEnabled === 'boolean') {
            this.longTermEnabled = payload.longTermEnabled;
        }

        this.save();
        return {
            ok: true,
            merge,
            importedCount: imported.length,
            totalCount: this.memories.length
        };
    }

    /**
     * Create an atomic filesystem backup of memory store
     */
    createBackup() {
        this._ensureDir();
        const backupDir = path.join(this.memoryDir, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupJsonPath = path.join(backupDir, `memory-backup-${timestamp}.json`);

        const exportPayload = this.exportData();
        fs.writeFileSync(backupJsonPath, JSON.stringify(exportPayload, null, 2), 'utf8');

        let backupSqlitePath = null;
        if (this.sqliteActive && this.sqliteAdapter && fs.existsSync(this.sqliteAdapter.dbPath)) {
            backupSqlitePath = path.join(backupDir, `memory-db-${timestamp}.sqlite`);
            try {
                fs.copyFileSync(this.sqliteAdapter.dbPath, backupSqlitePath);
            } catch {}
        }

        return {
            ok: true,
            backupPath: backupJsonPath,
            sqliteBackupPath: backupSqlitePath,
            timestamp
        };
    }

    /**
     * Restore from a backup file
     * @param {string} backupFilePath 
     */
    restoreBackup(backupFilePath) {
        if (!backupFilePath || typeof backupFilePath !== 'string' || !fs.existsSync(backupFilePath)) {
            throw new Error(`Backup file not found: ${backupFilePath}`);
        }

        const raw = fs.readFileSync(backupFilePath, 'utf8');
        const payload = JSON.parse(raw);
        return this.importData(payload, { merge: false });
    }

    getSummary() {
        const counts = {};
        for (const cat of Object.values(MEMORY_CATEGORIES)) {
            counts[cat] = 0;
        }
        for (const m of this.memories) {
            counts[m.category] = (counts[m.category] || 0) + 1;
        }
        return {
            total: this.memories.length,
            totalCount: this.memories.length,
            longTermEnabled: this.longTermEnabled,
            categories: counts,
            projectSnapshotsCount: this.projectSnapshots.size,
            sqliteActive: this.sqliteActive
        };
    }

    close() {
        if (this.sqliteActive && this.sqliteAdapter) {
            try {
                this.sqliteAdapter.close();
            } catch (err) {
                console.warn('[MemoryStore] Failed to close SQLite adapter:', err.message);
            }
            this.sqliteActive = false;
        }
        this.save();
    }
}

module.exports = {
    MEMORY_CATEGORIES,
    MEMORY_TYPES,
    PROJECT_STAGES,
    MEMORY_SOURCES,
    normalizeProjectKey,
    MemoryStore,
    redactSecrets,
    hasSecretLikeContent
};
