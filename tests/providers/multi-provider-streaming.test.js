'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');
const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { CredentialStore } = require('../../src/security/credential-store.js');

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Helper to create a ReadableStream of Uint8Array chunks from an array of strings
function createMockStream(chunks) {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            if (index < chunks.length) {
                controller.enqueue(encoder.encode(chunks[index]));
                index++;
            } else {
                controller.close();
            }
        }
    });
}

test('REQ-029: Incremental AI Response Streaming', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await t.test('Gemini: streams SSE chunks progressively and signals completion', async () => {
        const sseData = [
            'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}]}\n\n'
        ];

        globalThis.fetch = async (url, options) => {
            assert.match(url, /streamGenerateContent\?alt=sse/);
            assert.equal(options.headers['x-goog-api-key'], 'test_gemini_key');
            return new Response(createMockStream(sseData), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI,
            model: 'gemini-2.0-flash'
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_gemini_key';

        try {
            const chunks = [];
            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'Say hello' }],
                onChunk: (chunk) => {
                    chunks.push(chunk);
                }
            });

            assert.equal(result.ok, true);
            assert.equal(result.content, 'Hello world!');
            assert.equal(chunks.length, 4); // 3 deltas + 1 done

            assert.deepEqual(chunks[0], { delta: 'Hello', accumulatedText: 'Hello', done: false });
            assert.deepEqual(chunks[1], { delta: ' world', accumulatedText: 'Hello world', done: false });
            assert.deepEqual(chunks[2], { delta: '!', accumulatedText: 'Hello world!', done: false });
            assert.deepEqual(chunks[3], { delta: '', accumulatedText: 'Hello world!', done: true });
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    await t.test('OpenAI / OpenRouter: streams SSE chunks and handles [DONE]', async () => {
        const sseData = [
            'data: {"choices":[{"delta":{"content":"I am "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"LUCY."}}]}\n\n',
            'data: [DONE]\n\n'
        ];

        globalThis.fetch = async (url, options) => {
            assert.equal(JSON.parse(options.body).stream, true);
            return new Response(createMockStream(sseData), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.OPENROUTER,
            model: 'google/gemini-2.0-flash-001'
        });
        process.env.LUCY_OPENROUTER_API_KEY = 'test_or_key';

        try {
            const chunks = [];
            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'Introduce yourself' }],
                onChunk: (chunk) => chunks.push(chunk)
            });

            assert.equal(result.ok, true);
            assert.equal(result.content, 'I am LUCY.');
            assert.equal(chunks.length, 3);
            assert.equal(chunks[chunks.length - 1].done, true);
            assert.equal(chunks[chunks.length - 1].accumulatedText, 'I am LUCY.');
        } finally {
            delete process.env.LUCY_OPENROUTER_API_KEY;
        }
    });

    await t.test('Ollama: streams line-delimited NDJSON and reports eval metrics', async () => {
        const ndjsonData = [
            JSON.stringify({ message: { content: 'Local ' }, done: false }) + '\n',
            JSON.stringify({ message: { content: 'assistant' }, done: false }) + '\n',
            JSON.stringify({ message: { content: ' ready.' }, done: true, prompt_eval_count: 12, eval_count: 5 }) + '\n'
        ];

        globalThis.fetch = async (url, options) => {
            assert.match(url, /\/api\/chat$/);
            assert.equal(JSON.parse(options.body).stream, true);
            return new Response(createMockStream(ndjsonData), {
                status: 200,
                headers: { 'Content-Type': 'application/x-ndjson' }
            });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.OLLAMA,
            model: 'qwen2.5:1.5b'
        });

        const chunks = [];
        const result = await adapter.complete({
            messages: [{ role: 'user', content: 'Status check' }],
            onChunk: (chunk) => chunks.push(chunk)
        });

        assert.equal(result.ok, true);
        assert.equal(result.content, 'Local assistant ready.');
        assert.equal(result.usage.promptTokens, 12);
        assert.equal(result.usage.completionTokens, 5);
        assert.equal(result.usage.totalTokens, 17);
        assert.equal(chunks[chunks.length - 1].done, true);
    });

    await t.test('Non-streaming mode preserves legacy response structure', async () => {
        globalThis.fetch = async (url, options) => {
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'Complete non-streaming answer.' }] } }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, totalTokenCount: 18 }
            }), { status: 200 });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_gemini_key';

        try {
            // No onChunk callback -> non-streaming call
            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'Query' }]
            });

            assert.equal(result.ok, true);
            assert.equal(result.content, 'Complete non-streaming answer.');
            assert.equal(result.usage.totalTokens, 18);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });

    await t.test('Cancellation during streaming halts execution fail-closed', async () => {
        const controller = new AbortController();

        globalThis.fetch = async (url, options) => {
            options.signal.addEventListener('abort', () => {});
            // Simulate aborted stream
            throw new DOMException('The user aborted a request.', 'AbortError');
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.GEMINI
        });
        process.env.LUCY_GEMINI_API_KEY = 'test_gemini_key';

        try {
            controller.abort();
            const result = await adapter.complete({
                messages: [{ role: 'user', content: 'Slow stream' }],
                signal: controller.signal,
                onChunk: () => {}
            });

            assert.equal(result.ok, false);
            assert.equal(result.code, 'request_cancelled');
            assert.equal(result.cancelled, true);
        } finally {
            delete process.env.LUCY_GEMINI_API_KEY;
        }
    });
});

