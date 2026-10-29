'use strict';

/**
 * Desktop Floating Fairy Companion Application — UX 2.0
 * Manages the unified CelestialFamiliarRenderer, dynamic responsive resizing,
 * tactile corner resize grip, clean 3-button control dock, adjacent typewriter
 * conversation side panel, and expressive playful tricks.
 */
document.addEventListener('DOMContentLoaded', () => {
    const fairyCanvas = document.getElementById('fairyCanvas');
    const fairyStage = document.getElementById('fairyStage');
    const statusPill = document.getElementById('statusPill');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    // Side Conversation Panel Elements
    const sidePanel = document.getElementById('sideConversationPanel');
    const typewriterText = document.getElementById('typewriterText');
    const sideDismissBtn = document.getElementById('sideDismissBtn');
    const openChatBtn = document.getElementById('openChatBtn');
    const trickMenuBtn = document.getElementById('trickMenuBtn');
    const trickDropdown = document.getElementById('trickDropdown');
    const resizeGrip = document.getElementById('resizeGrip');

    // Clean 3-Button Dock & Container
    const talkBtn = document.getElementById('talkBtn');
    const pinBtn = document.getElementById('pinBtn');
    const returnBtn = document.getElementById('returnBtn');
    const closeBtn = document.getElementById('closeBtn');
    const companionContainer = document.getElementById('companionContainer');

    let isPinned = true;
    let collapseTimer = null;
    let typewriterTimer = null;
    let isResizing = false;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hasMoved = false;
    let isPointerDown = false;
    let hideControlsTimer = null;
    let isUserHovering = false;

    // Hover & Focus Visibility Manager for Controls and Status Indicators
    function showControls() {
        if (hideControlsTimer) {
            clearTimeout(hideControlsTimer);
            hideControlsTimer = null;
        }
        if (companionContainer) {
            companionContainer.classList.add('controls-visible');
        }
    }

    function scheduleHideControls(delayMs = 220) {
        if (hideControlsTimer) {
            clearTimeout(hideControlsTimer);
            hideControlsTimer = null;
        }
        // Never hide controls during active mouse drag or window resize, or while keyboard focus is within
        if (isPointerDown || isDragging || isResizing) return;
        if (companionContainer && companionContainer.matches(':focus-within')) return;

        hideControlsTimer = setTimeout(() => {
            if (isPointerDown || isDragging || isResizing) return;
            if (companionContainer && companionContainer.matches(':focus-within')) return;
            if (companionContainer && companionContainer.matches(':hover')) return;

            // When pointer is away, collapse side panel and trick menu so companion footprint is clean
            if (trickDropdown && trickDropdown.classList.contains('open')) {
                trickDropdown.classList.remove('open');
            }
            if (sidePanel && !sidePanel.classList.contains('collapsed')) {
                collapseSidePanel();
            }

            if (companionContainer) {
                companionContainer.classList.remove('controls-visible');
            }
            hideControlsTimer = null;
        }, delayMs);
    }

    if (companionContainer) {
        companionContainer.addEventListener('pointerenter', () => {
            isUserHovering = true;
            showControls();
        });
        companionContainer.addEventListener('pointerleave', () => {
            isUserHovering = false;
            scheduleHideControls(220);
        });
        companionContainer.addEventListener('mouseenter', () => {
            isUserHovering = true;
            showControls();
        });
        companionContainer.addEventListener('mouseleave', () => {
            isUserHovering = false;
            scheduleHideControls(220);
        });

        // Keyboard navigation accessibility
        companionContainer.addEventListener('focusin', () => {
            showControls();
        });
        companionContainer.addEventListener('focusout', () => {
            setTimeout(() => {
                if (!companionContainer.contains(document.activeElement)) {
                    scheduleHideControls(150);
                }
            }, 50);
        });
    }

    // Window-level pointer listeners to guarantee controls remain visible during active interactions
    window.addEventListener('pointerdown', () => {
        isPointerDown = true;
        showControls();
    }, true);

    window.addEventListener('pointerup', () => {
        isPointerDown = false;
        if (companionContainer && !companionContainer.matches(':hover') && !companionContainer.matches(':focus-within')) {
            scheduleHideControls(250);
        }
    }, true);

    window.addEventListener('pointercancel', () => {
        isPointerDown = false;
        scheduleHideControls(200);
    }, true);

    // Check user preference for reduced motion
    const prefersReducedMotion = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;

    // 1. Initialize Celestial Familiar Renderer
    const renderer = new CelestialFamiliarRenderer(fairyCanvas);
    renderer.start();
    window.fairyRenderer = renderer;
    window.companionRenderer = renderer;

    // 2. Dynamic Canvas Sizing & Proportion Preservation
    let configuredBaseWidth = 160;
    let configuredBaseHeight = 190;

    function resizeCanvasToStage() {
        if (!fairyStage || !fairyCanvas) return;
        const rect = fairyStage.getBoundingClientRect();
        const stageW = Math.max(100, Math.floor(rect.width));
        const stageH = Math.max(100, Math.floor(rect.height));

        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(2.5, window.devicePixelRatio) : 1;

        fairyCanvas.style.width = stageW + 'px';
        fairyCanvas.style.height = stageH + 'px';

        if (typeof renderer.onResize === 'function') {
            renderer.onResize(stageW, stageH, dpr);
        }
    }

    // Initial resize after DOM paint
    requestAnimationFrame(() => {
        resizeCanvasToStage();
    });

    window.addEventListener('resize', () => {
        resizeCanvasToStage();
    });

    if (window.companionIpc && window.companionIpc.onResized) {
        window.companionIpc.onResized((data) => {
            if (data && typeof data.width === 'number' && typeof data.height === 'number') {
                if (sidePanel && sidePanel.classList.contains('collapsed')) {
                    configuredBaseWidth = data.width;
                    configuredBaseHeight = data.height;
                }
            }
            resizeCanvasToStage();
        });
    }

    // 3. Tactile Corner Resize Grip
    if (resizeGrip) {
        let resizeStartX = 0;
        let resizeStartY = 0;

        resizeGrip.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            autoExpandedWidth = null;
            isResizing = true;
            resizeStartX = e.screenX;
            resizeStartY = e.screenY;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const deltaX = e.screenX - resizeStartX;
            const deltaY = e.screenY - resizeStartY;

            if (Math.abs(deltaX) >= 2 || Math.abs(deltaY) >= 2) {
                if (window.companionIpc && window.companionIpc.resizeDelta) {
                    window.companionIpc.resizeDelta(deltaX, deltaY);
                }
                resizeStartX = e.screenX;
                resizeStartY = e.screenY;
            }
        });

        window.addEventListener('mouseup', () => {
            isResizing = false;
        });
    }

    // 4. Adjacent Side Conversation Panel with Typewriter Effect
    let autoExpandedWidth = null;

    function displayMessage(text, isTransient = false) {
        if (!sidePanel || !typewriterText || !text) return;

        // Clear any running timers
        if (typewriterTimer) {
            clearInterval(typewriterTimer);
            typewriterTimer = null;
        }
        if (collapseTimer) {
            clearTimeout(collapseTimer);
            collapseTimer = null;
        }

        // Always update typewriter text content so it is ready
        typewriterText.textContent = text;

        // If pointer is away (user is not hovering and not focused), do not expand window or open side panel
        if (!isUserHovering && (!companionContainer || !companionContainer.matches(':focus-within'))) {
            return;
        }

        // If the window is compact (< 300px), expand to 320px so the side panel does not crowd the fairy
        if (window.innerWidth < 300 && window.companionIpc && window.companionIpc.setWindowSize) {
            if (autoExpandedWidth === null) {
                autoExpandedWidth = configuredBaseWidth || window.innerWidth;
            }
            window.companionIpc.setWindowSize(320, window.innerHeight, true);
        }

        // Open side panel
        sidePanel.classList.remove('collapsed');
        resizeCanvasToStage();

        if (prefersReducedMotion) {
            // Instant render for reduced motion users
            typewriterText.textContent = text;
        } else {
            // Smooth Typewriter presentation
            typewriterText.textContent = '';
            let charIndex = 0;
            const textToType = String(text);
            const speed = Math.max(16, Math.min(32, Math.floor(1000 / (textToType.length || 1))));

            typewriterTimer = setInterval(() => {
                if (charIndex < textToType.length) {
                    typewriterText.textContent += textToType[charIndex];
                    charIndex++;
                } else {
                    clearInterval(typewriterTimer);
                    typewriterTimer = null;
                }
            }, speed);
        }

        // If transient greeting, schedule auto-dismiss after reading interval
        if (isTransient) {
            collapseTimer = setTimeout(() => {
                collapseSidePanel();
            }, 7000);
        }
    }

    function collapseSidePanel() {
        if (!sidePanel) return;
        sidePanel.classList.add('collapsed');
        if (trickDropdown) trickDropdown.classList.remove('open');
        resizeCanvasToStage();

        if (autoExpandedWidth !== null && window.companionIpc && window.companionIpc.setWindowSize) {
            const restoreW = autoExpandedWidth;
            autoExpandedWidth = null;
            window.companionIpc.setWindowSize(restoreW, window.innerHeight, false);
        }

        if (companionContainer && !companionContainer.matches(':hover') && !companionContainer.matches(':focus-within')) {
            scheduleHideControls(220);
        }
    }

    if (sideDismissBtn) {
        sideDismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            collapseSidePanel();
        });
    }

    if (openChatBtn) {
        openChatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.companionIpc && window.companionIpc.focusMainWindow) {
                window.companionIpc.focusMainWindow();
            }
        });
    }

    // Set friendly initial state without opening side panel
    renderer.setVisualState({ emotion: 'happy' });

    // 5. Pin State Visual Sync
    function updatePinUI(pinned) {
        isPinned = Boolean(pinned);
        if (pinBtn) {
            pinBtn.classList.toggle('active', isPinned);
            pinBtn.classList.toggle('unpinned', !isPinned);
            pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
            pinBtn.textContent = isPinned ? '📌' : '📍';
            pinBtn.title = isPinned
                ? 'Pinned: Always on top 📌 (Click to unpin)'
                : 'Free: Normal desktop window 📍 (Click to pin on top)';
        }
    }

    if (window.companionIpc && window.companionIpc.getStatus) {
        window.companionIpc.getStatus().then((status) => {
            if (status) {
                if (status.isPinned !== undefined) {
                    updatePinUI(status.isPinned);
                }
                if (typeof status.width === 'number' && status.width > 0) {
                    configuredBaseWidth = status.width;
                }
                if (typeof status.height === 'number' && status.height > 0) {
                    configuredBaseHeight = status.height;
                }
            }
        }).catch(() => {});
    }

    if (window.companionIpc && window.companionIpc.onPinChanged) {
        window.companionIpc.onPinChanged((data) => {
            if (data && data.isPinned !== undefined) {
                updatePinUI(data.isPinned);
            }
        });
    }

    // 6. Window Dragging Physics
    function handleDragStart(e) {
        // Prevent drag when clicking buttons, dropdowns, or resize grip
        if (e.target.closest('.control-dock') ||
            e.target.closest('.top-close-btn') ||
            e.target.closest('.side-panel') ||
            e.target.closest('.resize-grip')) {
            return;
        }
        isDragging = true;
        hasMoved = false;
        dragStartX = e.screenX;
        dragStartY = e.screenY;
        document.body.classList.add('is-dragging');
    }

    function handleDragMove(e) {
        if (!isDragging) return;
        const deltaX = e.screenX - dragStartX;
        const deltaY = e.screenY - dragStartY;

        if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
            hasMoved = true;
        }

        if (window.companionIpc && window.companionIpc.moveWindow) {
            window.companionIpc.moveWindow(deltaX, deltaY);
        }

        dragStartX = e.screenX;
        dragStartY = e.screenY;
    }

    function handleDragEnd() {
        if (isDragging) {
            isDragging = false;
            document.body.classList.remove('is-dragging');
        }
    }

    if (fairyStage) fairyStage.addEventListener('mousedown', handleDragStart);
    if (statusPill) statusPill.addEventListener('mousedown', handleDragStart);
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);

    // 7. Clean 3-Button Dock Interactions
    // 💬 1. Talk / Chat
    if (talkBtn) {
        talkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (sidePanel && sidePanel.classList.contains('collapsed')) {
                isUserHovering = true;
                displayMessage('How can I help you today? ✨', false);
            } else {
                if (window.companionIpc && window.companionIpc.focusMainWindow) {
                    window.companionIpc.focusMainWindow();
                }
            }
        });
    }

    // 📌 2. Pin / Unpin Toggle (Guarded against race conditions)
    let isPinToggling = false;
    if (pinBtn) {
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isPinToggling) return;
            if (window.companionIpc && window.companionIpc.togglePin) {
                isPinToggling = true;
                pinBtn.style.pointerEvents = 'none';
                try {
                    const res = await window.companionIpc.togglePin();
                    if (res && res.ok !== false) {
                        updatePinUI(res.isPinned);
                        isUserHovering = true;
                        displayMessage(res.isPinned ? 'Pinned: Always on top 📌' : 'Unpinned: Free mode 📍', true);
                    } else if (res && res.error) {
                        displayMessage('Pin failed: ' + res.error, true);
                    }
                } catch (err) {
                    displayMessage('Pin error: ' + (err.message || 'Failed to toggle pin'), true);
                } finally {
                    isPinToggling = false;
                    pinBtn.style.pointerEvents = '';
                }
            }
        });
    }

    // ↩️ 3. Return to Main Application
    let isReturning = false;

    function resetCompanionState() {
        if (typewriterTimer) {
            clearInterval(typewriterTimer);
            typewriterTimer = null;
        }
        if (collapseTimer) {
            clearTimeout(collapseTimer);
            collapseTimer = null;
        }
        if (sidePanel) {
            sidePanel.classList.add('collapsed');
        }
        if (typewriterText) {
            typewriterText.textContent = '';
        }
        if (trickDropdown) {
            trickDropdown.classList.remove('open');
        }
        if (autoExpandedWidth !== null && window.companionIpc && window.companionIpc.setWindowSize) {
            const restoreW = autoExpandedWidth;
            autoExpandedWidth = null;
            window.companionIpc.setWindowSize(restoreW, window.innerHeight, false);
        }
        if (renderer) {
            renderer.setVisualState({ emotion: 'idle' });
            renderer.state.actionTimer = 0;
            renderer.state.transitionOffset = 0;
            renderer.state.opacity = 1;
        }
        if (companionContainer) {
            companionContainer.classList.remove('controls-visible');
        }
        if (hideControlsTimer) {
            clearTimeout(hideControlsTimer);
            hideControlsTimer = null;
        }
        isPointerDown = false;
        document.body.style.opacity = '1';
        isReturning = false;
        resizeCanvasToStage();
    }

    async function executeReturn() {
        if (isReturning) return;
        isReturning = true;

        displayMessage('Flying back home! ✨', true);
        renderer.setVisualState({ emotion: 'takeoff' });

        document.body.style.transition = 'opacity 0.22s ease';
        document.body.style.opacity = '0';

        setTimeout(async () => {
            try {
                if (window.companionIpc && window.companionIpc.returnToApp) {
                    await window.companionIpc.returnToApp();
                }
            } catch (_) {}
            resetCompanionState();
        }, 250);
    }

    if (returnBtn) {
        returnBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            executeReturn();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            executeReturn();
        });
    }

    // 8. Playful Fairy Tricks & Secondary Interaction
    const petManager = (typeof PetInteractionManager !== 'undefined')
        ? new PetInteractionManager()
        : (window.PetInteractionManager ? new window.PetInteractionManager() : null);

    if (trickMenuBtn && trickDropdown) {
        trickMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            trickDropdown.classList.toggle('open');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#trickMenuWrapper')) {
                trickDropdown.classList.remove('open');
            }
        });

        const trickOptions = trickDropdown.querySelectorAll('.trick-option');
        trickOptions.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const trick = btn.getAttribute('data-trick');
                trickDropdown.classList.remove('open');
                if (trick && typeof renderer.playTrick === 'function') {
                    renderer.playTrick(trick);
                    const trickDef = petManager ? petManager.getTrick(trick) : null;
                    const msg = trickDef ? trickDef.message : `Playing ${trick}! ✨`;
                    isUserHovering = true;
                    displayMessage(msg, true);
                    if (window.companionIpc && window.companionIpc.playTrick) {
                        window.companionIpc.playTrick(trick).catch(() => {});
                    }
                }
            });
        });
    }

    // Keyboard Interaction & Dismissal (Escape key dismisses open menus and side panel)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (trickDropdown && trickDropdown.classList.contains('open')) {
                trickDropdown.classList.remove('open');
            }
            if (sidePanel && !sidePanel.classList.contains('collapsed')) {
                collapseSidePanel();
            }
            if (companionContainer && !companionContainer.matches(':hover') && !companionContainer.matches(':focus-within')) {
                companionContainer.classList.remove('controls-visible');
            }
        }
    });

    // Direct Character Interaction (Petting reaction on fairy click)
    if (fairyStage) {
        fairyStage.addEventListener('click', () => {
            if (!hasMoved) {
                if (petManager && !petManager.canTriggerPet()) return;
                const phrase = petManager ? petManager.getNextAffectionPhrase() : 'Purr! ✨ That tickles, thank you! 💖';
                renderer.setVisualState({ emotion: 'pet' });
                isUserHovering = true;
                displayMessage(phrase, true);
                if (window.companionIpc && window.companionIpc.petCompanion) {
                    window.companionIpc.petCompanion({ phrase }).catch(() => {});
                }
            }
        });
    }

    // 9. IPC Listeners for Visual, Voice, and Trick Events
    if (window.companionIpc) {
        if (window.companionIpc.onVisualUpdate) {
            window.companionIpc.onVisualUpdate((data) => {
                if (!data) return;
                if (data.emotion) {
                    renderer.setVisualState({ emotion: data.emotion });
                    if (statusText) statusText.textContent = data.emotion.toUpperCase();

                    if (statusDot) {
                        const colors = {
                            happy: '#ff85a1',
                            speaking: '#70d6ff',
                            thinking: '#b388ff',
                            working: '#38bdf8',
                            listening: '#ff70a6',
                            worried: '#fb7185',
                            idle: '#70d6ff'
                        };
                        statusDot.style.background = colors[data.emotion] || '#70d6ff';
                        statusDot.style.boxShadow = `0 0 6px ${colors[data.emotion] || '#70d6ff'}`;
                    }
                }
                if (data.speechBubble || data.text) {
                    displayMessage(data.speechBubble || data.text, true);
                }
            });
        }

        if (window.companionIpc.onVoiceUpdate) {
            window.companionIpc.onVoiceUpdate((voiceData) => {
                if (!voiceData) return;
                const state = (voiceData.voiceState || voiceData.state || '').toLowerCase();
                if (state === 'idle') {
                    if (['speaking', 'listening', 'thinking', 'worried'].includes(renderer.state.emotion)) {
                        renderer.setVisualState({ emotion: 'idle' });
                    }
                    if (statusText) statusText.textContent = 'IDLE';
                    if (statusDot) {
                        statusDot.style.background = '#70d6ff';
                        statusDot.style.boxShadow = '0 0 6px #70d6ff';
                    }
                    if (!isUserHovering && (!companionContainer || !companionContainer.matches(':focus-within'))) {
                        collapseSidePanel();
                        scheduleHideControls(150);
                    }
                } else if (state === 'speaking') {
                    renderer.setVisualState({ emotion: 'speaking' });
                    if (statusText) statusText.textContent = 'SPEAKING';
                    if (statusDot) {
                        statusDot.style.background = '#70d6ff';
                        statusDot.style.boxShadow = '0 0 6px #70d6ff';
                    }
                    if (voiceData.text) {
                        displayMessage(voiceData.text, false);
                    }
                } else if (state === 'listening') {
                    renderer.setVisualState({ emotion: 'listening' });
                    if (statusText) statusText.textContent = 'LISTENING';
                    if (statusDot) {
                        statusDot.style.background = '#ff70a6';
                        statusDot.style.boxShadow = '0 0 6px #ff70a6';
                    }
                    displayMessage('Listening carefully... 🎙️', true);
                } else if (state === 'transcribing' || state === 'processing') {
                    renderer.setVisualState({ emotion: 'thinking' });
                    if (statusText) statusText.textContent = 'TRANSCRIBING';
                    if (statusDot) {
                        statusDot.style.background = '#e0aaff';
                        statusDot.style.boxShadow = '0 0 6px #e0aaff';
                    }
                } else if (state === 'understanding') {
                    renderer.setVisualState({ emotion: 'thinking' });
                    if (statusText) statusText.textContent = 'UNDERSTANDING';
                    if (statusDot) {
                        statusDot.style.background = '#c77dff';
                        statusDot.style.boxShadow = '0 0 6px #c77dff';
                    }
                } else if (state === 'awaiting_confirmation' || state === 'awaiting-confirmation') {
                    renderer.setVisualState({ emotion: 'curious' });
                    if (statusText) statusText.textContent = 'AWAITING APPROVAL';
                    if (statusDot) {
                        statusDot.style.background = '#ffd166';
                        statusDot.style.boxShadow = '0 0 6px #ffd166';
                    }
                } else if (state === 'executing') {
                    renderer.setVisualState({ emotion: 'working' });
                    if (statusText) statusText.textContent = 'EXECUTING';
                    if (statusDot) {
                        statusDot.style.background = '#38bdf8';
                        statusDot.style.boxShadow = '0 0 6px #38bdf8';
                    }
                } else if (state === 'recovering' || state === 'awaiting_reconciliation') {
                    renderer.setVisualState({ emotion: 'thinking' });
                    if (statusText) statusText.textContent = state === 'recovering' ? 'RECOVERING' : 'RECONCILIATION';
                    if (statusDot) {
                        statusDot.style.background = '#f59e0b';
                        statusDot.style.boxShadow = '0 0 6px #f59e0b';
                    }
                    if (voiceData.text) {
                        displayMessage(voiceData.text, true);
                    }
                } else if (state === 'cancelled') {
                    renderer.setVisualState({ emotion: 'idle' });
                    if (statusText) statusText.textContent = 'CANCELLED';
                    if (statusDot) {
                        statusDot.style.background = '#ff70a6';
                        statusDot.style.boxShadow = '0 0 6px #ff70a6';
                    }
                    displayMessage('Request cancelled.', true);
                } else if (state === 'error') {
                    renderer.setVisualState({ emotion: 'worried' });
                    if (statusText) statusText.textContent = 'ERROR';
                    if (statusDot) {
                        statusDot.style.background = '#ef476f';
                        statusDot.style.boxShadow = '0 0 6px #ef476f';
                    }
                }
            });
        }

        if (window.companionIpc.onTaskUpdate) {
            window.companionIpc.onTaskUpdate((taskEvent) => {
                if (!taskEvent) return;
                const to = taskEvent.to;
                if (!to) return;
                switch (to) {
                    case 'IDLE':
                        renderer.setVisualState({ emotion: 'idle' });
                        if (statusText) statusText.textContent = 'IDLE';
                        if (statusDot) {
                            statusDot.style.background = '#70d6ff';
                            statusDot.style.boxShadow = '0 0 6px #70d6ff';
                        }
                        if (!isUserHovering && (!companionContainer || !companionContainer.matches(':focus-within'))) {
                            collapseSidePanel();
                            scheduleHideControls(150);
                        }
                        break;
                    case 'INTERPRETING':
                    case 'PLANNING':
                        renderer.setVisualState({ emotion: 'thinking' });
                        if (statusText) statusText.textContent = to === 'PLANNING' ? 'PLANNING' : 'THINKING';
                        if (statusDot) {
                            statusDot.style.background = '#c77dff';
                            statusDot.style.boxShadow = '0 0 6px #c77dff';
                        }
                        break;
                    case 'WAITING_PERMISSION':
                    case 'AWAITING_AUTHORIZATION':
                        renderer.setVisualState({ emotion: 'curious' });
                        if (statusText) statusText.textContent = 'AWAITING APPROVAL';
                        if (statusDot) {
                            statusDot.style.background = '#ffd166';
                            statusDot.style.boxShadow = '0 0 6px #ffd166';
                        }
                        if (taskEvent.description) {
                            displayMessage(taskEvent.description, true);
                        }
                        break;
                    case 'RUNNING':
                    case 'EXECUTING_TOOL':
                        renderer.setVisualState({ emotion: 'working' });
                        if (statusText) statusText.textContent = 'EXECUTING';
                        if (statusDot) {
                            statusDot.style.background = '#38bdf8';
                            statusDot.style.boxShadow = '0 0 6px #38bdf8';
                        }
                        break;
                    case 'VERIFYING':
                        renderer.setVisualState({ emotion: 'focused' });
                        if (statusText) statusText.textContent = 'VERIFYING';
                        if (statusDot) {
                            statusDot.style.background = '#a855f7';
                            statusDot.style.boxShadow = '0 0 6px #a855f7';
                        }
                        break;
                    case 'RECOVERING':
                    case 'AWAITING_RECONCILIATION':
                        renderer.setVisualState({ emotion: 'thinking' });
                        if (statusText) statusText.textContent = to === 'RECOVERING' ? 'RECOVERING' : 'RECONCILIATION';
                        if (statusDot) {
                            statusDot.style.background = '#f59e0b';
                            statusDot.style.boxShadow = '0 0 6px #f59e0b';
                        }
                        if (taskEvent.description) {
                            displayMessage(taskEvent.description, true);
                        }
                        break;
                    case 'COMPLETED':
                        renderer.setVisualState({ emotion: 'happy' });
                        if (statusText) statusText.textContent = 'COMPLETED';
                        if (statusDot) {
                            statusDot.style.background = '#10b981';
                            statusDot.style.boxShadow = '0 0 6px #10b981';
                        }
                        if (taskEvent.result?.summary) {
                            displayMessage(taskEvent.result.summary, true);
                        }
                        break;
                    case 'FAILED':
                        renderer.setVisualState({ emotion: 'worried' });
                        if (statusText) statusText.textContent = 'FAILED';
                        if (statusDot) {
                            statusDot.style.background = '#ef476f';
                            statusDot.style.boxShadow = '0 0 6px #ef476f';
                        }
                        if (taskEvent.error) {
                            displayMessage(taskEvent.error, true);
                        }
                        break;
                    case 'CANCELLED':
                    case 'INTERRUPTED':
                        renderer.setVisualState({ emotion: 'idle' });
                        if (statusText) statusText.textContent = to;
                        if (statusDot) {
                            statusDot.style.background = '#ff70a6';
                            statusDot.style.boxShadow = '0 0 6px #ff70a6';
                        }
                        displayMessage('Task cancelled.', true);
                        break;
                }
            });
        }

        if (window.companionIpc.onPlayTrick) {
            window.companionIpc.onPlayTrick((data) => {
                if (data && data.trick && typeof renderer.playTrick === 'function') {
                    renderer.playTrick(data.trick);
                }
            });
        }

        if (window.companionIpc.onResetState) {
            window.companionIpc.onResetState(() => {
                resetCompanionState();
            });
        }

        if (window.companionIpc.onVisibilityChanged) {
            window.companionIpc.onVisibilityChanged((data) => {
                const isVisible = Boolean(data && data.isVisible);
                if (typeof renderer.setVisibility === 'function') {
                    renderer.setVisibility(isVisible);
                }
                if (!isVisible) {
                    resetCompanionState();
                }
            });
        }
    }
});
