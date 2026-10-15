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
    const settingVoicePitch = document.getElementById('settingVoicePitch');
    const settingVoiceRate = document.getElementById('settingVoiceRate');
    const voicePitchVal = document.getElementById('voicePitchVal');
    const voiceRateVal = document.getElementById('voiceRateVal');
    const settingWakeWordEnabled = document.getElementById('settingWakeWordEnabled');
    const wakeWordOptionsGroup = document.getElementById('wakeWordOptionsGroup');
    const settingBackgroundMode = document.getElementById('settingBackgroundMode');
    const explicitExitBtn = document.getElementById('explicitExitBtn');
    const hudExitBtn = document.getElementById('hudExitBtn');
    const settingWakeWordSensitivity = document.getElementById('settingWakeWordSensitivity');
    const wakeWordSensitivityVal = document.getElementById('wakeWordSensitivityVal');

    // Memory & Continuity Elements
    const hudMemoryBtn = document.getElementById('hudMemoryBtn');
    const sidebarMemoryBtn = document.getElementById('sidebarMemoryBtn');
    const memoryModal = document.getElementById('memoryModal');
    const closeMemoryModalBtn = document.getElementById('closeMemoryModalBtn');
    const tabMemoriesBtn = document.getElementById('tabMemoriesBtn');
    const tabContinuityBtn = document.getElementById('tabContinuityBtn');
    const tabAddMemoryBtn = document.getElementById('tabAddMemoryBtn');
    const paneMemories = document.getElementById('paneMemories');
    const paneContinuity = document.getElementById('paneContinuity');
    const paneAddMemory = document.getElementById('paneAddMemory');
    const toggleLongTermCheckbox = document.getElementById('toggleLongTermCheckbox');
    const memorySearchInput = document.getElementById('memorySearchInput');
    const clearCategoryBtn = document.getElementById('clearCategoryBtn');
    const memoryListContainer = document.getElementById('memoryListContainer');
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

    // 1. Initialize Creature Companion Renderer
    const renderer = new CelestialFamiliarRenderer(canvas);
    renderer.start();
    window.companionRenderer = renderer;

    // 1b. Initialize Voice Controller
    let voiceController = null;
    if (typeof createVoiceController === 'function') {
        voiceController = createVoiceController({
            globalScope: window,
            onWakeWord: (result) => {
                showBubble(`Heard "${result.keyword}"! How can I help?`);
                appendFeedEntry('Voice Activation', `Wake phrase detected: "${result.keyword}" (${(result.confidence * 100).toFixed(0)}% confidence).`, 'normal', 'Wake-Word');
                renderer.setVisualState({ emotion: 'listening' });
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
                } else if (voiceState === 'processing') {
                    if (micBtn) {
                        micBtn.classList.remove('listening');
                        micBtn.classList.add('processing');
                        micBtn.textContent = '⏳ Processing...';
                    }
                    statusLabel.textContent = 'PROCESSING';
                    statusDot.style.background = 'var(--accent-amber)';
                    renderer.setVisualState({ emotion: 'thinking' });
                    emotionLabel.textContent = 'Thinking';
                } else if (voiceState === 'speaking') {
                    if (stopVoiceBtn) stopVoiceBtn.style.display = 'inline-block';
                    statusLabel.textContent = 'SPEAKING';
                    statusDot.style.background = 'var(--accent-green)';
                    renderer.setVisualState({ emotion: 'speaking' });
                    emotionLabel.textContent = 'Speaking';
                } else if (voiceState === 'idle') {
                    if (micBtn) {
                        micBtn.classList.remove('listening', 'processing');
                        micBtn.textContent = '🎙️ Mic';
                    }
                    if (stopVoiceBtn) stopVoiceBtn.style.display = 'none';
                    if (['SPEAKING', 'LISTENING', 'PROCESSING'].includes(statusLabel.textContent)) {
                        statusLabel.textContent = 'READY';
                        statusDot.style.background = 'var(--accent-cyan)';
                        renderer.setVisualState({ emotion: 'happy' });
                        emotionLabel.textContent = 'Happy';
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
                commandInput.value = finalText;
                if (micBtn) {
                    micBtn.classList.remove('listening', 'processing');
                    micBtn.textContent = '🎙️ Mic';
                }
                if (finalText && finalText.trim()) {
                    handleCommand();
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
        });
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && voiceController && voiceController.isSpeaking) {
            voiceController.stopSpeaking();
            if (stopVoiceBtn) stopVoiceBtn.style.display = 'none';
        }
    });

    // 2. Creature Interactions
    canvas.addEventListener('click', () => {
        showBubble('Sparkle! ✨ What would you like me to do?');
        renderer.setVisualState({ emotion: 'happy' });
    });

    petBtn.addEventListener('click', () => {
        showBubble('Hehe, thank you! Ready to work! 🌟');
        renderer.setVisualState({ emotion: 'happy' });
    });

    toggleDryRunBtn.addEventListener('click', () => {
        isDryRun = !isDryRun;
        toggleDryRunBtn.textContent = `Dry-Run: ${isDryRun ? 'ON' : 'OFF'}`;
        toggleDryRunBtn.style.color = isDryRun ? 'var(--accent-amber)' : 'inherit';
        showBubble(isDryRun ? 'Dry-run active: tool executions will be simulated.' : 'Real execution mode active.');
    });

    // 2b. Floating Fairy Companion Lifecycle Controller
    let isFairyTransitioning = false;
    let isFairyFloating = false;
    const creatureStage = document.getElementById('creatureStage');
    const inlineReturnBtn = document.getElementById('inlineReturnBtn');
    const inlineSummonBtn = document.getElementById('inlineSummonBtn');

    async function floatFairyToDesktop() {
        if (isFairyTransitioning || isFairyFloating) return;
        isFairyTransitioning = true;
        if (toggleFloatingBtn) toggleFloatingBtn.disabled = true;

        // 1. Fairy acknowledges and plays takeoff flight
        renderer.setVisualState({ emotion: 'takeoff' });
        showBubble('Taking flight to your desktop! ✨');

        // 2. Animate embedded stage flight out
        if (creatureStage) {
            creatureStage.classList.add('fairy-flying-out');
        }

        await new Promise((r) => setTimeout(r, 400));

        // 3. Open desktop floating companion window via IPC
        if (window.lucyIpc && window.lucyIpc.toggleCompanionWindow) {
            await window.lucyIpc.toggleCompanionWindow({ action: 'float' });
        }

        // 4. Mark embedded stage as floating on desktop
        if (creatureStage) {
            creatureStage.classList.remove('fairy-flying-out');
            creatureStage.classList.add('fairy-on-desktop');
        }
        renderer.stop(); // Stop embedded loop to conserve resources

        isFairyFloating = true;
        if (toggleFloatingBtn) {
            toggleFloatingBtn.textContent = '↩️ Dock Pet';
            toggleFloatingBtn.title = 'Dock Lucy back into main application';
            toggleFloatingBtn.disabled = false;
        }
        isFairyTransitioning = false;
    }

    async function dockFairyToApp() {
        if (isFairyTransitioning || !isFairyFloating) return;
        isFairyTransitioning = true;
        if (toggleFloatingBtn) toggleFloatingBtn.disabled = true;

        // 1. Request floating window to return and hide
        if (window.lucyIpc && window.lucyIpc.toggleCompanionWindow) {
            await window.lucyIpc.toggleCompanionWindow({ action: 'dock' });
        }

        // 2. Prepare embedded stage for landing
        if (creatureStage) {
            creatureStage.classList.remove('fairy-on-desktop');
            creatureStage.classList.add('fairy-flying-in');
        }

        // 3. Wake up embedded renderer and play landing arrival
        renderer.start();
        renderer.setVisualState({ emotion: 'landing' });
        showBubble("I'm back! Ready to assist. ✨");

        await new Promise((r) => setTimeout(r, 500));

        if (creatureStage) {
            creatureStage.classList.remove('fairy-flying-in');
        }
        renderer.setVisualState({ emotion: 'happy' });

        isFairyFloating = false;
        if (toggleFloatingBtn) {
            toggleFloatingBtn.textContent = '🪟 Float Pet';
            toggleFloatingBtn.title = 'Float companion to desktop';
            toggleFloatingBtn.disabled = false;
        }
        isFairyTransitioning = false;
    }

    if (toggleFloatingBtn) {
        // Query initial status on startup
        if (window.lucyIpc && window.lucyIpc.getCompanionStatus) {
            window.lucyIpc.getCompanionStatus().then((res) => {
                if (res && res.isOpen) {
                    isFairyFloating = true;
                    if (creatureStage) creatureStage.classList.add('fairy-on-desktop');
                    renderer.stop();
                    toggleFloatingBtn.textContent = '↩️ Dock Pet';
                    toggleFloatingBtn.title = 'Dock Lucy back into main application';
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
            window.lucyIpc.onCompanionWindowToggled(async ({ isOpen }) => {
                if (!isOpen && isFairyFloating) {
                    await dockFairyToApp();
                } else if (isOpen && !isFairyFloating) {
                    isFairyFloating = true;
                    if (creatureStage) creatureStage.classList.add('fairy-on-desktop');
                    renderer.stop();
                    toggleFloatingBtn.textContent = '↩️ Dock Pet';
                    toggleFloatingBtn.title = 'Dock Lucy back into main application';
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
        appendFeedEntry('User Request', text, 'normal', 'Instruction');
        renderer.setVisualState({ emotion: 'thinking' });
        statusLabel.textContent = 'PLANNING';
        statusDot.style.background = 'var(--accent-purple)';

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
            showBubble('Response was cancelled.');
            return;
        }

        if (!response.ok) {
            if (activeStreamingEntry) {
                activeStreamingEntry.remove();
                activeStreamingEntry = null;
                streamingBuffer = '';
            }
            appendFeedEntry('Task Failed', response.error || 'Execution stopped', 'error', 'Verification Failed');
            renderer.setVisualState({ emotion: 'worried' });
            statusLabel.textContent = 'FAILED';
            statusDot.style.background = 'var(--accent-red)';
            showBubble('I hit a snag. Please review the activity log.');
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
            if (response.replyText && voiceController && voiceController.ttsEnabled) {
                voiceController.speakResponse(response.replyText);
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
        if (activeStreamingEntry) {
            activeStreamingEntry.className = 'log-entry normal';
            activeStreamingEntry.innerHTML = `
                <div class="log-meta">
                    <span>Task Completed</span>
                    <span>Verified Complete</span>
                </div>
                <div style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(response.replyText || streamingBuffer || 'Task finished successfully.')}</div>
            `;
            activeStreamingEntry = null;
            streamingBuffer = '';
        } else {
            appendFeedEntry('Task Completed', response.replyText || 'Task finished successfully.', 'normal', 'Verified Complete');
        }

        renderer.setVisualState({ emotion: 'happy' });
        statusLabel.textContent = 'COMPLETED';
        statusDot.style.background = 'var(--accent-green)';
        showBubble(response.replyText || 'All planned steps verified and completed!');

        if (response.replyText && voiceController && voiceController.ttsEnabled) {
            voiceController.speakResponse(response.replyText);
        }

        await refreshStatus();
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
        if (pendingPermissionResolve) {
            pendingPermissionResolve(true);
            pendingPermissionResolve = null;
        }
    });

    denyPermissionBtn.addEventListener('click', () => {
        permissionModal.classList.remove('active');
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

    // Tab Navigation
    const settingsTabBtns = document.querySelectorAll('.settings-tab-btn');
    const settingsTabContents = document.querySelectorAll('.settings-tab-content');

    function switchSettingsTab(targetTabId) {
        settingsTabBtns.forEach((btn) => {
            const isTarget = btn.getAttribute('data-tab') === targetTabId;
            btn.classList.toggle('active', isTarget);
            btn.style.background = isTarget ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255,255,255,0.05)';
            btn.style.borderColor = isTarget ? 'var(--accent-cyan)' : 'var(--bg-card-border)';
            btn.style.color = isTarget ? 'var(--accent-cyan)' : 'var(--text-dim)';
        });
        settingsTabContents.forEach((content) => {
            content.style.display = content.id === targetTabId ? 'flex' : 'none';
        });

        if (targetTabId === 'tabConnections') {
            loadConnectionsList();
        } else if (targetTabId === 'tabRouting') {
            loadRoutingConfig();
        } else if (targetTabId === 'tabDiagnostics') {
            loadRoutingDiagnostics();
        }
    }

    settingsTabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            switchSettingsTab(tabId);
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
                configured: 'var(--accent-cyan)',
                rate_limited: 'var(--accent-amber)',
                temporarily_unavailable: 'var(--accent-amber)',
                invalid_credential: 'var(--accent-red)',
                disabled: 'var(--text-dim)'
            };

            const statusLabels = {
                connected: '● Connected',
                configured: '● Ready',
                rate_limited: '● Rate Limited',
                temporarily_unavailable: '● Unavailable',
                invalid_credential: '● Invalid Key',
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
                            const isFail = ev.outcome === 'failed' || ev.fallbacks?.length > 0;
                            const outcomeColor = ev.outcome === 'success' ? 'var(--accent-green)' : (isFail ? 'var(--accent-amber)' : 'var(--text-main)');
                            const fallbacksStr = ev.fallbacks && ev.fallbacks.length > 0
                                ? `<div style="color: var(--accent-amber); margin-top: 2px;">↳ Fallback attempts: ${ev.fallbacks.map((f) => `${escapeHtml(f.provider)} (${escapeHtml(f.reason)})`).join(' → ')}</div>`
                                : '';

                            return `
                                <div style="border-bottom: 1px solid rgba(255,255,255,0.05); padding: 4px 0;">
                                    <div style="display: flex; justify-content: space-between;">
                                        <span style="color: var(--text-dim);">${escapeHtml(timeStr)}</span>
                                        <span style="color: ${outcomeColor}; font-weight: 700;">${escapeHtml(ev.outcome || 'routed')}</span>
                                    </div>
                                    <div style="color: var(--text-main);">
                                        <strong>${escapeHtml(ev.provider)}</strong> (${escapeHtml(ev.model)}) — <span style="color: var(--text-dim);">${escapeHtml(ev.reason || '')}</span>
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
        if (!synth || typeof synth.getVoices !== 'function') return;
        const voices = synth.getVoices() || [];
        settingVoiceSelect.innerHTML = '<option value="">Default (Auto-select female/natural voice)</option>';
        for (const v of voices) {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = `${v.name} (${v.lang || 'en'})${v.default ? ' [Default]' : ''}`;
            if (v.name === selectedVoice) {
                opt.selected = true;
            }
            settingVoiceSelect.appendChild(opt);
        }
    }

    if (settingVoicePitch && voicePitchVal) {
        settingVoicePitch.addEventListener('input', () => {
            voicePitchVal.textContent = parseFloat(settingVoicePitch.value).toFixed(2);
        });
    }

    if (settingVoiceRate && voiceRateVal) {
        settingVoiceRate.addEventListener('input', () => {
            voiceRateVal.textContent = parseFloat(settingVoiceRate.value).toFixed(2);
        });
    }

    const resetVoiceDefaultsBtn = document.getElementById('resetVoiceDefaultsBtn');
    if (resetVoiceDefaultsBtn) {
        resetVoiceDefaultsBtn.addEventListener('click', () => {
            if (settingVoicePitch) {
                settingVoicePitch.value = 1.05;
                if (voicePitchVal) voicePitchVal.textContent = '1.05';
            }
            if (settingVoiceRate) {
                settingVoiceRate.value = 1.02;
                if (voiceRateVal) voiceRateVal.textContent = '1.02';
            }
            if (settingVoiceSelect) {
                settingVoiceSelect.value = '';
            }
            if (settingTtsEnabled) {
                settingTtsEnabled.checked = true;
            }
            showBubble('Voice settings reset to defaults.');
        });
    }

    if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = () => {
            populateVoiceOptions(settingVoiceSelect ? settingVoiceSelect.value : '');
        };
    }

    async function openSettings() {
        switchSettingsTab('tabConnections');
        await loadConnectionsList();

        // Load persisted voice configuration
        if (window.lucyIpc && typeof window.lucyIpc.getVoiceConfig === 'function') {
            try {
                const voiceRes = await window.lucyIpc.getVoiceConfig();
                if (voiceRes && voiceRes.config) {
                    const vc = voiceRes.config;
                    if (settingVoicePitch) {
                        settingVoicePitch.value = vc.pitch ?? 1.05;
                        if (voicePitchVal) voicePitchVal.textContent = Number(vc.pitch ?? 1.05).toFixed(2);
                    }
                    if (settingVoiceRate) {
                        settingVoiceRate.value = vc.rate ?? 1.02;
                        if (voiceRateVal) voiceRateVal.textContent = Number(vc.rate ?? 1.02).toFixed(2);
                    }
                    if (settingTtsEnabled) {
                        settingTtsEnabled.checked = vc.ttsEnabled !== false;
                    }
                    if (settingWakeWordEnabled) {
                        settingWakeWordEnabled.checked = vc.wakeWordEnabled === true;
                        if (wakeWordOptionsGroup) {
                            wakeWordOptionsGroup.style.display = settingWakeWordEnabled.checked ? 'flex' : 'none';
                        }
                    }
                    if (settingWakeWordSensitivity) {
                        settingWakeWordSensitivity.value = vc.wakeWordSensitivity ?? 0.5;
                        if (wakeWordSensitivityVal) {
                            wakeWordSensitivityVal.textContent = Number(vc.wakeWordSensitivity ?? 0.5).toFixed(2);
                        }
                    }
                    populateVoiceOptions(vc.voiceName || vc.preferredVoiceName || '');
                }
            } catch {
                populateVoiceOptions();
            }
        } else {
            populateVoiceOptions();
        }

        if (settingBackgroundMode && window.lucyIpc && typeof window.lucyIpc.getAppSettings === 'function') {
            try {
                const appCfg = await window.lucyIpc.getAppSettings();
                if (appCfg && appCfg.settings) {
                    settingBackgroundMode.checked = Boolean(appCfg.settings.backgroundMode);
                }
            } catch (_) {}
        }
        settingsModal.classList.add('active');
        renderer.setVisualState({ emotion: 'curious' });
    }

    function closeSettings() {
        settingsModal.classList.remove('active');
    }

    const closeSettingsXBtn = document.getElementById('closeSettingsXBtn');
    if (closeSettingsXBtn) closeSettingsXBtn.addEventListener('click', closeSettings);
    if (hudSettingsBtn) hudSettingsBtn.addEventListener('click', openSettings);
    if (sidebarSettingsBtn) sidebarSettingsBtn.addEventListener('click', openSettings);
    if (cancelSettingsBtn) cancelSettingsBtn.addEventListener('click', closeSettings);

    const handleExitApp = () => {
        if (window.lucyIpc && typeof window.lucyIpc.exitApp === 'function') {
            window.lucyIpc.exitApp();
        }
    };
    if (explicitExitBtn) explicitExitBtn.addEventListener('click', handleExitApp);
    if (hudExitBtn) hudExitBtn.addEventListener('click', handleExitApp);

    if (settingWakeWordEnabled) {
        settingWakeWordEnabled.addEventListener('change', () => {
            if (wakeWordOptionsGroup) {
                wakeWordOptionsGroup.style.display = settingWakeWordEnabled.checked ? 'flex' : 'none';
            }
        });
    }

    if (settingBackgroundMode) {
        settingBackgroundMode.addEventListener('change', async () => {
            if (window.lucyIpc && typeof window.lucyIpc.setAppSettings === 'function') {
                await window.lucyIpc.setAppSettings({
                    backgroundMode: settingBackgroundMode.checked
                });
            }
        });
    }
    if (settingWakeWordSensitivity && wakeWordSensitivityVal) {
        settingWakeWordSensitivity.addEventListener('input', () => {
            wakeWordSensitivityVal.textContent = Number(settingWakeWordSensitivity.value).toFixed(2);
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
        if (!window.lucyIpc || typeof window.lucyIpc.getSystemStatus !== 'function') {
            hudProvider.textContent = 'Gemini (Preview)';
            hudMemory.textContent = 'Desktop Ready';
            return;
        }

        try {
            const status = await window.lucyIpc.getSystemStatus();
            if (status.ok) {
                const keyLabel = status.hasKey ? '✓ Active' : '⚠ No Key';
                const labelPart = status.connectionLabel ? ` [${status.connectionLabel}]` : '';
                const modePart = status.routingMode ? ` · ${status.routingMode}` : '';
                hudProvider.textContent = `${status.provider} (${status.model})${labelPart}${modePart} [${keyLabel}]`;
                hudPermission.textContent = `${status.permissionMode} (Gated)`;
            }
        } catch {
            // Keep default
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
        if (tabAddMemoryBtn) tabAddMemoryBtn.classList.toggle('active', tabName === 'add');
        if (paneMemories) paneMemories.classList.toggle('active', tabName === 'memories');
        if (paneContinuity) paneContinuity.classList.toggle('active', tabName === 'continuity');
        if (paneAddMemory) paneAddMemory.classList.toggle('active', tabName === 'add');

        if (tabName === 'memories') loadMemories();
        if (tabName === 'continuity') loadInterruptedTasks();
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
    if (tabAddMemoryBtn) tabAddMemoryBtn.addEventListener('click', () => switchMemoryTab('add'));

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
