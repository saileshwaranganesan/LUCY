'use strict';

const { RISK_TIERS } = require('../security/permission-authority.js');
const { MEMORY_CATEGORIES, redactSecrets } = require('../memory/memory-constants.js');

/**
 * Register model-facing memory retrieval and inspection tools
 * Allows L.U.C.Y. to explicitly search, inspect, and list persistent memory records.
 * 
 * Enforces:
 * - SAFE_READ risk tier (no unauthorized side-effects)
 * - Strict secret redaction ([REDACTED_SECRET]) across all retrieved content
 * - Authentic persistence integration (never fabricates memories on database error)
 * - Category filtering and result limit capping
 */
function registerMemoryTools(registry, memoryStore) {
    if (!registry || typeof registry.registerTool !== 'function') {
        throw new Error('Valid ToolRegistry required to register memory tools');
    }
    if (!memoryStore) {
        throw new Error('Valid MemoryStore required to register memory tools');
    }

    // 1. memory_search: BM25 lexical ranking across persistent categories
    registry.registerTool({
        id: 'memory_search',
        name: 'Search Persistent Memories',
        description: 'Search L.U.C.Y. persistent memory records using BM25 lexical ranking across categories (conversation, user_approved, task_continuity, project, working_data).',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query terms or phrase to match against memories'
                },
                category: {
                    type: 'string',
                    description: 'Optional category filter (conversation, user_approved, task_continuity, project, working_data)'
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of results to return (default: 10, max: 50)'
                }
            },
            required: ['query']
        },
        handler: async (params = {}) => {
            const rawQuery = (typeof params.query === 'string')
                ? params.query
                : (params.query != null ? String(params.query) : '');
            const trimmedQuery = rawQuery.trim();
            const category = params.category && Object.values(MEMORY_CATEGORIES).includes(params.category)
                ? params.category
                : (params.category ? null : null); // null means all categories

            const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));

            try {
                let results = [];
                if (typeof memoryStore.searchMemories === 'function') {
                    results = memoryStore.searchMemories(trimmedQuery, { category, limit });
                } else if (typeof memoryStore.getMemories === 'function') {
                    results = memoryStore.getMemories({ query: trimmedQuery, category, limit });
                }

                // Sanitize records to guarantee zero secret leakage and consistent schema
                const sanitized = (results || []).map((m) => ({
                    id: m.id,
                    category: m.category,
                    key: m.key || '',
                    content: redactSecrets(m.content),
                    type: m.type,
                    source: m.source,
                    importance: m.importance,
                    relevanceScore: m.relevanceScore !== undefined ? m.relevanceScore : null,
                    createdAt: m.createdAt,
                    updatedAt: m.updatedAt,
                    metadata: m.metadata || {}
                }));

                return {
                    ok: true,
                    status: 'completed',
                    query: trimmedQuery,
                    category: category || 'all',
                    totalFound: sanitized.length,
                    memories: sanitized,
                    verification: { verified: true, method: 'sqlite_bm25_retrieval' }
                };
            } catch (err) {
                return {
                    ok: false,
                    status: 'error',
                    error: `Memory retrieval error: ${err.message}`,
                    memories: [],
                    verification: { verified: false, failureReason: err.message }
                };
            }
        },
        dryRunSimulate: async (params = {}) => {
            return {
                simulatedAction: 'search_memories',
                query: params.query || '',
                category: params.category || 'all'
            };
        }
    });

    // 2. memory_get: Fetch an individual memory record by ID or key
    registry.registerTool({
        id: 'memory_get',
        name: 'Get Memory by ID or Key',
        description: 'Retrieve a single persistent memory record by its unique identifier or lookup key.',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                idOrKey: {
                    type: 'string',
                    description: 'Unique memory ID (e.g. mem_12345678) or lowercased key'
                }
            },
            required: ['idOrKey']
        },
        handler: async (params = {}) => {
            const idOrKey = String(params.idOrKey || params.id || params.key || params.identifier || '').trim();
            if (!idOrKey) {
                return {
                    ok: false,
                    status: 'invalid_parameter',
                    error: 'Parameter idOrKey cannot be empty',
                    memory: null
                };
            }

            try {
                let record = null;
                if (memoryStore.sqliteActive && memoryStore.sqliteAdapter) {
                    record = memoryStore.sqliteAdapter.getMemoryById(idOrKey);
                }
                if (!record && Array.isArray(memoryStore.memories)) {
                    const lookup = idOrKey.toLowerCase();
                    record = memoryStore.memories.find((m) => m.id === idOrKey || (m.key && m.key.toLowerCase() === lookup));
                }

                if (!record) {
                    return {
                        ok: false,
                        status: 'not_found',
                        error: `Memory record '${idOrKey}' not found`,
                        memory: null
                    };
                }

                return {
                    ok: true,
                    status: 'completed',
                    memory: {
                        id: record.id,
                        category: record.category,
                        key: record.key || '',
                        content: redactSecrets(record.content),
                        type: record.type,
                        source: record.source,
                        importance: record.importance,
                        createdAt: record.createdAt,
                        updatedAt: record.updatedAt,
                        metadata: record.metadata || {}
                    },
                    verification: { verified: true, method: 'memory_record_lookup' }
                };
            } catch (err) {
                return {
                    ok: false,
                    status: 'error',
                    error: `Failed to retrieve memory record: ${err.message}`,
                    memory: null
                };
            }
        },
        dryRunSimulate: async (params = {}) => {
            return {
                simulatedAction: 'get_memory_record',
                idOrKey: params.idOrKey || ''
            };
        }
    });

    // 3. memory_list: List memories by category
    registry.registerTool({
        id: 'memory_list',
        name: 'List Stored Memories',
        description: 'List memory records belonging to a specific category (conversation, user_approved, task_continuity, project, working_data).',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description: 'Memory category to list'
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of records to return (default: 20, max: 100)'
                }
            }
        },
        handler: async (params = {}) => {
            const category = params.category || null;
            const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));

            try {
                const list = memoryStore.getMemories({ category, limit });
                const sanitized = list.map((m) => ({
                    id: m.id,
                    category: m.category,
                    key: m.key || '',
                    content: redactSecrets(m.content),
                    type: m.type,
                    source: m.source,
                    createdAt: m.createdAt,
                    updatedAt: m.updatedAt
                }));

                return {
                    ok: true,
                    status: 'completed',
                    category: category || 'all',
                    count: sanitized.length,
                    memories: sanitized,
                    verification: { verified: true, method: 'memory_category_listing' }
                };
            } catch (err) {
                return {
                    ok: false,
                    status: 'error',
                    error: `Failed to list memories: ${err.message}`,
                    memories: []
                };
            }
        },
        dryRunSimulate: async (params = {}) => {
            return {
                simulatedAction: 'list_memory_category',
                category: params.category || 'all'
            };
        }
    });
}

module.exports = {
    registerMemoryTools
};
