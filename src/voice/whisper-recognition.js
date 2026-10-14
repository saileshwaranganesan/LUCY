'use strict';

/**
 * Offline Speech Recognition Service for L.U.C.Y. (REQ-027)
 * Powered by whisper.cpp (MIT License by Georgi Gerganov).
 * 
 * Guarantees:
 * 1. 100% offline, local execution with zero cloud audio transmission.
 * 2. Permissive MIT license compatibility.
 * 3. Safe fallback to Web Speech API or manual text input if binary/weights are absent.
 * 4. Subprocess argument sanitization and timeout protection.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WHISPER_LICENCE = 'MIT';
const DEFAULT_MODEL_NAMES = ['ggml-tiny.bin', 'ggml-tiny.en.bin', 'ggml-base.bin', 'ggml-base.en.bin'];

class WhisperOfflineRecognitionEngine {
    constructor({
        binaryPath = null,
        modelPath = null,
        modelsDir = null,
        language = 'en',
        threads = null,
        timeoutMs = 30000
    } = {}) {
        this.language = language;
        this.threads = threads || Math.max(1, Math.min(4, os.cpus() ? os.cpus().length - 1 : 2));
        this.timeoutMs = timeoutMs;

        // Discover binary path
        this.binaryPath = binaryPath
            || process.env.LUCY_WHISPER_PATH
            || process.env.WHISPER_BIN
            || this._findDefaultBinary();

        // Discover model path
        this.modelsDir = modelsDir
            || process.env.LUCY_WHISPER_MODELS_DIR
            || (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models', 'whisper'))
                ? path.join(process.resourcesPath, 'models', 'whisper')
                : null)
            || path.resolve(process.cwd(), 'models', 'whisper');

        this.modelPath = modelPath
            || process.env.LUCY_WHISPER_MODEL
            || this._findDefaultModel();
    }

    _findDefaultBinary() {
        const candidates = [];
        if (process.resourcesPath) {
            candidates.push(
                path.join(process.resourcesPath, 'bin', 'whisper-cli.exe'),
                path.join(process.resourcesPath, 'bin', 'whisper.exe'),
                path.join(process.resourcesPath, 'bin', 'main.exe')
            );
        }
        candidates.push(
            path.resolve(process.cwd(), 'bin', 'whisper-cli.exe'),
            path.resolve(process.cwd(), 'bin', 'whisper.exe'),
            path.resolve(process.cwd(), 'bin', 'main.exe'),
            path.resolve(__dirname, '../../bin/whisper-cli.exe'),
            path.resolve(__dirname, '../../bin/whisper.exe'),
            path.resolve(__dirname, '../../bin/main.exe')
        );
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return null;
    }

    _findDefaultModel() {
        const candidateDirs = [];
        if (process.resourcesPath) {
            candidateDirs.push(path.join(process.resourcesPath, 'models', 'whisper'));
        }
        if (this.modelsDir) {
            candidateDirs.push(this.modelsDir);
        }
        candidateDirs.push(
            path.resolve(process.cwd(), 'models', 'whisper'),
            path.resolve(__dirname, '../../models/whisper')
        );

        for (const dir of candidateDirs) {
            if (!dir || !fs.existsSync(dir)) continue;
            for (const name of DEFAULT_MODEL_NAMES) {
                const candidate = path.join(dir, name);
                if (fs.existsSync(candidate)) return candidate;
            }
        }
        return null;
    }

    /**
     * Check whether whisper.cpp binary and model weights are ready for offline inference.
     */
    isAvailable() {
        return Boolean(
            this.binaryPath && fs.existsSync(this.binaryPath) &&
            this.modelPath && fs.existsSync(this.modelPath)
        );
    }

    /**
     * Get engine capability status and licensing metadata.
     */
    getStatus() {
        const available = this.isAvailable();
        let modelSizeBytes = null;
        if (this.modelPath && fs.existsSync(this.modelPath)) {
            try {
                modelSizeBytes = fs.statSync(this.modelPath).size;
            } catch (_) {}
        }
        return {
            engine: 'whisper.cpp',
            license: WHISPER_LICENCE,
            isAvailable: available,
            binaryPath: this.binaryPath,
            modelPath: this.modelPath,
            modelSize: modelSizeBytes,
            language: this.language,
            threads: this.threads,
            message: available
                ? 'whisper.cpp offline speech recognition is ready'
                : 'whisper.cpp binary or model weights not detected; falling back to Web Speech API'
        };
    }

    /**
     * Transcribe a WAV audio file or buffer using local whisper.cpp executable.
     * @param {string|Buffer} audioInput - File path to 16kHz WAV file or Buffer.
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] - Optional AbortSignal for cancellation.
     * @param {number} [options.timeoutMs] - Optional custom timeout in milliseconds.
     * @returns {Promise<{ ok: boolean, transcript: string, durationMs?: number, error?: string, cancelled?: boolean }>}
     */
    async transcribeAudio(audioInput, options = {}) {
        const status = this.getStatus();
        if (!status.isAvailable) {
            return {
                ok: false,
                transcript: '',
                error: status.message,
                fallbackRequired: true
            };
        }

        if (options.signal && options.signal.aborted) {
            return {
                ok: false,
                transcript: '',
                error: 'Transcription was cancelled before start',
                cancelled: true
            };
        }

        let tempWavFile = null;
        let wavPath = '';

        if (Buffer.isBuffer(audioInput)) {
            if (audioInput.length === 0) {
                return {
                    ok: false,
                    transcript: '',
                    error: 'Invalid audio input: audio buffer is empty'
                };
            }
            tempWavFile = path.join(os.tmpdir(), `lucy_whisper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`);
            fs.writeFileSync(tempWavFile, audioInput);
            wavPath = tempWavFile;
        } else if (typeof audioInput === 'string' && fs.existsSync(audioInput)) {
            const stat = fs.statSync(audioInput);
            if (stat.size === 0) {
                return {
                    ok: false,
                    transcript: '',
                    error: 'Invalid audio input: audio file is empty'
                };
            }
            wavPath = audioInput;
        } else {
            return {
                ok: false,
                transcript: '',
                error: 'Invalid audio input: expected existing file path or non-empty audio Buffer'
            };
        }

        const startTime = Date.now();
        const timeoutMs = options.timeoutMs || this.timeoutMs;
        const args = [
            '-m', this.modelPath,
            '-f', wavPath,
            '-l', options.language || this.language,
            '-t', String(this.threads),
            '-nt',
            '-np'
        ];

        let proc = null;
        let abortHandler = null;

        try {
            const isWindowsBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.binaryPath);
            const spawnCommand = isWindowsBatch ? (process.env.ComSpec || 'cmd.exe') : this.binaryPath;
            const spawnArgs = isWindowsBatch ? ['/d', '/s', '/c', this.binaryPath, ...args] : args;

            const transcript = await new Promise((resolve, reject) => {
                proc = spawn(spawnCommand, spawnArgs, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                });

                let stdout = '';
                let stderr = '';
                let timedOut = false;
                let cancelled = false;

                const timer = setTimeout(() => {
                    timedOut = true;
                    try { proc.kill(); } catch (_) {}
                    reject(new Error(`whisper.cpp transcription timed out after ${timeoutMs}ms`));
                }, timeoutMs);

                if (options.signal) {
                    abortHandler = () => {
                        cancelled = true;
                        clearTimeout(timer);
                        try { proc.kill(); } catch (_) {}
                        const err = new Error('Transcription was cancelled');
                        err.cancelled = true;
                        reject(err);
                    };
                    options.signal.addEventListener('abort', abortHandler, { once: true });
                }

                proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
                proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

                proc.on('error', (err) => {
                    clearTimeout(timer);
                    reject(err);
                });

                proc.on('close', (code) => {
                    clearTimeout(timer);
                    if (timedOut || cancelled) return;
                    if (code === 0) {
                        // Clean whitespace and any stray brackets
                        const cleaned = stdout.trim().replace(/^\[\d+:\d+:\d+\.\d+\s*-->\s*\d+:\d+:\d+\.\d+\]\s*/gm, '').trim();
                        resolve(cleaned);
                    } else {
                        reject(new Error(`whisper.cpp exited with code ${code}: ${stderr.trim()}`));
                    }
                });
            });

            return {
                ok: true,
                transcript,
                durationMs: Date.now() - startTime,
                engine: 'whisper.cpp',
                license: WHISPER_LICENCE
            };
        } catch (err) {
            return {
                ok: false,
                transcript: '',
                error: err.message,
                cancelled: Boolean(err.cancelled),
                fallbackRequired: !err.cancelled
            };
        } finally {
            if (options.signal && abortHandler) {
                try { options.signal.removeEventListener('abort', abortHandler); } catch (_) {}
            }
            if (tempWavFile && fs.existsSync(tempWavFile)) {
                try { fs.unlinkSync(tempWavFile); } catch (_) {}
            }
        }
    }
}

module.exports = {
    WhisperOfflineRecognitionEngine,
    WHISPER_LICENCE
};
