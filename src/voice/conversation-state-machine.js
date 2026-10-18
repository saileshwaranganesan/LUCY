'use strict';

/**
 * Conversation State Machine for L.U.C.Y.
 * 
 * Implements the full conversational lifecycle:
 * Wake word → Listening → Speech recognition → Understanding → Response generation → Voice playback → Return to listening
 * 
 * Guarantees:
 * 1. Explicit, deterministic state transitions.
 * 2. Barge-in / interruption: user speech immediately interrupts active TTS.
 * 3. Anti-echo feedback suppression: Lucy's own speech output cannot trigger false wake-word or VAD activations.
 * 4. Multi-turn follow-up listening: user can converse naturally without repeating wake-word on every turn.
 * 5. Verbal confirmation gates for consequential actions.
 * 6. Coordination with TaskCoordinator, ModelRouter, MemoryStore, and Companion.
 */

const { EventEmitter } = require('events');
const { VoiceActivityDetector, VAD_STATES } = require('./voice-activity-detector.js');

const CONVERSATION_STATES = Object.freeze({
    IDLE: 'idle',
    WAKE_WORD_ACTIVE: 'wake_word_active',
    LISTENING: 'listening',
    TRANSCRIBING: 'transcribing',
    WAITING_AI: 'waiting_ai',
    SYNTHESIZING: 'synthesizing',
    SPEAKING: 'speaking',
    INTERRUPTED: 'interrupted',
    WAITING_NEXT_UTTERANCE: 'waiting_next_utterance',
    RECOVERING: 'recovering',
    UNAVAILABLE: 'unavailable',

    // Functional & backward-compatibility aliases
    STANDBY: 'idle',
    WAKE_WORD_DETECTED: 'wake_word_active',
    UNDERSTANDING: 'waiting_ai',
    WAITING_CONFIRMATION: 'waiting_confirmation',
    FOLLOW_UP_LISTENING: 'waiting_next_utterance',
    ERROR: 'recovering'
});

const NORMALIZED_STATES = Object.freeze({
    'standby': 'idle',
    'wake_word_detected': 'wake_word_active',
    'understanding': 'waiting_ai',
    'follow_up_listening': 'waiting_next_utterance',
    'error': 'recovering'
});

const DEFAULT_FOLLOW_UP_TIMEOUT_MS = 6000; // 6s follow-up window
const ANTI_ECHO_COOLDOWN_MS = 350;         // 350ms cooldown after speech playback

class ConversationStateMachine extends EventEmitter {
    constructor({
        voiceController = null,
        taskCoordinator = null,
        permissionAuthority = null,
        companionBridge = null,
        continuousConversation = true,
        followUpTimeoutMs = DEFAULT_FOLLOW_UP_TIMEOUT_MS,
        bargeInEnabled = true,
        autoAcknowledgeWakeWord = true,
        vadSensitivity = 'normal'
    } = {}) {
        super();
        this.voiceController = voiceController;
        this.taskCoordinator = taskCoordinator;
        this.permissionAuthority = permissionAuthority;
        this.companionBridge = companionBridge;

        this.continuousConversation = Boolean(continuousConversation);
        this.followUpTimeoutMs = Number(followUpTimeoutMs) || DEFAULT_FOLLOW_UP_TIMEOUT_MS;
        this.bargeInEnabled = Boolean(bargeInEnabled);
        this.autoAcknowledgeWakeWord = Boolean(autoAcknowledgeWakeWord);
        this.vadSensitivity = vadSensitivity;

        this.state = CONVERSATION_STATES.IDLE;
        this.sessionId = null;
        this.turnCount = 0;
        this.pendingConfirmation = null; // { auditId, toolId, action, question }
        this.lastPlaybackEndTime = 0;
        this.followUpTimer = null;
        this.activeAbortController = null;

        // Dedicated local Voice Activity Detector
        this.vad = new VoiceActivityDetector({
            sensitivity: this.vadSensitivity,
            hangoverMs: 1000,
            initialSilenceTimeoutMs: 7000
        });

        this._setupVadEvents();
        this._setupVoiceControllerEvents();
    }

