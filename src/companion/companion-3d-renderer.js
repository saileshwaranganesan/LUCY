/**
 * Companion3DRenderer
 * Three.js WebGL rendering engine for L.U.C.Y.'s cute 3D fantasy creature companion.
 * Loads Quaternius's CC0 Animated Fantasy Dragon, applies mood-reactive lighting,
 * procedural levitation, particle motes, speech-synchronized gestures, and
 * seamless failover to the 2D canvas familiar.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

class Companion3DApp {
    constructor() {
        this.threeCanvas = document.getElementById('threeCanvas');
        this.fallbackCanvas = document.getElementById('fallbackCanvas');
        this.speechBubble = document.getElementById('speechBubble');
        this.statusPill = document.getElementById('statusPill');
        this.statusDot = document.getElementById('statusDot');
        this.statusText = document.getElementById('statusText');
        this.petBtn = document.getElementById('petBtn');
        this.focusBtn = document.getElementById('focusBtn');
        this.dockBtn = document.getElementById('dockBtn');
        this.dragBtn = document.getElementById('dragBtn');

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.mixer = null;
        this.model = null;
        this.animations = {};
        this.activeAction = null;
        this.particles = null;
        this.moodLight = null;
        this.ambientLight = null;
        this.dirLight = null;

        this.clock = new THREE.Clock();
        this.currentState = 'idle';
        this.currentEmotion = 'happy';
        this.isSpeaking = false;
        this.speechTimer = null;
        this.basePosY = -0.68;
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };
        this.hasMoved = false;

        this.fallback2D = null;
        this.usingFallback = false;

        this.init();
    }

    async init() {
        this._bindUIEvents();

        try {
            this._initThreeScene();
            await this._loadModel();
            this._initParticles();
            this._startRenderLoop();
            this._bindIpcEvents();
            this.showBubble('Sparkle! ✨ Ready for your instruction.');
        } catch (err) {
            console.warn('[Companion3DApp] WebGL/Model init failed, activating 2D fallback:', err);
            this._activate2DFallback();
            this._bindIpcEvents();
        }
    }

    _initThreeScene() {
        const width = this.threeCanvas.clientWidth || 320;
        const height = this.threeCanvas.clientHeight || 380;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
        this.camera.position.set(0, 0.1, 3.4);
        this.camera.lookAt(0, 0.05, 0);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.threeCanvas,
            alpha: true,
            antialias: true,
            powerPreference: 'default'
        });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.25;

        // Lighting
        this.ambientLight = new THREE.AmbientLight(0xffffff, 1.4);
        this.scene.add(this.ambientLight);

        this.dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
        this.dirLight.position.set(2, 4, 3);
        this.scene.add(this.dirLight);

        // Mood-reactive point light radiating from in front of the creature
        this.moodLight = new THREE.PointLight(0x00f5d4, 3.5, 6.0);
        this.moodLight.position.set(0, 0.25, 1.4);
        this.scene.add(this.moodLight);
    }

    _loadModel() {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(
                'assets/dragon.glb',
                (gltf) => {
                    this.model = gltf.scene;
                    this.model.scale.set(0.42, 0.42, 0.42);
                    this.model.position.set(0, this.basePosY, 0);
                    this.model.rotation.y = 0.25; // Slight 3/4 cute pose

                    // Setup materials
                    this.model.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                            if (child.material) {
                                child.material.roughness = 0.45;
                                child.material.metalness = 0.15;
                            }
                        }
                    });

                    this.scene.add(this.model);

                    // Setup animations
                    if (gltf.animations && gltf.animations.length > 0) {
                        this.mixer = new THREE.AnimationMixer(this.model);
                        gltf.animations.forEach((clip) => {
                            this.animations[clip.name] = this.mixer.clipAction(clip);
                        });

                        // Play Idle by default
                        const idleClip = this.animations['Idle'] || this.animations[gltf.animations[0].name];
                        if (idleClip) {
                            this.activeAction = idleClip;
                            this.activeAction.play();
                        }
                    }

                    resolve();
                },
                undefined,
                (err) => reject(err)
            );
        });
    }

    _initParticles() {
        const particleCount = 36;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        this.particleData = [];
        const baseColor = new THREE.Color(0x00f5d4);

        for (let i = 0; i < particleCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = 0.7 + Math.random() * 0.7;
            const y = -0.5 + Math.random() * 1.3;
            const speed = 0.6 + Math.random() * 0.8;

            positions[i * 3] = Math.cos(angle) * radius;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = Math.sin(angle) * radius;

            colors[i * 3] = baseColor.r;
            colors[i * 3 + 1] = baseColor.g;
            colors[i * 3 + 2] = baseColor.b;

            this.particleData.push({ angle, radius, y, speed, baseRadius: radius });
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const material = new THREE.PointsMaterial({
            size: 0.045,
            vertexColors: true,
            transparent: true,
            opacity: 0.85,
            blending: THREE.AdditiveBlending
        });

        this.particles = new THREE.Points(geometry, material);
        this.scene.add(this.particles);
    }

    _startRenderLoop() {
        const animate = () => {
            requestAnimationFrame(animate);

            const delta = this.clock.getDelta();
            const elapsed = this.clock.getElapsedTime();

            if (this.mixer) {
                this.mixer.update(delta);
            }

            this._updateCreatureBehavior(elapsed, delta);
            this._updateParticles(elapsed);

            if (this.renderer && this.scene && this.camera) {
                this.renderer.render(this.scene, this.camera);
            }
        };

        animate();
    }

    _updateCreatureBehavior(elapsed, _delta) {
        if (!this.model) return;

        // Base procedural levitation
        const hoverFreq = this.isSpeaking ? 5.0 : (this.currentState === 'working' ? 3.5 : 1.8);
        const hoverAmp = this.isSpeaking ? 0.05 : 0.07;
        const targetY = this.basePosY + Math.sin(elapsed * hoverFreq) * hoverAmp;
        this.model.position.y = THREE.MathUtils.lerp(this.model.position.y, targetY, 0.1);

        // Gentle breathing roll & pitch
        if (this.currentState === 'idle') {
            const sway = Math.sin(elapsed * 1.4) * 0.04;
            this.model.rotation.z = THREE.MathUtils.lerp(this.model.rotation.z, sway, 0.05);
            this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, 0, 0.05);
        } else if (this.currentState === 'listening') {
            // Attentive head tilt towards user
            this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, 0.12, 0.08);
            this.model.rotation.z = THREE.MathUtils.lerp(this.model.rotation.z, Math.sin(elapsed * 2.8) * 0.06, 0.08);
        } else if (this.currentState === 'thinking') {
            // Pondering gentle head roll
            this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, -0.06, 0.08);
            this.model.rotation.z = THREE.MathUtils.lerp(this.model.rotation.z, Math.sin(elapsed * 2.0) * 0.09, 0.08);
        } else if (this.currentState === 'working') {
            // Active forward focus
            this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, 0.08, 0.08);
            this.model.rotation.y = 0.25 + Math.sin(elapsed * 3.0) * 0.12;
        }

        // Speech-synchronized rhythmic head nod & jaw pulse
        if (this.isSpeaking) {
            const nod = Math.sin(elapsed * 9.0) * 0.08;
            this.model.rotation.x = 0.05 + nod;
            if (this.moodLight) {
                this.moodLight.intensity = 3.0 + Math.sin(elapsed * 12.0) * 1.5;
            }
        }
    }

    _updateParticles(elapsed) {
        if (!this.particles || !this.particleData) return;

        const posAttr = this.particles.geometry.attributes.position;
        const positions = posAttr.array;

        for (let i = 0; i < this.particleData.length; i++) {
            const p = this.particleData[i];
            p.angle += 0.015 * p.speed;

            const x = Math.cos(p.angle) * p.radius;
            const z = Math.sin(p.angle) * p.radius;
            const y = p.y + Math.sin(elapsed * 2.0 + i) * 0.12;

            positions[i * 3] = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = z;
        }

        posAttr.needsUpdate = true;
    }

    setEmotion(emotion, bubbleText = '') {
        this.currentEmotion = emotion;

        let lightColor = 0x00f5d4; // cyan
        let statusLabel = 'IDLE';
        let dotColor = 'var(--accent-cyan)';

        switch (emotion) {
            case 'happy':
                lightColor = 0x00f5d4;
                statusLabel = 'HAPPY';
                dotColor = 'var(--accent-cyan)';
                this.currentState = 'idle';
                break;
            case 'listening':
                lightColor = 0xf72585; // magenta
                statusLabel = 'LISTENING';
                dotColor = 'var(--accent-magenta)';
                this.currentState = 'listening';
                break;
            case 'thinking':
            case 'focused':
                lightColor = 0xffb703; // amber
                statusLabel = 'THINKING';
                dotColor = 'var(--accent-amber)';
                this.currentState = 'thinking';
                break;
            case 'working':
                lightColor = 0x7209b7; // violet
                statusLabel = 'WORKING';
                dotColor = 'var(--accent-violet)';
                this.currentState = 'working';
                break;
            case 'curious':
                lightColor = 0x9d4edd; // lavender
                statusLabel = 'PERMISSION';
                dotColor = 'var(--accent-purple)';
                this.currentState = 'thinking';
                break;
            case 'speaking':
                lightColor = 0x06d6a0; // emerald
                statusLabel = 'SPEAKING';
                dotColor = 'var(--accent-green)';
                this.isSpeaking = true;
                break;
            case 'worried':
                lightColor = 0xef476f; // rose
                statusLabel = 'WORRIED';
                dotColor = 'var(--accent-red)';
                this.currentState = 'idle';
                break;
            default:
                lightColor = 0x00f5d4;
                statusLabel = 'IDLE';
                dotColor = 'var(--accent-cyan)';
                this.currentState = 'idle';
                break;
        }

        if (emotion !== 'speaking') {
            this.isSpeaking = false;
        }

        if (this.moodLight) {
            this.moodLight.color.setHex(lightColor);
            this.moodLight.intensity = 3.5;
        }

        if (this.particles) {
            const colorAttr = this.particles.geometry.attributes.color;
            const colors = colorAttr.array;
            const c = new THREE.Color(lightColor);
            for (let i = 0; i < colorAttr.count; i++) {
                colors[i * 3] = c.r;
                colors[i * 3 + 1] = c.g;
                colors[i * 3 + 2] = c.b;
            }
            colorAttr.needsUpdate = true;
        }

        this.statusText.textContent = statusLabel;
        this.statusDot.style.background = dotColor;
        this.statusDot.style.boxShadow = `0 0 8px ${dotColor}`;

        if (bubbleText) {
            this.showBubble(bubbleText);
        }

        if (this.usingFallback && this.fallback2D) {
            this.fallback2D.setVisualState({ emotion });
        }
    }

    showBubble(text) {
        if (!text) return;
        this.speechBubble.textContent = text;
        this.speechBubble.classList.add('visible');

        if (this.speechTimer) clearTimeout(this.speechTimer);
        this.speechTimer = setTimeout(() => {
            this.speechBubble.classList.remove('visible');
        }, 6000);
    }

    playPetFlourish() {
        this.showBubble('Sparkle! ✨ Hehe, thank you! Ready for work!');
        this.setEmotion('happy');

        // Play flourish animation if available
        const attackClip = this.animations['DragonArmature|DragonArmature|Dragon_Attack2'] ||
                           this.animations['2H_Melee_Attack_Chop'];
        if (attackClip && this.activeAction) {
            attackClip.reset();
            attackClip.setLoop(THREE.LoopOnce, 1);
            attackClip.clampWhenFinished = false;
            attackClip.crossFadeFrom(this.activeAction, 0.2, true).play();

            const onFinished = () => {
                if (this.mixer) this.mixer.removeEventListener('finished', onFinished);
                if (this.activeAction) {
                    this.activeAction.reset().crossFadeFrom(attackClip, 0.3, true).play();
                }
            };
            this.mixer.addEventListener('finished', onFinished);
        }
    }

    _activate2DFallback() {
        this.usingFallback = true;
        this.threeCanvas.style.display = 'none';
        this.fallbackCanvas.style.display = 'block';

        if (typeof CelestialFamiliarRenderer === 'function') {
            this.fallback2D = new CelestialFamiliarRenderer(this.fallbackCanvas);
            this.fallback2D.start();
        }
        this.showBubble('Running in resilient 2D familiar mode.');
    }

    _bindUIEvents() {
        // Drag window across desktop
        const onDragStart = (e) => {
            if (e.button === 0 && !e.target.closest('button:not(.drag-handle)')) {
                this.isDragging = true;
                this.hasMoved = false;
                this.dragStart = { x: e.screenX, y: e.screenY };
                if (e.target.setPointerCapture) {
                    e.target.setPointerCapture(e.pointerId);
                }
            }
        };

        const onDragMove = (e) => {
            if (!this.isDragging) return;
            const dx = e.screenX - this.dragStart.x;
            const dy = e.screenY - this.dragStart.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                this.hasMoved = true;
                this.dragStart = { x: e.screenX, y: e.screenY };
                if (window.companionIpc) {
                    window.companionIpc.moveWindow(dx, dy);
                }
            }
        };

        const onDragEnd = (e) => {
            if (this.isDragging) {
                this.isDragging = false;
                if (e.target.releasePointerCapture) {
                    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
                }
            }
        };

        // Bind drag listeners to canvas and drag button
        this.threeCanvas.addEventListener('pointerdown', onDragStart);
        this.threeCanvas.addEventListener('pointermove', onDragMove);
        this.threeCanvas.addEventListener('pointerup', (e) => {
            onDragEnd(e);
            if (!this.hasMoved) {
                // It was a click on the creature!
                this.playPetFlourish();
                if (window.companionIpc) {
                    window.companionIpc.petCompanion();
                }
            }
        });

        this.dragBtn.addEventListener('pointerdown', onDragStart);
        this.dragBtn.addEventListener('pointermove', onDragMove);
        this.dragBtn.addEventListener('pointerup', onDragEnd);

        // Pet button
        this.petBtn.addEventListener('click', () => {
            this.playPetFlourish();
            if (window.companionIpc) {
                window.companionIpc.petCompanion();
            }
        });

        // Focus main assistant console
        this.focusBtn.addEventListener('click', () => {
            if (window.companionIpc) {
                window.companionIpc.focusMainWindow();
            }
        });

        // Dock to sidebar
        this.dockBtn.addEventListener('click', () => {
            if (window.companionIpc) {
                window.companionIpc.closeCompanionWindow();
            }
        });
    }

    _bindIpcEvents() {
        if (!window.companionIpc) return;

        // Visual state updates from coordinator
        window.companionIpc.onVisualUpdate((state) => {
            if (state && state.emotion) {
                this.setEmotion(state.emotion, state.speechBubble || '');
            }
        });

        // Voice state updates from voice controller
        window.companionIpc.onVoiceUpdate((voice) => {
            if (voice && voice.voiceState) {
                if (voice.voiceState === 'listening') {
                    this.setEmotion('listening', 'Listening... Speak now!');
                } else if (voice.voiceState === 'processing') {
                    this.setEmotion('thinking', 'Processing your voice...');
                } else if (voice.voiceState === 'speaking') {
                    this.setEmotion('speaking', voice.text || 'Speaking response...');
                } else if (voice.voiceState === 'idle') {
                    this.isSpeaking = false;
                    this.setEmotion('happy');
                }
            }
        });
    }
}

// Instantiate on load
window.addEventListener('DOMContentLoaded', () => {
    window.companionApp = new Companion3DApp();
});
