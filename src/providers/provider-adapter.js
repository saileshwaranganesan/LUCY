'use strict';

/**
 * ProviderAdapter
 * Unified AI Provider layer supporting Gemini API, OpenRouter, local Ollama,
 * Custom OpenAI-compatible endpoints, and Hugging Face Inference API.
 * 
 * Enforces strict security & cost policies:
 * 1. Zero automatic paid-provider fallback (fails closed).
 * 2. Missing credentials fail closed immediately before network call.
 * 3. Unavailable usage or cost is explicitly represented as { status: 'unknown' }, NEVER zero.
 * 4. Supports incremental AI response streaming (REQ-029) with clean cancellation and error handling.
 * 5. Supports local Ollama model discovery and capability handling (REQ-030).
 * 6. Supports optional Hugging Face Inference API integration (REQ-031).
 */

const {
    validateEndpointUrl,
    isLoopbackHost,
    sanitizeUrlForLogging
} = require('../security/ipc-validator.js');

const PROVIDER_TYPES = Object.freeze({
    GEMINI: 'gemini',
    OPENROUTER: 'openrouter',
    GROQ: 'groq',
    CEREBRAS: 'cerebras',
    OLLAMA: 'ollama',
    CUSTOM_OPENAI: 'custom-openai',
    HUGGINGFACE: 'huggingface'
});

const DEFAULT_MODELS = Object.freeze({
    [PROVIDER_TYPES.GEMINI]: 'gemini-2.0-flash',
    [PROVIDER_TYPES.OPENROUTER]: 'google/gemini-2.0-flash-001',
    [PROVIDER_TYPES.GROQ]: 'llama-3.3-70b-versatile',
    [PROVIDER_TYPES.CEREBRAS]: 'llama3.1-8b',
    [PROVIDER_TYPES.OLLAMA]: 'qwen2.5:1.5b',
    [PROVIDER_TYPES.CUSTOM_OPENAI]: 'gpt-4o-mini',
    [PROVIDER_TYPES.HUGGINGFACE]: 'meta-llama/Llama-3.2-3B-Instruct'
});

class ProviderAdapter {
    constructor(options = {}) {
        this.credentialStore = options.credentialStore;
        this.provider = options.provider || process.env.LUCY_AI_PROVIDER || PROVIDER_TYPES.GEMINI;
        this.model = options.model || process.env.LUCY_AI_MODEL || DEFAULT_MODELS[this.provider];
        this.localBaseUrl = options.localBaseUrl || process.env.LUCY_LOCAL_MODEL_URL || 'http://127.0.0.1:11434';
        this.customOpenAiUrl = options.customOpenAiUrl || process.env.LUCY_CUSTOM_OPENAI_URL || null;
        this.huggingFaceUrl = options.huggingFaceUrl || process.env.LUCY_HUGGINGFACE_URL || 'https://router.huggingface.co/hf-inference/v1/chat/completions';
        this.groqUrl = options.groqUrl || process.env.LUCY_GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions';
        this.cerebrasUrl = options.cerebrasUrl || process.env.LUCY_CEREBRAS_URL || 'https://api.cerebras.ai/v1/chat/completions';
        this.modelRouter = options.modelRouter || null;
        this.connectionManager = options.connectionManager || null;
        this.allowPaidFallback = false; // Strictly non-negotiable: NO automatic paid fallback
    }

    setModelRouter(router) {
        this.modelRouter = router;
    }

    setConnectionManager(cm) {
        this.connectionManager = cm;
    }

    setCustomOpenAiUrl(url) {
        if (url) {
            const check = validateEndpointUrl(url, { context: 'Custom OpenAI endpoint', allowHttpLoopback: true });
            if (!check.ok) {
                throw new Error(`Invalid custom OpenAI URL: ${check.error}`);
            }
            this.customOpenAiUrl = check.url;
        } else {
            this.customOpenAiUrl = null;
        }
    }

    setLocalBaseUrl(url) {
        if (url) {
            const check = validateEndpointUrl(url, { context: 'Local Ollama endpoint', allowHttpLoopback: true });
            if (!check.ok) {
                throw new Error(`Invalid local Ollama URL: ${check.error}`);
            }
            this.localBaseUrl = check.url;
        } else {
            this.localBaseUrl = 'http://127.0.0.1:11434';
        }
    }

    setHuggingFaceUrl(url) {
        if (url) {
            const check = validateEndpointUrl(url, { context: 'Hugging Face endpoint', allowHttpLoopback: false });
            if (!check.ok) {
                throw new Error(`Invalid Hugging Face URL: ${check.error}`);
            }
            this.huggingFaceUrl = check.url;
        } else {
            this.huggingFaceUrl = 'https://router.huggingface.co/hf-inference/v1/chat/completions';
        }
    }

    setProvider(provider, model) {
        if (!Object.values(PROVIDER_TYPES).includes(provider)) {
            throw new Error(`Unsupported provider: ${provider}`);
        }
        this.provider = provider;
        this.model = model || DEFAULT_MODELS[provider];
    }

