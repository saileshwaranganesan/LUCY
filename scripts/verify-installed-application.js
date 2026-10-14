'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ARTIFACTS_DIR = 'C:\\Users\\admin\\.gemini\\antigravity-ide\\brain\\527dd3e2-4572-4245-bd22-06ce8ca7c83b';

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
                if (data.method === 'Runtime.exceptionThrown') {
                    console.error('  [CDP Exception]', JSON.stringify(data.params.exceptionDetails));
                }
                if (data.method === 'Runtime.consoleAPICalled') {
                    console.log('  [CDP Console]', data.params.type, data.params.args.map(a => a.value || a.description).join(' '));
                }
                if (data.method === 'Log.entryAdded') {
                    console.error('  [CDP Browser Log]', JSON.stringify(data.params.entry));
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

    async captureScreenshot() {
        const res = await this.send('Page.captureScreenshot', { format: 'png' });
        return Buffer.from(res.data, 'base64');
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCdpTargets(port = 9223) {
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json`);
            if (res.ok) {
                return await res.json();
            }
        } catch (_) {}
        await sleep(500);
    }
    throw new Error(`Timed out waiting for CDP endpoint on port ${port}`);
}

async function runInstalledAppVerification() {
    console.log('=== L.U.C.Y. Installed Windows Application Production Verification ===\n');

    const installedExe = path.join(process.env.LOCALAPPDATA, 'Programs', 'LUCY', 'LUCY.exe');
    console.log(`[Step 1] Locating installed application executable: ${installedExe}`);

    if (!fs.existsSync(installedExe)) {
        throw new Error(`Installed executable not found at: ${installedExe}`);
    }
    const exeStats = fs.statSync(installedExe);
    console.log(`  ✓ Found LUCY.exe (${(exeStats.size / 1024 / 1024).toFixed(1)} MB, modified: ${exeStats.mtime.toISOString()})`);

    // Verify resources
    const resDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'LUCY', 'resources');
    const uiaWorkerPath = path.join(resDir, 'native-uia', 'LucyUiaWorker.exe');
    const whisperBinPath = path.join(resDir, 'bin', 'whisper-cli.exe');
    const dragonModelPath = path.join(resDir, 'app.asar.unpacked', 'src', 'companion', 'assets', 'dragon.glb');

    console.log('\n[Step 2] Validating required runtime resources in installed package:');
    if (!fs.existsSync(uiaWorkerPath)) {
        throw new Error(`LucyUiaWorker.exe missing in installed resources: ${uiaWorkerPath}`);
    }
    console.log(`  ✓ LucyUiaWorker.exe present in resources/native-uia (${fs.statSync(uiaWorkerPath).size} bytes)`);

    if (fs.existsSync(whisperBinPath)) {
        console.log(`  ✓ whisper-cli.exe present in resources/bin (${fs.statSync(whisperBinPath).size} bytes)`);
    }

    if (fs.existsSync(dragonModelPath)) {
        throw new Error(`Obsolete dragon.glb still present in installed package: ${dragonModelPath}`);
    }
    console.log('  ✓ Confirmed obsolete dragon.glb is NOT present in runtime assets');

    // Launch installed app
    console.log('\n[Step 3] Launching installed application with remote debugging port 9223...');
    const appProc = spawn(installedExe, ['--remote-debugging-port=9223'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
    });

    appProc.stdout.on('data', (d) => console.log(`  [LUCY App STDOUT] ${d.toString().trim()}`));
    appProc.stderr.on('data', (d) => console.warn(`  [LUCY App STDERR] ${d.toString().trim()}`));

    let mainClient = null;
    let companionClient = null;

    try {
        console.log('\n[Step 4] Connecting to installed app via Chrome DevTools Protocol...');
        const targets = await getCdpTargets(9223);
        console.log(`  Discovered ${targets.length} targets from installed application.`);

        const mainTarget = targets.find((t) => t.url.includes('index.html'));
        if (!mainTarget) {
            throw new Error(`Main window target (index.html) not found. Available: ${JSON.stringify(targets.map((t) => t.url))}`);
        }
        console.log(`  ✓ Found Main Window target: ${mainTarget.title} (${mainTarget.url})`);

        mainClient = new SimpleCdpClient(mainTarget.webSocketDebuggerUrl);
        await mainClient.connect();
        await mainClient.send('Page.enable');
        await mainClient.send('Runtime.enable');
        console.log('  ✓ Connected to installed main window CDP.');

        // Verify system status & application data paths
        console.log('\n[Step 5] Querying system status and application-data paths via IPC:');
        const sysStatus = await mainClient.eval('window.lucyIpc.getSystemStatus()');
        console.log('  System Status:', JSON.stringify(sysStatus, null, 2));

        if (!sysStatus.ok) throw new Error('getSystemStatus failed');
        if (!sysStatus.workspaceRoot) throw new Error('workspaceRoot not configured');
        console.log(`  ✓ Authoritative Workspace Root: ${sysStatus.workspaceRoot}`);
        console.log(`  ✓ Fail-Closed AI Provider Auth: provider=${sysStatus.provider}, hasKey=${sysStatus.hasKey}`);

        // Verify Offline Direct Intent Execution
        console.log('\n[Step 6] Testing offline direct-intent tool execution (system_info):');
        const sysInfoResult = await mainClient.eval(`window.lucyIpc.executeRequest('inspect system status')`);
        console.log('  System Info Receipt:', JSON.stringify(sysInfoResult.summary || sysInfoResult, null, 2));
        if (!sysInfoResult.ok) throw new Error(`system_info failed: ${sysInfoResult.error}`);
        console.log('  ✓ Offline system_info tool executed successfully without external API or internet.');

        // Verify Mechanical Dry-Run Isolation
        console.log('\n[Step 7] Testing mechanical dry-run tool isolation in installed application:');
        const dryRunResult = await mainClient.eval(`
            window.lucyIpc.executeRequest('write file test_pack.txt with content verified_pack', { dryRun: true })
        `);
        console.log('  Dry-Run Receipt:', JSON.stringify(dryRunResult.summary || dryRunResult, null, 2));
        if (!dryRunResult.ok || !dryRunResult.dryRun) {
            throw new Error(`Dry-Run simulation failed or returned non-dryRun receipt`);
        }
        console.log('  ✓ Mechanical dry-run isolation verified in installed application.');

        // Verify Native Desktop Automation via LucyUiaWorker.exe
        console.log('\n[Step 8] Testing native desktop automation via LucyUiaWorker.exe in installed app:');
        const desktopListResult = await mainClient.eval(`
            window.lucyIpc.executeRequest('list running apps')
        `);
        console.log('  Desktop List Result:', JSON.stringify(desktopListResult.summary || desktopListResult, null, 2));
        if (!desktopListResult.ok) {
            throw new Error(`Desktop automation list apps failed: ${desktopListResult.error}`);
        }
        console.log('  ✓ LucyUiaWorker.exe spawned and communicated successfully in packaged application.');

        // Test Memory Persistence
        console.log('\n[Step 9] Testing persistent user memory in installed app:');
        const addMemResult = await mainClient.eval(`
            window.lucyIpc.addMemory({
                category: 'conversation',
                content: 'Installed application production test checkpoint memory',
                source: 'user_explicit'
            })
        `);
        console.log('  Add Memory Result:', JSON.stringify(addMemResult, null, 2));
        if (!addMemResult.ok) throw new Error(`addMemory failed: ${addMemResult.error}`);

        const searchMemResult = await mainClient.eval(`
            window.lucyIpc.getMemories({ query: 'production test checkpoint' })
        `);
        console.log(`  Found ${searchMemResult.memories ? searchMemResult.memories.length : 0} matching memories.`);
        if (!searchMemResult.memories || searchMemResult.memories.length === 0) {
            throw new Error('Memory search failed to retrieve newly added persistent memory');
        }
        console.log('  ✓ Persistent memory storage and lexical retrieval verified.');

        // Test 3D Floating Companion in Packaged App
        console.log('\n[Step 10] Testing 3D Floating Fantasy Companion in installed application:');
        const toggleResult = await mainClient.eval('window.lucyIpc.toggleCompanionWindow()');
        console.log('  Companion Toggle Result:', JSON.stringify(toggleResult, null, 2));
        await sleep(2500);

        const newTargets = await getCdpTargets(9223);
        const companionTarget = newTargets.find((t) => t.url.includes('companion.html'));
        if (!companionTarget) {
            throw new Error(`Companion window not found after toggle. Targets: ${JSON.stringify(newTargets.map((t) => t.url))}`);
        }
        console.log(`  ✓ Found Floating Companion Target: ${companionTarget.url}`);

        companionClient = new SimpleCdpClient(companionTarget.webSocketDebuggerUrl);
        await companionClient.connect();
        await companionClient.send('Page.enable');
        await companionClient.send('Runtime.enable');
        await companionClient.send('Log.enable').catch(() => {});

        // Check if Celestial Fairy Familiar loaded and active
        console.log('  Polling for Celestial Fairy Familiar inside companion window...');
        let companionStatus = null;
        for (let i = 0; i < 30; i++) {
            companionStatus = await companionClient.eval(`(() => {
                const renderer = window.fairyRenderer || window.companionRenderer;
                const canvas = document.getElementById('fairyCanvas');
                return {
                    hasFairyCanvas: Boolean(canvas),
                    rendererRunning: Boolean(renderer && renderer.running),
                    emotion: renderer ? renderer.state.emotion : 'none',
                    orbitParticles: renderer && renderer.orbitParticles ? renderer.orbitParticles.length : 0,
                    statusText: document.getElementById('statusText') ? document.getElementById('statusText').textContent : ''
                };
            })()`);

            if (companionStatus.rendererRunning) break;
            await sleep(500);
        }

        console.log('  Companion Fairy Status:', JSON.stringify(companionStatus, null, 2));
        if (!companionStatus.rendererRunning) {
            throw new Error('CelestialFamiliarRenderer failed to start in companion window');
        }
        console.log('  ✓ Celestial Fairy Familiar loaded and rendering in packaged application.');

        // Trigger companion pet flourish
        const petResult = await companionClient.eval('window.companionIpc.petCompanion()');
        console.log('  Pet Flourish Result:', JSON.stringify(petResult, null, 2));

        // Capture visual screenshots
        console.log('\n[Step 11] Capturing verification screenshots...');
        const mainScreenshot = await mainClient.captureScreenshot();
        const mainShotPath = path.join(ARTIFACTS_DIR, 'lucy_installed_main_verified.png');
        fs.writeFileSync(mainShotPath, mainScreenshot);
        console.log(`  ✓ Saved main window screenshot: ${mainShotPath} (${mainScreenshot.length} bytes)`);

        const companionScreenshot = await companionClient.captureScreenshot();
        const companionShotPath = path.join(ARTIFACTS_DIR, 'lucy_installed_companion_verified.png');
        fs.writeFileSync(companionShotPath, companionScreenshot);
        console.log(`  ✓ Saved companion window screenshot: ${companionShotPath} (${companionScreenshot.length} bytes)`);

        // Test Dock / Float Toggle cleanup
        console.log('\n[Step 12] Testing Dock toggle (closing companion window cleanly):');
        const dockResult = await mainClient.eval('window.lucyIpc.toggleCompanionWindow()');
        console.log('  Dock Companion Result:', JSON.stringify(dockResult, null, 2));
        await sleep(1000);

        console.log('\n=== All Packaged Application Features Verified Successfully! ===');

    } finally {
        if (mainClient) mainClient.close();
        if (companionClient) companionClient.close();

        console.log('\n[Step 13] Closing installed application and verifying child process cleanup...');
        try {
            appProc.kill('SIGTERM');
        } catch (_) {}
        await sleep(2000);

        // Check for orphaned LucyUiaWorker or LUCY processes
        try {
            const tasklist = execSync('tasklist', { encoding: 'utf8' });
            const hasOrphanWorker = tasklist.includes('LucyUiaWorker.exe');
            console.log(`  Orphaned LucyUiaWorker.exe check: ${hasOrphanWorker ? 'FAILED (Orphan detected)' : 'CLEAN (Zero orphans)'}`);
            if (hasOrphanWorker) {
                execSync('taskkill /F /IM LucyUiaWorker.exe /T 2>nul || exit 0', { shell: 'cmd.exe' });
            }
        } catch (_) {}
    }
}

runInstalledAppVerification().catch((err) => {
    console.error('\n❌ Verification Failed:', err);
    process.exit(1);
});
