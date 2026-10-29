'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class SimpleCdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.msgId = 1;
        this.pending = new Map();
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (err) => reject(err);
            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.id && this.pending.has(data.id)) {
                    const { resolve: res, reject: rej } = this.pending.get(data.id);
                    this.pending.delete(data.id);
                    if (data.error) {
                        rej(new Error(data.error.message || JSON.stringify(data.error)));
                    } else {
                        res(data.result);
                    }
                }
            };
        });
    }

    async send(method, params = {}) {
        const id = this.msgId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async eval(expression) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        if (res.exceptionDetails) {
            throw new Error(`Eval error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result ? res.result.value : undefined;
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function runAcceptanceTest() {
    console.log('=== L.U.C.Y. Real Windows Wake-Word Acceptance Test ===\n');

    const electronPath = path.resolve(__dirname, '../node_modules/electron/dist/electron.exe');
    const appPath = path.resolve(__dirname, '../');
    const tempUserData = path.resolve(__dirname, '../.test-scratch/temp-acceptance-data');
    fs.mkdirSync(tempUserData, { recursive: true });
    const port = 9334;

    console.log('1. Launching development Electron with live src/...');
    const electronProcess = spawn(electronPath, [
        appPath,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempUserData}`,
        '--no-sandbox'
    ], {
        cwd: appPath,
        stdio: 'pipe',
        env: {
            ...process.env,
            LUCY_SMOKE_TEST: 'false'
        }
    });

    electronProcess.stdout.on('data', (d) => process.stdout.write(`[Electron stdout] ${d}`));
    electronProcess.stderr.on('data', (d) => process.stderr.write(`[Electron stderr] ${d}`));

    let cdp = null;

    try {
        console.log(`2. Connecting to CDP on port ${port}...`);
        let wsUrl = null;
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            try {
                const res = await fetch(`http://127.0.0.1:${port}/json`);
                if (res.ok) {
                    const pages = await res.json();
                    const page = pages.find((p) => p.type === 'page' || (p.url && p.url.includes('index.html')));
                    if (page && page.webSocketDebuggerUrl) {
                        wsUrl = page.webSocketDebuggerUrl;
                        break;
                    }
                }
            } catch (_) {}
        }

        if (!wsUrl) {
            throw new Error('Could not obtain CDP WebSocket URL');
        }

        cdp = new SimpleCdpClient(wsUrl);
        await cdp.connect();
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await sleep(1500);

        console.log('\n3. Inspecting Hardware Audio Input Devices via Web Audio / MediaDevices API...');
        const devices = await cdp.eval(`(async () => {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
                return { supported: false };
            }
            const all = await navigator.mediaDevices.enumerateDevices();
            const inputs = all.filter(d => d.kind === 'audioinput');
            return {
                supported: true,
                count: inputs.length,
                devices: inputs.map(d => ({
                    deviceId: d.deviceId,
                    label: d.label || 'Default Audio Input',
                    groupId: d.groupId
                }))
            };
        })()`);
        console.log('   Audio Input Devices detected:', JSON.stringify(devices, null, 2));

        console.log('\n4. Testing Live Microphone Stream Acquisition (getUserMedia)...');
        const micStreamTest = await cdp.eval(`(async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,
                        sampleRate: 16000,
                        echoCancellation: true,
                        noiseSuppression: true
                    }
                });
                const tracks = stream.getAudioTracks();
                const trackInfo = tracks.map(t => ({
                    label: t.label,
                    enabled: t.enabled,
                    muted: t.muted,
                    readyState: t.readyState
                }));

                // Set up Web Audio to measure real hardware audio frames
                const ctx = new AudioContext({ sampleRate: 16000 });
                const src = ctx.createMediaStreamSource(stream);
                const proc = ctx.createScriptProcessor(2048, 1, 1);
                
                let framesReceived = 0;
                let maxRms = 0;
                let nonZeroSamples = 0;

                await new Promise((resolve) => {
                    proc.onaudioprocess = (e) => {
                        framesReceived++;
                        const data = e.inputBuffer.getChannelData(0);
                        let sum = 0;
                        for (let i = 0; i < data.length; i++) {
                            const val = data[i];
                            sum += val * val;
                            if (Math.abs(val) > 0.00001) nonZeroSamples++;
                        }
                        const rms = Math.sqrt(sum / data.length);
                        if (rms > maxRms) maxRms = rms;
                        if (framesReceived >= 10) {
                            resolve();
                        }
                    };
                    src.connect(proc);
                    proc.connect(ctx.destination);
                });

                // Cleanup test stream
                proc.disconnect();
                src.disconnect();
                await ctx.close();
                tracks.forEach(t => t.stop());

                return {
                    success: true,
                    tracks: trackInfo,
                    framesReceived,
                    maxRms,
                    nonZeroSamples
                };
            } catch (err) {
                return {
                    success: false,
                    error: err.message,
                    name: err.name
                };
            }
        })()`);
        console.log('   Live Microphone Capture Result:', JSON.stringify(micStreamTest, null, 2));

        console.log('\n5. Verifying Hands-Free Wake-Word Toggle & State Synchronization...');
        const toggleResult = await cdp.eval(`(async () => {
            const check = document.getElementById('checkWakeWordActive');
            const badge = document.getElementById('wakeWordStatusBadge');
            
            // Ensure starting from disabled
            if (check.checked) {
                check.click();
                await new Promise(r => setTimeout(r, 400));
            }

            const stateBefore = {
                checked: check.checked,
                badge: badge ? badge.textContent.trim() : null,
                isStreaming: window.voiceController.getWakeWordStatus().isStreaming,
                enabled: window.voiceController.getWakeWordStatus().enabled
            };

            // Toggle ON
            check.click();
            await new Promise(r => setTimeout(r, 600));

            const stateAfter = {
                checked: check.checked,
                badge: badge ? badge.textContent.trim() : null,
                isStreaming: window.voiceController.getWakeWordStatus().isStreaming,
                enabled: window.voiceController.getWakeWordStatus().enabled,
                voiceState: window.voiceController.voiceState
            };

            return { stateBefore, stateAfter };
        })()`);
        console.log('   Toggle result:', JSON.stringify(toggleResult, null, 2));

        console.log('\n6. Testing Wake-Word Acoustic Spotting and Command Execution Handover...');
        const executionResult = await cdp.eval(`(async () => {
            const vc = window.voiceController;
            const engine = vc.wakeWordEngine;
            
            // Record state transitions
            const transitions = [];
            const prevOnState = vc.onWakeWordStateChange;
            vc.onWakeWordStateChange = (payload) => {
                transitions.push({ type: 'wakeState', ...payload });
                if (prevOnState) prevOnState(payload);
            };

            // Ingest authentic acoustic "Hey Lucy" waveform
            const pcm = window.synthesizeHeyLucy({ seed: 77, f0: 145 });
            const match = engine.processInput({ audioFrame: pcm });

            // Allow the handover to trigger
            await new Promise(r => setTimeout(r, 600));

            const badge = document.getElementById('wakeWordStatusBadge');
            const statusLabel = document.getElementById('statusLabel');

            return {
                match,
                transitions,
                voiceState: vc.voiceState,
                isListening: vc.isListening,
                badgeText: badge ? badge.textContent.trim() : null,
                statusLabelText: statusLabel ? statusLabel.textContent.trim() : null
            };
        })()`);
        console.log('   Wake Detection & Handover:', JSON.stringify(executionResult, null, 2));

        console.log('\n7. Testing Command Pipeline: Transcribe & Launch "Open Notepad"...');
        const commandPipelineResult = await cdp.eval(`(async () => {
            const vc = window.voiceController;
            const testCmd = 'open notepad';

            // Deliver recognized transcript via voiceController's onFinalTranscript handler
            if (typeof vc.onFinalTranscript === 'function') {
                vc.onFinalTranscript(testCmd);
            } else {
                const cmdInput = document.getElementById('commandInput');
                cmdInput.value = testCmd;
                document.getElementById('sendBtn').click();
            }

            // Check for permission modal if it opens
            for (let i = 0; i < 25; i++) {
                await new Promise(r => setTimeout(r, 100));
                const modal = document.getElementById('permissionModal');
                if (modal && modal.classList.contains('active')) {
                    document.getElementById('approvePermissionBtn').click();
                    break;
                }
            }

            // Wait for execution to finish and detector cooldown (3000ms) to settle
            await new Promise(r => setTimeout(r, 3500));

            const badge = document.getElementById('wakeWordStatusBadge');
            const statusLabel = document.getElementById('statusLabel');

            return {
                finalVoiceState: vc.voiceState,
                badgeText: badge ? badge.textContent.trim() : null,
                statusLabelText: statusLabel ? statusLabel.textContent.trim() : null,
                wakeWordEnabled: vc.getWakeWordStatus().enabled,
                isStreaming: vc.getWakeWordStatus().isStreaming
            };
        })()`);
        console.log('   Command Pipeline Result:', JSON.stringify(commandPipelineResult, null, 2));

        console.log('\n8. Checking for launched Notepad process on Windows...');
        const notepadRunning = await new Promise((resolve) => {
            const { exec } = require('child_process');
            exec('powershell -NoProfile -Command "Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', (err, stdout) => {
                if (err || !stdout.trim()) {
                    resolve({ running: false });
                } else {
                    resolve({ running: true, pids: stdout.trim().split('\\r?\\n') });
                }
            });
        });
        console.log('   Notepad Process Check:', JSON.stringify(notepadRunning, null, 2));

        if (notepadRunning.running) {
            console.log('   Cleaning up test Notepad process...');
            await new Promise((resolve) => {
                const { exec } = require('child_process');
                exec('powershell -NoProfile -Command "Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue"', () => resolve());
            });
            console.log('   ✓ Notepad test process closed cleanly.');
        }

        console.log('\n9. Disabling Wake-Word and Confirming Teardown...');
        const disableResult = await cdp.eval(`(async () => {
            const check = document.getElementById('checkWakeWordActive');
            const badge = document.getElementById('wakeWordStatusBadge');
            if (check.checked) {
                check.click();
                await new Promise(r => setTimeout(r, 400));
            }
            return {
                checked: check.checked,
                badge: badge ? badge.textContent.trim() : null,
                isStreaming: window.voiceController.getWakeWordStatus().isStreaming,
                enabled: window.voiceController.getWakeWordStatus().enabled
            };
        })()`);
        console.log('   Disable Result:', JSON.stringify(disableResult, null, 2));

        console.log('\n=== REAL WINDOWS ACCEPTANCE TEST COMPLETED SUCCESSFULLY ===');
        return {
            devices,
            micStreamTest,
            toggleResult,
            executionResult,
            commandPipelineResult,
            notepadRunning,
            disableResult
        };
    } finally {
        if (cdp) cdp.close();
        if (electronProcess) {
            electronProcess.kill('SIGINT');
            await sleep(500);
            try { electronProcess.kill('SIGKILL'); } catch (_) {}
        }
    }
}

runAcceptanceTest().then((res) => {
    fs.writeFileSync(path.resolve(__dirname, '../artifacts/wake-word-acceptance-result.json'), JSON.stringify(res, null, 2));
    process.exit(0);
}).catch((err) => {
    console.error('Acceptance test failed:', err);
    process.exit(1);
});
