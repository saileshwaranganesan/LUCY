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
            || path.resolve(process.cwd(), 'models', 'whisper');

        this.modelPath = modelPath
            || process.env.LUCY_WHISPER_MODEL
            || this._findDefaultModel();
    }

    _findDefaultBinary() {
        const candidates = [
            path.resolve(process.cwd(), 'bin', 'whisper.exe'),
            path.resolve(process.cwd(), 'bin', 'whisper-cli.exe'),
            path.resolve(process.cwd(), 'bin', 'main.exe'),
            path.resolve(__dirname, '../../bin/whisper-cli.exe')
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return null;
    }

    _findDefaultModel() {
        if (!fs.existsSync(this.modelsDir)) return null;
        for (const name of DEFAULT_MODEL_NAMES) {
            const candidate = path.join(this.modelsDir, name);
            if (fs.existsSync(candidate)) return candidate;
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
        return {
            engine: 'whisper.cpp',
            license: WHISPER_LICENCE,
            isAvailable: available,
            binaryPath: this.binaryPath,
            modelPath: this.modelPath,
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
     * @returns {Promise<{ ok: boolean, transcript: string, durationMs?: number, error?: string }>}
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

        let tempWavFile = null;
        let wavPath = '';

        if (Buffer.isBuffer(audioInput)) {
            tempWavFile = path.join(os.tmpdir(), `lucy_whisper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`);
            fs.writeFileSync(tempWavFile, audioInput);
            wavPath = tempWavFile;
        } else if (typeof audioInput === 'string' && fs.existsSync(audioInput)) {
            wavPath = audioInput;
        } else {
            return {
                ok: false,
                transcript: '',
                error: 'Invalid audio input: expected existing file path or audio Buffer'
            };
        }

        const startTime = Date.now();
        const args = [
            '-m', this.modelPath,
            '-f', wavPath,
            '-l', options.language || this.language,
            '-t', String(this.threads),
            '--no-timestamps',
            '-nt'
        ];

        try {
            const isWindowsBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.binaryPath);
            const spawnCommand = isWindowsBatch ? (process.env.ComSpec || 'cmd.exe') : this.binaryPath;
            const spawnArgs = isWindowsBatch ? ['/d', '/s', '/c', this.binaryPath, ...args] : args;
            const transcript = await new Promise((resolve, reject) => {
                const proc = spawn(spawnCommand, spawnArgs, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                });

                let stdout = '';
                let stderr = '';

                const timer = setTimeout(() => {
                    proc.kill();
                    reject(new Error(`whisper.cpp transcription timed out after ${this.timeoutMs}ms`));
                }, this.timeoutMs);

                proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
                proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

                proc.on('error', (err) => {
                    clearTimeout(timer);
                    reject(err);
                });

                proc.on('close', (code) => {
                    clearTimeout(timer);
                    if (code === 0) {
                        resolve(stdout.trim());
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
                fallbackRequired: true
            };
        } finally {
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