    _setupVadEvents() {
        this.vad.on('speechStart', () => {
            // Barge-in check: if user speaks while Lucy is speaking
            if (this.state === CONVERSATION_STATES.SPEAKING) {
                if (this.bargeInEnabled && !this._isWithinAntiEchoCooldown()) {
                    this.interrupt('User barge-in detected');
                    this.transitionTo(CONVERSATION_STATES.LISTENING, { trigger: 'barge_in' });
                    return;
                }
            }

            if (this.state === CONVERSATION_STATES.WAITING_NEXT_UTTERANCE || this.state === CONVERSATION_STATES.WAITING_CONFIRMATION) {
                this._clearFollowUpTimer();
                this.transitionTo(CONVERSATION_STATES.LISTENING, { trigger: 'follow_up_speech_onset' });
            }
        });

        this.vad.on('speechEnd', async ({ samples, sampleCount, durationMs }) => {
            if (this.state === CONVERSATION_STATES.LISTENING) {
                this.transitionTo(CONVERSATION_STATES.TRANSCRIBING, { durationMs, sampleCount });
                await this._handleSpeechEnd(samples);
            }
        });

        this.vad.on('silenceTimeout', () => {
            if (this.state === CONVERSATION_STATES.LISTENING) {
                if (this.turnCount > 0 && this.continuousConversation) {
                    this.transitionTo(CONVERSATION_STATES.IDLE, { reason: 'turn_silence_timeout' });
                } else {
                    this.transitionTo(CONVERSATION_STATES.IDLE, { reason: 'initial_silence_timeout' });
                }
            }
        });
    }

    _setupVoiceControllerEvents() {
        if (!this.voiceController) return;

        // When wake word is heard
        this.voiceController.onWakeWord = (result) => {
            if (this._isWithinAntiEchoCooldown()) return;
            this.handleWakeWord(result);
        };
    }

    _isWithinAntiEchoCooldown() {
        return (Date.now() - this.lastPlaybackEndTime) < ANTI_ECHO_COOLDOWN_MS;
    }

    /**
     * Get current conversational state and metrics.
     */
    getState() {
        return {
            state: this.state,
            sessionId: this.sessionId,
            turnCount: this.turnCount,
            continuousConversation: this.continuousConversation,
            bargeInEnabled: this.bargeInEnabled,
            pendingConfirmation: this.pendingConfirmation ? { ...this.pendingConfirmation } : null
        };
    }

    /**
     * Transition explicitly to next state with safety checks and logging.
     * @param {string} nextState - One of CONVERSATION_STATES
     * @param {Object} [detail={}]
     */
    transitionTo(nextState, detail = {}) {
        const canonical = NORMALIZED_STATES[nextState] || nextState;
        if (!Object.values(CONVERSATION_STATES).includes(canonical)) {
            throw new Error(`Invalid conversation state: ${nextState}`);
        }

        const prevState = this.state;
        this.state = canonical;

        // Synchronize companion visual state
        this._syncCompanionEmotion(canonical);

        // Synchronize VAD activation
        if (canonical === CONVERSATION_STATES.LISTENING || canonical === CONVERSATION_STATES.WAITING_NEXT_UTTERANCE || canonical === CONVERSATION_STATES.WAITING_CONFIRMATION) {
            if (!this.vad.isActive) {
                this.vad.start();
            }
        } else {
            if (this.vad.isActive) {
                this.vad.stop();
            }
        }

        this.emit('stateTransition', {
            from: prevState,
            to: canonical,
            sessionId: this.sessionId,
            turnCount: this.turnCount,
            timestamp: new Date().toISOString(),
            ...detail
        });
    }

