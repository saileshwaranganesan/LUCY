'use strict';

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
                    if (data.error) rej(new Error(data.error.message || JSON.stringify(data.error)));
                    else res(data.result);
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
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
    }
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCdpTargets(port, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json`);
            if (res.ok) return await res.json();
        } catch (_) {}
        await sleep(300);
    }
    throw new Error(`Timed out waiting for CDP endpoint on port ${port}`);
}

async function inspectFairy() {
    const projectRoot = path.resolve(__dirname, '..');
    const localElectron = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const port = 19235;
    const sandboxDir = path.join(os.tmpdir(), `lucy-inspect-fairy-${Date.now()}`);
    const brainDir = 'C:\\Users\\admin\\.gemini\\antigravity-ide\\brain\\7ae752c2-9344-4b22-a07e-0613214bb3df';

    fs.mkdirSync(sandboxDir, { recursive: true });

    let appProcess = null;
    let mainCdp = null;

    try {
        appProcess = spawn(localElectron, [
            '.',
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${path.join(sandboxDir, 'user-data')}`
        ], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                LUCY_WORKSPACE_DIR: path.join(sandboxDir, 'workspace'),
                LUCY_SMOKE_TEST: 'false'
            }
        });

        const targets = await getCdpTargets(port, 20000);
        const mainTarget = targets.find((t) => t.url.includes('index.html') || t.title.includes('L.U.C.Y.'));
        mainCdp = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();
        await mainCdp.send('Page.enable');
        await mainCdp.send('Runtime.enable');

        await sleep(2500);

        // Inspect color palettes returned for different emotions
        const paletteAudit = await mainCdp.eval(`(() => {
            const canvas = document.getElementById('creatureCanvas');
            if (!canvas) return { error: 'canvas not found' };
            const r = new window.CelestialFamiliarRenderer(canvas);
            const emotions = ['idle', 'happy', 'pet', 'speaking', 'curious', 'worried', 'magic', 'sleep'];
            const results = {};
            emotions.forEach(e => {
                r.state.emotion = e;
                results[e] = r._getColorPalette();
            });
            return results;
        })()`);

        console.log('=== Color Palette Across Emotions ===');
        console.log(JSON.stringify(paletteAudit, null, 2));

        // Function to capture canvas dataURL and write to disk
        async function captureCanvas(targetCdp, canvasId, filename) {
            const shot = await targetCdp.eval(`(() => {
                const canvas = document.getElementById('${canvasId}');
                return canvas ? canvas.toDataURL('image/png') : null;
            })()`);
            if (shot) {
                const base64Data = shot.replace(/^data:image\/png;base64,/, '');
                fs.writeFileSync(path.join(brainDir, filename), Buffer.from(base64Data, 'base64'));
                console.log('Saved:', filename);
            } else {
                console.warn('Canvas not found for:', filename);
            }
        }

        // 1. Idle state
        await mainCdp.eval(`(() => {
            if (window.companionRenderer) {
                window.companionRenderer.setVisualState({ emotion: 'idle' });
            }
        })()`);
        await sleep(600);
        await captureCanvas(mainCdp, 'creatureCanvas', 'fairy_repaired_idle.png');

        // 2. Pet state (raised arms & celebration)
        await mainCdp.eval(`(() => {
            const btn = document.getElementById('petBtn');
            if (btn) btn.click();
            else if (window.companionRenderer) window.companionRenderer.setVisualState({ emotion: 'pet' });
        })()`);
        await sleep(700);
        await captureCanvas(mainCdp, 'creatureCanvas', 'fairy_repaired_pet.png');

        // 3. Speaking state (gesturing arm)
        await mainCdp.eval(`(() => {
            if (window.companionRenderer) {
                window.companionRenderer.setVisualState({ emotion: 'speaking' });
            }
        })()`);
        await sleep(600);
        await captureCanvas(mainCdp, 'creatureCanvas', 'fairy_repaired_speaking.png');

        // 4. Curious state
        await mainCdp.eval(`(() => {
            if (window.companionRenderer) {
                window.companionRenderer.setVisualState({ emotion: 'curious' });
            }
        })()`);
        await sleep(600);
        await captureCanvas(mainCdp, 'creatureCanvas', 'fairy_repaired_curious.png');

        // 5. Worried state
        await mainCdp.eval(`(() => {
            if (window.companionRenderer) {
                window.companionRenderer.setVisualState({ emotion: 'worried' });
            }
        })()`);
        await sleep(600);
        await captureCanvas(mainCdp, 'creatureCanvas', 'fairy_repaired_worried.png');

        // 6. Test Floating Companion
        console.log('Spawning floating companion...');
        await mainCdp.eval(`(() => {
            const floatBtn = document.getElementById('toggleFloatingBtn');
            if (floatBtn) floatBtn.click();
        })()`);
        await sleep(2000);

        // Find floating window target
        const updatedTargets = await getCdpTargets(port, 10000);
        const companionTarget = updatedTargets.find((t) => t.url.includes('companion.html'));
        if (companionTarget) {
            console.log('Connecting to floating companion CDP...');
            const companionCdp = new SimpleCdpClient(companionTarget.webSocketDebuggerUrl);
            await companionCdp.connect();
            await companionCdp.send('Page.enable');
            await companionCdp.send('Runtime.enable');
            await sleep(1000);

            // Capture floating companion at standard size
            await captureCanvas(companionCdp, 'fairyCanvas', 'fairy_floating_standard.png');

            // Resize floating companion to tiny (160x190) and capture
            await companionCdp.eval(`(() => {
                if (window.companionIpc && window.companionIpc.setWindowSize) {
                    window.companionIpc.setWindowSize(160, 190, true);
                }
            })()`);
            await sleep(1000);
            await captureCanvas(companionCdp, 'fairyCanvas', 'fairy_floating_tiny.png');

            companionCdp.close();
        } else {
            console.warn('Floating companion target not found in CDP list');
        }

        console.log('All fairy inspection captures completed successfully.');

    } finally {
        if (mainCdp) mainCdp.close();
        if (appProcess) {
            try { appProcess.kill('SIGKILL'); } catch (_) {}
        }
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    }
}

inspectFairy().catch((err) => {
    console.error('Fairy inspection error:', err);
    process.exit(1);
});
