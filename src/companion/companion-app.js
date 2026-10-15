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

    // Clean 3-Button Dock
    const talkBtn = document.getElementById('talkBtn');
    const pinBtn = document.getElementById('pinBtn');
    const returnBtn = document.getElementById('returnBtn');
    const closeBtn = document.getElementById('closeBtn');

    let isPinned = true;
    let collapseTimer = null;
    let typewriterTimer = null;

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
    function resizeCanvasToStage() {
        if (!fairyStage || !fairyCanvas) return;
        const rect = fairyStage.getBoundingClientRect();
        const stageW = Math.max(100, Math.floor(rect.width));
        const stageH = Math.max(100, Math.floor(rect.height));

        fairyCanvas.width = stageW;
        fairyCanvas.height = stageH;

        if (typeof renderer.onResize === 'function') {
            renderer.onResize(stageW, stageH);
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
        window.companionIpc.onResized(() => {
            resizeCanvasToStage();
        });
    }

    // 3. Tactile Corner Resize Grip
    if (resizeGrip) {
        let isResizing = false;
        let resizeStartX = 0;
        let resizeStartY = 0;

        resizeGrip.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
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

    // Show initial welcoming greeting beside character
    displayMessage('Sparkle! ✨ Beside you on your desktop.', true);

    // 5. Pin State Visual Sync
    function updatePinUI(pinned) {
        isPinned = Boolean(pinned);
        if (pinBtn) {
            pinBtn.classList.toggle('active', isPinned);
            pinBtn.classList.toggle('unpinned', !isPinned);
            pinBtn.textContent = isPinned ? '📌' : '📍';
            pinBtn.title = isPinned
                ? 'Pinned: Always on top 📌 (Click to unpin)'
                : 'Free: Normal desktop window 📍 (Click to pin on top)';
        }
    }

    if (window.companionIpc && window.companionIpc.getStatus) {
        window.companionIpc.getStatus().then((status) => {
            if (status && status.isPinned !== undefined) {
                updatePinUI(status.isPinned);
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
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hasMoved = false;

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
        isDragging = false;
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
                displayMessage('How can I help you today? ✨', false);
            } else {
                if (window.companionIpc && window.companionIpc.focusMainWindow) {
                    window.companionIpc.focusMainWindow();
                }
            }
        });
    }

    // 📌 2. Pin / Unpin Toggle
    if (pinBtn) {
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (window.companionIpc && window.companionIpc.togglePin) {
                try {
                    const res = await window.companionIpc.togglePin();
                    updatePinUI(res.isPinned);
                    displayMessage(res.isPinned ? 'Pinned: Always on top 📌' : 'Unpinned: Free mode 📍', true);
                } catch (_) {}
            }
        });
    }

    // ↩️ 3. Return to Main Application
    async function executeReturn() {
        displayMessage('Flying back home! ✨', true);
        renderer.setVisualState({ emotion: 'takeoff' });

        document.body.style.transition = 'opacity 0.28s ease';
        document.body.style.opacity = '0';

        setTimeout(() => {
            if (window.companionIpc && window.companionIpc.returnToApp) {
                window.companionIpc.returnToApp();
            }
            document.body.style.opacity = '1';
        }, 300);
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
                    const trickLabels = {
                        spin: 'Twirl! 💫 Spinning through the stars!',
                        jump: 'Boing! 🦘 High fairy leap!',
                        fly: 'Swoosh! 🦋 Gliding on celestial wings!',
                        bounce: 'Sparkle! ✨ Happy flutter bounce!'
                    };
                    displayMessage(trickLabels[trick] || `Playing ${trick}! ✨`, true);
                }
            });
        });
    }

    // Direct Character Interaction (Petting reaction on fairy click)
    if (fairyStage) {
        fairyStage.addEventListener('click', () => {
            if (!hasMoved) {
                renderer.setVisualState({ emotion: 'pet' });
                displayMessage('Purr! ✨ That tickles, thank you! 💖', true);
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
                if (voiceData.voiceState === 'speaking') {
                    renderer.setVisualState({ emotion: 'speaking' });
                    if (voiceData.text) {
                        displayMessage(voiceData.text, false);
                    }
                } else if (voiceData.voiceState === 'listening') {
                    renderer.setVisualState({ emotion: 'listening' });
                    displayMessage('Listening carefully... 🎙️', true);
                } else if (voiceData.voiceState === 'idle') {
                    if (renderer.state.emotion === 'speaking' || renderer.state.emotion === 'listening') {
                        renderer.setVisualState({ emotion: 'idle' });
                    }
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

        if (window.companionIpc.onVisibilityChanged) {
            window.companionIpc.onVisibilityChanged((data) => {
                if (data && typeof renderer.setVisibility === 'function') {
                    renderer.setVisibility(Boolean(data.isVisible));
                }
            });
        }
    }
});