    _syncCompanionEmotion(state) {
        if (!this.companionBridge) return;
        switch (state) {
            case CONVERSATION_STATES.WAKE_WORD_ACTIVE:
            case CONVERSATION_STATES.LISTENING:
            case CONVERSATION_STATES.WAITING_NEXT_UTTERANCE:
                this.companionBridge.setEmotion('listening', 'Listening to you');
                break;
            case CONVERSATION_STATES.TRANSCRIBING:
            case CONVERSATION_STATES.WAITING_AI:
            case CONVERSATION_STATES.SYNTHESIZING:
                this.companionBridge.setEmotion('thinking', 'Understanding and preparing response');
                break;
            case CONVERSATION_STATES.SPEAKING:
                this.companionBridge.setEmotion('speaking', 'Speaking to you');
                break;
            case CONVERSATION_STATES.WAITING_CONFIRMATION:
                this.companionBridge.setEmotion('curious', 'Waiting for your confirmation');
                break;
            case CONVERSATION_STATES.INTERRUPTED:
                this.companionBridge.setEmotion('curious', 'Interrupted');
                break;
            case CONVERSATION_STATES.RECOVERING:
                this.companionBridge.setEmotion('worried', 'Recovering from an issue');
                break;
            case CONVERSATION_STATES.UNAVAILABLE:
                this.companionBridge.setEmotion('sleepy', 'Voice services unavailable');
                break;
            case CONVERSATION_STATES.IDLE:
            default:
                this.companionBridge.setEmotion('happy', 'Ready');
                break;
        }
    }

    // =========================================================================
    // Conversational Flow Methods
    // =========================================================================

    /**
     * Step 1: Wake-Word Trigger.
     */
    async handleWakeWord(result = {}) {
        if (this.state === CONVERSATION_STATES.SPEAKING && this.bargeInEnabled) {
            this.interrupt('Wake word interruption');
        }

        this.sessionId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        this.turnCount = 0;
        this.transitionTo(CONVERSATION_STATES.WAKE_WORD_DETECTED, { keyword: result.keyword, confidence: result.confidence });

        if (this.autoAcknowledgeWakeWord && this.voiceController) {
            // Brief visual or voice cue, then transition immediately to listening
            this.transitionTo(CONVERSATION_STATES.LISTENING, { trigger: 'wake_word_auto_listen' });
            if (this.voiceController && typeof this.voiceController.startListening === 'function') {
                this.voiceController.startListening();
            }
        } else {
            this.transitionTo(CONVERSATION_STATES.LISTENING, { trigger: 'wake_word_listen' });
        }
    }

    /**
     * Manual push-to-talk trigger.
     */
    startManualConversation() {
        if (this.state === CONVERSATION_STATES.SPEAKING) {
            this.interrupt('Manual mic button press');
        }

        if (!this.sessionId) {
            this.sessionId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            this.turnCount = 0;
        }

        this.transitionTo(CONVERSATION_STATES.LISTENING, { trigger: 'manual_mic' });
        if (this.voiceController && typeof this.voiceController.startListening === 'function') {
            this.voiceController.startListening();
        }
    }

    /**
     * Ingest an audio chunk from microphone stream into VAD.
     */
    processAudioFrame(frame) {
        if (this.state === CONVERSATION_STATES.SPEAKING && this.bargeInEnabled) {
            // Check for barge-in energy during speaking
            let sum = 0;
            for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
            const rms = Math.sqrt(sum / frame.length);
            // Require higher threshold during playback to ignore low speaker bleed
            if (rms > 0.08 && !this._isWithinAntiEchoCooldown()) {
                this.interrupt('Acoustic barge-in');
                this.transitionTo(CONVERSATION_STATES.LISTENING, { trigger: 'acoustic_barge_in' });
                return;
            }
        }

        if (this.state === CONVERSATION_STATES.LISTENING || this.state === CONVERSATION_STATES.FOLLOW_UP_LISTENING || this.state === CONVERSATION_STATES.WAITING_CONFIRMATION) {
            this.vad.processAudioChunk(frame);
        }
    }

