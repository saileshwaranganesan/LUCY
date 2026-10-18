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

async function inspectLayout() {
    const projectRoot = path.resolve(__dirname, '..');
    const localElectron = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const packagedExe = path.join(projectRoot, 'dist-release', 'win-unpacked', 'LUCY.exe');
    const usePackaged = process.argv.includes('--packaged');
    const exePath = usePackaged && fs.existsSync(packagedExe) ? packagedExe : localElectron;
    const spawnArgs = usePackaged
        ? []
        : ['.'];

    const port = 19230;
    const sandboxDir = path.join(os.tmpdir(), `lucy-inspect-settings-${Date.now()}`);

    fs.mkdirSync(sandboxDir, { recursive: true });

    let appProcess = null;
    let mainCdp = null;

    try {
        appProcess = spawn(exePath, [
            ...spawnArgs,
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

        await sleep(2000);

        // Switch to Companion Settings view
        const switchRes = await mainCdp.eval(`(() => {
            const tab = document.getElementById('tabNavCompanionSettings');
            if (!tab) return { ok: false, error: 'tab not found' };
            tab.click();
            const view = document.getElementById('viewCompanionSettings');
            return {
                ok: true,
                tabClass: tab.className,
                dataView: tab.getAttribute('data-view'),
                viewClass: view ? view.className : 'no-view'
            };
        })()`);
        console.log('Switch tab result:', switchRes);
        await sleep(600);

        const inspection = await mainCdp.eval(`(() => {
            function getInfo(el, name) {
                if (!el) return { name, exists: false };
                const cs = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return {
                    name,
                    exists: true,
                    tagName: el.tagName,
                    id: el.id,
                    className: el.className,
                    clientHeight: el.clientHeight,
                    scrollHeight: el.scrollHeight,
                    offsetHeight: el.offsetHeight,
                    rect: { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width },
                    computed: {
                        display: cs.display,
                        flex: cs.flex,
                        flexDirection: cs.flexDirection,
                        height: cs.height,
                        minHeight: cs.minHeight,
                        maxHeight: cs.maxHeight,
                        overflow: cs.overflow,
                        overflowY: cs.overflowY,
                        position: cs.position,
                        boxSizing: cs.boxSizing
                    }
                };
            }

            const mainStage = document.querySelector('.main-stage');
            const viewport = document.getElementById('jarvisViewsViewport');
            const settingsView = document.getElementById('viewCompanionSettings');
            const consoleFooter = document.querySelector('.command-console');
            const boxes = settingsView ? Array.from(settingsView.querySelectorAll('.jarvis-box')).map((b, i) => getInfo(b, 'box-' + i)) : [];
            const controlsToCheck = [
                { id: 'btnResetTinyPet', label: 'Tiny Default Size Preset' },
                { id: 'btnMediumPet', label: 'Comfortable Size Preset' },
                { id: 'settingsToggleFloatBtn', label: 'Float Pet to Desktop Button' },
                { id: 'sliderCompanionWidth', label: 'Companion Width Slider' },
                { id: 'sliderCompanionHeight', label: 'Companion Height Slider' },
                { id: 'btnTestFairyVoice', label: 'Test Fairy Voice Button' },
                { id: 'settingsTtsEngineSelect', label: 'TTS Engine Select' },
                { id: 'settingsKokoroVoiceSelect', label: 'Voice Persona Preset Select' },
                { id: 'sliderVoiceRate', label: 'Speech Rate Slider' },
                { id: 'sliderVoicePitch', label: 'Speech Pitch Slider' },
                { id: 'sliderVoiceVolume', label: 'Speech Volume Slider' },
                { id: 'checkWakeWordActive', label: 'Wake-Word Detection Checkbox' },
                { id: 'settingCloseAction', label: 'Main-Window Close Behaviour' },
                { id: 'checkBackgroundListening', label: 'Background Voice & Listening' },
                { id: 'checkCompanionPinned', label: 'Pin Fairy Companion to Top' },
                { id: 'btnExplicitExitCompanion', label: 'Explicit Application Exit Button' }
            ];

            const initialControlStates = controlsToCheck.map(c => {
                const el = document.getElementById(c.id);
                if (!el) return { ...c, exists: false };
                const r = el.getBoundingClientRect();
                return {
                    ...c,
                    exists: true,
                    tagName: el.tagName,
                    top: Math.round(r.top),
                    bottom: Math.round(r.bottom),
                    height: Math.round(r.height)
                };
            });

            // Measure at scrollTop = 0
            if (viewport) viewport.scrollTop = 0;
            const topScrollTop = viewport ? viewport.scrollTop : 0;

            // Scroll to bottom
            if (viewport) viewport.scrollTop = 9999;
            const maxScrollTop = viewport ? viewport.scrollTop : 0;
            const viewportRect = viewport ? viewport.getBoundingClientRect() : { top: 0, bottom: 0, height: 0 };
            const footerRect = consoleFooter ? consoleFooter.getBoundingClientRect() : { top: 9999 };

            const bottomControlStates = controlsToCheck.map(c => {
                const el = document.getElementById(c.id);
                if (!el) return { ...c, exists: false };
                const r = el.getBoundingClientRect();
                const fullyVisibleAtBottom = (r.top >= viewportRect.top - 2) && (r.bottom <= Math.min(viewportRect.bottom + 2, footerRect.top));
                const partiallyVisibleAtBottom = (r.bottom > viewportRect.top) && (r.top < viewportRect.bottom);
                return {
                    ...c,
                    exists: true,
                    top: Math.round(r.top),
                    bottom: Math.round(r.bottom),
                    fullyVisibleAtBottom,
                    partiallyVisibleAtBottom
                };
            });

            // Test scrollIntoView for each control
            const scrollIntoViewResults = controlsToCheck.map(c => {
                const el = document.getElementById(c.id);
                if (!el) return { ...c, reachable: false };
                el.scrollIntoView({ block: 'nearest' });
                const r = el.getBoundingClientRect();
                const reachable = (r.top >= viewportRect.top - 2) && (r.bottom <= Math.min(viewportRect.bottom + 2, footerRect.top));
                return {
                    ...c,
                    reachable,
                    top: Math.round(r.top),
                    bottom: Math.round(r.bottom)
                };
            });

            return {
                windowInnerHeight: window.innerHeight,
                windowInnerWidth: window.innerWidth,
                mainStage: getInfo(mainStage, 'mainStage'),
                viewport: getInfo(viewport, 'viewport'),
                settingsView: getInfo(settingsView, 'settingsView'),
                consoleFooter: getInfo(consoleFooter, 'consoleFooter'),
                boxes,
                topScrollTop,
                maxScrollTop,
                initialControlStates,
                bottomControlStates,
                scrollIntoViewResults
            };
        })()`);

        console.log('=== Companion Settings Layout Inspection ===');
        console.log(JSON.stringify(inspection, null, 2));

        // Test native mouse wheel dispatch via CDP
        await mainCdp.eval(`(() => {
            const vp = document.getElementById('jarvisViewsViewport');
            if (vp) vp.scrollTop = 0;
        })()`);
        await sleep(200);

        const beforeWheelScroll = await mainCdp.eval(`document.getElementById('jarvisViewsViewport').scrollTop`);

        await mainCdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: 500,
            y: 350,
            deltaX: 0,
            deltaY: 200
        });
        await sleep(400);

        const afterWheelScroll = await mainCdp.eval(`document.getElementById('jarvisViewsViewport').scrollTop`);
        console.log(`Mouse wheel test: before=${beforeWheelScroll}, after=${afterWheelScroll}`);

        // Capture top screenshot
        await mainCdp.eval(`(() => {
            const vp = document.getElementById('jarvisViewsViewport');
            if (vp) vp.scrollTop = 0;
        })()`);
        await sleep(300);

        const topShot = await mainCdp.send('Page.captureScreenshot', { format: 'png' });
        const brainDir = 'C:\\Users\\admin\\.gemini\\antigravity-ide\\brain\\7ae752c2-9344-4b22-a07e-0613214bb3df';
        fs.writeFileSync(path.join(brainDir, 'repair2_companion_settings_top.png'), Buffer.from(topShot.data, 'base64'));

        // Capture bottom screenshot
        await mainCdp.eval(`(() => {
            const vp = document.getElementById('jarvisViewsViewport');
            if (vp) vp.scrollTop = 9999;
        })()`);
        await sleep(300);

        const bottomShot = await mainCdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(brainDir, 'repair2_companion_settings_bottom.png'), Buffer.from(bottomShot.data, 'base64'));
        console.log('Screenshots saved successfully to brain directory.');

    } finally {
        if (mainCdp) mainCdp.close();
        if (appProcess) {
            try { appProcess.kill('SIGKILL'); } catch (_) {}
        }
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    }
}

inspectLayout().catch((err) => {
    console.error('Inspection error:', err);
    process.exit(1);
});
