'use strict';

/**
 * CelestialFamiliarRenderer
 * Unified high-fidelity canvas rendering engine for L.U.C.Y.'s cute, feminine,
 * fantasy fairy companion.
 * 
 * Target Aesthetic:
 * - Cute chibi proportions with a balanced, rounded silhouette.
 * - Soft celestial palette: soft sky cyan, ethereal lavender, lilac violet,
 *   petal rose pink, and starlight champagne gold.
 * - Elegant 4-winged gossamer fairy wings with translucent iridescence & glowing veins.
 * - Soft layered celestial hair bangs, twin delicate side curls, and pointed fairy ears.
 * - Luminous starlight fairy tiara / circlet with a glowing pulsing star crystal.
 * - Expressive chibi anime eyes with deep iris gradients, dual catchlights, and look-at tracking.
 * - Layered translucent flower petal dress and glowing heart/star brooch.
 * - Subtle ambient stardust motes and particle ribbons.
 */
class CelestialFamiliarRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext('2d') : null;
        this.options = options;

        this.state = {
            emotion: 'idle',
            bubbleText: '',
            eyeTargetX: 0,
            eyeTargetY: 0,
            currentEyeX: 0,
            currentEyeY: 0,
            blinkProgress: 0,
            blinkTimer: 0,
            hoverPhase: 0,
            wingPhase: 0,
            skirtSway: 0,
            hairSway: 0,
            antennaeSway: 0,
            // Action animations & stunts
            actionTimer: 0,
            actionDuration: 0,
            spinAngle: 0,
            somersaultAngle: 0,
            flightOffsetX: 0,
            danceArmWave: 0,
            transitionOffset: 0,
            scaleY: 1,
            opacity: 1,
            // Idle saccades / breathing
            idleGlanceTimer: 0,
            idleGlanceDuration: 3.0
        };

        this.targetFps = 24;
        this.lastFrameTime = 0;
        this.isInteracting = false;
        this.isHovered = false;
        this.lastInteractionTime = Date.now();
        this.isObscured = false;
        this.rafId = null;
        const rect = (canvas && typeof canvas.getBoundingClientRect === 'function') ? canvas.getBoundingClientRect() : null;
        const defaultW = (rect && rect.width > 0) ? rect.width : ((canvas && canvas.width > 0) ? canvas.width : 160);
        const defaultH = (rect && rect.height > 0) ? rect.height : ((canvas && canvas.height > 0) ? canvas.height : 190);
        this.logicalWidth = (options.width && options.width > 0) ? options.width : Math.round(defaultW);
        this.logicalHeight = (options.height && options.height > 0) ? options.height : Math.round(defaultH);
        this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(2.5, window.devicePixelRatio) : 1;
        if (this.canvas) {
            const physicalW = Math.round(this.logicalWidth * this.dpr);
            const physicalH = Math.round(this.logicalHeight * this.dpr);
            if (this.canvas.width !== physicalW) this.canvas.width = physicalW;
            if (this.canvas.height !== physicalH) this.canvas.height = physicalH;
        }
        this.prefersReducedMotion = (typeof window !== 'undefined' && window.matchMedia)
            ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
            : false;

        this.orbitParticles = [];
        this.burstParticles = [];
        this.trailParticles = [];
        this.running = false;
        this.lastTime = 0;

        this._initParticles();
        this._bindEvents();
    }

    onResize(width, height, dpr) {
        if (typeof dpr === 'number' && dpr > 0) {
            this.dpr = Math.min(2.5, dpr);
        } else if (typeof window !== 'undefined' && window.devicePixelRatio) {
            this.dpr = Math.min(2.5, window.devicePixelRatio);
        }
        if (typeof width === 'number' && width > 0) {
            this.logicalWidth = Math.round(width);
        }
        if (typeof height === 'number' && height > 0) {
            this.logicalHeight = Math.round(height);
        }
        if (!this.canvas) return;

        const physicalW = Math.round(this.logicalWidth * this.dpr);
        const physicalH = Math.round(this.logicalHeight * this.dpr);
        if (this.canvas.width !== physicalW) {
            this.canvas.width = physicalW;
        }
        if (this.canvas.height !== physicalH) {
            this.canvas.height = physicalH;
        }
    }

    setVisibility(visible) {
        this.isObscured = !visible;
        if (visible) {
            this.lastInteractionTime = Date.now();
        }
    }

    markInteracted() {
        this.lastInteractionTime = Date.now();
        this.isInteracting = true;
    }

    _initParticles() {
        this.orbitParticles = [];
        for (let i = 0; i < 32; i++) {
            this.orbitParticles.push({
                x: (Math.random() - 0.5) * 120,
                y: (Math.random() - 0.5) * 120,
                radius: Math.random() * 1.8 + 0.6,
                angle: Math.random() * Math.PI * 2,
                speed: (Math.random() * 0.012 + 0.006) * (Math.random() > 0.5 ? 1 : -1),
                distance: Math.random() * 52 + 22,
                alpha: Math.random() * 0.6 + 0.3,
                pulseSpeed: Math.random() * 2 + 1
            });
        }
    }

    _bindEvents() {
        if (!this.canvas) return;

        this._mouseMoveHandler = (e) => {
            this.markInteracted();
            this.isHovered = true;
            const rect = this.canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            const cx = rect.width / 2;
            const cy = rect.height / 2;
            const targetX = (e.clientX - rect.left - cx) / cx;
            const targetY = (e.clientY - rect.top - cy) / cy;
            this.state.eyeTargetX = Math.max(-1, Math.min(1, targetX));
            this.state.eyeTargetY = Math.max(-1, Math.min(1, targetY));
        };

        this._mouseLeaveHandler = () => {
            this.isHovered = false;
            this.state.eyeTargetX = 0;
            this.state.eyeTargetY = 0;
        };

        this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
        this.canvas.addEventListener('mouseleave', this._mouseLeaveHandler);
    }

    setVisualState(visualState = {}) {
        if (!visualState) return;
        this.markInteracted();
        const prevEmotion = this.state.emotion;
        if (visualState.emotion) {
            // Protect active pet reaction and stunts from premature voice state overwrite
            const isProtectedActiveState = (this.state.emotion === 'pet' || String(this.state.emotion).startsWith('trick_')) && (this.state.actionTimer < this.state.actionDuration);
            if (!isProtectedActiveState || visualState.emotion !== 'speaking' || visualState.force) {
                this.state.emotion = visualState.emotion;
                this.targetFps = (visualState.emotion === 'idle') ? 24 : 60;
            }
        }

        if (this.state.emotion === 'pet' && prevEmotion !== 'pet') {
            this.triggerPetBurst();
        } else if (this.state.emotion === 'magic' && prevEmotion !== 'magic') {
            this.triggerMagicSpin();
        } else if ((this.state.emotion === 'trick_spin' || this.state.emotion === 'spin') && prevEmotion !== 'trick_spin') {
            this.triggerSpin();
        } else if ((this.state.emotion === 'trick_jump' || this.state.emotion === 'jump') && prevEmotion !== 'trick_jump') {
            this.triggerJump();
        } else if ((this.state.emotion === 'trick_fly' || this.state.emotion === 'fly') && prevEmotion !== 'trick_fly') {
            this.triggerFlight();
        } else if ((this.state.emotion === 'trick_bounce' || this.state.emotion === 'bounce') && prevEmotion !== 'trick_bounce') {
            this.triggerBounce();
        } else if ((this.state.emotion === 'trick_somersault' || this.state.emotion === 'somersault') && prevEmotion !== 'trick_somersault') {
            this.triggerSomersault();
        } else if ((this.state.emotion === 'trick_dance' || this.state.emotion === 'dance') && prevEmotion !== 'trick_dance') {
            this.triggerDance();
        } else if (this.state.emotion === 'takeoff') {
            this.triggerTakeoff();
        } else if (this.state.emotion === 'landing') {
            this.triggerLanding();
        }
    }

    playTrick(trickName) {
        const trick = String(trickName || '').toLowerCase().trim();
        switch (trick) {
            case 'spin':
            case 'twirl':
                this.triggerSpin();
                break;
            case 'jump':
            case 'leap':
                this.triggerJump();
                break;
            case 'fly':
            case 'flight':
                this.triggerFlight();
                break;
            case 'bounce':
            case 'flutter':
                this.triggerBounce();
                break;
            case 'somersault':
            case 'flip':
            case 'loop':
                this.triggerSomersault();
                break;
            case 'dance':
            case 'groove':
                this.triggerDance();
                break;
            case 'pet':
                this.setVisualState({ emotion: 'pet' });
                break;
            case 'magic':
                this.setVisualState({ emotion: 'magic' });
                break;
            default:
                this.triggerBounce();
                break;
        }
    }

    triggerSpin() {
        this.state.emotion = 'trick_spin';
        this.targetFps = 60;
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.6;
        this.state.spinAngle = 0;
        this.state.somersaultAngle = 0;
        this.markInteracted();
        this.burstParticles = [];
        for (let i = 0; i < 28; i++) {
            const angle = (i / 28) * Math.PI * 2;
            const dist = Math.random() * 32 + 10;
            this.burstParticles.push({
                x: Math.cos(angle) * dist,
                y: Math.sin(angle) * dist,
                vx: Math.cos(angle + Math.PI / 2) * (Math.random() * 2 + 1.2),
                vy: Math.sin(angle + Math.PI / 2) * (Math.random() * 2 + 1.2) - 0.4,
                radius: Math.random() * 2.4 + 1.0,
                alpha: 1,
                decay: 0.02,
                color: ['#70d6ff', '#ffd166', '#b388ff', '#ff85a1'][i % 4],
                shape: 'sparkle'
            });
        }
    }

    triggerJump() {
        this.state.emotion = 'trick_jump';
        this.targetFps = 60;
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.3;
        this.state.transitionOffset = 0;
        this.state.spinAngle = 0;
        this.state.somersaultAngle = 0;
        this.state.scaleY = 1.0;
        this.markInteracted();
        for (let i = 0; i < 16; i++) {
            this.burstParticles.push({
                x: (Math.random() - 0.5) * 24,
                y: 18,
                vx: (Math.random() - 0.5) * 1.8,
                vy: Math.random() * 1.5 + 0.5,
                radius: Math.random() * 2.2 + 0.8,
                alpha: 1,
                decay: 0.03,
                color: '#ffd166',
                shape: 'sparkle'
            });
        }
    }

    triggerFlight() {
        this.state.emotion = 'trick_fly';
        this.targetFps = 60;
        this.state.actionTimer = 0;
        this.state.actionDuration = 2.0;
        this.state.transitionOffset = 0;
        this.state.flightOffsetX = 0;
        this.state.spinAngle = 0;
        this.state.somersaultAngle = 0;
        this.markInteracted();
    }

    triggerBounce() {
        this.state.emotion = 'trick_bounce';
        this.targetFps = 60;
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.2;
        this.state.transitionOffset = 0;
        this.state.spinAngle = 0;
        this.state.somersaultAngle = 0;
        this.state.scaleY = 1.0;
        this.markInteracted();
    }

    triggerSomersault() {
        this.state.emotion = 'trick_somersault';
        this.targetFps = 60;
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.8;
        this.state.transitionOffset = 0;
        this.state.somersaultAngle = 0;
        this.state.spinAngle = 0;
        this.state.scaleY = 1.0;
        this.markInteracted();
        this.burstParticles = [];
        for (let i = 0; i < 32; i++) {
            const angle = (i / 32) * Math.PI * 2;
            const dist = Math.random() * 28 + 12;
            this.burstParticles.push({
                x: Math.cos(angle) * dist,
                y: Math.sin(angle) * dist - 15,
                vx: Math.cos(angle) * (Math.random() * 2.2 + 1.2),
                vy: Math.sin(angle) * (Math.random() * 2.2 + 1.2) - 0.5,
                radius: Math.random() * 2.6 + 1.0,
                alpha: 1,
                decay: 0.025,
                color: ['#70d6ff', '#ffd166', '#b388ff', '#f472b6'][i % 4],
                shape: 'sparkle'
            });
        }
    }

    triggerDance() {
        this.state.emotion = 'trick_dance';
        this.targetFps = 60;
        this.state.actionTimer = 0;
        this.state.actionDuration = 2.4;
        this.state.transitionOffset = 0;
        this.state.flightOffsetX = 0;
        this.state.spinAngle = 0;
        this.state.somersaultAngle = 0;
        this.state.scaleY = 1.0;
        this.markInteracted();
        this.burstParticles = [];
        for (let i = 0; i < 22; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 32 + 8;
            this.burstParticles.push({
                x: Math.cos(angle) * dist,
                y: Math.sin(angle) * dist,
                vx: (Math.random() - 0.5) * 1.6,
                vy: -Math.random() * 2.0 - 0.5,
                radius: Math.random() * 2.5 + 1.0,
                alpha: 1,
                decay: 0.02,
                color: Math.random() > 0.45 ? '#f472b6' : '#ffd166',
                shape: Math.random() > 0.4 ? 'heart' : 'sparkle'
            });
        }
    }

    triggerPetBurst() {
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.6;
        this.burstParticles = [];
        for (let i = 0; i < 24; i++) {
            const angle = (i / 24) * Math.PI * 2;
            const speed = Math.random() * 2.2 + 1.2;
            this.burstParticles.push({
                x: 0,
                y: -10,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 0.4,
                radius: Math.random() * 2.8 + 1.4,
                alpha: 1,
                decay: 0.02 + Math.random() * 0.02,
                color: Math.random() > 0.4 ? '#ff85a1' : '#ffd166',
                shape: Math.random() > 0.45 ? 'heart' : 'sparkle'
            });
        }
    }

    triggerMagicSpin() {
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.8;
        this.state.spinAngle = 0;
        for (let i = 0; i < 36; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 35 + 10;
            const speed = Math.random() * 2.6 + 1.6;
            this.burstParticles.push({
                x: Math.cos(angle) * dist,
                y: Math.sin(angle) * dist,
                vx: Math.cos(angle + Math.PI / 2) * speed * 0.7,
                vy: Math.sin(angle + Math.PI / 2) * speed * 0.7 - 0.9,
                radius: Math.random() * 3 + 1.2,
                alpha: 1,
                decay: 0.018 + Math.random() * 0.02,
                color: ['#70d6ff', '#ffd166', '#b388ff', '#ff85a1'][i % 4],
                shape: 'sparkle'
            });
        }
    }

    triggerTakeoff() {
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.2;
    }

    triggerLanding() {
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.0;
        this.state.transitionOffset = -120;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.lastTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        this.lastFrameTime = this.lastTime;

        const animate = (time) => {
            if (!this.running) return;

            // Visibility / hidden guard: skip render passes when document is hidden or obscured
            const isDocHidden = (typeof document !== 'undefined' && document.hidden);
            if (this.isObscured || isDocHidden) {
                if (typeof requestAnimationFrame === 'function') {
                    this.rafId = requestAnimationFrame(animate);
                }
                return;
            }

            // Adaptive frame rate scheduling:
            // High rate (60 FPS) when actively interacting, speaking, or executing tricks.
            // Throttled rate (24 FPS) when idle to preserve CPU, GPU, and battery.
            const isIdle = (this.state.emotion === 'idle');
            const now = Date.now();
            const isRecentlyActive = (now - this.lastInteractionTime < 3000);
            const targetFps = (!isIdle || isRecentlyActive) ? 60 : 24;
            const frameInterval = 1000 / targetFps;
            const elapsed = time - this.lastFrameTime;

            if (elapsed < frameInterval - 2) {
                if (typeof requestAnimationFrame === 'function') {
                    this.rafId = requestAnimationFrame(animate);
                }
                return;
            }

            this.lastFrameTime = time - (elapsed % frameInterval);
            const dt = Math.min((time - this.lastTime) / 1000, 0.1);
            this.lastTime = time;

            this._update(time, dt);
            this._render(time);

            if (typeof requestAnimationFrame === 'function') {
                this.rafId = requestAnimationFrame(animate);
            }
        };

        if (typeof requestAnimationFrame === 'function') {
            this.rafId = requestAnimationFrame(animate);
        }
    }

    stop() {
        this.running = false;
        if (this.rafId && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    destroy() {
        this.stop();
        if (this.canvas) {
            if (this._mouseMoveHandler) this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
            if (this._mouseLeaveHandler) this.canvas.removeEventListener('mouseleave', this._mouseLeaveHandler);
        }
    }

    _update(time, dt) {
        const sec = time / 1000;

        // Smooth look-at tracking with gentle spring damping
        this.state.currentEyeX += (this.state.eyeTargetX - this.state.currentEyeX) * Math.min(1, dt * 8);
        this.state.currentEyeY += (this.state.eyeTargetY - this.state.currentEyeY) * Math.min(1, dt * 8);

        // Hover & wing frequencies adapt dynamically
        let hoverSpeed = 2.2;
        let hoverAmp = this.prefersReducedMotion ? 2.5 : 7;
        let wingSpeed = this.prefersReducedMotion ? 6 : 12;

        if (this.state.emotion === 'takeoff') {
            wingSpeed = 24;
            this.state.actionTimer += dt;
            const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
            this.state.transitionOffset = -prog * 150;
            this.state.opacity = Math.max(0, 1 - prog * 1.4);
            if (Math.random() < 0.5) {
                this.trailParticles.push({
                    x: (Math.random() - 0.5) * 24,
                    y: 18,
                    vx: (Math.random() - 0.5) * 1.2,
                    vy: Math.random() * 1.8 + 0.8,
                    radius: Math.random() * 2.5 + 1,
                    alpha: 1,
                    decay: 0.03
                });
            }
        } else if (this.state.emotion === 'landing') {
            wingSpeed = 20;
            this.state.actionTimer += dt;
            const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
            this.state.transitionOffset = (1 - prog) * -100;
            this.state.opacity = Math.min(1, prog * 1.8);
            if (prog >= 1) {
                this.state.emotion = 'happy';
                this.state.transitionOffset = 0;
                this.state.opacity = 1;
            }
        } else {
            this.state.opacity = 1;

            if (this.state.emotion === 'speaking') {
                hoverSpeed = 2.8;
                wingSpeed = 15;
            } else if (this.state.emotion === 'working') {
                hoverSpeed = 2.5;
                wingSpeed = 16;
            } else if (this.state.emotion === 'pet') {
                hoverSpeed = 3.2;
                hoverAmp = 9;
                wingSpeed = 18;
                this.state.actionTimer += dt;
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'happy';
                    this.state.actionTimer = 0;
                    this.targetFps = 24;
                }
            } else if (this.state.emotion === 'trick_spin') {
                wingSpeed = 26;
                this.state.actionTimer += dt;
                this.state.spinAngle += dt * Math.PI * 3.8;
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'idle';
                    this.targetFps = 24;
                    this.state.spinAngle = 0;
                }
            } else if (this.state.emotion === 'trick_jump') {
                wingSpeed = 22;
                this.state.actionTimer += dt;
                const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
                if (prog < 0.2) {
                    this.state.scaleY = 0.88;
                    this.state.transitionOffset = 6;
                } else if (prog < 0.7) {
                    const jumpNorm = (prog - 0.2) / 0.5;
                    this.state.scaleY = 1.12;
                    this.state.transitionOffset = -46 * Math.sin(jumpNorm * Math.PI);
                } else if (prog < 0.9) {
                    this.state.scaleY = 0.9;
                    this.state.transitionOffset = 0;
                } else {
                    this.state.scaleY = 1.0;
                    this.state.transitionOffset = 0;
                }
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'idle';
                    this.targetFps = 24;
                    this.state.transitionOffset = 0;
                    this.state.scaleY = 1.0;
                }
            } else if (this.state.emotion === 'trick_fly') {
                wingSpeed = 28;
                this.state.actionTimer += dt;
                const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
                this.state.transitionOffset = Math.sin(prog * Math.PI * 2) * -30;
                this.state.flightOffsetX = Math.sin(prog * Math.PI * 4) * 16;
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'idle';
                    this.targetFps = 24;
                    this.state.transitionOffset = 0;
                    this.state.flightOffsetX = 0;
                }
            } else if (this.state.emotion === 'trick_bounce') {
                wingSpeed = 20;
                this.state.actionTimer += dt;
                const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
                this.state.transitionOffset = -Math.abs(Math.sin(prog * Math.PI * 4)) * 18;
                this.state.scaleY = 1.0 + Math.sin(prog * Math.PI * 4) * 0.08;
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'idle';
                    this.targetFps = 24;
                    this.state.transitionOffset = 0;
                    this.state.scaleY = 1.0;
                }
            } else if (this.state.emotion === 'trick_somersault') {
                wingSpeed = 30;
                this.state.actionTimer += dt;
                const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
                // Complete 360-degree aerial somersault loop
                this.state.somersaultAngle = prog * Math.PI * 2;
                this.state.transitionOffset = -Math.sin(prog * Math.PI) * 55;
                if (prog < 0.15) {
                    this.state.scaleY = 0.88;
                } else if (prog < 0.85) {
                    this.state.scaleY = 1.1;
                } else {
                    this.state.scaleY = 0.92 + ((prog - 0.85) / 0.15) * 0.08;
                }
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'idle';
                    this.targetFps = 24;
                    this.state.somersaultAngle = 0;
                    this.state.transitionOffset = 0;
                    this.state.scaleY = 1.0;
                }
            } else if (this.state.emotion === 'trick_dance') {
                wingSpeed = 22;
                this.state.actionTimer += dt;
                const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
                const beat = prog * Math.PI * 8; // 4 melodic sways
                this.state.flightOffsetX = Math.sin(beat) * 14;
                this.state.transitionOffset = -Math.abs(Math.sin(beat)) * 9;
                this.state.scaleY = 1.0 + Math.sin(beat * 2) * 0.04;
                this.state.danceArmWave = Math.sin(beat);
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'idle';
                    this.targetFps = 24;
                    this.state.flightOffsetX = 0;
                    this.state.transitionOffset = 0;
                    this.state.scaleY = 1.0;
                    this.state.danceArmWave = 0;
                }
            } else if (this.state.emotion === 'magic') {
                wingSpeed = 22;
                this.state.actionTimer += dt;
                this.state.spinAngle += dt * Math.PI * 3.5;
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'happy';
                    this.state.spinAngle = 0;
                }
            } else if (this.state.emotion === 'sleep') {
                hoverSpeed = 1.0;
                hoverAmp = 3.5;
                wingSpeed = 5;
            } else {
                this.state.transitionOffset = 0;
                this.state.scaleY = 1.0;
                this.state.flightOffsetX = 0;
                this.state.spinAngle = 0;
                this.state.somersaultAngle = 0;
                this.state.danceArmWave = 0;
            }
        }

        // Natural idle eye saccades / looking around when not tracking mouse
        if (!this.isHovered && (this.state.emotion === 'idle' || this.state.emotion === 'happy')) {
            this.state.idleGlanceTimer = (this.state.idleGlanceTimer || 0) + dt;
            if (this.state.idleGlanceTimer > (this.state.idleGlanceDuration || 2.4)) {
                this.state.idleGlanceTimer = 0;
                this.state.idleGlanceDuration = 2.0 + Math.random() * 2.2;
                // Alternate between looking to a gentle angle and returning to center
                if (Math.abs(this.state.eyeTargetX) < 0.05 && Math.abs(this.state.eyeTargetY) < 0.05) {
                    const angle = Math.random() * Math.PI * 2;
                    const magnitude = 0.35 + Math.random() * 0.45;
                    this.state.eyeTargetX = Math.cos(angle) * magnitude;
                    this.state.eyeTargetY = Math.sin(angle) * magnitude * 0.6;
                } else {
                    this.state.eyeTargetX = 0;
                    this.state.eyeTargetY = 0;
                }
            }
        }

        // Subtle natural breathing oscillation during idle
        if (this.state.emotion === 'idle' && !this.state.actionTimer) {
            this.state.scaleY = 1.0 + Math.sin(sec * 1.8) * 0.018;
        }

        this.state.hoverPhase = Math.sin(sec * hoverSpeed) * hoverAmp;
        this.state.wingPhase = Math.sin(sec * wingSpeed);
        this.state.skirtSway = Math.sin(sec * (hoverSpeed * 1.1) + 0.4) * 4;
        this.state.hairSway = Math.sin(sec * (hoverSpeed * 0.95) - 0.2) * 2.5;
        this.state.antennaeSway = this.state.hairSway;

        // Blinking cycle every ~3.8s
        this.state.blinkTimer += dt;
        if (this.state.blinkTimer > 3.8 && this.state.emotion !== 'sleep') {
            this.state.blinkProgress = Math.sin((this.state.blinkTimer - 3.8) * Math.PI * 6.5);
            if (this.state.blinkTimer > 4.1) {
                this.state.blinkTimer = Math.random() * 0.6;
                this.state.blinkProgress = 0;
            }
        }

        // Update burst particles
        for (let i = this.burstParticles.length - 1; i >= 0; i--) {
            const p = this.burstParticles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.alpha -= p.decay;
            if (p.alpha <= 0) {
                this.burstParticles.splice(i, 1);
            }
        }

        // Update trail particles
        for (let i = this.trailParticles.length - 1; i >= 0; i--) {
            const p = this.trailParticles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.alpha -= p.decay;
            if (p.alpha <= 0) {
                this.trailParticles.splice(i, 1);
            }
        }

        // Idle stardust spawn behind fairy in flight or hover
        if (Math.random() < 0.2) {
            this.trailParticles.push({
                x: (Math.random() - 0.5) * 30,
                y: 18 + Math.random() * 8,
                vx: (Math.random() - 0.5) * 0.6,
                vy: Math.random() * 0.8 + 0.2,
                radius: Math.random() * 1.6 + 0.6,
                alpha: 0.75,
                decay: 0.025
            });
        }
    }

    _getColorPalette() {
        // Canonical fairy character palette: consistent lavender, royal purple, and soft pink
        const base = {
            // Principal Character Colors: Lavender & Royal Violet
            hair: '#d8b4fe',          // Ethereal soft lavender
            hairAccent: '#9333ea',    // Royal violet depth & shading
            hairShadow: '#581c87',    // Deep plum-violet shadow
            hairGloss: 'rgba(255, 255, 255, 0.85)',
            
            // Costume: Lavender & Violet Bodice with Soft Petal Pink Accents
            bodiceMain: '#7c3aed',    // Celestial violet
            bodiceShade: '#5b21b6',   // Deep violet shadow
            bodiceHighlight: '#c084fc',
            bodiceTrim: '#f472b6',    // Soft petal pink sweetheart neckline trim
            dress: 'rgba(168, 85, 247, 0.65)',      // Translucent lilac gossamer skirt
            dressInner: 'rgba(244, 114, 182, 0.55)', // Soft petal rose pink inner petal
            dressEdge: 'rgba(255, 255, 255, 0.85)',
            
            // Humanoid Anatomy: Smooth Radiant Porcelain Skin & Rosy Blushes
            skin: '#fff5f8',
            skinShade: '#fce7f3',
            skinContour: 'rgba(160, 110, 180, 0.42)', // Delicate crisp anatomical outline
            skinBlush: 'rgba(255, 120, 160, 0.5)',    // Rosy cheeks, elbows & fingertips
            
            // Expressive Eyes: Deep Celestial Violet/Indigo with Crisp Catchlights
            eyes: '#6366f1',
            eyesPupil: '#1e1b4b',
            
            // Gossamer Translucent Wings with Starlight Veins
            wingsInner: 'rgba(147, 197, 253, 0.52)',
            wingsOuter: 'rgba(196, 181, 253, 0.48)',
            wingsVein: 'rgba(255, 255, 255, 0.68)',
            
            // Celestial Accessories
            accent: '#ffd166',        // Starlight champagne gold tiara star, brooch, boot gems
            core: '#a855f7'           // Canonical celestial purple glow
        };

        // Emotion-specific ambient aura and magical lighting adjustments
        // The character's anatomy, hair, dress, and identity REMAIN 100% UNIFORM.
        switch (this.state.emotion) {
            case 'happy':
            case 'pet':
                return {
                    ...base,
                    aura: 'rgba(244, 114, 182, 0.35)', // Warm joyful petal-pink starlight aura
                    auraGlow: '#f472b6'
                };
            case 'speaking':
            case 'talking':
                return {
                    ...base,
                    aura: 'rgba(129, 140, 248, 0.32)', // Resonant celestial blue-violet pulse
                    auraGlow: '#818cf8'
                };
            case 'listening':
                return {
                    ...base,
                    aura: 'rgba(192, 132, 252, 0.34)', // Attentive luminous lilac halo
                    auraGlow: '#c084fc'
                };
            case 'thinking':
            case 'focused':
                return {
                    ...base,
                    aura: 'rgba(147, 197, 253, 0.32)', // Focused starlight glow
                    auraGlow: '#93c5fd'
                };
            case 'working':
                return {
                    ...base,
                    aura: 'rgba(168, 85, 247, 0.35)',
                    auraGlow: '#a855f7'
                };
            case 'worried':
                return {
                    ...base,
                    aura: 'rgba(168, 162, 186, 0.22)', // Gentle muted aura
                    auraGlow: '#94a3b8'
                };
            case 'curious':
                return {
                    ...base,
                    aura: 'rgba(253, 224, 71, 0.32)',  // Inquisitive warm star sparkle
                    auraGlow: '#fde047'
                };
            case 'magic':
                return {
                    ...base,
                    aura: 'rgba(250, 204, 21, 0.42)',  // Radiant golden spellcasting aura
                    auraGlow: '#facc15'
                };
            case 'sleep':
                return {
                    ...base,
                    aura: 'rgba(148, 163, 184, 0.16)', // Serene soft moonlight
                    auraGlow: '#64748b'
                };
            case 'surprised':
                return {
                    ...base,
                    aura: 'rgba(254, 240, 138, 0.38)', // Luminous wide-eyed starlight halo
                    auraGlow: '#fef08a'
                };
            default: // idle
                return {
                    ...base,
                    aura: 'rgba(168, 85, 247, 0.24)', // Serene celestial violet aura
                    auraGlow: '#a855f7'
                };
        }
    }

    _render(time) {
        if (!this.ctx || !this.canvas) return;
        const dpr = this.dpr || 1;
        const logicalW = this.logicalWidth || (this.canvas.width / dpr);
        const logicalH = this.logicalHeight || (this.canvas.height / dpr);

        // 1. Reset canvas transform to identity, then scale by DPR exactly once
        if (typeof this.ctx.setTransform === 'function') {
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } else if (typeof this.ctx.resetTransform === 'function') {
            this.ctx.resetTransform();
            if (typeof this.ctx.scale === 'function' && dpr !== 1) {
                this.ctx.scale(dpr, dpr);
            }
        }

        // 2. Clear entire logical canvas bounds
        this.ctx.clearRect(0, 0, logicalW, logicalH);

        const cx = logicalW / 2;
        const cy = logicalH * 0.52 + this.state.hoverPhase + this.state.transitionOffset;
        const palette = this._getColorPalette();

        // Calculate deterministic scale factor based on LOGICAL dimensions
        // Base coordinate reference is 240x220 as designed for the fairy's vector paths
        const baseScale = Math.min(logicalW / 240, logicalH / 220);

        this.ctx.save();
        try {
            if (this.state.opacity < 1) {
                this.ctx.globalAlpha = Math.max(0, this.state.opacity);
            }

            // Apply scale & spin transformations during special actions
            const fx = cx + (this.state.flightOffsetX || 0);
            this.ctx.translate(fx, cy);
            this.ctx.scale(baseScale, baseScale * (this.state.scaleY || 1));

            const totalRotation = (this.state.spinAngle || 0) + (this.state.somersaultAngle || 0);
            if (totalRotation !== 0) {
                this.ctx.rotate(totalRotation);
            }

            // 1. Draw Orbiting Star Particles (scaled relative to character)
            this._renderOrbitParticles(palette, time);

            // 2. Draw Trailing Stardust Ribbon
            this._renderTrailingParticles();

            // 3. Multi-Layered Gossamer Fairy Wings (Drawn behind body)
            this._renderFairyWings(palette);

            // 4. Ethereal Soft Outer Aura
            this._renderSoftAura(palette);

            // 5. Back Hair Volume (Soft feminine silhouette framing head & shoulders)
            this._renderBackHair(palette);

            // 6. Slender Porcelain Legs & Delicate Fairy Boots (Drawn before skirt)
            this._renderFairyLegsAndBoots(palette);

            // 7. Petite Fairy Dress / Multi-Layered Petal Skirt
            this._renderPetalDress(palette);

            // 8. Slender Porcelain Neck & Defined Feminine Shoulders
            this._renderFairyNeckAndShoulders(palette);

            // 9. Fitted Magical Bodice & Glowing Star Brooch
            this._renderFairyBodice(palette);

            // 10. Cute Rounded Chibi Head & Luminous Porcelain Face
            this._renderFairyHead(palette);

            // 11. Pointed Fairy Elf Ears with Soft Blush
            this._renderFairyEars(palette);

            // 12. Soft Celestial Hair: Layered Bangs & Floating Side Curls
            this._renderFairyHair(palette);

            // 13. Delicate Starlight Tiara / Circlet with Glowing Star Crystal
            this._renderFairyTiara(palette);

            // 14. Expressive Chibi/Anime Eyes with Look-At Tracking & Blinking
            this._renderFairyEyes(palette);

            // 15. Rosy Cheeks, Cute Petite Nose & Animated Speaking Mouth
            this._renderCheeksAndMouth(palette, time);

            // 16. Slender Humanoid Arms & Clearly Visible Delicate Fairy Hands (Front layer)
            this._renderFairyArmsAndHands(palette);

            // 17. Draw Burst Particles (Hearts / Sparkles from Pet or Magic)
            this._renderBurstParticles();
        } finally {
            this.ctx.restore();
            // Deterministic transform reset ensures no transform persists across frames
            if (typeof this.ctx.setTransform === 'function') {
                this.ctx.setTransform(1, 0, 0, 1, 0, 0);
            } else if (typeof this.ctx.resetTransform === 'function') {
                this.ctx.resetTransform();
            }
        }
    }

    _renderOrbitParticles(palette, time) {
        const sec = time / 1000;
        for (const p of this.orbitParticles) {
            p.angle += p.speed;
            const px = Math.cos(p.angle) * p.distance;
            const py = Math.sin(p.angle) * (p.distance * 0.44);
            const pulse = (Math.sin(sec * p.pulseSpeed + p.angle) + 1) * 0.5;

            this.ctx.beginPath();
            this.ctx.arc(px, py, p.radius * (0.8 + pulse * 0.4), 0, Math.PI * 2);
            this.ctx.fillStyle = p.radius > 1.4 ? palette.accent : palette.aura;
            this.ctx.globalAlpha = p.alpha * (0.35 + pulse * 0.5) * this.state.opacity;
            this.ctx.fill();
        }
        this.ctx.globalAlpha = this.state.opacity;
    }

    _renderTrailingParticles() {
        for (const p of this.trailParticles) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffd166';
            this.ctx.globalAlpha = Math.max(0, p.alpha * this.state.opacity);
            this.ctx.shadowColor = '#ffd166';
            this.ctx.shadowBlur = 5;
            this.ctx.fill();
            this.ctx.restore();
        }
    }

    _renderFairyWings(palette) {
        this.ctx.save();
        this.ctx.translate(0, -6);

        const wingSpread = 1 + this.state.wingPhase * 0.15;
        const wingFlapY = Math.sin(this.state.wingPhase * 0.8) * 3.5;

        // Left Wing Pair
        this._drawWingPair(-1, wingSpread, wingFlapY, palette);

        // Right Wing Pair
        this._drawWingPair(1, wingSpread, wingFlapY, palette);

        this.ctx.restore();
    }

    _drawWingPair(side, spread, flapY, palette) {
        this.ctx.save();
        this.ctx.scale(side, 1);

        // --- Upper Primary Gossamer Fairy Wing ---
        const upperGrad = this.ctx.createLinearGradient(0, -8, 48 * spread, -38);
        upperGrad.addColorStop(0, palette.wingsInner);
        upperGrad.addColorStop(0.55, palette.wingsOuter);
        upperGrad.addColorStop(0.9, 'rgba(255, 255, 255, 0.75)');
        upperGrad.addColorStop(1, 'rgba(255, 209, 102, 0.6)');

        this.ctx.beginPath();
        this.ctx.moveTo(6, -6);
        // Graceful swept arch reaching up and outward like a delicate fairy butterfly wing
        this.ctx.bezierCurveTo(18, -34 + flapY, 48 * spread, -50 + flapY, 52 * spread, -24 + flapY);
        // Delicate scalloped outer curve
        this.ctx.bezierCurveTo(54 * spread, -6, 44 * spread, 4, 22, 3);
        this.ctx.bezierCurveTo(14, 2, 8, -2, 6, -6);
        this.ctx.fillStyle = upperGrad;
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 10;
        this.ctx.fill();

        // Delicate stardust wing veins
        this.ctx.beginPath();
        this.ctx.moveTo(6, -6);
        this.ctx.quadraticCurveTo(28 * spread, -22 + flapY, 46 * spread, -24 + flapY);
        this.ctx.moveTo(18 * spread, -18 + flapY * 0.6);
        this.ctx.quadraticCurveTo(34 * spread, -36 + flapY * 0.8, 42 * spread, -40 + flapY);
        this.ctx.moveTo(24 * spread, -12 + flapY * 0.4);
        this.ctx.quadraticCurveTo(38 * spread, -4 + flapY * 0.4, 46 * spread, -10 + flapY);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        this.ctx.lineWidth = 0.9;
        this.ctx.stroke();

        // Sparkle gem at upper wing tip
        this.ctx.beginPath();
        this.ctx.arc(52 * spread, -24 + flapY, 1.8, 0, Math.PI * 2);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = '#ffd166';
        this.ctx.shadowBlur = 6;
        this.ctx.fill();

        // --- Lower Secondary Gossamer Wing ---
        const lowerGrad = this.ctx.createLinearGradient(0, 2, 32 * spread, 26);
        lowerGrad.addColorStop(0, palette.wingsInner);
        lowerGrad.addColorStop(0.7, palette.wingsOuter);
        lowerGrad.addColorStop(1, 'rgba(255, 255, 255, 0.5)');

        this.ctx.beginPath();
        this.ctx.moveTo(6, 1);
        this.ctx.bezierCurveTo(18, 10, 36 * spread, 28 + flapY * 0.4, 28 * spread, 34);
        this.ctx.bezierCurveTo(18 * spread, 36, 10, 16, 6, 1);
        this.ctx.fillStyle = lowerGrad;
        this.ctx.shadowBlur = 6;
        this.ctx.fill();

        // Lower wing vein
        this.ctx.beginPath();
        this.ctx.moveTo(6, 1);
        this.ctx.quadraticCurveTo(18 * spread, 18, 24 * spread, 30);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();

        this.ctx.restore();
    }

    _renderSoftAura(palette) {
        // Restrained ethereal aura (subtle, non-blinding starlight glow)
        const auraGrad = this.ctx.createRadialGradient(0, -6, 10, 0, -6, 48);
        auraGrad.addColorStop(0, palette.aura ? palette.aura.replace(/[\d.]+\)$/, '0.18)') : 'rgba(112, 214, 255, 0.18)');
        auraGrad.addColorStop(0.65, palette.aura ? palette.aura.replace(/[\d.]+\)$/, '0.04)') : 'rgba(112, 214, 255, 0.04)');
        auraGrad.addColorStop(1, 'transparent');

        this.ctx.beginPath();
        this.ctx.arc(0, -6, 48, 0, Math.PI * 2);
        this.ctx.fillStyle = auraGrad;
        this.ctx.fill();
    }

    _renderBackHair(palette) {
        // Soft back hair volume that gives a cute, lush chibi fairy silhouette
        this.ctx.save();
        const backHairGrad = this.ctx.createRadialGradient(0, -22, 6, 0, -18, 36);
        backHairGrad.addColorStop(0, palette.hair);
        backHairGrad.addColorStop(0.7, palette.hairAccent || '#9d4edd');
        backHairGrad.addColorStop(1, 'rgba(40, 20, 60, 0.8)');

        this.ctx.beginPath();
        this.ctx.ellipse(0, -22, 28, 30, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = backHairGrad;
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 6;
        this.ctx.fill();
        this.ctx.restore();
    }

    _renderFairyLegsAndBoots(palette) {
        this.ctx.save();
        const sway = this.state.skirtSway * 0.4;

        // Render pair of slender humanoid legs: Left leg (-1) and Right leg (1)
        [-1, 1].forEach((side) => {
            const lx = side * 5.5 + sway * 0.3;
            const kneeY = 30;
            const ankleY = 40;
            const bootY = 46;

            // --- Porcelain Leg (Thigh to Ankle) ---
            const legGrad = this.ctx.createLinearGradient(lx, 18, lx, ankleY);
            legGrad.addColorStop(0, '#ffffff');
            legGrad.addColorStop(0.5, '#fff6f8');
            legGrad.addColorStop(1, '#fce7f3');

            this.ctx.beginPath();
            // Thigh
            this.ctx.moveTo(lx - 2.8, 18);
            // Slender knee contour
            this.ctx.quadraticCurveTo(lx - 3.0, kneeY - 3, lx - 2.2, kneeY);
            // Slender calf and ankle
            this.ctx.quadraticCurveTo(lx - 2.5, (kneeY + ankleY) / 2, lx - 1.8, ankleY);
            this.ctx.lineTo(lx + 1.8, ankleY);
            this.ctx.quadraticCurveTo(lx + 2.5, (kneeY + ankleY) / 2, lx + 2.2, kneeY);
            this.ctx.quadraticCurveTo(lx + 3.0, kneeY - 3, lx + 2.8, 18);
            this.ctx.closePath();
            this.ctx.fillStyle = legGrad;
            this.ctx.fill();

            // Subtle cute pink blush on knee
            this.ctx.beginPath();
            this.ctx.arc(lx, kneeY, 1.6, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(255, 133, 161, 0.35)';
            this.ctx.fill();

            // --- Delicate Fairy Boot / Slipper ---
            const bootGrad = this.ctx.createLinearGradient(lx, ankleY - 2, lx, bootY + 2);
            bootGrad.addColorStop(0, '#a855f7');  // Bright celestial lavender cuff
            bootGrad.addColorStop(0.4, '#7c3aed'); // Royal violet boot body
            bootGrad.addColorStop(1, '#4c1d95');  // Deep plum violet sole & toe

            this.ctx.beginPath();
            // Boot cuff with gentle petal flare
            this.ctx.moveTo(lx - 3.4, ankleY - 1.5);
            this.ctx.lineTo(lx + 3.4, ankleY - 1.5);
            this.ctx.quadraticCurveTo(lx + 3.6, ankleY + 3, lx + 2.6, bootY - 1.5);
            // Pointed fairy slipper toe arching slightly forward
            this.ctx.quadraticCurveTo(lx + side * 1.8, bootY + 2.2, lx, bootY + 2.4);
            this.ctx.quadraticCurveTo(lx - side * 1.8, bootY, lx - 2.6, bootY - 1.5);
            this.ctx.quadraticCurveTo(lx - 3.6, ankleY + 3, lx - 3.4, ankleY - 1.5);
            this.ctx.closePath();
            this.ctx.fillStyle = bootGrad;
            this.ctx.fill();
            this.ctx.strokeStyle = 'rgba(255, 209, 102, 0.75)'; // Starlight gold rim trim
            this.ctx.lineWidth = 0.8;
            this.ctx.stroke();

            // Tiny golden star crystal on boot cuff
            this.ctx.beginPath();
            this.ctx.arc(lx, ankleY - 0.5, 1.4, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffd166';
            this.ctx.shadowColor = '#ffd166';
            this.ctx.shadowBlur = 4;
            this.ctx.fill();

            // Delicate starlight highlight on boot toe
            this.ctx.beginPath();
            this.ctx.arc(lx, bootY + 0.8, 0.8, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            this.ctx.fill();
        });

        this.ctx.restore();
    }

    _renderPetalDress(palette) {
        this.ctx.save();
        this.ctx.translate(0, 13);
        const sway = this.state.skirtSway;

        // Outer translucent layered petal skirt in celestial lilac
        const petalGrad = this.ctx.createLinearGradient(0, 0, 0, 18);
        petalGrad.addColorStop(0, palette.dress);
        petalGrad.addColorStop(0.55, 'rgba(216, 180, 254, 0.65)');
        petalGrad.addColorStop(1, palette.dressEdge);

        // Inner soft petal pink lining
        const innerPetalGrad = this.ctx.createLinearGradient(0, 0, 0, 16);
        innerPetalGrad.addColorStop(0, palette.dressInner);
        innerPetalGrad.addColorStop(1, 'rgba(255, 235, 245, 0.8)');

        // Deep Back Layer Petal
        this.ctx.beginPath();
        this.ctx.moveTo(-6, 0);
        this.ctx.quadraticCurveTo(-15 + sway * 0.7, 9, -7 + sway, 17.5);
        this.ctx.quadraticCurveTo(0, 14, 7 + sway, 17.5);
        this.ctx.quadraticCurveTo(15 + sway * 0.7, 9, 6, 0);
        this.ctx.closePath();
        this.ctx.fillStyle = 'rgba(126, 34, 206, 0.45)';
        this.ctx.fill();

        // Inner Rose Petal Flares
        this.ctx.beginPath();
        this.ctx.moveTo(-5, 0);
        this.ctx.quadraticCurveTo(-12 + sway * 0.8, 8, -6 + sway * 0.7, 16);
        this.ctx.quadraticCurveTo(0, 13, 6 + sway * 0.7, 16);
        this.ctx.quadraticCurveTo(12 + sway * 0.8, 8, 5, 0);
        this.ctx.closePath();
        this.ctx.fillStyle = innerPetalGrad;
        this.ctx.fill();

        // Left Flared Translucent Lilac Petal
        this.ctx.beginPath();
        this.ctx.moveTo(-7, 0);
        this.ctx.quadraticCurveTo(-18 + sway * 0.8, 7, -13 + sway, 16.5);
        this.ctx.quadraticCurveTo(-6 + sway * 0.5, 14, -1, 0);
        this.ctx.closePath();
        this.ctx.fillStyle = petalGrad;
        this.ctx.fill();

        // Right Flared Translucent Lilac Petal
        this.ctx.beginPath();
        this.ctx.moveTo(7, 0);
        this.ctx.quadraticCurveTo(18 + sway * 0.8, 7, 13 + sway, 16.5);
        this.ctx.quadraticCurveTo(6 + sway * 0.5, 14, 1, 0);
        this.ctx.closePath();
        this.ctx.fillStyle = petalGrad;
        this.ctx.fill();

        // Center Front Petal
        this.ctx.beginPath();
        this.ctx.moveTo(-4, 0);
        this.ctx.quadraticCurveTo(-9 + sway, 8, 0 + sway * 1.1, 16);
        this.ctx.quadraticCurveTo(9 + sway, 8, 4, 0);
        this.ctx.closePath();
        this.ctx.fillStyle = petalGrad;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderFairyNeckAndShoulders(palette) {
        this.ctx.save();
        // Slender porcelain neck connecting head to shoulders
        const neckGrad = this.ctx.createLinearGradient(0, -8, 0, 1);
        neckGrad.addColorStop(0, palette.skin);
        neckGrad.addColorStop(1, palette.skinShade);

        this.ctx.beginPath();
        this.ctx.moveTo(-3.5, -8);
        this.ctx.lineTo(-3.5, 1);
        this.ctx.lineTo(3.5, 1);
        this.ctx.lineTo(3.5, -8);
        this.ctx.closePath();
        this.ctx.fillStyle = neckGrad;
        this.ctx.fill();

        // Soft neck shadow under chin
        this.ctx.beginPath();
        this.ctx.moveTo(-3.5, -8);
        this.ctx.quadraticCurveTo(0, -5.5, 3.5, -8);
        this.ctx.lineTo(3.5, -4.5);
        this.ctx.quadraticCurveTo(0, -2.5, -3.5, -4.5);
        this.ctx.closePath();
        this.ctx.fillStyle = 'rgba(180, 130, 180, 0.28)';
        this.ctx.fill();

        // Defined feminine shoulders spanning gracefully from x = -13.5 to +13.5
        this.ctx.beginPath();
        this.ctx.ellipse(0, 1.5, 13.5, 3.5, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.skin;
        this.ctx.fill();

        // Soft anatomical contour line along shoulders
        this.ctx.beginPath();
        this.ctx.ellipse(0, 1.5, 13.5, 3.5, 0, 0, Math.PI * 2);
        this.ctx.strokeStyle = palette.skinContour;
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();

        this.ctx.restore();
    }

    _renderFairyBodice(palette) {
        this.ctx.save();
        // Fitted feminine bodice tapering to slender fairy waist
        const bodiceGrad = this.ctx.createLinearGradient(0, 0, 0, 13);
        bodiceGrad.addColorStop(0, '#ffffff');
        bodiceGrad.addColorStop(0.2, palette.bodiceHighlight);
        bodiceGrad.addColorStop(0.65, palette.bodiceMain);
        bodiceGrad.addColorStop(1, palette.bodiceShade);

        this.ctx.beginPath();
        // Sweetheart neckline at top of chest
        this.ctx.moveTo(-11.5, 1.5);
        this.ctx.quadraticCurveTo(-5.5, 4.5, 0, 3.0);
        this.ctx.quadraticCurveTo(5.5, 4.5, 11.5, 1.5);
        // Taper gracefully inward to slender fairy waist at y=13
        this.ctx.quadraticCurveTo(9.5, 7.5, 7.5, 13);
        this.ctx.lineTo(-7.5, 13);
        this.ctx.quadraticCurveTo(-9.5, 7.5, -11.5, 1.5);
        this.ctx.closePath();
        this.ctx.fillStyle = bodiceGrad;
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 4;
        this.ctx.fill();

        // Soft petal pink sweetheart trim along neckline
        this.ctx.beginPath();
        this.ctx.moveTo(-11.5, 1.5);
        this.ctx.quadraticCurveTo(-5.5, 4.5, 0, 3.0);
        this.ctx.quadraticCurveTo(5.5, 4.5, 11.5, 1.5);
        this.ctx.strokeStyle = palette.bodiceTrim;
        this.ctx.lineWidth = 1.4;
        this.ctx.stroke();

        // Delicate golden filigree / corset seam lines
        this.ctx.beginPath();
        this.ctx.moveTo(0, 3.5);
        this.ctx.lineTo(0, 13);
        this.ctx.moveTo(-4, 4.5);
        this.ctx.lineTo(-3, 13);
        this.ctx.moveTo(4, 4.5);
        this.ctx.lineTo(3, 13);
        this.ctx.strokeStyle = 'rgba(255, 209, 102, 0.65)';
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();

        // Glowing Star Brooch / Heart Gem at center chest
        this.ctx.beginPath();
        this.ctx.arc(0, 4.5, 2.6, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.accent;
        this.ctx.shadowColor = palette.accent;
        this.ctx.shadowBlur = 6;
        this.ctx.fill();

        // Golden waist belt band
        this.ctx.beginPath();
        this.ctx.moveTo(-8, 12.5);
        this.ctx.lineTo(8, 12.5);
        this.ctx.strokeStyle = palette.accent;
        this.ctx.lineWidth = 1.4;
        this.ctx.stroke();

        this.ctx.restore();
    }

    _renderFairyArmsAndHands(palette) {
        const isRaised = (this.state.emotion === 'pet' || this.state.emotion === 'magic' || this.state.emotion === 'trick_jump');
        const isGesturing = (this.state.emotion === 'speaking' || this.state.emotion === 'talking' || this.state.emotion === 'thinking' || this.state.emotion === 'listening' || this.state.emotion === 'curious' || this.state.emotion === 'surprised');
        const isDancing = (this.state.emotion === 'trick_dance');

        if (isDancing) {
            const wave = this.state.danceArmWave || 0;
            if (wave > 0.2) {
                this._drawArmAndHand(-1, 'raised', palette);
                this._drawArmAndHand(1, 'gesturing', palette);
            } else if (wave < -0.2) {
                this._drawArmAndHand(-1, 'gesturing', palette);
                this._drawArmAndHand(1, 'raised', palette);
            } else {
                this._drawArmAndHand(-1, 'raised', palette);
                this._drawArmAndHand(1, 'raised', palette);
            }
        } else if (isRaised) {
            // Both arms joyfully raised celebrating or casting magic
            this._drawArmAndHand(-1, 'raised', palette);
            this._drawArmAndHand(1, 'raised', palette);
        } else if (isGesturing) {
            // Expressive gesture: left arm resting at waist, right arm gesturing toward chest/chin
            this._drawArmAndHand(-1, 'resting', palette);
            this._drawArmAndHand(1, 'gesturing', palette);
        } else {
            // Natural resting pose: both arms curve gracefully to waist, hands softly meeting in front
            this._drawArmAndHand(-1, 'resting', palette);
            this._drawArmAndHand(1, 'resting', palette);
        }
    }

    _drawArmAndHand(side, pose, palette) {
        this.ctx.save();
        this.ctx.scale(side, 1);

        const skinGrad = this.ctx.createLinearGradient(10, 0, 19, 15);
        skinGrad.addColorStop(0, '#ffffff');
        skinGrad.addColorStop(0.4, palette.skin);
        skinGrad.addColorStop(1, palette.skinShade);

        if (pose === 'raised') {
            // --- Raised Celebration / Pet / Magic Pose ---
            // 1. Off-shoulder petal puff sleeve at shoulder
            this._drawSleevePuff(palette);

            // 2. Volumetric Upper arm & Forearm reaching joyfully up and outward
            this.ctx.beginPath();
            // Shoulder connection
            this.ctx.moveTo(11.2, 1.5);
            // Inner arm contour
            this.ctx.quadraticCurveTo(13.8, -2.5, 14.5, -11.0);
            this.ctx.lineTo(18.0, -11.5);
            // Outer elbow and shoulder contour (pronounced elbow curve at x = 20.8)
            this.ctx.quadraticCurveTo(20.8, -3.5, 14.8, 2.5);
            this.ctx.closePath();
            this.ctx.fillStyle = skinGrad;
            this.ctx.fill();
            this.ctx.strokeStyle = palette.skinContour;
            this.ctx.lineWidth = 0.9;
            this.ctx.stroke();

            // Elbow blush
            this.ctx.beginPath();
            this.ctx.arc(18.5, -3.5, 1.8, 0, Math.PI * 2);
            this.ctx.fillStyle = palette.skinBlush;
            this.ctx.fill();

            // Wrist starlight bracelet
            this.ctx.beginPath();
            this.ctx.moveTo(14.2, -11.0);
            this.ctx.lineTo(18.2, -11.5);
            this.ctx.strokeStyle = palette.accent;
            this.ctx.lineWidth = 1.4;
            this.ctx.stroke();

            // 3. Open delicate fairy hand with 5 visible outstretched fingers
            this._drawOpenHand(16.2, -12.0, palette);

        } else if (pose === 'gesturing') {
            // --- Conversational Gesture Pose (tilted hand near chest/chin) ---
            this._drawSleevePuff(palette);

            // Arm curving forward and up toward chest
            this.ctx.beginPath();
            this.ctx.moveTo(11.2, 1.5);
            this.ctx.quadraticCurveTo(18.5, 4.5, 17.5, 8.5); // Elbow outward
            this.ctx.quadraticCurveTo(13.5, 10.5, 6.8, 7.8);  // Forearm in toward chest
            this.ctx.lineTo(5.6, 5.0);                       // Wrist
            this.ctx.quadraticCurveTo(11.2, 6.8, 14.8, 5.2);
            this.ctx.quadraticCurveTo(15.5, 2.2, 12.8, 1.2);
            this.ctx.closePath();
            this.ctx.fillStyle = skinGrad;
            this.ctx.fill();
            this.ctx.strokeStyle = palette.skinContour;
            this.ctx.lineWidth = 0.9;
            this.ctx.stroke();

            // Elbow blush
            this.ctx.beginPath();
            this.ctx.arc(17.5, 8.0, 1.6, 0, Math.PI * 2);
            this.ctx.fillStyle = palette.skinBlush;
            this.ctx.fill();

            // Wrist bracelet
            this.ctx.beginPath();
            this.ctx.moveTo(5.6, 5.0);
            this.ctx.lineTo(6.8, 7.8);
            this.ctx.strokeStyle = palette.accent;
            this.ctx.lineWidth = 1.3;
            this.ctx.stroke();

            // Delicate gesturing hand with thumb and articulated fingers
            this._drawGesturingHand(6.0, 6.2, palette);

        } else {
            // --- Natural Feminine Resting Pose ---
            // 1. Off-shoulder petal puff sleeve at shoulder
            this._drawSleevePuff(palette);

            // 2. Volumetric Upper arm & Forearm curving gracefully from shoulder to waist
            // Creates wide negative space between torso (x = 7.5) and elbow (x = 19.5)
            this.ctx.beginPath();
            // Shoulder attachment (x = 11.5, y = 2.0)
            this.ctx.moveTo(11.5, 2.0);
            // Outer upper arm sweeping down and outward to elbow at (x = 19.8, y = 9.5)
            this.ctx.bezierCurveTo(15.8, 3.5, 19.8, 6.2, 19.8, 9.5);
            // Outer forearm sweeping inward to wrist at (x = 8.0, y = 16.2)
            this.ctx.bezierCurveTo(19.2, 12.5, 14.5, 15.5, 8.2, 16.2);
            // Wrist outer edge
            this.ctx.lineTo(7.2, 13.5);
            // Inner forearm sweeping back to inner elbow at (x = 15.2, y = 8.8)
            this.ctx.bezierCurveTo(11.5, 13.0, 14.8, 11.0, 15.2, 8.8);
            // Inner upper arm returning to armpit/shoulder at (x = 10.2, y = 3.0)
            this.ctx.bezierCurveTo(15.2, 6.0, 12.8, 3.8, 10.2, 3.0);
            this.ctx.closePath();
            this.ctx.fillStyle = skinGrad;
            this.ctx.fill();
            this.ctx.strokeStyle = palette.skinContour;
            this.ctx.lineWidth = 0.9;
            this.ctx.stroke();

            // Delicate rosy blush on outer elbow curve
            this.ctx.beginPath();
            this.ctx.arc(19.2, 9.5, 2.0, 0, Math.PI * 2);
            this.ctx.fillStyle = palette.skinBlush;
            this.ctx.fill();

            // Wrist gold bracelet accent
            this.ctx.beginPath();
            this.ctx.moveTo(8.2, 16.2);
            this.ctx.lineTo(7.2, 13.5);
            this.ctx.strokeStyle = palette.accent;
            this.ctx.lineWidth = 1.3;
            this.ctx.stroke();

            // 3. Sculpted humanoid hand with thumb and 4 distinct fingers resting on skirt
            this._drawRestingHand(7.8, 15.0, palette);
        }

        this.ctx.restore();
    }

    _drawSleevePuff(palette) {
        // Delicate translucent petal puff sleeve at shoulder joint
        this.ctx.save();
        const puffGrad = this.ctx.createRadialGradient(11.8, 2.2, 1, 11.8, 2.2, 5.0);
        puffGrad.addColorStop(0, '#ffffff');
        puffGrad.addColorStop(0.5, 'rgba(216, 180, 254, 0.75)');
        puffGrad.addColorStop(1, 'rgba(244, 114, 182, 0.55)');

        this.ctx.beginPath();
        this.ctx.ellipse(11.8, 2.4, 4.4, 3.0, Math.PI / 6, 0, Math.PI * 2);
        this.ctx.fillStyle = puffGrad;
        this.ctx.fill();
        this.ctx.strokeStyle = 'rgba(255, 209, 102, 0.65)';
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();
        this.ctx.restore();
    }

    _drawRestingHand(wx, wy, palette) {
        this.ctx.save();
        this.ctx.translate(wx, wy);

        // 1. Palm volume gently angling inward toward center
        this.ctx.beginPath();
        this.ctx.moveTo(0, -1.2);
        this.ctx.quadraticCurveTo(-2.2, -1.8, -4.2, -0.6); // Thumb base
        this.ctx.quadraticCurveTo(-4.8, 1.2, -3.8, 2.8);   // Knuckle ridge
        this.ctx.quadraticCurveTo(-2.0, 3.2, -0.4, 2.2);   // Lower palm
        this.ctx.quadraticCurveTo(0.2, 1.2, 0, -1.2);
        this.ctx.closePath();
        this.ctx.fillStyle = palette.skin;
        this.ctx.fill();
        this.ctx.strokeStyle = palette.skinContour;
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();

        // 2. Distinct opposing thumb branching along upper edge with cute nail highlight
        this.ctx.beginPath();
        this.ctx.moveTo(-1.6, -1.0);
        this.ctx.quadraticCurveTo(-3.2, -2.6, -4.8, -1.8);
        this.ctx.quadraticCurveTo(-5.4, -1.0, -4.2, -0.2);
        this.ctx.lineTo(-2.2, 0.0);
        this.ctx.closePath();
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fill();
        this.ctx.strokeStyle = palette.skinContour;
        this.ctx.lineWidth = 0.7;
        this.ctx.stroke();

        // Thumb rosy tip
        this.ctx.beginPath();
        this.ctx.arc(-4.6, -1.4, 0.9, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.skinBlush;
        this.ctx.fill();

        // 3. Four clearly sculpted individual fingers (Index, Middle, Ring, Pinky)
        // Index Finger
        this._drawArticulatedFinger(-3.6, -0.2, -6.8, -0.2, 1.3, palette);
        // Middle Finger (slightly longer)
        this._drawArticulatedFinger(-3.4, 0.9, -7.4, 0.9, 1.3, palette);
        // Ring Finger
        this._drawArticulatedFinger(-3.0, 2.0, -6.8, 2.1, 1.2, palette);
        // Pinky Finger (cute petite outer finger)
        this._drawArticulatedFinger(-2.4, 2.9, -5.6, 3.1, 1.1, palette);

        // Subtle catchlight on knuckles
        this.ctx.beginPath();
        this.ctx.arc(-2.4, 0.8, 0.7, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        this.ctx.fill();

        this.ctx.restore();
    }

    _drawArticulatedFinger(x1, y1, x2, y2, width, palette) {
        // Finger base to tip with rounded cap
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.strokeStyle = palette.skin;
        this.ctx.lineWidth = width * 1.5;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        // Contour outline
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.strokeStyle = palette.skinContour;
        this.ctx.lineWidth = 0.65;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        // Rosy blush on fingertip
        this.ctx.beginPath();
        this.ctx.arc(x2, y2, width * 0.75, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.skinBlush;
        this.ctx.fill();

        // Delicate white nail highlight
        this.ctx.beginPath();
        this.ctx.arc(x2 - 0.2, y2 - 0.2, width * 0.35, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        this.ctx.fill();
    }

    _drawOpenHand(wx, wy, palette) {
        this.ctx.save();
        this.ctx.translate(wx, wy);

        // Palm
        this.ctx.beginPath();
        this.ctx.ellipse(0, -2.5, 3.0, 2.5, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.skin;
        this.ctx.fill();
        this.ctx.strokeStyle = palette.skinContour;
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();

        // Palm blush
        this.ctx.beginPath();
        this.ctx.arc(0, -2.5, 1.4, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.skinBlush;
        this.ctx.fill();

        // 5 Outstretched delicate fairy fingers pointing up and outward
        // Thumb (inner side)
        this._drawArticulatedFinger(-2.2, -1.8, -4.8, -4.2, 1.3, palette);
        // Index finger
        this._drawArticulatedFinger(-1.6, -3.6, -3.2, -9.0, 1.2, palette);
        // Middle finger (longest)
        this._drawArticulatedFinger(0.0, -4.2, 0.0, -10.5, 1.2, palette);
        // Ring finger
        this._drawArticulatedFinger(1.6, -3.8, 2.8, -9.2, 1.1, palette);
        // Pinky (outer)
        this._drawArticulatedFinger(2.6, -2.4, 4.6, -6.6, 1.0, palette);

        // Luminous magic starlight spark at middle fingertip
        this.ctx.beginPath();
        this.ctx.arc(0, -11.0, 1.4, 0, Math.PI * 2);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = palette.accent;
        this.ctx.shadowBlur = 5;
        this.ctx.fill();

        this.ctx.restore();
    }

    _drawGesturingHand(wx, wy, palette) {
        this.ctx.save();
        this.ctx.translate(wx, wy);

        // Palm tilted upward gracefully toward chest
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.quadraticCurveTo(-2.4, -1.8, -3.8, -1.2);
        this.ctx.quadraticCurveTo(-4.8, -3.2, -3.8, -4.8);
        this.ctx.quadraticCurveTo(-1.8, -4.0, 0, -1.5);
        this.ctx.closePath();
        this.ctx.fillStyle = palette.skin;
        this.ctx.fill();
        this.ctx.strokeStyle = palette.skinContour;
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();

        // Opposing thumb
        this.ctx.beginPath();
        this.ctx.moveTo(-1.4, -0.6);
        this.ctx.quadraticCurveTo(-3.0, -0.8, -3.8, 0.4);
        this.ctx.lineTo(-2.4, 0.8);
        this.ctx.closePath();
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fill();
        this.ctx.strokeStyle = palette.skinContour;
        this.ctx.lineWidth = 0.65;
        this.ctx.stroke();

        // Articulated gesturing fingers pointing up toward chin
        this._drawArticulatedFinger(-2.8, -2.0, -4.2, -6.5, 1.2, palette);
        this._drawArticulatedFinger(-1.8, -2.0, -2.8, -5.8, 1.2, palette);
        this._drawArticulatedFinger(-1.0, -1.6, -1.8, -4.2, 1.1, palette);

        // Rosy blush on palm
        this.ctx.beginPath();
        this.ctx.arc(-2.5, -2.5, 1.4, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.skinBlush;
        this.ctx.fill();

        this.ctx.restore();
    }

    _drawFinger(x1, y1, x2, y2, width, palette) {
        // Compatibility alias pointing to _drawArticulatedFinger
        this._drawArticulatedFinger(x1, y1, x2, y2, width, palette);
    }

    _renderFairyTorso(palette) {
        // Compatibility alias: renders both neck/shoulders and fitted bodice
        this._renderFairyNeckAndShoulders(palette);
        this._renderFairyBodice(palette);
    }

    _renderFairyHead(palette) {
        this.ctx.save();
        const headY = -20;

        // Cute rounded chibi head with gentle chin contour and porcelain skin
        const headGrad = this.ctx.createRadialGradient(-4, headY - 5, 4, 0, headY, 26);
        headGrad.addColorStop(0, '#ffffff');
        headGrad.addColorStop(0.55, '#fff6f8');
        headGrad.addColorStop(0.85, '#faeaf4');
        headGrad.addColorStop(1, 'rgba(190, 150, 210, 0.35)');

        this.ctx.beginPath();
        // Head outline with cute tapered jaw and rounded chin
        this.ctx.moveTo(-22, headY - 6);
        this.ctx.bezierCurveTo(-23, headY + 10, -12, headY + 18, 0, headY + 18);
        this.ctx.bezierCurveTo(12, headY + 18, 23, headY + 10, 22, headY - 6);
        this.ctx.bezierCurveTo(22, headY - 22, -22, headY - 22, -22, headY - 6);
        this.ctx.closePath();
        this.ctx.fillStyle = headGrad;
        this.ctx.shadowColor = 'rgba(255, 210, 230, 0.35)';
        this.ctx.shadowBlur = 8;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderFairyEars(palette) {
        this.ctx.save();
        const headY = -20;

        // Delicate pointed elf/fairy ears peeking gracefully from sides
        [-1, 1].forEach((side) => {
            this.ctx.beginPath();
            this.ctx.moveTo(side * 20, headY - 2);
            this.ctx.quadraticCurveTo(side * 26, headY - 5, side * 28, headY - 8);
            this.ctx.quadraticCurveTo(side * 25, headY + 2, side * 20, headY + 4);
            this.ctx.closePath();
            this.ctx.fillStyle = '#fff0f5';
            this.ctx.fill();

            // Soft inner ear blush
            this.ctx.beginPath();
            this.ctx.moveTo(side * 21, headY - 1);
            this.ctx.quadraticCurveTo(side * 24, headY - 3, side * 26, headY - 5);
            this.ctx.quadraticCurveTo(side * 23, headY + 1, side * 21, headY + 2);
            this.ctx.closePath();
            this.ctx.fillStyle = 'rgba(255, 133, 161, 0.55)';
            this.ctx.fill();

            // Tiny pearl earring
            this.ctx.beginPath();
            this.ctx.arc(side * 21.5, headY + 4, 1.3, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffffff';
            this.ctx.shadowColor = palette.accent;
            this.ctx.shadowBlur = 4;
            this.ctx.fill();
        });

        this.ctx.restore();
    }

    _renderFairyHair(palette) {
        this.ctx.save();
        const headY = -20;
        const sway = this.state.hairSway;

        // Hair color gradients
        const hairGrad = this.ctx.createLinearGradient(0, headY - 26, 0, headY + 12);
        hairGrad.addColorStop(0, '#ffffff');
        hairGrad.addColorStop(0.3, palette.hair);
        hairGrad.addColorStop(1, palette.hairAccent || '#9d4edd');

        // Front Chibi Bangs: soft layered bangs swept gracefully across forehead
        this.ctx.beginPath();
        this.ctx.moveTo(-24, headY - 14);
        // Left side fringe
        this.ctx.quadraticCurveTo(-18, headY - 4, -12, headY - 8);
        // Center fringe
        this.ctx.quadraticCurveTo(-5, headY + 2, 2, headY - 8);
        // Right side fringe
        this.ctx.quadraticCurveTo(10, headY - 3, 24, headY - 14);
        // Hairline top arch
        this.ctx.quadraticCurveTo(0, headY - 32, -24, headY - 14);
        this.ctx.fillStyle = hairGrad;
        this.ctx.fill();

        // Delicate hair gloss highlight (angel ring shine)
        this.ctx.beginPath();
        this.ctx.arc(0, headY - 16, 20, 1.25 * Math.PI, 1.75 * Math.PI);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        this.ctx.lineWidth = 1.6;
        this.ctx.stroke();

        // Twin floating side fairy curls / locks with gentle spring physics
        // Left side curl
        this.ctx.beginPath();
        this.ctx.moveTo(-22, headY - 8);
        this.ctx.bezierCurveTo(-26 + sway, headY + 6, -28 + sway * 1.4, headY + 18, -22 + sway * 1.2, headY + 24);
        this.ctx.bezierCurveTo(-20 + sway, headY + 24, -22 + sway, headY + 12, -20, headY - 4);
        this.ctx.fillStyle = hairGrad;
        this.ctx.fill();

        // Right side curl
        this.ctx.beginPath();
        this.ctx.moveTo(22, headY - 8);
        this.ctx.bezierCurveTo(26 - sway, headY + 6, 28 - sway * 1.4, headY + 18, 22 - sway * 1.2, headY + 24);
        this.ctx.bezierCurveTo(20 - sway, headY + 24, 22 - sway, headY + 12, 20, headY - 4);
        this.ctx.fillStyle = hairGrad;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderFairyTiara(palette) {
        this.ctx.save();
        const headY = -20;

        // Delicate starlight fairy tiara / circlet resting in hair
        this.ctx.beginPath();
        this.ctx.arc(0, headY - 16, 22, 1.25 * Math.PI, 1.75 * Math.PI);
        this.ctx.strokeStyle = palette.accent || '#ffd166';
        this.ctx.lineWidth = 1.6;
        this.ctx.shadowColor = palette.accent || '#ffd166';
        this.ctx.shadowBlur = 6;
        this.ctx.stroke();

        // Center Pulsing Starlight Crystal Gem
        const pulse = (Math.sin(this.state.hoverPhase * 1.2) + 1) * 0.5;
        this.ctx.beginPath();
        this.ctx.arc(0, headY - 26, 2.8 + pulse * 0.8, 0, Math.PI * 2);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = '#ffffff';
        this.ctx.shadowBlur = 8;
        this.ctx.fill();

        // 4-point golden star flare behind center crystal
        this.ctx.save();
        this.ctx.translate(0, headY - 26);
        const r = 5.5 + pulse * 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(0, -r);
        this.ctx.quadraticCurveTo(0, 0, r, 0);
        this.ctx.quadraticCurveTo(0, 0, 0, r);
        this.ctx.quadraticCurveTo(0, 0, -r, 0);
        this.ctx.quadraticCurveTo(0, 0, 0, -r);
        this.ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
        this.ctx.fill();
        this.ctx.restore();

        // Side mini star accents
        [-14, 14].forEach((x) => {
            this.ctx.beginPath();
            this.ctx.arc(x, headY - 22, 1.3, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffd166';
            this.ctx.fill();
        });

        this.ctx.restore();
    }

    _renderAntennae(cx, cy, palette) {
        // Preserved for backward-compatibility; antennae replaced by feminine starlight tiara & fairy curls
    }

    _renderFairyEyes(palette) {
        const headY = -20;
        const eyeOffset = 11;
        const eyeLookX = this.state.currentEyeX * 3.2;
        const eyeLookY = this.state.currentEyeY * 2.2;

        const isHappySmile = (this.state.emotion === 'happy' || this.state.emotion === 'pet');
        let blinkFactor = (this.state.emotion === 'sleep') ? 0.05 : Math.max(0.08, 1 - Math.abs(this.state.blinkProgress));
        if (this.state.emotion === 'surprised') {
            blinkFactor = 1.25; // Wide open surprised anime eyes
        }

        if (isHappySmile && this.state.emotion === 'pet') {
            // Joyful curved happy anime eyes (^‿^) during petting
            this._drawHappyEye(-eyeOffset, headY - 2, -1);
            this._drawHappyEye(eyeOffset, headY - 2, 1);
        } else {
            // Luminous Anime / Chibi Eyes with Look-At Tracking
            this._drawFairyEye(-eyeOffset + eyeLookX, headY - 2 + eyeLookY, palette.eyes, blinkFactor);
            this._drawFairyEye(eyeOffset + eyeLookX, headY - 2 + eyeLookY, palette.eyes, blinkFactor);
        }
    }

    _drawFairyEye(x, y, eyeColor, openFactor) {
        this.ctx.save();

        // Eye Socket (Dark background)
        this.ctx.beginPath();
        this.ctx.ellipse(x, y, 6.2, 9.2 * openFactor, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = '#0f1123';
        this.ctx.fill();

        if (openFactor > 0.35) {
            // Deep iridescent iris gradient
            const irisGrad = this.ctx.createLinearGradient(x, y - 8 * openFactor, x, y + 8 * openFactor);
            irisGrad.addColorStop(0, '#190a36');
            irisGrad.addColorStop(0.45, '#4a154b');
            irisGrad.addColorStop(0.8, eyeColor || '#70d6ff');
            irisGrad.addColorStop(1, '#ffffff');

            this.ctx.beginPath();
            this.ctx.ellipse(x, y, 4.8, 7.5 * openFactor, 0, 0, Math.PI * 2);
            this.ctx.fillStyle = irisGrad;
            this.ctx.fill();

            // Pupil
            this.ctx.beginPath();
            this.ctx.ellipse(x, y + 0.8, 2.5, 4.2 * openFactor, 0, 0, Math.PI * 2);
            this.ctx.fillStyle = '#060712';
            this.ctx.fill();

            // Primary Sparkle Glint (Top-left star reflection)
            this.ctx.beginPath();
            this.ctx.arc(x - 1.8, y - 2.8 * openFactor, 2.0, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffffff';
            this.ctx.shadowColor = '#ffffff';
            this.ctx.shadowBlur = 3;
            this.ctx.fill();

            // Secondary Catchlight (Bottom-right soft reflection)
            this.ctx.beginPath();
            this.ctx.arc(x + 2.0, y + 2.5 * openFactor, 1.1, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            this.ctx.fill();
        }

        // Feminine upper eyelash line with slight outer flick
        this.ctx.beginPath();
        this.ctx.arc(x, y - 5 * openFactor, 6.8, 1.12 * Math.PI, 1.88 * Math.PI);
        this.ctx.strokeStyle = '#0f1123';
        this.ctx.lineWidth = 1.6;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        this.ctx.restore();
    }

    _drawHappyEye(x, y, side) {
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.arc(x, y - 1, 6.2, 1.15 * Math.PI, 1.85 * Math.PI);
        this.ctx.strokeStyle = '#0f1123';
        this.ctx.lineWidth = 2.0;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        // Delicate outer eyelash flick
        this.ctx.beginPath();
        this.ctx.moveTo(x + side * 5.5, y - 2);
        this.ctx.lineTo(x + side * 8.5, y - 4.5);
        this.ctx.stroke();
        this.ctx.restore();
    }

    _renderCheeksAndMouth(palette, time) {
        const headY = -20;

        // Rosy Cheek Blush
        const blushOpacity = this.state.emotion === 'pet' ? 0.65 : 0.4;
        this.ctx.save();
        this.ctx.fillStyle = `rgba(255, 120, 160, ${blushOpacity})`;
        this.ctx.shadowColor = 'rgba(255, 120, 160, 0.35)';
        this.ctx.shadowBlur = 5;

        this.ctx.beginPath();
        this.ctx.ellipse(-15, headY + 8, 5.2, 3.2, 0, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.beginPath();
        this.ctx.ellipse(15, headY + 8, 5.2, 3.2, 0, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.restore();

        // Cute Mouth
        this.ctx.save();
        this.ctx.strokeStyle = '#4a154b';
        this.ctx.fillStyle = '#ff85a1';
        this.ctx.lineWidth = 1.4;
        this.ctx.lineCap = 'round';

        const isSpeaking = (this.state.emotion === 'speaking' || this.state.emotion === 'talking');
        if (isSpeaking) {
            const mouthOpen = Math.abs(Math.sin((time || 0) * 0.016)) * 3.5 + 1.8;
            this.ctx.beginPath();
            this.ctx.ellipse(0, headY + 11, 3.2, mouthOpen, 0, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
        } else if (this.state.emotion === 'happy' || this.state.emotion === 'pet') {
            // Joyful open smile
            this.ctx.beginPath();
            this.ctx.arc(0, headY + 9, 3.8, 0.15 * Math.PI, 0.85 * Math.PI);
            this.ctx.stroke();
        } else if (this.state.emotion === 'surprised') {
            // Surprised cute rounded 'o' mouth
            this.ctx.beginPath();
            this.ctx.ellipse(0, headY + 11, 2.4, 3.2, 0, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
        } else if (this.state.emotion === 'worried') {
            // Concerned soft pout
            this.ctx.beginPath();
            this.ctx.arc(0, headY + 13, 3.5, 1.15 * Math.PI, 1.85 * Math.PI);
            this.ctx.stroke();
        } else {
            // Gentle serene smile
            this.ctx.beginPath();
            this.ctx.arc(0, headY + 10, 2.6, 0.1 * Math.PI, 0.9 * Math.PI);
            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    _renderFairyHands(palette) {
        this.ctx.save();
        this.ctx.fillStyle = '#fff0f5';
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 4;

        if (this.state.emotion === 'pet' || this.state.emotion === 'magic') {
            // Hands held up playfully
            this.ctx.beginPath();
            this.ctx.arc(-12, 6, 2.6, 0, Math.PI * 2);
            this.ctx.arc(12, 6, 2.6, 0, Math.PI * 2);
            this.ctx.fill();
        } else {
            // Delicate hands folded softly together
            this.ctx.beginPath();
            this.ctx.ellipse(-2.5, 9, 2.6, 2.0, -Math.PI / 8, 0, Math.PI * 2);
            this.ctx.ellipse(2.5, 9, 2.6, 2.0, Math.PI / 8, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.restore();
    }

    _renderBurstParticles() {
        for (const p of this.burstParticles) {
            this.ctx.save();
            this.ctx.translate(p.x, p.y);
            this.ctx.fillStyle = p.color;
            this.ctx.globalAlpha = Math.max(0, p.alpha * this.state.opacity);
            this.ctx.shadowColor = p.color;
            this.ctx.shadowBlur = 6;

            if (p.shape === 'heart') {
                const s = p.radius * 0.65;
                this.ctx.beginPath();
                this.ctx.moveTo(0, s * 0.3);
                this.ctx.bezierCurveTo(-s, -s * 0.8, -s * 1.5, s * 0.2, 0, s * 1.3);
                this.ctx.bezierCurveTo(s * 1.5, s * 0.2, s, -s * 0.8, 0, s * 0.3);
                this.ctx.fill();
            } else {
                const r = p.radius;
                this.ctx.beginPath();
                this.ctx.moveTo(0, -r * 1.5);
                this.ctx.quadraticCurveTo(0, 0, r * 1.5, 0);
                this.ctx.quadraticCurveTo(0, 0, 0, r * 1.5);
                this.ctx.quadraticCurveTo(0, 0, -r * 1.5, 0);
                this.ctx.quadraticCurveTo(0, 0, 0, -r * 1.5);
                this.ctx.fill();
            }

            this.ctx.restore();
        }
    }

    destroy() {
        this.stop();
        if (this.canvas) {
            if (this._mouseMoveHandler) this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
            if (this._mouseLeaveHandler) this.canvas.removeEventListener('mouseleave', this._mouseLeaveHandler);
        }
        this.orbitParticles = [];
        this.burstParticles = [];
        this.trailParticles = [];
    }
}

// Global browser registration and CommonJS export
if (typeof window !== 'undefined') {
    window.CelestialFamiliarRenderer = CelestialFamiliarRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CelestialFamiliarRenderer };
}
