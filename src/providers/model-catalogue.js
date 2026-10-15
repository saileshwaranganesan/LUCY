'use strict';

/**
 * ModelCatalogue
 * Central authoritative registry of AI models, providers, and capabilities.
 * 
 * Enforces:
 * 1. Explicit capability verification (text, vision, structured tool calling, reasoning, fast, local).
 * 2. Honest pricing tracking (free, paid, or unknown — unknown pricing is NEVER assumed free).
 * 3. Graceful fallback to cached catalogue when dynamic endpoints are unreachable.
 * 4. Extensible custom model registration with capability validation.
 */

const PROVIDER_TYPES = Object.freeze({
    GEMINI: 'gemini',
    OPENROUTER: 'openrouter',
    GROQ: 'groq',
    CEREBRAS: 'cerebras',
    HUGGINGFACE: 'huggingface',
    OLLAMA: 'ollama',
    CUSTOM_OPENAI: 'custom-openai'
});

const KNOWN_MODELS = [
    // -------------------------------------------------------------
    // Google AI Studio / Gemini API
    // -------------------------------------------------------------
    {
        id: 'gemini-2.0-flash',
        provider: PROVIDER_TYPES.GEMINI,
        name: 'Gemini 2.0 Flash',
        description: 'Next-gen multimodal workhorse model with high speed and native tool calling.',
        capabilities: {
            text: true,
            vision: true,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: false
        },
        contextLimit: 1048576,
        outputLimit: 8192,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },
    {
        id: 'gemini-2.0-flash-lite',
        provider: PROVIDER_TYPES.GEMINI,
        name: 'Gemini 2.0 Flash-Lite',
        description: 'Cost-efficient and fast model optimized for lightweight tasks and high throughput.',
        capabilities: {
            text: true,
            vision: true,
            tool_calling: true,
            reasoning: false,
            fast: true,
            local: false
        },
        contextLimit: 1048576,
        outputLimit: 8192,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },
    {
        id: 'gemini-1.5-flash',
        provider: PROVIDER_TYPES.GEMINI,
        name: 'Gemini 1.5 Flash',
        description: 'Fast, lightweight multimodal model for high-frequency desktop assistance.',
        capabilities: {
            text: true,
            vision: true,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: false
        },
        contextLimit: 1048576,
        outputLimit: 8192,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },
    {
        id: 'gemini-1.5-pro',
        provider: PROVIDER_TYPES.GEMINI,
        name: 'Gemini 1.5 Pro',
        description: 'Deep reasoning multimodal model with 2M token context window for complex planning.',
        capabilities: {
            text: true,
            vision: true,
            tool_calling: true,
            reasoning: true,
            fast: false,
            local: false
        },
        contextLimit: 2097152,
        outputLimit: 8192,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },

    // -------------------------------------------------------------
    // GroqCloud Inference (Ultra-low latency LPU)
    // -------------------------------------------------------------
    {
        id: 'llama-3.3-70b-versatile',
        provider: PROVIDER_TYPES.GROQ,
        name: 'Llama 3.3 70B (Groq)',
        description: 'State-of-the-art open-weights reasoning model running on Groq LPU with tool calling.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: false
        },
        contextLimit: 131072,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },
    {
        id: 'llama-3.1-8b-instant',
        provider: PROVIDER_TYPES.GROQ,
        name: 'Llama 3.1 8B Instant (Groq)',
        description: 'Ultra-fast inference model (800+ tokens/sec) ideal for real-time voice and lightweight tasks.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: false,
            fast: true,
            local: false
        },
        contextLimit: 131072,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },
    {
        id: 'mixtral-8x7b-32768',
        provider: PROVIDER_TYPES.GROQ,
        name: 'Mixtral 8x7B (Groq)',
        description: 'Fast mixture-of-experts model with 32k context and tool calling support.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: false
        },
        contextLimit: 32768,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },

    // -------------------------------------------------------------
    // Cerebras Inference (Wafer-scale high-speed inference)
    // -------------------------------------------------------------
    {
        id: 'llama3.1-8b',
        provider: PROVIDER_TYPES.CEREBRAS,
        name: 'Llama 3.1 8B (Cerebras)',
        description: 'Wafer-scale hardware execution delivering 2000+ tokens/sec for voice and quick actions.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: false,
            fast: true,
            local: false
        },
        contextLimit: 8192,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },
    {
        id: 'llama3.1-70b',
        provider: PROVIDER_TYPES.CEREBRAS,
        name: 'Llama 3.1 70B (Cerebras)',
        description: 'Wafer-scale large reasoning model with blazing execution speed and tool calling.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: false
        },
        contextLimit: 8192,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },
    {
        id: 'llama3.3-70b',
        provider: PROVIDER_TYPES.CEREBRAS,
        name: 'Llama 3.3 70B (Cerebras)',
        description: 'Flagship Cerebras model combining 70B reasoning with wafer-scale high throughput.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: false
        },
        contextLimit: 8192,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'free_tier_eligible' },
        isFreeEligible: true
    },

    // -------------------------------------------------------------
    // OpenRouter (Universal Multi-Model Router)
    // -------------------------------------------------------------
    {
        id: 'google/gemini-2.0-flash-001',
        provider: PROVIDER_TYPES.OPENROUTER,
        name: 'Gemini 2.0 Flash (OpenRouter)',
        description: 'OpenRouter routed Gemini 2.0 Flash with multimodal and tool calling capabilities.',
        capabilities: {
            text: true,
            vision: true,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: false
        },
        contextLimit: 1048576,
        outputLimit: 8192,
        pricing: { type: 'free', tier: 'free_eligible' },
        isFreeEligible: true
    },
    {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        provider: PROVIDER_TYPES.OPENROUTER,
        name: 'Llama 3.3 70B Free (OpenRouter)',
        description: 'Free community tier of Llama 3.3 70B with tool support and reasoning.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: false,
            local: false
        },
        contextLimit: 65536,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'free_tier' },
        isFreeEligible: true
    },
    {
        id: 'deepseek/deepseek-r1:free',
        provider: PROVIDER_TYPES.OPENROUTER,
        name: 'DeepSeek R1 Free (OpenRouter)',
        description: 'Deep mathematical and algorithmic reasoning model on OpenRouter free tier.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: false,
            reasoning: true,
            fast: false,
            local: false
        },
        contextLimit: 65536,
        outputLimit: 8192,
        pricing: { type: 'free', tier: 'free_tier' },
        isFreeEligible: true
    },
    {
        id: 'qwen/qwen-2.5-72b-instruct',
        provider: PROVIDER_TYPES.OPENROUTER,
        name: 'Qwen 2.5 72B (OpenRouter Paid)',
        description: 'Advanced Chinese/English bilingual coding and reasoning model (Paid).',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: false,
            local: false
        },
        contextLimit: 131072,
        outputLimit: 4096,
        pricing: { type: 'paid', promptPerM: 0.35, completionPerM: 0.40 },
        isFreeEligible: false
    },
    {
        id: 'anthropic/claude-3.5-sonnet',
        provider: PROVIDER_TYPES.OPENROUTER,
        name: 'Claude 3.5 Sonnet (OpenRouter Paid)',
        description: 'Industry-leading coding and agentic execution model (Paid).',
        capabilities: {
            text: true,
            vision: true,
            tool_calling: true,
            reasoning: true,
            fast: false,
            local: false
        },
        contextLimit: 200000,
        outputLimit: 8192,
        pricing: { type: 'paid', promptPerM: 3.0, completionPerM: 15.0 },
        isFreeEligible: false
    },

    // -------------------------------------------------------------
    // Hugging Face Inference API
    // -------------------------------------------------------------
    {
        id: 'meta-llama/Llama-3.2-3B-Instruct',
        provider: PROVIDER_TYPES.HUGGINGFACE,
        name: 'Llama 3.2 3B Instruct (HF)',
        description: 'Serverless free tier model for lightweight assistant interactions.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: false,
            reasoning: false,
            fast: true,
            local: false
        },
        contextLimit: 131072,
        outputLimit: 2048,
        pricing: { type: 'free', tier: 'serverless_free_tier' },
        isFreeEligible: true
    },
    {
        id: 'meta-llama/Llama-3.1-8B-Instruct',
        provider: PROVIDER_TYPES.HUGGINGFACE,
        name: 'Llama 3.1 8B Instruct (HF)',
        description: 'Popular general-purpose model on Hugging Face Serverless Inference.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: false,
            local: false
        },
        contextLimit: 131072,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'serverless_free_tier' },
        isFreeEligible: true
    },

    // -------------------------------------------------------------
    // Ollama / Local Inference (100% Offline / Free)
    // -------------------------------------------------------------
    {
        id: 'qwen2.5:1.5b',
        provider: PROVIDER_TYPES.OLLAMA,
        name: 'Qwen 2.5 1.5B (Local)',
        description: 'Compact, efficient local model for private offline text processing.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: false,
            reasoning: false,
            fast: true,
            local: true
        },
        contextLimit: 32768,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'local_hardware' },
        isFreeEligible: true
    },
    {
        id: 'llama3.2:1b',
        provider: PROVIDER_TYPES.OLLAMA,
        name: 'Llama 3.2 1B (Local)',
        description: 'Ultra-compact local model suitable for rapid on-device filtering and summaries.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: false,
            reasoning: false,
            fast: true,
            local: true
        },
        contextLimit: 131072,
        outputLimit: 2048,
        pricing: { type: 'free', tier: 'local_hardware' },
        isFreeEligible: true
    },
    {
        id: 'llama3.2:3b',
        provider: PROVIDER_TYPES.OLLAMA,
        name: 'Llama 3.2 3B (Local)',
        description: 'Balanced local model with structured function calling support.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: true,
            local: true
        },
        contextLimit: 131072,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'local_hardware' },
        isFreeEligible: true
    },
    {
        id: 'llama3.1:8b',
        provider: PROVIDER_TYPES.OLLAMA,
        name: 'Llama 3.1 8B (Local)',
        description: 'Capable 8B parameter local model for comprehensive offline tool use.',
        capabilities: {
            text: true,
            vision: false,
            tool_calling: true,
            reasoning: true,
            fast: false,
            local: true
        },
        contextLimit: 131072,
        outputLimit: 4096,
        pricing: { type: 'free', tier: 'local_hardware' },
        isFreeEligible: true
    },
    {
        id: 'llava:7b',
        provider: PROVIDER_TYPES.OLLAMA,
        name: 'LLaVA 7B (Local Vision)',
        description: 'Local multimodal vision model for private desktop screenshot interpretation.',
        capabilities: {
            text: true,
            vision: true,
            tool_calling: false,
            reasoning: true,
            fast: false,
            local: true
        },
        contextLimit: 4096,
        outputLimit: 2048,
        pricing: { type: 'free', tier: 'local_hardware' },
        isFreeEligible: true
    }
];

