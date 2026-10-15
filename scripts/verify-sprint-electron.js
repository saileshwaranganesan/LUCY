'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CONVERSATION_ARTIFACTS = 'C:\\Users\\admin\\.gemini\\antigravity-ide\\brain\\72c6770c-c89f-4cf6-a495-f818e8d3d33d';
const LOCAL_ARTIFACTS = path.resolve(__dirname, '../artifacts');
const ISOLATED_PROFILE = path.resolve(__dirname, '../scratch/isolated-sprint-verify-profile');

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

    async captureScreenshot(clip = null) {
        const params = { format: 'png' };
        if (clip) params.clip = clip;
        const res = await this.send('Page.captureScreenshot', params);
        return Buffer.from(res.data, 'base64');
    }

    close() {
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
    }
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCdpTargets(port = 9222) {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    return await res.json();
}

function saveScreenshot(filename, buffer) {
    [CONVERSATION_ARTIFACTS, LOCAL_ARTIFACTS].forEach((dir) => {
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, filename), buffer);
        } catch (err) {
            console.warn(`Warning: failed to write ${filename} to ${dir}:`, err.message);
        }
    });
    console.log(`  📸 Saved screenshot: ${filename} (${buffer.length} bytes)`);
}

async function launchApp(port = 9222) {
    const electronBin = path.resolve(__dirname, '../node_modules/electron/dist/electron.exe');
    const appPath = path.resolve(__dirname, '..');
    fs.mkdirSync(ISOLATED_PROFILE, { recursive: true });

    const proc = spawn(electronBin, [
        appPath,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${ISOLATED_PROFILE}`
    ], {
        cwd: appPath,
        env: {
            ...process.env,
            LUCY_PERMISSION_MODE: 'standard',
            LUCY_SMOKE_TEST: 'false',
            LUCY_MEMORY_DIR: path.join(ISOLATED_PROFILE, 'memory')
        },
        stdio: 'pipe'
    });

    proc.stdout.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.log('  [App STDOUT]', line);
    });
    proc.stderr.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.warn('  [App STDERR]', line);
    });

    return proc;
}

async function killApp(proc) {
    if (!proc) return;
    try {
        proc.kill('SIGINT');
        await sleep(600);
        try { proc.kill('SIGKILL'); } catch (_) {}
    } catch (_) {}
}

async function run() {
    console.log('================================================================');
    console.log('  L.U.C.Y. Sprint Acceptance Verification & Screenshot Suite');
    console.log('================================================================\n');

    let proc = await launchApp(9222);
    let mainClient = null;
    let compClient = null;

    try {
        console.log('[Step 1] Connecting to Electron via CDP on port 9222...');
        let targets = [];
        for (let i = 0; i < 30; i++) {
            await sleep(400);
            try {
                targets = await fetchCdpTargets(9222);
                if (targets && targets.length > 0) break;
            } catch (_) {}
        }

        const mainTarget = targets.find((t) => t.url.includes('index.html'));
        if (!mainTarget) throw new Error('Main window not found via CDP');
        console.log(`  ✓ Main Window connected: ${mainTarget.title}`);

        mainClient = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainClient.connect();
        await mainClient.send('Runtime.enable');
        await mainClient.send('Page.enable');

        await sleep(2000);

        // -------------------------------------------------------------
        // SCREENSHOT 1: Main Window with Humanoid Fairy in Sidebar
        // -------------------------------------------------------------
        console.log('\n[Step 2] Capturing Screenshot 1: Main Application with Humanoid Fairy Sidebar...');
        const mainRendererStatus = await mainClient.eval(`
            (() => {
                const renderer = window.companionRenderer;
                const canvas = document.getElementById('creatureCanvas');
                return {
                    running: Boolean(renderer && renderer.running),
                    emotion: renderer ? renderer.state.emotion : 'unknown',
                    canvasWidth: canvas ? canvas.width : 0,
                    canvasHeight: canvas ? canvas.height : 0
                };
            })()
        `);
        console.log('  Main Renderer Status:', mainRendererStatus);

        const ss1 = await mainClient.captureScreenshot();
        saveScreenshot('fairy_1_main_application.png', ss1);

        // -------------------------------------------------------------
        // SCREENSHOT 2: Floating Companion Window (Chibi Humanoid Fairy)
        // -------------------------------------------------------------
        console.log('\n[Step 3] Undocking Fairy to Desktop Floating Companion Window...');
        await mainClient.eval('window.lucyIpc.toggleCompanionWindow({ action: "float" })');
        await sleep(2000);

        const curTargets = await fetchCdpTargets(9222);
        const compTarget = curTargets.find((t) => t.url.includes('companion.html'));
        if (!compTarget) throw new Error('Companion window target not found after float toggle');
        console.log(`  ✓ Floating Companion Window connected: ${compTarget.title}`);

        compClient = new SimpleCdpClient(compTarget.webSocketDebuggerUrl);
        await compClient.connect();
        await compClient.send('Runtime.enable');
        await compClient.send('Page.enable');

        await sleep(1000);

        const compStatus = await compClient.eval(`
            (() => {
                const renderer = window.fairyRenderer || window.companionRenderer;
                const canvas = document.getElementById('fairyCanvas');
                return {
                    running: Boolean(renderer && renderer.running),
                    emotion: renderer ? renderer.state.emotion : 'unknown',
                    canvasWidth: canvas ? canvas.width : 0,
                    canvasHeight: canvas ? canvas.height : 0
                };
            })()
        `);
        console.log('  Floating Companion Status:', compStatus);

        const ss2 = await compClient.captureScreenshot();
        saveScreenshot('fairy_2_floating_compact.png', ss2);

        // -------------------------------------------------------------
        // SCREENSHOT 3: Interactive / Emotional State (Petting / Happy)
        // -------------------------------------------------------------
        console.log('\n[Step 4] Triggering Petting Interaction on Floating Fairy...');
        await compClient.eval(`
            (() => {
                const petBtn = document.getElementById('petBtn');
                if (petBtn) petBtn.click();
            })()
        `);
        await sleep(1200); // Allow animation frames to render petting / heart / blushing state

        const petStatus = await compClient.eval(`
            (() => {
                const renderer = window.fairyRenderer || window.companionRenderer;
                return {
                    emotion: renderer ? renderer.state.emotion : 'unknown',
                    speech: document.getElementById('speechBubble') ? document.getElementById('speechBubble').textContent.trim() : ''
                };
            })()
        `);
        console.log('  Petting State:', petStatus);

        const ss3 = await compClient.captureScreenshot();
        saveScreenshot('fairy_3_petting_interaction.png', ss3);

        // -------------------------------------------------------------
        // SCREENSHOT 4: Background Runtime Mode (Main Window Closed/Hidden)
        // -------------------------------------------------------------
        console.log('\n[Step 5] Testing Background Runtime: Closing Main Window...');
        // Simulating main window close request: close-to-tray interceptor will hide it
        await mainClient.eval(`
            (() => {
                window.close();
            })()
        `);
        await sleep(1500);

        // Verify that floating companion is still alive and rendering
        const backgroundCompStatus = await compClient.eval(`
            (() => {
                const renderer = window.fairyRenderer || window.companionRenderer;
                return {
                    stillRunning: Boolean(renderer && renderer.running),
                    time: Date.now()
                };
            })()
        `);
        console.log('  Floating Companion in Background Mode:', backgroundCompStatus);
        if (!backgroundCompStatus.stillRunning) {
            throw new Error('Floating companion died when main window closed!');
        }
        console.log('  ✓ Floating companion is alive and running while main window is hidden in tray!');

        const ss4 = await compClient.captureScreenshot();
        saveScreenshot('fairy_4_background_mode_active.png', ss4);

        // -------------------------------------------------------------
        // Clean Exit
        // -------------------------------------------------------------
        console.log('\n[Step 6] Testing Explicit App Exit...');
        // Summon back main window or call exitApp
        await compClient.eval(`
            (async () => {
                if (window.companionIpc && window.companionIpc.returnToApp) {
                    await window.companionIpc.returnToApp();
                }
            })()
        `);
        await sleep(1000);

        console.log('\n================================================================');
        console.log('  ALL SPRINT VERIFICATION SCREENSHOTS CAPTURED SUCCESSFULLY!');
        console.log('================================================================\n');

    } finally {
        if (compClient) compClient.close();
        if (mainClient) mainClient.close();
        await killApp(proc);
        console.log('  App process terminated cleanly.');
    }
}

run().catch((err) => {
    console.error('SPRINT_VERIFICATION_FAILED:', err);
    process.exit(1);
});
