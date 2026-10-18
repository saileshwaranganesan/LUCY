'use strict';

/**
 * Kokoro-82M Local Speech Synthesis Service for L.U.C.Y.
 * 
 * Implements resource-efficient, local, free text-to-speech using quantized Kokoro ONNX.
 * 
 * Core Design:
 * 1. On-demand lifecycle: Model is never loaded by default on app launch.
 * 2. Separate worker process: Python ONNX Runtime worker runs in its own process,
 *    allowing immediate stoppage/unloading without blocking UI or wake-word listener.
 * 3. Memory budget enforcement: Monitors process RSS and system available RAM.
 *    Clamps memory to configurable budget (default 450 MB).
 * 4. Memory-aware unloading: Unloads model after configurable idle time (default 30s)
 *    and frees ~200MB+ memory back to OS.
 * 5. Audio playback queue: Sequentially queues utterances, prevents overlapping audio.
 * 6. Cancellation: Instant playback stop and worker inference abort.
 * 7. Zero-cost fallback: If Kokoro worker fails, model is missing, or memory budget
 *    is exceeded, transparently falls back to the native Windows speech facility.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const EventEmitter = require('events');

function resolveKokoroModelPath() {
    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'models', 'kokoro', 'kokoro-v1.0.int8.onnx'));
    }
    candidates.push(path.resolve(__dirname, '..', '..', 'models', 'kokoro', 'kokoro-v1.0.int8.onnx'));
    candidates.push(path.resolve(process.cwd(), 'models', 'kokoro', 'kokoro-v1.0.int8.onnx'));
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[0];
}

function resolveKokoroVoicePath() {
    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'models', 'kokoro', 'voices.bin'));
        candidates.push(path.join(process.resourcesPath, 'models', 'kokoro', 'af_bella.bin'));
    }
    candidates.push(path.resolve(__dirname, '..', '..', 'models', 'kokoro', 'voices.bin'));
    candidates.push(path.resolve(__dirname, '..', '..', 'models', 'kokoro', 'af_bella.bin'));
    candidates.push(path.resolve(process.cwd(), 'models', 'kokoro', 'voices.bin'));
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[0];
}

function resolveKokoroWorkerScriptPath() {
    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'voice', 'kokoro-worker.py'));
        candidates.push(path.join(process.resourcesPath, 'kokoro-worker.py'));
    }
    if (typeof __dirname !== 'undefined') {
        if (__dirname.includes('app.asar')) {
            candidates.push(__dirname.replace('app.asar', 'app.asar.unpacked') + path.sep + 'kokoro-worker.py');
        }
        candidates.push(path.resolve(__dirname, 'kokoro-worker.py'));
    }
    candidates.push(path.resolve(process.cwd(), 'src', 'voice', 'kokoro-worker.py'));
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[0];
}

const DEFAULT_MODEL_PATH = resolveKokoroModelPath();
const DEFAULT_VOICE_PATH = resolveKokoroVoicePath();
const WORKER_SCRIPT_PATH = resolveKokoroWorkerScriptPath();

class KokoroTtsService extends EventEmitter {
    constructor({
        pythonPath = 'python',
        modelPath = resolveKokoroModelPath(),
        voicePath = resolveKokoroVoicePath(),
        workerScriptPath = resolveKokoroWorkerScriptPath(),
        voiceName = 'af_bella',
        maxRssMb = 450,
        minAvailableMemMb = 300,
        idleUnloadTimeoutMs = 30000,
        threads = 4,
        fallbackService = null,
        onStateChange = () => {},
        onError = () => {}
    } = {}) {
        super();
        this.pythonPath = pythonPath;
        this.modelPath = path.resolve(modelPath);
        this.voicePath = path.resolve(voicePath);
        this.workerScriptPath = path.resolve(workerScriptPath);
        this.voiceName = voiceName;
        this.maxRssMb = maxRssMb;
        this.minAvailableMemMb = minAvailableMemMb;
        this.idleUnloadTimeoutMs = idleUnloadTimeoutMs;
        this.threads = threads;
        this.fallbackService = fallbackService;
        this.onStateChange = onStateChange;
        this.onError = onError;

        this.workerProcess = null;
        this.rl = null;
        this.isLoaded = false;
        this.isSpeaking = false;
        this.activeSpeechGeneration = 0;
        this.idleTimer = null;
        this.pendingRequests = new Map();
        this.requestIdCounter = 0;
        this.speechQueue = [];
        this.activeAudio = null;
        this.lastMemoryInfo = null;
        this.state = 'idle'; // 'idle' | 'loading' | 'synthesizing' | 'speaking' | 'error'
    }

    /**
     * Check if local model weights and worker script are physically present.
     */
    isAvailable() {
        return fs.existsSync(this.modelPath) &&
               fs.existsSync(this.voicePath) &&
               fs.existsSync(this.workerScriptPath);
    }

    /**
     * Start the background worker process if not already running.
     */
    _ensureWorker() {
        if (this.workerProcess && !this.workerProcess.killed) {
            return this.workerProcess;
        }

        const proc = spawn(this.pythonPath, [this.workerScriptPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });

        proc.stdin.on('error', () => {}); // Prevent unhandled EPIPE on worker exit/kill

        this.workerProcess = proc;
        this.rl = readline.createInterface({ input: proc.stdout });

        this.rl.on('line', (line) => {
            line = line.trim();
            if (!line) return;
            try {
                const res = JSON.parse(line);
                if (res.memory) {
                    this.lastMemoryInfo = res.memory;
                }
                const reqId = res._reqId;
                if (reqId && this.pendingRequests.has(reqId)) {
                    const { resolve, reject } = this.pendingRequests.get(reqId);
                    this.pendingRequests.delete(reqId);
                    if (res.status === 'error') {
                        reject(new Error(res.error || 'Worker error'));
                    } else {
                        resolve(res);
                    }
                } else {
                    // Match by action if no reqId
                    for (const [id, req] of this.pendingRequests.entries()) {
                        if (req.action === res.action) {
                            this.pendingRequests.delete(id);
                            if (res.status === 'error') {
                                req.reject(new Error(res.error || 'Worker error'));
                            } else {
                                req.resolve(res);
                            }
                            break;
                        }
                    }
                }
            } catch (err) {
                // Non-JSON worker debug/log output
            }
        });

        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                this.emit('workerStderr', msg);
            }
        });

        proc.on('error', (err) => {
            this._setState('error', { error: err.message });
            this.onError(err);
            this._cleanupWorker();
        });

        proc.on('exit', (code, signal) => {
            this.isLoaded = false;
            this.isSpeaking = false;
            this._cleanupWorker();
            this.emit('workerExit', { code, signal });
        });

        return proc;
    }

    _cleanupWorker() {
        if (this.rl) {
            try { this.rl.close(); } catch (_) {}
            this.rl = null;
        }
        if (this.workerProcess) {
            try { this.workerProcess.kill(); } catch (_) {}
            this.workerProcess = null;
        }
        // Reject any dangling pending requests
        for (const [id, req] of this.pendingRequests.entries()) {
            req.reject(new Error('Kokoro worker process terminated unexpectedly'));
        }
        this.pendingRequests.clear();
    }

    _setState(newState, payload = {}) {
        this.state = newState;
        this.onStateChange({ state: newState, ...payload });
        this.emit('stateChange', { state: newState, ...payload });
    }

    _sendCommand(cmdObj) {
        return new Promise((resolve, reject) => {
            try {
                this._ensureWorker();
                const reqId = ++this.requestIdCounter;
                cmdObj._reqId = reqId;
                this.pendingRequests.set(reqId, {
                    resolve,
                    reject,
                    action: cmdObj.cmd,
                    timestamp: Date.now()
                });
                this.workerProcess.stdin.write(JSON.stringify(cmdObj) + '\n');
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Load the model on demand into the worker process.
     */
    async loadModel() {
        if (this.isLoaded) return true;
        this._cancelIdleTimer();
        this._setState('loading');

        try {
            const res = await this._sendCommand({
                cmd: 'load',
                model_path: this.modelPath,
                voice_path: this.voicePath,
                threads: this.threads
            });

            if (res.status === 'ok') {
                this.isLoaded = true;
                this._setState('idle');
                return true;
            } else {
                throw new Error(res.error || 'Failed to load Kokoro ONNX model');
            }
        } catch (err) {
            this._setState('error', { error: err.message });
            this.onError(err);
            return false;
        }
    }

    /**
     * Unload the model from worker memory.
     */
    async unloadModel() {
        this._cancelIdleTimer();
        if (!this.workerProcess || !this.isLoaded) return true;

        try {
            const res = await this._sendCommand({ cmd: 'unload' });
            this.isLoaded = false;
            this._setState('idle');
            return res.status === 'ok';
        } catch (err) {
            return false;
        }
    }

    _resetIdleTimer() {
        this._cancelIdleTimer();
        if (this.idleUnloadTimeoutMs > 0) {
            this.idleTimer = setTimeout(() => {
                if (!this.isSpeaking && this.isLoaded && this.speechQueue.length === 0) {
                    this.unloadModel().catch(() => {});
                }
            }, this.idleUnloadTimeoutMs);
            if (this.idleTimer.unref) {
                this.idleTimer.unref();
            }
        }
    }

    _cancelIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * Synthesize speech using Kokoro or fallback if unavailable/over budget.
     */
    async speak(text, options = {}) {
        if (!text || typeof text !== 'string' || !text.trim()) {
            return false;
        }

        const generation = this.activeSpeechGeneration;
        this._cancelIdleTimer();

        // 1. Check memory safety budget before loading
        if (this.lastMemoryInfo) {
            if (this.lastMemoryInfo.rss_mb > this.maxRssMb ||
                this.lastMemoryInfo.system_available_mb < this.minAvailableMemMb) {
                // Exceeded memory budget! Unload model and fall back to Windows TTS
                await this.unloadModel().catch(() => {});
                if (this.fallbackService) {
                    return this.fallbackService.speak(text, options);
                }
                return false;
            }
        }

        // 2. Fall back if Kokoro assets are missing
        if (!this.isAvailable()) {
            if (this.fallbackService) {
                return this.fallbackService.speak(text, options);
            }
            return false;
        }

        // 3. Conversational natural sentence chunking for low perceived latency
        const trimmed = text.trim();
        const sentences = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
        if (options.chunk !== false && sentences && sentences.length > 1 && trimmed.length > 50) {
            let allOk = true;
            for (const sentence of sentences) {
                const sTrimmed = sentence.trim();
                if (!sTrimmed) continue;
                if (generation !== this.activeSpeechGeneration) return false;
                const chunkOk = await new Promise((resolve) => {
                    this.speechQueue.push({
                        generation,
                        text: sTrimmed,
                        options,
                        resolve
                    });
                    this._processQueue();
                });
                if (!chunkOk) allOk = false;
            }
            return allOk;
        }

        // Single utterance queue
        return new Promise((resolve) => {
            this.speechQueue.push({
                generation,
                text: trimmed,
                options,
                resolve
            });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this.isSpeaking || this.speechQueue.length === 0) {
            return;
        }

        const item = this.speechQueue.shift();
        if (item.generation !== this.activeSpeechGeneration) {
            item.resolve(false);
            return this._processQueue();
        }

        this.isSpeaking = true;
        this._setState('synthesizing', { text: item.text });

        try {
            // Ensure model is loaded on-demand
            if (!this.isLoaded) {
                const loaded = await this.loadModel();
                if (!loaded) {
                    // Fall back
                    this.isSpeaking = false;
                    if (this.fallbackService) {
                        const fallbackRes = await this.fallbackService.speak(item.text, item.options);
                        item.resolve(fallbackRes);
                    } else {
                        item.resolve(false);
                    }
                    return this._processQueue();
                }
            }

            if (item.generation !== this.activeSpeechGeneration) {
                this.isSpeaking = false;
                item.resolve(false);
                return this._processQueue();
            }

            // Execute synthesis in worker
            const res = await this._sendCommand({
                cmd: 'synthesize',
                text: item.text,
                voice: item.options.voice || this.voiceName,
                speed: item.options.rate || 1.0,
                lang: item.options.lang || 'en-us'
            });

            if (item.generation !== this.activeSpeechGeneration || res.status === 'cancelled') {
                this.isSpeaking = false;
                item.resolve(false);
                return this._processQueue();
            }

            if (res.status === 'ok' && res.audio) {
                this._setState('speaking', { text: item.text, duration: res.duration_s });
                this.emit('synthesized', {
                    text: item.text,
                    duration: res.duration_s,
                    latency: res.latency_ms,
                    rtf: res.rtf,
                    memory: res.memory
                });

                // Play audio if in browser / Electron environment
                await this._playAudio(res.audio, item.generation);
                item.resolve(true);
            } else {
                throw new Error(res.error || 'Synthesis returned no audio');
            }
        } catch (err) {
            this.onError(err);
            // On failure, transparent fallback to native Windows speech
            if (this.fallbackService && item.generation === this.activeSpeechGeneration) {
                try {
                    const fallbackRes = await this.fallbackService.speak(item.text, item.options);
                    item.resolve(fallbackRes);
                } catch (_) {
                    item.resolve(false);
                }
            } else {
                item.resolve(false);
            }
        } finally {
            this.isSpeaking = false;
            this._setState('idle');
            this._resetIdleTimer();
            this._processQueue();
        }
    }

    async _playAudio(audioDataUri, generation) {
        if (typeof Audio === 'undefined') {
            // Node / testing environment: simulate audio playback duration or resolve
            return;
        }

        return new Promise((resolve) => {
            const audio = new Audio(audioDataUri);
            this.activeAudio = audio;

            const cleanup = () => {
                if (this.activeAudio === audio) {
                    this.activeAudio = null;
                }
                resolve();
            };

            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.onabort = cleanup;

            audio.play().catch(() => {
                cleanup();
            });
        });
    }

    /**
     * Stop and cancel any active speech synthesis and playback immediately.
     */
    stop() {
        this.activeSpeechGeneration++;
        const queued = this.speechQueue.splice(0, this.speechQueue.length);
        for (const item of queued) {
            item.resolve(false);
        }

        if (this.activeAudio) {
            try {
                this.activeAudio.pause();
                this.activeAudio.currentTime = 0;
            } catch (_) {}
            this.activeAudio = null;
        }

        if (this.workerProcess && this.isLoaded) {
            this._sendCommand({ cmd: 'cancel' }).catch(() => {});
        }

        if (this.fallbackService) {
            this.fallbackService.stop();
        }

        this.isSpeaking = false;
        this._setState('idle');
        this._resetIdleTimer();
    }

    /**
     * Gracefully terminate worker process and clear timers.
     */
    dispose() {
        this.activeSpeechGeneration++;
        this._cancelIdleTimer();
        this.speechQueue.length = 0;
        if (this.activeAudio) {
            try {
                this.activeAudio.pause();
                this.activeAudio.currentTime = 0;
            } catch (_) {}
            this.activeAudio = null;
        }
        if (this.workerProcess) {
            const proc = this.workerProcess;
            this.workerProcess = null;
            if (this.rl) {
                try { this.rl.close(); } catch (_) {}
                this.rl = null;
            }
            try {
                proc.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n');
            } catch (_) {}
            try {
                proc.kill();
            } catch (_) {}
        }
        for (const [id, req] of this.pendingRequests.entries()) {
            req.resolve({ status: 'disposed' });
        }
        this.pendingRequests.clear();
        this.isSpeaking = false;
        this.isLoaded = false;
        this._setState('idle');
    }
}

module.exports = {
    KokoroTtsService,
    DEFAULT_MODEL_PATH,
    DEFAULT_VOICE_PATH,
    WORKER_SCRIPT_PATH,
    resolveKokoroModelPath,
    resolveKokoroVoicePath,
    resolveKokoroWorkerScriptPath
};
