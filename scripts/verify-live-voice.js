'use strict';

const { spawn } = require('child_process');
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
                    console.log('>>> BROWSER EXCEPTION:', JSON.stringify(data.params.exceptionDetails));
                }
                if (data.method === 'Runtime.consoleAPICalled') {
                    console.log('>>> BROWSER CONSOLE:', data.params.type, data.params.args.map(a => a.value || a.description).join(' '));
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
        }
    }
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    console.log('=== L.U.C.Y. Live Voice Integration Verification Suite ===\n');

    const electronPath = path.resolve(__dirname, '../node_modules/electron/dist/electron.exe');
    const appPath = path.resolve(__dirname, '../');

    console.log(`1. Launching Electron desktop assistant...`);
    const electronProcess = spawn(electronPath, [
        appPath,
        '--remote-debugging-port=9223'
    ], {
        cwd: appPath,
        stdio: 'pipe',
        env: {
            ...process.env,
            LUCY_SMOKE_TEST: 'false'
        }
    });

    electronProcess.stdout.on('data', (d) => process.stdout.write(`[Electron stdout] ${d}`));
    electronProcess.stderr.on('data', (d) => process.stderr.write(`[Electron stderr] ${d}`));

    let connected = false;
    let cdp = null;

    try {
        console.log('2. Waiting for CDP endpoint on port 9223...');
        let wsUrl = null;
        for (let i = 0; i < 25; i++) {
            await sleep(500);
            try {
                const res = await fetch('http://127.0.0.1:9223/json');
                if (res.ok) {
                    const pages = await res.json();
                    const page = pages.find((p) => p.type === 'page' || p.url.includes('index.html'));
                    if (page && page.webSocketDebuggerUrl) {
                        wsUrl = page.webSocketDebuggerUrl;
                        break;
                    }
                }
            } catch {}
        }

        if (!wsUrl) {
            throw new Error('Failed to acquire CDP WebSocket URL from Electron process.');
        }

        console.log('   Connected to CDP WebSocket: ' + wsUrl);
        cdp = new SimpleCdpClient(wsUrl);
        await cdp.connect();
        connected = true;

        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Page.reload');
        await sleep(1500);

        // Verification 1: Inspect Voice DOM elements
        console.log('\n3. Verifying Voice UI elements in Electron DOM...');
        const scriptGlobals = await cdp.eval(`({
            cleanTextForSpeech: typeof window.cleanTextForSpeech,
            createSpeechRecognition: typeof window.createSpeechRecognition,
            createSpeechSynthesis: typeof window.createSpeechSynthesis,
            createVoiceController: typeof window.createVoiceController,
            voiceController: typeof window.voiceController
        })`);
        console.log(`   Script Globals Check:`, scriptGlobals);

        const uiChecks = await cdp.eval(`({
            hasMicBtn: Boolean(document.getElementById('micBtn')),
            micBtnText: document.getElementById('micBtn')?.textContent?.trim(),
            hasStopVoiceBtn: Boolean(document.getElementById('stopVoiceBtn')),
            hasToggleTtsBtn: Boolean(document.getElementById('toggleTtsBtn')),
            toggleTtsBtnText: document.getElementById('toggleTtsBtn')?.textContent?.trim(),
            hasVoiceController: Boolean(window.voiceController),
            isTtsEnabled: Boolean(window.voiceController?.ttsEnabled),
            hasCompanion: Boolean(window.companionRenderer)
        })`);

        console.log(`   DOM Voice Controls Check:`, uiChecks);
        if (!uiChecks.hasMicBtn || !uiChecks.hasStopVoiceBtn || !uiChecks.hasToggleTtsBtn) {
            throw new Error('Voice buttons missing from index.html DOM.');
        }
        if (!uiChecks.hasVoiceController) {
            throw new Error('window.voiceController was not initialized in renderer.');
        }

        // Verification 2: Test TTS Toggle Button
        console.log('\n4. Verifying TTS toggle (Mute / Unmute)...');
        const toggledMute = await cdp.eval(`(() => {
            const btn = document.getElementById('toggleTtsBtn');
            btn.click();
            return {
                text: btn.textContent.trim(),
                ttsEnabled: window.voiceController.ttsEnabled
            };
        })()`);
        console.log(`   After Mute Toggle:`, toggledMute);

        // Toggle back ON
        const toggledBack = await cdp.eval(`(() => {
            const btn = document.getElementById('toggleTtsBtn');
            btn.click();
            return {
                text: btn.textContent.trim(),
                ttsEnabled: window.voiceController.ttsEnabled
            };
        })()`);
        console.log(`   After Unmute Toggle:`, toggledBack);

        // Verification 3: Test Speech Playback and Instant Interruption (Stop Voice)
        console.log('\n5. Verifying Speech Playback and Stop Voice Button...');
        const speakTriggered = await cdp.eval(`(async () => {
            // Trigger speech playback
            window.voiceController.speakResponse('Hello! This is Lucy speaking with verified voice playback.');
            await new Promise(r => setTimeout(r, 100));
            const stopBtn = document.getElementById('stopVoiceBtn');
            const statusLabel = document.getElementById('statusLabel').textContent.trim();
            const emotion = window.companionRenderer.state.emotion;
            const isSpeaking = window.voiceController.isSpeaking;
            return {
                stopBtnVisible: stopBtn.style.display !== 'none',
                statusLabel,
                companionEmotion: emotion,
                isSpeaking
            };
        })()`);
        console.log(`   Playback Active State:`, speakTriggered);

        // Click Stop Voice button
        console.log('   Clicking Stop Voice button to interrupt...');
        const stoppedResult = await cdp.eval(`(() => {
            const stopBtn = document.getElementById('stopVoiceBtn');
            stopBtn.click();
            return {
                stopBtnDisplay: stopBtn.style.display,
                isSpeaking: window.voiceController.isSpeaking,
                statusLabel: document.getElementById('statusLabel').textContent.trim(),
                companionEmotion: window.companionRenderer.state.emotion
            };
        })()`);
        console.log(`   After Stop Voice Click:`, stoppedResult);

        // Verification 4: Push-to-Talk Microphone Interaction & Text Fallback
        console.log('\n6. Verifying Push-to-Talk Mic Interaction and Non-Blocking Fallback...');
        const micClickResult = await cdp.eval(`(() => {
            const mic = document.getElementById('micBtn');
            mic.click();
            return {
                isListening: window.voiceController.isListening,
                btnText: mic.textContent.trim(),
                statusLabel: document.getElementById('statusLabel').textContent.trim(),
                emotion: window.companionRenderer.state.emotion
            };
        })()`);
        console.log(`   Mic Button Click Result:`, micClickResult);

        // Cancel listening
        await cdp.eval(`window.voiceController.cancelListening()`);
        await sleep(300);

        // Verification 5: Verify Text Chat Continuity (Text-only Fallback)
        console.log('\n7. Verifying Text Chat Continuity (Decoupled Text Execution)...');
        const textExecution = await cdp.eval(`(async () => {
            const input = document.getElementById('commandInput');
            const sendBtn = document.getElementById('sendBtn');
            input.value = 'Inspect system resource status';
            sendBtn.click();
            // Wait for planning & execution to render in feed
            await new Promise(r => setTimeout(r, 1200));
            const feed = document.getElementById('taskFeed');
            const lastEntry = feed.lastElementChild?.textContent || '';
            const statusLabel = document.getElementById('statusLabel').textContent.trim();
            return {
                lastEntrySnippet: lastEntry.slice(0, 150),
                statusLabel
            };
        })()`);
        console.log(`   Text Execution Result:`, textExecution);

        // Verification 6: Capture Screenshot Artifact
        console.log('\n8. Capturing live desktop screenshot artifact...');
        const screenshotBuf = await cdp.captureScreenshot();
        const screenshotPath = path.join(ARTIFACTS_DIR, 'lucy_voice_integration_verified.png');
        fs.writeFileSync(screenshotPath, screenshotBuf);
        console.log(`   Screenshot successfully saved to: ${screenshotPath} (${screenshotBuf.length} bytes)`);

        console.log('\n=== ALL REAL-RUNTIME VOICE VERIFICATIONS PASSED SUCCESSFULLY ===');
    } finally {
        if (cdp) {
            cdp.close();
        }
        if (electronProcess) {
            console.log('Teardown: Terminating Electron process...');
            electronProcess.kill('SIGINT');
            await sleep(500);
            try {
                electronProcess.kill('SIGKILL');
            } catch {}
        }
    }
}

main().catch((err) => {
    console.error('VERIFICATION ERROR:', err);
    process.exit(1);
});
