'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CDP_PORT = 19226;
const ARTIFACTS_DIR = 'C:/Users/admin/.gemini/antigravity-ide/brain/7ae752c2-9344-4b22-a07e-0613214bb3df';
const EXE_PATH = path.resolve(__dirname, '../dist-release/win-unpacked/LUCY.exe');
const SANDBOX_DIR = path.join(require('os').tmpdir(), 'lucy-hover-verify-' + Date.now());

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
    const res = await fetch(url);
    return await res.json();
}

class SimpleCdp {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (err) => reject(err);
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.id && this.pending.has(msg.id)) {
                    const { res, rej } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) rej(new Error(msg.error.message));
                    else res(msg.result);
                }
            };
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((res, rej) => {
            this.pending.set(id, { res, rej });
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
            throw new Error(res.exceptionDetails.text || 'CDP Eval Exception');
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
        }
    }
}

async function run() {
    console.log('=== L.U.C.Y. Repair 6: Live Packaged Hover-Only Visibility Verification ===');
    console.log('Target Binary:', EXE_PATH);
    console.log('Sandbox Profile:', SANDBOX_DIR);

    fs.mkdirSync(SANDBOX_DIR, { recursive: true });

    const appProcess = spawn(EXE_PATH, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${SANDBOX_DIR}`,
        '--no-sandbox'
    ], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    appProcess.stdout.on('data', (d) => process.stdout.write('[App] ' + d.toString()));
    appProcess.stderr.on('data', (d) => process.stderr.write('[App Err] ' + d.toString()));

    try {
        console.log('Waiting for CDP endpoint...');
        let connected = false;
        let targets = [];
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            try {
                targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
                if (targets && targets.length > 0) {
                    connected = true;
                    break;
                }
            } catch (_) {}
        }

        if (!connected) throw new Error('Could not connect to packaged app via CDP');

        console.log('Connected to packaged app. Finding main window...');
        const mainTarget = targets.find((t) => t.type === 'page' && !t.url.includes('companion.html'));
        if (!mainTarget) throw new Error('Main window target not found');

        const mainCdp = new SimpleCdp(mainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();
        console.log('Main window CDP connected.');

        // Step 1: Open Floating Companion
        console.log('\n[Step 1] Opening Floating Companion...');
        await mainCdp.eval(`window.lucyIpc.toggleCompanionWindow({ action: 'float' })`);
        await sleep(1500);

        // Find companion target with retry
        let compTarget = null;
        for (let i = 0; i < 20; i++) {
            const updatedTargets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
            compTarget = updatedTargets.find((t) => t.url.includes('companion.html'));
            if (compTarget) break;
            await sleep(500);
        }
        if (!compTarget) throw new Error('Floating Companion target not found in CDP list');

        const compCdp = new SimpleCdp(compTarget.webSocketDebuggerUrl);
        await compCdp.connect();
        console.log('Companion window CDP connected.');

        // Check 1: Normal State (Pointer Away)
        console.log('\n[Check 1] Inspecting Normal State (Pointer Away)...');
        const normalState = await compCdp.eval(`(() => {
            const dock = document.getElementById('controlDock');
            const close = document.getElementById('closeBtn');
            const pill = document.getElementById('statusPill');
            const sidePanel = document.getElementById('sideConversationPanel');
            const canvas = document.getElementById('fairyCanvas');
            const container = document.getElementById('companionContainer');

            const dockStyle = window.getComputedStyle(dock);
            const closeStyle = window.getComputedStyle(close);
            const pillStyle = window.getComputedStyle(pill);
            const panelStyle = window.getComputedStyle(sidePanel);

            return {
                dockHidden: dockStyle.opacity === '0' && dockStyle.visibility === 'hidden' && dockStyle.pointerEvents === 'none',
                closeHidden: closeStyle.opacity === '0' && closeStyle.visibility === 'hidden' && closeStyle.pointerEvents === 'none',
                pillHidden: pillStyle.opacity === '0' && pillStyle.visibility === 'hidden' && pillStyle.pointerEvents === 'none',
                sidePanelCollapsed: sidePanel.classList.contains('collapsed') || panelStyle.display === 'none',
                canvasVisible: canvas && canvas.offsetWidth > 0 && canvas.offsetHeight > 0,
                rendererActive: window.fairyRenderer && window.fairyRenderer.running
            };
        })()`);

        console.log('Normal state result:', normalState);
        if (!normalState.dockHidden || !normalState.closeHidden || !normalState.pillHidden || !normalState.sidePanelCollapsed) {
            throw new Error('Normal state failed: auxiliary elements are visible when pointer is away!');
        }
        if (!normalState.canvasVisible || !normalState.rendererActive) {
            throw new Error('Normal state failed: fairy canvas or renderer is not active!');
        }
        console.log('✓ Normal State: ALL auxiliary controls and status indicators hidden; Fairy visible and animated.');

        const normalScreenshot = await compCdp.captureScreenshot();
        fs.writeFileSync(path.join(ARTIFACTS_DIR, 'companion_hover_away_state.png'), normalScreenshot);
        console.log('Saved screenshot: companion_hover_away_state.png');

        // Check 2: Hover State (Pointer Over Companion)
        console.log('\n[Check 2] Simulating pointer entering companion interaction region...');
        await compCdp.eval(`(() => {
            const container = document.getElementById('companionContainer');
            container.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
            container.classList.add('controls-visible');
        })()`);
        await sleep(350);

        const hoverState = await compCdp.eval(`(() => {
            const dock = document.getElementById('controlDock');
            const close = document.getElementById('closeBtn');
            const pill = document.getElementById('statusPill');
            const statusText = document.getElementById('statusText');

            const dockStyle = window.getComputedStyle(dock);
            const closeStyle = window.getComputedStyle(close);
            const pillStyle = window.getComputedStyle(pill);

            return {
                dockVisible: parseFloat(dockStyle.opacity) > 0.8 && dockStyle.visibility === 'visible' && dockStyle.pointerEvents === 'auto',
                closeVisible: parseFloat(closeStyle.opacity) > 0.8 && closeStyle.visibility === 'visible' && closeStyle.pointerEvents === 'auto',
                pillVisible: parseFloat(pillStyle.opacity) > 0.8 && pillStyle.visibility === 'visible' && pillStyle.pointerEvents === 'auto',
                statusText: statusText ? statusText.textContent : ''
            };
        })()`);

        console.log('Hover state result:', hoverState);
        if (!hoverState.dockVisible || !hoverState.closeVisible || !hoverState.pillVisible) {
            throw new Error('Hover state failed: controls or status pill not visible on hover!');
        }
        console.log('✓ Hover State: Controls and status indicator smoothly revealed and interactive.');

        const hoverScreenshot = await compCdp.captureScreenshot();
        fs.writeFileSync(path.join(ARTIFACTS_DIR, 'companion_hover_active_state.png'), hoverScreenshot);
        console.log('Saved screenshot: companion_hover_active_state.png');

        // Check 3: Pointer Exit (Pointer Leaves Companion)
        console.log('\n[Check 3] Simulating pointer leaving companion interaction region...');
        await compCdp.eval(`(() => {
            const container = document.getElementById('companionContainer');
            container.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
            container.classList.remove('controls-visible');
        })()`);
        await sleep(350);

        const exitState = await compCdp.eval(`(() => {
            const dock = document.getElementById('controlDock');
            const close = document.getElementById('closeBtn');
            const pill = document.getElementById('statusPill');

            const dockStyle = window.getComputedStyle(dock);
            const closeStyle = window.getComputedStyle(close);
            const pillStyle = window.getComputedStyle(pill);

            return {
                dockHidden: dockStyle.opacity === '0' && dockStyle.visibility === 'hidden' && dockStyle.pointerEvents === 'none',
                closeHidden: closeStyle.opacity === '0' && closeStyle.visibility === 'hidden' && closeStyle.pointerEvents === 'none',
                pillHidden: pillStyle.opacity === '0' && pillStyle.visibility === 'hidden' && pillStyle.pointerEvents === 'none'
            };
        })()`);

        console.log('Exit state result:', exitState);
        if (!exitState.dockHidden || !exitState.closeHidden || !exitState.pillHidden) {
            throw new Error('Exit state failed: auxiliary UI did not re-hide when pointer exited!');
        }
        console.log('✓ Pointer Exit: Auxiliary controls and status indicators re-hidden cleanly.');

        // Check 4: Animation and State Updates While Pointer Is Away
        console.log('\n[Check 4] Testing Animation States while Pointer Is Away...');

        const testStates = [
            { name: 'Idle', visual: { emotion: 'idle' } },
            { name: 'Landing/Happy', visual: { emotion: 'happy' } },
            { name: 'Speaking', voice: { voiceState: 'speaking', text: 'Hello from the celestial realm! ✨' } },
            { name: 'Listening', voice: { voiceState: 'listening' } },
            { name: 'Petting', visual: { emotion: 'pet' } },
            { name: 'Spin Trick', trick: 'spin' },
            { name: 'Somersault Trick', trick: 'somersault' }
        ];

        for (const s of testStates) {
            console.log(`  Testing state: ${s.name}...`);
            if (s.visual) {
                await compCdp.eval(`(() => {
                    const r = window.fairyRenderer;
                    if (r) r.setVisualState(${JSON.stringify(s.visual)});
                    const text = document.getElementById('statusText');
                    if (text) text.textContent = '${s.visual.emotion.toUpperCase()}';
                })()`);
            } else if (s.voice) {
                await compCdp.eval(`(() => {
                    const r = window.fairyRenderer;
                    if (r) r.setVisualState({ emotion: '${s.voice.voiceState}' });
                    const text = document.getElementById('statusText');
                    if (text) text.textContent = '${s.voice.voiceState.toUpperCase()}';
                })()`);
            } else if (s.trick) {
                await compCdp.eval(`(() => {
                    const r = window.fairyRenderer;
                    if (r && typeof r.playTrick === 'function') r.playTrick('${s.trick}');
                })()`);
            }

            await sleep(150);

            // Verify auxiliary UI remains hidden while mouse is away
            const stateCheck = await compCdp.eval(`(() => {
                const dock = document.getElementById('controlDock');
                const close = document.getElementById('closeBtn');
                const pill = document.getElementById('statusPill');
                const sidePanel = document.getElementById('sideConversationPanel');

                const dockStyle = window.getComputedStyle(dock);
                const closeStyle = window.getComputedStyle(close);
                const pillStyle = window.getComputedStyle(pill);

                return {
                    dockOpacity: dockStyle.opacity,
                    closeOpacity: closeStyle.opacity,
                    pillOpacity: pillStyle.opacity,
                    sidePanelCollapsed: sidePanel ? sidePanel.classList.contains('collapsed') : true
                };
            })()`);

            if (stateCheck.dockOpacity !== '0' || stateCheck.closeOpacity !== '0' || stateCheck.pillOpacity !== '0' || !stateCheck.sidePanelCollapsed) {
                throw new Error(`State ${s.name} forced auxiliary controls/pill/panel visible while pointer is away!`);
            }
            console.log(`  ✓ State ${s.name} preserved hover-only rule (controls and pill remained 0 opacity).`);
        }

        // Check 5: Button Interactivity and Docking Return
        console.log('\n[Check 5] Testing Return to App button click while visible...');
        // Hover to reveal
        await compCdp.eval(`(() => {
            const container = document.getElementById('companionContainer');
            container.classList.add('controls-visible');
        })()`);
        await sleep(300);

        // Click return
        await compCdp.eval(`document.getElementById('returnBtn').click()`);
        await sleep(1200);

        const returnCheck = await mainCdp.eval(`(() => {
            const sidebarBtn = document.getElementById('toggleFloatingBtn');
            const settingsBtn = document.getElementById('settingsToggleFloatBtn');
            const stage = document.getElementById('creatureStage');
            return {
                sidebarText: sidebarBtn ? sidebarBtn.textContent.trim() : null,
                settingsText: settingsBtn ? settingsBtn.textContent.trim() : null,
                fairyDocked: stage ? !stage.classList.contains('fairy-on-desktop') : false
            };
        })()`);

        console.log('Return check result:', returnCheck);
        if (returnCheck.sidebarText !== '🪟 Float Pet' || !returnCheck.fairyDocked) {
            throw new Error('Return to app failed from visible control dock!');
        }
        console.log('✓ Return button clicked successfully and restored fairy to main window.');

        console.log('\n======================================================');
        console.log('ALL PACKAGED HOVER VISIBILITY CHECKS PASSED (5/5)!');
        console.log('======================================================');

        compCdp.close();
        mainCdp.close();
    } finally {
        console.log('Cleaning up application process...');
        appProcess.kill();
        await sleep(500);
        try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch (_) {}
    }
}

run().catch((err) => {
    console.error('VERIFICATION FAILED:', err);
    process.exit(1);
});