class ModelCatalogue {
    constructor() {
        this._models = new Map();
        for (const m of KNOWN_MODELS) {
            this._models.set(this._makeKey(m.provider, m.id), { ...m });
        }
    }

    _makeKey(provider, modelId) {
        return `${String(provider || '').trim().toLowerCase()}::${String(modelId || '').trim().toLowerCase()}`;
    }

    /**
     * Retrieve a model entry by ID and optional provider.
     * @param {string} modelId
     * @param {string} [provider]
     * @returns {Object|null}
     */
    getModel(modelId, provider = null) {
        if (!modelId) return null;
        const cleanId = String(modelId).trim().toLowerCase();

        if (provider) {
            const key = this._makeKey(provider, cleanId);
            if (this._models.has(key)) return { ...this._models.get(key) };
        }

        // Search across all registered providers
        for (const entry of this._models.values()) {
            if (entry.id.toLowerCase() === cleanId) {
                return { ...entry };
            }
        }

        return null;
    }

    /**
     * List models with optional capability and policy filters.
     * @param {Object} [filter={}]
     * @returns {Array<Object>}
     */
    listModels(filter = {}) {
        let results = Array.from(this._models.values());

        if (filter.provider) {
            const targetProv = String(filter.provider).trim().toLowerCase();
            results = results.filter((m) => m.provider === targetProv);
        }

        if (filter.localOnly) {
            results = results.filter((m) => m.capabilities.local === true);
        }

        if (filter.freeOnly) {
            results = results.filter((m) => m.isFreeEligible === true);
        }

        if (filter.requiresVision) {
            results = results.filter((m) => m.capabilities.vision === true);
        }

        if (filter.requiresToolCalling) {
            results = results.filter((m) => m.capabilities.tool_calling === true);
        }

        if (filter.requiresReasoning) {
            results = results.filter((m) => m.capabilities.reasoning === true);
        }

        if (filter.requiresFast) {
            results = results.filter((m) => m.capabilities.fast === true);
        }

        return results.map((m) => ({ ...m }));
    }