test('REQ-030: Ollama Model Discovery and Capability Handling', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await t.test('discovers installed local models from /api/tags', async () => {
        const fakeTags = {
            models: [
                {
                    name: 'qwen2.5:1.5b',
                    size: 986000000,
                    digest: 'sha256:abc1234',
                    details: {
                        family: 'qwen2',
                        parameter_size: '1.5B',
                        quantization_level: 'Q4_K_M'
                    },
                    modified_at: '2026-10-10T12:00:00Z'
                },
                {
                    name: 'llama3.2:3b',
                    size: 2000000000,
                    details: {
                        family: 'llama',
                        parameter_size: '3B'
                    }
                }
            ]
        };

        globalThis.fetch = async (url) => {
            assert.match(url, /\/api\/tags$/);
            return new Response(JSON.stringify(fakeTags), { status: 200 });
        };

        const adapter = new ProviderAdapter({ localBaseUrl: 'http://127.0.0.1:11434' });
        const res = await adapter.discoverOllamaModels();

        assert.equal(res.ok, true);
        assert.equal(res.count, 2);
        assert.equal(res.models[0].name, 'qwen2.5:1.5b');
        assert.equal(res.models[0].installed, true);
        assert.equal(res.models[0].details.parameter_size, '1.5B');
        assert.equal(res.models[1].name, 'llama3.2:3b');
    });

    await t.test('handles server unavailable cleanly without crashing or silent fallback', async () => {
        globalThis.fetch = async () => {
            const err = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
            err.cause = { code: 'ECONNREFUSED' };
            throw err;
        };

        const adapter = new ProviderAdapter({ localBaseUrl: 'http://127.0.0.1:11434' });
        const res = await adapter.discoverOllamaModels();

        assert.equal(res.ok, false);
        assert.equal(res.code, 'OLLAMA_UNAVAILABLE');
        assert.match(res.error, /unavailable at/i);
    });

    await t.test('handles empty model list response', async () => {
        globalThis.fetch = async () => {
            return new Response(JSON.stringify({ models: [] }), { status: 200 });
        };

        const adapter = new ProviderAdapter({ localBaseUrl: 'http://127.0.0.1:11434' });
        const res = await adapter.discoverOllamaModels();

        assert.equal(res.ok, true);
        assert.equal(res.count, 0);
        assert.deepEqual(res.models, []);
    });

    await t.test('handles malformed JSON response', async () => {
        globalThis.fetch = async () => {
            return new Response('<html>Error: Bad Gateway</html>', { status: 502 });
        };

        const adapter = new ProviderAdapter({ localBaseUrl: 'http://127.0.0.1:11434' });
        const res = await adapter.discoverOllamaModels();

        assert.equal(res.ok, false);
        assert.equal(res.code, 'http_502');
    });

    await t.test('rejects insecure remote HTTP endpoint for model discovery', async () => {
        const adapter = new ProviderAdapter();
        const res = await adapter.discoverOllamaModels('http://remote-server.com:11434');

        assert.equal(res.ok, false);
        assert.equal(res.code, 'INSECURE_HTTP_FORBIDDEN');
    });
});

