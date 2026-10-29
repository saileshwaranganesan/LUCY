'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { KokoroTtsService } = require('../../src/voice/kokoro-tts-service.js');

test('Kokoro-82M ONNX Local TTS Architecture & Lifecycle Suite', async (t) => {
    let service;

    t.afterEach(() => {
        if (service) {
            service.dispose();
            service = null;
        }
    });

    await t.test('1. Model files presence and availability check', () => {
        service = new KokoroTtsService();
        assert.equal(typeof service.isAvailable(), 'boolean');
        const available = service.isAvailable();
        assert.equal(available, true, 'Kokoro INT8 ONNX weights and voice pack should be present');
    });

    await t.test('2. On-demand initialization: Worker and model are not loaded until requested', () => {
        service = new KokoroTtsService();
        assert.equal(service.isLoaded, false);
        assert.equal(service.isSpeaking, false);
        assert.equal(service.workerProcess, null);
    });

    await t.test('3. Separate worker process lifecycle and explicit model loading', async () => {
        service = new KokoroTtsService({ threads: 4 });
        const loaded = await service.loadModel();
        assert.equal(loaded, true);
        assert.equal(service.isLoaded, true);
        assert.ok(service.workerProcess);
        assert.ok(!service.workerProcess.killed);

        const mem = service.lastMemoryInfo;
        assert.ok(mem);
        assert.ok(typeof mem.rss_mb === 'number');
        assert.ok(mem.rss_mb > 50, `RSS memory ${mem.rss_mb} MB should be recorded`);
    });

    await t.test('4. On-demand speech synthesis and audio generation', async () => {
        service = new KokoroTtsService({ threads: 4 });
        let synthesizedEvent = null;
        service.on('synthesized', (data) => {
            synthesizedEvent = data;
        });

        const success = await service.speak('Hello from Lucy.');
        assert.equal(success, true);
        assert.ok(synthesizedEvent);
        assert.ok(synthesizedEvent.duration > 0);
        assert.ok(synthesizedEvent.latency > 0);
        assert.ok(synthesizedEvent.memory.rss_mb > 0);
    });

    await t.test('5. Sequential speech queueing without overlap', async () => {
        service = new KokoroTtsService({ threads: 4 });
        const order = [];

        service.on('synthesized', (data) => {
            order.push(data.text);
        });

        const p1 = service.speak('First message.');
        const p2 = service.speak('Second message.');

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, true);
        assert.equal(r2, true);
        assert.deepEqual(order, ['First message.', 'Second message.']);
    });

    await t.test('6. Immediate cancellation and queue clearing on stop()', async () => {
        service = new KokoroTtsService({ threads: 4 });
        const p1 = service.speak('Very long speech utterance that will be interrupted.');
        const p2 = service.speak('Queued message that should be dropped.');

        // Stop immediately
        service.stop();

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, false);
        assert.equal(r2, false);
        assert.equal(service.isSpeaking, false);
    });

    await t.test('7. Memory-aware explicit unloading and memory reclamation', async () => {
        service = new KokoroTtsService({ threads: 4 });
        await service.loadModel();
        assert.equal(service.isLoaded, true);
        const ramBefore = service.lastMemoryInfo.rss_mb;

        const unloaded = await service.unloadModel();
        assert.equal(unloaded, true);
        assert.equal(service.isLoaded, false);

        const ramAfter = service.lastMemoryInfo.rss_mb;
        assert.ok(ramAfter < ramBefore, `RAM after unload (${ramAfter} MB) should be lower than loaded (${ramBefore} MB)`);
    });

    await t.test('8. Automatic idle unload after timeout', async () => {
        service = new KokoroTtsService({
            threads: 4,
            idleUnloadTimeoutMs: 100 // 100ms for test speed
        });

        await service.loadModel();
        assert.equal(service.isLoaded, true);

        // Trigger idle timer reset
        service._resetIdleTimer();

        // Wait up to 1500ms for idle timer to fire and worker to unload
        for (let i = 0; i < 30; i++) {
            if (!service.isLoaded) break;
            await new Promise((r) => setTimeout(r, 50));
        }

        assert.equal(service.isLoaded, false, 'Model should automatically unload after idle timeout');
    });

    await t.test('9. Transparent fallback to native speech facility if model path is invalid', async () => {
        let fallbackSpoke = false;
        const mockFallback = {
            speak: async (text) => {
                fallbackSpoke = true;
                return true;
            },
            stop: () => {}
        };

        service = new KokoroTtsService({
            modelPath: path.resolve(__dirname, 'nonexistent-model.onnx'),
            fallbackService: mockFallback
        });

        const res = await service.speak('Fallback test');
        assert.equal(res, true);
        assert.equal(fallbackSpoke, true, 'Should invoke fallback service when model is absent');
    });

    await t.test('10. Transparent fallback when memory budget is exceeded', async () => {
        let fallbackSpoke = false;
        const mockFallback = {
            speak: async (text) => {
                fallbackSpoke = true;
                return true;
            },
            stop: () => {}
        };

        service = new KokoroTtsService({
            maxRssMb: 10, // Unreasonably low budget to trigger guard
            fallbackService: mockFallback
        });

        // Set artificially high memory
        service.lastMemoryInfo = { rss_mb: 500, system_available_mb: 2000 };

        const res = await service.speak('Budget test');
        assert.equal(res, true);
        assert.equal(fallbackSpoke, true, 'Should fall back to native speech when memory budget is exceeded');
    });
});