    /**
     * Check if a given model satisfies required capabilities.
     * @param {string} modelId
     * @param {Object} requirements - e.g. { vision: true, tool_calling: true }
     * @param {string} [provider]
     * @returns {{ capable: boolean, missing: string[] }}
     */
    isCapable(modelId, requirements = {}, provider = null) {
        const model = this.getModel(modelId, provider);
        if (!model) {
            return { capable: false, missing: ['model_not_found'] };
        }

        const missing = [];
        for (const [cap, required] of Object.entries(requirements)) {
            if (required && !model.capabilities[cap]) {
                missing.push(cap);
            }
        }

        return {
            capable: missing.length === 0,
            missing
        };
    }

    /**
     * Check if a model is verified free or free-tier eligible.
     * Strict Rule: Unknown pricing is NEVER treated as free.
     * @param {string} modelId
     * @param {string} [provider]
     * @returns {boolean}
     */
    isFreeEligible(modelId, provider = null) {
        const model = this.getModel(modelId, provider);
        if (!model) return false;
        if (model.pricing?.type === 'unknown' || !model.pricing) return false;
        return model.isFreeEligible === true && model.pricing.type === 'free';
    }

    /**
     * Register or update a custom model definition.
     * @param {Object} modelDef
     */
    registerCustomModel(modelDef) {
        if (!modelDef || !modelDef.id || !modelDef.provider) {
            throw new Error('Custom model definition must contain at least id and provider');
        }

        const cleanId = String(modelDef.id).trim();
        const cleanProvider = String(modelDef.provider).trim().toLowerCase();
        const key = this._makeKey(cleanProvider, cleanId);

        const entry = {
            id: cleanId,
            provider: cleanProvider,
            name: modelDef.name || cleanId,
            description: modelDef.description || 'Custom registered model',
            capabilities: {
                text: modelDef.capabilities?.text !== false,
                vision: Boolean(modelDef.capabilities?.vision),
                tool_calling: Boolean(modelDef.capabilities?.tool_calling),
                reasoning: Boolean(modelDef.capabilities?.reasoning),
                fast: Boolean(modelDef.capabilities?.fast),
                local: cleanProvider === PROVIDER_TYPES.OLLAMA || Boolean(modelDef.capabilities?.local)
            },
            contextLimit: Number(modelDef.contextLimit) || 8192,
            outputLimit: Number(modelDef.outputLimit) || 2048,
            pricing: modelDef.pricing || { type: 'unknown' },
            isFreeEligible: modelDef.isFreeEligible === true && modelDef.pricing?.type === 'free',
            custom: true
        };

        this._models.set(key, entry);
        return { ...entry };
    }

