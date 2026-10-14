'use strict';

/**
 * CelestialFamiliarRenderer
 * Unified high-fidelity canvas rendering engine for L.U.C.Y.'s cute, feminine,
 * luminous fairy companion.
 * 
 * Features:
 * - Luminous pearlescent face with rosy blush and expressive look-at-mouse tracking.
 * - Captivating chibi/anime eyes with rich iridescent iris gradients, dual sparkles, and blinking.
 * - Slender arching antennae with glowing pearls that bob with spring physics.
 * - Petite feminine fairy silhouette with a glowing heart/crystal emblem on her chest.
 * - Layered translucent petal skirt that sways in the magical breeze.
 * - Multi-layered double iridescent fairy wings with cyan-lavender-pearl gradients & veins.
 * - Orbiting stardust motes, dynamic trailing particle ribbons, and burst effects for Pet & Magic.
 * - Seamless animation lifecycle: Idle, Pet, Magic, Takeoff, Landing, Speaking, Thinking, Working, etc.
 */
class CelestialFamiliarRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
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
            antennaeSway: 0,
            // Action animations
            actionTimer: 0,
            actionDuration: 0,
            spinAngle: 0,
            transitionOffset: 0,
            scaleY: 1,
            opacity: 1
        };

        this.orbitParticles = [];
        this.burstParticles = [];
        this.trailParticles = [];
        this.running = false;
        this.lastTime = 0;

        this._initParticles();
        this._bindEvents();
    }

    _initParticles() {
        this.orbitParticles = [];
        for (let i = 0; i < 32; i++) {
            this.orbitParticles.push({
                x: (Math.random() - 0.5) * 160,
                y: (Math.random() - 0.5) * 160,
                radius: Math.random() * 2.2 + 0.8,
                angle: Math.random() * Math.PI * 2,
                speed: (Math.random() * 0.015 + 0.008) * (Math.random() > 0.5 ? 1 : -1),
                distance: Math.random() * 70 + 25,
                alpha: Math.random() * 0.7 + 0.3,
                pulseSpeed: Math.random() * 2 + 1
            });
        }
    }

    _bindEvents() {
        if (!this.canvas) return;

        this._mouseMoveHandler = (e) => {
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
            this.state.eyeTargetX = 0;
            this.state.eyeTargetY = 0;
        };

        this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
        this.canvas.addEventListener('mouseleave', this._mouseLeaveHandler);
    }

    setVisualState(visualState = {}) {
        if (!visualState) return;
        const prevEmotion = this.state.emotion;
        if (visualState.emotion) {
            this.state.emotion = visualState.emotion;
        }

        // Trigger special bursts on state changes
        if (this.state.emotion === 'pet' && prevEmotion !== 'pet') {
            this.triggerPetBurst();
        } else if (this.state.emotion === 'magic' && prevEmotion !== 'magic') {
            this.triggerMagicSpin();
        } else if (this.state.emotion === 'takeoff') {
            this.triggerTakeoff();
        } else if (this.state.emotion === 'landing') {
            this.triggerLanding();
        }
    }

    triggerPetBurst() {
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.6;
        for (let i = 0; i < 24; i++) {
            const angle = (i / 24) * Math.PI * 2;
            const speed = Math.random() * 2.5 + 1.5;
            this.burstParticles.push({
                x: 0,
                y: -10,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 0.5,
                radius: Math.random() * 3 + 1.5,
                alpha: 1,
                decay: 0.02 + Math.random() * 0.02,
                color: Math.random() > 0.4 ? '#ff69b4' : '#ffd166',
                shape: Math.random() > 0.5 ? 'heart' : 'sparkle'
            });
        }
    }

    triggerMagicSpin() {
        this.state.actionTimer = 0;
        this.state.actionDuration = 1.8;
        this.state.spinAngle = 0;
        for (let i = 0; i < 36; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 40 + 10;
            const speed = Math.random() * 3 + 2;
            this.burstParticles.push({
                x: Math.cos(angle) * dist,
                y: Math.sin(angle) * dist,
                vx: Math.cos(angle + Math.PI / 2) * speed * 0.7,
                vy: Math.sin(angle + Math.PI / 2) * speed * 0.7 - 1.2,
                radius: Math.random() * 3.5 + 1.5,
                alpha: 1,
                decay: 0.018 + Math.random() * 0.02,
                color: ['#00f5d4', '#ffd166', '#b388ff', '#ffffff'][i % 4],
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
        this.state.transitionOffset = -140;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.lastTime = performance.now();
        const animate = (time) => {
            if (!this.running) return;
            const dt = Math.min((time - this.lastTime) / 1000, 0.1);
            this.lastTime = time;
            this._update(time, dt);
            this._render(time);
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }

    stop() {
        this.running = false;
    }

    _update(time, dt) {
        const sec = time / 1000;

        // Smooth look-at tracking with gentle spring damping
        this.state.currentEyeX += (this.state.eyeTargetX - this.state.currentEyeX) * Math.min(1, dt * 8);
        this.state.currentEyeY += (this.state.eyeTargetY - this.state.currentEyeY) * Math.min(1, dt * 8);

        // Hover & wing frequencies adapt dynamically
        let hoverSpeed = 2.4;
        let hoverAmp = 9;
        let wingSpeed = 14;

        if (this.state.emotion === 'takeoff') {
            wingSpeed = 28;
            this.state.actionTimer += dt;
            const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
            // Rise upward and fade
            this.state.transitionOffset = -prog * 180;
            this.state.opacity = Math.max(0, 1 - prog * 1.5);
            // Spawn launch trail
            if (Math.random() < 0.6) {
                this.trailParticles.push({
                    x: (Math.random() - 0.5) * 30,
                    y: 20,
                    vx: (Math.random() - 0.5) * 1.5,
                    vy: Math.random() * 2 + 1,
                    radius: Math.random() * 3 + 1,
                    alpha: 1,
                    decay: 0.03
                });
            }
        } else if (this.state.emotion === 'landing') {
            wingSpeed = 22;
            this.state.actionTimer += dt;
            const prog = Math.min(1, this.state.actionTimer / this.state.actionDuration);
            // Decelerate downward into position
            this.state.transitionOffset = (1 - prog) * -120;
            this.state.opacity = Math.min(1, prog * 1.8);
            if (prog >= 1) {
                this.state.emotion = 'happy';
                this.state.transitionOffset = 0;
                this.state.opacity = 1;
            }
        } else {
            this.state.transitionOffset = 0;
            this.state.opacity = 1;

            if (this.state.emotion === 'speaking') {
                hoverSpeed = 3.2;
                wingSpeed = 16;
            } else if (this.state.emotion === 'working') {
                hoverSpeed = 2.8;
                wingSpeed = 18;
            } else if (this.state.emotion === 'pet') {
                hoverSpeed = 3.5;
                hoverAmp = 12;
                wingSpeed = 20;
            } else if (this.state.emotion === 'magic') {
                wingSpeed = 24;
                this.state.actionTimer += dt;
                this.state.spinAngle += dt * Math.PI * 4;
                if (this.state.actionTimer >= this.state.actionDuration) {
                    this.state.emotion = 'happy';
                    this.state.spinAngle = 0;
                }
            } else if (this.state.emotion === 'sleep') {
                hoverSpeed = 1.2;
                hoverAmp = 4;
                wingSpeed = 6;
            }
        }

        this.state.hoverPhase = Math.sin(sec * hoverSpeed) * hoverAmp;
        this.state.wingPhase = Math.sin(sec * wingSpeed);
        this.state.skirtSway = Math.sin(sec * (hoverSpeed * 1.1) + 0.4) * 5;
        this.state.antennaeSway = Math.sin(sec * (hoverSpeed * 0.9) - 0.3) * 3;

        // Blinking cycle every ~3.6s
        this.state.blinkTimer += dt;
        if (this.state.blinkTimer > 3.6 && this.state.emotion !== 'sleep') {
            this.state.blinkProgress = Math.sin((this.state.blinkTimer - 3.6) * Math.PI * 6.5);
            if (this.state.blinkTimer > 3.9) {
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
        if (Math.random() < 0.25) {
            this.trailParticles.push({
                x: (Math.random() - 0.5) * 40,
                y: 25 + Math.random() * 10,
                vx: (Math.random() - 0.5) * 0.8,
                vy: Math.random() * 1 + 0.3,
                radius: Math.random() * 2 + 0.8,
                alpha: 0.8,
                decay: 0.025
            });
        }
    }

    _getColorPalette() {
        switch (this.state.emotion) {
            case 'happy':
            case 'pet':
                return {
                    core: '#00f5d4',
                    accent: '#ffd166',
                    aura: 'rgba(0, 245, 212, 0.42)',
                    eyes: '#48cae4',
                    wingsInner: 'rgba(0, 245, 212, 0.55)',
                    wingsOuter: 'rgba(179, 136, 255, 0.4)',
                    dress: 'rgba(0, 245, 212, 0.6)'
                };
            case 'speaking':
            case 'talking':
                return {
                    core: '#38ef7d',
                    accent: '#00f5d4',
                    aura: 'rgba(56, 239, 125, 0.5)',
                    eyes: '#80ed99',
                    wingsInner: 'rgba(56, 239, 125, 0.55)',
                    wingsOuter: 'rgba(72, 202, 228, 0.4)',
                    dress: 'rgba(56, 239, 125, 0.6)'
                };
            case 'listening':
                return {
                    core: '#ff70a6',
                    accent: '#ffd166',
                    aura: 'rgba(255, 112, 166, 0.5)',
                    eyes: '#ff9ebb',
                    wingsInner: 'rgba(255, 112, 166, 0.55)',
                    wingsOuter: 'rgba(179, 136, 255, 0.4)',
                    dress: 'rgba(255, 112, 166, 0.6)'
                };
            case 'thinking':
            case 'focused':
                return {
                    core: '#b388ff',
                    accent: '#00f5d4',
                    aura: 'rgba(179, 136, 255, 0.5)',
                    eyes: '#d8b4fe',
                    wingsInner: 'rgba(179, 136, 255, 0.55)',
                    wingsOuter: 'rgba(72, 202, 228, 0.45)',
                    dress: 'rgba(179, 136, 255, 0.6)'
                };
            case 'working':
                return {
                    core: '#06d6a0',
                    accent: '#ffd166',
                    aura: 'rgba(6, 214, 160, 0.48)',
                    eyes: '#70e000',
                    wingsInner: 'rgba(6, 214, 160, 0.55)',
                    wingsOuter: 'rgba(0, 245, 212, 0.4)',
                    dress: 'rgba(6, 214, 160, 0.6)'
                };
            case 'worried':
                return {
                    core: '#ff8da1',
                    accent: '#ffb703',
                    aura: 'rgba(255, 141, 161, 0.4)',
                    eyes: '#ffccd5',
                    wingsInner: 'rgba(255, 141, 161, 0.45)',
                    wingsOuter: 'rgba(255, 183, 3, 0.35)',
                    dress: 'rgba(255, 141, 161, 0.5)'
                };
            case 'curious':
                return {
                    core: '#ffd166',
                    accent: '#00f5d4',
                    aura: 'rgba(255, 209, 102, 0.48)',
                    eyes: '#ffeaa7',
                    wingsInner: 'rgba(255, 209, 102, 0.55)',
                    wingsOuter: 'rgba(255, 112, 166, 0.4)',
                    dress: 'rgba(255, 209, 102, 0.6)'
                };
            case 'magic':
                return {
                    core: '#ffd166',
                    accent: '#00f5d4',
                    aura: 'rgba(255, 215, 0, 0.6)',
                    eyes: '#ffffff',
                    wingsInner: 'rgba(255, 215, 0, 0.65)',
                    wingsOuter: 'rgba(0, 245, 212, 0.6)',
                    dress: 'rgba(255, 215, 0, 0.7)'
                };
            case 'sleep':
                return {
                    core: '#708090',
                    accent: '#a0aec0',
                    aura: 'rgba(112, 128, 144, 0.25)',
                    eyes: '#cbd5e1',
                    wingsInner: 'rgba(112, 128, 144, 0.3)',
                    wingsOuter: 'rgba(74, 85, 104, 0.25)',
                    dress: 'rgba(112, 128, 144, 0.35)'
                };
            default:
                return {
                    core: '#00f5d4',
                    accent: '#ffd166',
                    aura: 'rgba(0, 245, 212, 0.38)',
                    eyes: '#48cae4',
                    wingsInner: 'rgba(0, 245, 212, 0.5)',
                    wingsOuter: 'rgba(179, 136, 255, 0.4)',
                    dress: 'rgba(0, 245, 212, 0.55)'
                };
        }
    }

    _render(time) {
        if (!this.ctx || !this.canvas) return;
        const width = this.canvas.width;
        const height = this.canvas.height;
        this.ctx.clearRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height * 0.48 + this.state.hoverPhase + this.state.transitionOffset;
        const palette = this._getColorPalette();

        this.ctx.save();
        if (this.state.opacity < 1) {
            this.ctx.globalAlpha = Math.max(0, this.state.opacity);
        }

        // Apply scale & spin transformations during special actions
        if (this.state.spinAngle !== 0) {
            this.ctx.translate(cx, cy);
            this.ctx.rotate(this.state.spinAngle);
            this.ctx.translate(-cx, -cy);
        }

        // 1. Draw Orbiting Star Particles
        this._renderOrbitParticles(cx, cy, palette, time);

        // 2. Draw Trailing Stardust Ribbon
        this._renderTrailingParticles(cx, cy);

        // 3. Multi-Layered Iridescent Fairy Wings (Drawn behind body)
        this._renderFairyWings(cx, cy, palette);

        // 4. Ethereal Soft Outer Aura
        this._renderSoftAura(cx, cy, palette);

        // 5. Petite Fairy Dress / Petal Skirt
        this._renderPetalDress(cx, cy, palette);

        // 6. Luminous Fairy Torso & Glowing Heart Gem
        this._renderFairyTorso(cx, cy, palette);

        // 7. Luminous Head & Soft Face
        this._renderFairyHead(cx, cy, palette);

        // 8. Delicate Arching Antennae with Glowing Pearl Tips
        this._renderAntennae(cx, cy, palette);

        // 9. Expressive Chibi/Anime Eyes with Look-At Tracking & Blinking
        this._renderFairyEyes(cx, cy, palette);

        // 10. Rosy Cheeks & Animated Speaking Mouth
        this._renderCheeksAndMouth(cx, cy, palette, time);

        // 11. Delicate Little Hands Resting Gently in Front
        this._renderFairyHands(cx, cy, palette);

        // 12. Draw Burst Particles (Hearts / Sparkles from Pet or Magic)
        this._renderBurstParticles(cx, cy);

        this.ctx.restore();
    }

    _renderOrbitParticles(cx, cy, palette, time) {
        const sec = time / 1000;
        for (const p of this.orbitParticles) {
            p.angle += p.speed;
            const px = cx + Math.cos(p.angle) * p.distance;
            const py = cy + Math.sin(p.angle) * (p.distance * 0.42);
            const pulse = (Math.sin(sec * p.pulseSpeed + p.angle) + 1) * 0.5;

            this.ctx.beginPath();
            this.ctx.arc(px, py, p.radius * (0.8 + pulse * 0.4), 0, Math.PI * 2);
            this.ctx.fillStyle = p.radius > 1.8 ? palette.accent : palette.aura;
            this.ctx.globalAlpha = p.alpha * (0.4 + pulse * 0.6) * this.state.opacity;
            this.ctx.fill();
        }
        this.ctx.globalAlpha = this.state.opacity;
    }

    _renderTrailingParticles(cx, cy) {
        for (const p of this.trailParticles) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.arc(cx + p.x, cy + p.y, p.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffd166';
            this.ctx.globalAlpha = Math.max(0, p.alpha * this.state.opacity);
            this.ctx.shadowColor = '#00f5d4';
            this.ctx.shadowBlur = 6;
            this.ctx.fill();
            this.ctx.restore();
        }
    }

    _renderFairyWings(cx, cy, palette) {
        this.ctx.save();
        this.ctx.translate(cx, cy - 8);

        const wingSpread = 1 + this.state.wingPhase * 0.16;
        const wingFlapY = Math.sin(this.state.wingPhase * 0.8) * 4;

        // Left Double Wing Set
        this._drawWingPair(-1, wingSpread, wingFlapY, palette);

        // Right Double Wing Set
        this._drawWingPair(1, wingSpread, wingFlapY, palette);

        this.ctx.restore();
    }

    _drawWingPair(side, spread, flapY, palette) {
        // Upper Primary Wing (Graceful Teardrop)
        this.ctx.save();
        this.ctx.scale(side, 1);

        const upperGrad = this.ctx.createLinearGradient(0, 0, 50 * spread, -35);
        upperGrad.addColorStop(0, palette.wingsInner);
        upperGrad.addColorStop(0.6, palette.wingsOuter);
        upperGrad.addColorStop(1, 'rgba(255, 255, 255, 0.7)');

        this.ctx.beginPath();
        this.ctx.moveTo(8, -4);
        this.ctx.bezierCurveTo(24, -28 + flapY, 52 * spread, -46 + flapY, 56 * spread, -18 + flapY);
        this.ctx.bezierCurveTo(58 * spread, 6, 26, 4, 8, 2);
        this.ctx.fillStyle = upperGrad;
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 14;
        this.ctx.fill();

        // Delicate glowing wing vein
        this.ctx.beginPath();
        this.ctx.moveTo(8, -4);
        this.ctx.quadraticCurveTo(32 * spread, -20 + flapY, 48 * spread, -18 + flapY);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        this.ctx.lineWidth = 1.1;
        this.ctx.stroke();

        // Lower Secondary Wing (Softer rounded petal)
        const lowerGrad = this.ctx.createLinearGradient(0, 0, 36 * spread, 24);
        lowerGrad.addColorStop(0, palette.wingsInner);
        lowerGrad.addColorStop(1, 'rgba(179, 136, 255, 0.45)');

        this.ctx.beginPath();
        this.ctx.moveTo(8, 2);
        this.ctx.bezierCurveTo(22, 10, 42 * spread, 26 + flapY * 0.5, 34 * spread, 34);
        this.ctx.bezierCurveTo(24 * spread, 38, 12, 18, 6, 8);
        this.ctx.fillStyle = lowerGrad;
        this.ctx.shadowBlur = 8;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderSoftAura(cx, cy, palette) {
        const auraGrad = this.ctx.createRadialGradient(cx, cy - 6, 12, cx, cy - 6, 82);
        auraGrad.addColorStop(0, palette.aura);
        auraGrad.addColorStop(0.55, palette.aura.replace(/[\d.]+\)$/, '0.15)'));
        auraGrad.addColorStop(1, 'transparent');

        this.ctx.beginPath();
        this.ctx.arc(cx, cy - 6, 82, 0, Math.PI * 2);
        this.ctx.fillStyle = auraGrad;
        this.ctx.fill();
    }

    _renderPetalDress(cx, cy, palette) {
        this.ctx.save();
        this.ctx.translate(cx, cy + 18);

        const sway = this.state.skirtSway;
        const petalGrad = this.ctx.createLinearGradient(0, 0, 0, 32);
        petalGrad.addColorStop(0, palette.dress);
        petalGrad.addColorStop(0.8, 'rgba(179, 136, 255, 0.45)');
        petalGrad.addColorStop(1, 'rgba(255, 255, 255, 0.6)');

        // Center Petal
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.quadraticCurveTo(-14 + sway, 16, 0 + sway * 1.2, 32);
        this.ctx.quadraticCurveTo(14 + sway, 16, 0, 0);
        this.ctx.fillStyle = petalGrad;
        this.ctx.fill();

        // Left Layered Petal
        this.ctx.beginPath();
        this.ctx.moveTo(-6, -2);
        this.ctx.quadraticCurveTo(-26 + sway * 0.8, 12, -18 + sway, 28);
        this.ctx.quadraticCurveTo(-4, 18, -2, 2);
        this.ctx.fillStyle = petalGrad;
        this.ctx.fill();

        // Right Layered Petal
        this.ctx.beginPath();
        this.ctx.moveTo(6, -2);
        this.ctx.quadraticCurveTo(26 + sway * 0.8, 12, 18 + sway, 28);
        this.ctx.quadraticCurveTo(4, 18, 2, 2);
        this.ctx.fillStyle = petalGrad;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderFairyTorso(cx, cy, palette) {
        // Torso / Bodice
        this.ctx.save();
        const torsoGrad = this.ctx.createRadialGradient(cx, cy + 4, 3, cx, cy + 6, 20);
        torsoGrad.addColorStop(0, '#ffffff');
        torsoGrad.addColorStop(0.6, palette.core);
        torsoGrad.addColorStop(1, 'rgba(20, 26, 50, 0.9)');

        this.ctx.beginPath();
        this.ctx.ellipse(cx, cy + 6, 16, 18, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = torsoGrad;
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 12;
        this.ctx.fill();

        // Glowing Heart / Star Emblem on chest
        this.ctx.beginPath();
        this.ctx.arc(cx, cy + 4, 3.8, 0, Math.PI * 2);
        this.ctx.fillStyle = palette.accent || '#ffd166';
        this.ctx.shadowColor = palette.accent || '#ffd166';
        this.ctx.shadowBlur = 10;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderFairyHead(cx, cy, palette) {
        this.ctx.save();
        const headY = cy - 20;

        // Head core with soft pearlescent luminous gradient
        const headGrad = this.ctx.createRadialGradient(cx - 8, headY - 10, 6, cx, headY, 38);
        headGrad.addColorStop(0, '#ffffff');
        headGrad.addColorStop(0.45, '#f8fafc');
        headGrad.addColorStop(0.8, palette.core);
        headGrad.addColorStop(1, 'rgba(18, 24, 48, 0.95)');

        this.ctx.beginPath();
        this.ctx.ellipse(cx, headY, 36, 38, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = headGrad;
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 24;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderAntennae(cx, cy, palette) {
        this.ctx.save();
        const headY = cy - 20;
        const sway = this.state.antennaeSway;

        this.ctx.strokeStyle = palette.core;
        this.ctx.lineWidth = 2.4;
        this.ctx.lineCap = 'round';
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 8;

        // Left Antennula
        this.ctx.beginPath();
        this.ctx.moveTo(cx - 16, headY - 28);
        this.ctx.bezierCurveTo(cx - 28 + sway, headY - 56, cx - 44 + sway * 1.5, headY - 68, cx - 36 + sway * 1.8, headY - 74);
        this.ctx.stroke();

        // Left glowing pearl bulb
        this.ctx.beginPath();
        this.ctx.arc(cx - 36 + sway * 1.8, headY - 74, 4.5, 0, Math.PI * 2);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = palette.accent || '#ffd166';
        this.ctx.shadowBlur = 14;
        this.ctx.fill();

        // Right Antennula
        this.ctx.beginPath();
        this.ctx.moveTo(cx + 16, headY - 28);
        this.ctx.bezierCurveTo(cx + 28 - sway, headY - 56, cx + 44 - sway * 1.5, headY - 68, cx + 36 - sway * 1.8, headY - 74);
        this.ctx.stroke();

        // Right glowing pearl bulb
        this.ctx.beginPath();
        this.ctx.arc(cx + 36 - sway * 1.8, headY - 74, 4.5, 0, Math.PI * 2);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = palette.accent || '#ffd166';
        this.ctx.shadowBlur = 14;
        this.ctx.fill();

        this.ctx.restore();
    }

    _renderFairyEyes(cx, cy, palette) {
        const headY = cy - 20;
        const eyeOffset = 14;
        const eyeLookX = this.state.currentEyeX * 4;
        const eyeLookY = this.state.currentEyeY * 3;

        const isHappySmile = (this.state.emotion === 'happy' || this.state.emotion === 'pet');
        const blinkFactor = (this.state.emotion === 'sleep') ? 0.05 : Math.max(0.08, 1 - Math.abs(this.state.blinkProgress));

        if (isHappySmile && this.state.emotion === 'pet') {
            // Delightful happy curved eyes (^‿^) during petting
            this._drawHappyEye(cx - eyeOffset, headY - 2, palette.eyes, -1);
            this._drawHappyEye(cx + eyeOffset, headY - 2, palette.eyes, 1);
        } else {
            // Luminous Anime / Chibi Eyes
            this._drawFairyEye(cx - eyeOffset + eyeLookX, headY - 2 + eyeLookY, palette.eyes, blinkFactor);
            this._drawFairyEye(cx + eyeOffset + eyeLookX, headY - 2 + eyeLookY, palette.eyes, blinkFactor);
        }
    }

    _drawFairyEye(x, y, eyeColor, openFactor) {
        this.ctx.save();

        // Eye Socket (Dark background)
        this.ctx.beginPath();
        this.ctx.ellipse(x, y, 7.5, 11 * openFactor, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = '#0a0e1c';
        this.ctx.fill();

        if (openFactor > 0.35) {
            // Iridescent Iris Gradient
            const irisGrad = this.ctx.createLinearGradient(x, y - 9 * openFactor, x, y + 9 * openFactor);
            irisGrad.addColorStop(0, '#10002b');
            irisGrad.addColorStop(0.45, '#3a0ca3');
            irisGrad.addColorStop(0.85, eyeColor);
            irisGrad.addColorStop(1, '#00f5d4');

            this.ctx.beginPath();
            this.ctx.ellipse(x, y, 5.8, 9 * openFactor, 0, 0, Math.PI * 2);
            this.ctx.fillStyle = irisGrad;
            this.ctx.fill();

            // Pupil
            this.ctx.beginPath();
            this.ctx.ellipse(x, y + 1, 3.2, 5 * openFactor, 0, 0, Math.PI * 2);
            this.ctx.fillStyle = '#05070f';
            this.ctx.fill();

            // Primary Sparkle Glint (Top-left star reflection)
            this.ctx.beginPath();
            this.ctx.arc(x - 2.2, y - 3.2 * openFactor, 2.4, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffffff';
            this.ctx.shadowColor = '#ffffff';
            this.ctx.shadowBlur = 4;
            this.ctx.fill();

            // Secondary Ambient Catchlight (Bottom-right soft reflection)
            this.ctx.beginPath();
            this.ctx.arc(x + 2.4, y + 3 * openFactor, 1.4, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            this.ctx.fill();
        }

        // Delicate Upper Eyelash line
        this.ctx.beginPath();
        this.ctx.arc(x, y - 6 * openFactor, 8, 1.1 * Math.PI, 1.9 * Math.PI);
        this.ctx.strokeStyle = '#0a0e1c';
        this.ctx.lineWidth = 1.8;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        this.ctx.restore();
    }

    _drawHappyEye(x, y, eyeColor, side) {
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.arc(x, y - 1, 7.5, 1.15 * Math.PI, 1.85 * Math.PI);
        this.ctx.strokeStyle = '#0a0e1c';
        this.ctx.lineWidth = 2.4;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();

        // Delicate eyelash flick
        this.ctx.beginPath();
        this.ctx.moveTo(x + side * 7, y - 2);
        this.ctx.lineTo(x + side * 10, y - 5);
        this.ctx.stroke();
        this.ctx.restore();
    }

    _renderCheeksAndMouth(cx, cy, palette, time) {
        const headY = cy - 20;

        // Rosy Cheek Blush
        const blushOpacity = this.state.emotion === 'pet' ? 0.6 : 0.35;
        this.ctx.save();
        this.ctx.fillStyle = `rgba(255, 105, 180, ${blushOpacity})`;
        this.ctx.shadowColor = 'rgba(255, 105, 180, 0.4)';
        this.ctx.shadowBlur = 6;

        this.ctx.beginPath();
        this.ctx.ellipse(cx - 20, headY + 11, 6.5, 4, 0, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.beginPath();
        this.ctx.ellipse(cx + 20, headY + 11, 6.5, 4, 0, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.restore();

        // Cute Mouth
        this.ctx.save();
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.fillStyle = '#ffffff';
        this.ctx.lineWidth = 1.7;
        this.ctx.lineCap = 'round';

        const isSpeaking = (this.state.emotion === 'speaking' || this.state.emotion === 'talking');
        if (isSpeaking) {
            const mouthOpen = Math.abs(Math.sin((time || 0) * 0.016)) * 4.5 + 2;
            this.ctx.beginPath();
            this.ctx.ellipse(cx, headY + 14, 4.2, mouthOpen, 0, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            this.ctx.fill();
        } else if (this.state.emotion === 'happy' || this.state.emotion === 'pet') {
            // Joyful open smile
            this.ctx.beginPath();
            this.ctx.arc(cx, headY + 12, 5, 0.15 * Math.PI, 0.85 * Math.PI);
            this.ctx.stroke();
        } else if (this.state.emotion === 'worried') {
            // Concerned soft pout
            this.ctx.beginPath();
            this.ctx.arc(cx, headY + 16, 4.5, 1.15 * Math.PI, 1.85 * Math.PI);
            this.ctx.stroke();
        } else {
            // Gentle serene smile
            this.ctx.beginPath();
            this.ctx.arc(cx, headY + 13, 3.2, 0.1 * Math.PI, 0.9 * Math.PI);
            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    _renderFairyHands(cx, cy, palette) {
        this.ctx.save();
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        this.ctx.shadowColor = palette.core;
        this.ctx.shadowBlur = 6;

        if (this.state.emotion === 'pet' || this.state.emotion === 'magic') {
            // Hands held up playfully
            this.ctx.beginPath();
            this.ctx.arc(cx - 16, cy + 8, 3.2, 0, Math.PI * 2);
            this.ctx.arc(cx + 16, cy + 8, 3.2, 0, Math.PI * 2);
            this.ctx.fill();
        } else {
            // Delicate hands folded softly together
            this.ctx.beginPath();
            this.ctx.ellipse(cx - 3, cy + 12, 3.4, 2.6, -Math.PI / 8, 0, Math.PI * 2);
            this.ctx.ellipse(cx + 3, cy + 12, 3.4, 2.6, Math.PI / 8, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.restore();
    }

    _renderBurstParticles(cx, cy) {
        for (const p of this.burstParticles) {
            this.ctx.save();
            this.ctx.translate(cx + p.x, cy + p.y);
            this.ctx.fillStyle = p.color;
            this.ctx.globalAlpha = Math.max(0, p.alpha * this.state.opacity);
            this.ctx.shadowColor = p.color;
            this.ctx.shadowBlur = 8;

            if (p.shape === 'heart') {
                // Draw little glowing heart
                const s = p.radius * 0.7;
                this.ctx.beginPath();
                this.ctx.moveTo(0, s * 0.3);
                this.ctx.bezierCurveTo(-s, -s * 0.8, -s * 1.5, s * 0.2, 0, s * 1.3);
                this.ctx.bezierCurveTo(s * 1.5, s * 0.2, s, -s * 0.8, 0, s * 0.3);
                this.ctx.fill();
            } else {
                // 4-point glittering star sparkle
                const r = p.radius;
                this.ctx.beginPath();
                this.ctx.moveTo(0, -r * 1.6);
                this.ctx.quadraticCurveTo(0, 0, r * 1.6, 0);
                this.ctx.quadraticCurveTo(0, 0, 0, r * 1.6);
                this.ctx.quadraticCurveTo(0, 0, -r * 1.6, 0);
                this.ctx.quadraticCurveTo(0, 0, 0, -r * 1.6);
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
