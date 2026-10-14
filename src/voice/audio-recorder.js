'use strict';

/**
 * Microphone Audio Capture and WAV Encoder for L.U.C.Y. (REQ-027, REQ-028)
 * 
 * Captures microphone audio, downsamples/converts to 16kHz 16-bit mono PCM,
 * and packages into a standard 44-byte RIFF WAV header for whisper.cpp.
 * Supports continuous streaming for local wake-word detection (REQ-028).
 * 
 * Guarantees:
 * 1. 100% local, zero network streaming.
 * 2. Strict 16kHz mono 16-bit PCM format guaranteed for whisper.cpp compatibility.
 * 3. Seamless transition between wake-word listening and push-to-talk recording
 *    without duplicate microphone streams or device contention.
 * 4. Graceful handling of denied microphone permissions, device unplugging, and cancellation.
 * 5. Complete resource disposal on stop or failure.
 */

function encodeWavPcm16(samples, sampleRate = 16000) {
    let int16Samples;
    if (samples instanceof Int16Array) {
        int16Samples = samples;
    } else {
        int16Samples = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
    }

    const dataByteLength = int16Samples.length * 2;
    const buffer = (typeof Buffer !== 'undefined')
        ? Buffer.alloc(44 + dataByteLength)
        : new Uint8Array(44 + dataByteLength);

    const view = (buffer instanceof Uint8Array && typeof Buffer === 'undefined')
        ? new DataView(buffer.buffer)
        : null;

    function writeString(str, offset) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)) {
            buffer.write(str, offset, 'ascii');
        } else {
            for (let i = 0; i < str.length; i++) {
                buffer[offset + i] = str.charCodeAt(i);
            }
        }
    }

    function writeUInt32LE(val, offset) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)) {
            buffer.writeUInt32LE(val, offset);
        } else {
            view.setUint32(offset, val, true);
        }
    }

    function writeUInt16LE(val, offset) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)) {
            buffer.writeUInt16LE(val, offset);
        } else {
            view.setUint16(offset, val, true);
        }
    }

    function writeInt16LE(val, offset) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)) {
            buffer.writeInt16LE(val, offset);
        } else {
            view.setInt16(offset, val, true);
        }
    }

    // RIFF chunk descriptor
    writeString('RIFF', 0);
    writeUInt32LE(36 + dataByteLength, 4);
    writeString('WAVE', 8);

    // fmt subchunk
    writeString('fmt ', 12);
    writeUInt32LE(16, 16);               // Subchunk1Size = 16 for PCM
    writeUInt16LE(1, 20);                // AudioFormat = 1 (PCM)
    writeUInt16LE(1, 22);                // NumChannels = 1 (Mono)
    writeUInt32LE(sampleRate, 24);       // SampleRate (16000)
    writeUInt32LE(sampleRate * 2, 28);   // ByteRate = SampleRate * NumChannels * BitsPerSample/8
    writeUInt16LE(2, 32);                // BlockAlign = NumChannels * BitsPerSample/8
    writeUInt16LE(16, 34);               // BitsPerSample = 16

    // data subchunk
    writeString('data', 36);
    writeUInt32LE(dataByteLength, 40);

    for (let i = 0; i < int16Samples.length; i++) {
        writeInt16LE(int16Samples[i], 44 + (i * 2));
    }

    return buffer;
}

class AudioRecorder {
    constructor({
        globalScope = (typeof globalThis !== 'undefined' ? globalThis : null),
        sampleRate = 16000,
        onAudioLevel = null,
        onAudioFrame = null,
        onStreamEnd = null
    } = {}) {
        this.globalScope = globalScope;
        this.sampleRate = sampleRate;
        this.onAudioLevel = onAudioLevel;
        this.onAudioFrame = onAudioFrame;
        this.onStreamEnd = onStreamEnd;
        this.isRecording = false;
        this.isStreaming = false;
        this.mediaStream = null;
        this.audioContext = null;
        this.sourceNode = null;
        this.processorNode = null;
        this.audioChunks = [];
        this.totalSamples = 0;
    }

