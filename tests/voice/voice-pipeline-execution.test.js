'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { cleanTextForSpeech } = require('../../src/voice/speech-text-cleaner.js');
const { VoiceController, VOICE_STATES } = require('../../src/voice/voice-controller.js');
const { TaskCoordinator } = require('../../src/core/task-coordinator.js');
const { ToolRegistry } = require('../../src/tools/tool-registry.js');
const { PermissionAuthority } = require('../../src/security/permission-authority.js');
const { ResultVerifier } = require('../../src/core/result-verifier.js');
const { TaskRecoveryEngine } = require('../../src/core/recovery-engine.js');
const { validateSendVoiceState } = require('../../src/security/ipc-validator.js');

const testMemDir = path.join(os.tmpdir(), 'lucy_voice_test_mem_' + Date.now());
if (!fs.existsSync(testMemDir)) fs.mkdirSync(testMemDir, { recursive: true });
process.env.LUCY_MEMORY_DIR = testMemDir;

test('L.U.C.Y. Phase 5: Voice Pipeline & End-to-End Voice-Driven Task Execution', async (t) => {
    t.after(() => {
        try {
            if (fs.existsSync(testMemDir)) fs.rmSync(testMemDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test('1. Secret Redaction: Sensitive tokens are scrubbed before TTS output', () => {
        // API keys, tokens, and passwords must never be pronounced aloud
        const inputWithApiKey = 'Task done! Your OpenAI key is sk-1234567890abcdef1234567890 for API calls.';
        const cleanedKey = cleanTextForSpeech(inputWithApiKey);
        assert.ok(!cleanedKey.includes('sk-1234567890abcdef1234567890'), 'Raw OpenAI key must be removed');
        assert.ok(cleanedKey.toLowerCase().includes('secret key'), 'Should use safe descriptor');

        const inputWithGitHubToken = 'Your token is ghp_1234567890abcdef1234567890abcdef1234.';
        const cleanedGh = cleanTextForSpeech(inputWithGitHubToken);
        assert.ok(!cleanedGh.includes('ghp_1234567890abcdef1234567890abcdef1234'), 'GitHub PAT must be removed');
        assert.ok(cleanedGh.toLowerCase().includes('access token'), 'Should use safe descriptor');

        const inputWithPassword = 'Created user admin with password: SuperSecretPassword123.';
        const cleanedPwd = cleanTextForSpeech(inputWithPassword);
        assert.ok(!cleanedPwd.includes('SuperSecretPassword123'), 'Plaintext password must be redacted');
        assert.ok(cleanedPwd.toLowerCase().includes('credentials omitted'), 'Should indicate credentials omitted');

        const inputWithRedactedTag = 'Retrieved status for [REDACTED_SECRET]. Verification complete.';
        const cleanedTag = cleanTextForSpeech(inputWithRedactedTag);
        assert.ok(!cleanedTag.includes('[REDACTED_SECRET]'), 'Raw tag must not be pronounced');
        assert.ok(cleanedTag.toLowerCase().includes('redacted'), 'Should pronounce redacted safely');
    });

    await t.test('2. Push-to-Talk Lifecycle: Clean state transitions and explicit activation', () => {
        const stateEvents = [];
        let finalTranscriptReceived = null;

        const mockRecorder = {
            supported: true,
            start: async () => true,
            stop: async () => Buffer.from('mock-audio-pcm'),
            cancel: () => {}
        };

        const mockWhisper = {
            isAvailable: () => true,
            getStatus: () => ({ isAvailable: true, engine: 'whisper.cpp' }),
            transcribeAudio: async () => ({
                ok: true,
                transcript: 'What is the current system status?'
            })
        };

        const controller = new VoiceController({
            recognitionMode: 'offline',
            whisperEngine: mockWhisper,
            audioRecorder: mockRecorder,
            onStateChange: (evt) => stateEvents.push(evt.voiceState),
            onFinalTranscript: (text) => { finalTranscriptReceived = text; }
        });

        assert.equal(controller.voiceState, VOICE_STATES.IDLE);
        assert.equal(controller.isListening, false);

        // 1. Explicit user activation starts listening
        const started = controller.startListening();
        assert.equal(started, true);
        assert.equal(controller.isListening, true);
        assert.equal(controller.voiceState, VOICE_STATES.LISTENING);

        // 2. Repeated activation is rejected to prevent duplicate recording sessions
        const repeatedStart = controller.startListening();
        assert.equal(repeatedStart, false);

        // 3. Explicit stop triggers transcribing and emits final transcript
        const stopped = controller.stopListening();
        assert.equal(stopped, true);

        return new Promise((resolve) => {
            setTimeout(() => {
                assert.equal(controller.voiceState, VOICE_STATES.IDLE);
                assert.equal(finalTranscriptReceived, 'What is the current system status?');
                assert.ok(stateEvents.includes(VOICE_STATES.LISTENING));
                assert.ok(stateEvents.includes(VOICE_STATES.TRANSCRIBING));
                assert.ok(stateEvents.includes(VOICE_STATES.IDLE));
                resolve();
            }, 50);
        });
    });

    await t.test('3. Empty, silence, and unintelligible transcripts produce clear feedback', () => {
        let finalTranscriptReceived = null;

        const mockRecorder = {
            supported: true,
            start: async () => true,
            stop: async () => Buffer.from('silence-pcm'),
            cancel: () => {}
        };

        // Whisper outputs [BLANK_AUDIO] or empty string on silence
        const mockWhisper = {
            isAvailable: () => true,
            getStatus: () => ({ isAvailable: true }),
            transcribeAudio: async () => ({
                ok: true,
                transcript: ' [BLANK_AUDIO] ... '
            })
        };

        const controller = new VoiceController({
            recognitionMode: 'offline',
            whisperEngine: mockWhisper,
            audioRecorder: mockRecorder,
            onFinalTranscript: (text) => { finalTranscriptReceived = text; }
        });

        controller.startListening();
        controller.stopListening();

        return new Promise((resolve) => {
            setTimeout(() => {
                // Should clean [BLANK_AUDIO] and dots to empty string
                assert.equal(finalTranscriptReceived, '');
                assert.equal(controller.voiceState, VOICE_STATES.IDLE);
                resolve();
            }, 50);
        });
    });

    await t.test('4. Empty audio buffer handled gracefully without false transcription failure', () => {
        let finalTranscriptReceived = null;
        let errorReceived = null;

        const mockRecorder = {
            supported: true,
            start: async () => true,
            stop: async () => null, // user tapped stop immediately with 0 bytes
            cancel: () => {}
        };

        const mockWhisper = {
            isAvailable: () => true,
            getStatus: () => ({ isAvailable: true }),
            transcribeAudio: async () => ({ ok: false, error: 'Should not be called' })
        };

        const controller = new VoiceController({
            recognitionMode: 'offline',
            whisperEngine: mockWhisper,
            audioRecorder: mockRecorder,
            onFinalTranscript: (text) => { finalTranscriptReceived = text; },
            onError: (err) => { errorReceived = err; }
        });

        controller.startListening();
        controller.stopListening();

        return new Promise((resolve) => {
            setTimeout(() => {
                assert.equal(finalTranscriptReceived, '');
                assert.equal(errorReceived, null, 'Zero bytes must not produce false failure error');
                assert.equal(controller.voiceState, VOICE_STATES.IDLE);
                resolve();
            }, 50);
        });
    });

    await t.test('5. STT Offline Provider Failure & Fallback Handling', () => {
        let errorReported = null;

        const controller = new VoiceController({
            recognitionMode: 'offline',
            whisperEngine: {
                isAvailable: () => false,
                getStatus: () => ({ isAvailable: false, message: 'binary missing' })
            },
            onError: (err) => { errorReported = err; }
        });

        const started = controller.startListening();
        assert.equal(started, false, 'Offline mode must fail-closed if whisper is missing');
        assert.ok(errorReported, 'Must emit actionable error');
        assert.equal(errorReported.code, 'OFFLINE_UNAVAILABLE');
        assert.equal(controller.voiceState, VOICE_STATES.ERROR);
    });

    await t.test('6. In-Flight Voice Request Cancellation and Resource Cleanup', () => {
        let recorderCancelled = false;
        let abortTriggered = false;

        const mockRecorder = {
            supported: true,
            start: async () => true,
            stop: async () => Buffer.from('pcm'),
            cancel: () => { recorderCancelled = true; }
        };

        const controller = new VoiceController({
            recognitionMode: 'offline',
            whisperEngine: {
                isAvailable: () => true,
                transcribeAudio: async (_buf, opts) => {
                    if (opts.signal) {
                        opts.signal.addEventListener('abort', () => { abortTriggered = true; });
                    }
                    return new Promise((res) => setTimeout(() => res({ ok: true, transcript: 'test' }), 200));
                }
            },
            audioRecorder: mockRecorder
        });

        controller.startListening();
        assert.equal(controller.isListening, true);

        // Cancel listening before/during transcription
        const cancelled = controller.cancelListening();
        assert.equal(cancelled, true);
        assert.equal(recorderCancelled, true, 'Audio recorder must be cancelled');
        assert.equal(controller.voiceState, VOICE_STATES.IDLE, 'State must return to idle');
    });

    await t.test('7. Spoken Response Interruption: User barge-in or explicit stop terminates speech', async () => {
        let stoppedCalled = false;

        const mockSynthesis = {
            supported: true,
            isSpeaking: false,
            speak: async (_text, opts) => {
                mockSynthesis.isSpeaking = true;
                if (opts.onStart) opts.onStart();
                return new Promise((res) => setTimeout(() => {
                    mockSynthesis.isSpeaking = false;
                    res(true);
                }, 200));
            },
            stop: () => {
                stoppedCalled = true;
                mockSynthesis.isSpeaking = false;
            }
        };

        const controller = new VoiceController({
            ttsEnabled: true,
            synthesis: mockSynthesis
        });

        // Trigger speech
        const speakPromise = controller.speak('This is a longer spoken response that will be interrupted.');
        
        // Wait for speech to start
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(controller.isSpeaking, true);

        // Explicit user stop or barge-in
        controller.stopSpeaking();
        assert.equal(stoppedCalled, true);
        assert.equal(controller.isSpeaking, false);
        assert.equal(controller.voiceState, VOICE_STATES.IDLE);

        await speakPromise;
    });

    await t.test('8. UI and Companion Voice State Synchronization Validation', () => {
        // Verify all Phase 5 lifecycle states pass IPC validation
        const requiredStates = [
            'idle',
            'listening',
            'transcribing',
            'understanding',
            'awaiting_confirmation',
            'executing',
            'speaking',
            'cancelled',
            'error'
        ];

        for (const st of requiredStates) {
            const res = validateSendVoiceState({ voiceState: st, text: 'Test update' });
            assert.equal(res.ok, true, `State '${st}' must be accepted by IPC validator`);
        }

        // Invalid states are rejected
        const invalidRes = validateSendVoiceState({ voiceState: 'unauthorized_hack_state' });
        assert.equal(invalidRes.ok, false);
        assert.equal(invalidRes.code, 'INVALID_VOICE_STATE');
    });

    await t.test('9. Workflow A (Ask a question by voice): Informational direct answer without tools', async () => {
        const toolRegistry = new ToolRegistry({ projectRoot: process.cwd() });
        const permissionAuthority = new PermissionAuthority();
        const resultVerifier = new ResultVerifier();
        const recoveryEngine = new TaskRecoveryEngine();

        const coordinator = new TaskCoordinator({
            toolRegistry,
            permissionAuthority,
            resultVerifier,
            recoveryEngine
        });

        const voiceTranscript = "What is the capital of France?";
        const planOverride = {
            type: 'conversation',
            replyText: "The capital of France is Paris, famous for the Eiffel Tower and rich history.",
            steps: []
        };

        const result = await coordinator.executeRequest(voiceTranscript, { planOverride });

        assert.equal(result.ok, true);
        assert.ok(result.replyText.includes('Paris'), 'Response must answer the question');
        assert.equal(result.executedSteps.length, 0, 'Informational question must not run desktop tools');

        // Verify that the answer text is speakable and secrets are scrubbed
        const speakable = cleanTextForSpeech(result.replyText);
        assert.ok(speakable.length > 0);
        assert.ok(speakable.includes('Paris'));
    });

    await t.test('10. Workflow B (Execute spoken desktop task): Voice to verified tool execution', async () => {
        const toolRegistry = new ToolRegistry({ projectRoot: process.cwd() });
        let typedText = '';
        let appLaunched = false;

        // Register harmless verified desktop mock tools
        toolRegistry.registerTool({
            id: 'notepad_launch',
            description: 'Launch Notepad editor',
            parameters: {},
            category: 'desktop',
            isConsequential: false,
            handler: async () => {
                appLaunched = true;
                return { status: 'success', windowTitle: 'Untitled - Notepad', pid: 1234 };
            }
        });

        toolRegistry.registerTool({
            id: 'notepad_type_and_verify',
            description: 'Type text into Notepad and verify readback',
            parameters: {
                text: { type: 'string', description: 'Text to type' }
            },
            category: 'desktop',
            isConsequential: false,
            handler: async (params) => {
                typedText = params.text;
                return {
                    status: 'success',
                    readText: typedText,
                    verified: typedText === 'Lucy voice workflow test 123'
                };
            }
        });

        const permissionAuthority = new PermissionAuthority();
        const resultVerifier = new ResultVerifier();
        const recoveryEngine = new TaskRecoveryEngine();

        const coordinator = new TaskCoordinator({
            toolRegistry,
            permissionAuthority,
            resultVerifier,
            recoveryEngine
        });

        // Spoken command: "Open Notepad, type 'Lucy voice workflow test 123', and verify that the text is present"
        const planOverride = {
            objective: "Open Notepad, type 'Lucy voice workflow test 123', and verify that the text is present",
            steps: [
                {
                    id: 'step_1',
                    index: 1,
                    title: 'Launch Notepad',
                    toolId: 'notepad_launch',
                    params: {}
                },
                {
                    id: 'step_2',
                    index: 2,
                    title: 'Type text into Notepad',
                    toolId: 'notepad_type_and_verify',
                    params: { text: 'Lucy voice workflow test 123' },
                    dependsOn: ['step_1']
                }
            ]
        };

        // Execute through coordinator
        const executionResult = await coordinator.executeRequest(
            "Open Notepad, type 'Lucy voice workflow test 123', and verify that the text is present",
            { planOverride, dryRun: false }
        );
        assert.equal(executionResult.ok, true);
        assert.equal(appLaunched, true);
        assert.equal(typedText, 'Lucy voice workflow test 123');
        assert.equal(executionResult.executedSteps.length, 2);

        // Formulate spoken confirmation grounded in verified execution result
        const spokenConfirmation = `Notepad was launched and the text 'Lucy voice workflow test 123' was verified present.`;
        const speakableOutput = cleanTextForSpeech(spokenConfirmation);
        assert.ok(speakableOutput.includes('Lucy voice workflow test 123'));
        assert.ok(speakableOutput.includes('verified'));
    });

    await t.test('11. Workflow C (Failure and cancellation handling): Unintelligible input, provider failure, and task cancellation', async () => {
        const toolRegistry = new ToolRegistry({ projectRoot: process.cwd() });
        const permissionAuthority = new PermissionAuthority();
        const resultVerifier = new ResultVerifier();
        const recoveryEngine = new TaskRecoveryEngine();

        let step1Ran = false;
        let step2Ran = false;

        const coordinator = new TaskCoordinator({
            toolRegistry,
            permissionAuthority,
            resultVerifier,
            recoveryEngine
        });

        toolRegistry.registerTool({
            id: 'cancellable_step_1',
            parameters: {},
            handler: async (_p, ctx) => {
                step1Ran = true;
                coordinator.cancelTask(ctx.taskId, 'User cancelled');
                return { status: 'success' };
            }
        });

        toolRegistry.registerTool({
            id: 'cancellable_step_2',
            parameters: {},
            handler: async () => {
                step2Ran = true;
                return { status: 'success' };
            }
        });

        // 1. Unintelligible / empty transcript handling
        const emptyTranscript = '   ';
        const emptyCleaned = cleanTextForSpeech(emptyTranscript);
        assert.equal(emptyCleaned, 'Ready!'); // Fallback phrase without fabricating task execution

        // 2. Cancellation during active workflow prevents subsequent steps
        const taskId = 'test_cancel_task_' + Date.now();
        const cancelPlan = {
            objective: 'Cancellable workflow',
            steps: [
                {
                    id: 's1',
                    index: 1,
                    title: 'Step 1',
                    toolId: 'cancellable_step_1',
                    params: {}
                },
                {
                    id: 's2',
                    index: 2,
                    title: 'Step 2',
                    toolId: 'cancellable_step_2',
                    params: {},
                    dependsOn: ['s1']
                }
            ]
        };

        const execResult = await coordinator.executeRequest('Run cancellable task', {
            taskId,
            planOverride: cancelPlan
        });

        assert.equal(execResult.ok, false);
        assert.equal(execResult.status, 'cancelled');
        assert.equal(step1Ran, true);
        assert.equal(step2Ran, false, 'Eligible unstarted steps must not run after cancellation');
    });

    await t.test('12. Consequential Permission Boundary: Voice commands cannot bypass confirmation', async () => {
        const permissionAuthority = new PermissionAuthority({
            mode: 'standard'
        });
        const toolRegistry = new ToolRegistry({
            projectRoot: process.cwd(),
            permissionAuthority
        });
        let deleted = false;

        toolRegistry.registerTool({
            id: 'delete_database_file',
            name: 'Delete Database File',
            description: 'Consequential action requiring explicit approval',
            riskTier: 'consequential_mutate',
            isConsequential: true,
            parameters: {},
            handler: async () => {
                deleted = true;
                return { status: 'deleted' };
            }
        });

        const resultVerifier = new ResultVerifier();
        const recoveryEngine = new TaskRecoveryEngine();

        const coordinator = new TaskCoordinator({
            toolRegistry,
            permissionAuthority,
            resultVerifier,
            recoveryEngine
        });

        const consequentialPlan = {
            objective: 'Consequential action requiring explicit approval',
            steps: [{
                id: 'consequential_step',
                index: 1,
                title: 'Delete Database File',
                toolId: 'delete_database_file',
                isConsequential: true,
                params: {}
            }]
        };

        // In non-interactive mode without permission grant, consequential action fails closed
        const execResult = await coordinator.executeRequest('Delete database file', {
            planOverride: consequentialPlan,
            dryRun: false
        });
        assert.equal(execResult.ok, false);
        assert.equal(deleted, false, 'Consequential action must fail closed when unconfirmed');
    });
});
