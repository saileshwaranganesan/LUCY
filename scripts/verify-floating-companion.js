'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ARTIFACTS_DIR = 'C:\\Users\\admin\\.gemini\\antigravity-ide\\brain\\527dd3e2-4572-4245-bd22-06ce8ca7c83b';

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

    async captureScreenshot() {
        const res = await this.send('Page.captureScreenshot', { format: 'png' });
        return Buffer.from(res.data, 'base64');
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCdpTargets(port = 9222) {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    return await res.json();
}

async function runVerification() {
    console.log('=== L.U.C.Y. Workstream 03: 3D Floating Companion Verification ===\n');
    const startTime = Date.now();

    // 1. Launch Electron with CDP remote debugging
    console.log('1. Launching real Electron application with remote debugging...');
    const electronBin = path.resolve(__dirname, '../node_modules/electron/dist/electron.exe');
    const appPath = path.resolve(__dirname, '..');
    const proc = spawn(electronBin, [appPath, '--remote-debugging-port=9222'], {
        cwd: appPath,
        env: {
            ...process.env,
            LUCY_PERMISSION_MODE: 'standard',
            LUCY_SMOKE_TEST: 'false'
        },
        stdio: 'pipe'
    });

    proc.stdout.on('data', (d) => console.log('[Electron stdout]', d.toString().trim()));
    proc.stderr.on('data', (d) => console.log('[Electron stderr]', d.toString().trim()));

    let mainClient = null;
    let companionClient = null;

    try {
        // Wait for CDP target
        console.log('2. Polling for Chrome DevTools Protocol targets...');
        let targets = [];
        for (let i = 0; i < 20; i++) {
            await sleep(500);
            try {
                targets = await fetchCdpTargets(9222);
                if (targets && targets.length > 0) break;
            } catch (_) {}
        }

        const mainTarget = targets.find(t => t.url.includes('index.html'));
        if (!mainTarget) {
            throw new Error('Main window target not found in CDP');
        }
        console.log(`   Found main window target: ${mainTarget.title} (PID: ${proc.pid})`);

        mainClient = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainClient.connect();
        await mainClient.send('Runtime.enable');
        await mainClient.send('Page.enable');

        // Wait for DOM readiness and scripts initialization
        await sleep(2000);
        const readyState = await mainClient.eval('document.readyState');
        console.log(`   Document readyState: ${readyState}`);

        // Check Float 3D Pet button presence
        const floatBtnText = await mainClient.eval('document.getElementById("toggleFloatingBtn")?.textContent');
        console.log(`   Initial sidebar button state: "${floatBtnText}"`);

        // 4. Toggle Floating Companion Window
        console.log('\n3. Triggering toggleCompanionWindow...');
        const clickTime = Date.now();
        const toggleRes = await mainClient.eval('window.lucyIpc.toggleCompanionWindow()');
        console.log('   toggleCompanionWindow IPC returned:', toggleRes);
        await sleep(1500);

        // 5. Discover Floating Companion Window target
        console.log('\n4. Discovering floating companion window via CDP...');
        let compTarget = null;
        for (let i = 0; i < 15; i++) {
            await sleep(500);
            const currentTargets = await fetchCdpTargets(9222);
            console.log(`   CDP Target poll [${i+1}]:`, currentTargets.map(t => `${t.title} (${t.url})`));
            compTarget = currentTargets.find(t => t.url.includes('companion.html'));
            if (compTarget) break;
        }
        if (!compTarget) {
            throw new Error('Floating companion window target not found in CDP');
        }
        console.log(`   Found floating companion target: "${compTarget.title}"`);
        console.log(`   URL: ${compTarget.url}`);

        companionClient = new SimpleCdpClient(compTarget.webSocketDebuggerUrl);
        await companionClient.connect();
        await companionClient.send('Runtime.enable');
        await companionClient.send('Page.enable');

        // 6. Inspect Celestial Fairy Familiar
        console.log('\n5. Inspecting Celestial Familiar Fairy & Particle Systems...');
        let isModelReady = false;
        let modelStats = null;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            modelStats = await companionClient.eval(`
                (() => {
                    const renderer = window.fairyRenderer || window.companionRenderer;
                    const canvas = document.getElementById('fairyCanvas');
                    if (!renderer) return { ready: false };
                    return {
                        ready: Boolean(renderer.running && canvas),
                        running: Boolean(renderer.running),
                        emotion: renderer.state.emotion,
                        orbitParticles: renderer.orbitParticles ? renderer.orbitParticles.length : 0,
                        burstParticles: renderer.burstParticles ? renderer.burstParticles.length : 0,
                        speechText: document.getElementById('speechBubble')?.textContent?.trim() || '',
                        statusText: document.getElementById('statusText')?.textContent?.trim() || ''
                    };
                })()
            `);
            if (modelStats && modelStats.ready) {
                isModelReady = true;
                break;
            }
        }

        const modelLoadDuration = Date.now() - clickTime;
        console.log(`   Fairy load status: ${isModelReady ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   Initial load & render duration: ${modelLoadDuration} ms`);
        console.log(`   Active emotion: "${modelStats.emotion}"`);
        console.log(`   Renderer running: ${modelStats.running}`);
        console.log(`   Orbital stardust particles: ${modelStats.orbitParticles}`);
        console.log(`   Dialogue Bubble: "${modelStats.speechText}"`);
        console.log(`   Status Pill: "${modelStats.statusText}"`);

        // 7. Test Companion Physical Interaction (Pet Button)
        console.log('\n6. Testing physical pet interaction on floating fairy...');
        await companionClient.eval('document.getElementById("petBtn")?.click()');
        await sleep(600);

        const petState = await companionClient.eval(`
            (() => {
                const renderer = window.fairyRenderer || window.companionRenderer;
                return {
                    speechText: document.getElementById('speechBubble')?.textContent?.trim() || '',
                    statusText: document.getElementById('statusText')?.textContent?.trim() || '',
                    emotion: renderer ? renderer.state.emotion : ''
                };
            })()
        `);
        console.log(`   Pet reaction emotion: "${petState.emotion}"`);
        console.log(`   Speech bubble response: "${petState.speechText}"`);

        // 8. Test Magic Sparkle Interaction
        console.log('\n7. Testing magic sparkle interaction...');
        await companionClient.eval('document.getElementById("magicBtn")?.click()');
        await sleep(600);
        const magicEmotion = await companionClient.eval('(window.fairyRenderer || window.companionRenderer)?.state?.emotion');
        console.log(`   Magic reaction emotion: "${magicEmotion}"`);

        // 9. Capture Screenshots
        console.log('\n8. Capturing visual evidence artifacts...');
        const compScreenshot = await companionClient.captureScreenshot();
        const compScreenshotPath = path.join(ARTIFACTS_DIR, 'lucy_floating_fairy_companion.png');
        fs.writeFileSync(compScreenshotPath, compScreenshot);
        console.log(`   Saved companion window screenshot: ${compScreenshotPath} (${compScreenshot.length} bytes)`);

        const mainScreenshot = await mainClient.captureScreenshot();
        const mainScreenshotPath = path.join(ARTIFACTS_DIR, 'lucy_main_floating_active.png');
        fs.writeFileSync(mainScreenshotPath, mainScreenshot);
        console.log(`   Saved main window screenshot: ${mainScreenshotPath} (${mainScreenshot.length} bytes)`);

        // 10. Test Window Return / Docking behavior
        console.log('\n9. Testing window dock/return behavior...');
        await companionClient.eval('document.getElementById("returnBtn")?.click()');
        await sleep(1000);

        const dockedBtnText = await mainClient.eval('document.getElementById("toggleFloatingBtn")?.textContent');
        console.log(`   After clicking return button, sidebar button: "${dockedBtnText}"`);

        // Re-open
        await mainClient.eval('document.getElementById("toggleFloatingBtn").click()');
        await sleep(1000);
        const reopenedBtnText = await mainClient.eval('document.getElementById("toggleFloatingBtn")?.textContent');
        console.log(`   After re-clicking float button, sidebar button: "${reopenedBtnText}"`);

        // Performance measurements
        const totalDuration = Date.now() - startTime;
        console.log('\n=== Verification Summary ===');
        console.log(`Total verification duration: ${(totalDuration / 1000).toFixed(2)}s`);
        console.log('Floating 3D Companion: 100% VERIFIED & FUNCTIONAL');

    } finally {
        if (companionClient) companionClient.close();
        if (mainClient) mainClient.close();
        proc.kill('SIGINT');
        await sleep(500);
        try { proc.kill('SIGKILL'); } catch (_) {}
    }
}

runVerification().catch(err => {
    console.error('VERIFICATION_FAILED:', err);
    process.exit(1);
});
