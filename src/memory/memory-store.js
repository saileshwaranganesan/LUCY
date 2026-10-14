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
    MEMORY_SOURCES,
    redactSecrets,
    hasSecretLikeContent
} = require('./memory-constants.js');

class MemoryStore {
    constructor(options = {}) {
        this.memoryDir = options.memoryDir || path.resolve(__dirname, '../../data/memory');
        this.filePath = path.join(this.memoryDir, 'memory-store.json');
        this.longTermEnabled = options.longTermEnabled !== false;
        this.sqliteAdapter = options.sqliteAdapter || null;
        this.sqliteActive = Boolean(this.sqliteAdapter && this.sqliteAdapter.initialized);
        this.migrationReport = null;
        this.memories = [];
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
            this.sqliteActive = true;
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
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.memories = Array.isArray(data.memories) ? data.memories : [];
                if (typeof data.longTermEnabled === 'boolean') {
                    this.longTermEnabled = data.longTermEnabled;
                }
            } else {
                this.memories = [];
            }
            this.loaded = true;
            this.purgeExpired();
        } catch (err) {
            console.error('Failed to load memory store from disk:', err.message);
            this.memories = [];
            this.loaded = true;
        }
    }

    save() {
        try {
            this._ensureDir();
            const payload = {
                version: 2,
                updatedAt: new Date().toISOString(),
                longTermEnabled: this.longTermEnabled,
                memories: this.memories
            };
            const tempPath = `${this.filePath}.tmp_${Date.now()}`;
            fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tempPath, this.filePath);
            return true;
        } catch (err) {
            console.error('Failed to save memory store to disk:', err.message);
            return false;
        }
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

        // Check for conflicting memory with same key in user_approved
        let conflictDetected = false;
        let existingId = null;
        if (key && (category === MEMORY_CATEGORIES.USER_APPROVED || category === MEMORY_CATEGORIES.PROJECT)) {
            const existing = this.memories.find((m) => m.category === category && m.key === key && m.status !== 'deleted');
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
            key: key.trim().toLowerCase(),
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
            metadata: { ...metadata, conflictDetected, previousId: existingId }
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
            status = 'active'
        } = opts;

        let pool = this.memories.filter((m) => {
            if (status && m.status !== status && m.status !== 'conflict') return false;
            if (category && m.category !== category) return false;
            // Respect disabled long-term memory
            if (!this.longTermEnabled && m.category === MEMORY_CATEGORIES.USER_APPROVED) return false;
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
    MEMORY_SOURCES,
    MemoryStore,
    redactSecrets,
    hasSecretLikeContent
};