    /**
     * Resolve the active API key from environment, CredentialStore, or ConnectionManager.
     * Consistent Precedence:
     * 1. Environment variables (LUCY_<PROVIDER>_API_KEY, <PROVIDER>_API_KEY)
     * 2. CredentialStore provider key (<provider>_api_key)
     * 3. ConnectionManager connection key (if connectionManager is attached)
     */
    resolveApiKey(provider = this.provider) {
        if (provider === PROVIDER_TYPES.OLLAMA) {
            return 'not_required'; // Local models don't require keys
        }

        // 1. Environment variables have highest precedence
        const provUpper = String(provider).replace(/-/g, '_').toUpperCase();
        const envKey = process.env[`LUCY_${provUpper}_API_KEY`] ||
            process.env[`${provUpper}_API_KEY`];
        if (envKey && envKey.trim()) return envKey.trim();

        // 2. CredentialStore provider key
        const keyName = `${provider}_api_key`;
        if (this.credentialStore) {
            if (typeof this.credentialStore.getSecret === 'function') {
                const key = this.credentialStore.getSecret(keyName);
                if (key && key.trim()) return key.trim();
            } else if (typeof this.credentialStore.resolveApiKey === 'function') {
                const key = this.credentialStore.resolveApiKey(provider);
                if (key && key.trim()) return key.trim();
            }
        }

        // 3. Fallback to active connection in ConnectionManager
        if (this.connectionManager) {
            try {
                const conns = this.connectionManager.listConnections({ provider });
                for (const c of conns) {
                    const k = this.connectionManager.getApiKey(c.id);
                    if (k && k.trim()) return k.trim();
                }
            } catch (_) {}
        }

        return '';
    }

    /**
     * Check if a usable AI route exists based on current configuration and policy.
     * @param {Object} [options={}]
     * @returns {boolean}
     */
    hasUsableRoute(options = {}) {
        if (this.modelRouter) {
            try {
                const candidates = this.modelRouter.resolveCandidateRoutes(options);
                return Array.isArray(candidates) && candidates.length > 0;
            } catch {
                return false;
            }
        }
        if (this.provider === PROVIDER_TYPES.OLLAMA) {
            return true;
        }
        return Boolean(this.resolveApiKey(this.provider));
    }

