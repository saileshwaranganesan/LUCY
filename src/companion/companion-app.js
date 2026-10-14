'use strict';

/**
 * Desktop Floating Fairy Companion Application
 * Runs the unified CelestialFamiliarRenderer on the transparent desktop window,
 * manages window drag physics, speech dialogue bubbles, and dock interactions.
 */
document.addEventListener('DOMContentLoaded', () => {
    const fairyCanvas = document.getElementById('fairyCanvas');
    const fairyStage = document.getElementById('fairyStage');
    const speechBubble = document.getElementById('speechBubble');
    const statusPill = document.getElementById('statusPill');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    // Dock Buttons
    const petBtn = document.getElementById('petBtn');
    const magicBtn = document.getElementById('magicBtn');
    const talkBtn = document.getElementById('talkBtn');
    const pinBtn = document.getElementById('pinBtn');
    const returnBtn = document.getElementById('returnBtn');
    const closeBtn = document.getElementById('closeBtn');

    let isPinned = true;
    let bubbleTimer = null;

    // 1. Initialize Unified Fairy Renderer
    const renderer = new CelestialFamiliarRenderer(fairyCanvas);
    renderer.start();
    window.fairyRenderer = renderer;

    // Show initial welcoming speech bubble
    showBubble('Sparkle! ✨ I am right here beside you.');

    // 2. Window Dragging Physics
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hasMoved = false;

    function handleDragStart(e) {
        // Prevent drag when clicking dock buttons or top controls
        if (e.target.closest('.control-dock') || e.target.closest('.top-close-btn')) {
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

    // Attach dragging to stage and status pill
    if (fairyStage) fairyStage.addEventListener('mousedown', handleDragStart);
    if (statusPill) statusPill.addEventListener('mousedown', handleDragStart);
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);

    // 3. Dock Button Interactions
    // ✋ Pet Lucy
    if (petBtn) {
        petBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            renderer.setVisualState({ emotion: 'pet' });
            showBubble('Purr! ✨ That tickles, thank you! 💖');

            if (window.companionIpc && window.companionIpc.petCompanion) {
                try {
                    await window.companionIpc.petCompanion();
                } catch (_) {}
            }
        });
    }

    // ✨ Magic Sparkle Interaction
    if (magicBtn) {
        magicBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            renderer.setVisualState({ emotion: 'magic' });
            showBubble('Twirl! 🌟 May stardust guide your thoughts!');

            if (window.companionIpc && window.companionIpc.magicCompanion) {
                try {
                    await window.companionIpc.magicCompanion();
                } catch (_) {}
            }
        });
    }

    // 💬 Talk / Focus Assistant Console
    if (talkBtn) {
        talkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            renderer.setVisualState({ emotion: 'listening' });
            showBubble('Listening! Focusing main console...');

            if (window.companionIpc && window.companionIpc.focusMainWindow) {
                window.companionIpc.focusMainWindow();
            }
        });
    }

    // 📌 Pin / Always on Top
    if (pinBtn) {
        pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (window.companionIpc && window.companionIpc.togglePin) {
                try {
                    const res = await window.companionIpc.togglePin();
                    isPinned = res.isPinned;
                    pinBtn.classList.toggle('active', isPinned);
                    showBubble(isPinned ? 'Pinned: Always on top 📌' : 'Unpinned from top.');
                } catch (_) {}
            }
        });
    }

    // ↩️ Return to Main Application
    async function executeReturn() {
        showBubble('Flying back home! ✨');
        renderer.setVisualState({ emotion: 'takeoff' });

        // Graceful exit fade
        document.body.style.transition = 'opacity 0.35s ease';
        document.body.style.opacity = '0';

        setTimeout(() => {
            if (window.companionIpc && window.companionIpc.returnToApp) {
                window.companionIpc.returnToApp();
            }
            document.body.style.opacity = '1';
        }, 360);
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

    // Stage Click (Direct Pet / Wakeup if clicked without dragging)
    if (fairyStage) {
        fairyStage.addEventListener('click', () => {
            if (!hasMoved) {
                renderer.setVisualState({ emotion: 'pet' });
                showBubble('Hehe, sparkle! ✨ I am watching over your desktop.');
            }
        });
    }

    // 4. Speech Bubble Helper
    function showBubble(text) {
        if (!speechBubble || !text) return;
        speechBubble.textContent = text;
        speechBubble.classList.add('visible');

        if (bubbleTimer) clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(() => {
            speechBubble.classList.remove('visible');
        }, 5500);
    }

    // 5. IPC Listeners for Visual & Voice Events
    if (window.companionIpc) {
        if (window.companionIpc.onVisualUpdate) {
            window.companionIpc.onVisualUpdate((data) => {
                if (!data) return;
                if (data.emotion) {
                    renderer.setVisualState({ emotion: data.emotion });
                    if (statusText) statusText.textContent = data.emotion.toUpperCase();

                    // Update status dot color
                    if (statusDot) {
                        const colors = {
                            happy: '#00f5d4',
                            speaking: '#38ef7d',
                            thinking: '#b388ff',
                            working: '#06d6a0',
                            listening: '#ff70a6',
                            worried: '#ff8da1',
                            idle: '#00f5d4'
                        };
                        statusDot.style.background = colors[data.emotion] || '#00f5d4';
                        statusDot.style.boxShadow = `0 0 8px ${colors[data.emotion] || '#00f5d4'}`;
                    }
                }
                if (data.speechBubble) {
                    showBubble(data.speechBubble);
                }
            });
        }

        if (window.companionIpc.onVoiceUpdate) {
            window.companionIpc.onVoiceUpdate((voiceData) => {
                if (!voiceData) return;
                if (voiceData.voiceState === 'speaking') {
                    renderer.setVisualState({ emotion: 'speaking' });
                    if (voiceData.text) showBubble(voiceData.text);
                } else if (voiceData.voiceState === 'listening') {
                    renderer.setVisualState({ emotion: 'listening' });
                } else if (voiceData.voiceState === 'idle') {
                    renderer.setVisualState({ emotion: 'idle' });
                }
            });
        }
    }
});
