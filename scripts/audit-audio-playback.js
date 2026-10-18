'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const PACKAGED_EXE = path.resolve(__dirname, '..', 'dist-release', 'win-unpacked', 'LUCY.exe');
const TEMP_USER_DATA = path.resolve(__dirname, '..', '.test-scratch', 'temp-audio-audit-data');
const DEBUG_PORT = 9555;

async function waitHttp(url, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.get(url, (res) => {
                    if (res.statusCode === 200) resolve();
                    else reject(new Error('Status ' + res.statusCode));
                });
                req.on('error', reject);
                req.end();
            });
            return true;
        } catch (_) {
            await new Promise((r) => setTimeout(r, 400));
        }
    }
    return false;
}

async function main() {
    console.log('=== L.U.C.Y. Audio Playback Forensic Audit ===');
    fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

    console.log(`Spawning ${PACKAGED_EXE} on port ${DEBUG_PORT}...`);
    const proc = spawn(PACKAGED_EXE, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${TEMP_USER_DATA}`,
        '--no-sandbox'
    ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (d) => {
        const s = d.toString().trim();
        if (s && !s.includes('libpng')) console.log('[STDOUT]', s);
    });
    proc.stderr.on('data', (d) => {
        const s = d.toString().trim();
        if (s && !s.includes('libpng')) console.log('[STDERR]', s);
    });

    try {
        const ready = await waitHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 25000);
        if (!ready) throw new Error('App failed to respond on CDP port');

        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
        const pages = browser.contexts()[0].pages();
        const mainPage = pages.find((p) => p.url().includes('index.html')) || pages[0];
        console.log('Connected to page:', mainPage.url());

        // Run deep audit in renderer context
        const auditReport = await mainPage.evaluate(async () => {
            const report = {
                mediaDevices: [],
                audioContextInitialState: null,
                audioContextResumedState: null,
                autoplayPolicy: null,
                synthesizeResult: null,
                plainAudioPlayResult: null,
                webAudioPlayResult: null,
                voiceControllerSpeakResult: null,
                consoleLogs: []
            };

            // 1. Enumerate media devices (speakers / audio output)
            try {
                if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    report.mediaDevices = devices.map(d => ({
                        kind: d.kind,
                        label: d.label,
                        deviceId: d.deviceId,
                        groupId: d.groupId
                    }));
                } else {
                    report.mediaDevices = 'navigator.mediaDevices not available';
                }
            } catch (e) {
                report.mediaDevices = 'Error enumerating: ' + e.message;
            }

            // 2. AudioContext baseline
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (AudioCtx) {
                    const ctx = new AudioCtx();
                    report.audioContextInitialState = ctx.state;
                    report.sampleRate = ctx.sampleRate;
                    await ctx.resume().catch(e => report.audioContextResumeError = e.message);
                    report.audioContextResumedState = ctx.state;
                }
            } catch (e) {
                report.audioContextInitialState = 'Error: ' + e.message;
            }

            // 3. Synthesize a short phrase
            try {
                const synth = await window.lucyIpc.synthesizeSpeech('Hello from Lucy audit', { voice: 'af_bella' });
                report.synthesizeResult = {
                    ok: synth.ok,
                    hasAudio: Boolean(synth.audio),
                    audioLength: synth.audio ? synth.audio.length : 0,
                    audioPrefix: synth.audio ? synth.audio.slice(0, 40) : null,
                    duration_s: synth.duration_s,
                    error: synth.error
                };

                if (synth.ok && synth.audio) {
                    // Test 3a: Plain HTMLAudioElement playback (no AudioContext / createMediaElementSource)
                    try {
                        const a = new Audio(synth.audio);
                        a.volume = 1.0;
                        const playPromise = a.play();
                        report.plainAudioPlayResult = {
                            startedPromise: playPromise ? 'promise returned' : 'null',
                            pausedBefore: a.paused
                        };
                        await playPromise;
                        report.plainAudioPlayResult.resolved = true;
                        report.plainAudioPlayResult.pausedAfterPlay = a.paused;
                        report.plainAudioPlayResult.duration = a.duration;
                        report.plainAudioPlayResult.currentTime = a.currentTime;
                        // Let it play briefly
                        await new Promise(r => setTimeout(r, 600));
                        report.plainAudioPlayResult.currentTimeAfter600ms = a.currentTime;
                        a.pause();
                    } catch (e) {
                        report.plainAudioPlayResult = { error: e.name + ': ' + e.message };
                    }

                    // Test 3b: Playback with createMediaElementSource
                    try {
                        const AudioCtx = window.AudioContext || window.webkitAudioContext;
                        const ctx = new AudioCtx();
                        if (ctx.state === 'suspended') await ctx.resume();
                        const a2 = new Audio(synth.audio);
                        const src = ctx.createMediaElementSource(a2);
                        const analyser = ctx.createAnalyser();
                        src.connect(analyser);
                        analyser.connect(ctx.destination);
                        await a2.play();
                        report.webAudioPlayResult = {
                            ctxState: ctx.state,
                            paused: a2.paused,
                            currentTime: a2.currentTime
                        };
                        await new Promise(r => setTimeout(r, 600));
                        report.webAudioPlayResult.currentTimeAfter600ms = a2.currentTime;
                        a2.pause();
                        src.disconnect();
                        await ctx.close();
                    } catch (e) {
                        report.webAudioPlayResult = { error: e.name + ': ' + e.message };
                    }

                    // Test 3c: VoiceController.speak()
                    if (window.voiceController) {
                        try {
                            const vc = window.voiceController;
                            let onStartFired = false;
                            const vcRes = await vc.speak('Lucy voice controller test', {
                                isPreview: true,
                                onStart: () => { onStartFired = true; }
                            });
                            report.voiceControllerSpeakResult = {
                                returned: vcRes,
                                onStartFired,
                                finalState: vc.voiceState,
                                isSpeaking: vc.isSpeaking
                            };
                        } catch (e) {
                            report.voiceControllerSpeakResult = { error: e.name + ': ' + e.message };
                        }
                    }
                }
            } catch (e) {
                report.synthesizeResult = { error: e.message };
            }

            return report;
        });

        console.log('AUDIT REPORT:\n', JSON.stringify(auditReport, null, 2));

        await browser.close();
    } finally {
        proc.kill();
        try { fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true }); } catch (_) {}
    }
}

main().catch(err => {
    console.error('Audit failed with error:', err);
    process.exit(1);
});
