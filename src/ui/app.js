'use strict';

/**
 * Desktop UI Controller for L.U.C.Y.
 */
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('creatureCanvas');
    const speechBubble = document.getElementById('speechBubble');
    const statusLabel = document.getElementById('statusLabel');
    const statusDot = document.getElementById('statusDot');
    const emotionLabel = document.getElementById('emotionLabel');
    const taskFeed = document.getElementById('taskFeed');
    const commandInput = document.getElementById('commandInput');
    const sendBtn = document.getElementById('sendBtn');
    const petBtn = document.getElementById('petBtn');
    const toggleDryRunBtn = document.getElementById('toggleDryRunBtn');
    const toggleFloatingBtn = document.getElementById('toggleFloatingBtn');
    const hudProvider = document.getElementById('hudProvider');
    const hudPermission = document.getElementById('hudPermission');
    const hudMemory = document.getElementById('hudMemory');
    const hudSettingsBtn = document.getElementById('hudSettingsBtn');
    const sidebarSettingsBtn = document.getElementById('sidebarSettingsBtn');

    // Voice & Audio Controls
    const micBtn = document.getElementById('micBtn');
    const stopVoiceBtn = document.getElementById('stopVoiceBtn');
    const toggleTtsBtn = document.getElementById('toggleTtsBtn');
    const cancelStreamBtn = document.getElementById('cancelStreamBtn');

    // Permission Modal Elements
    const permissionModal = document.getElementById('permissionModal');
    const permissionModalBody = document.getElementById('permissionModalBody');
    const approvePermissionBtn = document.getElementById('approvePermissionBtn');
    const denyPermissionBtn = document.getElementById('denyPermissionBtn');

    // Settings Modal Elements
    const settingsModal = document.getElementById('settingsModal');
    const settingProvider = document.getElementById('settingProvider');
    const settingModel = document.getElementById('settingModel');
    const settingApiKey = document.getElementById('settingApiKey');
    const keyStatusBadge = document.getElementById('keyStatusBadge');
    const settingLocalUrl = document.getElementById('settingLocalUrl');
    const apiKeyGroup = document.getElementById('apiKeyGroup');
    const localUrlGroup = document.getElementById('localUrlGroup');
    const clearKeyBtn = document.getElementById('clearKeyBtn');
    const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const discoverOllamaBtn = document.getElementById('discoverOllamaBtn');
    const ollamaDiscoveryStatus = document.getElementById('ollamaDiscoveryStatus');
    const modelDiscoveryBadge = document.getElementById('modelDiscoveryBadge');
    const modelDatalist = document.getElementById('modelDatalist');
    const hfNotice = document.getElementById('hfNotice');
    const settingTtsEnabled = document.getElementById('settingTtsEnabled');
    const settingVoiceSelect = document.getElementById('settingVoiceSelect');
    const previewVoiceBtn = document.getElementById('previewVoiceBtn');
    const settingVoicePitch = document.getElementById('settingVoicePitch');
    const settingVoiceRate = document.getElementById('settingVoiceRate');
    const settingVoiceVolume = document.getElementById('settingVoiceVolume');
    const voicePitchVal = document.getElementById('voicePitchVal');
    const voiceRateVal = document.getElementById('voiceRateVal');
    const voiceVolumeVal = document.getElementById('voiceVolumeVal');
    const settingWakeWordEnabled = document.getElementById('settingWakeWordEnabled');
    const wakeWordOptionsGroup = document.getElementById('wakeWordOptionsGroup');
    const settingCloseActionModal = document.getElementById('settingCloseActionModal');
    const settingBackgroundListeningModal = document.getElementById('settingBackgroundListeningModal');
    const settingCompanionPinnedModal = document.getElementById('settingCompanionPinnedModal');
    const lifecycleStateBadge = document.getElementById('lifecycleStateBadge');
    const explicitExitBtn = document.getElementById('explicitExitBtn');
    const hudExitBtn = document.getElementById('hudExitBtn');
    const settingWakeWordSensitivity = document.getElementById('settingWakeWordSensitivity');
    const wakeWordSensitivityVal = document.getElementById('wakeWordSensitivityVal');
    const settingContinuousConversation = document.getElementById('settingContinuousConversation');
    const settingBargeInEnabled = document.getElementById('settingBargeInEnabled');
    const settingVadSensitivity = document.getElementById('settingVadSensitivity');

    // Memory & Continuity Elements
    const hudMemoryBtn = document.getElementById('hudMemoryBtn');
    const sidebarMemoryBtn = document.getElementById('sidebarMemoryBtn');
    const memoryModal = document.getElementById('memoryModal');
    const closeMemoryModalBtn = document.getElementById('closeMemoryModalBtn');
    const tabMemoriesBtn = document.getElementById('tabMemoriesBtn');
    const tabContinuityBtn = document.getElementById('tabContinuityBtn');
    const tabProjectsBtn = document.getElementById('tabProjectsBtn');
    const tabAddMemoryBtn = document.getElementById('tabAddMemoryBtn');
    const paneMemories = document.getElementById('paneMemories');
    const paneContinuity = document.getElementById('paneContinuity');
    const paneProjects = document.getElementById('paneProjects');
    const paneAddMemory = document.getElementById('paneAddMemory');
    const toggleLongTermCheckbox = document.getElementById('toggleLongTermCheckbox');
    const memorySearchInput = document.getElementById('memorySearchInput');
    const clearCategoryBtn = document.getElementById('clearCategoryBtn');
    const exportMemoryBtn = document.getElementById('exportMemoryBtn');
    const importMemoryBtn = document.getElementById('importMemoryBtn');
    const memoryFileInput = document.getElementById('memoryFileInput');
    const memoryListContainer = document.getElementById('memoryListContainer');
    const projectSnapshotsContainer = document.getElementById('projectSnapshotsContainer');
    const interruptedTasksList = document.getElementById('interruptedTasksList');
    const addMemoryCategory = document.getElementById('addMemoryCategory');
    const addMemoryKey = document.getElementById('addMemoryKey');
    const addMemoryContent = document.getElementById('addMemoryContent');
    const addMemoryTtl = document.getElementById('addMemoryTtl');
    const workingDataTtlGroup = document.getElementById('workingDataTtlGroup');
    const saveExplicitMemoryBtn = document.getElementById('saveExplicitMemoryBtn');
    const catPills = document.querySelectorAll('.cat-pill');
    let currentMemoryCat = 'all';

    let isDryRun = false;
    let pendingPermissionResolve = null;
    let switchJarvisView = null;

    // 1. Initialize Creature Companion Renderer with dynamic stage sizing
    const creatureStage = document.getElementById('creatureStage');
    function resizeMainCompanionCanvas() {
        if (!canvas || !creatureStage) return;
        const rect = creatureStage.getBoundingClientRect();
        const stageW = Math.max(120, Math.floor(rect.width));
        const stageH = Math.max(120, Math.floor(rect.height));
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(2.5, window.devicePixelRatio) : 1;

        canvas.style.width = stageW + 'px';
        canvas.style.height = stageH + 'px';

        if (renderer && typeof renderer.onResize === 'function') {
            renderer.onResize(stageW, stageH, dpr);
        }
    }

    const stageRect = creatureStage ? creatureStage.getBoundingClientRect() : null;
    const initialStageW = (stageRect && stageRect.width > 0) ? Math.floor(stageRect.width) : (canvas ? canvas.width : 280);
    const initialStageH = (stageRect && stageRect.height > 0) ? Math.floor(stageRect.height) : (canvas ? canvas.height : 270);

    const renderer = new CelestialFamiliarRenderer(canvas, {
        width: initialStageW,
        height: initialStageH
    });
    renderer.start();
    window.companionRenderer = renderer;

    requestAnimationFrame(() => {
        resizeMainCompanionCanvas();
    });
    window.addEventListener('resize', resizeMainCompanionCanvas);
    if (typeof ResizeObserver !== 'undefined' && creatureStage) {
        new ResizeObserver(() => resizeMainCompanionCanvas()).observe(creatureStage);
    }

    // 1b. Initialize Voice Controller & Wake-Word State Handlers
    function updateWakeWordBadge(info = {}) {
        const state = typeof info === 'string' ? info : (info.state || 'disabled');
        const err = info.error || '';
        const keyword = info.keyword || 'Hey Lucy';

        const updateElem = (badge) => {
            if (!badge) return;
            badge.removeAttribute('title');
            switch (state) {
                case 'disabled':
                    badge.textContent = 'Disabled';
                    badge.style.background = 'rgba(255, 255, 255, 0.08)';
                    badge.style.color = 'var(--text-dim)';
                    badge.style.border = '1px solid rgba(255, 255, 255, 0.12)';
                    badge.style.boxShadow = 'none';
                    break;
                case 'initializing':
                    badge.textContent = 'Initialising...';
                    badge.style.background = 'rgba(0, 242, 254, 0.15)';
                    badge.style.color = 'var(--accent-cyan)';
                    badge.style.border = '1px solid rgba(0, 242, 254, 0.4)';
                    badge.style.boxShadow = '0 0 6px rgba(0, 242, 254, 0.2)';
                    break;
                case 'listening':
                case 'listening_wake':
                    badge.textContent = 'Listening for "Hey Lucy"';
                    badge.style.background = 'rgba(0, 245, 212, 0.15)';
                    badge.style.color = 'var(--accent-green)';
                    badge.style.border = '1px solid rgba(0, 245, 212, 0.5)';
                    badge.style.boxShadow = '0 0 8px rgba(0, 245, 212, 0.25)';
                    break;
                case 'triggered':
                    badge.textContent = `"${keyword}" Detected!`;
                    badge.style.background = 'rgba(255, 209, 102, 0.25)';
                    badge.style.color = 'var(--accent-gold)';
                    badge.style.border = '1px solid rgba(255, 209, 102, 0.6)';
                    badge.style.boxShadow = '0 0 10px rgba(255, 209, 102, 0.4)';
                    break;
                case 'waiting_for_command':
                    badge.textContent = 'Waiting for Command...';
                    badge.style.background = 'rgba(255, 110, 199, 0.2)';
                    badge.style.color = 'var(--accent-pink)';
                    badge.style.border = '1px solid rgba(255, 110, 199, 0.5)';
                    badge.style.boxShadow = '0 0 8px rgba(255, 110, 199, 0.3)';
                    break;
                case 'processing_command':
                    badge.textContent = 'Processing Command...';
                    badge.style.background = 'rgba(157, 78, 221, 0.2)';
                    badge.style.color = 'var(--accent-purple)';
                    badge.style.border = '1px solid rgba(157, 78, 221, 0.5)';
                    badge.style.boxShadow = 'none';
                    break;
                case 'speaking':
                    badge.textContent = 'Speaking...';
                    badge.style.background = 'rgba(0, 245, 212, 0.15)';
                    badge.style.color = 'var(--accent-green)';
                    badge.style.border = '1px solid rgba(0, 245, 212, 0.5)';
                    badge.style.boxShadow = 'none';
                    break;
                case 'paused':
                    badge.textContent = 'Paused';
                    badge.style.background = 'rgba(255, 255, 255, 0.08)';
                    badge.style.color = 'var(--text-dim)';
                    badge.style.border = '1px solid rgba(255, 255, 255, 0.12)';
                    badge.style.boxShadow = 'none';
                    break;
                case 'standby':
                    badge.textContent = 'Standby';
                    badge.style.background = 'rgba(255, 255, 255, 0.08)';
                    badge.style.color = 'var(--text-dim)';
                    badge.style.border = '1px solid rgba(255, 255, 255, 0.12)';
                    badge.style.boxShadow = 'none';
                    break;
                case 'failed':
                case 'unavailable':
                    badge.textContent = 'Failed / Unavailable';
                    badge.style.background = 'rgba(255, 75, 75, 0.2)';
                    badge.style.color = 'var(--accent-red)';
                    badge.style.border = '1px solid rgba(255, 75, 75, 0.5)';
                    badge.style.boxShadow = 'none';
                    if (err) badge.title = `Microphone / Wake-Word Error: ${err}`;
                    break;
                default:
                    badge.textContent = state.toUpperCase();
                    badge.style.background = 'rgba(255, 255, 255, 0.08)';
                    badge.style.color = 'var(--text-dim)';
                    badge.style.boxShadow = 'none';
            }
        };

        const sideBadge = document.getElementById('wakeWordStatusBadge');
        const modalBadge = document.getElementById('modalWakeWordStatusBadge');
        updateElem(sideBadge);
        updateElem(modalBadge);
    }

    function syncWakeWordUI(enabled) {
        const checkWakeWord = document.getElementById('checkWakeWordActive');
        const settingWakeWord = document.getElementById('settingWakeWordEnabled');
        const optionsGroup = document.getElementById('wakeWordOptionsGroup');

        if (checkWakeWord) checkWakeWord.checked = Boolean(enabled);
        if (settingWakeWord) settingWakeWord.checked = Boolean(enabled);
        if (optionsGroup) optionsGroup.style.display = enabled ? 'flex' : 'none';
    }

    async function handleWakeWordToggle(isEnabled) {
        syncWakeWordUI(isEnabled);
        let actualSuccess = isEnabled;
        if (voiceController) {
            actualSuccess = voiceController.setWakeWordEnabled(isEnabled);
            if (isEnabled && !actualSuccess) {
                syncWakeWordUI(false);
                showBubble('Could not start wake-word: microphone is unavailable.');
                return;
            }
        }
        if (window.lucyIpc && typeof window.lucyIpc.setVoiceConfig === 'function') {
            await window.lucyIpc.setVoiceConfig({ wakeWordEnabled: isEnabled && actualSuccess });
        }
        showBubble(isEnabled ? 'Wake-word detection active: say "Hey Lucy".' : 'Wake-word detection disabled.');
    }

    let voiceController = null;
    if (typeof createVoiceController === 'function') {
        voiceController = createVoiceController({
            globalScope: window,
            continuousConversation: true,
            bargeInEnabled: true,
            enableVad: true,
            vadSensitivity: 'normal',
            onWakeWordStateChange: updateWakeWordBadge,
            onWakeWord: (result) => {
                const heardMsg = `Heard "${result.keyword}"! How can I help?`;
                showBubble(heardMsg);
                appendFeedEntry('Voice Activation', `Wake phrase detected: "${result.keyword}" (${(result.confidence * 100).toFixed(0)}% confidence).`, 'normal', 'Wake-Word');
                renderer.setVisualState({ emotion: 'listening' });
                if (voiceController && voiceController.ttsEnabled) {
                    voiceController.speak("I'm listening! How can I help?").catch(() => {});
                }
            },
            onStateChange: ({ voiceState, text }) => {
                if (voiceState === 'listening') {
                    if (micBtn) {
                        micBtn.classList.add('listening');
                        micBtn.classList.remove('processing');
                        micBtn.textContent = '🛑 Stop Mic';
                    }
                    statusLabel.textContent = 'LISTENING';
                    statusDot.style.background = 'var(--accent-pink)';
                    renderer.setVisualState({ emotion: 'listening' });
                    emotionLabel.textContent = 'Listening';
                    showBubble('Listening... Speak now!');
                } else if (voiceState === 'transcribing' || voiceState === 'processing') {
                    if (micBtn) {
                        micBtn.classList.remove('listening');
                        micBtn.classList.add('processing');
                        micBtn.textContent = '⏳ Transcribing...';
                    }
                    statusLabel.textContent = 'TRANSCRIBING';
                    statusDot.style.background = 'var(--accent-amber)';
                    renderer.setVisualState({ emotion: 'thinking' });
                    emotionLabel.textContent = 'Thinking';
                } else if (voiceState === 'understanding') {
                    statusLabel.textContent = 'UNDERSTANDING';
                    statusDot.style.background = 'var(--accent-purple)';
                    renderer.setVisualState({ emotion: 'thinking' });
                    emotionLabel.textContent = 'Thinking';
                } else if (voiceState === 'awaiting_confirmation') {
                    statusLabel.textContent = 'AWAITING APPROVAL';
                    statusDot.style.background = 'var(--accent-amber)';
                    renderer.setVisualState({ emotion: 'curious' });
                    emotionLabel.textContent = 'Awaiting Confirmation';
                } else if (voiceState === 'executing') {
                    statusLabel.textContent = 'EXECUTING';
                    statusDot.style.background = 'var(--accent-purple)';
                    renderer.setVisualState({ emotion: 'thinking' });
                    emotionLabel.textContent = 'Executing';
                } else if (voiceState === 'speaking') {
                    if (stopVoiceBtn) stopVoiceBtn.style.display = 'inline-block';
                    statusLabel.textContent = 'SPEAKING';
                    statusDot.style.background = 'var(--accent-green)';
                    if (renderer.state.emotion !== 'pet' && !String(renderer.state.emotion).startsWith('trick_')) {
                        renderer.setVisualState({ emotion: 'speaking' });
                    }
                    emotionLabel.textContent = 'Speaking';
                } else if (voiceState === 'cancelled') {
                    statusLabel.textContent = 'CANCELLED';
                    statusDot.style.background = 'var(--accent-amber)';
                    renderer.setVisualState({ emotion: 'idle' });
                    emotionLabel.textContent = 'Cancelled';
                } else if (voiceState === 'error') {
                    statusLabel.textContent = 'ERROR';
                    statusDot.style.background = 'var(--accent-red)';
                    renderer.setVisualState({ emotion: 'worried' });
                    emotionLabel.textContent = 'Error';
                } else if (voiceState === 'idle') {
                    if (micBtn) {
                        micBtn.classList.remove('listening', 'processing');
                        micBtn.textContent = '🎙️ Mic';
                    }
                    if (stopVoiceBtn) stopVoiceBtn.style.display = 'none';
                    if (['SPEAKING', 'LISTENING', 'PROCESSING', 'TRANSCRIBING', 'UNDERSTANDING', 'EXECUTING'].includes(statusLabel.textContent)) {
                        statusLabel.textContent = 'READY';
                        statusDot.style.background = 'var(--accent-cyan)';
                        if (renderer.state.emotion !== 'pet' && !String(renderer.state.emotion).startsWith('trick_')) {
                            renderer.setVisualState({ emotion: 'happy' });
                            emotionLabel.textContent = 'Happy';
                        }
                    }
                }

                // Forward voice state to floating companion if active
                if (window.lucyIpc && window.lucyIpc.sendVoiceState) {
                    window.lucyIpc.sendVoiceState({ voiceState, text });
                }
            },
            onInterimTranscript: (interimText) => {
                commandInput.value = interimText;
                showBubble(`"${interimText}"`);
            },
            onFinalTranscript: (finalText) => {
                const cleaned = (finalText || '').trim();
                commandInput.value = cleaned;
                if (micBtn) {
                    micBtn.classList.remove('listening', 'processing');
                    micBtn.textContent = '🎙️ Mic';
                }
                if (cleaned) {
                    handleCommand();
                } else {
                    const clarifyMsg = "I didn't catch that. Could you please repeat?";
                    showBubble(clarifyMsg);
                    appendFeedEntry('Voice Input', 'No speech detected or recording was unintelligible.', 'normal', 'Voice Prompt');
                    renderer.setVisualState({ emotion: 'curious' });
                    statusLabel.textContent = 'READY';
                    statusDot.style.background = 'var(--accent-cyan)';
                    if (voiceController && voiceController.ttsEnabled) {
                        voiceController.speak(clarifyMsg).catch(() => {});
                    }
                }
            },
            onError: (err) => {
                if (micBtn) {
                    micBtn.classList.remove('listening', 'processing');
                    micBtn.textContent = '🎙️ Mic';
                }
                appendFeedEntry(
                    'Audio Device Notice',
                    err.message || 'Microphone unavailable. Text mode is fully operational.',
                    'normal',
                    'Audio Fallback'
                );
                showBubble('Microphone unavailable; text chat is ready.');
                renderer.setVisualState({ emotion: 'curious' });
                statusLabel.textContent = 'READY';
                statusDot.style.background = 'var(--accent-cyan)';
            }
        });
        window.voiceController = voiceController;
        if (window.lucyIpc && typeof window.lucyIpc.getVoiceConfig === 'function') {
            window.lucyIpc.getVoiceConfig().then((res) => {
                if (res && res.config) {
                    if (voiceController) {
                        voiceController.setVoiceConfig(res.config);
                        if (res.config.wakeWordEnabled) {
                            voiceController.setWakeWordEnabled(true);
                        }
                    }
                    // Immediately synchronize DOM controls on startup so defaults do not overwrite saved state
                    const engine = res.config.ttsEngine || 'kokoro';
                    const selectEngine = document.getElementById('settingsTtsEngineSelect');
                    if (selectEngine) selectEngine.value = engine;
                    if (typeof updateEngineUiVisibility === 'function') {
                        updateEngineUiVisibility(engine);
                    }
                    const selectKokoroVoice = document.getElementById('settingsKokoroVoiceSelect');
                    if (selectKokoroVoice && res.config.kokoroVoice) {
                        selectKokoroVoice.value = res.config.kokoroVoice;
                    }
                    if (typeof refreshVoiceSettingsUI === 'function') {
                        refreshVoiceSettingsUI();
                    }
                }
            }).catch(() => {});
        }
    }

    // Voice UI listeners
    if (micBtn && voiceController) {
        micBtn.addEventListener('click', () => {
            if (voiceController.isListening) {
                voiceController.stopListening();
            } else {
                voiceController.startListening();
            }
        });
    }

    if (stopVoiceBtn && voiceController) {
        stopVoiceBtn.addEventListener('click', () => {
            voiceController.stopSpeaking();
            stopVoiceBtn.style.display = 'none';
            showBubble('Voice response stopped.');
            renderer.setVisualState({ emotion: 'happy' });
        });
    }

    if (toggleTtsBtn && voiceController) {
        toggleTtsBtn.addEventListener('click', () => {
            const isEnabled = voiceController.toggleTts();
            toggleTtsBtn.textContent = isEnabled ? '🔊 Voice: ON' : '🔇 Voice: OFF';
            toggleTtsBtn.style.color = isEnabled ? 'inherit' : 'var(--text-muted)';
            showBubble(isEnabled ? 'Spoken responses enabled.' : 'Spoken responses muted (text-only mode).');
            if (isEnabled) {
                voiceController.speak('Spoken responses enabled. Ready for instructions.').catch(() => {});
            }
        });
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && voiceController && voiceController.isSpeaking) {
            voiceController.stopSpeaking();
            if (stopVoiceBtn) stopVoiceBtn.style.display = 'none';
        }
    });

    // 2. Creature Pet Interactions & Trick Stunts
    const petManager = (typeof PetInteractionManager !== 'undefined')
        ? new PetInteractionManager()
        : (window.PetInteractionManager ? new window.PetInteractionManager() : null);

    function handlePetInteraction(customPhrase) {
        if (petManager && !petManager.canTriggerPet()) {
            return;
        }

        const phrase = customPhrase || (petManager ? petManager.getNextAffectionPhrase() : "Aww, that tickles! ✨");
        
        // 1. Play real visual pet reaction: heart burst, raised arms, happy curved eyes, blush
        renderer.setVisualState({ emotion: 'pet' });
        showBubble(phrase);

        // 2. Audible speech output strictly respecting user's voice setting
        if (voiceController && voiceController.ttsEnabled) {
            // Prevent audio overlap on rapid petting: cancel previous speech immediately
            voiceController.stopSpeaking();
            voiceController.speak(phrase).catch(() => {});
        }

        // 3. Forward visual state to floating companion if active
        if (window.lucyIpc && window.lucyIpc.sendVisualState) {
            window.lucyIpc.sendVisualState({ emotion: 'pet', speechBubble: phrase });
        }
    }

    if (canvas) {
        canvas.addEventListener('click', () => {
            handlePetInteraction();
        });
    }

    if (petBtn) {
        petBtn.addEventListener('click', () => {
            handlePetInteraction();
        });
    }

    // Main window trick stunts dropdown
    const trickMenuBtnMain = document.getElementById('trickMenuBtnMain');
    const trickDropdownMain = document.getElementById('trickDropdownMain');

    if (trickMenuBtnMain && trickDropdownMain) {
        trickMenuBtnMain.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = trickDropdownMain.style.display === 'block';
            trickDropdownMain.style.display = isVisible ? 'none' : 'block';
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#trickMenuBtnMain') && !e.target.closest('#trickDropdownMain')) {
                trickDropdownMain.style.display = 'none';
            }
        });

        const trickButtons = trickDropdownMain.querySelectorAll('.main-trick-opt');
        trickButtons.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const trickName = btn.getAttribute('data-trick');
                trickDropdownMain.style.display = 'none';
                if (trickName && typeof renderer.playTrick === 'function') {
                    renderer.playTrick(trickName);
                    const trickDef = petManager ? petManager.getTrick(trickName) : null;
                    const msg = trickDef ? trickDef.message : `Playing ${trickName}! ✨`;
                    showBubble(msg);

                    if (voiceController && voiceController.ttsEnabled) {
                        voiceController.stopSpeaking();
                        voiceController.speak(msg).catch(() => {});
                    }

                    if (window.lucyIpc && window.lucyIpc.playCompanionTrick) {
                        window.lucyIpc.playCompanionTrick(trickName).catch(() => {});
                    }
                }
            });
        });
    }

    // Listen for pet interactions originating from desktop floating companion
    if (window.lucyIpc && window.lucyIpc.onPetInteraction) {
        window.lucyIpc.onPetInteraction((data) => {
            // Guard: Never interrupt active safety confirmation prompts or permission dialogues
            const isAwaitingConfirmation = (permissionModal && permissionModal.classList.contains('active')) ||
                                           (voiceController && (voiceController.state === 'awaiting_confirmation' || voiceController.state === 'awaiting-confirmation')) ||
                                           (statusLabel && statusLabel.textContent === 'AWAITING APPROVAL');
            if (isAwaitingConfirmation) {
                return;
            }
            const phrase = data?.phrase || (petManager ? petManager.getNextAffectionPhrase() : "Aww, that tickles! ✨");
            if (voiceController && voiceController.ttsEnabled) {
                voiceController.stopSpeaking();
                voiceController.speakResponse(phrase).catch(() => {});
            }
        });
    }

    function syncDryRunUI() {
        if (toggleDryRunBtn) {
            toggleDryRunBtn.textContent = `Dry-Run: ${isDryRun ? 'ON' : 'OFF'}`;
            toggleDryRunBtn.style.color = isDryRun ? 'var(--accent-amber)' : 'inherit';
        }
        const toggleDryRunSettingsBtn = document.getElementById('toggleDryRunSettingsBtn');
        if (toggleDryRunSettingsBtn) {
            toggleDryRunSettingsBtn.textContent = `Dry-Run: ${isDryRun ? 'ON' : 'OFF'}`;
            toggleDryRunSettingsBtn.style.color = isDryRun ? 'var(--accent-amber)' : 'inherit';
            toggleDryRunSettingsBtn.style.borderColor = isDryRun ? 'rgba(255, 184, 0, 0.4)' : '';
        }
    }

    if (toggleDryRunBtn) {
        toggleDryRunBtn.addEventListener('click', () => {
            isDryRun = !isDryRun;
            syncDryRunUI();
            showBubble(isDryRun ? 'Dry-run active: tool executions will be simulated.' : 'Real execution mode active.');
        });
    }

    // 2b. Floating Fairy Companion Lifecycle Controller
    let isFairyTransitioning = false;
    let isFairyFloating = false;
    const inlineReturnBtn = document.getElementById('inlineReturnBtn');
    const inlineSummonBtn = document.getElementById('inlineSummonBtn');

    // Centralized Authoritative Companion UI Synchronization
    function syncCompanionUI(isFloating, options = {}) {
        isFairyFloating = Boolean(isFloating);

        // 1. Sidebar Primary Toggle Button
        if (toggleFloatingBtn) {
            toggleFloatingBtn.textContent = isFairyFloating ? '↩️ Dock Pet' : '🪟 Float Pet';
            toggleFloatingBtn.title = isFairyFloating ? 'Dock Lucy back into main application' : 'Float companion to desktop';
            toggleFloatingBtn.disabled = false;
            toggleFloatingBtn.classList.toggle('active', isFairyFloating);
        }

        // 2. Settings Companion Toggle Button
        const settingsToggleFloat = document.getElementById('settingsToggleFloatBtn');
        if (settingsToggleFloat) {
            settingsToggleFloat.textContent = isFairyFloating ? '↩️ Dock Pet to App' : '🪟 Float Pet to Desktop';
            settingsToggleFloat.title = isFairyFloating ? 'Dock Lucy back into main application' : 'Float companion to desktop';
            settingsToggleFloat.disabled = false;
            settingsToggleFloat.classList.toggle('active', isFairyFloating);
        }

        // 3. Embedded Creature Stage & Renderer Lifecycle
        if (creatureStage) {
            if (isFairyFloating) {
                creatureStage.classList.remove('fairy-flying-out', 'fairy-flying-in');
                creatureStage.classList.add('fairy-on-desktop');
                renderer.stop();
            } else {
                creatureStage.classList.remove('fairy-flying-out', 'fairy-flying-in', 'fairy-on-desktop');
                renderer.start();
                if (options.playLanding) {
                    renderer.setVisualState({ emotion: 'landing' });
                    showBubble("I'm back! Ready to assist. ✨");
                    if (typeof resizeMainCompanionCanvas === 'function') {
                        resizeMainCompanionCanvas();
                    }
                    if (voiceController && voiceController.ttsEnabled) {
                        voiceController.speak("I'm back! Ready to assist.").catch(() => {});
                    }
                    setTimeout(() => {
                        renderer.setVisualState({ emotion: 'happy' });
                    }, 500);
                }
            }
        }
    }

    async function floatFairyToDesktop() {
        if (isFairyTransitioning || isFairyFloating) return;
        isFairyTransitioning = true;
        if (toggleFloatingBtn) toggleFloatingBtn.disabled = true;
        const settingsToggleFloat = document.getElementById('settingsToggleFloatBtn');
        if (settingsToggleFloat) settingsToggleFloat.disabled = true;

        // 1. Fairy acknowledges and plays takeoff flight
        renderer.setVisualState({ emotion: 'takeoff' });
        showBubble('Taking flight to your desktop! ✨');
        if (voiceController && voiceController.ttsEnabled) {
            voiceController.speak("Taking flight to your desktop!").catch(() => {});
        }

        // 2. Animate embedded stage flight out
        if (creatureStage) {
            creatureStage.classList.add('fairy-flying-out');
        }

        await new Promise((r) => setTimeout(r, 400));

        // 3. Open desktop floating companion window via IPC
        if (window.lucyIpc && window.lucyIpc.toggleCompanionWindow) {
            await window.lucyIpc.toggleCompanionWindow({ action: 'float' });
        }

        // 4. Update authoritative UI state across all buttons & stage
        syncCompanionUI(true);
        isFairyTransitioning = false;
    }

    async function dockFairyToApp(options = {}) {
        if (isFairyTransitioning || !isFairyFloating) return;
        isFairyTransitioning = true;
        if (toggleFloatingBtn) toggleFloatingBtn.disabled = true;
        const settingsToggleFloat = document.getElementById('settingsToggleFloatBtn');
        if (settingsToggleFloat) settingsToggleFloat.disabled = true;

        // 1. Request floating window to return and hide if not already requested
        if (!options.alreadyDocked && window.lucyIpc && window.lucyIpc.toggleCompanionWindow) {
            await window.lucyIpc.toggleCompanionWindow({ action: 'dock' });
        }

        // 2. Prepare embedded stage for landing animation
        if (creatureStage) {
            creatureStage.classList.remove('fairy-on-desktop');
            creatureStage.classList.add('fairy-flying-in');
        }

        // 3. Wake up embedded renderer and play landing arrival
        renderer.start();
        renderer.setVisualState({ emotion: 'landing' });
        showBubble("I'm back! Ready to assist. ✨");
        if (typeof resizeMainCompanionCanvas === 'function') {
            resizeMainCompanionCanvas();
        }
        if (voiceController && voiceController.ttsEnabled) {
            voiceController.speak("I'm back! Ready to assist.").catch(() => {});
        }

        await new Promise((r) => setTimeout(r, 500));

        // 4. Update authoritative UI state across all buttons & stage
        syncCompanionUI(false);
        renderer.setVisualState({ emotion: 'happy' });
        isFairyTransitioning = false;
    }

    if (toggleFloatingBtn) {
        // Query initial status on startup
        if (window.lucyIpc && window.lucyIpc.getCompanionStatus) {
            window.lucyIpc.getCompanionStatus().then((res) => {
                if (res && typeof res.isOpen === 'boolean') {
                    syncCompanionUI(res.isOpen);
                }
            }).catch(() => {});
        }

        toggleFloatingBtn.addEventListener('click', async () => {
            if (isFairyFloating) {
                await dockFairyToApp();
            } else {
                await floatFairyToDesktop();
            }
        });

        if (inlineReturnBtn) {
            inlineReturnBtn.addEventListener('click', async () => {
                await dockFairyToApp();
            });
        }

        if (inlineSummonBtn) {
            inlineSummonBtn.addEventListener('click', async () => {
                if (window.lucyIpc && window.lucyIpc.summonCompanionWindow) {
                    await window.lucyIpc.summonCompanionWindow();
                    showBubble('Brought Lucy to the front! ✨');
                }
            });
        }

        if (window.lucyIpc && window.lucyIpc.onCompanionWindowToggled) {
            window.lucyIpc.onCompanionWindowToggled(async ({ isOpen, returning }) => {
                if (!isOpen) {
                    if (isFairyFloating) {
                        await dockFairyToApp({ alreadyDocked: Boolean(returning) });
                    } else {
                        syncCompanionUI(false, { playLanding: Boolean(returning) });
                    }
                } else if (isOpen) {
                    if (!isFairyFloating) {
                        syncCompanionUI(true);
                    }
                }
            });
        }
    }

    function showBubble(text) {
        if (!text) return;
        speechBubble.textContent = text;
        speechBubble.classList.add('visible');
        clearTimeout(speechBubble._timer);
        speechBubble._timer = setTimeout(() => {
            speechBubble.classList.remove('visible');
        }, 5000);
    }

    function appendFeedEntry(title, message, type = 'normal', meta = '') {
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.innerHTML = `
            <div class="log-meta">
                <span>${escapeHtml(title)}</span>
                <span>${escapeHtml(meta || new Date().toLocaleTimeString())}</span>
            </div>
            <div>${escapeHtml(message)}</div>
        `;
        taskFeed.appendChild(entry);
        taskFeed.scrollTop = taskFeed.scrollHeight;

        // Mirror execution step receipts to the Actions view timeline
        const actionsFeed = document.getElementById('actionsTimelineFeed');
        if (actionsFeed) {
            const emptyNotice = actionsFeed.querySelector('div[style*="text-align: center"]');
            if (emptyNotice) emptyNotice.remove();
            const actionEntry = document.createElement('div');
            actionEntry.className = `log-entry ${type}`;
            actionEntry.innerHTML = `
                <div class="log-meta">
                    <span>${escapeHtml(title)}</span>
                    <span>${escapeHtml(meta || new Date().toLocaleTimeString())}</span>
                </div>
                <div style="font-size: 11px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(message)}</div>
            `;
            actionsFeed.prepend(actionEntry);
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // 3. Streaming and Command Dispatch
    let currentActiveTaskId = null;
    let activeStreamingEntry = null;
    let streamingBuffer = '';
    let streamRenderRaf = null;

    if (window.lucyIpc && typeof window.lucyIpc.onStreamChunk === 'function') {
        window.lucyIpc.onStreamChunk(({ taskId, chunk }) => {
            if (!currentActiveTaskId || (taskId && taskId !== currentActiveTaskId)) return;
            streamingBuffer += chunk;
            if (!activeStreamingEntry) {
                activeStreamingEntry = document.createElement('div');
                activeStreamingEntry.className = 'log-entry normal';
                activeStreamingEntry.innerHTML = `
                    <div class="log-meta">
                        <span>Assistant (Streaming...)</span>
                        <span>${escapeHtml(new Date().toLocaleTimeString())}</span>
                    </div>
                    <div class="log-stream-content" style="white-space: pre-wrap; word-break: break-word;"></div>
                `;
                taskFeed.appendChild(activeStreamingEntry);
                taskFeed.scrollTop = taskFeed.scrollHeight;
                renderer.setVisualState({ emotion: 'thinking' });
            }

            if (!streamRenderRaf) {
                streamRenderRaf = requestAnimationFrame(() => {
                    if (activeStreamingEntry) {
                        const contentDiv = activeStreamingEntry.querySelector('.log-stream-content');
                        if (contentDiv) {
                            contentDiv.textContent = streamingBuffer;
                            taskFeed.scrollTop = taskFeed.scrollHeight;
                        }
                    }
                    streamRenderRaf = null;
                });
            }
        });
    }

    if (cancelStreamBtn) {
        cancelStreamBtn.addEventListener('click', async () => {
            if (currentActiveTaskId && window.lucyIpc && typeof window.lucyIpc.cancelRequest === 'function') {
                try {
                    await window.lucyIpc.cancelRequest(currentActiveTaskId);
                } catch {}
            }
            if (voiceController && voiceController.isSpeaking) {
                voiceController.stopSpeaking();
            }
            cancelStreamBtn.style.display = 'none';
            showBubble('Stopping active response...');
        });
    }

    let lastSubmittedText = '';
    let lastSubmittedTime = 0;

    if (window.lucyIpc && typeof window.lucyIpc.onTaskLifecycleEvent === 'function') {
        window.lucyIpc.onTaskLifecycleEvent((event) => {
            try {
                if (!event || !event.state) return;
                const state = event.state;
                if (state === 'planning') {
                    statusLabel.textContent = 'PLANNING';
                    statusDot.style.background = 'var(--accent-purple)';
                } else if (state === 'ready') {
                    statusLabel.textContent = 'READY TO EXECUTE';
                    statusDot.style.background = 'var(--accent-cyan)';
                } else if (state === 'executing_tool') {
                    const stepNum = event.detail?.step || '';
                    const total = event.detail?.totalSteps || '';
                    const tool = event.detail?.currentTool || '';
                    statusLabel.textContent = stepNum ? `EXECUTING (${stepNum}/${total}): ${tool}` : 'EXECUTING';
                    statusDot.style.background = 'var(--accent-amber)';
                } else if (state === 'verifying') {
                    statusLabel.textContent = 'VERIFYING';
                    statusDot.style.background = 'var(--accent-purple)';
                } else if (state === 'recovering') {
                    const attempt = event.detail?.attempt || 1;
                    statusLabel.textContent = `RECOVERING (${attempt})`;
                    statusDot.style.background = 'var(--accent-pink)';
                } else if (state === 'partially_completed') {
                    statusLabel.textContent = 'PARTIALLY COMPLETED';
                    statusDot.style.background = 'var(--accent-amber)';
                } else if (state === 'completed') {
                    statusLabel.textContent = 'COMPLETED';
                    statusDot.style.background = 'var(--accent-green)';
                } else if (state === 'cancelled') {
                    statusLabel.textContent = 'CANCELLED';
                    statusDot.style.background = 'var(--accent-amber)';
                } else if (state === 'failed') {
                    statusLabel.textContent = 'FAILED';
                    statusDot.style.background = 'var(--accent-red)';
                }
            } catch (err) {
                console.warn('[UI] Error handling task lifecycle event:', err.message);
            }
        });
    }

    async function handleCommand() {
        const text = commandInput.value.trim();
        if (!text) return;

        const now = Date.now();
        if (text === lastSubmittedText && (now - lastSubmittedTime) < 1000) {
            return;
        }
        if (currentActiveTaskId) {
            return;
        }
        lastSubmittedText = text;
        lastSubmittedTime = now;

        // Stop any active speech response when user sends a new command
        if (voiceController && voiceController.isSpeaking) {
            voiceController.stopSpeaking();
        }

        commandInput.value = '';

        // Expressive fairy trick commands
        const lower = text.toLowerCase().trim();
        const trickMatch = lower.match(/^(\/)?(spin|jump|fly|bounce)$/) ||
            lower.match(/^(do a spin|spin around|jump up|do a jump|fly around|bounce up)$/);
        if (trickMatch) {
            let trick = 'bounce';
            if (lower.includes('spin')) trick = 'spin';
            else if (lower.includes('jump')) trick = 'jump';
            else if (lower.includes('fly')) trick = 'fly';
            else if (lower.includes('bounce')) trick = 'bounce';

            if (typeof renderer.playTrick === 'function') {
                renderer.playTrick(trick);
            }
            if (window.lucyIpc && typeof window.lucyIpc.playCompanionTrick === 'function') {
                window.lucyIpc.playCompanionTrick(trick);
            }

            const replies = {
                spin: 'Twirl! 💫 Watch me spin through the stardust!',
                jump: 'Boing! 🦘 High fairy leap into the air!',
                fly: 'Swoosh! 🦋 Gliding on celestial gossamer wings!',
                bounce: 'Sparkle! ✨ Bouncing with celestial happiness!'
            };
            const reply = replies[trick] || 'Sparkle! ✨';
            showBubble(reply);
            appendFeedEntry('Fairy Trick', reply, 'normal', `Trick: ${trick}`);

            if (voiceController && voiceController.ttsEnabled) {
                voiceController.speak(reply);
            }

            statusLabel.textContent = 'READY';
            statusDot.style.background = 'var(--accent-cyan)';
            return;
        }

        appendFeedEntry('User Request', text, 'normal', 'Instruction');
        renderer.setVisualState({ emotion: 'thinking' });
        statusLabel.textContent = 'UNDERSTANDING';
        statusDot.style.background = 'var(--accent-purple)';
        if (window.lucyIpc && window.lucyIpc.sendVoiceState) {
            window.lucyIpc.sendVoiceState({ voiceState: 'understanding', text });
        }

        const taskId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        currentActiveTaskId = taskId;
        streamingBuffer = '';
        activeStreamingEntry = null;
        if (cancelStreamBtn) cancelStreamBtn.style.display = 'inline-block';

        try {
            let response;
            if (window.lucyIpc && typeof window.lucyIpc.executeRequest === 'function') {
                response = await window.lucyIpc.executeRequest(text, { dryRun: isDryRun, taskId });
            } else {
                response = await simulateLocalExecution(text, isDryRun);
            }

            await handleCoordinatorResponse(response);
        } catch (err) {
            if (activeStreamingEntry) {
                activeStreamingEntry.remove();
                activeStreamingEntry = null;
                streamingBuffer = '';
            }
            appendFeedEntry('Execution Error', err.message, 'error', 'Halted');
            renderer.setVisualState({ emotion: 'worried' });
            statusLabel.textContent = 'FAILED';
            statusDot.style.background = 'var(--accent-red)';
            if (window.lucyIpc && window.lucyIpc.sendVoiceState) {
                window.lucyIpc.sendVoiceState({ voiceState: 'error', text: err.message });
            }
            const errMsg = `I encountered an issue executing that command: ${err.message || 'Execution halted.'}`;
            showBubble(errMsg);
            if (voiceController && voiceController.ttsEnabled) {
                voiceController.speakResponse(errMsg).catch(() => {});
            }
        } finally {
            currentActiveTaskId = null;
            if (cancelStreamBtn) cancelStreamBtn.style.display = 'none';
        }
    }

    async function handleCoordinatorResponse(response) {
        if (cancelStreamBtn) cancelStreamBtn.style.display = 'none';

        if (response.status === 'cancelled') {
            if (activeStreamingEntry) {
                activeStreamingEntry.className = 'log-entry consequential';
                activeStreamingEntry.innerHTML = `
                    <div class="log-meta">
                        <span>Assistant (Cancelled)</span>
                        <span>${escapeHtml(new Date().toLocaleTimeString())}</span>
                    </div>
                    <div style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(streamingBuffer || 'Response generation cancelled.')} <em style="color: var(--accent-red);">[Stopped]</em></div>
                `;
                activeStreamingEntry = null;
                streamingBuffer = '';
            } else {
                appendFeedEntry('Task Cancelled', 'Request was cancelled before completion.', 'consequential', 'Stopped');
            }
            renderer.setVisualState({ emotion: 'curious' });
            statusLabel.textContent = 'CANCELLED';
            statusDot.style.background = 'var(--accent-amber)';
            if (window.lucyIpc && window.lucyIpc.sendVoiceState) {
                window.lucyIpc.sendVoiceState({ voiceState: 'cancelled' });
            }
            const cancelMsg = 'Response was cancelled.';
            showBubble(cancelMsg);
            if (voiceController && voiceController.ttsEnabled) {
                voiceController.speak(cancelMsg).catch(() => {});
            } else if (voiceController) {
                voiceController.setVoiceState('idle');
            }
            return;
        }

        if (!response.ok) {
            if (activeStreamingEntry) {
                activeStreamingEntry.remove();
                activeStreamingEntry = null;
                streamingBuffer = '';
            }
            const failReason = response.error || response.replyText || 'Execution stopped';
            appendFeedEntry('Task Failed', failReason, 'error', 'Verification Failed');
            renderer.setVisualState({ emotion: 'worried' });
            statusLabel.textContent = 'FAILED';
            statusDot.style.background = 'var(--accent-red)';
            const failSpeech = response.replyText || (response.error ? `I hit a snag: ${response.error}` : 'I hit a snag executing that task. Please review the activity log.');
            showBubble(failSpeech);
            if (voiceController && voiceController.ttsEnabled) {
                voiceController.speakResponse(failSpeech).catch(() => {});
            } else if (voiceController) {
                voiceController.setVoiceState('idle');
            }
            loadRoutingDiagnostics();
            return;
        }

        if (response.needsConfig) {
            if (activeStreamingEntry) {
                activeStreamingEntry.remove();
                activeStreamingEntry = null;
                streamingBuffer = '';
            }
            appendFeedEntry(
                'AI Provider Required',
                response.replyText,
                'consequential',
                'Configuration Notice'
            );
            renderer.setVisualState({ emotion: 'curious' });
            statusLabel.textContent = 'READY';
            statusDot.style.background = 'var(--accent-cyan)';
            showBubble('Configure a provider in Settings to enable reasoning.');
            const spokenNotice = response.spokenText || 'No AI provider is configured. Running in offline tool mode. You can configure a provider in Settings.';
            if (spokenNotice && voiceController && voiceController.ttsEnabled) {
                voiceController.speakResponse(spokenNotice);
            } else if (voiceController) {
                voiceController.setVoiceState('idle');
            }
            return;
        }

        // Render executed steps receipts
        if (response.executedSteps && response.executedSteps.length) {
            for (const step of response.executedSteps) {
                const verifiedTag = step.verified ? 'Verified ✓' : 'Unverified';
                const resultSnippet = step.result?.result ? JSON.stringify(step.result.result).slice(0, 180) : step.result?.status;
                appendFeedEntry(
                    `Step: ${step.title}`,
                    `Tool: ${step.toolId} | ${resultSnippet}`,
                    response.dryRun ? 'consequential' : 'normal',
                    verifiedTag
                );
            }
        }

        // Finalize streaming entry or add completed message
        const completedReply = response.replyText || streamingBuffer || (response.executedSteps && response.executedSteps.length ? 'All planned steps verified and completed!' : 'Task finished successfully.');
        if (activeStreamingEntry) {
            activeStreamingEntry.className = 'log-entry normal';
            activeStreamingEntry.innerHTML = `
                <div class="log-meta">
                    <span>Task Completed</span>
                    <span>Verified Complete</span>
                </div>
                <div style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(completedReply)}</div>
            `;
            activeStreamingEntry = null;
            streamingBuffer = '';
        } else {
            appendFeedEntry('Task Completed', completedReply, 'normal', 'Verified Complete');
        }

        renderer.setVisualState({ emotion: 'happy' });
        statusLabel.textContent = 'COMPLETED';
        statusDot.style.background = 'var(--accent-green)';
        showBubble(completedReply);

        if (completedReply && voiceController && voiceController.ttsEnabled) {
            voiceController.speakResponse(completedReply).catch(() => {});
        } else if (voiceController) {
            voiceController.setVoiceState('idle');
        }

        await refreshStatus();
        loadRoutingDiagnostics();
    }

    sendBtn.addEventListener('click', handleCommand);
    commandInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleCommand();
    });

    // 4. Permission Gate UI (IPC & Local)
    function promptPermission(request) {
        return new Promise((resolve) => {
            pendingPermissionResolve = resolve;
            permissionModalBody.innerHTML = `
                <div><strong>Tool:</strong> ${escapeHtml(request.toolId)} (${escapeHtml(request.action)})</div>
                <div style="margin-top: 6px;"><strong>Reason:</strong> ${escapeHtml(request.promptReason)}</div>
                <div style="margin-top: 6px; font-family: monospace; font-size: 11px; background: rgba(0,0,0,0.5); padding: 6px; border-radius: 4px;">
                    ${escapeHtml(JSON.stringify(request.params, null, 2))}
                </div>
            `;
            permissionModal.classList.add('active');
            renderer.setVisualState({ emotion: 'curious' });
            statusLabel.textContent = 'AWAITING APPROVAL';
            statusDot.style.background = 'var(--accent-amber)';
            if (window.lucyIpc && window.lucyIpc.sendVoiceState) {
                window.lucyIpc.sendVoiceState({ voiceState: 'awaiting_confirmation' });
            }
        });
    }

    if (window.lucyIpc && typeof window.lucyIpc.onPermissionRequest === 'function') {
        window.lucyIpc.onPermissionRequest(async (request) => {
            const approved = await promptPermission(request);
            window.lucyIpc.respondPermission(request.auditId, approved);
        });
    }

    approvePermissionBtn.addEventListener('click', () => {
        permissionModal.classList.remove('active');
        if (window.lucyIpc && window.lucyIpc.sendVoiceState) {
            window.lucyIpc.sendVoiceState({ voiceState: 'executing' });
        }
        if (pendingPermissionResolve) {
            pendingPermissionResolve(true);
            pendingPermissionResolve = null;
        }
    });

    denyPermissionBtn.addEventListener('click', () => {
        permissionModal.classList.remove('active');
        if (window.lucyIpc && window.lucyIpc.sendVoiceState) {
            window.lucyIpc.sendVoiceState({ voiceState: 'idle' });
        }
        if (pendingPermissionResolve) {
            pendingPermissionResolve(false);
            pendingPermissionResolve = null;
        }
    });

    // 5. Companion Visual Events from IPC
    if (window.lucyIpc && typeof window.lucyIpc.onVisualUpdate === 'function') {
        window.lucyIpc.onVisualUpdate((visualState) => {
            if (visualState.emotion) {
                renderer.setVisualState({ emotion: visualState.emotion });
                emotionLabel.textContent = visualState.emotion.charAt(0).toUpperCase() + visualState.emotion.slice(1);
            }
            if (visualState.speechBubble) {
                showBubble(visualState.speechBubble);
            }
        });
    }

    // 6. Multi-Provider AI Connection & Routing Management
    const defaultModels = {
        gemini: 'gemini-2.0-flash',
        openrouter: 'google/gemini-2.0-flash-001',
        groq: 'llama-3.3-70b-versatile',
        cerebras: 'llama3.1-8b',
        ollama: 'qwen2.5:1.5b',
        huggingface: 'meta-llama/Llama-3.2-3B-Instruct',
        'custom-openai': 'gpt-4o-mini'
    };

    // Tab Navigation for AI & Sub-Panels
    const settingsTabBtns = document.querySelectorAll('.settings-tab-btn, .settings-sub-tab-btn');
    const settingsTabContents = document.querySelectorAll('.settings-tab-content');

    function switchSettingsTab(targetTabId) {
        const idMapping = {
            connections: 'tabConnections',
            routing: 'tabRouting',
            diagnostics: 'tabDiagnostics',
            tabConnections: 'tabConnections',
            tabRouting: 'tabRouting',
            tabDiagnostics: 'tabDiagnostics'
        };
        const resolvedId = idMapping[targetTabId] || targetTabId;

        settingsTabBtns.forEach((btn) => {
            const tabAttr = btn.getAttribute('data-tab') || btn.getAttribute('data-ai-sub');
            const isTarget = (tabAttr === targetTabId || btn.getAttribute('data-tab') === resolvedId || btn.getAttribute('data-ai-sub') === targetTabId);
            btn.classList.toggle('active', isTarget);
            if (btn.classList.contains('settings-tab-btn')) {
                btn.style.background = isTarget ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255,255,255,0.05)';
                btn.style.borderColor = isTarget ? 'var(--accent-cyan)' : 'var(--bg-card-border)';
                btn.style.color = isTarget ? 'var(--accent-cyan)' : 'var(--text-muted)';
            }
        });

        settingsTabContents.forEach((content) => {
            content.style.display = (content.id === resolvedId) ? 'flex' : 'none';
        });

        if (resolvedId === 'tabConnections') {
            loadConnectionsList();
        } else if (resolvedId === 'tabRouting') {
            loadRoutingConfig();
        } else if (resolvedId === 'tabDiagnostics') {
            loadRoutingDiagnostics();
        }
    }

    settingsTabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-ai-sub') || btn.getAttribute('data-tab');
            if (tabId) switchSettingsTab(tabId);
        });
    });

    // Connections Management Elements
    const showAddConnBtn = document.getElementById('showAddConnBtn');
    const cancelAddConnBtn = document.getElementById('cancelAddConnBtn');
    const addConnectionForm = document.getElementById('addConnectionForm');
    const connProviderSelect = document.getElementById('connProviderSelect');
    const connLabelInput = document.getElementById('connLabelInput');
    const connApiKeyInput = document.getElementById('connApiKeyInput');
    const connModelInput = document.getElementById('connModelInput');
    const connPriorityInput = document.getElementById('connPriorityInput');
    const connBaseUrlInput = document.getElementById('connBaseUrlInput');
    const connFreeOnlyInput = document.getElementById('connFreeOnlyInput');
    const saveConnBtn = document.getElementById('saveConnBtn');
    const connApiKeyRow = document.getElementById('connApiKeyRow');
    const connBaseUrlRow = document.getElementById('connBaseUrlRow');
    const connModelList = document.getElementById('connModelList');
    const connectionsListContainer = document.getElementById('connectionsListContainer');

    function updateConnFormVisibility() {
        if (!connProviderSelect) return;
        const prov = connProviderSelect.value;
        if (prov === 'ollama') {
            if (connApiKeyRow) connApiKeyRow.style.display = 'none';
            if (connBaseUrlRow) connBaseUrlRow.style.display = 'flex';
            if (connBaseUrlInput && !connBaseUrlInput.value) connBaseUrlInput.value = 'http://127.0.0.1:11434';
        } else {
            if (connApiKeyRow) connApiKeyRow.style.display = 'flex';
            if (connBaseUrlRow) connBaseUrlRow.style.display = (prov === 'custom-openai') ? 'flex' : 'none';
        }
        if (connModelInput && !connModelInput.value) {
            connModelInput.value = defaultModels[prov] || '';
        }
    }

    if (connProviderSelect) {
        connProviderSelect.addEventListener('change', () => {
            if (connModelInput) connModelInput.value = defaultModels[connProviderSelect.value] || '';
            updateConnFormVisibility();
        });
    }

    if (showAddConnBtn && addConnectionForm) {
        showAddConnBtn.addEventListener('click', () => {
            addConnectionForm.style.display = 'flex';
            updateConnFormVisibility();
        });
    }

    if (cancelAddConnBtn && addConnectionForm) {
        cancelAddConnBtn.addEventListener('click', () => {
            addConnectionForm.style.display = 'none';
            if (connApiKeyInput) connApiKeyInput.value = '';
            if (connLabelInput) connLabelInput.value = '';
        });
    }

    if (saveConnBtn) {
        saveConnBtn.addEventListener('click', async () => {
            const provider = connProviderSelect.value;
            const label = connLabelInput.value.trim();
            const apiKey = connApiKeyInput.value.trim();
            const defaultModel = connModelInput.value.trim() || defaultModels[provider];
            const priority = parseInt(connPriorityInput.value, 10) || 10;
            const baseUrl = connBaseUrlInput ? connBaseUrlInput.value.trim() : '';
            const freeOnly = connFreeOnlyInput ? connFreeOnlyInput.checked : false;

            if (provider !== 'ollama' && !apiKey) {
                showBubble('API Key is required for hosted AI connections.');
                return;
            }

            saveConnBtn.disabled = true;
            saveConnBtn.textContent = 'Saving...';

            try {
                if (window.lucyIpc && typeof window.lucyIpc.saveConnection === 'function') {
                    const res = await window.lucyIpc.saveConnection({
                        provider,
                        label: label || undefined,
                        apiKey: apiKey || undefined,
                        defaultModel,
                        priority,
                        baseUrl: baseUrl || undefined,
                        freeOnly,
                        enabled: true
                    });

                    if (res && res.ok) {
                        appendFeedEntry('Connection Saved', `Saved connection '${label || provider}' securely via Windows DPAPI.`, 'normal', 'Key Configured');
                        showBubble(`Connection '${label || provider}' saved!`);
                        if (addConnectionForm) addConnectionForm.style.display = 'none';
                        if (connApiKeyInput) connApiKeyInput.value = '';
                        if (connLabelInput) connLabelInput.value = '';
                        await loadConnectionsList();
                        await refreshStatus();
                    } else {
                        showBubble(`Save failed: ${res.error || 'Unknown error'}`);
                    }
                }
            } catch (err) {
                showBubble(`Save error: ${err.message}`);
            } finally {
                saveConnBtn.disabled = false;
                saveConnBtn.textContent = 'Save Connection';
            }
        });
    }

    async function loadConnectionsList() {
        if (!connectionsListContainer) return;
        if (!window.lucyIpc || typeof window.lucyIpc.getConnectionList !== 'function') {
            connectionsListContainer.innerHTML = '<div style="font-size: 11px; color: var(--text-dim); text-align: center; padding: 20px;">Connections unavailable in preview mode.</div>';
            return;
        }

        try {
            const res = await window.lucyIpc.getConnectionList();
            if (!res || !res.ok || !Array.isArray(res.connections)) {
                connectionsListContainer.innerHTML = `<div style="font-size: 11px; color: var(--accent-red); padding: 10px;">Failed to load connections: ${escapeHtml(res?.error || 'Unknown')}</div>`;
                return;
            }

            const conns = res.connections;
            if (conns.length === 0) {
                connectionsListContainer.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 20px; background: rgba(0,0,0,0.15); border-radius: var(--radius-sm);">No AI connections configured yet. Click "+ Add Connection" above to configure your first provider key.</div>';
                return;
            }

            const statusColors = {
                connected: 'var(--accent-green)',
                unverified: 'var(--accent-cyan)',
                configured: 'var(--accent-cyan)',
                not_configured: 'var(--text-dim)',
                rate_limited: 'var(--accent-amber)',
                temporarily_unavailable: 'var(--accent-amber)',
                invalid_credential: 'var(--accent-red)',
                model_unavailable: 'var(--accent-amber)',
                policy_ineligible: 'var(--accent-red)',
                failed: 'var(--accent-red)',
                disabled: 'var(--text-dim)'
            };

            const statusLabels = {
                connected: '● Validated / Ready',
                unverified: '○ Unverified Key',
                configured: '○ Unverified Key',
                not_configured: '○ Not Configured',
                rate_limited: '● Rate Limited',
                temporarily_unavailable: '● Unreachable',
                invalid_credential: '● Invalid Key',
                model_unavailable: '● Model Unavailable',
                policy_ineligible: '● Ineligible (Paid)',
                failed: '● Request Failed',
                disabled: '○ Disabled'
            };

            connectionsListContainer.innerHTML = conns.map((c) => {
                const color = statusColors[c.state] || 'var(--text-dim)';
                const label = statusLabels[c.state] || c.state;
                const cooldownText = c.cooldownSecondsRemaining > 0 ? ` (${c.cooldownSecondsRemaining}s cooldown)` : '';
                const freeTag = c.freeOnly ? '<span style="font-size: 9px; padding: 2px 5px; border-radius: 3px; background: rgba(0,255,136,0.1); color: var(--accent-green); border: 1px solid rgba(0,255,136,0.3);">FREE ONLY</span>' : '';

                return `
                    <div class="connection-card" style="display: flex; flex-direction: column; gap: 6px; background: rgba(14, 20, 38, 0.7); border: 1px solid ${c.enabled ? 'var(--bg-card-border)' : 'rgba(255,255,255,0.06)'}; padding: 10px 12px; border-radius: var(--radius-sm); opacity: ${c.enabled ? '1' : '0.6'};">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <strong style="font-size: 12px; color: var(--accent-cyan); text-transform: uppercase;">${escapeHtml(c.provider)}</strong>
                                <span style="font-size: 12px; color: var(--text-main); font-weight: 600;">${escapeHtml(c.label || 'Default Connection')}</span>
                                ${freeTag}
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="font-size: 10px; font-weight: 700; color: ${color};">${escapeHtml(label)}${escapeHtml(cooldownText)}</span>
                                <span style="font-size: 10px; color: var(--text-dim); background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 3px;">P:${c.priority}</span>
                            </div>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted);">
                            <div style="display: flex; gap: 12px; align-items: center;">
                                <span>Model: <strong style="color: var(--text-dim);">${escapeHtml(c.defaultModel || 'auto')}</strong></span>
                                <span>Key: <code style="color: var(--text-dim);">${escapeHtml(c.maskedKey || (c.hasKey ? '••••••••' : 'No Key'))}</code></span>
                                ${c.lastError ? `<span style="color: var(--accent-red); font-size: 10px;" title="${escapeHtml(c.lastError)}">⚠ ${escapeHtml(c.lastError.slice(0, 35))}...</span>` : ''}
                            </div>
                            <div style="display: flex; gap: 6px; align-items: center;">
                                <button class="btn-cancel test-conn-btn" data-id="${escapeHtml(c.id)}" style="padding: 2px 8px; font-size: 10px; color: var(--accent-cyan); border-color: rgba(0,242,254,0.3);">Test</button>
                                <button class="btn-cancel toggle-conn-btn" data-id="${escapeHtml(c.id)}" data-enabled="${c.enabled}" style="padding: 2px 8px; font-size: 10px;">${c.enabled ? 'Disable' : 'Enable'}</button>
                                <button class="btn-cancel delete-conn-btn" data-id="${escapeHtml(c.id)}" data-label="${escapeHtml(c.label || c.provider)}" style="padding: 2px 8px; font-size: 10px; color: var(--accent-red); border-color: rgba(255,75,75,0.3);">Delete</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // Bind actions
            connectionsListContainer.querySelectorAll('.test-conn-btn').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const id = btn.getAttribute('data-id');
                    btn.disabled = true;
                    btn.textContent = 'Testing...';
                    try {
                        const testRes = await window.lucyIpc.testConnection(id);
                        if (testRes.ok) {
                            showBubble(`✓ Connected successfully: ${testRes.message || 'Healthy'}`);
                        } else {
                            showBubble(`✗ Connection test failed: ${testRes.error || testRes.code}`);
                        }
                        await loadConnectionsList();
                    } catch (err) {
                        showBubble(`Test error: ${err.message}`);
                    } finally {
                        btn.disabled = false;
                        btn.textContent = 'Test';
                    }
                });
            });

            connectionsListContainer.querySelectorAll('.toggle-conn-btn').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const id = btn.getAttribute('data-id');
                    const currentEnabled = btn.getAttribute('data-enabled') === 'true';
                    try {
                        await window.lucyIpc.updateConnection({ id, enabled: !currentEnabled });
                        await loadConnectionsList();
                        await refreshStatus();
                    } catch (err) {
                        showBubble(`Toggle failed: ${err.message}`);
                    }
                });
            });

            connectionsListContainer.querySelectorAll('.delete-conn-btn').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const id = btn.getAttribute('data-id');
                    const label = btn.getAttribute('data-label');
                    if (!confirm(`Delete connection '${label}' and its stored DPAPI key?`)) return;
                    try {
                        await window.lucyIpc.deleteConnection(id);
                        showBubble(`Deleted connection '${label}'`);
                        await loadConnectionsList();
                        await refreshStatus();
                    } catch (err) {
                        showBubble(`Delete failed: ${err.message}`);
                    }
                });
            });

        } catch (err) {
            connectionsListContainer.innerHTML = `<div style="font-size: 11px; color: var(--accent-red); padding: 10px;">Error: ${escapeHtml(err.message)}</div>`;
        }
    }

    // Routing Management Elements
    const routingModeSelect = document.getElementById('routingModeSelect');
    const routingModeDescription = document.getElementById('routingModeDescription');
    const manualOverrideGroup = document.getElementById('manualOverrideGroup');
    const manualProviderSelect = document.getElementById('manualProviderSelect');
    const manualModelInput = document.getElementById('manualModelInput');
    const taskOverrideReasoning = document.getElementById('taskOverrideReasoning');
    const taskOverrideCoding = document.getElementById('taskOverrideCoding');
    const taskOverrideVision = document.getElementById('taskOverrideVision');
    const taskOverrideLightweight = document.getElementById('taskOverrideLightweight');
    const policyFreeOnlyCheck = document.getElementById('policyFreeOnlyCheck');
    const saveRoutingConfigBtn = document.getElementById('saveRoutingConfigBtn');

    const routingModeDescriptions = {
        auto: 'Automatically routes requests to the best available eligible connection based on required capabilities (vision, tools, reasoning).',
        prefer_local: 'Attempts local Ollama execution first for privacy; falls back gracefully to free hosted models if local is offline.',
        local_only: 'Strictly executes locally via Ollama. 100% offline, zero network data egress. Incompatible requests fail honestly.',
        free_only: 'Strictly limits routing to confirmed free tiers. Guaranteed zero cost; never falls back to paid models.',
        manual: 'Forces all requests to the specified manual provider and model.'
    };

    if (routingModeSelect) {
        routingModeSelect.addEventListener('change', () => {
            const mode = routingModeSelect.value;
            if (routingModeDescription) {
                routingModeDescription.textContent = routingModeDescriptions[mode] || '';
            }
            if (manualOverrideGroup) {
                manualOverrideGroup.style.display = mode === 'manual' ? 'grid' : 'none';
            }
        });
    }

    async function loadRoutingConfig() {
        if (!window.lucyIpc || typeof window.lucyIpc.getRoutingConfig !== 'function') return;
        try {
            const res = await window.lucyIpc.getRoutingConfig();
            if (res && res.ok && res.config) {
                const c = res.config;
                if (routingModeSelect) routingModeSelect.value = c.mode || 'auto';
                if (routingModeDescription) routingModeDescription.textContent = routingModeDescriptions[c.mode || 'auto'] || '';
                if (manualOverrideGroup) manualOverrideGroup.style.display = c.mode === 'manual' ? 'grid' : 'none';
                if (manualProviderSelect && c.manualProvider) manualProviderSelect.value = c.manualProvider;
                if (manualModelInput && c.manualModel) manualModelInput.value = c.manualModel;
                if (policyFreeOnlyCheck) policyFreeOnlyCheck.checked = Boolean(c.freeOnly);

                const t = c.taskOverrides || {};
                if (taskOverrideReasoning) taskOverrideReasoning.value = t.reasoning?.model || '';
                if (taskOverrideCoding) taskOverrideCoding.value = t.coding?.model || '';
                if (taskOverrideVision) taskOverrideVision.value = t.vision?.model || '';
                if (taskOverrideLightweight) taskOverrideLightweight.value = t.lightweight?.model || '';
            }
        } catch (_) {}
    }

    if (saveRoutingConfigBtn) {
        saveRoutingConfigBtn.addEventListener('click', async () => {
            const mode = routingModeSelect.value;
            const freeOnly = policyFreeOnlyCheck ? policyFreeOnlyCheck.checked : true;
            const taskOverrides = {};

            if (taskOverrideReasoning && taskOverrideReasoning.value.trim()) {
                taskOverrides.reasoning = { model: taskOverrideReasoning.value.trim() };
            }
            if (taskOverrideCoding && taskOverrideCoding.value.trim()) {
                taskOverrides.coding = { model: taskOverrideCoding.value.trim() };
            }
            if (taskOverrideVision && taskOverrideVision.value.trim()) {
                taskOverrides.vision = { model: taskOverrideVision.value.trim() };
            }
            if (taskOverrideLightweight && taskOverrideLightweight.value.trim()) {
                taskOverrides.lightweight = { model: taskOverrideLightweight.value.trim() };
            }

            saveRoutingConfigBtn.disabled = true;
            saveRoutingConfigBtn.textContent = 'Saving...';

            try {
                if (window.lucyIpc && typeof window.lucyIpc.setRoutingConfig === 'function') {
                    await window.lucyIpc.setRoutingConfig({
                        mode,
                        freeOnly,
                        manualProvider: manualProviderSelect ? manualProviderSelect.value : undefined,
                        manualModel: manualModelInput ? manualModelInput.value.trim() : undefined,
                        taskOverrides
                    });
                    appendFeedEntry('Routing Policy Updated', `Global routing mode set to '${mode}'. Free-only: ${freeOnly}.`, 'normal', 'Policy Saved');
                    showBubble('AI Routing policy saved!');
                    await refreshStatus();
                }
            } catch (err) {
                showBubble(`Failed to save routing: ${err.message}`);
            } finally {
                saveRoutingConfigBtn.disabled = false;
                saveRoutingConfigBtn.textContent = 'Save Routing Policy';
            }
        });
    }

    // Diagnostics Elements
    const lastRouteDetails = document.getElementById('lastRouteDetails');
    const diagnosticsFeed = document.getElementById('diagnosticsFeed');
    const refreshDiagnosticsBtn = document.getElementById('refreshDiagnosticsBtn');

    async function loadRoutingDiagnostics() {
        if (!window.lucyIpc || typeof window.lucyIpc.getRoutingDiagnostics !== 'function') return;
        try {
            const res = await window.lucyIpc.getRoutingDiagnostics();
            if (res && res.ok) {
                if (lastRouteDetails) {
                    if (res.lastRoute) {
                        const r = res.lastRoute;
                        const labelPart = r.connectionLabel ? ` [${r.connectionLabel}]` : '';
                        lastRouteDetails.innerHTML = `
                            <span style="color: var(--accent-cyan); font-weight: 700;">${escapeHtml(r.provider)}</span> / 
                            <span>${escapeHtml(r.model)}</span>${escapeHtml(labelPart)} 
                            <span style="color: var(--text-dim); font-size: 10px; margin-left: 8px;">(${escapeHtml(r.reason || 'selected')})</span>
                            <div style="font-size: 10px; color: var(--text-dim); margin-top: 2px;">
                                Tokens: in=${r.usage?.promptTokens ?? '?'}, out=${r.usage?.completionTokens ?? '?'} • Cost: ${escapeHtml(r.cost?.amount != null ? '$' + r.cost.amount.toFixed(4) : (r.cost?.status || 'unknown'))}
                            </div>
                        `;
                    } else {
                        lastRouteDetails.textContent = 'No requests processed in this session yet.';
                    }
                }

                if (diagnosticsFeed) {
                    const events = res.events || [];
                    if (events.length === 0) {
                        diagnosticsFeed.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 10px;">No routing events recorded yet.</div>';
                    } else {
                        diagnosticsFeed.innerHTML = events.slice().reverse().map((ev) => {
                            const timeStr = new Date(ev.timestamp).toLocaleTimeString();
                            const isFail = ev.outcome === 'failed' || ev.outcome === 'no_route' || ev.fallbacks?.length > 0;
                            const outcomeColor = (ev.outcome === 'success' || ev.outcome === 'failover_success')
                                ? 'var(--accent-green)'
                                : (ev.outcome === 'no_route' ? 'var(--accent-red)' : (isFail ? 'var(--accent-amber)' : 'var(--text-main)'));
                            const fallbacksStr = ev.fallbacks && ev.fallbacks.length > 0
                                ? `<div style="color: var(--accent-amber); margin-top: 2px;">↳ Fallback attempts: ${ev.fallbacks.map((f) => `${escapeHtml(f.provider)} (${escapeHtml(f.reason)})`).join(' → ')}</div>`
                                : '';

                            const provDisplay = ev.provider ? escapeHtml(ev.provider) : (ev.outcome === 'no_route' ? 'No Eligible Route' : 'Unknown Provider');
                            const modelDisplay = ev.model && ev.model !== 'none' ? ` (${escapeHtml(ev.model)})` : '';
                            const reasonDisplay = escapeHtml(ev.reason || ev.error || 'No route available');

                            return `
                                <div style="border-bottom: 1px solid rgba(255,255,255,0.05); padding: 4px 0;">
                                    <div style="display: flex; justify-content: space-between;">
                                        <span style="color: var(--text-dim);">${escapeHtml(timeStr)}</span>
                                        <span style="color: ${outcomeColor}; font-weight: 700;">${escapeHtml(ev.outcome || 'routed')}</span>
                                    </div>
                                    <div style="color: var(--text-main);">
                                        <strong>${provDisplay}</strong>${modelDisplay} — <span style="color: var(--text-dim);">${reasonDisplay}</span>
                                    </div>
                                    ${fallbacksStr}
                                </div>
                            `;
                        }).join('');
                    }
                }
            }
        } catch (_) {}
    }

    if (refreshDiagnosticsBtn) {
        refreshDiagnosticsBtn.addEventListener('click', loadRoutingDiagnostics);
    }

    // Voice & System Configuration Handlers
    function populateVoiceOptions(selectedVoice = '') {
        if (!settingVoiceSelect) return;
        const synth = window.speechSynthesis;
        const voices = synth && typeof synth.getVoices === 'function' ? (synth.getVoices() || []) : [];
        settingVoiceSelect.innerHTML = '';

        const optDefault = document.createElement('option');
        optDefault.value = '';
        optDefault.textContent = 'Default (Kokoro-82M Bella — Soft & Natural Fairy)';
        if (!selectedVoice) optDefault.selected = true;
        settingVoiceSelect.appendChild(optDefault);

        const optBella = document.createElement('option');
        optBella.value = 'af_bella';
        optBella.textContent = 'Kokoro-82M — Bella (Soft, Warm & Natural Fairy)';
        if (selectedVoice === 'af_bella') optBella.selected = true;
        settingVoiceSelect.appendChild(optBella);

        const optSky = document.createElement('option');
        optSky.value = 'af_sky';
        optSky.textContent = 'Kokoro-82M — Sky (Bright, Ethereal & Melodic Fairy)';
        if (selectedVoice === 'af_sky') optSky.selected = true;
        settingVoiceSelect.appendChild(optSky);

        for (const v of voices) {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang || 'en'}) [Windows SAPI5]${v.default ? ' ★' : ''}`;
            if (v.name === selectedVoice) {
                opt.selected = true;
            }
            settingVoiceSelect.appendChild(opt);
        }
    }

    if (settingVoicePitch && voicePitchVal) {
        settingVoicePitch.addEventListener('input', () => {
            voicePitchVal.textContent = parseFloat(settingVoicePitch.value).toFixed(2);
            persistVoiceSettings();
        });
    }

    if (settingVoiceRate && voiceRateVal) {
        settingVoiceRate.addEventListener('input', () => {
            voiceRateVal.textContent = parseFloat(settingVoiceRate.value).toFixed(2);
            persistVoiceSettings();
        });
    }

    if (settingVoiceVolume && voiceVolumeVal) {
        settingVoiceVolume.addEventListener('input', () => {
            const vol = parseFloat(settingVoiceVolume.value);
            voiceVolumeVal.textContent = Math.round(vol * 100) + '%';
            if (voiceController && voiceController.synthesis) {
                voiceController.synthesis.setVoiceConfig({ volume: vol });
            }
            persistVoiceSettings();
        });
    }

    if (settingVoiceSelect) {
        settingVoiceSelect.addEventListener('change', () => {
            persistVoiceSettings();
        });
    }

    if (settingTtsEnabled) {
        settingTtsEnabled.addEventListener('change', () => {
            persistVoiceSettings();
        });
    }

    if (settingWakeWordEnabled) {
        settingWakeWordEnabled.addEventListener('change', () => {
            handleWakeWordToggle(settingWakeWordEnabled.checked);
        });
    }

    if (settingWakeWordSensitivity) {
        settingWakeWordSensitivity.addEventListener('input', () => {
            const val = parseFloat(settingWakeWordSensitivity.value) || 0.5;
            if (wakeWordSensitivityVal) {
                wakeWordSensitivityVal.textContent = val.toFixed(2);
            }
            if (voiceController) {
                voiceController.setWakeWordSensitivity(val);
            }
            persistVoiceSettings();
        });
    }

    async function persistVoiceSettings() {
        if (!window.lucyIpc || typeof window.lucyIpc.setVoiceConfig !== 'function') return;
        const selectEngineElem = document.getElementById('settingsTtsEngineSelect');
        const selectKokoroVoiceElem = document.getElementById('settingsKokoroVoiceSelect');
        const activeEngine = (selectEngineElem && selectEngineElem.value) ? selectEngineElem.value : (voiceController?.ttsEngine || 'kokoro');
        const activeKokoroVoice = (selectKokoroVoiceElem && selectKokoroVoiceElem.value) ? selectKokoroVoiceElem.value : (voiceController?.kokoroVoice || 'af_bella');
        const config = {
            voiceName: settingVoiceSelect ? settingVoiceSelect.value : '',
            ttsEngine: activeEngine,
            kokoroVoice: activeKokoroVoice,
            pitch: settingVoicePitch ? parseFloat(settingVoicePitch.value) : 1.05,
            rate: settingVoiceRate ? parseFloat(settingVoiceRate.value) : 1.02,
            volume: settingVoiceVolume ? parseFloat(settingVoiceVolume.value) : 1.0,
            ttsEnabled: settingTtsEnabled ? settingTtsEnabled.checked : true,
            wakeWordEnabled: settingWakeWordEnabled ? settingWakeWordEnabled.checked : false,
            wakeWordSensitivity: settingWakeWordSensitivity ? parseFloat(settingWakeWordSensitivity.value) : 0.5,
            continuousConversation: settingContinuousConversation ? settingContinuousConversation.checked : true,
            bargeInEnabled: settingBargeInEnabled ? settingBargeInEnabled.checked : true,
            vadSensitivity: settingVadSensitivity ? settingVadSensitivity.value : 'normal'
        };
        try {
            await window.lucyIpc.setVoiceConfig(config);
            if (voiceController) {
                voiceController.setVoiceConfig(config);
                if (config.continuousConversation !== undefined) {
                    voiceController.setContinuousConversation(config.continuousConversation);
                }
                if (config.bargeInEnabled !== undefined) {
                    voiceController.setBargeInEnabled(config.bargeInEnabled);
                }
                if (config.vadSensitivity !== undefined) {
                    voiceController.setVadSensitivity(config.vadSensitivity);
                }
                if (config.wakeWordSensitivity !== undefined) {
                    voiceController.setWakeWordSensitivity(config.wakeWordSensitivity);
                }
            }
        } catch (_) {}
    }

    if (previewVoiceBtn) {
        previewVoiceBtn.addEventListener('click', async () => {
            if (!voiceController) return;
            if (voiceController.isSpeaking) {
                voiceController.stopSpeaking();
                previewVoiceBtn.textContent = '▶ Preview';
                return;
            }
            const selectedVoice = settingVoiceSelect ? settingVoiceSelect.value : '';
            const pitch = settingVoicePitch ? parseFloat(settingVoicePitch.value) : 1.05;
            const rate = settingVoiceRate ? parseFloat(settingVoiceRate.value) : 1.02;
            const volume = settingVoiceVolume ? parseFloat(settingVoiceVolume.value) : 1.0;

            previewVoiceBtn.textContent = '⏳ Loading...';
            try {
                const phrase = 'Hello! I am Lucy, your celestial fairy companion. Ready to assist you!';
                await voiceController.speak(phrase, {
                    voiceName: selectedVoice,
                    voice: selectedVoice,
                    pitch,
                    rate,
                    volume,
                    isPreview: true,
                    force: true,
                    onStart: () => {
                        previewVoiceBtn.textContent = '⏹ Stop';
                    }
                });
            } catch (err) {
                previewVoiceBtn.textContent = '⚠️ Failed';
                setTimeout(() => { previewVoiceBtn.textContent = '▶ Preview'; }, 2000);
            } finally {
                if (previewVoiceBtn.textContent !== '⚠️ Failed') {
                    previewVoiceBtn.textContent = '▶ Preview';
                }
            }
        });
    }

    const resetVoiceDefaultsBtn = document.getElementById('resetVoiceDefaultsBtn');
    if (resetVoiceDefaultsBtn) {
        resetVoiceDefaultsBtn.addEventListener('click', async () => {
            if (settingVoicePitch) {
                settingVoicePitch.value = 1.05;
                if (voicePitchVal) voicePitchVal.textContent = '1.05';
            }
            if (settingVoiceRate) {
                settingVoiceRate.value = 1.02;
                if (voiceRateVal) voiceRateVal.textContent = '1.02';
            }
            if (settingVoiceVolume) {
                settingVoiceVolume.value = 1.0;
                if (voiceVolumeVal) voiceVolumeVal.textContent = '100%';
            }
            if (settingVoiceSelect) {
                settingVoiceSelect.value = '';
            }
            if (settingTtsEnabled) {
                settingTtsEnabled.checked = true;
            }
            await persistVoiceSettings();
            showBubble('Voice settings reset to defaults.');
        });
    }

    if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = () => {
            populateVoiceOptions(settingVoiceSelect ? settingVoiceSelect.value : '');
        };
    }

    function updateEngineUiVisibility(engine) {
        const kokoroContainer = document.getElementById('kokoroPersonaContainer');
        const sapi5Container = document.getElementById('sapi5VoiceContainer');
        if (engine === 'windows-speech') {
            if (kokoroContainer) kokoroContainer.style.display = 'none';
            if (sapi5Container) sapi5Container.style.display = 'flex';
        } else {
            if (kokoroContainer) kokoroContainer.style.display = 'flex';
            if (sapi5Container) sapi5Container.style.display = 'none';
        }
    }

    function updateAutomationModeUI(mode) {
        const automationTierTag = document.getElementById('automationTierTag');
        if (!automationTierTag) return;
        if (mode === 'foreground_required') {
            automationTierTag.textContent = 'FOREGROUND SIMULATION';
            automationTierTag.style.color = 'var(--accent-amber)';
            automationTierTag.style.borderColor = 'rgba(255, 184, 0, 0.3)';
            automationTierTag.style.background = 'rgba(255, 184, 0, 0.1)';
        } else {
            automationTierTag.textContent = 'NON-INTRUSIVE (TIER 1-3)';
            automationTierTag.style.color = 'var(--accent-green)';
            automationTierTag.style.borderColor = 'rgba(0, 245, 212, 0.3)';
            automationTierTag.style.background = 'rgba(0, 245, 212, 0.1)';
        }
    }

    function updateCloseActionTag(val) {
        const closeActionTag = document.getElementById('closeActionTag');
        if (!closeActionTag) return;
        if (val === 'background') {
            closeActionTag.textContent = 'Background Mode';
            closeActionTag.style.color = 'var(--accent-cyan)';
        } else if (val === 'minimize_to_tray') {
            closeActionTag.textContent = 'Tray Only';
            closeActionTag.style.color = 'var(--accent-purple)';
        } else if (val === 'exit') {
            closeActionTag.textContent = 'Direct Exit';
            closeActionTag.style.color = 'var(--accent-red)';
        }
    }

    async function refreshGeneralSettings() {
        if (window.lucyIpc && typeof window.lucyIpc.getAppSettings === 'function') {
            try {
                const appCfg = await window.lucyIpc.getAppSettings();
                if (appCfg && appCfg.settings) {
                    const action = appCfg.settings.closeAction || (appCfg.settings.backgroundMode ? 'background' : 'exit');
                    const settingCloseAction = document.getElementById('settingCloseAction');
                    if (settingCloseAction) settingCloseAction.value = action;
                    if (settingCloseActionModal) settingCloseActionModal.value = action;
                    updateCloseActionTag(action);

                    const checkBg = document.getElementById('checkBackgroundListening');
                    const isBgListening = Boolean(appCfg.settings.backgroundListening);
                    if (checkBg) checkBg.checked = isBgListening;
                    if (settingBackgroundListeningModal) settingBackgroundListeningModal.checked = isBgListening;

                    const autoMode = appCfg.settings.automationMode || 'non_intrusive';
                    const settingAutoMode = document.getElementById('settingAutomationMode');
                    if (settingAutoMode) settingAutoMode.value = autoMode;
                    updateAutomationModeUI(autoMode);
                }
            } catch (_) {}
        }

        if (lifecycleStateBadge && window.lucyIpc && typeof window.lucyIpc.getLifecycleState === 'function') {
            try {
                const ls = await window.lucyIpc.getLifecycleState();
                if (ls && ls.currentState) {
                    lifecycleStateBadge.textContent = ls.currentState.replace(/_/g, ' ').toUpperCase();
                }
            } catch (_) {}
        }
    }

    async function refreshVoiceSettingsUI() {
        if (!window.lucyIpc || typeof window.lucyIpc.getVoiceConfig !== 'function') {
            populateVoiceOptions();
            return;
        }

        try {
            const voiceRes = await window.lucyIpc.getVoiceConfig();
            if (voiceRes && voiceRes.config) {
                const vc = voiceRes.config;
                const engine = vc.ttsEngine || 'kokoro';
                const selectEngine = document.getElementById('settingsTtsEngineSelect');
                if (selectEngine) selectEngine.value = engine;
                updateEngineUiVisibility(engine);

                const selectKokoroVoice = document.getElementById('settingsKokoroVoiceSelect');
                if (selectKokoroVoice && vc.kokoroVoice) {
                    selectKokoroVoice.value = vc.kokoroVoice;
                }

                populateVoiceOptions(vc.voiceName || vc.preferredVoiceName || '');

                const rate = vc.rate ?? 1.0;
                const sliderRate = document.getElementById('sliderVoiceRate');
                if (sliderRate) sliderRate.value = rate;
                if (settingVoiceRate) settingVoiceRate.value = rate;
                const rateLabel = document.getElementById('rateLabelVal');
                if (rateLabel) rateLabel.textContent = `${Number(rate).toFixed(2)}x`;
                if (voiceRateVal) voiceRateVal.textContent = Number(rate).toFixed(2);

                const pitch = vc.pitch ?? 1.05;
                const sliderPitch = document.getElementById('sliderVoicePitch');
                if (sliderPitch) sliderPitch.value = pitch;
                if (settingVoicePitch) settingVoicePitch.value = pitch;
                const pitchLabel = document.getElementById('pitchLabelVal');
                if (pitchLabel) pitchLabel.textContent = `${Number(pitch).toFixed(2)}x`;
                if (voicePitchVal) voicePitchVal.textContent = Number(pitch).toFixed(2);

                const volume = vc.volume ?? 1.0;
                const sliderVol = document.getElementById('sliderVoiceVolume');
                if (sliderVol) sliderVol.value = volume;
                if (settingVoiceVolume) settingVoiceVolume.value = volume;
                const volLabel = document.getElementById('volumeLabelVal');
                if (volLabel) volLabel.textContent = `${Math.round(volume * 100)}%`;
                if (voiceVolumeVal) voiceVolumeVal.textContent = `${Math.round(volume * 100)}%`;

                const ttsCheck = document.getElementById('settingTtsEnabled');
                if (ttsCheck) ttsCheck.checked = vc.ttsEnabled !== false;

                const wakeActive = Boolean(vc.wakeWordEnabled);
                const checkWakeWord = document.getElementById('checkWakeWordActive');
                if (checkWakeWord) checkWakeWord.checked = wakeActive;
                if (settingWakeWordEnabled) settingWakeWordEnabled.checked = wakeActive;
                syncWakeWordUI(wakeActive);
                if (voiceController) {
                    voiceController.setVoiceConfig(vc);
                    if (wakeActive !== voiceController.wakeWordEngine?.enabled) {
                        voiceController.setWakeWordEnabled(wakeActive);
                    }
                }

                const wakeSens = vc.wakeWordSensitivity ?? 0.5;
                if (settingWakeWordSensitivity) settingWakeWordSensitivity.value = wakeSens;
                if (wakeWordSensitivityVal) wakeWordSensitivityVal.textContent = Number(wakeSens).toFixed(2);

                if (settingContinuousConversation && vc.continuousConversation !== undefined) {
                    settingContinuousConversation.checked = vc.continuousConversation !== false;
                }
                if (settingBargeInEnabled && vc.bargeInEnabled !== undefined) {
                    settingBargeInEnabled.checked = vc.bargeInEnabled !== false;
                }
                if (settingVadSensitivity && vc.vadSensitivity) {
                    settingVadSensitivity.value = vc.vadSensitivity;
                }
            } else {
                populateVoiceOptions();
            }
        } catch (_) {
            populateVoiceOptions();
        }
    }

    function switchSettingsCenterTab(targetTabId) {
        if (!targetTabId) targetTabId = 'general';
        const aliasMap = {
            general: 'general',
            system: 'general',
            companion: 'companion',
            pet: 'companion',
            floating: 'companion',
            viewCompanionSettings: 'companion',
            voice: 'voice',
            audio: 'voice',
            speech: 'voice',
            tts: 'voice',
            ai: 'ai',
            models: 'ai',
            connections: 'ai',
            routing: 'ai',
            diagnostics: 'ai',
            tabConnections: 'ai',
            tabRouting: 'ai',
            tabDiagnostics: 'ai',
            handsfree: 'handsfree',
            handsFree: 'handsfree',
            'hands-free': 'handsfree',
            wakeword: 'handsfree',
            vad: 'handsfree',
            memory: 'memory',
            privacy: 'memory',
            automation: 'automation',
            about: 'about',
            info: 'about'
        };

        const resolvedTab = aliasMap[targetTabId] || 'general';

        const tabBtns = document.querySelectorAll('.settings-center-tab-btn');
        tabBtns.forEach((btn) => {
            const btnTab = btn.getAttribute('data-settings-tab');
            const isActive = (btnTab === resolvedTab);
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        const panes = document.querySelectorAll('.settings-center-pane');
        panes.forEach((pane) => {
            const paneTab = pane.getAttribute('data-settings-tab');
            const isActive = (paneTab === resolvedTab);
            pane.classList.toggle('active', isActive);
        });

        const viewport = document.getElementById('settingsCenterViewport');
        if (viewport) {
            viewport.scrollTop = 0;
        }

        if (resolvedTab === 'ai') {
            if (targetTabId === 'routing' || targetTabId === 'tabRouting') {
                switchSettingsTab('tabRouting');
            } else if (targetTabId === 'diagnostics' || targetTabId === 'tabDiagnostics') {
                switchSettingsTab('tabDiagnostics');
            } else {
                switchSettingsTab('tabConnections');
            }
        }

        if (resolvedTab === 'general') {
            refreshGeneralSettings();
        } else if (resolvedTab === 'companion') {
            if (typeof window.refreshCompanionSettings === 'function') {
                window.refreshCompanionSettings();
            }
        } else if (resolvedTab === 'voice' || resolvedTab === 'handsfree') {
            refreshVoiceSettingsUI();
        } else if (resolvedTab === 'automation') {
            syncDryRunUI();
            refreshGeneralSettings();
        }
    }

    async function openSettings(targetCategory = 'general') {
        if (typeof switchJarvisView === 'function') {
            switchJarvisView('viewSettings');
        } else {
            const viewSettings = document.getElementById('viewSettings');
            if (viewSettings) {
                document.querySelectorAll('.jarvis-view').forEach((v) => v.classList.remove('active'));
                viewSettings.classList.add('active');
            }
            const tabSettings = document.getElementById('tabNavSettings');
            if (tabSettings) {
                document.querySelectorAll('.nav-deck-tab').forEach((t) => t.classList.remove('active'));
                tabSettings.classList.add('active');
            }
        }

        switchSettingsCenterTab(targetCategory || 'general');

        if (renderer && typeof renderer.setVisualState === 'function') {
            renderer.setVisualState({ emotion: 'curious' });
        }
    }

    function closeSettings() {
        if (settingsModal) {
            settingsModal.classList.remove('active');
        }
        if (typeof switchJarvisView === 'function') {
            switchJarvisView('viewHome');
        }
    }

    window.openSettings = openSettings;
    window.switchSettingsCenterTab = switchSettingsCenterTab;

    // Settings Center Tab Navigation Buttons
    document.querySelectorAll('.settings-center-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-settings-tab');
            if (tab) switchSettingsCenterTab(tab);
        });
    });

    const closeSettingsXBtn = document.getElementById('closeSettingsXBtn');
    if (closeSettingsXBtn) closeSettingsXBtn.addEventListener('click', closeSettings);
    if (hudSettingsBtn) hudSettingsBtn.addEventListener('click', () => openSettings('general'));
    if (sidebarSettingsBtn) sidebarSettingsBtn.addEventListener('click', () => openSettings('general'));
    if (cancelSettingsBtn) cancelSettingsBtn.addEventListener('click', closeSettings);

    const handleExitApp = () => {
        if (window.lucyIpc && typeof window.lucyIpc.exitApp === 'function') {
            window.lucyIpc.exitApp();
        }
    };
    if (explicitExitBtn) explicitExitBtn.addEventListener('click', handleExitApp);
    if (hudExitBtn) hudExitBtn.addEventListener('click', handleExitApp);
    const btnExplicitExitCompanion = document.getElementById('btnExplicitExitCompanion');
    if (btnExplicitExitCompanion) btnExplicitExitCompanion.addEventListener('click', handleExitApp);

    // General Settings Listeners
    const settingCloseAction = document.getElementById('settingCloseAction');
    if (settingCloseAction) {
        settingCloseAction.addEventListener('change', async () => {
            const val = settingCloseAction.value;
            updateCloseActionTag(val);
            if (settingCloseActionModal) settingCloseActionModal.value = val;
            if (window.lucyIpc && typeof window.lucyIpc.setAppSettings === 'function') {
                await window.lucyIpc.setAppSettings({
                    closeAction: val,
                    backgroundMode: val !== 'exit'
                });
            }
        });
    }

    const checkBackgroundListening = document.getElementById('checkBackgroundListening');
    if (checkBackgroundListening) {
        checkBackgroundListening.addEventListener('change', async () => {
            const val = checkBackgroundListening.checked;
            if (settingBackgroundListeningModal) settingBackgroundListeningModal.checked = val;
            if (window.lucyIpc && typeof window.lucyIpc.setAppSettings === 'function') {
                await window.lucyIpc.setAppSettings({
                    backgroundListening: val
                });
            }
        });
    }

    // Voice & Audio Settings Center Listeners
    const selectEngine = document.getElementById('settingsTtsEngineSelect');
    if (selectEngine) {
        selectEngine.addEventListener('change', () => {
            updateEngineUiVisibility(selectEngine.value);
            persistVoiceSettings();
        });
    }

    const selectKokoroVoice = document.getElementById('settingsKokoroVoiceSelect');
    if (selectKokoroVoice) {
        selectKokoroVoice.addEventListener('change', persistVoiceSettings);
    }

    const sliderVoiceRate = document.getElementById('sliderVoiceRate');
    if (sliderVoiceRate) {
        sliderVoiceRate.addEventListener('input', () => {
            const val = parseFloat(sliderVoiceRate.value);
            const rateLabel = document.getElementById('rateLabelVal');
            if (rateLabel) rateLabel.textContent = `${val.toFixed(2)}x`;
            if (voiceRateVal) voiceRateVal.textContent = val.toFixed(2);
            if (settingVoiceRate) settingVoiceRate.value = val;
            persistVoiceSettings();
        });
    }

    const sliderVoicePitch = document.getElementById('sliderVoicePitch');
    if (sliderVoicePitch) {
        sliderVoicePitch.addEventListener('input', () => {
            const val = parseFloat(sliderVoicePitch.value);
            const pitchLabel = document.getElementById('pitchLabelVal');
            if (pitchLabel) pitchLabel.textContent = `${val.toFixed(2)}x`;
            if (voicePitchVal) voicePitchVal.textContent = val.toFixed(2);
            if (settingVoicePitch) settingVoicePitch.value = val;
            persistVoiceSettings();
        });
    }

    const sliderVoiceVolume = document.getElementById('sliderVoiceVolume');
    if (sliderVoiceVolume) {
        sliderVoiceVolume.addEventListener('input', () => {
            const val = parseFloat(sliderVoiceVolume.value);
            const volLabel = document.getElementById('volumeLabelVal');
            if (volLabel) volLabel.textContent = `${Math.round(val * 100)}%`;
            if (voiceVolumeVal) voiceVolumeVal.textContent = `${Math.round(val * 100)}%`;
            if (settingVoiceVolume) settingVoiceVolume.value = val;
            if (voiceController && voiceController.synthesis) {
                voiceController.synthesis.setVoiceConfig({ volume: val });
            }
            persistVoiceSettings();
        });
    }

    // Hands-Free Settings Center Listeners
    const checkWakeWordActive = document.getElementById('checkWakeWordActive');
    if (checkWakeWordActive) {
        checkWakeWordActive.addEventListener('change', () => {
            handleWakeWordToggle(checkWakeWordActive.checked);
        });
    }

    if (settingWakeWordEnabled) {
        settingWakeWordEnabled.addEventListener('change', () => {
            handleWakeWordToggle(settingWakeWordEnabled.checked);
        });
    }

    if (settingWakeWordSensitivity && wakeWordSensitivityVal) {
        settingWakeWordSensitivity.addEventListener('input', () => {
            const val = parseFloat(settingWakeWordSensitivity.value) || 0.5;
            wakeWordSensitivityVal.textContent = val.toFixed(2);
            if (voiceController) {
                voiceController.setWakeWordSensitivity(val);
            }
            persistVoiceSettings();
        });
    }

    if (settingContinuousConversation) {
        settingContinuousConversation.addEventListener('change', persistVoiceSettings);
    }
    if (settingBargeInEnabled) {
        settingBargeInEnabled.addEventListener('change', persistVoiceSettings);
    }
    if (settingVadSensitivity) {
        settingVadSensitivity.addEventListener('change', persistVoiceSettings);
    }

    // Memory & Privacy Tab Listeners
    const btnOpenMemoryVaultModal = document.getElementById('btnOpenMemoryVaultModal');
    if (btnOpenMemoryVaultModal) {
        btnOpenMemoryVaultModal.addEventListener('click', () => {
            if (typeof openMemoryModal === 'function') {
                openMemoryModal('memories');
            }
        });
    }

    const settingsToggleLongTerm = document.getElementById('settingsToggleLongTerm');
    if (settingsToggleLongTerm) {
        settingsToggleLongTerm.addEventListener('change', async () => {
            if (toggleLongTermCheckbox) toggleLongTermCheckbox.checked = settingsToggleLongTerm.checked;
            if (window.lucyIpc && typeof window.lucyIpc.setMemoryRetention === 'function') {
                await window.lucyIpc.setMemoryRetention(settingsToggleLongTerm.checked);
            }
        });
    }

    const settingsExportMemoryBtn = document.getElementById('settingsExportMemoryBtn');
    if (settingsExportMemoryBtn) {
        settingsExportMemoryBtn.addEventListener('click', () => {
            const exportBtn = document.getElementById('exportMemoryBtn');
            if (exportBtn) exportBtn.click();
        });
    }

    const settingsImportMemoryBtn = document.getElementById('settingsImportMemoryBtn');
    if (settingsImportMemoryBtn) {
        settingsImportMemoryBtn.addEventListener('click', () => {
            const importBtn = document.getElementById('importMemoryBtn');
            if (importBtn) importBtn.click();
        });
    }

    const settingsClearWorkingDataBtn = document.getElementById('settingsClearWorkingDataBtn');
    if (settingsClearWorkingDataBtn) {
        settingsClearWorkingDataBtn.addEventListener('click', async () => {
            if (confirm('Purge all working data memories? User-approved and project memories will be preserved.')) {
                if (window.lucyIpc && typeof window.lucyIpc.clearWorkingMemories === 'function') {
                    await window.lucyIpc.clearWorkingMemories();
                    showBubble('Working data memories cleared.');
                    if (typeof loadMemories === 'function') loadMemories();
                } else {
                    showBubble('Working data cache purged.');
                }
            }
        });
    }

    // Automation Tab Listeners
    const settingAutomationMode = document.getElementById('settingAutomationMode');
    if (settingAutomationMode) {
        settingAutomationMode.addEventListener('change', async () => {
            const mode = settingAutomationMode.value;
            updateAutomationModeUI(mode);
            if (window.lucyIpc && typeof window.lucyIpc.setAppSettings === 'function') {
                await window.lucyIpc.setAppSettings({ automationMode: mode });
            }
            showBubble(`Automation mode set to ${mode === 'non_intrusive' ? 'Non-Intrusive' : 'Foreground Simulation'}.`);
        });
    }

    const toggleDryRunSettingsBtn = document.getElementById('toggleDryRunSettingsBtn');
    if (toggleDryRunSettingsBtn) {
        toggleDryRunSettingsBtn.addEventListener('click', () => {
            isDryRun = !isDryRun;
            syncDryRunUI();
            showBubble(isDryRun ? 'Dry-run active: tool executions will be simulated.' : 'Real execution mode active.');
        });
    }

    if (clearKeyBtn) {
        clearKeyBtn.addEventListener('click', async () => {
            const provider = settingProvider ? settingProvider.value : 'gemini';
            if (window.lucyIpc && typeof window.lucyIpc.clearApiKey === 'function') {
                await window.lucyIpc.clearApiKey(provider);
                if (settingApiKey) settingApiKey.value = '';
                appendFeedEntry('Secret Cleared', `Stored API key for ${provider} was securely deleted.`, 'consequential', 'DPAPI Removed');
                await refreshStatus();
            }
        });
    }

    // 7. Initial Status Refresh & Memory Metrics
    async function refreshStatus() {
        const homeStatusText = document.getElementById('homeStatusText');
        const homeActiveProvider = document.getElementById('homeActiveProvider');
        const homeLatencyMetric = document.getElementById('homeLatencyMetric');
        const homeTtsStatus = document.getElementById('homeTtsStatus');
        const homeHeroStatusTag = document.getElementById('homeHeroStatusTag');
        const homeHeroProvider = document.getElementById('homeHeroProvider');
        const modelKokoroStatus = document.getElementById('modelStatusKokoro');
        const modelWhisperStatus = document.getElementById('modelStatusWhisper');

        if (homeStatusText) homeStatusText.textContent = 'ONLINE / READY';
        if (homeHeroStatusTag) homeHeroStatusTag.textContent = 'ALL SYSTEMS NOMINAL';

        if (!window.lucyIpc || typeof window.lucyIpc.getSystemStatus !== 'function') {
            hudProvider.textContent = 'Gemini (Preview)';
            hudMemory.textContent = 'Desktop Ready';
            if (homeActiveProvider) homeActiveProvider.textContent = 'Gemini (Preview)';
            if (homeHeroProvider) homeHeroProvider.textContent = 'Gemini (Preview)';
            return;
        }

        try {
            const status = await window.lucyIpc.getSystemStatus();
            if (status.ok) {
                let keyLabel = '⚠ Not Configured';
                if (status.connectionState === 'connected') {
                    keyLabel = '✓ Validated';
                } else if (status.connectionState === 'invalid_credential') {
                    keyLabel = '✗ Invalid Key';
                } else if (status.connectionState === 'rate_limited') {
                    keyLabel = '⏳ Rate Limited';
                } else if (status.connectionState === 'temporarily_unavailable') {
                    keyLabel = '⚠ Unreachable';
                } else if (status.connectionState === 'unverified' || status.connectionState === 'configured') {
                    keyLabel = '○ Unverified Key';
                } else if (status.hasKey) {
                    keyLabel = '○ Unverified Key';
                }
                const labelPart = status.connectionLabel ? ` [${status.connectionLabel}]` : '';
                const modePart = status.routingMode ? ` · ${status.routingMode}` : '';
                const provStr = `${status.provider} (${status.model})${labelPart}${modePart}`;
                hudProvider.textContent = `${provStr} [${keyLabel}]`;
                hudPermission.textContent = `${status.permissionMode} (Gated)`;
                if (homeActiveProvider) homeActiveProvider.textContent = `${provStr} [${keyLabel}]`;
                if (homeHeroProvider) homeHeroProvider.textContent = `${provStr} [${keyLabel}]`;
            }
        } catch {
            // Keep default
        }

        // Check Kokoro-82M Local TTS Status
        if (window.lucyIpc && typeof window.lucyIpc.getKokoroStatus === 'function') {
            window.lucyIpc.getKokoroStatus().then((k) => {
                if (k && k.isAvailable) {
                    if (homeTtsStatus) homeTtsStatus.textContent = 'KOKORO-82M (LOCAL)';
                    if (modelKokoroStatus) {
                        modelKokoroStatus.textContent = k.isLoaded ? 'Loaded (In-Memory)' : 'Ready (On-Demand)';
                        modelKokoroStatus.style.color = 'var(--accent-green)';
                    }
                } else {
                    if (homeTtsStatus) homeTtsStatus.textContent = 'WINDOWS SAPI5';
                    if (modelKokoroStatus) {
                        modelKokoroStatus.textContent = 'Unavailable';
                        modelKokoroStatus.style.color = 'var(--accent-amber)';
                    }
                }
            }).catch(() => {});
        }

        // Check Whisper.cpp Offline STT Status
        if (window.lucyIpc && typeof window.lucyIpc.getWhisperStatus === 'function') {
            window.lucyIpc.getWhisperStatus().then((w) => {
                if (modelWhisperStatus) {
                    if (w && w.isAvailable) {
                        modelWhisperStatus.textContent = 'Available (Offline)';
                        modelWhisperStatus.style.color = 'var(--accent-green)';
                    } else {
                        modelWhisperStatus.textContent = 'Web Speech Mode';
                        modelWhisperStatus.style.color = 'var(--text-dim)';
                    }
                }
            }).catch(() => {});
        }

        try {
            if (window.lucyIpc && typeof window.lucyIpc.getMemorySummary === 'function') {
                const memSum = await window.lucyIpc.getMemorySummary();
                if (memSum && memSum.ok) {
                    const statusStr = memSum.longTermEnabled ? 'Active' : 'Disabled';
                    const count = (memSum.totalCount !== undefined ? memSum.totalCount : memSum.total) || 0;
                    hudMemory.textContent = `${count} Memories (${statusStr})`;
                }
            }
        } catch {
            hudMemory.textContent = 'Active (Protected)';
        }
    }

    // 8. Memory & Task Continuity Modal Controller
    function switchMemoryTab(tabName) {
        if (tabMemoriesBtn) tabMemoriesBtn.classList.toggle('active', tabName === 'memories');
        if (tabContinuityBtn) tabContinuityBtn.classList.toggle('active', tabName === 'continuity');
        if (tabProjectsBtn) tabProjectsBtn.classList.toggle('active', tabName === 'projects');
        if (tabAddMemoryBtn) tabAddMemoryBtn.classList.toggle('active', tabName === 'add');
        if (paneMemories) paneMemories.classList.toggle('active', tabName === 'memories');
        if (paneContinuity) paneContinuity.classList.toggle('active', tabName === 'continuity');
        if (paneProjects) paneProjects.classList.toggle('active', tabName === 'projects');
        if (paneAddMemory) paneAddMemory.classList.toggle('active', tabName === 'add');

        if (tabName === 'memories') loadMemories();
        if (tabName === 'continuity') loadInterruptedTasks();
        if (tabName === 'projects') loadProjectSnapshots();
    }

    async function loadProjectSnapshots() {
        if (!projectSnapshotsContainer) return;
        if (!window.lucyIpc || typeof window.lucyIpc.listProjects !== 'function') {
            projectSnapshotsContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 12px;">Project Snapshots unavailable in preview.</div>';
            return;
        }

        try {
            const listRes = await window.lucyIpc.listProjects();
            const projectIds = (listRes && listRes.ok) ? listRes.projects : [];

            if (projectIds.length === 0) {
                projectSnapshotsContainer.innerHTML = '<div style="color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px;">No project snapshots recorded yet. When working on projects, architectural choices and decisions will be maintained here.</div>';
                return;
            }

            projectSnapshotsContainer.innerHTML = '';
            for (const pid of projectIds) {
                const snapRes = await window.lucyIpc.getProjectSnapshot(pid);
                const snap = snapRes && snapRes.ok ? snapRes.snapshot : null;
                if (!snap) continue;

                const card = document.createElement('div');
                card.className = 'memory-card';
                card.innerHTML = `
                    <div class="memory-card-header">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="memory-badge project">${escapeHtml(snap.stage || 'project')}</span>
                            <strong style="font-size: 13px; color: var(--text-main);">${escapeHtml(snap.projectId)}</strong>
                        </div>
                        <span style="font-size: 11px; color: var(--text-dim);">${snap.updatedAt ? new Date(snap.updatedAt).toLocaleDateString() : ''}</span>
                    </div>
                    <div class="memory-content">
                        ${snap.objective ? `<div style="margin-bottom: 4px;"><strong>Objective:</strong> ${escapeHtml(snap.objective)}</div>` : ''}
                        ${snap.techStack ? `<div style="margin-bottom: 4px;"><strong>Tech Stack:</strong> ${escapeHtml(snap.techStack)}</div>` : ''}
                        ${snap.acceptedDecisions && snap.acceptedDecisions.length > 0 ? `<div style="margin-bottom: 4px;"><strong>Accepted Decisions:</strong> ${escapeHtml(snap.acceptedDecisions.join('; '))}</div>` : ''}
                        ${snap.outstandingTasks && snap.outstandingTasks.length > 0 ? `<div style="margin-bottom: 4px; color: var(--accent-cyan);"><strong>Tasks:</strong> ${escapeHtml(snap.outstandingTasks.join('; '))}</div>` : ''}
                    </div>
                    <div class="memory-footer">
                        <span>Status: ${escapeHtml(snap.verifiedStatus || 'active')}</span>
                    </div>
                `;
                projectSnapshotsContainer.appendChild(card);
            }
        } catch (err) {
            projectSnapshotsContainer.innerHTML = `<div style="color: var(--accent-red); font-size: 12px;">Failed to load project snapshots: ${escapeHtml(err.message)}</div>`;
        }
    }

    async function openMemoryModal(tab = 'memories') {
        if (!memoryModal) return;
        switchMemoryTab(tab);
        memoryModal.classList.add('active');
        renderer.setVisualState({ emotion: 'curious' });
    }

    function closeMemoryModal() {
        if (!memoryModal) return;
        memoryModal.classList.remove('active');
    }

    async function loadMemories() {
        if (!memoryListContainer) return;
        if (!window.lucyIpc || typeof window.lucyIpc.getMemories !== 'function') {
            memoryListContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 12px;">Memory IPC unavailable in standalone preview.</div>';
            return;
        }

        try {
            const summaryRes = await window.lucyIpc.getMemorySummary();
            if (summaryRes && summaryRes.ok && toggleLongTermCheckbox) {
                toggleLongTermCheckbox.checked = summaryRes.longTermEnabled;
            }

            const cat = currentMemoryCat === 'all' ? null : currentMemoryCat;
            const res = await window.lucyIpc.getMemories(cat);
            if (!res.ok) {
                memoryListContainer.innerHTML = `<div style="color: var(--accent-red); font-size: 12px;">Failed to load memories: ${escapeHtml(res.error)}</div>`;
                return;
            }

            let items = res.memories || [];
            const searchVal = (memorySearchInput ? memorySearchInput.value : '').trim().toLowerCase();
            if (searchVal) {
                items = items.filter(m => 
                    (m.key && m.key.toLowerCase().includes(searchVal)) ||
                    (m.content && m.content.toLowerCase().includes(searchVal))
                );
            }

            if (items.length === 0) {
                memoryListContainer.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px;">No memories found in this category.</div>`;
                return;
            }

            memoryListContainer.innerHTML = '';
            for (const m of items) {
                const card = document.createElement('div');
                card.className = 'memory-card';
                const conflictTag = m.hasConflict 
                    ? `<span class="memory-badge conflict" title="Conflicting information detected! Needs verification.">⚠️ Conflict</span>` 
                    : '';
                const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleDateString() + ' ' + new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                const sourceTag = m.source ? `<span style="font-size: 10px; color: var(--text-dim);">Source: ${escapeHtml(m.source)}</span>` : '';

                const displayTitle = m.key 
                    ? escapeHtml(m.key) 
                    : (m.category === 'conversation' 
                        ? (m.content.startsWith('User:') ? 'User Turn' : (m.content.startsWith('LUCY:') ? 'Assistant Response' : 'Conversation Record')) 
                        : escapeHtml(m.id));

                const typeBadge = m.type === 'confirmed_fact' 
                    ? '✓ Confirmed Fact' 
                    : (m.type === 'inferred_preference' 
                        ? 'Inferred Preference' 
                        : (m.category === 'conversation' ? 'Conversation Turn' : 'Active Memory'));

                card.innerHTML = `
                    <div class="memory-card-header">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="memory-badge ${escapeHtml(m.category)}">${escapeHtml(m.category)}</span>
                            <strong style="font-size: 13px; color: var(--text-main);">${displayTitle}</strong>
                            ${conflictTag}
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            ${sourceTag}
                            <span style="font-size: 11px; color: var(--text-dim);">${timeStr}</span>
                        </div>
                    </div>
                    <div class="memory-content">${escapeHtml(m.content)}</div>
                    <div class="memory-footer">
                        <span>${typeBadge}</span>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn-cancel edit-mem-btn" style="padding: 3px 8px; font-size: 11px;">✏️ Edit</button>
                            <button class="btn-cancel delete-mem-btn" style="padding: 3px 8px; font-size: 11px; color: var(--accent-red);">🗑️ Delete</button>
                        </div>
                    </div>
                `;

                // Wire edit button
                const editBtn = card.querySelector('.edit-mem-btn');
                editBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (editBtn.disabled) return;
                    const label = m.key || (m.category === 'conversation' ? 'conversation turn' : m.id);
                    const newContent = prompt(`Edit memory content for [${label}]:`, m.content);
                    if (newContent !== null && newContent.trim() && newContent !== m.content) {
                        editBtn.disabled = true;
                        editBtn.textContent = '⏳ Saving...';
                        try {
                            const upRes = await window.lucyIpc.updateMemory(m.id, newContent.trim());
                            if (upRes && upRes.ok) {
                                showBubble(`Memory updated.`);
                                await loadMemories();
                                await refreshStatus();
                            } else {
                                alert(`Failed to update: ${upRes ? upRes.error : 'Unknown error'}`);
                                editBtn.disabled = false;
                                editBtn.textContent = '✏️ Edit';
                            }
                        } catch (err) {
                            alert(`Failed to update: ${err.message}`);
                            editBtn.disabled = false;
                            editBtn.textContent = '✏️ Edit';
                        }
                    }
                });

                // Wire delete button
                const deleteBtn = card.querySelector('.delete-mem-btn');
                deleteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (deleteBtn.disabled) return;
                    const label = m.key 
                        ? `[${m.key}]` 
                        : (m.category === 'conversation' 
                            ? `conversation "${m.content.slice(0, 45)}..."` 
                            : `record "${(m.content || m.id).slice(0, 45)}..."`);

                    if (confirm(`Delete ${label} permanently?`)) {
                        deleteBtn.disabled = true;
                        deleteBtn.textContent = '⏳ Deleting...';
                        try {
                            const delRes = await window.lucyIpc.deleteMemory(m.id);
                            if (delRes && delRes.ok) {
                                showBubble(`Memory deleted successfully.`);
                                await loadMemories();
                                await refreshStatus();
                            } else {
                                alert(`Failed to delete: ${delRes ? delRes.error : 'Record not found'}`);
                                deleteBtn.disabled = false;
                                deleteBtn.textContent = '🗑️ Delete';
                            }
                        } catch (err) {
                            alert(`Failed to delete: ${err.message}`);
                            deleteBtn.disabled = false;
                            deleteBtn.textContent = '🗑️ Delete';
                        }
                    }
                });

                memoryListContainer.appendChild(card);
            }
        } catch (err) {
            memoryListContainer.innerHTML = `<div style="color: var(--accent-red); font-size: 12px;">Error: ${escapeHtml(err.message)}</div>`;
        }
    }

    async function loadInterruptedTasks() {
        if (!interruptedTasksList) return;
        if (!window.lucyIpc || typeof window.lucyIpc.getInterruptedTasks !== 'function') {
            interruptedTasksList.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 12px;">Task continuity unavailable in standalone preview.</div>';
            return;
        }

        try {
            const res = await window.lucyIpc.getInterruptedTasks();
            if (!res.ok) {
                interruptedTasksList.innerHTML = `<div style="color: var(--accent-red); font-size: 12px;">Failed: ${escapeHtml(res.error)}</div>`;
                return;
            }

            const tasks = res.interruptedTasks || [];
            if (tasks.length === 0) {
                interruptedTasksList.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px;">No interrupted tasks found. System state is clean.</div>`;
                return;
            }

            interruptedTasksList.innerHTML = '';
            for (const t of tasks) {
                const card = document.createElement('div');
                card.className = 'continuity-card';

                const totalSteps = (t.completedSteps ? t.completedSteps.length : 0) + (t.pendingSteps ? t.pendingSteps.length : 0);
                const completedCount = t.completedSteps ? t.completedSteps.length : 0;
                const hasConsequential = t.pendingSteps && t.pendingSteps.some(s => ['write_file', 'delete_file', 'browser_click', 'browser_fill', 'browser_submit'].includes(s.toolId));

                let stepsHtml = '';
                if (t.completedSteps && t.completedSteps.length > 0) {
                    for (const s of t.completedSteps) {
                        stepsHtml += `
                            <div class="continuity-step-item completed">
                                <span>✓ Step ${s.stepIndex + 1}: ${escapeHtml(s.title || s.toolId)}</span>
                                <span style="font-size: 10px; color: var(--accent-green);">Verified Completed</span>
                            </div>
                        `;
                    }
                }
                if (t.pendingSteps && t.pendingSteps.length > 0) {
                    for (const s of t.pendingSteps) {
                        const isConsequential = ['write_file', 'delete_file', 'browser_click', 'browser_fill', 'browser_submit'].includes(s.toolId);
                        stepsHtml += `
                            <div class="continuity-step-item pending ${isConsequential ? 'consequential' : ''}">
                                <span>⏳ Step ${s.stepIndex + 1}: ${escapeHtml(s.title || s.toolId)}</span>
                                <span style="font-size: 10px;">${isConsequential ? '⚠️ Consequential (Requires Auth)' : 'Pending'}</span>
                            </div>
                        `;
                    }
                }

                card.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong style="font-size: 14px; color: var(--accent-cyan);">${escapeHtml(t.description || t.taskId)}</strong>
                            <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">Task ID: ${escapeHtml(t.taskId)} • Status: <span style="color: var(--accent-amber);">${escapeHtml(t.status)}</span></div>
                        </div>
                        <div style="font-size: 12px; color: var(--text-muted);">
                            Progress: ${completedCount}/${totalSteps} steps completed
                        </div>
                    </div>
                    <div class="continuity-steps">
                        ${stepsHtml}
                    </div>
                    <div style="display: flex; justify-content: flex-end; gap: 8px;">
                        <button class="btn-cancel discard-task-btn" style="color: var(--accent-red); font-size: 12px; padding: 6px 14px;">🗑️ Discard</button>
                        <button class="btn-action resume-task-btn" style="font-size: 12px; padding: 6px 18px;">▶️ Resume Safely</button>
                    </div>
                `;

                // Wire Resume
                card.querySelector('.resume-task-btn').addEventListener('click', async () => {
                    if (hasConsequential) {
                        const ok = confirm(`Task "${t.description || t.taskId}" contains consequential pending actions (e.g. file operations). Do you authorize resuming and executing them?`);
                        if (!ok) return;
                    }
                    appendFeedEntry('Resuming Task', `Resuming interrupted task: ${t.description || t.taskId}`, 'normal', 'Continuity Recovery');
                    closeMemoryModal();
                    showBubble('Resuming interrupted task safely...');
                    renderer.setVisualState({ emotion: 'thinking' });

                    try {
                        const resumeRes = await window.lucyIpc.resumeTask(t.taskId, { interactiveConfirmation: true });
                        if (resumeRes.ok) {
                            appendFeedEntry('Task Resumed & Finished', `Result: ${resumeRes.replyText || 'All remaining steps completed.'}`, 'consequential', 'Recovery Complete');
                            showBubble('Interrupted task completed successfully! ✨');
                            renderer.setVisualState({ emotion: 'happy' });
                        } else {
                            appendFeedEntry('Resume Failed', resumeRes.error, 'consequential', 'Recovery Error');
                            showBubble('Task resume encountered an issue.');
                            renderer.setVisualState({ emotion: 'curious' });
                        }
                    } catch (err) {
                        appendFeedEntry('Resume Exception', err.message, 'consequential', 'Error');
                    }
                    await refreshStatus();
                });

                // Wire Discard
                card.querySelector('.discard-task-btn').addEventListener('click', async () => {
                    if (confirm(`Discard interrupted task checkpoint [${t.taskId}]?`)) {
                        const discRes = await window.lucyIpc.discardTask(t.taskId);
                        if (discRes.ok) {
                            showBubble('Interrupted task checkpoint discarded.');
                            await loadInterruptedTasks();
                        } else {
                            alert(`Failed to discard: ${discRes.error}`);
                        }
                    }
                });

                interruptedTasksList.appendChild(card);
            }
        } catch (err) {
            interruptedTasksList.innerHTML = `<div style="color: var(--accent-red); font-size: 12px;">Error: ${escapeHtml(err.message)}</div>`;
        }
    }

    // Modal listeners
    if (hudMemoryBtn) hudMemoryBtn.addEventListener('click', () => openMemoryModal('memories'));
    if (sidebarMemoryBtn) sidebarMemoryBtn.addEventListener('click', () => openMemoryModal('memories'));
    if (closeMemoryModalBtn) closeMemoryModalBtn.addEventListener('click', closeMemoryModal);
    if (tabMemoriesBtn) tabMemoriesBtn.addEventListener('click', () => switchMemoryTab('memories'));
    if (tabContinuityBtn) tabContinuityBtn.addEventListener('click', () => switchMemoryTab('continuity'));
    if (tabProjectsBtn) tabProjectsBtn.addEventListener('click', () => switchMemoryTab('projects'));
    if (tabAddMemoryBtn) tabAddMemoryBtn.addEventListener('click', () => switchMemoryTab('add'));

    // Export memories to JSON
    if (exportMemoryBtn) {
        exportMemoryBtn.addEventListener('click', async () => {
            if (!window.lucyIpc || typeof window.lucyIpc.exportMemory !== 'function') {
                alert('Export not available in preview mode.');
                return;
            }
            try {
                const res = await window.lucyIpc.exportMemory();
                if (res && res.ok && res.data) {
                    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `lucy-memory-export-${new Date().toISOString().slice(0, 10)}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showBubble('Persistent memories exported to JSON.');
                } else {
                    alert(`Export failed: ${res.error || 'Unknown error'}`);
                }
            } catch (err) {
                alert(`Export error: ${err.message}`);
            }
        });
    }

    // Import memories from JSON
    if (importMemoryBtn && memoryFileInput) {
        importMemoryBtn.addEventListener('click', () => {
            memoryFileInput.value = '';
            memoryFileInput.click();
        });

        memoryFileInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (evt) => {
                try {
                    const parsed = JSON.parse(evt.target.result);
                    if (!window.lucyIpc || typeof window.lucyIpc.importMemory !== 'function') {
                        alert('Import not available in preview mode.');
                        return;
                    }
                    const merge = confirm('Merge with existing memories? Click OK to merge, or Cancel to replace current memories.');
                    const res = await window.lucyIpc.importMemory(parsed, { merge });
                    if (res && res.ok) {
                        showBubble(`Successfully imported ${res.importedCount || 0} memories.`);
                        await loadMemories();
                        await refreshStatus();
                    } else {
                        alert(`Import failed: ${res.error || 'Invalid format'}`);
                    }
                } catch (err) {
                    alert(`Failed to parse JSON file: ${err.message}`);
                }
            };
            reader.readAsText(file);
        });
    }

    // Long-Term memory toggle
    if (toggleLongTermCheckbox) {
        toggleLongTermCheckbox.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            if (window.lucyIpc && typeof window.lucyIpc.toggleLongTermMemory === 'function') {
                await window.lucyIpc.toggleLongTermMemory(enabled);
                showBubble(enabled ? 'Long-term memory enabled.' : 'Long-term memory disabled.');
                await refreshStatus();
            }
        });
    }

    // Category pills filter
    catPills.forEach(pill => {
        pill.addEventListener('click', () => {
            catPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentMemoryCat = pill.dataset.cat;
            loadMemories();
        });
    });

    // Search filter
    if (memorySearchInput) {
        memorySearchInput.addEventListener('input', () => {
            loadMemories();
        });
    }

    // Clear category
    if (clearCategoryBtn) {
        clearCategoryBtn.addEventListener('click', async () => {
            if (currentMemoryCat === 'all') {
                alert('Please select a specific category pill to clear.');
                return;
            }
            if (confirm(`Clear all memories in category [${currentMemoryCat}]?`)) {
                if (window.lucyIpc && typeof window.lucyIpc.clearMemoryCategory === 'function') {
                    const clrRes = await window.lucyIpc.clearMemoryCategory(currentMemoryCat);
                    if (clrRes.ok) {
                        showBubble(`Category [${currentMemoryCat}] cleared.`);
                        await loadMemories();
                        await refreshStatus();
                    } else {
                        alert(`Failed to clear: ${clrRes.error}`);
                    }
                }
            }
        });
    }

    // Explicit Memory form
    if (addMemoryCategory) {
        addMemoryCategory.addEventListener('change', () => {
            if (workingDataTtlGroup) {
                workingDataTtlGroup.style.display = addMemoryCategory.value === 'working_data' ? 'flex' : 'none';
            }
        });
    }

    if (saveExplicitMemoryBtn) {
        saveExplicitMemoryBtn.addEventListener('click', async () => {
            const category = addMemoryCategory.value;
            const key = addMemoryKey.value.trim();
            const content = addMemoryContent.value.trim();
            const ttlMs = category === 'working_data' ? parseInt(addMemoryTtl.value, 10) : undefined;

            if (!key) {
                alert('Please provide a key / label for the memory.');
                return;
            }
            if (!content) {
                alert('Please provide memory content.');
                return;
            }

            if (window.lucyIpc && typeof window.lucyIpc.addMemory === 'function') {
                const addRes = await window.lucyIpc.addMemory({
                    category,
                    key,
                    content,
                    source: 'user_explicit',
                    confirmed: true,
                    ttlMs
                });
                if (addRes.ok) {
                    showBubble(`Memory [${key}] saved successfully!`);
                    addMemoryKey.value = '';
                    addMemoryContent.value = '';
                    switchMemoryTab('memories');
                    await loadMemories();
                    await refreshStatus();
                } else {
                    alert(`Failed to save memory: ${addRes.error}`);
                }
            }
        });
    }

    // 9. Futuristic JARVIS Navigation Deck Controller
    function initJarvisNavigationDeck() {
        const tabs = document.querySelectorAll('.nav-deck-tab');
        const views = document.querySelectorAll('.jarvis-view');

        function switchView(targetViewId) {
            let actualViewId = targetViewId;
            let targetSettingsCategory = null;

            if (targetViewId === 'viewCompanionSettings') {
                actualViewId = 'viewSettings';
                targetSettingsCategory = 'companion';
            } else if (targetViewId === 'viewSettings') {
                // If opening viewSettings directly and no settings tab is active, default to general
            }

            tabs.forEach((tab) => {
                const view = tab.getAttribute('data-view') || tab.getAttribute('data-target-view');
                const isMatch = (view === targetViewId || view === actualViewId || 
                    (targetViewId === 'viewCompanionSettings' && (view === 'viewSettings' || tab.id === 'tabNavSettings')));
                tab.classList.toggle('active', isMatch);
                tab.setAttribute('aria-selected', isMatch ? 'true' : 'false');
            });
            views.forEach((v) => {
                v.classList.toggle('active', v.id === actualViewId);
            });
            const viewport = document.getElementById('jarvisViewsViewport');
            if (viewport) {
                viewport.scrollTop = 0;
            }
            if (actualViewId === 'viewSettings') {
                if (targetSettingsCategory) {
                    if (typeof switchSettingsCenterTab === 'function') {
                        switchSettingsCenterTab(targetSettingsCategory);
                    }
                } else {
                    const currentActive = document.querySelector('.settings-center-pane.active');
                    if (!currentActive && typeof switchSettingsCenterTab === 'function') {
                        switchSettingsCenterTab('general');
                    }
                }
            }
            if (targetViewId === 'viewIntelligence' && typeof loadRoutingDiagnostics === 'function') {
                loadRoutingDiagnostics();
            }
            if ((targetViewId === 'viewCompanionSettings' || targetSettingsCategory === 'companion') && typeof window.refreshCompanionSettings === 'function') {
                window.refreshCompanionSettings();
            }
        }

        switchJarvisView = switchView;
        window.switchJarvisView = switchView;

        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const target = tab.getAttribute('data-view') || tab.getAttribute('data-target-view');
                if (target) switchView(target);
            });
        });

        // Quick Command Portals on View 1 (Home)
        const portalConv = document.getElementById('portalConversationBtn');
        if (portalConv) {
            portalConv.addEventListener('click', () => {
                switchView('viewConversation');
                if (commandInput) commandInput.focus();
            });
        }

        const portalMem = document.getElementById('portalMemoryBtn');
        if (portalMem) {
            portalMem.addEventListener('click', () => {
                openMemoryModal('memories');
            });
        }

        const portalIntel = document.getElementById('portalIntelligenceBtn');
        if (portalIntel) {
            portalIntel.addEventListener('click', () => {
                switchView('viewIntelligence');
            });
        }

        const portalFloat = document.getElementById('portalFloatPetBtn');
        if (portalFloat) {
            portalFloat.addEventListener('click', async () => {
                if (typeof floatFairyToDesktop === 'function') {
                    await floatFairyToDesktop();
                }
            });
        }

        const intelOpenSettings = document.getElementById('intelOpenSettingsBtn');
        if (intelOpenSettings) {
            intelOpenSettings.addEventListener('click', () => {
                openSettings('ai');
            });
        }

        const clearFeedViewBtn = document.getElementById('clearFeedViewBtn');
        if (clearFeedViewBtn) {
            clearFeedViewBtn.addEventListener('click', () => {
                const feed = document.getElementById('actionsTimelineFeed');
                if (feed) {
                    feed.innerHTML = '<div style="font-size: 11px; color: var(--text-dim); text-align: center; padding: 20px;">Receipt timeline cleared.</div>';
                }
            });
        }
    }

    // 10. Futuristic Audio-Reactive Visualizer (Spectrum / Horizon)
    function initAudioVisualizer() {
        const canvas = document.getElementById('audioVisualizerCanvas');
        const statusText = document.getElementById('vizStatusText');
        const pulseDot = document.getElementById('vizPulseDot');
        const engineTag = document.getElementById('vizEngineTag');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        let wavePhase = 0;

        const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        function renderFrame() {
            const width = canvas.width;
            const height = canvas.height;
            ctx.clearRect(0, 0, width, height);

            const isSpeaking = voiceController && voiceController.isSpeaking;
            const isListening = voiceController && voiceController.isListening;
            const isProcessing = voiceController && voiceController.voiceState === 'processing';

            if (engineTag && voiceController) {
                engineTag.textContent = voiceController.ttsEngine === 'kokoro' ? 'KOKORO-82M NEURAL' : 'WINDOWS SAPI5';
            }

            if (isSpeaking) {
                if (statusText) statusText.textContent = 'SPEAKING (KOKORO-82M)';
                if (pulseDot) pulseDot.style.background = 'var(--accent-cyan)';

                if (prefersReducedMotion) {
                    ctx.fillStyle = '#00f2fe';
                    ctx.fillRect(width * 0.2, height / 2 - 2, width * 0.6, 4);
                } else {
                    const freqData = voiceController.getAudioFrequencyData();
                    const bars = 36;
                    const barWidth = 6;
                    const spacing = (width - (bars * barWidth)) / (bars - 1);

                    wavePhase += 0.15;
                    for (let i = 0; i < bars; i++) {
                        let magnitude = 0.3;
                        if (freqData && freqData.length > 0) {
                            const binIndex = Math.floor((i / bars) * freqData.length);
                            magnitude = (freqData[binIndex] || 0) / 255;
                        } else {
                            magnitude = (Math.sin(wavePhase + i * 0.4) * 0.35 + 0.45) * (Math.cos(wavePhase * 0.6 + i * 0.2) * 0.3 + 0.6);
                        }

                        const barHeight = Math.max(3, magnitude * (height - 6));
                        const x = i * (barWidth + spacing);
                        const y = (height - barHeight) / 2;

                        const grad = ctx.createLinearGradient(x, y, x, y + barHeight);
                        grad.addColorStop(0, '#00f2fe');
                        grad.addColorStop(1, '#9d4edd');
                        ctx.fillStyle = grad;
                        ctx.fillRect(x, y, barWidth, barHeight);

                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(x, y, barWidth, 1.5);
                    }
                }
            } else if (isListening) {
                if (statusText) statusText.textContent = 'LISTENING (MICROPHONE)';
                if (pulseDot) pulseDot.style.background = 'var(--accent-pink)';

                if (prefersReducedMotion) {
                    ctx.fillStyle = '#ff007f';
                    ctx.fillRect(width * 0.25, height / 2 - 2, width * 0.5, 4);
                } else {
                    wavePhase += 0.2;
                    ctx.beginPath();
                    ctx.strokeStyle = '#ff007f';
                    ctx.lineWidth = 2;
                    for (let x = 0; x < width; x += 4) {
                        const y = height / 2 + Math.sin(x * 0.05 + wavePhase) * 8 * Math.sin(wavePhase * 0.5);
                        if (x === 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }
            } else if (isProcessing) {
                if (statusText) statusText.textContent = 'PROCESSING (NEURAL)';
                if (pulseDot) pulseDot.style.background = 'var(--accent-amber)';

                wavePhase += 0.08;
                const scanX = (Math.sin(wavePhase) * 0.5 + 0.5) * (width - 40);
                ctx.fillStyle = 'rgba(255, 183, 3, 0.2)';
                ctx.fillRect(0, height / 2 - 1, width, 2);
                ctx.fillStyle = '#ffb703';
                ctx.fillRect(scanX, height / 2 - 3, 40, 6);
            } else {
                if (statusText) statusText.textContent = 'SUB-SYSTEM READY';
                if (pulseDot) pulseDot.style.background = 'var(--accent-green)';

                ctx.strokeStyle = 'rgba(0, 242, 254, 0.25)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, height / 2);
                ctx.lineTo(width, height / 2);
                ctx.stroke();

                if (!prefersReducedMotion) {
                    wavePhase += 0.03;
                    const pulse = Math.sin(wavePhase);
                    if (pulse > 0.8) {
                        const pulseH = (pulse - 0.8) * 18;
                        ctx.strokeStyle = '#00f2fe';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.moveTo(width / 2 - 20, height / 2);
                        ctx.lineTo(width / 2 - 5, height / 2);
                        ctx.lineTo(width / 2, height / 2 - pulseH);
                        ctx.lineTo(width / 2 + 5, height / 2 + pulseH);
                        ctx.lineTo(width / 2 + 10, height / 2);
                        ctx.lineTo(width / 2 + 20, height / 2);
                        ctx.stroke();
                    }
                }
            }

            requestAnimationFrame(renderFrame);
        }

        renderFrame();
    }

    // 11. Companion Sizing & Local Fairy Voice Controls
    function initCompanionSettingsControls() {
        const sliderWidth = document.getElementById('sliderCompanionWidth');
        const sliderHeight = document.getElementById('sliderCompanionHeight');
        const sliderWidthVal = document.getElementById('sliderWidthVal');
        const sliderHeightVal = document.getElementById('sliderHeightVal');
        const labelDims = document.getElementById('companionDimensionsLabel');
        const btnResetTiny = document.getElementById('btnResetTinyPet');
        const btnMedium = document.getElementById('btnMediumPet');
        const settingsToggleFloat = document.getElementById('settingsToggleFloatBtn');

        const selectEngine = document.getElementById('settingsTtsEngineSelect');
        const selectKokoroVoice = document.getElementById('settingsKokoroVoiceSelect');
        const sliderRate = document.getElementById('sliderVoiceRate');
        const sliderPitch = document.getElementById('sliderVoicePitch');
        const sliderVolume = document.getElementById('sliderVoiceVolume');
        const rateLabelVal = document.getElementById('rateLabelVal');
        const pitchLabelVal = document.getElementById('pitchLabelVal');
        const volumeLabelVal = document.getElementById('volumeLabelVal');
        const btnTestFairy = document.getElementById('btnTestFairyVoice');

        const checkWakeWord = document.getElementById('checkWakeWordActive');
        const checkBg = document.getElementById('checkBackgroundActive');

        // Authoritative dimension state
        let confirmedWidth = 160;
        let confirmedHeight = 190;
        let dimensionRequestId = 0;
        let resizeDebounceTimer = null;

        function renderConfirmedDimensions(w, h) {
            const safeW = Math.max(140, Math.min(520, Math.round(Number(w) || 160)));
            const safeH = Math.max(170, Math.min(600, Math.round(Number(h) || 190)));
            confirmedWidth = safeW;
            confirmedHeight = safeH;

            if (sliderWidth && Number(sliderWidth.value) !== safeW) {
                sliderWidth.value = safeW;
            }
            if (sliderHeight && Number(sliderHeight.value) !== safeH) {
                sliderHeight.value = safeH;
            }
            if (sliderWidthVal) {
                sliderWidthVal.textContent = `${safeW} px`;
            }
            if (sliderHeightVal) {
                sliderHeightVal.textContent = `${safeH} px`;
            }
            if (labelDims) {
                labelDims.textContent = `${safeW} × ${safeH} px`;
            }
        }

        function renderTentativeDimensions(w, h) {
            const safeW = Math.max(140, Math.min(520, Math.round(Number(w) || 160)));
            const safeH = Math.max(170, Math.min(600, Math.round(Number(h) || 190)));
            if (sliderWidthVal) sliderWidthVal.textContent = `${safeW} px`;
            if (sliderHeightVal) sliderHeightVal.textContent = `${safeH} px`;
            if (labelDims) labelDims.textContent = `${safeW} × ${safeH} px`;
        }

        function refreshCompanionStatus() {
            if (window.lucyIpc && typeof window.lucyIpc.getCompanionStatus === 'function') {
                window.lucyIpc.getCompanionStatus().then((st) => {
                    if (st && Number.isFinite(st.width) && Number.isFinite(st.height)) {
                        renderConfirmedDimensions(st.width, st.height);
                    }
                }).catch(() => {});
            }
        }

        window.refreshCompanionSettings = refreshCompanionStatus;
        refreshCompanionStatus();

        if (window.lucyIpc && typeof window.lucyIpc.onCompanionResized === 'function') {
            window.lucyIpc.onCompanionResized((data) => {
                if (data && Number.isFinite(data.width) && Number.isFinite(data.height)) {
                    dimensionRequestId++; // Invalidate pending local slider requests
                    renderConfirmedDimensions(data.width, data.height);
                }
            });
        }

        async function commitDimensions(targetW, targetH, immediate = false) {
            const w = Math.max(140, Math.min(520, Math.round(Number(targetW))));
            const h = Math.max(170, Math.min(600, Math.round(Number(targetH))));

            if (resizeDebounceTimer) {
                clearTimeout(resizeDebounceTimer);
                resizeDebounceTimer = null;
            }

            const reqId = ++dimensionRequestId;

            const sendIpcRequest = async () => {
                if (!window.lucyIpc || typeof window.lucyIpc.setCompanionDimensions !== 'function') {
                    renderConfirmedDimensions(w, h);
                    return;
                }
                try {
                    const res = await window.lucyIpc.setCompanionDimensions({ width: w, height: h });
                    // Discard stale responses from out-of-order execution
                    if (reqId !== dimensionRequestId) return;

                    if (res && res.ok && Number.isFinite(res.width) && Number.isFinite(res.height)) {
                        renderConfirmedDimensions(res.width, res.height);
                    } else {
                        // Failed/rejected: revert to last confirmed authoritative dimensions
                        renderConfirmedDimensions(confirmedWidth, confirmedHeight);
                    }
                } catch (_) {
                    if (reqId === dimensionRequestId) {
                        renderConfirmedDimensions(confirmedWidth, confirmedHeight);
                    }
                }
            };

            if (immediate) {
                renderTentativeDimensions(w, h);
                if (sliderWidth) sliderWidth.value = w;
                if (sliderHeight) sliderHeight.value = h;
                await sendIpcRequest();
            } else {
                renderTentativeDimensions(w, h);
                resizeDebounceTimer = setTimeout(sendIpcRequest, 80);
            }
        }

        if (sliderWidth && sliderHeight) {
            sliderWidth.addEventListener('input', () => {
                commitDimensions(sliderWidth.value, sliderHeight.value, false);
            });
            sliderHeight.addEventListener('input', () => {
                commitDimensions(sliderWidth.value, sliderHeight.value, false);
            });
        }

        if (btnResetTiny) {
            btnResetTiny.addEventListener('click', () => {
                commitDimensions(160, 190, true);
                showBubble('Companion reset to tiny default 160 × 190 px.');
            });
        }

        if (btnMedium) {
            btnMedium.addEventListener('click', () => {
                commitDimensions(220, 260, true);
                showBubble('Companion set to comfortable 220 × 260 px.');
            });
        }

        if (settingsToggleFloat) {
            settingsToggleFloat.addEventListener('click', async () => {
                if (isFairyFloating) {
                    await dockFairyToApp();
                } else {
                    await floatFairyToDesktop();
                }
            });
            // Ensure settings button strictly matches current companion state
            syncCompanionUI(isFairyFloating);
        }

        async function persistCompanionVoiceConfig() {
            if (typeof persistVoiceSettings === 'function') {
                await persistVoiceSettings();
            }
        }

        if (btnTestFairy) {
            let isUserStopping = false;
            btnTestFairy.addEventListener('click', async () => {
                if (!voiceController) return;
                if (voiceController.isSpeaking) {
                    isUserStopping = true;
                    voiceController.stopSpeaking();
                    btnTestFairy.textContent = '▶ Test Fairy Voice';
                    renderer.setVisualState({ emotion: 'happy' });
                    return;
                }

                isUserStopping = false;

                // Read live unsaved inputs directly from UI
                const engine = selectEngine ? selectEngine.value : 'kokoro';
                const voiceName = selectKokoroVoice ? selectKokoroVoice.value : 'af_bella';
                const rate = sliderRate ? parseFloat(sliderRate.value) : 1.0;
                const pitch = sliderPitch ? parseFloat(sliderPitch.value) : 1.05;
                const volume = sliderVolume ? parseFloat(sliderVolume.value) : 1.0;

                btnTestFairy.textContent = '⏳ Loading...';
                renderer.setVisualState({ emotion: 'curious' });

                try {
                    let testPhrase;
                    if (engine === 'windows-speech') {
                        testPhrase = `Sparkle! I am Lucy, speaking with the local Windows Speech system voice. All systems verified and ready.`;
                    } else {
                        const persona = voiceName === 'af_sky' ? 'Sky' : 'Bella';
                        testPhrase = `Sparkle! I am Lucy, your celestial fairy companion speaking with ${persona} voice preset. All local systems are verified and ready.`;
                    }
                    showBubble(testPhrase);

                    const success = await voiceController.speak(testPhrase, {
                        ttsEngine: engine,
                        voice: voiceName,
                        kokoroVoice: voiceName,
                        rate,
                        pitch,
                        volume,
                        isPreview: true,
                        force: true,
                        onStart: () => {
                            if (!isUserStopping) {
                                btnTestFairy.textContent = '⏹ Stop Voice';
                                renderer.setVisualState({ emotion: 'speaking' });
                            }
                        }
                    });
                    if (!success && !isUserStopping) {
                        throw new Error('Voice playback did not start');
                    }
                } catch (err) {
                    if (isUserStopping) return;
                    showBubble('Voice test failed: ' + err.message);
                    btnTestFairy.textContent = '⚠️ Test Failed';
                    renderer.setVisualState({ emotion: 'worried' });
                    setTimeout(() => {
                        btnTestFairy.textContent = '▶ Test Fairy Voice';
                        renderer.setVisualState({ emotion: 'happy' });
                    }, 2500);
                } finally {
                    if (!isUserStopping && btnTestFairy.textContent !== '⚠️ Test Failed') {
                        btnTestFairy.textContent = '▶ Test Fairy Voice';
                        renderer.setVisualState({ emotion: 'happy' });
                    }
                }
            });
        }

        // Playful Aerial Stunts on Companion Settings Tab
        const stuntButtons = document.querySelectorAll('#paneCompanion .main-trick-opt');
        stuntButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const trick = btn.getAttribute('data-trick');
                if (trick && renderer && typeof renderer.playTrick === 'function') {
                    renderer.playTrick(trick);
                    const trickDef = petManager ? petManager.getTrick(trick) : null;
                    const msg = trickDef ? trickDef.message : `Playing ${trick}! ✨`;
                    showBubble(msg);
                    if (voiceController && voiceController.ttsEnabled) {
                        voiceController.stopSpeaking();
                        voiceController.speak(msg).catch(() => {});
                    }
                    if (window.lucyIpc && window.lucyIpc.playCompanionTrick) {
                        window.lucyIpc.playCompanionTrick(trick).catch(() => {});
                    }
                }
            });
        });

        // Companion Pinning State Handling
        const checkCompanionPinned = document.getElementById('checkCompanionPinned');
        if (checkCompanionPinned && window.lucyIpc && typeof window.lucyIpc.getCompanionStatus === 'function') {
            window.lucyIpc.getCompanionStatus().then((st) => {
                if (st && st.isPinned !== undefined) {
                    checkCompanionPinned.checked = Boolean(st.isPinned);
                    if (settingCompanionPinnedModal) settingCompanionPinnedModal.checked = Boolean(st.isPinned);
                }
            }).catch(() => {});
        }

        if (checkCompanionPinned) {
            checkCompanionPinned.addEventListener('change', async () => {
                const isPinned = checkCompanionPinned.checked;
                if (settingCompanionPinnedModal) settingCompanionPinnedModal.checked = isPinned;
                if (window.lucyIpc && typeof window.lucyIpc.setCompanionPin === 'function') {
                    await window.lucyIpc.setCompanionPin(isPinned);
                }
            });
        }

        if (window.lucyIpc && typeof window.lucyIpc.onCompanionPinChanged === 'function') {
            window.lucyIpc.onCompanionPinChanged((data) => {
                if (data && data.isPinned !== undefined) {
                    const pinned = Boolean(data.isPinned);
                    if (checkCompanionPinned) checkCompanionPinned.checked = pinned;
                    if (settingCompanionPinnedModal) settingCompanionPinnedModal.checked = pinned;
                }
            });
        }
    }

    // Lifecycle State Change Observer
    if (window.lucyIpc && typeof window.lucyIpc.onLifecycleStateChanged === 'function') {
        window.lucyIpc.onLifecycleStateChanged((data) => {
            const state = data?.currentState;
            if (lifecycleStateBadge) {
                lifecycleStateBadge.textContent = state ? state.replace(/_/g, ' ').toUpperCase() : 'UNKNOWN';
            }
            if (state === 'companion_only' || state === 'background_tray') {
                if (window.lucyIpc && typeof window.lucyIpc.getAppSettings === 'function') {
                    window.lucyIpc.getAppSettings().then((cfg) => {
                        const bgListen = cfg?.settings?.backgroundListening;
                        if (!bgListen && voiceController) {
                            if (voiceController.isListening) {
                                voiceController.stopListening();
                            }
                        }
                    }).catch(() => {});
                }
            } else if (state === 'shutting_down' || state === 'stopped') {
                if (voiceController) {
                    if (voiceController.isSpeaking) voiceController.stopSpeaking();
                    if (voiceController.isListening) voiceController.stopListening();
                }
            }
        });
    }

    if (window.lucyIpc && typeof window.lucyIpc.onOpenSettings === 'function') {
        window.lucyIpc.onOpenSettings(() => {
            openSettings();
        });
    }

    initJarvisNavigationDeck();
    initAudioVisualizer();
    initCompanionSettingsControls();
    refreshStatus();

    // Standalone fallback simulator when previewed directly in browser
    async function simulateLocalExecution(text, dryRun) {
        const lower = text.toLowerCase();
        await new Promise((r) => setTimeout(r, 600));

        if (lower.includes('status') || lower.includes('system')) {
            return {
                ok: true,
                status: 'completed',
                replyText: 'System status verified. Running on Windows x64 with clean resources.',
                dryRun,
                executedSteps: [
                    {
                        title: 'Query host platform resources',
                        toolId: 'system_info',
                        verified: true,
                        result: { ok: true, status: 'completed', result: { platform: 'win32', memory: { usedPercent: 42 } } }
                    }
                ]
            };
        }

        return {
            ok: true,
            status: 'completed',
            needsConfig: true,
            replyText: `No AI provider is configured in preview mode. Please configure Google Gemini or OpenRouter in Provider Settings.`,
            dryRun,
            executedSteps: []
        };
    }
});
