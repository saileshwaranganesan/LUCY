'use strict';

/**
 * Kokoro-82M ONNX Benchmark & Resource Profiler for L.U.C.Y.
 * Measures on-device metrics on this actual machine.
 */

const { KokoroTtsService } = require('../src/voice/kokoro-tts-service.js');
const os = require('os');

async function runBenchmark() {
    console.log('===============================================================');
    console.log('       L.U.C.Y. Kokoro-82M ONNX TTS Benchmark & Profiler       ');
    console.log('===============================================================');
    console.log(`OS:              ${os.type()} ${os.release()} (${os.arch()})`);
    console.log(`CPU:             ${os.cpus()[0]?.model || 'Unknown'} (${os.cpus().length} logical cores)`);
    console.log(`Total RAM:       ${(os.totalmem() / (1024 ** 3)).toFixed(2)} GB`);
    console.log(`Free RAM:        ${(os.freemem() / (1024 ** 3)).toFixed(2)} GB`);
    console.log('---------------------------------------------------------------\n');

    const service = new KokoroTtsService({ threads: 6, idleUnloadTimeoutMs: 15000 });

    try {
        console.log('[Step 1] Model & Voice Assets Inspection...');
        console.log(`  Model File:    ${service.modelPath}`);
        console.log(`  Voice File:    ${service.voicePath}`);
        console.log(`  Available:     ${service.isAvailable()}`);
        console.log(`  Default Voice: ${service.voiceName}\n`);

        console.log('[Step 2] Cold Start (Worker Spawn & Model Load)...');
        const t0 = Date.now();
        const loadOk = await service.loadModel();
        const coldStartMs = Date.now() - t0;
        const memAfterLoad = service.lastMemoryInfo;
        console.log(`  Load Status:   ${loadOk ? 'SUCCESS' : 'FAILED'}`);
        console.log(`  Cold Start:    ${coldStartMs} ms`);
        console.log(`  Worker RAM:    ${memAfterLoad?.rss_mb} MB RSS\n`);

        const testPhrases = [
            { label: 'Short Utterance', text: 'Task completed.' },
            { label: 'Medium Sentence', text: 'Hello! I am Lucy, your autonomous desktop assistant and companion.' },
            { label: 'Multi-Clause Query', text: 'I checked your active workspace, organized the files, and created the requested study session.' }
        ];

        console.log('[Step 3] Inference Latency & Audio Generation Benchmarks:');
        let peakRss = memAfterLoad?.rss_mb || 0;

        for (const item of testPhrases) {
            let synthMetrics = null;
            const onSynth = (m) => { synthMetrics = m; };
            service.once('synthesized', onSynth);

            const tStart = Date.now();
            await service.speak(item.text);
            const totalElapsed = Date.now() - tStart;

            if (synthMetrics) {
                if (synthMetrics.memory?.rss_mb > peakRss) {
                    peakRss = synthMetrics.memory.rss_mb;
                }
                console.log(`  --- ${item.label} ---`);
                console.log(`      Text:       "${item.text}" (${item.text.length} chars)`);
                console.log(`      Audio:      ${synthMetrics.duration} s (${synthMetrics.sample_rate || 24000} Hz)`);
                console.log(`      Latency:    ${synthMetrics.latency} ms`);
                console.log(`      RTF:        ${synthMetrics.rtf}x real-time`);
                console.log(`      Worker RAM: ${synthMetrics.memory?.rss_mb} MB RSS`);
            }
        }

        console.log('\n[Step 4] Memory-Aware Lifecycle & Unload Verification...');
        console.log(`  Peak RSS during synthesis: ${peakRss} MB`);
        const unloadOk = await service.unloadModel();
        const memAfterUnload = service.lastMemoryInfo;
        console.log(`  Explicit Unload:           ${unloadOk ? 'SUCCESS' : 'FAILED'}`);
        console.log(`  Worker RAM after unload:   ${memAfterUnload?.rss_mb} MB RSS`);
        console.log(`  RAM Reclaimed:             ${(peakRss - (memAfterUnload?.rss_mb || 0)).toFixed(2)} MB\n`);

        console.log('[Step 5] Safe Cancellation Test...');
        const p1 = service.speak('This utterance will be cancelled mid-flight.');
        service.stop();
        const cancelRes = await p1;
        console.log(`  Cancellation Result:       ${cancelRes === false ? 'PASS (Cancelled cleanly)' : 'FAIL'}`);

        console.log('\n===============================================================');
        console.log('                    BENCHMARK COMPLETED                        ');
        console.log('===============================================================');
    } finally {
        service.dispose();
    }
}

runBenchmark().catch(console.error);
