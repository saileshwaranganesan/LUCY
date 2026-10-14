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
            toggleFloatingBtn.textContent = '↩️ Return Pet';
            toggleFloatingBtn.title = 'Return Lucy to main application';
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
                    toggleFloatingBtn.textContent = '↩️ Return Pet';
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

        if (window.lucyIpc && window.lucyIpc.onCompanionWindowToggled) {
            window.lucyIpc.onCompanionWindowToggled(async ({ isOpen }) => {
                if (!isOpen && isFairyFloating) {
                    await dockFairyToApp();
                } else if (isOpen && !isFairyFloating) {
                    isFairyFloating = true;
                    if (creatureStage) creatureStage.classList.add('fairy-on-desktop');
                    renderer.stop();
                    toggleFloatingBtn.textContent = '↩️ Return Pet';
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

    // 6. Provider Settings Screen
    const defaultModels = {
        gemini: 'gemini-2.0-flash',
        openrouter: 'google/gemini-2.0-flash-001',
        ollama: 'qwen2.5:1.5b',
        huggingface: 'meta-llama/Llama-3.2-3B-Instruct',
        'custom-openai': 'gpt-4o-mini'
    };

    function updateSettingVisibility() {
        const prov = settingProvider.value;
        if (prov === 'ollama') {
            apiKeyGroup.style.display = 'none';
            localUrlGroup.style.display = 'flex';
            if (hfNotice) hfNotice.style.display = 'none';
        } else if (prov === 'huggingface') {
            apiKeyGroup.style.display = 'flex';
            localUrlGroup.style.display = 'none';
            if (hfNotice) hfNotice.style.display = 'block';
        } else {
            apiKeyGroup.style.display = 'flex';
            localUrlGroup.style.display = 'none';
            if (hfNotice) hfNotice.style.display = 'none';
        }
    }

    settingProvider.addEventListener('change', () => {
        updateSettingVisibility();
        settingModel.value = defaultModels[settingProvider.value] || '';
        checkKeyStatus();
    });

    if (discoverOllamaBtn) {
        discoverOllamaBtn.addEventListener('click', async () => {
            const url = settingLocalUrl.value.trim() || 'http://127.0.0.1:11434';
            discoverOllamaBtn.disabled = true;
            discoverOllamaBtn.textContent = '🔄 Discovering...';
            if (ollamaDiscoveryStatus) {
                ollamaDiscoveryStatus.style.display = 'block';
                ollamaDiscoveryStatus.style.color = 'var(--text-dim)';
                ollamaDiscoveryStatus.textContent = 'Connecting to Ollama endpoint...';
            }

            try {
                if (window.lucyIpc && typeof window.lucyIpc.discoverOllamaModels === 'function') {
                    const res = await window.lucyIpc.discoverOllamaModels(url);
                    if (res.ok && res.models && res.models.length > 0) {
                        if (modelDatalist) {
                            modelDatalist.innerHTML = res.models
                                .map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)} (${escapeHtml(m.sizeFormatted || '')})</option>`)
                                .join('');
                        }
                        if (modelDiscoveryBadge) {
                            modelDiscoveryBadge.style.display = 'inline';
                            modelDiscoveryBadge.textContent = `${res.models.length} local models`;
                        }
                        if (ollamaDiscoveryStatus) {
                            ollamaDiscoveryStatus.style.color = 'var(--accent-green)';
                            ollamaDiscoveryStatus.textContent = `✓ Found ${res.models.length} installed model(s).`;
                        }
                        if (!settingModel.value || settingModel.value === defaultModels.ollama) {
                            settingModel.value = res.models[0].name;
                        }
                        showBubble(`Discovered ${res.models.length} local Ollama model(s)!`);
                    } else {
                        if (ollamaDiscoveryStatus) {
                            ollamaDiscoveryStatus.style.color = 'var(--accent-amber)';
                            ollamaDiscoveryStatus.textContent = res.error ? `Discovery error: ${res.error}` : 'No installed models returned by server.';
                        }
                        if (modelDiscoveryBadge) {
                            modelDiscoveryBadge.style.display = 'none';
                        }
                    }
                } else {
                    if (ollamaDiscoveryStatus) {
                        ollamaDiscoveryStatus.textContent = 'Discovery IPC unavailable in preview mode.';
                    }
                }
            } catch (err) {
                if (ollamaDiscoveryStatus) {
                    ollamaDiscoveryStatus.style.color = 'var(--accent-red)';
                    ollamaDiscoveryStatus.textContent = `Failed: ${err.message}`;
                }
            } finally {
                discoverOllamaBtn.disabled = false;
                discoverOllamaBtn.textContent = '🔄 Discover Models';
            }
        });
    }

    async function checkKeyStatus() {
        if (!window.lucyIpc || typeof window.lucyIpc.getProviderConfig !== 'function') {
            keyStatusBadge.textContent = 'Offline Preview Mode';
            keyStatusBadge.style.color = 'var(--text-muted)';
            return;
        }
        try {
            const cfg = await window.lucyIpc.getProviderConfig();
            if (settingProvider.value === 'ollama') {
                keyStatusBadge.textContent = 'Local (No Key Required)';
                keyStatusBadge.style.color = 'var(--accent-green)';
            } else if (cfg.hasKey && cfg.provider === settingProvider.value) {
                keyStatusBadge.textContent = '✓ Configured (DPAPI Protected)';
                keyStatusBadge.style.color = 'var(--accent-green)';
            } else if (settingProvider.value === 'huggingface') {
                keyStatusBadge.textContent = 'Key Required (Free HF Token)';
                keyStatusBadge.style.color = 'var(--accent-amber)';
            } else {
                keyStatusBadge.textContent = 'Not Configured';
                keyStatusBadge.style.color = 'var(--accent-amber)';
            }
        } catch {
            keyStatusBadge.textContent = 'Unknown';
        }
    }

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

    // Initial voice config load
    if (window.lucyIpc && typeof window.lucyIpc.getVoiceConfig === 'function') {
        window.lucyIpc.getVoiceConfig().then((res) => {
            if (res && res.config && voiceController) {
                voiceController.setVoiceConfig(res.config);
                if (res.config.wakeWordEnabled !== undefined) {
                    voiceController.setWakeWordEnabled(res.config.wakeWordEnabled);
                }
                if (res.config.wakeWordSensitivity !== undefined && voiceController.wakeWordEngine) {
                    voiceController.wakeWordEngine.setSensitivity(res.config.wakeWordSensitivity);
                }
            }
        }).catch(() => {});
    }

    async function openSettings() {
        if (window.lucyIpc && typeof window.lucyIpc.getProviderConfig === 'function') {
            const cfg = await window.lucyIpc.getProviderConfig();
            if (cfg.provider) settingProvider.value = cfg.provider;
            if (cfg.model) settingModel.value = cfg.model;
            if (cfg.localBaseUrl) settingLocalUrl.value = cfg.localBaseUrl;
        }

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

        settingApiKey.value = '';
        updateSettingVisibility();
        await checkKeyStatus();
        settingsModal.classList.add('active');
        renderer.setVisualState({ emotion: 'curious' });
    }

    function closeSettings() {
        settingsModal.classList.remove('active');
        settingApiKey.value = '';
    }

    if (hudSettingsBtn) hudSettingsBtn.addEventListener('click', openSettings);
    if (sidebarSettingsBtn) sidebarSettingsBtn.addEventListener('click', openSettings);
    cancelSettingsBtn.addEventListener('click', closeSettings);

    saveSettingsBtn.addEventListener('click', async () => {
        const provider = settingProvider.value;
        const model = settingModel.value.trim() || defaultModels[provider];
        const apiKey = settingApiKey.value.trim();
        const localBaseUrl = settingLocalUrl.value.trim();

        if (window.lucyIpc && typeof window.lucyIpc.setProviderConfig === 'function') {
            await window.lucyIpc.setProviderConfig({
                provider,
                model,
                apiKey,
                localBaseUrl
            });
            appendFeedEntry('Settings Applied', `Provider updated to ${provider} (${model}).`, 'normal', 'Config Saved');
            await refreshStatus();
        } else {
            appendFeedEntry('Settings Saved', `Provider simulated as ${provider} (${model}).`, 'normal', 'Preview Mode');
        }

        // Save Voice Settings
        if (settingVoicePitch && settingVoiceRate) {
            const voicePayload = {
                pitch: parseFloat(settingVoicePitch.value) || 1.05,
                rate: parseFloat(settingVoiceRate.value) || 1.02,
                voiceName: settingVoiceSelect ? settingVoiceSelect.value : '',
                preferredVoiceName: settingVoiceSelect ? settingVoiceSelect.value : '',
                ttsEnabled: settingTtsEnabled ? settingTtsEnabled.checked : true,
                wakeWordEnabled: settingWakeWordEnabled ? settingWakeWordEnabled.checked : false,
                wakeWordSensitivity: settingWakeWordSensitivity ? parseFloat(settingWakeWordSensitivity.value) || 0.5 : 0.5
            };
            if (window.lucyIpc && typeof window.lucyIpc.setVoiceConfig === 'function') {
                const voiceRes = await window.lucyIpc.setVoiceConfig(voicePayload);
                if (voiceRes && !voiceRes.ok) {
                    appendFeedEntry('Voice Config Warning', voiceRes.error || 'Failed to save voice configuration.', 'error', 'Voice Warning');
                    showBubble('Voice configuration error: ' + (voiceRes.error || 'invalid settings'));
                    return;
                }
            }
            if (voiceController && typeof voiceController.setVoiceConfig === 'function') {
                voiceController.setVoiceConfig(voicePayload);
                if (typeof voiceController.setWakeWordEnabled === 'function') {
                    voiceController.setWakeWordEnabled(voicePayload.wakeWordEnabled);
                    if (voiceController.wakeWordEngine) {
                        voiceController.wakeWordEngine.setSensitivity(voicePayload.wakeWordSensitivity);
                    }
                }
            }
            appendFeedEntry('Voice Updated', `Voice set to pitch ${voicePayload.pitch}, rate ${voicePayload.rate}.`, 'normal', 'Audio Config');
        }

        closeSettings();
        showBubble('Settings updated safely!');
        renderer.setVisualState({ emotion: 'happy' });
    });

    if (settingWakeWordEnabled) {
        settingWakeWordEnabled.addEventListener('change', () => {
            if (wakeWordOptionsGroup) {
                wakeWordOptionsGroup.style.display = settingWakeWordEnabled.checked ? 'flex' : 'none';
            }
        });
    }
    if (settingWakeWordSensitivity && wakeWordSensitivityVal) {
        settingWakeWordSensitivity.addEventListener('input', () => {
            wakeWordSensitivityVal.textContent = Number(settingWakeWordSensitivity.value).toFixed(2);
        });
    }

    clearKeyBtn.addEventListener('click', async () => {
        const provider = settingProvider.value;
        if (window.lucyIpc && typeof window.lucyIpc.clearApiKey === 'function') {
            await window.lucyIpc.clearApiKey(provider);
            settingApiKey.value = '';
            await checkKeyStatus();
            appendFeedEntry('Secret Cleared', `Stored API key for ${provider} was securely deleted.`, 'consequential', 'DPAPI Removed');
            await refreshStatus();
        }
    });

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
                const keyLabel = status.hasKey ? '✓ Configured' : '⚠ No Key';
                hudProvider.textContent = `${status.provider} (${status.model}) [${keyLabel}]`;
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
