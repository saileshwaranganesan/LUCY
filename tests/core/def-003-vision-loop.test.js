'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ProviderAdapter, PROVIDER_TYPES } = require('../../src/providers/provider-adapter.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { registerVisualTools } = require('../../src/tools/visual-tools.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { PermissionAuthority, PERMISSION_MODES, RISK_TIERS } = require('../../src/security/permission-authority.js');
const { MemoryStore } = require('../../src/memory/memory-store.js');
const { TaskContinuityStore } = require('../../src/memory/task-continuity-store.js');

// Tiny 1x1 transparent PNG in base64 (68 bytes)
const SAMPLE_1X1_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SAMPLE_DATA_URI = `data:image/png;base64,${SAMPLE_1X1_PNG_BASE64}`;

test('DEF-003: Visual Understanding & Multimodal Screenshot-to-Model Loop', async (suite) => {
    const testTempDir = path.join(os.tmpdir(), `lucy_def003_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testTempDir, { recursive: true });

    suite.after(() => {
        try {
            fs.rmSync(testTempDir, { recursive: true, force: true });
        } catch (_) {}
    });

    // =========================================================================
    // 1. PROVIDER ADAPTER MULTIMODAL NORMALIZATION & ENCODING
    // =========================================================================
    await suite.test('1. Multimodal normalization parses string content, image arrays, and data URIs', () => {
        const adapter = new ProviderAdapter({ provider: PROVIDER_TYPES.GEMINI });

        // A. Standard text message
        const textNorm = adapter._normalizeMultimodalMessage({ role: 'user', content: 'Hello world' });
        assert.equal(textNorm.isValid, true);
        assert.equal(textNorm.hasImages, false);
        assert.equal(textNorm.text, 'Hello world');
        assert.equal(textNorm.images.length, 0);

        // B. Convenience images array
        const imgNorm = adapter._normalizeMultimodalMessage({
            role: 'user',
            content: 'Describe this screenshot',
            images: [{ mimeType: 'image/png', data: SAMPLE_1X1_PNG_BASE64 }]
        });
        assert.equal(imgNorm.isValid, true);
        assert.equal(imgNorm.hasImages, true);
        assert.equal(imgNorm.text, 'Describe this screenshot');
        assert.equal(imgNorm.images.length, 1);
        assert.equal(imgNorm.images[0].mimeType, 'image/png');
        assert.equal(imgNorm.images[0].base64, SAMPLE_1X1_PNG_BASE64);
        assert.equal(imgNorm.images[0].dataUri, SAMPLE_DATA_URI);

        // C. OpenAI-style content parts array
        const openAiNorm = adapter._normalizeMultimodalMessage({
            role: 'user',
            content: [
                { type: 'text', text: 'Locate button' },
                { type: 'image_url', image_url: { url: SAMPLE_DATA_URI } }
            ]
        });
        assert.equal(openAiNorm.isValid, true);
        assert.equal(openAiNorm.hasImages, true);
        assert.equal(openAiNorm.text, 'Locate button');
        assert.equal(openAiNorm.images.length, 1);
        assert.equal(openAiNorm.images[0].base64, SAMPLE_1X1_PNG_BASE64);
    });

    await suite.test('2. Image validation enforces MIME type whitelist and payload size limits fail-closed', async () => {
        const adapter = new ProviderAdapter({ provider: PROVIDER_TYPES.GEMINI });

        // Unsupported MIME type
        const badMime = adapter._normalizeMultimodalMessage({
            role: 'user',
            content: 'Check',
            images: [{ mimeType: 'application/pdf', data: 'JVBERi0xLjQK' }]
        });
        assert.equal(badMime.isValid, false);
        assert.equal(badMime.code, 'invalid_image_mime');
        assert.match(badMime.error, /Unsupported image MIME type/);

        // Empty image data
        const emptyImg = adapter._normalizeMultimodalMessage({
            role: 'user',
            content: 'Check',
            images: [{ mimeType: 'image/png', data: '' }]
        });
        assert.equal(emptyImg.isValid, false);
        assert.equal(emptyImg.code, 'empty_image_data');

        // Oversized payload (> 4MB)
        const fakeHugeBase64 = 'A'.repeat(5.6 * 1024 * 1024); // ~4.2 MB decoded
        const hugeNorm = adapter._normalizeMultimodalMessage({
            role: 'user',
            content: 'Inspect huge',
            images: [{ mimeType: 'image/png', data: fakeHugeBase64 }]
        });
        assert.equal(hugeNorm.isValid, false);
        assert.equal(hugeNorm.code, 'image_payload_too_large');

        // complete() rejects invalid multimodal messages before network call
        const completeRes = await adapter.complete({
            messages: [
                {
                    role: 'user',
                    content: 'Test',
                    images: [{ mimeType: 'image/bmp', data: 'Qk0=' }]
                }
            ]
        });
        assert.equal(completeRes.ok, false);
        assert.equal(completeRes.code, 'invalid_image_mime');
    });

    await suite.test('3. Google Gemini formats inlineData parts with base64 image and text', async () => {
        let capturedBody = null;
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                role: 'model',
                                parts: [{ text: 'I see a desktop with Notepad open.' }]
                            }
                        }
                    ],
                    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, totalTokenCount: 140 }
                })
            };
        };

        try {
            const adapter = new ProviderAdapter({
                provider: PROVIDER_TYPES.GEMINI,
                credentialStore: { resolveApiKey: () => 'test_gemini_key', getSecret: () => 'test_gemini_key', redact: (s) => s }
            });

            const res = await adapter.complete({
                messages: [
                    {
                        role: 'user',
                        content: 'What is on this screen?',
                        images: [{ mimeType: 'image/png', data: SAMPLE_1X1_PNG_BASE64 }]
                    }
                ]
            });

            assert.equal(res.ok, true);
            assert.equal(res.content, 'I see a desktop with Notepad open.');
            assert.ok(capturedBody, 'Fetch body must be captured');
            assert.equal(capturedBody.contents.length, 1);

            const userContent = capturedBody.contents[0];
            assert.equal(userContent.role, 'user');
            assert.equal(userContent.parts.length, 2);
            assert.equal(userContent.parts[0].text, 'What is on this screen?');
            assert.deepEqual(userContent.parts[1], {
                inlineData: {
                    mimeType: 'image/png',
                    data: SAMPLE_1X1_PNG_BASE64
                }
            });
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    await suite.test('4. OpenAI/OpenRouter formats multimodal image_url parts with data URIs', async () => {
        let capturedBody = null;
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                role: 'assistant',
                                content: 'The active web page displays a student dashboard.'
                            }
                        }
                    ],
                    usage: { prompt_tokens: 150, completion_tokens: 25, total_tokens: 175 }
                })
            };
        };

        try {
            const adapter = new ProviderAdapter({
                provider: PROVIDER_TYPES.OPENROUTER,
                credentialStore: { resolveApiKey: () => 'test_openrouter_key', getSecret: () => 'test_openrouter_key', redact: (s) => s }
            });

            const res = await adapter.complete({
                messages: [
                    {
                        role: 'user',
                        content: 'Inspect page',
                        images: [{ mimeType: 'image/png', data: SAMPLE_1X1_PNG_BASE64 }]
                    }
                ]
            });

            assert.equal(res.ok, true);
            assert.equal(res.content, 'The active web page displays a student dashboard.');
            assert.ok(capturedBody);
            assert.equal(capturedBody.messages.length, 1);

            const userMsg = capturedBody.messages[0];
            assert.equal(userMsg.role, 'user');
            assert.ok(Array.isArray(userMsg.content));
            assert.equal(userMsg.content[0].type, 'text');
            assert.equal(userMsg.content[0].text, 'Inspect page');
            assert.equal(userMsg.content[1].type, 'image_url');
            assert.equal(userMsg.content[1].image_url.url, SAMPLE_DATA_URI);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    await suite.test('5. Ollama formats /api/chat payload with raw base64 images array', async () => {
        let capturedBody = null;
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    message: {
                        role: 'assistant',
                        content: 'Local vision model sees Calculator showing 42.'
                    },
                    prompt_eval_count: 80,
                    eval_count: 15
                })
            };
        };

        try {
            const adapter = new ProviderAdapter({
                provider: PROVIDER_TYPES.OLLAMA,
                model: 'llava:latest'
            });

            const res = await adapter.complete({
                messages: [
                    {
                        role: 'user',
                        content: 'Read number',
                        images: [{ mimeType: 'image/png', data: SAMPLE_1X1_PNG_BASE64 }]
                    }
                ]
            });

            assert.equal(res.ok, true);
            assert.equal(res.content, 'Local vision model sees Calculator showing 42.');
            assert.ok(capturedBody);
            assert.equal(capturedBody.messages.length, 1);

            const userMsg = capturedBody.messages[0];
            assert.equal(userMsg.role, 'user');
            assert.equal(userMsg.content, 'Read number');
            assert.ok(Array.isArray(userMsg.images));
            assert.equal(userMsg.images[0], SAMPLE_1X1_PNG_BASE64);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    await suite.test('6. Hugging Face reports unsupported_multimodal honestly for text-only models', async () => {
        const adapter = new ProviderAdapter({
            provider: PROVIDER_TYPES.HUGGINGFACE,
            model: 'Qwen/Qwen2.5-Coder-32B-Instruct',
            credentialStore: { resolveApiKey: () => 'hf_test_token', getSecret: () => 'hf_test_token', redact: (s) => s }
        });

        const res = await adapter.complete({
            messages: [
                {
                    role: 'user',
                    content: 'Explain image',
                    images: [{ mimeType: 'image/png', data: SAMPLE_1X1_PNG_BASE64 }]
                }
            ]
        });

        assert.equal(res.ok, false);
        assert.equal(res.code, 'unsupported_multimodal');
        assert.match(res.error, /does not support multimodal visual input/);
    });

    // =========================================================================
    // 2. VISUAL INSPECTION TOOL & RESOLUTION LIFECYCLE
    // =========================================================================
    await suite.test('7. visual_inspect resolves image from direct base64, file path, and dynamic capture', async () => {
        const testImagePath = path.join(testTempDir, 'test_screenshot.png');
        fs.writeFileSync(testImagePath, Buffer.from(SAMPLE_1X1_PNG_BASE64, 'base64'));

        let modelCalled = false;
        let lastReceivedImage = null;
        const mockAdapter = {
            complete: async (req) => {
                modelCalled = true;
                lastReceivedImage = req.messages[0].images[0];
                return {
                    ok: true,
                    content: 'Analysis: Login form with Username and Password fields.',
                    provider: 'gemini',
                    model: 'gemini-2.0-flash'
                };
            }
        };

        const mockBrowserManager = {
            screenshot: async () => ({
                ok: true,
                status: 'screenshot_captured',
                base64: SAMPLE_1X1_PNG_BASE64
            })
        };

        const mockDesktopManager = {
            takeScreenshot: async () => ({
                format: 'png',
                width: 800,
                height: 600,
                base64: SAMPLE_1X1_PNG_BASE64
            })
        };

        const registry = new ToolRegistry();
        registerVisualTools(registry, {
            providerAdapter: mockAdapter,
            browserManager: mockBrowserManager,
            desktopManager: mockDesktopManager
        });

        // A. Inspect with direct base64
        modelCalled = false;
        const resBase64 = await registry.execute('visual_inspect', {
            prompt: 'Identify buttons',
            imageBase64: SAMPLE_1X1_PNG_BASE64
        });
        assert.equal(resBase64.ok, true);
        assert.equal(modelCalled, true);
        assert.equal(resBase64.result.status, 'visual_analysis_complete');
        assert.equal(resBase64.result.analysis, 'Analysis: Login form with Username and Password fields.');
        assert.equal(lastReceivedImage.data, SAMPLE_1X1_PNG_BASE64);

        // B. Inspect with file path on disk
        modelCalled = false;
        const resPath = await registry.execute('visual_inspect', {
            prompt: 'Read text',
            imagePath: testImagePath
        });
        assert.equal(resPath.ok, true);
        assert.equal(modelCalled, true);
        assert.equal(resPath.result.source, `file:${testImagePath}`);

        // C. Dynamic browser capture
        modelCalled = false;
        const resBrowser = await registry.execute('visual_inspect', {
            prompt: 'Check page layout',
            target: 'browser'
        });
        assert.equal(resBrowser.ok, true);
        assert.equal(modelCalled, true);
        assert.equal(resBrowser.result.source, 'browser_viewport');

        // D. Dynamic desktop capture
        modelCalled = false;
        const resDesktop = await registry.execute('visual_inspect', {
            prompt: 'What app is open?',
            target: 'Notepad'
        });
        assert.equal(resDesktop.ok, true);
        assert.equal(modelCalled, true);
        assert.equal(resDesktop.result.source, 'desktop:Notepad');

        // E. Dry run simulation mechanically isolates from model call
        modelCalled = false;
        const resDryRun = await registry.execute('visual_inspect', {
            prompt: 'Dry run check',
            target: 'desktop'
        }, { dryRun: true });
        assert.equal(resDryRun.ok, true);
        assert.equal(resDryRun.dryRun, true);
        assert.equal(modelCalled, false, 'Dry run must not call AI model');
        assert.match(resDryRun.simulatedDetails.effect, /Would capture image/);
    });

    // =========================================================================
    // 3. TASK PLANNER INTENT DECOMPOSITION FOR VISUAL UNDERSTANDING
    // =========================================================================
    await suite.test('8. TaskPlanner plans direct visual requests, compound screenshot+analysis, and visual actions', async () => {
        const registry = new ToolRegistry();
        registerVisualTools(registry, {});
        registry.registerTool({
            id: 'desktop_take_screenshot',
            name: 'Desktop Screenshot',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: { target: { type: 'string' } } },
            handler: async () => ({})
        });
        registry.registerTool({
            id: 'desktop_click_element',
            name: 'Desktop Click',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            schema: { type: 'object', properties: { target: { type: 'string' }, name: { type: 'string' } } },
            handler: async () => ({})
        });
        registry.registerTool({
            id: 'browser_screenshot',
            name: 'Browser Screenshot',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
            handler: async () => ({})
        });
        const planner = new TaskPlanner({ toolRegistry: registry });

        // A. Direct visual inspection prompt
        const directPlan = await planner.plan('What is on my screen right now?');
        assert.equal(directPlan.type, 'plan');
        assert.equal(directPlan.steps.length, 1);
        assert.equal(directPlan.steps[0].toolId, 'visual_inspect');
        assert.equal(directPlan.steps[0].params.target, 'desktop');

        // B. Browser visual inspection
        const browserVisualPlan = await planner.plan('Look at the website and summarize what is visible');
        assert.equal(browserVisualPlan.type, 'plan');
        assert.equal(browserVisualPlan.steps[0].toolId, 'visual_inspect');
        assert.equal(browserVisualPlan.steps[0].params.target, 'browser');

        // C. Compound screenshot + explain request
        const compoundScreenshotPlan = await planner.plan('Take a screenshot of Calculator and tell me the result displayed');
        assert.equal(compoundScreenshotPlan.type, 'plan');
        assert.equal(compoundScreenshotPlan.steps.length, 2);
        assert.equal(compoundScreenshotPlan.steps[0].toolId, 'desktop_take_screenshot');
        assert.equal(compoundScreenshotPlan.steps[0].params.target, 'Calculator');
        assert.equal(compoundScreenshotPlan.steps[1].toolId, 'visual_inspect');
        assert.equal(compoundScreenshotPlan.steps[1].params.target, 'Calculator');

        // D. Compound visual inspection + consequential action
        const visualActionPlan = await planner.plan('Look at screen and click Submit');
        assert.equal(visualActionPlan.type, 'plan');
        assert.equal(visualActionPlan.steps.length, 2);
        assert.equal(visualActionPlan.steps[0].toolId, 'visual_inspect');
        assert.equal(visualActionPlan.steps[1].toolId, 'desktop_click_element');
        assert.equal(visualActionPlan.steps[1].params.name, 'Submit');
    });

    // =========================================================================
    // 4. END-TO-END EXECUTION & PERMISSION GATE SAFETY
    // =========================================================================
    await suite.test('9. TaskCoordinator executes visual inspection end-to-end and enforces permission gates on follow-up actions', async () => {
        const authority = new PermissionAuthority({
            mode: PERMISSION_MODES.STANDARD
        });

        // Deny interactive permission to test fail-closed security gate
        let permissionPrompted = false;
        authority.setConfirmationHandler(async (request) => {
            permissionPrompted = true;
            return false; // Deny permission
        });

        const registry = new ToolRegistry({ permissionAuthority: authority });
        const mockAdapter = {
            complete: async () => ({
                ok: true,
                content: 'Found Submit button at center bottom.',
                provider: 'gemini',
                model: 'gemini-2.0-flash'
            })
        };

        const mockDesktopManager = {
            takeScreenshot: async () => ({ format: 'png', base64: SAMPLE_1X1_PNG_BASE64 }),
            clickElement: async () => ({ ok: true, status: 'clicked' })
        };

        registerVisualTools(registry, {
            providerAdapter: mockAdapter,
            desktopManager: mockDesktopManager
        });

        // Register desktop click tool
        registry.registerTool({
            id: 'desktop_click_element',
            name: 'Desktop Click',
            riskTier: RISK_TIERS.CONSEQUENTIAL,
            schema: { type: 'object', properties: { target: { type: 'string' }, name: { type: 'string' } } },
            handler: async () => mockDesktopManager.clickElement()
        });

        const isolatedMemoryDir = path.join(testTempDir, 'coord_mem');
        fs.mkdirSync(isolatedMemoryDir, { recursive: true });

        const coordinator = new TaskCoordinator({
            permissionAuthority: authority,
            toolRegistry: registry,
            providerAdapter: mockAdapter,
            memoryDir: isolatedMemoryDir
        });

        // 1. Pure Visual Inspection: SAFE_READ -> executes without permission prompt
        permissionPrompted = false;
        const visualResult = await coordinator.executeRequest('Inspect the screen and tell me what you see');
        assert.equal(visualResult.ok, true);
        assert.equal(permissionPrompted, false, 'SAFE_READ visual inspection should not prompt for permission');
        assert.equal(visualResult.status, 'completed');
        assert.ok(visualResult.replyText.includes('Found Submit button'));

        // 2. Compound Visual Inspection + Consequential Action: SAFE_READ succeeds, then CONSEQUENTIAL prompts
        permissionPrompted = false;
        const compoundResult = await coordinator.executeRequest('Look at screen and click Submit');

        // Step 1 (visual_inspect) succeeded, but Step 2 (desktop_click_element) prompted and was denied!
        assert.equal(permissionPrompted, true, 'Consequential click action must prompt for interactive permission');
        assert.equal(compoundResult.ok, false, 'Declined consequential action must fail closed');
        assert.equal(compoundResult.status, 'failed');
        assert.match(compoundResult.error, /permission (?:denied|declined)|declined permission/i);
    });
});
