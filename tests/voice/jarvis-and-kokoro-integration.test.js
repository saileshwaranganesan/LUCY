'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VoiceController, VOICE_STATES } = require('../../src/voice/voice-controller.js');
const { validateVoiceConfig, validateCompanionDimensions } = require('../../src/security/ipc-validator.js');
const { KokoroTtsService } = require('../../src/voice/kokoro-tts-service.js');

test('L.U.C.Y. Phase 2 & Phase 4: JARVIS UI & Local Fairy Voice Acceptance Suite', async (t) => {

    await t.test('1. JARVIS 5-View Architecture and Design System Elements in index.html', () => {
        const indexPath = path.join(__dirname, '../../src/ui/index.html');
        assert.ok(fs.existsSync(indexPath), 'index.html exists');
        const html = fs.readFileSync(indexPath, 'utf8');

        // 5 Core JARVIS Views
        assert.ok(html.includes('id="viewHome"'), 'View 1: Home / Command Centre exists');
        assert.ok(html.includes('id="viewConversation"'), 'View 2: Conversation View exists');
        assert.ok(html.includes('id="viewIntelligence"'), 'View 3: Intelligence View exists');
        assert.ok(html.includes('id="viewActions"'), 'View 4: Actions View exists');
        assert.ok(html.includes('id="viewCompanionSettings"'), 'View 5: Companion Settings View exists');

        // JARVIS Navigation Deck
        assert.ok(html.includes('class="jarvis-nav-deck"'), 'JARVIS navigation deck exists');
        assert.ok(html.includes('data-view="viewHome"'), 'Nav tab for viewHome exists');
        assert.ok(html.includes('data-view="viewConversation"'), 'Nav tab for viewConversation exists');
        assert.ok(html.includes('data-view="viewIntelligence"'), 'Nav tab for viewIntelligence exists');
        assert.ok(html.includes('data-view="viewActions"'), 'Nav tab for viewActions exists');
        assert.ok(html.includes('data-view="viewCompanionSettings"'), 'Nav tab for viewCompanionSettings exists');

        // Audio-Reactive Visualizer Elements
        assert.ok(html.includes('id="audioVisualizerContainer"'), 'Visualizer bar container exists');
        assert.ok(html.includes('id="audioVisualizerCanvas"'), 'Visualizer canvas exists');
        assert.ok(html.includes('id="vizStatusText"'), 'Visualizer status text exists');
        assert.ok(html.includes('id="vizEngineTag"'), 'Visualizer engine tag exists');

        // Command Centre Portals
        assert.ok(html.includes('id="portalConversationBtn"'), 'Conversation portal button exists');
        assert.ok(html.includes('id="portalMemoryBtn"'), 'Memory portal button exists');
        assert.ok(html.includes('id="portalIntelligenceBtn"'), 'Intelligence portal button exists');
        assert.ok(html.includes('id="portalFloatPetBtn"'), 'Desktop companion portal button exists');

        // Companion Sizing & Voice Controls
        assert.ok(html.includes('id="sliderCompanionWidth"'), 'Width slider exists');
        assert.ok(html.includes('id="sliderCompanionHeight"'), 'Height slider exists');
        assert.ok(html.includes('id="btnResetTinyPet"'), 'Tiny 160x190 reset button exists');
        assert.ok(html.includes('id="settingsTtsEngineSelect"'), 'TTS engine selector exists');
        assert.ok(html.includes('id="settingsKokoroVoiceSelect"'), 'Kokoro fairy voice preset selector exists');
        assert.ok(html.includes('id="btnTestFairyVoice"'), 'Test Fairy Voice audition button exists');
    });

    await t.test('2. JARVIS Futuristic CSS Theme and Color Tokens in style.css', () => {
        const cssPath = path.join(__dirname, '../../src/ui/style.css');
        assert.ok(fs.existsSync(cssPath), 'style.css exists');
        const css = fs.readFileSync(cssPath, 'utf8');

        // Futuristic Palette & Glassmorphic HUD Tokens
        assert.ok(css.includes('--bg-deep: #070913'), 'Deep near-black primary background defined');
        assert.ok(css.includes('--bg-card: rgba(18, 24, 43, 0.75)'), 'Deep navy card background defined');
        assert.ok(css.includes('--accent-cyan: #00f2fe'), 'Cyan illumination accent defined');
        assert.ok(css.includes('--accent-purple: #9d4edd'), 'Violet accent defined');
        assert.ok(css.includes('.jarvis-nav-deck'), 'Navigation deck styles defined');
        assert.ok(css.includes('.jarvis-visualizer-bar'), 'Visualizer bar styles defined');
        assert.ok(css.includes('.jarvis-hero-card'), 'JARVIS hero card styles defined');
        assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'prefers-reduced-motion respected');
    });

    await t.test('3. VoiceController: Configures Kokoro Engine and Voice Presets (Bella / Sky)', () => {
        const controller = new VoiceController({
            ttsEngine: 'kokoro',
            kokoroVoice: 'af_bella'
        });

        assert.strictEqual(controller.ttsEngine, 'kokoro');
        assert.strictEqual(controller.kokoroVoice, 'af_bella');

        const cfg = controller.getVoiceConfig();
        assert.strictEqual(cfg.ttsEngine, 'kokoro');
        assert.strictEqual(cfg.kokoroVoice, 'af_bella');

        // Switch to Sky preset
        controller.setVoiceConfig({ kokoroVoice: 'af_sky' });
        assert.strictEqual(controller.kokoroVoice, 'af_sky');
        assert.strictEqual(controller.getVoiceConfig().kokoroVoice, 'af_sky');

        // Switch engine to Windows SAPI5
        controller.setVoiceConfig({ ttsEngine: 'windows-speech' });
        assert.strictEqual(controller.ttsEngine, 'windows-speech');
        assert.strictEqual(controller.getVoiceConfig().ttsEngine, 'windows-speech');

        // Reset to defaults restores Kokoro + Bella
        controller.resetToDefaults();
        assert.strictEqual(controller.ttsEngine, 'kokoro');
        assert.strictEqual(controller.kokoroVoice, 'af_bella');

        controller.dispose();
    });

    await t.test('4. VoiceController: Seamless Kokoro Synthesis with Renderer Playback and Interruption', async () => {
        let synthesizedCalls = [];
        let stopCalls = 0;

        const mockIpc = {
            synthesizeSpeech: async (text, opts) => {
                synthesizedCalls.push({ text, opts });
                return {
                    ok: true,
                    audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
                    duration_s: 1.5,
                    latency_ms: 120
                };
            },
            stopKokoroSpeech: async () => {
                stopCalls++;
                return { ok: true };
            }
        };

        const mockGlobal = {
            lucyIpc: mockIpc
        };

        const statesEmitted = [];
        const controller = new VoiceController({
            globalScope: mockGlobal,
            ttsEngine: 'kokoro',
            kokoroVoice: 'af_bella',
            onStateChange: (st) => statesEmitted.push(st.voiceState)
        });

        // Trigger speech
        const speakPromise = controller.speakResponse('Hello there! Lucy is ready to help.', { voice: 'af_bella' });
        assert.strictEqual(synthesizedCalls.length, 1);
        assert.strictEqual(synthesizedCalls[0].opts.voice, 'af_bella');

        // Instant interruption via stopSpeaking()
        controller.stopSpeaking();
        assert.ok(stopCalls >= 1, 'stopKokoroSpeech was called upon speech and cancellation');

        const res = await speakPromise;
        // Verify controller cleanly recovered to IDLE
        assert.strictEqual(controller.voiceState, VOICE_STATES.IDLE);

        controller.dispose();
    });

    await t.test('5. VoiceController: Transparent Fallback to Windows SAPI5 Speech on Error', async () => {
        let fallbackSpoken = [];

        const mockIpc = {
            synthesizeSpeech: async () => {
                return { ok: false, error: 'Temporary worker busy' };
            }
        };

        const mockGlobal = {
            lucyIpc: mockIpc,
            speechSynthesis: {
                getVoices: () => [{ name: 'Microsoft David Desktop', lang: 'en-US' }],
                speak: (utt) => {
                    fallbackSpoken.push(utt.text);
                    if (utt.onstart) process.nextTick(utt.onstart);
                    if (utt.onend) process.nextTick(utt.onend);
                },
                cancel: () => {}
            },
            SpeechSynthesisUtterance: class {
                constructor(t) { this.text = t; }
            }
        };

        const controller = new VoiceController({
            globalScope: mockGlobal,
            ttsEngine: 'kokoro',
            kokoroVoice: 'af_bella'
        });

        await controller.speakResponse('Testing automatic speech fallback mechanism.');
        assert.ok(fallbackSpoken.length >= 1, 'Fell back to native synthesis utterance');
        assert.ok(fallbackSpoken[0].includes('Testing automatic speech fallback mechanism'));

        controller.dispose();
    });

    await t.test('6. Security & IPC Validation: Voice Configuration and Companion Sizing', () => {
        // Voice Config Validation
        const v1 = validateVoiceConfig({ ttsEngine: 'kokoro', kokoroVoice: 'af_bella', rate: 1.1, volume: 0.9 });
        assert.ok(v1.ok);
        assert.strictEqual(v1.sanitized.ttsEngine, 'kokoro');
        assert.strictEqual(v1.sanitized.kokoroVoice, 'af_bella');

        const v2 = validateVoiceConfig({ ttsEngine: 'invalid-engine' });
        assert.ok(!v2.ok, 'Rejects invalid TTS engine');

        const v3 = validateVoiceConfig({ kokoroVoice: 'malicious_voice_injection' });
        assert.ok(!v3.ok, 'Rejects unknown voice preset');

        // Companion Sizing Validation and Clamping
        const d1 = validateCompanionDimensions({ width: 160, height: 190 });
        assert.ok(d1.ok);
        assert.strictEqual(d1.sanitized.width, 160);
        assert.strictEqual(d1.sanitized.height, 190);

        // Clamping extreme values
        const d2 = validateCompanionDimensions({ width: 50, height: 1000 });
        assert.ok(d2.ok);
        assert.strictEqual(d2.sanitized.width, 140, 'Clamped to MIN_WIDTH');
        assert.strictEqual(d2.sanitized.height, 600, 'Clamped to MAX_HEIGHT');

        const d3 = validateCompanionDimensions({ width: 'not_a_number', height: 190 });
        assert.ok(!d3.ok, 'Rejects non-numeric dimensions');
    });

    await t.test('7. Offline Kokoro-82M Asset Integrity and Dual-Preset Verification', () => {
        const modelPath = path.join(__dirname, '../../models/kokoro/kokoro-v1.0.int8.onnx');
        const voicePath = path.join(__dirname, '../../models/kokoro/voices.bin');

        assert.ok(fs.existsSync(modelPath), 'Kokoro INT8 ONNX model file exists locally');
        assert.ok(fs.existsSync(voicePath), 'Combined voices.bin file exists locally');

        const modelStats = fs.statSync(modelPath);
        const voiceStats = fs.statSync(voicePath);

        // Size verification: INT8 quantized model ~108MB, voices ~1MB
        assert.ok(modelStats.size > 100 * 1024 * 1024 && modelStats.size < 120 * 1024 * 1024, 'Model is ~108MB INT8 ONNX');
        assert.ok(voiceStats.size > 900 * 1024 && voiceStats.size < 2 * 1024 * 1024, 'Dual voice pack is under 2MB');

        // Kokoro service verifies local availability without network
        const service = new KokoroTtsService({ modelPath, voicePath });
        assert.strictEqual(service.isAvailable(), true);
        service.dispose();
    });

    await t.test('8. Open-Source Reused Components Integrity and Legal Attribution Verification', () => {
        const indexPath = path.join(__dirname, '../../src/ui/index.html');
        const stylePath = path.join(__dirname, '../../src/ui/style.css');
        const companionCssPath = path.join(__dirname, '../../src/companion/companion.css');
        const attrPath = path.join(__dirname, '../../docs/OPEN_SOURCE_ATTRIBUTIONS.md');
        const auditPath = path.join(__dirname, '../../docs/OPEN_SOURCE_REUSE_AUDIT.md');

        const html = fs.readFileSync(indexPath, 'utf8');
        const css = fs.readFileSync(stylePath, 'utf8');
        const companionCss = fs.readFileSync(companionCssPath, 'utf8');

        // Axshatt/VirtualAssistant HUD components verified in UI
        assert.ok(html.includes('jarvis-corner-bracket'), 'Corner brackets integrated into HUD panels');
        assert.ok(html.includes('jarvis-scanlines'), 'Scanlines overlay integrated into hero card');
        assert.ok(html.includes('jarvis-sweep-line'), 'Sweep-line animation integrated into hero card');
        assert.ok(css.includes('.jarvis-corner-bracket'), 'CSS rules for corner brackets defined');
        assert.ok(css.includes('.jarvis-scanlines'), 'CSS rules for scanlines defined');
        assert.ok(css.includes('.jarvis-sweep-line'), 'CSS rules for radar sweep defined');

        // dengyie/OpenPet tactile dragging feedback verified
        assert.ok(companionCss.includes('body.is-dragging'), 'Tactile grab cursor feedback defined in companion.css');

        // Attribution and audit records verified
        assert.ok(fs.existsSync(attrPath), 'docs/OPEN_SOURCE_ATTRIBUTIONS.md exists');
        const attrText = fs.readFileSync(attrPath, 'utf8');
        assert.ok(attrText.includes('Axshatt/VirtualAssistant'), 'Attribution for Axshatt/VirtualAssistant recorded');
        assert.ok(attrText.includes('dengyie/OpenPet'), 'Attribution for dengyie/OpenPet recorded');
        assert.ok(attrText.includes('Kokoro-82M'), 'Attribution for Kokoro-82M recorded');
        assert.ok(attrText.includes('MIT License'), 'MIT license text included');
        assert.ok(attrText.includes('Apache License'), 'Apache-2.0 license text included');

        const auditText = fs.readFileSync(auditPath, 'utf8');
        assert.ok(auditText.includes('Axshatt/VirtualAssistant'), 'VirtualAssistant documented in reuse audit');
        assert.ok(auditText.includes('dengyie/OpenPet'), 'OpenPet documented in reuse audit');
        assert.ok(auditText.includes('Kokoro-82M'), 'Kokoro documented in reuse audit');
    });
});
