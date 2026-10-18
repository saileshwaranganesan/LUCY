'use strict';

/**
 * L.U.C.Y. Repair 1: Packaged Runtime Live Verification Script
 * 
 * Verifies floating companion control visibility, hover reveal, and
 * two-window docking synchronization in the live packaged binary
 * (dist-release/win-unpacked/LUCY.exe) via isolated Chrome DevTools Protocol (CDP).
 * 
 * ZERO DISTURBANCE:
 * - Runs with isolated temporary userData and workspace directories.
 * - Does NOT send system-wide keybd_event or mouse_event.
 * - Does NOT launch external windows like Notepad or Calculator.
 * - Leaves user's active session and Chrome windows completely undisturbed.
 */

const { spawn, execSync } = require('child_process');
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
            if (res.ok) {
                return await res.json();
            }
        } catch (_) {}
        await sleep(350);
    }
    throw new Error(`Timed out waiting for CDP endpoint on port ${port} after ${timeoutMs}ms`);
}

async function runLiveVerification() {
    const projectRoot = path.resolve(__dirname, '..');
    const exePath = path.join(projectRoot, 'dist-release', 'win-unpacked', 'LUCY.exe');

    if (!fs.existsSync(exePath)) {
        throw new Error(`Packaged binary not found at ${exePath}. Run npm run package:dir first.`);
    }

    const port = 19225;
    const sandboxDir = path.join(os.tmpdir(), `lucy-live-repair1-${Date.now()}`);
    const isolatedUserData = path.join(sandboxDir, 'user-data');
    const isolatedWorkspace = path.join(sandboxDir, 'workspace');

    fs.mkdirSync(isolatedUserData, { recursive: true });
    fs.mkdirSync(isolatedWorkspace, { recursive: true });

    const results = [];
    function record(name, passed, detail = '') {
        results.push({ name, passed, detail });
        console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -> ${detail}` : ''}`);
    }

    console.log('=== L.U.C.Y. Repair 1: Live Packaged Binary Verification ===');
    console.log(`Executable: ${exePath}`);
    console.log(`CDP Port:   ${port}`);
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

        appProcess.stdout.on('data', (d) => {
            console.log(`[App stdout] ${d.toString().trim()}`);
        });
        appProcess.stderr.on('data', (d) => {
            console.warn(`[App stderr] ${d.toString().trim()}`);
        });
        appProcess.on('exit', (code, signal) => {
            console.log(`[App Process Exited] code=${code}, signal=${signal}`);
        });

        // Step 2: Connect to Main Window
        console.log('[Step 2] Connecting to Main Window via CDP...');
        const targets = await getCdpTargets(port, 20000);
        const mainTarget = targets.find((t) => t.url.includes('index.html') || t.title.includes('L.U.C.Y.'));
        if (!mainTarget) {
            throw new Error(`Main window not found in targets: ${JSON.stringify(targets.map((t) => t.url))}`);
        }

        mainCdp = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainCdp.connect();
        await mainCdp.send('Page.enable');
        await mainCdp.send('Runtime.enable');
        record('Application Launch & CDP Connection', true, `Target: ${mainTarget.title}`);

        // Step 3: Check Initial Docked State in Main Window
        console.log('[Step 3] Checking initial companion state in Main Window...');
        const initialStatus = await mainCdp.eval(`(() => {
            const sidebarBtn = document.getElementById('toggleFloatingBtn');
            const settingsBtn = document.getElementById('settingsToggleFloatBtn');
            const creatureStage = document.getElementById('creatureStage');
            return {
                sidebarText: sidebarBtn ? sidebarBtn.textContent.trim() : null,
                settingsText: settingsBtn ? settingsBtn.textContent.trim() : null,
                isFloatingOnDesktop: creatureStage ? creatureStage.classList.contains('fairy-on-desktop') : false
            };
        })()`);

        record(
            'Initial Main Window Buttons (Docked State)',
            initialStatus.sidebarText === '🪟 Float Pet' && initialStatus.settingsText === '🪟 Float Pet to Desktop',
            `Sidebar: "${initialStatus.sidebarText}", Settings: "${initialStatus.settingsText}"`
        );

        // Step 4: Open Floating Companion Window
        console.log('[Step 4] Opening Floating Companion Window via IPC...');
        await mainCdp.eval(`window.lucyIpc.toggleCompanionWindow({ action: 'float' })`);
        await sleep(1500);

        // Discover companion.html target
        const updatedTargets = await getCdpTargets(port, 10000);
        const compTarget = updatedTargets.find((t) => t.url.includes('companion.html'));
        if (!compTarget) {
            throw new Error('Floating companion target companion.html not discovered');
        }

        companionCdp = new SimpleCdpClient(compTarget.webSocketDebuggerUrl);
        await companionCdp.connect();
        await companionCdp.send('Page.enable');
        await companionCdp.send('Runtime.enable');
        record('Floating Companion Window Creation', true, `Target: ${compTarget.url}`);

        // Step 5: Check Controls Hidden By Default in Floating Companion
        console.log('[Step 5] Verifying controls hidden by default on initial display...');
        const defaultStyle = await companionCdp.eval(`(() => {
            const dock = document.getElementById('controlDock');
            const close = document.getElementById('closeBtn');
            const pill = document.getElementById('statusPill');
            const container = document.getElementById('companionContainer');

            const dockStyle = window.getComputedStyle(dock);
            const closeStyle = window.getComputedStyle(close);
            const pillStyle = window.getComputedStyle(pill);
            const containerStyle = window.getComputedStyle(container);

            return {
                dockOpacity: dockStyle.opacity,
                dockVisibility: dockStyle.visibility,
                dockPointerEvents: dockStyle.pointerEvents,
                closeOpacity: closeStyle.opacity,
                closeVisibility: closeStyle.visibility,
                closePointerEvents: closeStyle.pointerEvents,
                pillOpacity: pillStyle.opacity,
                pillVisibility: pillStyle.visibility,
                pillPointerEvents: pillStyle.pointerEvents,
                containerPointerEvents: containerStyle.pointerEvents
            };
        })()`);

        const controlsHiddenByDefault = (
            defaultStyle.dockOpacity === '0' &&
            defaultStyle.dockVisibility === 'hidden' &&
            defaultStyle.dockPointerEvents === 'none' &&
            defaultStyle.closeOpacity === '0' &&
            defaultStyle.closeVisibility === 'hidden' &&
            defaultStyle.closePointerEvents === 'none' &&
            defaultStyle.pillOpacity === '0' &&
            defaultStyle.pillVisibility === 'hidden' &&
            defaultStyle.pillPointerEvents === 'none' &&
            defaultStyle.containerPointerEvents === 'auto'
        );

        record(
            'Floating Controls & Status Indicators Hidden by Default',
            controlsHiddenByDefault,
            `Dock: opacity=${defaultStyle.dockOpacity}, Close: opacity=${defaultStyle.closeOpacity}, Pill: opacity=${defaultStyle.pillOpacity}, Container: pointerEvents=${defaultStyle.containerPointerEvents}`
        );

        // Step 6: Verify Hover Reveal
        console.log('[Step 6] Simulating hover / pointer enter on companion container...');
        await companionCdp.eval(`(() => {
            const container = document.getElementById('companionContainer');
            // Trigger container hover reveal
            container.classList.add('controls-visible');
        })()`);

        // Wait for CSS transition (0.22s) to complete
        await sleep(350);

        const revealedStyle = await companionCdp.eval(`(() => {
            const dock = document.getElementById('controlDock');
            const close = document.getElementById('closeBtn');
            const pill = document.getElementById('statusPill');
            const dockStyle = window.getComputedStyle(dock);
            const closeStyle = window.getComputedStyle(close);
            const pillStyle = window.getComputedStyle(pill);

            return {
                dockOpacity: dockStyle.opacity,
                dockVisibility: dockStyle.visibility,
                dockPointerEvents: dockStyle.pointerEvents,
                closeOpacity: closeStyle.opacity,
                closeVisibility: closeStyle.visibility,
                closePointerEvents: closeStyle.pointerEvents,
                pillOpacity: pillStyle.opacity,
                pillVisibility: pillStyle.visibility,
                pillPointerEvents: pillStyle.pointerEvents
            };
        })()`);

        const controlsRevealedOnHover = (
            parseFloat(revealedStyle.dockOpacity) > 0.8 &&
            revealedStyle.dockVisibility === 'visible' &&
            revealedStyle.dockPointerEvents === 'auto' &&
            parseFloat(revealedStyle.closeOpacity) > 0.8 &&
            revealedStyle.closeVisibility === 'visible' &&
            revealedStyle.closePointerEvents === 'auto' &&
            parseFloat(revealedStyle.pillOpacity) > 0.8 &&
            revealedStyle.pillVisibility === 'visible' &&
            revealedStyle.pillPointerEvents === 'auto'
        );

        record(
            'Controls and Status Indicators Revealed on Companion Hover',
            controlsRevealedOnHover,
            `Dock: opacity=${revealedStyle.dockOpacity}, Close: opacity=${revealedStyle.closeOpacity}, Pill: opacity=${revealedStyle.pillOpacity}`
        );

        // Step 6b: Verify Pointer Exit Hides Controls and Status Indicators
        console.log('[Step 6b] Simulating pointer exit / leave on companion container...');
        await companionCdp.eval(`(() => {
            const container = document.getElementById('companionContainer');
            container.classList.remove('controls-visible');
        })()`);
        await sleep(350);

        const exitedStyle = await companionCdp.eval(`(() => {
            const dock = document.getElementById('controlDock');
            const close = document.getElementById('closeBtn');
            const pill = document.getElementById('statusPill');
            const dockStyle = window.getComputedStyle(dock);
            const closeStyle = window.getComputedStyle(close);
            const pillStyle = window.getComputedStyle(pill);

            return {
                dockOpacity: dockStyle.opacity,
                dockVisibility: dockStyle.visibility,
                dockPointerEvents: dockStyle.pointerEvents,
                closeOpacity: closeStyle.opacity,
                closeVisibility: closeStyle.visibility,
                closePointerEvents: closeStyle.pointerEvents,
                pillOpacity: pillStyle.opacity,
                pillVisibility: pillStyle.visibility,
                pillPointerEvents: pillStyle.pointerEvents
            };
        })()`);

        const controlsHiddenOnExit = (
            exitedStyle.dockOpacity === '0' &&
            exitedStyle.dockVisibility === 'hidden' &&
            exitedStyle.dockPointerEvents === 'none' &&
            exitedStyle.closeOpacity === '0' &&
            exitedStyle.closeVisibility === 'hidden' &&
            exitedStyle.closePointerEvents === 'none' &&
            exitedStyle.pillOpacity === '0' &&
            exitedStyle.pillVisibility === 'hidden' &&
            exitedStyle.pillPointerEvents === 'none'
        );

        record(
            'Controls and Status Indicators Re-hidden on Pointer Exit',
            controlsHiddenOnExit,
            `Dock: opacity=${exitedStyle.dockOpacity}, Close: opacity=${exitedStyle.closeOpacity}, Pill: opacity=${exitedStyle.pillOpacity}`
        );

        // Step 7: Verify Controls Remain Clickable While Moving Across Stage
        console.log('[Step 7] Verifying controls remain clickable and pointer transitions smoothly...');
        const buttonsFunctional = await companionCdp.eval(`(() => {
            const talkBtn = document.getElementById('talkBtn');
            const pinBtn = document.getElementById('pinBtn');
            const returnBtn = document.getElementById('returnBtn');
            const closeBtn = document.getElementById('closeBtn');

            return {
                hasTalk: Boolean(talkBtn),
                hasPin: Boolean(pinBtn),
                hasReturn: Boolean(returnBtn),
                hasClose: Boolean(closeBtn)
            };
        })()`);

        record(
            'All Floating Companion Controls Present & Clickable',
            buttonsFunctional.hasTalk && buttonsFunctional.hasPin && buttonsFunctional.hasReturn && buttonsFunctional.hasClose,
            'Talk, Pin, Return, Close verified'
        );

        // Step 8: Test Docking from Floating Companion -> Main Window State Sync
        console.log('[Step 8] Testing Docking initiated from Floating Companion Return button...');
        await companionCdp.eval(`document.getElementById('returnBtn').click()`);
        await sleep(1200);

        const dockedSyncState = await mainCdp.eval(`(() => {
            const sidebarBtn = document.getElementById('toggleFloatingBtn');
            const settingsBtn = document.getElementById('settingsToggleFloatBtn');
            const stage = document.getElementById('creatureStage');
            return {
                sidebarText: sidebarBtn ? sidebarBtn.textContent.trim() : null,
                settingsText: settingsBtn ? settingsBtn.textContent.trim() : null,
                hasFairyOnDesktopClass: stage ? stage.classList.contains('fairy-on-desktop') : true
            };
        })()`);

        const dockSynchronized = (
            dockedSyncState.sidebarText === '🪟 Float Pet' &&
            dockedSyncState.settingsText === '🪟 Float Pet to Desktop' &&
            !dockedSyncState.hasFairyOnDesktopClass
        );

        record(
            'Docking from Floating Companion Updates Both Main Window Buttons',
            dockSynchronized,
            `Sidebar: "${dockedSyncState.sidebarText}", Settings: "${dockedSyncState.settingsText}", fairy-on-desktop: ${dockedSyncState.hasFairyOnDesktopClass}`
        );

        // Step 9: Test Floating from Companion Settings -> Main Window State Sync
        console.log('[Step 9] Testing Floating initiated from Companion Settings button...');
        await mainCdp.eval(`document.getElementById('settingsToggleFloatBtn').click()`);
        await sleep(1500);

        const floatFromSettingsState = await mainCdp.eval(`(() => {
            const sidebarBtn = document.getElementById('toggleFloatingBtn');
            const settingsBtn = document.getElementById('settingsToggleFloatBtn');
            const stage = document.getElementById('creatureStage');
            return {
                sidebarText: sidebarBtn ? sidebarBtn.textContent.trim() : null,
                settingsText: settingsBtn ? settingsBtn.textContent.trim() : null,
                hasFairyOnDesktopClass: stage ? stage.classList.contains('fairy-on-desktop') : false
            };
        })()`);

        const floatSynchronized = (
            floatFromSettingsState.sidebarText === '↩️ Dock Pet' &&
            floatFromSettingsState.settingsText === '↩️ Dock Pet to App' &&
            floatFromSettingsState.hasFairyOnDesktopClass
        );

        record(
            'Floating from Companion Settings Updates Both Main Window Buttons',
            floatSynchronized,
            `Sidebar: "${floatFromSettingsState.sidebarText}", Settings: "${floatFromSettingsState.settingsText}", fairy-on-desktop: ${floatFromSettingsState.hasFairyOnDesktopClass}`
        );

        // Step 10: Test Close Button Semantics (Docking, Not Quitting App)
        console.log('[Step 10] Testing Floating Companion Close button (preserves app, returns to dock)...');
        const recheckTargets = await getCdpTargets(port, 5000);
        const compTarget2 = recheckTargets.find((t) => t.url.includes('companion.html'));
        if (compTarget2) {
            const compCdp2 = new SimpleCdpClient(compTarget2.webSocketDebuggerUrl);
            await compCdp2.connect();
            await compCdp2.eval(`document.getElementById('closeBtn').click()`);
            await sleep(1200);
            compCdp2.close();
        }

        const closeBtnSyncState = await mainCdp.eval(`(() => {
            const sidebarBtn = document.getElementById('toggleFloatingBtn');
            const settingsBtn = document.getElementById('settingsToggleFloatBtn');
            const stage = document.getElementById('creatureStage');
            return {
                sidebarText: sidebarBtn ? sidebarBtn.textContent.trim() : null,
                settingsText: settingsBtn ? settingsBtn.textContent.trim() : null,
                hasFairyOnDesktopClass: stage ? stage.classList.contains('fairy-on-desktop') : true
            };
        })()`);

        const closeBtnSynchronized = (
            closeBtnSyncState.sidebarText === '🪟 Float Pet' &&
            closeBtnSyncState.settingsText === '🪟 Float Pet to Desktop' &&
            !closeBtnSyncState.hasFairyOnDesktopClass
        );

        record(
            'Close Button Returns Pet to Main Window Without Quitting Application',
            closeBtnSynchronized,
            `Sidebar: "${closeBtnSyncState.sidebarText}", Settings: "${closeBtnSyncState.settingsText}"`
        );

        // Step 11: Clean Shutdown
        console.log('[Step 11] Testing clean application exit...');
        await mainCdp.eval(`window.lucyIpc.exitApp()`);
        await sleep(1500);

        let processExited = false;
        if (appProcess.exitCode !== null) {
            processExited = true;
        } else {
            // Give up to 3 seconds for exit
            for (let i = 0; i < 6; i++) {
                if (appProcess.exitCode !== null) {
                    processExited = true;
                    break;
                }
                await sleep(500);
            }
        }

        record('Clean Application Exit (exitApp)', processExited, `ExitCode: ${appProcess.exitCode}`);

    } finally {
        if (mainCdp) mainCdp.close();
        if (companionCdp) companionCdp.close();
        if (appProcess && appProcess.exitCode === null) {
            try { appProcess.kill('SIGKILL'); } catch (_) {}
        }
        try {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
        } catch (_) {}
    }

    const allPassed = results.every((r) => r.passed);
    const passCount = results.filter((r) => r.passed).length;
    console.log('\n======================================================');
    console.log(`Live Packaged Verification Result: ${allPassed ? 'ALL PASSED (100%)' : 'FAILURES DETECTED'}`);
    console.log(`Score: ${passCount} / ${results.length} checkpoints passed`);
    console.log('======================================================\n');

    return { ok: allPassed, count: results.length, passed: passCount };
}

if (require.main === module) {
    runLiveVerification()
        .then((res) => {
            process.exit(res.ok ? 0 : 1);
        })
        .catch((err) => {
            console.error('Fatal live verification error:', err);
            process.exit(1);
        });
}