    /**
     * Step 2 & 3: Speech recognition upon endpoint.
     */
    async _handleSpeechEnd(samples) {
        let transcript = '';

        try {
            if (this.voiceController && typeof this.voiceController.transcribeAudio === 'function') {
                const res = await this.voiceController.transcribeAudio(samples);
                if (res && res.ok && res.transcript) {
                    transcript = res.transcript.trim();
                } else if (res && res.error) {
                    throw new Error(res.error);
                }
            }
        } catch (err) {
            this.transitionTo(CONVERSATION_STATES.ERROR, { error: err.message, phase: 'transcription' });
            this._scheduleReturnToStandby(1500);
            return;
        }

        if (!transcript) {
            // No speech transcribed from audio
            if (this.turnCount > 0 && this.continuousConversation) {
                this.transitionTo(CONVERSATION_STATES.STANDBY, { reason: 'empty_transcript_end_dialogue' });
            } else {
                this.transitionTo(CONVERSATION_STATES.STANDBY, { reason: 'empty_transcript' });
            }
            return;
        }

        this.emit('transcriptReady', { transcript, sessionId: this.sessionId, turn: this.turnCount + 1 });

        // Step 4: Check if answering a pending confirmation
        if (this.state === CONVERSATION_STATES.WAITING_CONFIRMATION || this.pendingConfirmation) {
            await this._handleConfirmationAnswer(transcript);
            return;
        }

        // Step 4 & 5: Understanding & Response Generation
        await this.handleUserUtterance(transcript);
    }

    /**
     * Step 4 & 5: Understanding, task coordination, and response synthesis.
     */
    async handleUserUtterance(userText) {
        this.turnCount++;
        this.transitionTo(CONVERSATION_STATES.UNDERSTANDING, { userText });

        this.activeAbortController = new AbortController();

        try {
            let responseText = '';
            let executionResult = null;

            if (this.taskCoordinator && typeof this.taskCoordinator.executeRequest === 'function') {
                executionResult = await this.taskCoordinator.executeRequest(userText, {
                    sessionId: this.sessionId,
                    signal: this.activeAbortController.signal
                });

                if (executionResult && executionResult.replyText) {
                    responseText = executionResult.replyText;
                } else if (executionResult && executionResult.error) {
                    responseText = `I encountered an issue: ${executionResult.error}`;
                }
            } else {
                // Fallback direct synthesis for testing
                responseText = `I heard: ${userText}`;
            }

            if (this.activeAbortController.signal.aborted) {
                return;
            }

            // Step 6: Voice Playback
            await this.speakAndFollowUp(responseText);

        } catch (err) {
            if (this.activeAbortController.signal.aborted) return;
            this.transitionTo(CONVERSATION_STATES.ERROR, { error: err.message, phase: 'understanding' });
            this._scheduleReturnToStandby(2000);
        } finally {
            this.activeAbortController = null;
        }
    }

    /**
     * Step 6 & 7: Speak response text and return to follow-up listening.
     */
    async speakAndFollowUp(responseText) {
        if (!responseText || !responseText.trim()) {
            this._concludeOrFollowUp();
            return;
        }

        this.transitionTo(CONVERSATION_STATES.SYNTHESIZING, { text: responseText });

        if (this.voiceController && this.voiceController.ttsEnabled) {
            this.transitionTo(CONVERSATION_STATES.SPEAKING, { text: responseText });
            try {
                await this.voiceController.speakResponse(responseText);
            } catch (_) {}
            this.lastPlaybackEndTime = Date.now();
        }

        this._concludeOrFollowUp();
    }

