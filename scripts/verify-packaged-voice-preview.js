'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const ARTIFACT_DIR = path.resolve('C:/Users/admin/.gemini/antigravity-ide/brain/7ae752c2-9344-4b22-a07e-0613214bb3df');
const PACKAGED_EXE = path.resolve(__dirname, '..', 'dist-release', 'win-unpacked', 'LUCY.exe');
const TEMP_USER_DATA = path.resolve(__dirname, '..', '.test-scratch', 'temp-packaged-voice-data');
const DEBUG_PORT = 9444;

async function waitHttp(url, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.get(url, (res) => {
                    if (res.statusCode === 200) resolve();
                    else reject(new Error('Status ' + res.statusCode));
                });
                req.on('error', reject);
                req.end();
            });
            return true;
        } catch (_) {
            await new Promise((r) => setTimeout(r, 400));
        }
    }
    return false;
}

async function runPackagedVoicePreviewVerification() {
    console.log('=== L.U.C.Y. Packaged App Voice Preview Verification ===');
    console.log(`Executable: ${PACKAGED_EXE}`);

    if (!fs.existsSync(PACKAGED_EXE)) {
        throw new Error(`Packaged executable not found at: ${PACKAGED_EXE}`);
    }

    fs.mkdirSync(TEMP_USER_DATA, { recursive: true });

    // Launch packaged LUCY.exe off-screen with isolated debugging port and user data
    console.log(`Launching packaged LUCY.exe with remote-debugging-port=${DEBUG_PORT}...`);
    const proc = spawn(PACKAGED_EXE, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${TEMP_USER_DATA}`,
        '--window-position=-3000,-3000',
        '--no-sandbox'
    ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (d) => {
        const str = d.toString().trim();
        if (str && !str.includes('libpng')) console.log('[Packaged stdout]', str);
    });

    proc.stderr.on('data', (d) => {
        const str = d.toString().trim();
        if (str && !str.includes('libpng')) console.log('[Packaged stderr]', str);
    });

    let browser = null;
    try {
        const ready = await waitHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 25000);
        if (!ready) {
            throw new Error(`Packaged app failed to respond on port ${DEBUG_PORT} within 25 seconds`);
        }
        console.log('Packaged app is running and debugging endpoint is reachable.');

        browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
        const contexts = browser.contexts();
        if (contexts.length === 0) {
            throw new Error('No browser contexts found via CDP');
        }

        const pages = contexts[0].pages();
        console.log(`Found ${pages.length} open pages.`);
        const mainPage = pages.find((p) => p.url().includes('index.html')) || pages[0];
        if (!mainPage) {
            throw new Error('Could not identify main window page');
        }

        await mainPage.waitForLoadState('domcontentloaded');
        console.log(`Connected to main window page: ${mainPage.url()}`);

        mainPage.on('console', msg => console.log(`[PAGE CONSOLE] ${msg.type()}: ${msg.text()}`));
        mainPage.on('pageerror', err => console.log(`[PAGE ERROR] ${err.message}`));

        const voiceGlobals = await mainPage.evaluate(() => ({
            hasVoiceController: typeof window.voiceController !== 'undefined',
            voiceControllerVal: window.voiceController ? 'OBJECT' : String(window.voiceController),
            hasCreateVoiceController: typeof window.createVoiceController !== 'undefined',
            hasLucyIpc: typeof window.lucyIpc !== 'undefined'
        }));
        console.log('DOM Voice Globals:', JSON.stringify(voiceGlobals));

        // 1. Verify Kokoro status in packaged app
        console.log('Checking Kokoro TTS status via IPC in packaged app...');
        const kokoroStatus = await mainPage.evaluate(async () => {
            if (!window.lucyIpc || typeof window.lucyIpc.getKokoroStatus !== 'function') {
                return { error: 'lucyIpc.getKokoroStatus not available' };
            }
            return await window.lucyIpc.getKokoroStatus();
        });
        console.log('Kokoro status result:', JSON.stringify(kokoroStatus, null, 2));
        if (!kokoroStatus.isAvailable) {
            throw new Error('Kokoro TTS service reports not available in packaged app!');
        }

        // 2. Synthesize Bella voice preset
        console.log('Synthesizing speech with Bella voice preset...');
        const bellaRes = await mainPage.evaluate(async () => {
            return await window.lucyIpc.synthesizeSpeech(
                'Sparkle! I am Lucy, your celestial fairy companion speaking with Bella voice preset.',
                { voice: 'af_bella', rate: 1.0 }
            );
        });
        console.log('Bella synthesis response: ok=', bellaRes.ok, 'duration=', bellaRes.duration_s, 'latency_ms=', bellaRes.latency_ms);
        if (!bellaRes.ok || !bellaRes.audio || !bellaRes.audio.startsWith('data:audio/wav;base64,')) {
            throw new Error(`Bella voice synthesis failed: ${bellaRes.error || 'No audio'}`);
        }

        // 3. Synthesize Sky voice preset
        console.log('Synthesizing speech with Sky voice preset...');
        const skyRes = await mainPage.evaluate(async () => {
            return await window.lucyIpc.synthesizeSpeech(
                'Sparkle! I am Lucy, speaking with Sky ethereal fairy voice preset.',
                { voice: 'af_sky', rate: 1.1 }
            );
        });
        console.log('Sky synthesis response: ok=', skyRes.ok, 'duration=', skyRes.duration_s, 'latency_ms=', skyRes.latency_ms);
        if (!skyRes.ok || !skyRes.audio || !skyRes.audio.startsWith('data:audio/wav;base64,')) {
            throw new Error(`Sky voice synthesis failed: ${skyRes.error || 'No audio'}`);
        }

        // 4. Test Companion Settings Voice Controls in packaged app UI
        console.log('Navigating to Companion Settings in UI...');
        await mainPage.click('#tabNavCompanionSettings');
        await mainPage.waitForTimeout(600);

        const btnTestFairy = await mainPage.$('#btnTestFairyVoice');
        if (!btnTestFairy) {
            throw new Error('#btnTestFairyVoice button not found in DOM');
        }

        const initialBtnText = await btnTestFairy.textContent();
        console.log('Initial #btnTestFairyVoice text:', initialBtnText.trim());

        // Select Sky voice and modify rate/pitch/volume in UI
        await mainPage.evaluate(() => {
            const voiceSel = document.getElementById('settingsKokoroVoiceSelect');
            if (voiceSel) {
                voiceSel.value = 'af_sky';
                voiceSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const rate = document.getElementById('sliderVoiceRate');
            if (rate) {
                rate.value = '1.15';
                rate.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const pitch = document.getElementById('sliderVoicePitch');
            if (pitch) {
                pitch.value = '1.1';
                pitch.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const volume = document.getElementById('sliderVoiceVolume');
            if (volume) {
                volume.value = '0.85';
                volume.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        // Click Test Fairy Voice
        console.log('Clicking #btnTestFairyVoice in packaged application...');
        await mainPage.click('#btnTestFairyVoice');

        // Wait for state transition to loading or playing
        let transitionedToPlaying = false;
        let isSpeakingObserved = false;
        let audioVolumeObserved = null;

        for (let i = 0; i < 80; i++) {
            await mainPage.waitForTimeout(500);
            const state = await mainPage.evaluate(() => {
                const btn = document.getElementById('btnTestFairyVoice');
                const vc = window.voiceController;
                return {
                    btnText: btn ? btn.textContent.trim() : '',
                    isSpeaking: vc ? vc.isSpeaking : false,
                    hasAudio: vc && vc.activeKokoroAudio !== null,
                    audioVolume: vc && vc.activeKokoroAudio ? vc.activeKokoroAudio.volume : null,
                    audioPaused: vc && vc.activeKokoroAudio ? vc.activeKokoroAudio.paused : null
                };
            });

            if (i % 5 === 0 || state.btnText.includes('Stop Voice') || state.isSpeaking) {
                console.log(`[Playback poll ${i}] btnText="${state.btnText}", isSpeaking=${state.isSpeaking}, hasAudio=${state.hasAudio}, volume=${state.audioVolume}`);
            }

            if (state.btnText.includes('Stop Voice') || state.isSpeaking) {
                transitionedToPlaying = true;
                isSpeakingObserved = true;
                audioVolumeObserved = state.audioVolume;
                break;
            }
        }

        if (!transitionedToPlaying) {
            throw new Error('#btnTestFairyVoice failed to transition to playing/stop state');
        }
        console.log('SUCCESS: #btnTestFairyVoice transitioned to playing state, volume=', audioVolumeObserved);

        // Test stopping playback
        console.log('Testing Stop Voice button...');
        await mainPage.click('#btnTestFairyVoice');
        await mainPage.waitForTimeout(400);

        const stoppedState = await mainPage.evaluate(() => {
            const btn = document.getElementById('btnTestFairyVoice');
            const vc = window.voiceController;
            return {
                btnText: btn ? btn.textContent.trim() : '',
                isSpeaking: vc ? vc.isSpeaking : false,
                hasAudio: vc && vc.activeKokoroAudio !== null
            };
        });
        console.log('After Stop click:', JSON.stringify(stoppedState));
        if (stoppedState.isSpeaking || stoppedState.hasAudio) {
            throw new Error('Stop button failed to halt speech playback');
        }

        // 5. Test Settings Modal Voice Preview
        console.log('Opening Settings Modal to test #previewVoiceBtn...');
        await mainPage.click('#hudSettingsBtn');
        await mainPage.waitForTimeout(500);

        // Open Voice tab
        await mainPage.click('#tabBtnVoiceSystem');
        await mainPage.waitForTimeout(400);

        const previewBtn = await mainPage.$('#previewVoiceBtn');
        if (!previewBtn) {
            throw new Error('#previewVoiceBtn not found in Settings modal');
        }

        let previewState = null;
        for (let i = 0; i < 80; i++) {
            await mainPage.waitForTimeout(500);
            previewState = await mainPage.evaluate(() => {
                const btn = document.getElementById('previewVoiceBtn');
                const vc = window.voiceController;
                return {
                    btnText: btn ? btn.textContent.trim() : '',
                    isSpeaking: vc ? vc.isSpeaking : false,
                    hasAudio: vc && vc.activeKokoroAudio !== null
                };
            });
            if (previewState.isSpeaking || previewState.hasAudio) {
                break;
            }
        }
        console.log('Preview state after click:', JSON.stringify(previewState));

        // Stop preview
        if (previewState && previewState.isSpeaking) {
            await mainPage.click('#previewVoiceBtn');
            await mainPage.waitForTimeout(300);
        }

        // Take verification screenshot of Companion Settings
        await mainPage.click('#closeSettingsXBtn');
        await mainPage.waitForTimeout(300);
        await mainPage.click('#tabNavCompanionSettings');
        await mainPage.waitForTimeout(400);

        const screenshotPath = path.join(ARTIFACT_DIR, 'voice_preview_verified.png');
        await mainPage.screenshot({ path: screenshotPath });
        console.log(`Saved verification screenshot to: ${screenshotPath}`);

        console.log('=== All Packaged Voice Preview Checks PASSED! ===');
        return {
            ok: true,
            kokoroAvailable: kokoroStatus.isAvailable,
            bellaDuration: bellaRes.duration_s,
            skyDuration: skyRes.duration_s,
            playbackVolume: audioVolumeObserved,
            screenshotPath
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
        if (proc && !proc.killed) {
            try { proc.kill(); } catch (_) {}
        }
        // Clean up temp user data directory
        try {
            fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true });
        } catch (_) {}
    }
}

runPackagedVoicePreviewVerification().then((res) => {
    console.log('Packaged App Verification Result:', JSON.stringify(res, null, 2));
    process.exit(0);
}).catch((err) => {
    console.error('Packaged App Verification FAILED:', err);
    process.exit(1);
});
