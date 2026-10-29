'use strict';

const { RISK_TIERS } = require('../security/permission-authority.js');
const { MEMORY_CATEGORIES, MEMORY_TYPES, MEMORY_SOURCES, redactSecrets } = require('../memory/memory-constants.js');

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
                },
                projectId: {
                    type: 'string',
                    description: 'Optional project ID to scope search to a specific project context'
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
            const projectId = (typeof params.projectId === 'string' && params.projectId.trim())
                ? params.projectId.trim().toLowerCase()
                : null;

            try {
                let results = [];
                if (typeof memoryStore.searchMemories === 'function') {
                    results = memoryStore.searchMemories(trimmedQuery, { category, limit, projectId });
                } else if (typeof memoryStore.getMemories === 'function') {
                    results = memoryStore.getMemories({ query: trimmedQuery, category, limit, projectId });
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
                },
                projectId: {
                    type: 'string',
                    description: 'Optional project ID to scope listed memories'
                }
            }
        },
        handler: async (params = {}) => {
            const category = params.category || null;
            const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
            const projectId = (typeof params.projectId === 'string' && params.projectId.trim())
                ? params.projectId.trim().toLowerCase()
                : null;

            try {
                const list = memoryStore.getMemories({ category, limit, projectId });
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

    // 4. memory_store: Persist a confirmed fact, preference, instruction, or project note
    registry.registerTool({
        id: 'memory_store',
        name: 'Store Persistent Memory',
        description: 'Store a confirmed fact, preference, user instruction, or project note in persistent memory.',
        riskTier: RISK_TIERS.LOW_IMPACT,
        schema: {
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'The memory content or fact to store'
                },
                category: {
                    type: 'string',
                    description: 'Memory category (user_approved, project, working_data, conversation). Defaults to user_approved.'
                },
                key: {
                    type: 'string',
                    description: 'Optional lookup key or topic tag'
                },
                type: {
                    type: 'string',
                    description: 'Memory type (confirmed_fact, user_instruction, project_decision, etc.)'
                },
                importance: {
                    type: 'number',
                    description: 'Importance rating from 1 to 5 (default: 2)'
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional tags for categorization'
                },
                metadata: {
                    type: 'object',
                    description: 'Optional structured metadata'
                }
            },
            required: ['content']
        },
        handler: async (params = {}) => {
            const content = String(params.content || '').trim();
            if (!content) {
                return {
                    ok: false,
                    status: 'invalid_parameter',
                    error: 'Parameter content cannot be empty',
                    verification: { verified: false, failureReason: 'Empty content' }
                };
            }

            const category = params.category && Object.values(MEMORY_CATEGORIES).includes(params.category)
                ? params.category
                : MEMORY_CATEGORIES.USER_APPROVED;
            const type = params.type && Object.values(MEMORY_TYPES).includes(params.type)
                ? params.type
                : (params.isInstruction ? MEMORY_TYPES.USER_INSTRUCTION : MEMORY_TYPES.CONFIRMED_FACT);

            try {
                const res = memoryStore.addMemory({
                    category,
                    key: params.key || '',
                    content,
                    type,
                    source: params.source || MEMORY_SOURCES.USER_EXPLICIT,
                    importance: Number(params.importance) || 2,
                    tags: Array.isArray(params.tags) ? params.tags : [],
                    metadata: params.metadata || {}
                });

                if (res && res.rejected) {
                    return {
                        ok: false,
                        status: 'rejected',
                        reason: res.reason,
                        rejected: true,
                        instructionId: res.instructionId || null,
                        verification: { verified: false, failureReason: res.reason }
                    };
                }

                return {
                    ok: true,
                    status: 'completed',
                    memory: {
                        id: res.id,
                        category: res.category,
                        key: res.key || '',
                        content: redactSecrets(res.content),
                        type: res.type,
                        source: res.source,
                        importance: res.importance,
                        createdAt: res.createdAt,
                        updatedAt: res.updatedAt
                    },
                    verification: { verified: true, method: 'memory_store_persisted' }
                };
            } catch (err) {
                return {
                    ok: false,
                    status: 'error',
                    error: `Failed to store memory: ${err.message}`,
                    verification: { verified: false, failureReason: err.message }
                };
            }
        },
        dryRunSimulate: async (params = {}) => {
            return {
                simulatedAction: 'store_memory',
                content: params.content || '',
                category: params.category || 'user_approved'
            };
        }
    });

    // 5. memory_delete: Delete an individual memory record by ID or key
    registry.registerTool({
        id: 'memory_delete',
        name: 'Delete Persistent Memory',
        description: 'Delete a persistent memory record by its exact ID or lookup key with exact-ID protection.',
        riskTier: RISK_TIERS.LOW_IMPACT,
        schema: {
            type: 'object',
            properties: {
                idOrKey: {
                    type: 'string',
                    description: 'Unique memory record ID (e.g. mem_12345678) or key to delete'
                },
                exactIdOnly: {
                    type: 'boolean',
                    description: 'If true, will only delete if matching the exact record ID (never falls back to key)'
                }
            },
            required: ['idOrKey']
        },
        handler: async (params = {}) => {
            const idOrKey = String(params.idOrKey || params.id || params.key || '').trim();
            if (!idOrKey) {
                return {
                    ok: false,
                    status: 'invalid_parameter',
                    error: 'Parameter idOrKey cannot be empty',
                    verification: { verified: false, failureReason: 'Empty identifier' }
                };
            }

            try {
                const deleted = memoryStore.deleteMemory(idOrKey, { exactIdOnly: Boolean(params.exactIdOnly) });
                return {
                    ok: true,
                    status: 'completed',
                    deleted: Boolean(deleted),
                    idOrKey,
                    verification: { verified: Boolean(deleted), method: 'memory_record_deletion' }
                };
            } catch (err) {
                return {
                    ok: false,
                    status: 'error',
                    error: `Failed to delete memory: ${err.message}`,
                    verification: { verified: false, failureReason: err.message }
                };
            }
        },
        dryRunSimulate: async (params = {}) => {
            return {
                simulatedAction: 'delete_memory_record',
                idOrKey: params.idOrKey || ''
            };
        }
    });

    // 6. memory_forget: Forget a topic and optionally register a negative instruction
    registry.registerTool({
        id: 'memory_forget',
        name: 'Forget Topic or Preference',
        description: 'Remove existing memories regarding a topic and record a negative user instruction preventing future retention.',
        riskTier: RISK_TIERS.LOW_IMPACT,
        schema: {
            type: 'object',
            properties: {
                topic: {
                    type: 'string',
                    description: 'The topic, keyword, or preference to forget'
                },
                removeExisting: {
                    type: 'boolean',
                    description: 'Whether to remove existing stored memories matching the topic (default: true)'
                },
                prohibitFuture: {
                    type: 'boolean',
                    description: 'Whether to create an active negative instruction preventing future storage of this topic (default: true)'
                }
            },
            required: ['topic']
        },
        handler: async (params = {}) => {
            const rawTopic = String(params.topic || '').trim();
            if (!rawTopic) {
                return {
                    ok: false,
                    status: 'invalid_parameter',
                    error: 'Parameter topic cannot be empty',
                    verification: { verified: false, failureReason: 'Empty topic' }
                };
            }

            const removeExisting = params.removeExisting !== false;
            const prohibitFuture = params.prohibitFuture !== false;
            const normTopic = rawTopic.toLowerCase();
            let removedCount = 0;

            try {
                // 1. Remove existing memories matching the topic if requested
                if (removeExisting && Array.isArray(memoryStore.memories)) {
                    const toDelete = memoryStore.memories.filter((m) => {
                        if (m.status !== 'active') return false;
                        const contentMatches = m.content && m.content.toLowerCase().includes(normTopic);
                        const keyMatches = m.key && m.key.toLowerCase().includes(normTopic);
                        const tagMatches = Array.isArray(m.tags) && m.tags.some((t) => t.toLowerCase().includes(normTopic));
                        return contentMatches || keyMatches || tagMatches;
                    });

                    for (const rec of toDelete) {
                        const del = memoryStore.deleteMemory(rec.id, { exactIdOnly: true });
                        if (del) removedCount++;
                    }
                }

                // 2. Prohibit future storage by recording an active negative instruction
                let instructionRecord = null;
                if (prohibitFuture) {
                    instructionRecord = memoryStore.addMemory({
                        category: MEMORY_CATEGORIES.USER_APPROVED,
                        key: `no_${normTopic.replace(/[^a-z0-9_]/g, '_').slice(0, 32)}`,
                        content: `Do not remember ${rawTopic}`,
                        type: MEMORY_TYPES.USER_INSTRUCTION,
                        source: MEMORY_SOURCES.USER_EXPLICIT,
                        importance: 5,
                        metadata: {
                            isNegativeInstruction: true,
                            prohibitedTopic: normTopic
                        }
                    });
                }

                return {
                    ok: true,
                    status: 'completed',
                    topic: rawTopic,
                    removedCount,
                    instructionCreated: Boolean(instructionRecord && !instructionRecord.rejected),
                    instructionId: instructionRecord?.id || null,
                    verification: { verified: true, method: 'memory_topic_forgotten' }
                };
            } catch (err) {
                return {
                    ok: false,
                    status: 'error',
                    error: `Failed to forget topic: ${err.message}`,
                    verification: { verified: false, failureReason: err.message }
                };
            }
        },
        dryRunSimulate: async (params = {}) => {
            return {
                simulatedAction: 'forget_topic',
                topic: params.topic || ''
            };
        }
    });
}

module.exports = {
    registerMemoryTools
};