    /**
     * Call the configured LLM endpoint or route intelligently through ModelRouter
     * @param {Object} request
     * @param {Array<{role: string, content: string}>} request.messages
     * @param {Array<Object>} [request.tools] - Tool definitions
     * @param {number} [request.temperature=0.7]
     * @param {number} [request.maxTokens=2048]
     * @param {AbortSignal} [request.signal] - Cancellation signal
     * @param {Function} [request.onChunk] - Incremental streaming callback ({ delta, accumulatedText, done })
     * @param {Object} [routingOptions={}] - Optional routing overrides and flags
     * @returns {Promise<Object>} Formatted response with honest usage/cost tracking
     */
    async complete(request = {}, routingOptions = {}) {
        if (this.modelRouter && routingOptions.bypassRouter !== true) {
            return await this.modelRouter.complete(request, routingOptions);
        }

        const { messages = [], tools = [], temperature = 0.7, maxTokens = 2048, signal, onChunk } = request;

        if (signal && signal.aborted) {
            return {
                ok: false,
                code: 'request_cancelled',
                error: 'Request was cancelled before execution started.',
                cancelled: true,
                provider: this.provider,
                model: this.model,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        if (!messages.length) {
            return {
                ok: false,
                code: 'empty_messages',
                error: 'Cannot call model with empty messages array'
            };
        }

        // Validate multimodal messages fail-closed before network dispatch
        for (const msg of messages) {
            const norm = this._normalizeMultimodalMessage(msg);
            if (!norm.isValid) {
                return {
                    ok: false,
                    code: norm.code || 'invalid_multimodal_message',
                    error: norm.error || 'Invalid multimodal message payload',
                    provider: this.provider,
                    model: this.model,
                    usage: { status: 'unknown' },
                    cost: { status: 'unknown' }
                };
            }
        }

        // 1. Validate credentials - FAIL CLOSED
        const apiKey = this.resolveApiKey(this.provider);
        if (!apiKey) {
            return {
                ok: false,
                code: 'missing_credentials',
                error: `Authentication failed: Missing API key for provider '${this.provider}'. Configure via settings or Windows Credential Manager.`,
                provider: this.provider,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        // 2. Dispatch based on configured provider (NO silent fallback)
        try {
            if (this.provider === PROVIDER_TYPES.GEMINI) {
                return await this._callGemini(messages, tools, apiKey, { temperature, maxTokens, signal, onChunk });
            } else if (this.provider === PROVIDER_TYPES.OPENROUTER || this.provider === PROVIDER_TYPES.CUSTOM_OPENAI) {
                return await this._callOpenAiCompatible(messages, tools, apiKey, { temperature, maxTokens, signal, onChunk });
            } else if (this.provider === PROVIDER_TYPES.GROQ) {
                return await this._callOpenAiCompatible(messages, tools, apiKey, { temperature, maxTokens, signal, onChunk, baseUrl: this.groqUrl });
            } else if (this.provider === PROVIDER_TYPES.CEREBRAS) {
                return await this._callOpenAiCompatible(messages, tools, apiKey, { temperature, maxTokens, signal, onChunk, baseUrl: this.cerebrasUrl });
            } else if (this.provider === PROVIDER_TYPES.OLLAMA) {
                return await this._callOllama(messages, tools, { temperature, maxTokens, signal, onChunk });
            } else if (this.provider === PROVIDER_TYPES.HUGGINGFACE) {
                return await this._callHuggingFace(messages, tools, apiKey, { temperature, maxTokens, signal, onChunk });
            }
            throw new Error(`Unknown provider: ${this.provider}`);
        } catch (err) {
            // Check for user cancellation
            if ((signal && signal.aborted) || err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('abort'))) {
                return {
                    ok: false,
                    code: 'request_cancelled',
                    error: 'Request was cancelled by user.',
                    cancelled: true,
                    provider: this.provider,
                    model: this.model,
                    usage: { status: 'unknown' },
                    cost: { status: 'unknown' }
                };
            }

            // Under NO circumstance switch to another paid provider!
            const sanitizedErr = this._redactSecret(err.message, apiKey);
            return {
                ok: false,
                code: 'provider_request_failed',
                error: `Provider call failed (${this.provider}): ${sanitizedErr}`,
                provider: this.provider,
                model: this.model,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }
    }

    /**
     * Dispatch completion with an explicit connection and model (used by ModelRouter & ConnectionManager)
     * @param {Object} params
     * @param {Object} params.connection
     * @param {string} [params.apiKey]
     * @param {string} [params.model]
     * @param {Object} params.request
     * @returns {Promise<Object>}
     */
    async completeWithConnection({ connection, apiKey, model, request = {} }) {
        if (!connection || !connection.provider) {
            throw new Error('Connection must specify a provider');
        }

        const prov = connection.provider;
        const targetModel = model || connection.defaultModel || DEFAULT_MODELS[prov];
        const key = apiKey || (this.connectionManager ? this.connectionManager.getApiKey(connection.id) : this.resolveApiKey(prov));
        const { messages = [], tools = [], temperature = 0.7, maxTokens = 2048, signal, onChunk } = request;

        const options = {
            temperature,
            maxTokens,
            signal,
            onChunk,
            model: targetModel,
            provider: prov,
            baseUrl: connection.baseUrl
        };

        if (prov === PROVIDER_TYPES.GEMINI) {
            return await this._callGemini(messages, tools, key, options);
        } else if (prov === PROVIDER_TYPES.OPENROUTER) {
            return await this._callOpenAiCompatible(messages, tools, key, { ...options, baseUrl: connection.baseUrl || 'https://openrouter.ai/api/v1/chat/completions' });
        } else if (prov === PROVIDER_TYPES.GROQ) {
            return await this._callOpenAiCompatible(messages, tools, key, { ...options, baseUrl: connection.baseUrl || this.groqUrl });
        } else if (prov === PROVIDER_TYPES.CEREBRAS) {
            return await this._callOpenAiCompatible(messages, tools, key, { ...options, baseUrl: connection.baseUrl || this.cerebrasUrl });
        } else if (prov === PROVIDER_TYPES.CUSTOM_OPENAI) {
            return await this._callOpenAiCompatible(messages, tools, key, { ...options, baseUrl: connection.baseUrl || this.customOpenAiUrl });
        } else if (prov === PROVIDER_TYPES.OLLAMA) {
            return await this._callOllama(messages, tools, { ...options, baseUrl: connection.baseUrl || this.localBaseUrl });
        } else if (prov === PROVIDER_TYPES.HUGGINGFACE) {
            return await this._callHuggingFace(messages, tools, key, { ...options, baseUrl: connection.baseUrl || this.huggingFaceUrl });
        }
        throw new Error(`Unsupported provider: ${prov}`);
    }

    /**
     * Test a connection's validity and reachability
     * @param {string} connectionId
     * @returns {Promise<Object>}
     */
    async testConnection(connectionId) {
        if (!this.connectionManager) {
            throw new Error('ConnectionManager is not attached to ProviderAdapter');
        }
        return await this.connectionManager.testConnection(connectionId, this);
    }

    async _callGemini(messages, tools, apiKey, options = {}) {
        const activeModel = options.model || this.model;
        const activeProvider = options.provider || this.provider;
        const isStreaming = typeof options.onChunk === 'function';
        const action = isStreaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:${action}`;

        // Format Gemini contents with multimodal support
        const contents = [];
        let systemInstruction = null;

        for (const msg of messages) {
            const norm = this._normalizeMultimodalMessage(msg);
            if (msg.role === 'system') {
                systemInstruction = { parts: [{ text: norm.text }] };
            } else if (msg.role === 'tool' || msg.functionResponse) {
                const toolName = msg.name || msg.toolId || 'tool_response';
                const resObj = typeof msg.content === 'object' && msg.content !== null ? msg.content : { result: msg.content };
                contents.push({
                    role: 'function',
                    parts: [{
                        functionResponse: {
                            name: toolName,
                            response: resObj
                        }
                    }]
                });
            } else {
                const parts = [];
                if (norm.text) {
                    parts.push({ text: norm.text });
                }
                for (const img of norm.images) {
                    parts.push({
                        inlineData: {
                            mimeType: img.mimeType,
                            data: img.base64
                        }
                    });
                }
                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: parts.length > 0 ? parts : [{ text: '' }]
                });
            }
        }

        const body = {
            contents,
            generationConfig: {
                temperature: options.temperature,
                maxOutputTokens: options.maxTokens
            }
        };

        if (systemInstruction) {
            body.systemInstruction = systemInstruction;
        }

        // Format function declarations if tools provided
        if (tools && tools.length) {
            body.tools = [{
                functionDeclarations: tools.map((t) => ({
                    name: t.id,
                    description: t.description,
                    parameters: t.schema
                }))
            }];
        }

        const fetchSignal = options.signal || AbortSignal.timeout(30000);

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(body),
            signal: fetchSignal
        });

        if (!res.ok) {
            const rawErrText = await res.text().catch(() => '');
            const sanitizedErr = this._redactSecret(rawErrText, apiKey);
            return {
                ok: false,
                code: `http_${res.status}`,
                error: `Gemini API returned HTTP ${res.status}: ${sanitizedErr.slice(0, 300)}`,
                provider: activeProvider,
                model: activeModel,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        if (isStreaming) {
            return await this._consumeSseStream(res, (data) => {
                const part = data.candidates?.[0]?.content?.parts?.[0];
                return part?.text || '';
            }, options.onChunk, fetchSignal, { provider: activeProvider, model: activeModel });
        }

        const data = await res.json();
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        let content = '';
        const toolCalls = [];

        for (const part of parts) {
            if (part.text) {
                content += part.text;
            }
            if (part.functionCall) {
                toolCalls.push({
                    name: part.functionCall.name,
                    arguments: part.functionCall.args || {}
                });
            }
        }

        // Usage and cost representation
        const usage = this._formatUsage(data.usageMetadata);
        const cost = this._formatCost(usage);

        return {
            ok: true,
            provider: activeProvider,
            model: activeModel,
            isLocal: false,
            leavesLocalMachine: true,
            content,
            toolCalls,
            hasToolCalls: toolCalls.length > 0,
            usage,
            cost
        };
    }

    async _callOpenAiCompatible(messages, tools, apiKey, options = {}) {
        const activeModel = options.model || this.model;
        const activeProvider = options.provider || this.provider;
        let baseUrl = options.baseUrl;
        if (!baseUrl) {
            if (activeProvider === PROVIDER_TYPES.OPENROUTER) {
                baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
            } else if (activeProvider === PROVIDER_TYPES.GROQ) {
                baseUrl = this.groqUrl;
            } else if (activeProvider === PROVIDER_TYPES.CEREBRAS) {
                baseUrl = this.cerebrasUrl;
            } else {
                baseUrl = this.customOpenAiUrl || process.env.LUCY_CUSTOM_OPENAI_URL || 'https://api.openai.com/v1/chat/completions';
            }
        }

        // SEC-007: Strictly enforce HTTPS for remote endpoints and validate loopback policy
        const urlValidation = validateEndpointUrl(baseUrl, {
            context: activeProvider === PROVIDER_TYPES.OPENROUTER ? 'OpenRouter' : (activeProvider || 'OpenAI Compatible'),
            allowHttpLoopback: true
        });

        if (!urlValidation.ok) {
            return {
                ok: false,
                code: urlValidation.code || 'invalid_endpoint_url',
                error: `Security Policy Violation: ${urlValidation.error}`,
                provider: activeProvider,
                model: activeModel,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        baseUrl = urlValidation.url;
        const isStreaming = typeof options.onChunk === 'function';

        const formattedMessages = messages.map((msg) => {
            if (msg.role === 'tool') {
                return {
                    role: 'tool',
                    tool_call_id: msg.tool_call_id || msg.id || 'call_0',
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
                };
            }
            if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
                return {
                    role: 'assistant',
                    content: msg.content || null,
                    tool_calls: msg.toolCalls.map((tc, idx) => ({
                        id: tc.id || `call_${idx}`,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})
                        }
                    }))
                };
            }
            const norm = this._normalizeMultimodalMessage(msg);
            if (!norm.hasImages) {
                return { role: msg.role, content: typeof msg.content === 'string' ? msg.content : norm.text };
            }
            const contentParts = [];
            if (norm.text) {
                contentParts.push({ type: 'text', text: norm.text });
            }
            for (const img of norm.images) {
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: img.dataUri }
                });
            }
            return { role: msg.role, content: contentParts };
        });

        const body = {
            model: activeModel,
            messages: formattedMessages,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            stream: isStreaming
        };

        if (tools && tools.length) {
            body.tools = tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.id,
                    description: t.description,
                    parameters: t.schema
                }
            }));
        }

        const fetchSignal = options.signal || AbortSignal.timeout(30000);

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: fetchSignal
        });

        if (!res.ok) {
            const rawErrText = await res.text().catch(() => '');
            const sanitizedErr = this._redactSecret(rawErrText, apiKey);
            return {
                ok: false,
                code: `http_${res.status}`,
                error: `${activeProvider} returned HTTP ${res.status}: ${sanitizedErr.slice(0, 300)}`,
                provider: activeProvider,
                model: activeModel,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        if (isStreaming) {
            return await this._consumeSseStream(res, (data) => {
                const delta = data.choices?.[0]?.delta?.content;
                return delta || '';
            }, options.onChunk, fetchSignal, { provider: activeProvider, model: activeModel });
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const msg = choice?.message || {};

        const toolCalls = [];
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            for (const call of msg.tool_calls) {
                let parsedArgs = {};
                try {
                    parsedArgs = JSON.parse(call.function?.arguments || '{}');
                } catch {
                    parsedArgs = {};
                }
                toolCalls.push({
                    name: call.function?.name,
                    arguments: parsedArgs
                });
            }
        }

        const usage = this._formatUsage(data.usage);
        const cost = this._formatCost(usage);

        return {
            ok: true,
            provider: activeProvider,
            model: activeModel,
            isLocal: false,
            leavesLocalMachine: true,
            content: msg.content || '',
            toolCalls,
            hasToolCalls: toolCalls.length > 0,
            usage,
            cost
        };
    }

    async _callOllama(messages, tools, options = {}) {
        const activeBaseUrl = options.baseUrl || this.localBaseUrl;
        const activeModel = options.model || this.model;
        const activeProvider = options.provider || PROVIDER_TYPES.OLLAMA;
        // SEC-007: Strictly validate Ollama endpoint URL before dispatch
        const urlValidation = validateEndpointUrl(activeBaseUrl, {
            context: 'Ollama local',
            allowHttpLoopback: true
        });

        if (!urlValidation.ok) {
            return {
                ok: false,
                code: urlValidation.code || 'invalid_endpoint_url',
                error: `Security Policy Violation: ${urlValidation.error}`,
                provider: activeProvider,
                model: activeModel,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        const url = `${urlValidation.url.replace(/\/+$/, '')}/api/chat`;
        const isStreaming = typeof options.onChunk === 'function';

        const formattedMessages = messages.map((msg) => {
            if (msg.role === 'tool') {
                return {
                    role: 'tool',
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
                };
            }
            if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
                return {
                    role: 'assistant',
                    content: msg.content || '',
                    tool_calls: msg.toolCalls.map((tc) => ({
                        function: {
                            name: tc.name,
                            arguments: tc.arguments || {}
                        }
                    }))
                };
            }
            const norm = this._normalizeMultimodalMessage(msg);
            const ollamaMsg = {
                role: msg.role,
                content: typeof msg.content === 'string' && !norm.hasImages ? msg.content : norm.text
            };
            if (norm.hasImages) {
                ollamaMsg.images = norm.images.map((img) => img.base64);
            }
            return ollamaMsg;
        });

        const body = {
            model: activeModel,
            messages: formattedMessages,
            options: {
                temperature: options.temperature
            },
            keep_alive: options.keepAlive !== undefined ? options.keepAlive : '5m',
            stream: isStreaming
        };

        if (tools && tools.length) {
            body.tools = tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.id,
                    description: t.description,
                    parameters: t.schema || { type: 'object', properties: {} }
                }
            }));
        }

        const fetchSignal = options.signal || AbortSignal.timeout(45000);

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: fetchSignal
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            let errCode = `http_${res.status}`;
            let errMsg = `Ollama returned HTTP ${res.status}: ${errText.slice(0, 300)}`;

            const lower = errText.toLowerCase();
            if (res.status === 404 || lower.includes('not found') || lower.includes('try pulling it')) {
                errCode = 'model_not_installed';
                errMsg = `Requested local model '${activeModel}' is not installed in Ollama. Pull it using 'ollama pull ${activeModel}'.`;
            } else if (res.status === 500 && (lower.includes('load') || lower.includes('memory') || lower.includes('resource') || lower.includes('allocate'))) {
                errCode = 'model_loading_failure';
                errMsg = `Ollama failed to load model '${activeModel}' into memory: ${errText.slice(0, 300)}`;
            }

            return {
                ok: false,
                code: errCode,
                error: errMsg,
                provider: activeProvider,
                model: activeModel,
                isLocal: true,
                leavesLocalMachine: false,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        if (isStreaming) {
            return await this._consumeNdjsonStream(res, options.onChunk, fetchSignal, { provider: activeProvider, model: activeModel });
        }

        const data = await res.json();
        const msg = data.message || {};
        const toolCalls = [];

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            for (const call of msg.tool_calls) {
                let parsedArgs = {};
                if (typeof call.function?.arguments === 'string') {
                    try {
                        parsedArgs = JSON.parse(call.function.arguments || '{}');
                    } catch {
                        parsedArgs = {};
                    }
                } else if (typeof call.function?.arguments === 'object' && call.function?.arguments !== null) {
                    parsedArgs = call.function.arguments;
                }
                toolCalls.push({
                    name: call.function?.name,
                    arguments: parsedArgs
                });
            }
        }

        const usage = data.prompt_eval_count != null ? {
            status: 'reported',
            promptTokens: data.prompt_eval_count,
            completionTokens: data.eval_count || 0,
            totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
        } : { status: 'unknown' };

        // Local inference cost is $0.00
        const cost = {
            status: 'local_zero_cost',
            amount: 0.0,
            currency: 'USD'
        };

        return {
            ok: true,
            provider: activeProvider,
            model: activeModel,
            isLocal: true,
            leavesLocalMachine: false,
            content: msg.content || '',
            toolCalls,
            hasToolCalls: toolCalls.length > 0,
            usage,
            cost
        };
    }

    /**
     * REQ-031: Call Hugging Face Inference API
     */
    async _callHuggingFace(messages, tools, apiKey, options = {}) {
        const activeModel = options.model || this.model;
        const activeProvider = options.provider || PROVIDER_TYPES.HUGGINGFACE;
        let baseUrl = options.baseUrl || this.huggingFaceUrl || 'https://router.huggingface.co/hf-inference/v1/chat/completions';

        // Enforce HTTPS
        const urlValidation = validateEndpointUrl(baseUrl, {
            context: 'Hugging Face endpoint',
            allowHttpLoopback: false
        });

        if (!urlValidation.ok) {
            return {
                ok: false,
                code: urlValidation.code || 'invalid_endpoint_url',
                error: `Security Policy Violation: ${urlValidation.error}`,
                provider: activeProvider,
                model: activeModel,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        baseUrl = urlValidation.url;
        const isStreaming = typeof options.onChunk === 'function';

        const hasMultimodal = messages.some((m) => this._normalizeMultimodalMessage(m).hasImages);
        if (hasMultimodal) {
            const modelLower = (activeModel || '').toLowerCase();
            const isVisionModel = Boolean(
                modelLower.includes('vision') ||
                modelLower.includes('-vl') ||
                modelLower.includes('paligemma') ||
                modelLower.includes('llava') ||
                modelLower.includes('pixtral') ||
                modelLower.includes('smolvlm') ||
                modelLower.includes('idefics')
            );
            if (!isVisionModel) {
                return {
                    ok: false,
                    code: 'unsupported_multimodal',
                    error: `Configured Hugging Face model '${activeModel}' does not support multimodal visual input. Please use Google Gemini, OpenAI/OpenRouter, or local Ollama with a vision model.`,
                    provider: activeProvider,
                    model: activeModel,
                    usage: { status: 'unknown' },
                    cost: { status: 'unknown' }
                };
            }
        }

        const formattedHfMessages = messages.map((msg) => {
            const norm = this._normalizeMultimodalMessage(msg);
            if (!norm.hasImages) {
                return { role: msg.role, content: typeof msg.content === 'string' ? msg.content : norm.text };
            }
            const contentParts = [];
            if (norm.text) contentParts.push({ type: 'text', text: norm.text });
            for (const img of norm.images) {
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: img.dataUri }
                });
            }
            return { role: msg.role, content: contentParts };
        });

        const body = {
            model: activeModel,
            messages: formattedHfMessages,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            stream: isStreaming
        };

        if (tools && tools.length) {
            body.tools = tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.id,
                    description: t.description,
                    parameters: t.schema || { type: 'object', properties: {} }
                }
            }));
        }

        const fetchSignal = options.signal || AbortSignal.timeout(35000);

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: fetchSignal
        });

        if (!res.ok) {
            const rawErrText = await res.text().catch(() => '');
            const sanitizedErr = this._redactSecret(rawErrText, apiKey);
            let userError = `Hugging Face returned HTTP ${res.status}: ${sanitizedErr.slice(0, 300)}`;

            if (res.status === 401) {
                userError = 'Hugging Face authentication failed: Invalid or missing Hugging Face API token.';
            } else if (res.status === 404) {
                userError = `Hugging Face model '${activeModel}' was not found or is unsupported on the serverless router.`;
            } else if (res.status === 429) {
                userError = 'Hugging Face rate limit exceeded. Please wait or configure an inference endpoint.';
            } else if (res.status === 503) {
                userError = `Hugging Face model '${activeModel}' is currently loading. Please retry in a few moments.`;
            }

            return {
                ok: false,
                code: `http_${res.status}`,
                error: userError,
                provider: activeProvider,
                model: activeModel,
                usage: { status: 'unknown' },
                cost: { status: 'unknown' }
            };
        }

        if (isStreaming) {
            const streamResult = await this._consumeSseStream(res, (data) => {
                const delta = data.choices?.[0]?.delta?.content;
                return delta || '';
            }, options.onChunk, fetchSignal, { provider: activeProvider, model: activeModel });

            if (streamResult.ok) {
                streamResult.cost = {
                    status: 'serverless_tier_or_account_billed',
                    amount: 0.0,
                    currency: 'USD',
                    note: 'Free within Hugging Face serverless rate limits'
                };
            }
            return streamResult;
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const msg = choice?.message || {};
        const toolCalls = [];

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            for (const call of msg.tool_calls) {
                let parsedArgs = {};
                if (typeof call.function?.arguments === 'string') {
                    try {
                        parsedArgs = JSON.parse(call.function.arguments || '{}');
                    } catch {
                        parsedArgs = {};
                    }
                } else if (typeof call.function?.arguments === 'object' && call.function?.arguments !== null) {
                    parsedArgs = call.function.arguments;
                }
                toolCalls.push({
                    name: call.function?.name,
                    arguments: parsedArgs
                });
            }
        }

        const usage = this._formatUsage(data.usage);
        const cost = {
            status: 'serverless_tier_or_account_billed',
            amount: 0.0,
            currency: 'USD',
            note: 'Free within Hugging Face serverless rate limits'
        };

        return {
            ok: true,
            provider: activeProvider,
            model: activeModel,
            isLocal: false,
            leavesLocalMachine: true,
            content: msg.content || '',
            toolCalls,
            hasToolCalls: toolCalls.length > 0,
            usage,
            cost
        };
    }

    /**
     * REQ-030: Discover locally installed Ollama models
     * @param {string} [endpointUrl=this.localBaseUrl]
     * @returns {Promise<Object>}
     */
    async discoverOllamaModels(endpointUrl = this.localBaseUrl) {
        const urlValidation = validateEndpointUrl(endpointUrl, {
            context: 'Local Ollama endpoint',
            allowHttpLoopback: true
        });

        if (!urlValidation.ok) {
            return {
                ok: false,
                code: urlValidation.code || 'invalid_endpoint_url',
                error: `Cannot discover models: ${urlValidation.error}`
            };
        }

        const cleanUrl = urlValidation.url.replace(/\/+$/, '');
        const targetUrl = `${cleanUrl}/api/tags`;

        try {
            const res = await fetch(targetUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });

            if (!res.ok) {
                return {
                    ok: false,
                    code: `http_${res.status}`,
                    error: `Ollama returned HTTP ${res.status} when listing models.`
                };
            }

            const data = await res.json().catch(() => null);
            if (!data || !Array.isArray(data.models)) {
                return {
                    ok: false,
                    code: 'malformed_response',
                    error: 'Ollama returned a malformed model list response.'
                };
            }

            const models = data.models.map((m) => ({
                name: m.name || m.model || 'unknown',
                size: m.size || 0,
                digest: m.digest || '',
                details: m.details || {},
                modifiedAt: m.modified_at || '',
                installed: true
            }));

            return {
                ok: true,
                endpoint: cleanUrl,
                models,
                count: models.length
            };
        } catch (err) {
            const isConnRefused = err.cause?.code === 'ECONNREFUSED' ||
                (err.message && (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')));

            return {
                ok: false,
                code: isConnRefused ? 'OLLAMA_UNAVAILABLE' : 'discovery_failed',
                error: isConnRefused
                    ? `Ollama server is unavailable at '${cleanUrl}'. Verify that Ollama is installed and running.`
                    : `Failed to query Ollama models: ${err.message}`
            };
        }
    }

    /**
     * Check if the local Ollama inference service is available and responding.
     * @param {string} [endpointUrl=this.localBaseUrl]
     * @returns {Promise<{ ok: boolean, version?: string, code?: string, error?: string }>}
     */
    async checkLocalServiceAvailability(endpointUrl = this.localBaseUrl) {
        const urlValidation = validateEndpointUrl(endpointUrl, {
            context: 'Local Ollama health check',
            allowHttpLoopback: true
        });

        if (!urlValidation.ok) {
            return {
                ok: false,
                code: urlValidation.code || 'invalid_endpoint_url',
                error: `Invalid local endpoint: ${urlValidation.error}`
            };
        }

        const cleanUrl = urlValidation.url.replace(/\/+$/, '');
        try {
            const res = await fetch(`${cleanUrl}/api/version`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });

            if (!res.ok) {
                const tagsRes = await fetch(`${cleanUrl}/api/tags`, {
                    method: 'GET',
                    signal: AbortSignal.timeout(3000)
                });
                if (tagsRes.ok) {
                    return { ok: true, version: 'available', endpoint: cleanUrl };
                }
                return {
                    ok: false,
                    code: 'OLLAMA_UNAVAILABLE',
                    error: `Ollama returned HTTP ${res.status}`
                };
            }

            const data = await res.json().catch(() => ({}));
            return {
                ok: true,
                version: data.version || 'available',
                endpoint: cleanUrl
            };
        } catch (err) {
            const isConnRefused = err.cause?.code === 'ECONNREFUSED' ||
                (err.message && (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')));

            return {
                ok: false,
                code: 'OLLAMA_UNAVAILABLE',
                error: isConnRefused
                    ? `Ollama local inference runtime is not running at ${cleanUrl}.`
                    : `Cannot reach local inference runtime: ${err.message}`
            };
        }
    }

    /**
     * Query currently loaded models in Ollama memory (via /api/ps).
     * @param {string} [endpointUrl=this.localBaseUrl]
     * @returns {Promise<{ ok: boolean, models: Array<Object>, count: number }>}
     */
    async getLoadedModels(endpointUrl = this.localBaseUrl) {
        const urlValidation = validateEndpointUrl(endpointUrl, {
            context: 'Ollama loaded models',
            allowHttpLoopback: true
        });

        if (!urlValidation.ok) {
            return { ok: false, models: [], count: 0, error: urlValidation.error };
        }

        const cleanUrl = urlValidation.url.replace(/\/+$/, '');
        try {
            const res = await fetch(`${cleanUrl}/api/ps`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });

            if (!res.ok) {
                return { ok: true, models: [], count: 0 };
            }

            const data = await res.json().catch(() => ({}));
            const models = Array.isArray(data.models) ? data.models : [];
            return {
                ok: true,
                models: models.map((m) => ({
                    name: m.name || m.model || 'unknown',
                    size: m.size || 0,
                    sizeVram: m.size_vram || 0,
                    expiresAt: m.expires_at || null
                })),
                count: models.length
            };
        } catch (err) {
            return { ok: false, models: [], count: 0, error: err.message };
        }
    }

    /**
     * Unload a model from Ollama memory to free system RAM (via keep_alive: 0).
     * @param {string} modelName
     * @param {string} [endpointUrl=this.localBaseUrl]
     * @returns {Promise<{ ok: boolean, message: string }>}
     */
    async unloadModel(modelName, endpointUrl = this.localBaseUrl) {
        if (!modelName) {
            return { ok: false, error: 'Model name required to unload' };
        }

        const urlValidation = validateEndpointUrl(endpointUrl, {
            context: 'Ollama unload model',
            allowHttpLoopback: true
        });

        if (!urlValidation.ok) {
            return { ok: false, error: urlValidation.error };
        }

        const cleanUrl = urlValidation.url.replace(/\/+$/, '');
        try {
            const res = await fetch(`${cleanUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelName,
                    keep_alive: 0
                }),
                signal: AbortSignal.timeout(5000)
            });

            if (res.ok) {
                return { ok: true, message: `Model '${modelName}' unloaded from memory.` };
            }
            return { ok: false, error: `Failed to unload model '${modelName}': HTTP ${res.status}` };
        } catch (err) {
            return { ok: false, error: `Failed to unload model '${modelName}': ${err.message}` };
        }
    }

