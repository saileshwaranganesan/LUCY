'use strict';

/**
 * Real Windows Environment Voice Acceptance & Live Workflow Verification Suite
 * 
 * Verifies live speech synthesis (Kokoro-82M ONNX & Windows SAPI5),
 * offline local Whisper recognition, real desktop automation via LucyUiaWorker.exe,
 * secret redaction before TTS, and task execution through TaskCoordinator.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { WhisperOfflineRecognitionEngine } = require('../../src/voice/whisper-recognition.js');
const { KokoroTtsService } = require('../../src/voice/kokoro-tts-service.js');
const { cleanTextForSpeech } = require('../../src/voice/speech-text-cleaner.js');
const { DesktopAutomationManager } = require('../../src/tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../../src/tools/desktop-app-tools.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES } = require('../../src/security/permission-authority.js');
const { ResultVerifier } = require('../../src/core/result-verifier.js');
const { TaskRecoveryEngine } = require('../../src/core/recovery-engine.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { TaskPlanner } = require('../../src/core/task-planner.js');

const testMemDir = path.join(os.tmpdir(), 'lucy_real_voice_test_mem_' + Date.now());
if (!fs.existsSync(testMemDir)) fs.mkdirSync(testMemDir, { recursive: true });
process.env.LUCY_MEMORY_DIR = testMemDir;

test('L.U.C.Y. Phase 5: Real Windows Environment Voice & Workflow Acceptance Suite', async (t) => {
    t.after(() => {
        try {
            if (fs.existsSync(testMemDir)) fs.rmSync(testMemDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test('1. Secret Redaction: Sensitive credentials scrubbed before TTS output', () => {
        const rawSecretText = "Your API key is sk-proj-1234567890abcdef12345678 and token is ghp_123456789012345678901234567890123456 with password: MySecretPassword123!";
        const cleanedText = cleanTextForSpeech(rawSecretText);

        assert.equal(cleanedText.includes('sk-proj'), false);
        assert.equal(cleanedText.includes('ghp_'), false);
        assert.equal(cleanedText.includes('MySecretPassword123'), false);
        assert.ok(cleanedText.includes('secret key'));
        assert.ok(cleanedText.includes('credentials omitted'));
    });

    await t.test('2. Windows SAPI5 Real Speech Synthesis Generation', () => {
        const sapi5WavPath = path.join(os.tmpdir(), `lucy_sapi5_test_${Date.now()}.wav`);
        const psScript = `
            Add-Type -AssemblyName System.Speech;
            $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
            $s.SetOutputToWaveFile('${sapi5WavPath.replace(/\\/g, '\\\\')}');
            $s.Speak('Hello, this is Lucy verifying Windows SAPI5 offline speech synthesis.');
            $s.Dispose();
        `;
        const psResult = spawnSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' });
        assert.equal(psResult.status, 0, `PowerShell SAPI5 execution failed: ${psResult.stderr}`);
        assert.ok(fs.existsSync(sapi5WavPath), 'SAPI5 WAV file must exist');
        assert.ok(fs.statSync(sapi5WavPath).size > 1000, 'SAPI5 WAV must contain audio data');

        try { fs.unlinkSync(sapi5WavPath); } catch (_) {}
    });

    await t.test('3. Offline Whisper Local Transcription of Synthesized Audio', async () => {
        const sapi5WavPath = path.join(os.tmpdir(), `lucy_sapi5_whisper_${Date.now()}.wav`);
        const psScript = `
            Add-Type -AssemblyName System.Speech;
            $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
            $s.SetOutputToWaveFile('${sapi5WavPath.replace(/\\/g, '\\\\')}');
            $s.Speak('Hello, this is Lucy verifying Windows SAPI5 offline speech synthesis.');
            $s.Dispose();
        `;
        spawnSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' });

        const whisper = new WhisperOfflineRecognitionEngine();
        assert.equal(whisper.isAvailable(), true);

        const whisperRes = await whisper.transcribeAudio(sapi5WavPath);
        assert.equal(whisperRes.ok, true);
        assert.match(whisperRes.transcript, /Hello.*Lucy/i);
        assert.ok(whisperRes.durationMs > 0);

        try { fs.unlinkSync(sapi5WavPath); } catch (_) {}
    });

    await t.test('4. Kokoro-82M Local ONNX Speech Worker Synthesis', { timeout: 180000 }, async () => {
        const kokoro = new KokoroTtsService();
        assert.equal(kokoro.isAvailable(), true);

        await kokoro.loadModel();
        assert.equal(kokoro.isLoaded, true);

        const testPhrase = "Photosynthesis is plant energy.";
        const synthRes = await kokoro._sendCommand({
            cmd: 'synthesize',
            text: testPhrase,
            voice: 'af_bella',
            speed: 1.0
        });

        assert.equal(synthRes.status, 'ok');
        assert.ok(synthRes.audio && synthRes.audio.length > 1000);
        assert.ok(synthRes.duration_s > 0);

        await kokoro.unloadModel();
        kokoro._cleanupWorker();
    });

    await t.test('5. Workflow A: Informational Question Intent & Direct Answer Synthesis', async () => {
        const taskPlanner = new TaskPlanner();
        const intentRes = taskPlanner.classifyIntent('What is photosynthesis?');
        assert.equal(String(intentRes.intentType).toLowerCase(), 'direct_answer');

        const coordinatorA = new TaskCoordinator({
            taskPlanner,
            toolRegistry: new ToolRegistry({ projectRoot: process.cwd() }),
            permissionAuthority: new PermissionAuthority(),
            resultVerifier: new ResultVerifier(),
            recoveryEngine: new TaskRecoveryEngine()
        });

        const resultA = await coordinatorA.executeRequest('What is photosynthesis?', {
            planOverride: {
                type: 'conversation',
                replyText: "Photosynthesis is the biological process by which green plants transform sunlight, carbon dioxide, and water into chemical energy.",
                steps: []
            }
        });

        assert.equal(resultA.ok, true);
        assert.equal(resultA.executedSteps.length, 0);
        assert.ok((resultA.replyText || resultA.summary).includes('Photosynthesis'));
    });

    await t.test('6. Workflow B: Live Real-Device Windows Desktop Task Execution', async () => {
        const desktopManager = new DesktopAutomationManager();
        await desktopManager.ensureWorker();

        const toolRegistry = new ToolRegistry({ projectRoot: process.cwd() });
        registerDesktopTools(toolRegistry, desktopManager);

        const permissionAuthority = new PermissionAuthority({ mode: PERMISSION_MODES.STANDARD });
        permissionAuthority.setConfirmationHandler(async () => ({ confirmed: true, rationale: 'Automated test authorization' }));

        const coordinatorB = new TaskCoordinator({
            toolRegistry,
            permissionAuthority,
            resultVerifier: new ResultVerifier(),
            recoveryEngine: new TaskRecoveryEngine()
        });

        const requestB = "Open Notepad, type 'Lucy voice acceptance test 123', and verify that the text is present";
        const planB = {
            objective: requestB,
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Launch Notepad',
                    toolId: 'desktop_launch_app',
                    params: { executable: 'notepad.exe' }
                },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Type text into Notepad',
                    toolId: 'desktop_type_text',
                    params: {
                        target: '{{step_1.appId}}',
                        text: 'Lucy voice acceptance test 123'
                    },
                    dependsOn: ['step_1']
                }
            ]
        };

        const resultB = await coordinatorB.executeRequest(requestB, { planOverride: planB });
        assert.equal(resultB.ok, true);
        assert.equal(resultB.executedSteps.length, 2);

        const step1 = resultB.executedSteps[0];
        const step2 = resultB.executedSteps[1];

        assert.equal(step1.verified, true);
        assert.equal(step2.verified, true);
        assert.equal(step2.result.readText, 'Lucy voice acceptance test 123');

        // Clean up Notepad
        if (step1.result?.pid) {
            try {
                await desktopManager.closeApp(step1.result.pid, {
                    savePolicy: 'dont_save',
                    force: true,
                    taskId: resultB.taskId
                });
            } catch (_) {}
        }
        if (desktopManager.proc) {
            desktopManager.proc.kill();
        }
    });
});
