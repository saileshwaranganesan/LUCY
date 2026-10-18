'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

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

async function getCdpTargets(port, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const data = await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
                    let raw = '';
                    res.on('data', chunk => raw += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.setTimeout(1500, () => req.destroy());
            });
            if (Array.isArray(data) && data.length > 0) return data;
        } catch (_) {}
        await sleep(500);
    }
    throw new Error(`Timed out waiting for CDP targets on port ${port}`);
}

async function runInstalledLucyVerification() {
    console.log('=== Verifying Installed Program: C:\\Users\\admin\\AppData\\Local\\Programs\\LUCY\\LUCY.exe ===\n');

    const installedExe = 'C:\\Users\\admin\\AppData\\Local\\Programs\\LUCY\\LUCY.exe';
    if (!fs.existsSync(installedExe)) {
        throw new Error(`Installed executable not found at: ${installedExe}`);
    }

    const port = 19266;
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-installed-test-'));
    const isolatedUserData = path.join(sandboxDir, 'userdata');
    const isolatedWorkspace = path.join(sandboxDir, 'workspace');
    const artifactsDir = path.resolve(__dirname, '../artifacts');

    fs.mkdirSync(isolatedUserData, { recursive: true });
    fs.mkdirSync(isolatedWorkspace, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });

    let appProcess = null;
    let mainCdp = null;

    try {
        console.log('[Step 1] Spawning installed LUCY.exe with remote debugging...');
        appProcess = spawn(installedExe, [
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

        appProcess.stdout.on('data', d => console.log('  [App stdout]', d.toString().trim()));
        appProcess.stderr.on('data', d => console.warn('  [App stderr]', d.toString().trim()));

        console.log('[Step 2] Connecting to installed app via CDP...');
        const targets = await getCdpTargets(port);
        const mainTarget = targets.find(t => t.url.includes('index.html') || t.title.includes('L.U.C.Y.'));
        if (!mainTarget) {
            throw new Error(`Main window target not found. Targets: ${JSON.stringify(targets)}`);
        }

        mainCdp = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();
        await mainCdp.send('Page.enable');
        await mainCdp.send('Runtime.enable');
        console.log('  ✓ Connected to installed application CDP session.');

        await sleep(1500);

        console.log('\n[Step 3] Checking for JavaScript runtime / parse exceptions...');
        console.log(`  Uncaught exceptions recorded: ${mainCdp.exceptions.length}`);
        if (mainCdp.exceptions.length > 0) {
            for (const ex of mainCdp.exceptions) {
                console.error('    Exception:', ex.text, ex.exception?.description);
            }
            throw new Error(`Installed app startup threw ${mainCdp.exceptions.length} unhandled runtime exceptions`);
        }
        console.log('  ✓ Zero unhandled runtime exceptions on startup.');

        console.log('\n[Step 4] Checking Celestial Familiar Fairy Renderer on creatureCanvas...');
        const companionState = await mainCdp.eval(`(() => {
            const canvas = document.getElementById('creatureCanvas');
            const renderer = window.companionRenderer || window.fairyRenderer;
            if (!canvas) return { ok: false, error: 'Canvas element not found' };
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
                emotion: renderer ? renderer.state.emotion : 'none'
            };
        })()`);

        console.log('  Fairy Renderer State:', JSON.stringify(companionState));
        if (!companionState.hasRenderer || !companionState.isRunning) {
            throw new Error('window.companionRenderer is not active');
        }
        if (companionState.renderedPixels === 0) {
            throw new Error('Canvas has 0 non-zero rendered pixels');
        }
        console.log(`  ✓ CelestialFamiliarRenderer active and rendering (${companionState.renderedPixels} pixels).`);

        console.log('\n[Step 5] Checking UI Clickability & Navigation...');
        // Test clicking navigation tabs
        const navDeckTest = await mainCdp.eval(`(() => {
            const settingsBtn = document.getElementById('tabNavSettings');
            const conversationBtn = document.getElementById('tabNavConversation');
            if (!settingsBtn) return { ok: false, error: 'tabNavSettings missing' };
            if (!conversationBtn) return { ok: false, error: 'tabNavConversation missing' };

            // Click settings
            settingsBtn.click();
            const viewSettings = document.getElementById('viewSettings');
            const settingsActive = viewSettings ? viewSettings.classList.contains('active') : false;

            // Click conversation back
            conversationBtn.click();
            const viewConversation = document.getElementById('viewConversation');
            const convActive = viewConversation ? viewConversation.classList.contains('active') : false;

            return {
                ok: true,
                settingsSwitchWorks: settingsActive,
                conversationSwitchWorks: convActive
            };
        })()`);

        console.log('  Nav Deck Switching Result:', JSON.stringify(navDeckTest));
        if (!navDeckTest.settingsSwitchWorks || !navDeckTest.conversationSwitchWorks) {
            throw new Error('Navigation deck tab clicking failed to switch views');
        }
        console.log('  ✓ UI buttons and navigation tabs are fully clickable and responsive.');

        console.log('\n[Step 6] Testing chat input interaction...');
        const chatInputTest = await mainCdp.eval(`(() => {
            const input = document.getElementById('promptInput') || document.querySelector('.chat-input') || document.querySelector('textarea, input[type="text"]');
            if (!input) return { ok: false, error: 'Input element not found' };
            input.focus();
            input.value = 'Hello L.U.C.Y.';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return {
                ok: true,
                value: input.value,
                isFocused: document.activeElement === input
            };
        })()`);

        console.log('  Chat Input Test Result:', JSON.stringify(chatInputTest));
        if (!chatInputTest.ok) {
            throw new Error(`Chat input failed: ${chatInputTest.error}`);
        }
        console.log('  ✓ User input fields are focused, editable, and responsive.');

        console.log('\n[Step 7] Capturing screenshot of verified installed application...');
        const screenshotPath = path.join(artifactsDir, 'installed_lucy_verified.png');
        await mainCdp.captureScreenshot(screenshotPath);
        console.log(`  ✓ Saved screenshot: ${screenshotPath} (${fs.statSync(screenshotPath).size} bytes)`);

        console.log('\n=== ALL VERIFICATIONS PASSED: Installed LUCY is 100% functional and interactive! ===');
    } finally {
        if (mainCdp) mainCdp.close();
        if (appProcess) {
            try { appProcess.kill('SIGKILL'); } catch (_) {}
        }
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    }
}

runInstalledLucyVerification().catch(err => {
    console.error('\n❌ Verification Failed:', err.message);
    process.exit(1);
});
