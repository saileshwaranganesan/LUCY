'use strict';

/**
 * L.U.C.Y. Repair 11: Live Main UI Parse and Settings Center Verification
 * 
 * Verifies that:
 * 1. app.js loads without parse errors or uncaught exceptions.
 * 2. window.companionRenderer starts and renders onto #creatureCanvas.
 * 3. Unified Settings Center opens from the navigation deck.
 * 4. All 8 canonical settings tabs switch and activate their respective panes.
 * 5. Input values are preserved across tab switching.
 * 6. Captures screenshots showing restored fairy renderer and Settings Center.
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
        this.exceptions = [];
        this.consoleLogs = [];
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (err) => reject(err);
            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.method === 'Runtime.exceptionThrown') {
                    this.exceptions.push(data.params.exceptionDetails);
                    console.error('  [CDP Exception]', data.params.exceptionDetails.text, data.params.exceptionDetails.exception?.description || '');
                }
                if (data.method === 'Runtime.consoleAPICalled') {
                    const msg = data.params.args.map(a => a.value || a.description).join(' ');
                    this.consoleLogs.push({ type: data.params.type, text: msg });
                }
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
    return new Promise((r) => setTimeout(r, ms));
}

async function getCdpTargets(port, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json`);
            if (res.ok) {
                return await res.json();
            }
        } catch (_) {}
        await sleep(300);
    }
    throw new Error(`Timed out waiting for CDP port ${port}`);
}

async function run() {
    console.log('=== L.U.C.Y. Repair 11: Live Main UI & Settings Center Verification ===\n');

    const projectRoot = path.resolve(__dirname, '..');
    const port = 19265;
    const sandboxDir = path.join(os.tmpdir(), `lucy-r11-test-${Date.now()}`);
    const isolatedUserData = path.join(sandboxDir, 'user-data');
    const isolatedWorkspace = path.join(sandboxDir, 'workspace');
    const artifactsDir = path.join(projectRoot, 'artifacts');

    fs.mkdirSync(isolatedUserData, { recursive: true });
    fs.mkdirSync(isolatedWorkspace, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });

    let electronProcess = null;
    let mainCdp = null;

    try {
        console.log('[Step 1] Launching development Electron app with remote debugging...');
        const electronBin = require('electron');

        electronProcess = spawn(electronBin, [
            projectRoot,
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${isolatedUserData}`
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                LUCY_WORKSPACE_DIR: isolatedWorkspace,
                LUCY_PERMISSION_MODE: 'standard',
                LUCY_SMOKE_TEST: 'false'
            }
        });

        electronProcess.stdout.on('data', d => console.log('  [App stdout]', d.toString().trim()));
        electronProcess.stderr.on('data', d => console.warn('  [App stderr]', d.toString().trim()));

        console.log('[Step 2] Connecting to Main Window via CDP...');
        const targets = await getCdpTargets(port);
        const mainTarget = targets.find(t => t.url.includes('index.html') || t.title.includes('L.U.C.Y.'));
        if (!mainTarget) {
            throw new Error(`Main window not found in targets: ${JSON.stringify(targets)}`);
        }

        mainCdp = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();
        await mainCdp.send('Page.enable');
        await mainCdp.send('Runtime.enable');
        console.log('  ✓ Connected to main window CDP.');

        // Allow DOMContentLoaded and renderer frames
        await sleep(1500);

        console.log('\n[Step 3] Checking for JavaScript runtime exceptions during startup...');
        console.log(`  Uncaught exceptions recorded: ${mainCdp.exceptions.length}`);
        if (mainCdp.exceptions.length > 0) {
            for (const ex of mainCdp.exceptions) {
                console.error('    Exception:', ex.text, ex.exception?.description);
            }
            throw new Error(`Startup threw ${mainCdp.exceptions.length} unhandled runtime exceptions`);
        }
        console.log('  ✓ Zero unhandled runtime exceptions on application startup.');

        console.log('\n[Step 4] Verifying Celestial Familiar Fairy Renderer on main canvas...');
        const companionState = await mainCdp.eval(`(() => {
            const canvas = document.getElementById('creatureCanvas');
            const renderer = window.companionRenderer || window.fairyRenderer;
            if (!canvas) return { ok: false, error: 'Canvas not found' };
            const ctx = canvas.getContext('2d');
            const imgData = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
            let nonZeroPixels = 0;
            if (imgData) {
                for (let i = 3; i < imgData.data.length; i += 4) {
                    if (imgData.data[i] > 10) nonZeroPixels++;
                }
            }
            return {
                ok: true,
                canvasWidth: canvas.width,
                canvasHeight: canvas.height,
                renderedPixels: nonZeroPixels,
                hasRenderer: Boolean(renderer),
                isRunning: Boolean(renderer && renderer.running),
                emotion: renderer ? renderer.state.emotion : 'none',
                rendererName: renderer ? renderer.constructor.name : 'Unknown'
            };
        })()`);

        console.log('  Companion Renderer State:', JSON.stringify(companionState, null, 2));
        if (!companionState.hasRenderer || !companionState.isRunning) {
            throw new Error('window.companionRenderer is not running');
        }
        if (companionState.renderedPixels === 0) {
            throw new Error('No non-zero alpha pixels rendered on creatureCanvas');
        }
        console.log(`  ✓ CelestialFamiliarRenderer active and rendering (${companionState.renderedPixels} non-zero pixels)`);

        console.log('\n[Step 5] Capturing restored main window screenshot...');
        const mainShotPath = path.join(artifactsDir, 'repair11_main_window_fairy_restored.png');
        await mainCdp.captureScreenshot(mainShotPath);
        console.log(`  ✓ Saved screenshot: ${mainShotPath} (${fs.statSync(mainShotPath).size} bytes)`);

        console.log('\n[Step 6] Verifying Unified Settings Center entry and tab navigation...');
        // 1. Click Settings Tab in navigation deck
        const openSettingsResult = await mainCdp.eval(`(() => {
            const settingsNavTab = document.getElementById('tabNavSettings');
            if (!settingsNavTab) return { ok: false, error: 'tabNavSettings button missing' };
            settingsNavTab.click();
            const viewSettings = document.getElementById('viewSettings');
            return {
                ok: true,
                isSettingsViewActive: viewSettings ? viewSettings.classList.contains('active') : false
            };
        })()`);

        console.log('  Open Settings View Result:', JSON.stringify(openSettingsResult));
        if (!openSettingsResult.ok || !openSettingsResult.isSettingsViewActive) {
            throw new Error('Failed to open viewSettings via tabNavSettings');
        }
        console.log('  ✓ Centralized Settings Center view opened.');

        // 2. Test each of the 8 canonical tabs
        const canonicalTabs = [
            { id: 'general', paneId: 'paneGeneral' },
            { id: 'companion', paneId: 'paneCompanion' },
            { id: 'voice', paneId: 'paneVoice' },
            { id: 'ai', paneId: 'paneAi' },
            { id: 'handsfree', paneId: 'paneHandsfree' },
            { id: 'memory', paneId: 'paneMemory' },
            { id: 'automation', paneId: 'paneAutomation' },
            { id: 'about', paneId: 'paneAbout' }
        ];

        for (const tab of canonicalTabs) {
            const tabResult = await mainCdp.eval(`(() => {
                const btn = document.querySelector('.settings-center-tab-btn[data-settings-tab="${tab.id}"]');
                if (!btn) return { ok: false, error: 'Tab button not found for ${tab.id}' };
                btn.click();
                const pane = document.getElementById('${tab.paneId}');
                return {
                    ok: true,
                    btnActive: btn.classList.contains('active'),
                    paneActive: pane ? pane.classList.contains('active') : false,
                    display: pane ? window.getComputedStyle(pane).display : 'none'
                };
            })()`);

            if (!tabResult.ok || !tabResult.btnActive || !tabResult.paneActive) {
                throw new Error(`Tab navigation failed for [${tab.id}]: ${JSON.stringify(tabResult)}`);
            }
            console.log(`  ✓ Tab [${tab.id}] switched successfully -> pane [${tab.paneId}] active (display: ${tabResult.display})`);
        }

        console.log('\n[Step 7] Verifying unsaved input preservation across tab switches...');
        const preservationResult = await mainCdp.eval(`(() => {
            // Select general tab, set test close action
            window.switchSettingsCenterTab('general');
            const closeSelect = document.getElementById('settingCloseAction');
            if (closeSelect) closeSelect.value = 'minimize_to_tray';

            // Select companion tab
            window.switchSettingsCenterTab('companion');

            // Select ai tab, enter custom text into manualModelInput
            window.switchSettingsCenterTab('ai');
            const modelInput = document.getElementById('manualModelInput');
            if (modelInput) modelInput.value = 'custom-mistral-nemo:12b';

            // Navigate to memory, then voice, then back to ai and general
            window.switchSettingsCenterTab('memory');
            window.switchSettingsCenterTab('voice');
            window.switchSettingsCenterTab('ai');
            const preservedModel = modelInput ? modelInput.value : '';

            window.switchSettingsCenterTab('general');
            const preservedClose = closeSelect ? closeSelect.value : '';

            return {
                ok: true,
                preservedModel,
                preservedClose
            };
        })()`);

        console.log('  Preservation Result:', JSON.stringify(preservationResult));
        if (preservationResult.preservedModel !== 'custom-mistral-nemo:12b') {
            throw new Error('Unsaved input on AI tab was lost during tab switching');
        }
        if (preservationResult.preservedClose !== 'minimize_to_tray') {
            throw new Error('Unsaved selection on General tab was lost during tab switching');
        }
        console.log('  ✓ Unsaved inputs perfectly preserved across tab navigation.');

        console.log('\n[Step 8] Capturing Settings Center active screenshot...');
        const settingsShotPath = path.join(artifactsDir, 'repair11_settings_center_active.png');
        await mainCdp.captureScreenshot(settingsShotPath);
        console.log(`  ✓ Saved screenshot: ${settingsShotPath} (${fs.statSync(settingsShotPath).size} bytes)`);

        console.log('\n=== All Main UI & Settings Center Checks Passed Successfully! ===');

    } finally {
        if (mainCdp) mainCdp.close();
        if (electronProcess) {
            console.log('\n[Teardown] Shutting down application...');
            try { electronProcess.kill('SIGTERM'); } catch (_) {}
            await sleep(1500);
        }
    }
}

run().catch((err) => {
    console.error('\n❌ Verification Failed:', err);
    process.exit(1);
});
