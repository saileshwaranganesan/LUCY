'use strict';

/**
 * L.U.C.Y. Repair 5: Live Packaged Binary Sizing and Synchronization Verification
 * 
 * Tests the real packaged application (dist-release/win-unpacked/LUCY.exe)
 * via Chrome DevTools Protocol (CDP) in an isolated sandbox:
 * - Slider changes and actual window dimensions
 * - Tiny Default (160×190) and Comfortable (220×260) presets
 * - Displayed values vs effective bounds
 * - Docking and undocking size preservation
 * - Persistence across application restart
 * - Dragging scale stability
 * - Screenshot capture for visual proof
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

    async captureScreenshot(outputPath) {
        const res = await this.send('Page.captureScreenshot', { format: 'png' });
        if (res && res.data) {
            fs.writeFileSync(outputPath, Buffer.from(res.data, 'base64'));
            return true;
        }
        return false;
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
            if (res.ok) {
                return await res.json();
            }
        } catch (_) {}
        await sleep(350);
    }
    throw new Error(`Timed out waiting for CDP endpoint on port ${port} after ${timeoutMs}ms`);
}

async function runVerification() {
    const projectRoot = path.resolve(__dirname, '..');
    const exePath = path.join(projectRoot, 'dist-release', 'win-unpacked', 'LUCY.exe');
    const brainDir = path.resolve('C:/Users/admin/.gemini/antigravity-ide/brain/7ae752c2-9344-4b22-a07e-0613214bb3df');

    if (!fs.existsSync(exePath)) {
        throw new Error(`Packaged binary not found at ${exePath}`);
    }

    const port = 19230;
    const sandboxDir = path.join(os.tmpdir(), `lucy-r5-test-${Date.now()}`);
    const isolatedUserData = path.join(sandboxDir, 'user-data');
    const isolatedWorkspace = path.join(sandboxDir, 'workspace');

    fs.mkdirSync(isolatedUserData, { recursive: true });
    fs.mkdirSync(isolatedWorkspace, { recursive: true });

    const checks = [];
    function record(name, pass, detail = '') {
        checks.push({ name, pass, detail });
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -> ${detail}` : ''}`);
    }

    console.log('=== L.U.C.Y. Repair 5: Live Packaged Sizing & Synchronization Verification ===');
    console.log(`Executable: ${exePath}`);
    console.log(`Port:       ${port}`);
    console.log(`Sandbox:    ${sandboxDir}\n`);

    let appProcess = null;
    let mainCdp = null;
    let companionCdp = null;

    try {
        // Step 1: Launch packaged application in isolated sandbox
        console.log('[Step 1] Launching packaged binary in sandbox...');
        appProcess = spawn(exePath, [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${isolatedUserData}`
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                LUCY_WORKSPACE_DIR: isolatedWorkspace,
                LUCY_SMOKE_TEST: 'false'
            }
        });

        // Step 2: Connect to Main Window
        console.log('[Step 2] Connecting to Main Window via CDP...');
        const targets = await getCdpTargets(port, 25000);
        const mainTarget = targets.find(t => t.url.includes('index.html') || t.title.includes('L.U.C.Y.'));
        if (!mainTarget) {
            throw new Error(`Main window not found in targets: ${JSON.stringify(targets.map(t => t.url))}`);
        }
        mainCdp = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();
        await mainCdp.send('Page.enable');
        await sleep(1000);

        // Step 3: Switch to Companion Settings View
        console.log('[Step 3] Switching to Companion Settings tab...');
        await mainCdp.eval(`(() => {
            const tab = document.querySelector('.nav-deck-tab[data-view="viewCompanionSettings"]') ||
                        document.querySelector('.nav-deck-tab[data-target-view="viewCompanionSettings"]');
            if (tab) tab.click();
        })()`);
        await sleep(500);

        // Verify initial settings dimensions
        const initDims = await mainCdp.eval(`(() => {
            return {
                sliderW: document.getElementById('sliderCompanionWidth')?.value,
                sliderH: document.getElementById('sliderCompanionHeight')?.value,
                labelW: document.getElementById('sliderWidthVal')?.textContent,
                labelH: document.getElementById('sliderHeightVal')?.textContent,
                labelDims: document.getElementById('companionDimensionsLabel')?.textContent
            };
        })()`);

        record('Initial Width Slider value is 160', initDims.sliderW === '160', `Got ${initDims.sliderW}`);
        record('Initial Height Slider value is 190', initDims.sliderH === '190', `Got ${initDims.sliderH}`);
        record('Initial Width Label is "160 px"', initDims.labelW === '160 px', `Got ${initDims.labelW}`);
        record('Initial Height Label is "190 px"', initDims.labelH === '190 px', `Got ${initDims.labelH}`);
        record('Initial Dimensions Label is "160 × 190 px"', initDims.labelDims === '160 × 190 px', `Got ${initDims.labelDims}`);

        // Step 4: Float Pet to Desktop
        console.log('[Step 4] Summoning / floating companion to desktop...');
        await mainCdp.eval(`window.lucyIpc.toggleCompanionWindow({ action: 'float' })`);
        await sleep(1500);

        // Step 5: Connect to Companion Window
        console.log('[Step 5] Connecting to Floating Companion Window...');
        const updatedTargets = await getCdpTargets(port, 10000);
        const compTarget = updatedTargets.find(t => t.url.includes('companion.html'));
        if (!compTarget) {
            throw new Error(`Companion window not found in targets: ${JSON.stringify(updatedTargets.map(t => t.url))}`);
        }
        companionCdp = new SimpleCdpClient(compTarget.webSocketDebuggerUrl);
        await companionCdp.connect();
        await companionCdp.send('Page.enable');
        await sleep(800);

        // Measure actual companion window bounds at Tiny Default
        const compInitBounds = await companionCdp.eval(`(() => {
            const canvas = document.getElementById('fairyCanvas');
            return {
                winW: window.innerWidth,
                winH: window.innerHeight,
                canvasStyleW: canvas ? canvas.style.width : null,
                canvasStyleH: canvas ? canvas.style.height : null,
                dpr: window.devicePixelRatio
            };
        })()`);

        record('Companion Window width matches Tiny Default (160px)', Math.abs(compInitBounds.winW - 160) <= 2, `Got ${compInitBounds.winW}px`);
        record('Companion Window height matches Tiny Default (190px)', Math.abs(compInitBounds.winH - 190) <= 2, `Got ${compInitBounds.winH}px`);

        // Capture initial screenshot
        const shotTinyPath = path.join(brainDir, 'companion_preset_tiny_160x190.png');
        await companionCdp.captureScreenshot(shotTinyPath);
        console.log(`Saved screenshot: ${shotTinyPath}`);

        // Step 6: Test "Comfortable (220 × 260)" Preset
        console.log('[Step 6] Testing "Comfortable (220 × 260)" preset...');
        await mainCdp.eval(`(() => {
            const btn = document.getElementById('btnMediumPet');
            if (btn) btn.click();
        })()`);
        await sleep(1000);

        // Verify Main Window UI updated
        const medDims = await mainCdp.eval(`(() => {
            return {
                sliderW: document.getElementById('sliderCompanionWidth')?.value,
                sliderH: document.getElementById('sliderCompanionHeight')?.value,
                labelW: document.getElementById('sliderWidthVal')?.textContent,
                labelH: document.getElementById('sliderHeightVal')?.textContent,
                labelDims: document.getElementById('companionDimensionsLabel')?.textContent
            };
        })()`);

        record('Comfortable Preset updates Width Slider to 220', medDims.sliderW === '220', `Got ${medDims.sliderW}`);
        record('Comfortable Preset updates Height Slider to 260', medDims.sliderH === '260', `Got ${medDims.sliderH}`);
        record('Comfortable Preset updates Dimensions Label to "220 × 260 px"', medDims.labelDims === '220 × 260 px', `Got ${medDims.labelDims}`);

        // Verify Floating Window actual bounds updated
        const compMedBounds = await companionCdp.eval(`(() => ({
            winW: window.innerWidth,
            winH: window.innerHeight
        }))()`);

        record('Companion Window width reflects Comfortable preset (220px)', compMedBounds.winW === 220, `Got ${compMedBounds.winW}px`);
        record('Companion Window height reflects Comfortable preset (260px)', compMedBounds.winH === 260, `Got ${compMedBounds.winH}px`);

        const shotComfortablePath = path.join(brainDir, 'companion_preset_comfortable_220x260.png');
        await companionCdp.captureScreenshot(shotComfortablePath);
        console.log(`Saved screenshot: ${shotComfortablePath}`);

        // Step 7: Test Custom Dimensions via Sliders (280 × 320)
        console.log('[Step 7] Testing custom dimensions (280 × 320)...');
        await mainCdp.eval(`(() => {
            const sw = document.getElementById('sliderCompanionWidth');
            const sh = document.getElementById('sliderCompanionHeight');
            if (sw && sh) {
                sw.value = 280;
                sw.dispatchEvent(new Event('input', { bubbles: true }));
                sh.value = 320;
                sh.dispatchEvent(new Event('input', { bubbles: true }));
            }
        })()`);
        await sleep(1000);

        const customDims = await mainCdp.eval(`(() => {
            return {
                sliderW: document.getElementById('sliderCompanionWidth')?.value,
                sliderH: document.getElementById('sliderCompanionHeight')?.value,
                labelDims: document.getElementById('companionDimensionsLabel')?.textContent
            };
        })()`);

        record('Custom Slider updates Width to 280', customDims.sliderW === '280', `Got ${customDims.sliderW}`);
        record('Custom Slider updates Height to 320', customDims.sliderH === '320', `Got ${customDims.sliderH}`);
        record('Custom Dimensions Label is "280 × 320 px"', customDims.labelDims === '280 × 320 px', `Got ${customDims.labelDims}`);

        const compCustomBounds = await companionCdp.eval(`(() => ({
            winW: window.innerWidth,
            winH: window.innerHeight
        }))()`);

        record('Companion Window width reflects custom width (280px)', compCustomBounds.winW === 280, `Got ${compCustomBounds.winW}px`);
        record('Companion Window height reflects custom height (320px)', compCustomBounds.winH === 320, `Got ${compCustomBounds.winH}px`);

        const shotCustomPath = path.join(brainDir, 'companion_custom_280x320.png');
        await companionCdp.captureScreenshot(shotCustomPath);

        // Step 8: Test Dragging vs Size Stability
        console.log('[Step 8] Testing dragging scale stability (20 simulated position moves)...');
        for (let i = 0; i < 20; i++) {
            await companionCdp.eval(`window.companionIpc.moveWindow(5, 5)`);
            await sleep(30);
        }
        await sleep(300);

        const afterDragBounds = await companionCdp.eval(`(() => ({
            winW: window.innerWidth,
            winH: window.innerHeight
        }))()`);

        record('Dragging did not mutate Companion Width (strictly preserved)', afterDragBounds.winW === compCustomBounds.winW, `Got ${afterDragBounds.winW}px (was ${compCustomBounds.winW}px)`);
        record('Dragging did not mutate Companion Height (strictly preserved)', afterDragBounds.winH === compCustomBounds.winH, `Got ${afterDragBounds.winH}px (was ${compCustomBounds.winH}px)`);

        // Step 9: Test Docking and Undocking
        console.log('[Step 9] Testing docking and undocking...');
        await mainCdp.eval(`(() => {
            const btn = document.getElementById('settingsToggleFloatBtn');
            if (btn) btn.click();
        })()`);
        await sleep(1000);

        // Alter dimensions while docked: 200 × 240
        await mainCdp.eval(`(() => {
            const sw = document.getElementById('sliderCompanionWidth');
            const sh = document.getElementById('sliderCompanionHeight');
            if (sw && sh) {
                sw.value = 200;
                sw.dispatchEvent(new Event('input', { bubbles: true }));
                sh.value = 240;
                sh.dispatchEvent(new Event('input', { bubbles: true }));
            }
        })()`);
        await sleep(800);

        // Undock Lucy
        await mainCdp.eval(`(() => {
            const btn = document.getElementById('settingsToggleFloatBtn');
            if (btn) btn.click();
        })()`);
        await sleep(1500);

        // Reconnect to companion window
        const undockedTargets = await getCdpTargets(port, 10000);
        const undockedCompTarget = undockedTargets.find(t => t.url.includes('companion.html'));
        if (undockedCompTarget) {
            const newCompCdp = new SimpleCdpClient(undockedCompTarget.webSocketDebuggerUrl);
            await newCompCdp.connect();
            const undockedBounds = await newCompCdp.eval(`(() => ({
                winW: window.innerWidth,
                winH: window.innerHeight
            }))()`);

            record('Undocked companion restored dimensions configured while docked (200px width)', undockedBounds.winW === 200, `Got ${undockedBounds.winW}px`);
            record('Undocked companion restored dimensions configured while docked (240px height)', undockedBounds.winH === 240, `Got ${undockedBounds.winH}px`);
            newCompCdp.close();
        } else {
            record('Undocked companion window accessible', false, 'Window target not found');
        }

        // Capture settings UI screenshot
        const shotSettingsPath = path.join(brainDir, 'companion_settings_synchronized_ui.png');
        await mainCdp.captureScreenshot(shotSettingsPath);
        console.log(`Saved screenshot: ${shotSettingsPath}`);

        // Step 10: Clean Shutdown & Restart Verification
        console.log('[Step 10] Testing restart persistence...');
        mainCdp.close();
        if (companionCdp) companionCdp.close();

        // Kill process cleanly
        appProcess.kill();
        await sleep(1500);

        // Relaunch app with same sandbox user data
        console.log('[Step 10b] Relaunching application from persistent user-data...');
        appProcess = spawn(exePath, [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${isolatedUserData}`
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                LUCY_WORKSPACE_DIR: isolatedWorkspace,
                LUCY_SMOKE_TEST: 'false'
            }
        });

        const restartTargets = await getCdpTargets(port, 25000);
        const restartMainTarget = restartTargets.find(t => t.url.includes('index.html') || t.title.includes('L.U.C.Y.'));
        mainCdp = new SimpleCdpClient(restartMainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();
        await sleep(1000);

        // Switch to settings tab
        await mainCdp.eval(`(() => {
            const tab = document.querySelector('.nav-deck-tab[data-view="viewCompanionSettings"]') ||
                        document.querySelector('.nav-deck-tab[data-target-view="viewCompanionSettings"]');
            if (tab) tab.click();
        })()`);
        await sleep(500);

        const restartedDims = await mainCdp.eval(`(() => {
            return {
                sliderW: document.getElementById('sliderCompanionWidth')?.value,
                sliderH: document.getElementById('sliderCompanionHeight')?.value,
                labelDims: document.getElementById('companionDimensionsLabel')?.textContent
            };
        })()`);

        record('After Restart: Width Slider restored to saved 200', restartedDims.sliderW === '200', `Got ${restartedDims.sliderW}`);
        record('After Restart: Height Slider restored to saved 240', restartedDims.sliderH === '240', `Got ${restartedDims.sliderH}`);
        record('After Restart: Dimensions Label restored to "200 × 240 px"', restartedDims.labelDims === '200 × 240 px', `Got ${restartedDims.labelDims}`);

        // Reset to tiny default
        await mainCdp.eval(`(() => {
            const btn = document.getElementById('btnResetTinyPet');
            if (btn) btn.click();
        })()`);
        await sleep(500);

        const resetDims = await mainCdp.eval(`(() => ({
            sliderW: document.getElementById('sliderCompanionWidth')?.value,
            sliderH: document.getElementById('sliderCompanionHeight')?.value,
            labelDims: document.getElementById('companionDimensionsLabel')?.textContent
        }))()`);

        record('Reset to Tiny button restores 160 × 190 px', resetDims.labelDims === '160 × 190 px', `Got ${resetDims.labelDims}`);

    } finally {
        if (mainCdp) mainCdp.close();
        if (companionCdp) companionCdp.close();
        if (appProcess && !appProcess.killed) {
            try { appProcess.kill(); } catch (_) {}
        }
        try {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
        } catch (_) {}
    }

    const failed = checks.filter(c => !c.pass);
    console.log(`\n=== Verification Complete: ${checks.length - failed.length}/${checks.length} Passed ===`);
    if (failed.length > 0) {
        console.error('Failed checks:');
        for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
        process.exit(1);
    }
}

runVerification().catch(err => {
    console.error('Fatal verification error:', err);
    process.exit(1);
});
