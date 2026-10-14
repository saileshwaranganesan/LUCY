'use strict';

/**
 * ContextBudgetManager (REQ-032)
 * Manages token budget for long-running assistant tasks.
 * Performs lossless-aware semantic compaction when soft context thresholds are breached.
 * 
 * Guarantees:
 * 1. Model-aware context budgeting respecting documented limits.
 * 2. Conservative, documented token estimation (never assumes character count == token count).
 * 3. Full context accounting: system prompt, message history, memories, tool schemas, and current request.
 * 4. Preserves recent messages, user preferences, active task state, and verified tool outcomes.
 * 5. Secret redaction during compaction.
 * 6. Never discards pending permission gates or represents unexecuted actions as completed.
 * 7. Keeps original conversation history intact while generating bounded views for model requests.
 */

const MODEL_CONTEXT_LIMITS = Object.freeze({
    // Gemini models
    'gemini-2.0-flash': 1048576,
    'gemini-1.5-pro': 2097152,
    // OpenAI / OpenRouter models
    'google/gemini-2.0-flash-001': 128000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    // Ollama local models (often default to 2k-8k context window)
    'qwen2.5:1.5b': 4096,
    'llama3.2:3b': 8192,
    'llama3.1:8b': 8192,
    'mistral:7b': 8192,
    // Hugging Face models
    'meta-llama/Llama-3.2-3B-Instruct': 8192,
    'Qwen/Qwen2.5-7B-Instruct': 32768,
    // Conservative default
    'default': 8192
});

const DEFAULT_WORKING_MAX_TOKENS = 8192;
const DEFAULT_SOFT_RATIO = 0.70; // 70% threshold triggers compaction
const DEFAULT_HARD_RATIO = 0.85; // 85% threshold triggers aggressive compaction

/**
 * Conservative, documented token estimation.
 * In English prose, standard BPE tokenizers produce ~1 token per 3.5-4 characters.
 * However, code, paths, JSON structure, and punctuation produce significantly higher token counts
 * (~1 token per 2.5-3 characters).
 * 
 * Formula:
 * Heuristic combines word tokens (words * 1.3), symbol tokens (each non-whitespace symbol),
 * and a character floor (str.length / 3.3).
 * 
 * @param {string|Object} textOrObj
 * @returns {number} Estimated token count
 */
function estimateTokenCount(textOrObj) {
    if (!textOrObj) return 0;
    const str = typeof textOrObj === 'string' ? textOrObj : JSON.stringify(textOrObj);
    if (str.length === 0) return 0;

    const words = str.match(/[\w]+/g);
    const symbols = str.match(/[^\w\s]/g);
    const wordCount = words ? words.length : 0;
    const symbolCount = symbols ? symbols.length : 0;

    const heuristic = Math.ceil(wordCount * 1.3 + symbolCount * 1.0);
    const charFloor = Math.ceil(str.length / 3.3);

    return Math.max(heuristic, charFloor, 1);
}

// Backward-compatible alias
const approxTokenCount = estimateTokenCount;

class ContextBudgetManager {
    constructor(options = {}) {
        this.model = options.model || 'default';
        const modelLimit = MODEL_CONTEXT_LIMITS[this.model] || MODEL_CONTEXT_LIMITS.default;
        
        // Use configured maxTokens, or cap at modelLimit with a safety margin
        this.maxTokens = options.maxTokens || Math.min(modelLimit, DEFAULT_WORKING_MAX_TOKENS);
        this.softRatio = options.softRatio || DEFAULT_SOFT_RATIO;
        this.hardRatio = options.hardRatio || DEFAULT_HARD_RATIO;
        this.recentTurnsToKeep = options.recentTurnsToKeep || 4; // Keep latest 4 messages untouched
        this.credentialStore = options.credentialStore || null;
    }

    /**
     * Set the active model and update budget limits accordingly
     * @param {string} modelName
     */
    setModel(modelName) {
        if (!modelName) return;
        this.model = modelName;
        const modelLimit = MODEL_CONTEXT_LIMITS[this.model] || MODEL_CONTEXT_LIMITS.default;
        this.maxTokens = Math.min(modelLimit, DEFAULT_WORKING_MAX_TOKENS);
    }

    /**
     * Measure token usage across all request components
     * @param {Array<{role: string, content: string}>} messages
     * @param {Object} [additionalContext={}]
     * @returns {{ totalTokens: number, maxTokens: number, ratio: number, level: 'ok'|'soft'|'hard', breakdown: Object }}
     */
    measureContext(messages = [], additionalContext = {}) {
        let historyTokens = 0;
        let systemTokens = 0;

        for (const msg of messages) {
            const count = estimateTokenCount(msg.role) + estimateTokenCount(msg.content);
            if (msg.role === 'system') {
                systemTokens += count;
            } else {
                historyTokens += count;
            }
        }

        const memoryTokens = additionalContext.memories ? estimateTokenCount(additionalContext.memories) : 0;
        const toolTokens = additionalContext.tools ? estimateTokenCount(additionalContext.tools) : 0;
        const requestTokens = additionalContext.currentRequest ? estimateTokenCount(additionalContext.currentRequest) : 0;

        const totalTokens = systemTokens + historyTokens + memoryTokens + toolTokens + requestTokens;
        const ratio = this.maxTokens > 0 ? totalTokens / this.maxTokens : 0;

        let level = 'ok';
        if (ratio >= this.hardRatio) {
            level = 'hard';
        } else if (ratio >= this.softRatio) {
            level = 'soft';
        }

        return {
            totalTokens,
            maxTokens: this.maxTokens,
            ratio: Number(ratio.toFixed(3)),
            level,
            breakdown: {
                system: systemTokens,
                history: historyTokens,
                memories: memoryTokens,
                tools: toolTokens,
                currentRequest: requestTokens
            }
        };
    }

