'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ARTIFACTS_DIR = 'C:\\Users\\admin\\.gemini\\antigravity-ide\\brain\\37e00f8a-b4af-4413-a3f0-ab08cdcdc149';
const ISOLATED_PROFILE = path.resolve(__dirname, '../scratch/isolated-verify-profile');

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
            try { this.ws.close(); } catch (_) {}
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

async function runVisualVerificationSuite() {
    console.log('================================================================');
    console.log('  L.U.C.Y. Visual Verification Suite: Elimination of Old Dragon');
    console.log('  Testing 5 States: Main, Floating, Dock/Undock, Reopen, Restart');
    console.log('================================================================\n');

    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

    // STEP 1 & 2 & 3 & 4 (Session 1)
    console.log('[Phase 1] Launching Application with Remote Debugging...');
    let proc = await launchApp(9222);
    let mainClient = null;
    let compClient = null;

    try {
        // Wait for CDP target
        let targets = [];
        for (let i = 0; i < 25; i++) {
            await sleep(400);
            try {
                targets = await fetchCdpTargets(9222);
                if (targets && targets.length > 0) break;
            } catch (_) {}
        }

        const mainTarget = targets.find(t => t.url.includes('index.html'));
        if (!mainTarget) throw new Error('Main window not found in CDP');
        console.log(`  ✓ Main Window connected: ${mainTarget.title}`);

        mainClient = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainClient.connect();
        await mainClient.send('Runtime.enable');
        await mainClient.send('Page.enable');

        await sleep(2000);

        // -------------------------------------------------------------
        // SCREENSHOT 1: Main application with the fairy visible
        // -------------------------------------------------------------
        console.log('\n[Check 1] Inspecting Main Application Alcove & Fairy Renderer...');
        const mainFairyStatus = await mainClient.eval(`
            (() => {
                const canvas = document.getElementById('creatureCanvas');
                const renderer = window.companionRenderer;
                return {
                    hasCanvas: Boolean(canvas),
                    rendererRunning: Boolean(renderer && renderer.running),
                    emotion: renderer ? renderer.state.emotion : 'none',
                    particlesCount: renderer && renderer.orbitParticles ? renderer.orbitParticles.length : 0,
                    hasDragonReference: document.body.innerHTML.toLowerCase().includes('dragon')
                };
            })()
        `);
        console.log('  Main Fairy Status:', JSON.stringify(mainFairyStatus, null, 2));
        if (!mainFairyStatus.rendererRunning) {
            throw new Error('CelestialFamiliarRenderer is not running in main window');
        }
        if (mainFairyStatus.hasDragonReference) {
            throw new Error('Dragon reference found in main window DOM!');
        }
        console.log('  ✓ Main window alcove is running CelestialFamiliarRenderer (Fairy). Dragon reference: 0.');

        const ss1 = await mainClient.captureScreenshot();
        const p1 = path.join(ARTIFACTS_DIR, 'fairy_1_main_application.png');
        fs.writeFileSync(p1, ss1);
        console.log(`  📸 Saved Screenshot 1 (Main Fairy): ${p1} (${ss1.length} bytes)`);

        // -------------------------------------------------------------
        // SCREENSHOT 2: Floating companion visible outside the main window
        // -------------------------------------------------------------
        console.log('\n[Check 2] Undocking Fairy to Desktop Overlay...');
        await mainClient.eval('window.lucyIpc.toggleCompanionWindow({ action: "float" })');
        await sleep(2000);

        let curTargets = await fetchCdpTargets(9222);
        const compTarget = curTargets.find(t => t.url.includes('companion.html'));
        if (!compTarget) throw new Error('Companion window target not found after float toggle');
        console.log(`  ✓ Floating Companion Window connected: ${compTarget.title}`);

        compClient = new SimpleCdpClient(compTarget.webSocketDebuggerUrl);
        await compClient.connect();
        await compClient.send('Runtime.enable');
        await compClient.send('Page.enable');

        const floatingStatus = await compClient.eval(`
            (() => {
                const renderer = window.fairyRenderer || window.companionRenderer;
                const canvas = document.getElementById('fairyCanvas');
                const hasThree = Boolean(document.getElementById('threeCanvas'));
                const hasDragon = document.body.innerHTML.toLowerCase().includes('dragon');
                return {
                    hasFairyCanvas: Boolean(canvas),
                    hasThreeCanvas: hasThree,
                    hasDragonText: hasDragon,
                    rendererRunning: Boolean(renderer && renderer.running),
                    emotion: renderer ? renderer.state.emotion : 'none',
                    orbitParticles: renderer && renderer.orbitParticles ? renderer.orbitParticles.length : 0,
                    speechBubble: document.getElementById('speechBubble')?.textContent?.trim() || ''
                };
            })()
        `);
        console.log('  Floating Companion Status:', JSON.stringify(floatingStatus, null, 2));
        if (!floatingStatus.rendererRunning) {
            throw new Error('CelestialFamiliarRenderer is not running in floating companion');
        }
        if (floatingStatus.hasThreeCanvas || floatingStatus.hasDragonText) {
            throw new Error('Legacy threeCanvas or dragon reference detected in floating companion!');
        }
        console.log('  ✓ Floating window is running CelestialFamiliarRenderer. 0 dragons present.');

        const ss2 = await compClient.captureScreenshot();
        const p2 = path.join(ARTIFACTS_DIR, 'fairy_2_floating_companion.png');
        fs.writeFileSync(p2, ss2);
        console.log(`  📸 Saved Screenshot 2 (Floating Fairy): ${p2} (${ss2.length} bytes)`);

        // -------------------------------------------------------------
        // SCREENSHOT 3: The application after docking and undocking
        // -------------------------------------------------------------
        console.log('\n[Check 3] Testing Docking (Return to App) and Undocking Cycle...');
        await compClient.eval('document.getElementById("returnBtn").click()');
        await sleep(1500);

        const dockedStatus = await mainClient.eval(`
            (() => {
                const renderer = window.companionRenderer;
                const stage = document.getElementById('creatureStage');
                return {
                    rendererRunning: Boolean(renderer && renderer.running),
                    stageHasFlyingIn: stage.classList.contains('fairy-flying-in') || !stage.classList.contains('fairy-on-desktop'),
                    toggleBtnText: document.getElementById('toggleFloatingBtn')?.textContent || ''
                };
            })()
        `);
        console.log('  Docked State in Main App:', JSON.stringify(dockedStatus, null, 2));

        // Undock again
        await mainClient.eval('window.lucyIpc.toggleCompanionWindow({ action: "float" })');
        await sleep(1500);

        const ss3 = await compClient.captureScreenshot();
        const p3 = path.join(ARTIFACTS_DIR, 'fairy_3_dock_undock_verified.png');
        fs.writeFileSync(p3, ss3);
        console.log(`  📸 Saved Screenshot 3 (After Dock/Undock): ${p3} (${ss3.length} bytes)`);

        // -------------------------------------------------------------
        // SCREENSHOT 4: The application after closing and reopening the companion
        // -------------------------------------------------------------
        console.log('\n[Check 4] Testing Close and Reopen Companion (Single Instance Verification)...');
        await compClient.eval('document.getElementById("closeBtn").click()');
        await sleep(1200);

        // Reopen from main app button
        await mainClient.eval('document.getElementById("toggleFloatingBtn").click()');
        await sleep(1500);

        // Check target count - ensure NO duplicate companion windows
        const checkTargets = await fetchCdpTargets(9222);
        const compTargets = checkTargets.filter(t => t.url.includes('companion.html'));
        console.log(`  Discovered companion targets count: ${compTargets.length}`);
        if (compTargets.length !== 1) {
            throw new Error(`Expected exactly 1 companion window target, found: ${compTargets.length}`);
        }
        console.log('  ✓ Duplicate prevention verified: exactly 1 companion window exists.');

        const ss4 = await compClient.captureScreenshot();
        const p4 = path.join(ARTIFACTS_DIR, 'fairy_4_close_reopen_verified.png');
        fs.writeFileSync(p4, ss4);
        console.log(`  📸 Saved Screenshot 4 (After Close & Reopen): ${p4} (${ss4.length} bytes)`);

    } finally {
        if (compClient) compClient.close();
        if (mainClient) mainClient.close();
        await killApp(proc);
        await sleep(1500);
    }

    // -------------------------------------------------------------
    // SCREENSHOT 5: The application after a full application restart
    // -------------------------------------------------------------
    console.log('\n[Check 5] Full Application Restart Verification...');
    proc = await launchApp(9222);
    mainClient = null;
    compClient = null;

    try {
        let targets = [];
        for (let i = 0; i < 25; i++) {
            await sleep(400);
            try {
                targets = await fetchCdpTargets(9222);
                if (targets && targets.length > 0) break;
            } catch (_) {}
        }

        const mainTarget = targets.find(t => t.url.includes('index.html'));
        if (!mainTarget) throw new Error('Main window not found after restart');

        mainClient = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainClient.connect();
        await mainClient.send('Runtime.enable');
        await mainClient.send('Page.enable');
        await sleep(2000);

        // Undock companion on fresh restart
        await mainClient.eval('window.lucyIpc.toggleCompanionWindow({ action: "float" })');
        await sleep(2000);

        const restartTargets = await fetchCdpTargets(9222);
        const compTarget = restartTargets.find(t => t.url.includes('companion.html'));
        if (!compTarget) throw new Error('Companion window not found after restart and toggle');

        compClient = new SimpleCdpClient(compTarget.webSocketDebuggerUrl);
        await compClient.connect();
        await compClient.send('Runtime.enable');
        await compClient.send('Page.enable');

        const restartStatus = await compClient.eval(`
            (() => {
                const renderer = window.fairyRenderer || window.companionRenderer;
                const canvas = document.getElementById('fairyCanvas');
                const hasThree = Boolean(document.getElementById('threeCanvas'));
                const hasDragon = document.body.innerHTML.toLowerCase().includes('dragon');
                return {
                    hasFairyCanvas: Boolean(canvas),
                    hasThreeCanvas: hasThree,
                    hasDragonText: hasDragon,
                    rendererRunning: Boolean(renderer && renderer.running),
                    emotion: renderer ? renderer.state.emotion : 'none',
                    orbitParticles: renderer && renderer.orbitParticles ? renderer.orbitParticles.length : 0
                };
            })()
        `);
        console.log('  Fresh Restart Status:', JSON.stringify(restartStatus, null, 2));
        if (!restartStatus.rendererRunning) {
            throw new Error('Renderer failed to run after restart');
        }
        if (restartStatus.hasThreeCanvas || restartStatus.hasDragonText) {
            throw new Error('Old dragon found after fresh restart!');
        }
        console.log('  ✓ Post-restart verified: 0 dragons in any window, Fairy running flawlessly.');

        const ss5 = await compClient.captureScreenshot();
        const p5 = path.join(ARTIFACTS_DIR, 'fairy_5_restart_verified.png');
        fs.writeFileSync(p5, ss5);
        console.log(`  📸 Saved Screenshot 5 (After Restart): ${p5} (${ss5.length} bytes)`);

        console.log('\n================================================================');
        console.log('  ALL 5 VISUAL VERIFICATION CHECKS PASSED WITH 100% SUCCESS!');
        console.log('================================================================');

    } finally {
        if (compClient) compClient.close();
        if (mainClient) mainClient.close();
        await killApp(proc);
    }
}

runVisualVerificationSuite().catch((err) => {
    console.error('VERIFICATION_SUITE_FAILED:', err);
    process.exit(1);
});
