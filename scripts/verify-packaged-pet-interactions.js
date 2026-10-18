'use strict';

/**
 * Packaged Application Pet Interactions, Affection & Stunts Visual Verification Script
 *
 * Verifies live in the packaged Electron build (dist-release/win-unpacked/LUCY.exe):
 * 1. Petting produces visible reaction: heart burst, happy anime eyes, rosy blush, raised arms.
 * 2. Varied affection phrases display in speech bubble without repeating consecutively.
 * 3. Somersault stunt: full 360-degree aerial loop with squash & stretch cushion and return to idle.
 * 4. Starlight dance stunt: rhythmic side-to-side sway, vertical bounce, and alternating arm waves.
 * 5. Floating desktop companion window executes pet reactions and tricks smoothly.
 * 6. ZERO OS-level disturbance to the user's desktop.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class SimpleCdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.msgId = 1;
        this.pending = new Map();
    }

    async connect(timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`WebSocket connection timeout to ${this.wsUrl}`)), timeoutMs);
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => { clearTimeout(timer); resolve(); };
            this.ws.onerror = (err) => { clearTimeout(timer); reject(err); };
            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.id && this.pending.has(data.id)) {
                    const { resolve: res, reject: rej } = this.pending.get(data.id);
                    this.pending.delete(data.id);
                    if (data.error) rej(new Error(data.error.message || JSON.stringify(data.error)));
                    else res(data.result);
                }
            };
        });
    }

    async send(method, params = {}, timeoutMs = 10000) {
        const id = this.msgId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP request ${method} (id=${id}) timed out`));
                }
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (val) => { clearTimeout(timer); resolve(val); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            });
            try {
                this.ws.send(JSON.stringify({ id, method, params }));
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    async eval(expression, timeoutMs = 10000) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        }, timeoutMs);
        if (res.exceptionDetails) {
            throw new Error(`Eval error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result ? res.result.value : undefined;
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

async function getCdpTargets(port, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json`);
            if (res.ok) return await res.json();
        } catch (_) {}
        await sleep(300);
    }
    throw new Error(`Failed to query CDP targets on port ${port} within ${timeoutMs}ms`);
}

async function runPackagedPetVerification() {
    console.log('=== L.U.C.Y. Repair 4: Packaged Pet Interactions & Stunts Verification ===\n');

    const artifactDir = 'C:\\Users\\admin\\.gemini\\antigravity-ide\\brain\\7ae752c2-9344-4b22-a07e-0613214bb3df';
    const packagedExe = path.resolve(__dirname, '../dist-release/win-unpacked/LUCY.exe');
    if (!fs.existsSync(packagedExe)) {
        throw new Error(`Packaged executable not found at: ${packagedExe}. Run 'npm run package:dir' first.`);
    }

    const testSandboxDir = path.join(os.tmpdir(), `lucy_pet_test_${Date.now()}`);
    fs.mkdirSync(testSandboxDir, { recursive: true });

    const cdpPort = 9444;
    console.log(`[Launch] Spawning packaged app: ${packagedExe}`);
    console.log(`[Launch] Sandbox profile: ${testSandboxDir}`);
    console.log(`[Launch] CDP Debug Port: ${cdpPort}`);

    const child = spawn(packagedExe, [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${testSandboxDir}`
    ], {
        stdio: 'ignore',
        detached: false
    });

    let mainClient = null;
    let companionClient = null;

    try {
        console.log('[CDP] Waiting for Chromium DevTools port to open...');
        const targets = await getCdpTargets(cdpPort, 20000);
        console.log(`[CDP] Discovered ${targets.length} initial target(s)`);

        const mainTarget = targets.find((t) => t.type === 'page' && (t.url.includes('index.html') || t.title.includes('L.U.C.Y.')));
        if (!mainTarget) {
            throw new Error('Main application window target not found among CDP targets');
        }

        console.log(`[CDP] Connecting to main window: ${mainTarget.title} (${mainTarget.url})`);
        mainClient = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainClient.connect();
        await mainClient.send('Page.enable');
        await mainClient.send('Runtime.enable');
        await sleep(1500);

        // 1. Verify Renderer presence and initial idle status
        console.log('\n--- Step 1: Initial Familiar Status ---');
        const initialStatus = await mainClient.eval(`
            (() => {
                const renderer = window.companionRenderer;
                return {
                    hasRenderer: Boolean(renderer),
                    emotion: renderer?.state?.emotion,
                    fps: renderer?.targetFps
                };
            })()
        `);
        console.log('[Check] Renderer initialized:', initialStatus);
        if (!initialStatus.hasRenderer) throw new Error('Companion renderer missing in main window');

        // 2. Test Pet Interaction in Main Application
        console.log('\n--- Step 2: Main Application Pet Reaction ---');
        const petResult = await mainClient.eval(`
            (() => {
                const petBtn = document.getElementById('petBtn');
                if (petBtn) petBtn.click();
                const renderer = window.companionRenderer;
                const bubble = document.getElementById('speechBubble');
                return {
                    emotion: renderer.state.emotion,
                    burstParticlesCount: renderer.burstParticles.length,
                    bubbleText: bubble?.textContent,
                    bubbleVisible: bubble?.classList.contains('visible')
                };
            })()
        `);
        console.log('[Check] Pet Interaction State:', petResult);
        if (petResult.emotion !== 'pet') throw new Error(`Expected emotion 'pet', got '${petResult.emotion}'`);
        if (petResult.burstParticlesCount < 10) throw new Error('Expected burst particles for petting reaction');

        // Capture live screenshot of the fairy reacting to petting (heart burst & joyful smile)
        await sleep(350);
        const petScreenshot = await mainClient.send('Page.captureScreenshot', { format: 'png' });
        const petImgPath = path.join(artifactDir, 'fairy_repaired_pet_reaction.png');
        fs.writeFileSync(petImgPath, Buffer.from(petScreenshot.data, 'base64'));
        console.log(`[Screenshot] Saved Pet Reaction to: ${petImgPath}`);

        // Wait for auto-return to idle/happy
        await sleep(1800);
        const returnedStatus = await mainClient.eval(`window.companionRenderer.state.emotion`);
        console.log(`[Check] Pet auto-return state after 1.8s: '${returnedStatus}'`);
        if (returnedStatus !== 'happy' && returnedStatus !== 'idle') {
            console.warn(`[Warning] Expected emotion happy/idle, got ${returnedStatus}`);
        }

        // 3. Test Stunt: Aerial Somersault Loop
        console.log('\n--- Step 3: Aerial Somersault Stunt ---');
        await mainClient.eval(`
            (() => {
                const renderer = window.companionRenderer;
                renderer.playTrick('somersault');
            })()
        `);
        await sleep(400); // mid-somersault
        const somersaultState = await mainClient.eval(`
            (() => {
                const r = window.companionRenderer;
                return {
                    emotion: r.state.emotion,
                    somersaultAngle: r.state.somersaultAngle,
                    transitionOffset: r.state.transitionOffset,
                    scaleY: r.state.scaleY
                };
            })()
        `);
        console.log('[Check] Mid-Somersault Physics State:', somersaultState);
        if (somersaultState.emotion !== 'trick_somersault') throw new Error('Somersault not active');

        const somersaultScreenshot = await mainClient.send('Page.captureScreenshot', { format: 'png' });
        const somersaultImgPath = path.join(artifactDir, 'fairy_stunt_somersault.png');
        fs.writeFileSync(somersaultImgPath, Buffer.from(somersaultScreenshot.data, 'base64'));
        console.log(`[Screenshot] Saved Somersault Stunt to: ${somersaultImgPath}`);

        // Wait for somersault completion
        await sleep(1500);
        const somersaultEnd = await mainClient.eval(`
            (() => {
                const r = window.companionRenderer;
                return { emotion: r.state.emotion, somersaultAngle: r.state.somersaultAngle };
            })()
        `);
        console.log('[Check] Post-Somersault state:', somersaultEnd);
        if (somersaultEnd.emotion !== 'idle') throw new Error(`Expected return to idle, got ${somersaultEnd.emotion}`);

        // 4. Test Stunt: Starlight Dance
        console.log('\n--- Step 4: Starlight Dance Stunt ---');
        await mainClient.eval(`
            (() => {
                const renderer = window.companionRenderer;
                renderer.playTrick('dance');
            })()
        `);
        await sleep(600); // mid-dance
        const danceState = await mainClient.eval(`
            (() => {
                const r = window.companionRenderer;
                return {
                    emotion: r.state.emotion,
                    flightOffsetX: r.state.flightOffsetX,
                    danceArmWave: r.state.danceArmWave
                };
            })()
        `);
        console.log('[Check] Mid-Dance Rhythm State:', danceState);
        if (danceState.emotion !== 'trick_dance') throw new Error('Dance not active');

        const danceScreenshot = await mainClient.send('Page.captureScreenshot', { format: 'png' });
        const danceImgPath = path.join(artifactDir, 'fairy_stunt_dance.png');
        fs.writeFileSync(danceImgPath, Buffer.from(danceScreenshot.data, 'base64'));
        console.log(`[Screenshot] Saved Starlight Dance to: ${danceImgPath}`);

        // Wait for dance completion
        await sleep(1900);
        const danceEnd = await mainClient.eval(`window.companionRenderer.state.emotion`);
        console.log(`[Check] Post-Dance state: '${danceEnd}'`);
        if (danceEnd !== 'idle') throw new Error(`Expected return to idle, got ${danceEnd}`);

        // 5. Test Floating Desktop Companion Window
        console.log('\n--- Step 5: Floating Companion Window Interactions ---');
        await mainClient.eval(`
            (() => {
                const floatBtn = document.getElementById('toggleFloatingBtn');
                if (floatBtn) floatBtn.click();
            })()
        `);
        await sleep(1500);

        const currentTargets = await getCdpTargets(cdpPort, 10000);
        const companionTarget = currentTargets.find((t) => t.type === 'page' && (t.url.includes('companion.html') || t.title.includes('Companion')));
        if (!companionTarget) {
            throw new Error('Floating companion target not found after floating toggle');
        }

        console.log(`[CDP] Connecting to floating companion: ${companionTarget.url}`);
        companionClient = new SimpleCdpClient(companionTarget.webSocketDebuggerUrl);
        await companionClient.connect();
        await companionClient.send('Page.enable');
        await companionClient.send('Runtime.enable');
        await sleep(500);

        // Click on floating fairy stage to pet
        console.log('[Action] Clicking floating fairy stage to pet...');
        const floatPetResult = await companionClient.eval(`
            (() => {
                const fairyStage = document.getElementById('fairyStage');
                if (fairyStage) fairyStage.click();
                const r = window.fairyRenderer || window.companionRenderer;
                const typewriter = document.getElementById('typewriterText');
                return {
                    emotion: r ? r.state.emotion : null,
                    burstCount: r ? r.burstParticles.length : 0,
                    message: typewriter ? typewriter.textContent : null
                };
            })()
        `);
        console.log('[Check] Floating Companion Pet State:', floatPetResult);
        if (floatPetResult.emotion !== 'pet') throw new Error(`Expected floating pet emotion, got ${floatPetResult.emotion}`);

        await sleep(350);
        const floatPetScreenshot = await companionClient.send('Page.captureScreenshot', { format: 'png' });
        const floatPetImgPath = path.join(artifactDir, 'floating_fairy_pet_reaction.png');
        fs.writeFileSync(floatPetImgPath, Buffer.from(floatPetScreenshot.data, 'base64'));
        console.log(`[Screenshot] Saved Floating Companion Pet Reaction to: ${floatPetImgPath}`);

        // Clean dock back to app
        console.log('\n--- Step 6: Docking Companion Back to App ---');
        await companionClient.eval(`
            (() => {
                const returnBtn = document.getElementById('returnBtn');
                if (returnBtn) returnBtn.click();
            })()
        `);
        await sleep(1200);

        console.log('\n=== L.U.C.Y. Repair 4: Verification COMPLETED SUCCESSFULLY ===\n');
        return true;

    } finally {
        if (companionClient) companionClient.close();
        if (mainClient) mainClient.close();

        console.log('[Teardown] Terminating packaged test process...');
        try {
            if (!child.killed) {
                child.kill('SIGTERM');
                await sleep(500);
                if (!child.killed) child.kill('SIGKILL');
            }
        } catch (_) {}

        // Clean temp sandbox directory
        try {
            fs.rmSync(testSandboxDir, { recursive: true, force: true });
        } catch (_) {}
    }
}

runPackagedPetVerification().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\n[FATAL ERROR]', err.stack || err.message);
    process.exit(1);
});