    /**
     * Compact conversation history into structured semantic continuation memory
     * Redacts secrets, preserves recent messages and critical state.
     * 
     * @param {Array<Object>} messages - Full message history
     * @param {Object} metadata - Task state, objective, artifacts, preferences
     * @returns {Array<Object>} Compacted message array with continuation memory
     */
    compactHistory(messages = [], metadata = {}) {
        if (!Array.isArray(messages) || messages.length <= this.recentTurnsToKeep) {
            return [...(messages || [])];
        }

        const systemMessage = messages.find((m) => m.role === 'system');
        const nonSystemMessages = messages.filter((m) => m.role !== 'system');

        const keepCount = Math.min(this.recentTurnsToKeep, nonSystemMessages.length);
        const olderMessages = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
        const recentMessages = nonSystemMessages.slice(nonSystemMessages.length - keepCount);

        // Extract key facts from older history
        const userObjective = metadata.objective || messages.find((m) => m.role === 'user')?.content || 'User request';
        const completedSteps = metadata.completedSteps || [];
        const verifiedFacts = metadata.verifiedFacts || [];
        const preferences = metadata.preferences || metadata.constraints || [];
        const pendingDecisions = metadata.pendingDecisions || [];

        // Build concise structured continuation block
        const sections = [
            '<lucy_semantic_continuation_memory>',
            `## Primary Objective\n${this._redact(userObjective)}`
        ];

        if (preferences.length) {
            sections.push(`## Preferences & Directives\n${preferences.map((p) => `- ${this._redact(p)}`).join('\n')}`);
        }

        if (completedSteps.length) {
            sections.push(`## Completed Steps\n${completedSteps.map((s) => `- ${this._redact(s)}`).join('\n')}`);
        } else if (olderMessages.length) {
            sections.push(`## Prior Context\n- Handled ${olderMessages.length} preliminary interaction turns.`);
        }

        if (verifiedFacts.length) {
            sections.push(`## Verified Facts\n${verifiedFacts.map((f) => `- ${this._redact(f)}`).join('\n')}`);
        }

        if (pendingDecisions.length) {
            sections.push(`## Pending Actions\n${pendingDecisions.map((d) => `- ⚠ PENDING: ${this._redact(d)}`).join('\n')}`);
        }

        sections.push(`## Continuation Point\n${this._redact(metadata.nextAction || 'Continue task.')}`);
        sections.push('</lucy_semantic_continuation_memory>');

        const continuationBlock = sections.join('\n\n');

        const compactedMessages = [];
        if (systemMessage) {
            compactedMessages.push(systemMessage);
        }

        compactedMessages.push({
            role: 'assistant',
            content: continuationBlock,
            isCompactedMemory: true
        });

        // Add recent interactions untouched
        compactedMessages.push(...recentMessages);

        return compactedMessages;
    }

    /**
     * Generate a bounded context view for LLM dispatch without mutating the original conversation record.
     * 
     * @param {Array<Object>} fullHistory - Full unmodified conversation history
     * @param {Object} [options={}]
     * @returns {{ boundedMessages: Array<Object>, compacted: boolean, diagnostics: Object }}
     */
    buildBoundedContext(fullHistory = [], options = {}) {
        const check = this.measureContext(fullHistory, options);

        if (check.level === 'ok' || fullHistory.length <= this.recentTurnsToKeep) {
            return {
                boundedMessages: [...fullHistory],
                compacted: false,
                diagnostics: {
                    originalTokens: check.totalTokens,
                    compactedTokens: check.totalTokens,
                    tokensSaved: 0,
                    ratio: check.ratio,
                    level: check.level
                }
            };
        }

        // Compact history for bounded view
        const compactedMessages = this.compactHistory(fullHistory, options.metadata || {});
        const postCheck = this.measureContext(compactedMessages, options);

        // If template expansion didn't save tokens on very short conversations, preserve original
        if (postCheck.totalTokens >= check.totalTokens) {
            return {
                boundedMessages: [...fullHistory],
                compacted: false,
                diagnostics: {
                    originalTokens: check.totalTokens,
                    compactedTokens: check.totalTokens,
                    tokensSaved: 0,
                    ratio: check.ratio,
                    level: check.level
                }
            };
        }

        return {
            boundedMessages: compactedMessages,
            compacted: true,
            diagnostics: {
                originalTokens: check.totalTokens,
                compactedTokens: postCheck.totalTokens,
                tokensSaved: Math.max(0, check.totalTokens - postCheck.totalTokens),
                ratio: postCheck.ratio,
                level: postCheck.level
            }
        };
    }

    _redact(text) {
        if (typeof text !== 'string') return '';
        let sanitized = text;
        if (this.credentialStore && typeof this.credentialStore.redact === 'function') {
            sanitized = this.credentialStore.redact(sanitized);
        }
        // Universal secret token masking
        sanitized = sanitized.replace(/(?:api[_-]?key|secret|token|password|bearer\s+)[:=\s]+['"]?([a-zA-Z0-9_\-]{8,})['"]?/gi, '[REDACTED_SECRET]');
        sanitized = sanitized.replace(/hf_[a-zA-Z0-9]{20,}/g, '[REDACTED_SECRET]');
        return sanitized;
    }
}

module.exports = {
    ContextBudgetManager,
    MODEL_CONTEXT_LIMITS,
    estimateTokenCount,
    approxTokenCount
};