    /**
     * Refresh Ollama local models from discovered tag list or remote endpoint without blocking.
     * @param {Array<Object|string>|string} modelsOrEndpoint
     * @returns {Promise<{ ok: boolean, count?: number, error?: string }>}
     */
    async refreshLocalModels(modelsOrEndpoint) {
        if (typeof modelsOrEndpoint === 'string') {
            const url = modelsOrEndpoint.trim().replace(/\/+$/, '');
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000);
                const res = await fetch(`${url}/api/tags`, {
                    signal: controller.signal,
                    headers: { 'Accept': 'application/json' }
                });
                clearTimeout(timeoutId);

                if (!res.ok) {
                    return { ok: false, error: `HTTP ${res.status}` };
                }

                const data = await res.json();
                const models = Array.isArray(data?.models) ? data.models : [];
                await this.refreshLocalModels(models);
                return { ok: true, count: models.length };
            } catch (err) {
                return { ok: false, error: err.message || 'Connection failed' };
            }
        }

        if (!Array.isArray(modelsOrEndpoint)) {
            return { ok: false, error: 'Invalid models list' };
        }

        for (const item of modelsOrEndpoint) {
            const modelName = typeof item === 'string' ? item : (item.name || item.model);
            if (!modelName) continue;

            const cleanName = String(modelName).trim();
            const lower = cleanName.toLowerCase();
            const isVision = lower.includes('vision') || lower.includes('llava') || lower.includes('vl');
            const isTool = lower.includes('qwen') || lower.includes('llama3') || lower.includes('mistral');

            this.registerCustomModel({
                id: cleanName,
                provider: PROVIDER_TYPES.OLLAMA,
                name: `${cleanName} (Local)`,
                description: 'Locally discovered model in Ollama runtime',
                capabilities: {
                    text: true,
                    vision: isVision,
                    tool_calling: isTool,
                    reasoning: isTool,
                    fast: lower.includes('1b') || lower.includes('3b'),
                    local: true
                },
                pricing: { type: 'free', tier: 'local_hardware' },
                isFreeEligible: true
            });
        }

        return { ok: true, count: modelsOrEndpoint.length };
    }
}

module.exports = {
    PROVIDER_TYPES,
    KNOWN_MODELS,
    ModelCatalogue
};