    /**
     * Helper to parse and stream Server-Sent Events (SSE)
     */
    async _consumeSseStream(response, extractDeltaFn, onChunk, signal, context = {}) {
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedText = '';

        if (!response.body) {
            throw new Error('Response body is null, cannot stream');
        }

        for await (const chunk of response.body) {
            if (signal && signal.aborted) {
                throw new Error('Stream cancelled by user signal');
            }

            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;

                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') {
                    break;
                }

                if (!payload) continue;

                try {
                    const parsed = JSON.parse(payload);
                    const delta = extractDeltaFn(parsed);
                    if (delta) {
                        accumulatedText += delta;
                        onChunk({ delta, accumulatedText, done: false });
                    }
                } catch (_) {
                    // Ignore non-JSON heartbeat or malformed SSE line
                }
            }
        }

        // Process any remainder in buffer
        if (buffer && buffer.trim().startsWith('data:')) {
            const payload = buffer.trim().slice(5).trim();
            if (payload && payload !== '[DONE]') {
                try {
                    const parsed = JSON.parse(payload);
                    const delta = extractDeltaFn(parsed);
                    if (delta) {
                        accumulatedText += delta;
                        onChunk({ delta, accumulatedText, done: false });
                    }
                } catch (_) {}
            }
        }

        // Final completion notification
        onChunk({ delta: '', accumulatedText, done: true });

        return {
            ok: true,
            provider: context.provider || this.provider,
            model: context.model || this.model,
            content: accumulatedText,
            toolCalls: [],
            hasToolCalls: false,
            usage: { status: 'reported_stream' },
            cost: { status: 'unknown' }
        };
    }

    /**
     * Helper to parse and stream line-delimited JSON (NDJSON, e.g. Ollama)
     */
    async _consumeNdjsonStream(response, onChunk, signal, context = {}) {
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedText = '';
        let finalUsage = { status: 'unknown' };

        if (!response.body) {
            throw new Error('Response body is null, cannot stream');
        }

        for await (const chunk of response.body) {
            if (signal && signal.aborted) {
                throw new Error('Stream cancelled by user signal');
            }

            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const data = JSON.parse(trimmed);
                    const delta = data.message?.content;
                    if (delta) {
                        accumulatedText += delta;
                        onChunk({ delta, accumulatedText, done: false });
                    }
                    if (data.done) {
                        if (data.prompt_eval_count != null) {
                            finalUsage = {
                                status: 'reported',
                                promptTokens: data.prompt_eval_count,
                                completionTokens: data.eval_count || 0,
                                totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                            };
                        }
                    }
                } catch (_) {}
            }
        }

        onChunk({ delta: '', accumulatedText, done: true });

        return {
            ok: true,
            provider: context.provider || this.provider,
            model: context.model || this.model,
            content: accumulatedText,
            toolCalls: [],
            hasToolCalls: false,
            usage: finalUsage,
            cost: { status: 'local_zero_cost', amount: 0.0, currency: 'USD' }
        };
    }

    /**
     * Normalize, validate, and extract image and text payload parts from a message.
     * Enforces MIME whitelist and 4MB per-image size cap fail-closed.
     * @param {Object} msg
     * @returns {{ text: string, images: Array<{ mimeType: string, base64: string, dataUri: string, byteLength: number }>, hasImages: boolean, isValid: boolean, code?: string, error?: string }}
     */
    _normalizeMultimodalMessage(msg) {
        if (!msg || typeof msg !== 'object') {
            return { text: '', images: [], hasImages: false, isValid: false, code: 'invalid_message', error: 'Invalid message object' };
        }

        let text = '';
        const rawImages = [];

        if (typeof msg.content === 'string') {
            text = msg.content;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (!part) continue;
                if (part.type === 'text') {
                    text = text ? `${text}\n${part.text || ''}` : (part.text || '');
                } else if (part.type === 'image_url') {
                    rawImages.push(part.image_url?.url || part.image_url);
                } else if (part.type === 'image' || part.inlineData) {
                    rawImages.push(part.inlineData || part);
                }
            }
        }

        if (Array.isArray(msg.images)) {
            for (const img of msg.images) {
                rawImages.push(img);
            }
        }

        const normalizedImages = [];
        const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB per image cap

        for (const raw of rawImages) {
            if (!raw) continue;
            let mimeType = 'image/png';
            let base64 = '';

            if (typeof raw === 'string') {
                const dataUriMatch = raw.match(/^data:([^;]+);base64,(.+)$/s);
                if (dataUriMatch) {
                    mimeType = dataUriMatch[1].toLowerCase();
                    base64 = dataUriMatch[2].replace(/\s+/g, '');
                } else {
                    base64 = raw.replace(/\s+/g, '');
                }
            } else if (typeof raw === 'object') {
                mimeType = (raw.mimeType || raw.mime_type || 'image/png').toLowerCase();
                base64 = (raw.data || raw.base64 || '').replace(/\s+/g, '');
                if (raw.url) {
                    const match = raw.url.match(/^data:([^;]+);base64,(.+)$/s);
                    if (match) {
                        mimeType = match[1].toLowerCase();
                        base64 = match[2].replace(/\s+/g, '');
                    }
                }
            }

            const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
            if (!allowedMimes.includes(mimeType)) {
                return {
                    text,
                    images: [],
                    hasImages: false,
                    isValid: false,
                    code: 'invalid_image_mime',
                    error: `Unsupported image MIME type: '${mimeType}'. Supported formats: PNG, JPEG, WEBP, GIF.`
                };
            }

            if (base64.length === 0) {
                return {
                    text,
                    images: [],
                    hasImages: false,
                    isValid: false,
                    code: 'empty_image_data',
                    error: 'Encountered empty or missing base64 image data in multimodal message.'
                };
            }

            const approxBytes = Math.ceil((base64.length * 3) / 4);
            if (approxBytes > MAX_IMAGE_BYTES) {
                return {
                    text,
                    images: [],
                    hasImages: false,
                    isValid: false,
                    code: 'image_payload_too_large',
                    error: `Image payload exceeds maximum allowed size of 4MB (approx ${(approxBytes / (1024 * 1024)).toFixed(2)} MB).`
                };
            }

            normalizedImages.push({
                mimeType,
                base64,
                dataUri: `data:${mimeType};base64,${base64}`,
                byteLength: approxBytes
            });
        }

        return {
            text,
            images: normalizedImages,
            hasImages: normalizedImages.length > 0,
            isValid: true
        };
    }

    /**
     * Map raw usage metadata or return unknown
     */
    _formatUsage(rawUsage) {
        if (!rawUsage || typeof rawUsage !== 'object') {
            return { status: 'unknown' };
        }

        const prompt = rawUsage.promptTokens ?? rawUsage.prompt_tokens ?? rawUsage.promptTokenCount;
        const completion = rawUsage.candidatesTokenCount ?? rawUsage.completion_tokens ?? rawUsage.completionTokens;
        const total = rawUsage.totalTokens ?? rawUsage.total_tokens ?? rawUsage.totalTokenCount;

        if (prompt == null && completion == null && total == null) {
            return { status: 'unknown' };
        }

        return {
            status: 'reported',
            promptTokens: Number(prompt) || 0,
            completionTokens: Number(completion) || 0,
            totalTokens: Number(total) || ((Number(prompt) || 0) + (Number(completion) || 0))
        };
    }

    /**
     * Map cost or return unknown
     */
    _formatCost(usage) {
        if (usage.status !== 'reported') {
            return { status: 'unknown' };
        }

        // For Gemini 2.0 Flash standard rates ($0.10/1M prompt, $0.40/1M output)
        if (this.provider === PROVIDER_TYPES.GEMINI) {
            const promptCost = (usage.promptTokens / 1_000_000) * 0.10;
            const completionCost = (usage.completionTokens / 1_000_000) * 0.40;
            return {
                status: 'estimated',
                amount: Number((promptCost + completionCost).toFixed(6)),
                currency: 'USD'
            };
        }

        return { status: 'unknown' };
    }

    /**
     * Redact API key or configured secrets from error strings and diagnostic output
     */
    _redactSecret(text, secret) {
        if (typeof text !== 'string') return '';
        let sanitized = text;
        if (this.credentialStore && typeof this.credentialStore.redact === 'function') {
            sanitized = this.credentialStore.redact(sanitized);
        }
        if (secret && typeof secret === 'string' && secret.length >= 6) {
            sanitized = sanitized.replaceAll(secret, '[REDACTED_SECRET]');
        }
        // Also redact any potential Hugging Face token patterns (hf_...)
        sanitized = sanitized.replace(/hf_[a-zA-Z0-9]{20,}/g, '[REDACTED_SECRET]');
        return sanitized;
    }
}

module.exports = {
    ProviderAdapter,
    PROVIDER_TYPES,
    DEFAULT_MODELS
};