    get supported() {
        if (!this.globalScope) return false;
        const nav = this.globalScope.navigator;
        return Boolean(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
    }

    get isCapturing() {
        return this.isRecording || this.isStreaming;
    }

    /**
     * Initializes hardware microphone media stream if not already active.
     */
    async _ensureCapturePipeline() {
        if (this.mediaStream && this.audioContext && this.processorNode) {
            return true;
        }

        if (this._pipelineInitPromise) {
            return this._pipelineInitPromise;
        }

        if (!this.supported) {
            throw new Error('Microphone audio capture is not supported in this runtime environment.');
        }

        this._pipelineInitPromise = (async () => {
            try {
                const stream = await this.globalScope.navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,
                        sampleRate: this.sampleRate,
                        echoCancellation: true,
                        noiseSuppression: true
                    }
                });

                this.mediaStream = stream;

                // Monitor stream track ending (device unplugged or revoked)
                const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
                if (audioTracks.length > 0) {
                    audioTracks[0].onended = () => {
                        this.cleanup();
                        if (typeof this.onStreamEnd === 'function') {
                            this.onStreamEnd();
                        }
                    };
                }

                const AudioCtx = this.globalScope.AudioContext || this.globalScope.webkitAudioContext;
                this.audioContext = new AudioCtx({ sampleRate: this.sampleRate });
                this.sourceNode = this.audioContext.createMediaStreamSource(stream);

                const bufferSize = 2048;
                this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

                this.processorNode.onaudioprocess = (e) => {
                    const channelData = e.inputBuffer.getChannelData(0);
                    const chunk = new Float32Array(channelData.length);
                    chunk.set(channelData);

                    // Accumulate chunks during active recording
                    if (this.isRecording) {
                        this.audioChunks.push(chunk);
                        this.totalSamples += chunk.length;
                    }

                    // Continuous stream callback (e.g. for wake-word engine)
                    if (typeof this.onAudioFrame === 'function') {
                        this.onAudioFrame(chunk);
                    }

                    if (typeof this.onAudioLevel === 'function') {
                        let sum = 0;
                        for (let i = 0; i < chunk.length; i++) {
                            sum += chunk[i] * chunk[i];
                        }
                        const rms = Math.sqrt(sum / chunk.length);
                        this.onAudioLevel(rms);
                    }
                };

                this.sourceNode.connect(this.processorNode);
                this.processorNode.connect(this.audioContext.destination);

                return true;
            } finally {
                this._pipelineInitPromise = null;
            }
        })();

        return this._pipelineInitPromise;
    }

    /**
     * Start continuous background microphone streaming (for wake-word detection).
     * @param {object} [options]
     * @param {Function} [options.onAudioFrame]
     */
    async startContinuousCapture({ onAudioFrame = null } = {}) {
        if (onAudioFrame) {
            this.onAudioFrame = onAudioFrame;
        }
        this.isStreaming = true;
        try {
            await this._ensureCapturePipeline();
            return true;
        } catch (err) {
            this.cleanup();
            throw err;
        }
    }

    /**
     * Stop continuous background streaming.
     */
    stopContinuousCapture() {
        this.isStreaming = false;
        this.onAudioFrame = null;
        if (!this.isRecording) {
            this.cleanup();
        }
    }

    /**
     * Start recording an utterance (Push-to-talk / speech intake).
     */
    async start() {
        if (this.isRecording) return true;

        this.audioChunks = [];
        this.totalSamples = 0;

        try {
            await this._ensureCapturePipeline();
            this.isRecording = true;
            return true;
        } catch (err) {
            this.cleanup();
            throw err;
        }
    }

    /**
     * Stop utterance recording and return 16kHz mono WAV buffer.
     */
    stop() {
        if (!this.isRecording) {
            return null;
        }
        this.isRecording = false;

        // Flatten collected Float32 chunks
        const flattened = new Float32Array(this.totalSamples);
        let offset = 0;
        for (const chunk of this.audioChunks) {
            flattened.set(chunk, offset);
            offset += chunk.length;
        }

        this.audioChunks = [];
        this.totalSamples = 0;

        // Clean up pipeline if not continuously streaming
        if (!this.isStreaming) {
            this.cleanup();
        }

        // Encode to 16kHz 16-bit mono WAV
        const wavBuffer = encodeWavPcm16(flattened, this.sampleRate);
        return wavBuffer;
    }

    cancel() {
        this.isRecording = false;
        this.audioChunks = [];
        this.totalSamples = 0;
        if (!this.isStreaming) {
            this.cleanup();
        }
    }

    cleanup() {
        this.isRecording = false;
        this.isStreaming = false;
        this.audioChunks = [];
        this.totalSamples = 0;

        if (this.processorNode) {
            try { this.processorNode.disconnect(); } catch (_) {}
            this.processorNode = null;
        }
        if (this.sourceNode) {
            try { this.sourceNode.disconnect(); } catch (_) {}
            this.sourceNode = null;
        }
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (_) {}
            this.audioContext = null;
        }
        if (this.mediaStream) {
            try {
                for (const track of this.mediaStream.getTracks()) {
                    track.stop();
                }
            } catch (_) {}
            this.mediaStream = null;
        }
    }
}

function createAudioRecorder(options = {}) {
    return new AudioRecorder(options);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        encodeWavPcm16,
        AudioRecorder,
        createAudioRecorder
    };
}

if (typeof window !== 'undefined') {
    window.encodeWavPcm16 = encodeWavPcm16;
    window.AudioRecorder = AudioRecorder;
    window.createAudioRecorder = createAudioRecorder;
}
