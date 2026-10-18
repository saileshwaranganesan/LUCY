'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CDP_PORT = 19227;
const ARTIFACTS_DIR = 'C:/Users/admin/.gemini/antigravity-ide/brain/7ae752c2-9344-4b22-a07e-0613214bb3df';
const EXE_PATH = path.resolve(__dirname, '../dist-release/win-unpacked/LUCY.exe');
const SANDBOX_DIR = path.join(require('os').tmpdir(), 'lucy-anim-shots-' + Date.now());

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
                    if (data.error) rej(new Error(data.error.message));
                    else res(data.result);
                }
            };
        });
    }

    send(method, params = {}) {
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
            throw new Error(`Eval error: ${res.exceptionDetails.text}`);
        }
        return res.result ? res.result.value : undefined;
    }

    async captureScreenshot() {
        const res = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        return Buffer.from(res.data, 'base64');
    }

    close() {
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
    }
}

async function run() {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    const appProcess = spawn(EXE_PATH, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${SANDBOX_DIR}`,
        '--no-sandbox'
    ], { stdio: 'ignore' });

    try {
        let targets = [];
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            try {
                const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
                if (res.ok) {
                    targets = await res.json();
                    if (targets && targets.length > 0) break;
                }
            } catch (_) {}
        }

        const mainTarget = targets.find((t) => t.type === 'page' && !t.url.includes('companion.html'));
        const mainCdp = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();

        // Float companion
        await mainCdp.eval(`window.lucyIpc.toggleCompanionWindow({ action: 'float' })`);
        await sleep(1500);

        let compTarget = null;
        for (let i = 0; i < 20; i++) {
            const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
            const list = await res.json();
            compTarget = list.find((t) => t.url.includes('companion.html'));
            if (compTarget) break;
            await sleep(500);
        }

        const compCdp = new SimpleCdpClient(compTarget.webSocketDebuggerUrl);
        await compCdp.connect();

        // 1. Speaking State (Pointer Away)
        await compCdp.eval(`(() => {
            const r = window.fairyRenderer;
            if (r) r.setVisualState({ emotion: 'speaking' });
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            if (text) text.textContent = 'SPEAKING';
            if (dot) {
                dot.style.background = '#70d6ff';
                dot.style.boxShadow = '0 0 6px #70d6ff';
            }
        })()`);
        await sleep(250);
        const speakingAwayShot = await compCdp.captureScreenshot();
        fs.writeFileSync(path.join(ARTIFACTS_DIR, 'companion_speaking_away_state.png'), speakingAwayShot);
        console.log('Saved: companion_speaking_away_state.png');

        // 2. Speaking State (Hover Active)
        await compCdp.eval(`document.getElementById('companionContainer').classList.add('controls-visible')`);
        await sleep(350);
        const speakingHoverShot = await compCdp.captureScreenshot();
        fs.writeFileSync(path.join(ARTIFACTS_DIR, 'companion_speaking_hover_state.png'), speakingHoverShot);
        console.log('Saved: companion_speaking_hover_state.png');

        // 3. Listening State (Hover Active)
        await compCdp.eval(`(() => {
            const r = window.fairyRenderer;
            if (r) r.setVisualState({ emotion: 'listening' });
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            if (text) text.textContent = 'LISTENING';
            if (dot) {
                dot.style.background = '#ff70a6';
                dot.style.boxShadow = '0 0 6px #ff70a6';
            }
        })()`);
        await sleep(250);
        const listeningHoverShot = await compCdp.captureScreenshot();
        fs.writeFileSync(path.join(ARTIFACTS_DIR, 'companion_listening_hover_state.png'), listeningHoverShot);
        console.log('Saved: companion_listening_hover_state.png');

        compCdp.close();
        mainCdp.close();
    } finally {
        appProcess.kill();
        await sleep(500);
        try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch (_) {}
    }
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