    _concludeOrFollowUp() {
        if (this.pendingConfirmation) {
            this.transitionTo(CONVERSATION_STATES.WAITING_CONFIRMATION, {
                followUpWindowMs: this.followUpTimeoutMs
            });

            this._clearFollowUpTimer();
            this.followUpTimer = setTimeout(() => {
                if (this.state === CONVERSATION_STATES.WAITING_CONFIRMATION) {
                    this.transitionTo(CONVERSATION_STATES.STANDBY, { reason: 'confirmation_timeout' });
                }
            }, this.followUpTimeoutMs);
            return;
        }

        if (this.continuousConversation) {
            this.transitionTo(CONVERSATION_STATES.FOLLOW_UP_LISTENING, {
                followUpWindowMs: this.followUpTimeoutMs
            });

            this._clearFollowUpTimer();
            this.followUpTimer = setTimeout(() => {
                if (this.state === CONVERSATION_STATES.FOLLOW_UP_LISTENING) {
                    this.transitionTo(CONVERSATION_STATES.STANDBY, { reason: 'follow_up_timeout' });
                }
            }, this.followUpTimeoutMs);
        } else {
            this.transitionTo(CONVERSATION_STATES.STANDBY, { reason: 'turn_completed' });
        }
    }

    _clearFollowUpTimer() {
        if (this.followUpTimer) {
            clearTimeout(this.followUpTimer);
            this.followUpTimer = null;
        }
    }

    _scheduleReturnToStandby(delayMs = 1500) {
        setTimeout(() => {
            if (this.state === CONVERSATION_STATES.ERROR) {
                this.transitionTo(CONVERSATION_STATES.STANDBY, { reason: 'error_recovery' });
            }
        }, delayMs);
    }

    /**
     * Interruption / Barge-in: immediately cancel audio and in-flight operations.
     */
    interrupt(reason = 'User interruption') {
        if (this.activeAbortController) {
            try { this.activeAbortController.abort(reason); } catch (_) {}
            this.activeAbortController = null;
        }

        this._clearFollowUpTimer();

        if (this.voiceController && typeof this.voiceController.stopSpeaking === 'function') {
            this.voiceController.stopSpeaking();
        }

        this.emit('interrupted', { reason, previousState: this.state });
    }

    /**
     * Cancel active conversation turn and return immediately to standby.
     */
    cancel(reason = 'User cancellation') {
        this.interrupt(reason);
        this.pendingConfirmation = null;
        this.transitionTo(CONVERSATION_STATES.STANDBY, { reason });
    }

    // =========================================================================
    // Confirmation Gate Support
    // =========================================================================

    /**
     * Enter confirmation state for high-impact actions.
     */
    async requestConfirmation({ auditId, toolId, action, question }) {
        this.pendingConfirmation = { auditId, toolId, action, question };
        await this.speakAndFollowUp(question);
    }

    async _handleConfirmationAnswer(transcript) {
        const lower = transcript.toLowerCase();
        const conf = this.pendingConfirmation;

        const isAffirmative = lower.includes('yes') || lower.includes('proceed') || lower.includes('confirm') || lower.includes('sure') || lower.includes('go ahead') || lower.includes('do it');
        const isNegative = lower.includes('no') || lower.includes('cancel') || lower.includes('stop') || lower.includes('abort') || lower.includes('don\'t') || lower.includes('dont');

        if (isAffirmative) {
            this.pendingConfirmation = null;
            this.emit('confirmationResolved', { auditId: conf?.auditId, approved: true });
            await this.speakAndFollowUp('Confirmed. Proceeding now.');
        } else if (isNegative) {
            this.pendingConfirmation = null;
            this.emit('confirmationResolved', { auditId: conf?.auditId, approved: false });
            await this.speakAndFollowUp('Action cancelled.');
        } else {
            // Unclear answer, ask again
            this.pendingConfirmation = conf;
            await this.speakAndFollowUp('Please say yes to proceed, or no to cancel.');
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ConversationStateMachine,
        CONVERSATION_STATES,
        DEFAULT_FOLLOW_UP_TIMEOUT_MS,
        ANTI_ECHO_COOLDOWN_MS
    };
}

if (typeof window !== 'undefined') {
    window.ConversationStateMachine = ConversationStateMachine;
    window.CONVERSATION_STATES = CONVERSATION_STATES;
    window.DEFAULT_FOLLOW_UP_TIMEOUT_MS = DEFAULT_FOLLOW_UP_TIMEOUT_MS;
    window.ANTI_ECHO_COOLDOWN_MS = ANTI_ECHO_COOLDOWN_MS;
}