test('REQ-031: Hugging Face Provider Integration', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    await t.test('fails closed when Hugging Face API token is missing', async () => {
        delete process.env.LUCY_HUGGINGFACE_API_KEY;

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.HUGGINGFACE
        });

        const result = await adapter.complete({
            messages: [{ role: 'user', content: 'Hello' }]
        });

        assert.equal(result.ok, false);
        assert.equal(result.code, 'missing_credentials');
        assert.match(result.error, /Missing API key for provider 'huggingface'/i);
    });

    await t.test('rejects remote HTTP endpoint for Hugging Face', async () => {
        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.HUGGINGFACE
        });
        process.env.LUCY_HUGGINGFACE_API_KEY = 'hf_valid_token_test_12345';

        try {
            assert.throws(() => {
                adapter.setHuggingFaceUrl('http://insecure-hf-router.com/v1');
            }, /must use HTTPS/i);
        } finally {
            delete process.env.LUCY_HUGGINGFACE_API_KEY;
        }
    });

    await t.test('handles 401 authentication failure and redacts token', async () => {
        const fakeToken = 'hf_secret_test_token_1234567890';
        globalThis.fetch = async () => {
            return new Response(JSON.stringify({ error: `Unauthorized access with ${fakeToken}` }), { status: 401 });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.HUGGINGFACE
        });
        process.env.LUCY_HUGGINGFACE_API_KEY = fakeToken;

        try {
            const res = await adapter.complete({
                messages: [{ role: 'user', content: 'Hi' }]
            });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'http_401');
            assert.match(res.error, /authentication failed/i);
            assert.ok(!res.error.includes(fakeToken), 'API key token must NOT be leaked in error message');
        } finally {
            delete process.env.LUCY_HUGGINGFACE_API_KEY;
        }
    });

    await t.test('handles 429 rate limit gracefully', async () => {
        globalThis.fetch = async () => {
            return new Response('Rate limit reached', { status: 429 });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.HUGGINGFACE
        });
        process.env.LUCY_HUGGINGFACE_API_KEY = 'hf_valid_token_test_12345';

        try {
            const res = await adapter.complete({
                messages: [{ role: 'user', content: 'Hi' }]
            });

            assert.equal(res.ok, false);
            assert.equal(res.code, 'http_429');
            assert.match(res.error, /rate limit/i);
        } finally {
            delete process.env.LUCY_HUGGINGFACE_API_KEY;
        }
    });

    await t.test('supports streaming inference on Hugging Face router', async () => {
        const sseData = [
            'data: {"choices":[{"delta":{"content":"HF "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"streaming "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"works!"}}]}\n\n',
            'data: [DONE]\n\n'
        ];

        globalThis.fetch = async (url, options) => {
            assert.equal(options.headers['Authorization'], 'Bearer hf_test_token_stream_12345');
            assert.equal(JSON.parse(options.body).stream, true);
            return new Response(createMockStream(sseData), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        };

        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.HUGGINGFACE,
            model: 'meta-llama/Llama-3.2-3B-Instruct'
        });
        process.env.LUCY_HUGGINGFACE_API_KEY = 'hf_test_token_stream_12345';

        try {
            const chunks = [];
            const res = await adapter.complete({
                messages: [{ role: 'user', content: 'Test stream' }],
                onChunk: (chunk) => chunks.push(chunk)
            });

            assert.equal(res.ok, true);
            assert.equal(res.content, 'HF streaming works!');
            assert.equal(chunks.length, 4);
            assert.equal(chunks[chunks.length - 1].done, true);
            assert.equal(res.cost.status, 'serverless_tier_or_account_billed');
        } finally {
            delete process.env.LUCY_HUGGINGFACE_API_KEY;
        }
    });
});
