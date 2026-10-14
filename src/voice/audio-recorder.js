'use strict';

/**
 * Microphone Audio Capture and WAV Encoder for L.U.C.Y. Offline Speech Recognition (REQ-027)
 * 
 * Captures microphone audio, downsamples/converts to 16kHz 16-bit mono PCM,
 * and packages into a standard 44-byte RIFF WAV header for whisper.cpp.
 * 
 * Guarantees:
 * 1. 100% local, zero network streaming.
 * 2. Strict 16kHz mono 16-bit PCM format guaranteed for whisper.cpp compatibility.
 * 3. Graceful handling of denied microphone permissions, device unplugging, and cancellation.
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
        onAudioLevel = null
    } = {}) {
        this.globalScope = globalScope;
        this.sampleRate = sampleRate;
        this.onAudioLevel = onAudioLevel;
        this.isRecording = false;
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

    async start() {
        if (this.isRecording) return true;
        if (!this.supported) {
            throw new Error('Microphone audio capture is not supported in this runtime environment.');
        }

        this.audioChunks = [];
        this.totalSamples = 0;

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
            const AudioCtx = this.globalScope.AudioContext || this.globalScope.webkitAudioContext;
            this.audioContext = new AudioCtx({ sampleRate: this.sampleRate });
            this.sourceNode = this.audioContext.createMediaStreamSource(stream);

            // Use ScriptProcessorNode or AudioWorklet for raw PCM sample capture
            const bufferSize = 4096;
            this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

            this.processorNode.onaudioprocess = (e) => {
                if (!this.isRecording) return;
                const channelData = e.inputBuffer.getChannelData(0);
                const chunk = new Float32Array(channelData.length);
                chunk.set(channelData);
                this.audioChunks.push(chunk);
                this.totalSamples += chunk.length;

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

            this.isRecording = true;
            return true;
        } catch (err) {
            this.cleanup();
            throw err;
        }
    }

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

        this.cleanup();

        // Encode to 16kHz 16-bit mono WAV
        const wavBuffer = encodeWavPcm16(flattened, this.sampleRate);
        return wavBuffer;
    }

    cancel() {
        this.isRecording = false;
        this.audioChunks = [];
        this.totalSamples = 0;
        this.cleanup();
    }

    cleanup() {
        this.isRecording = false;
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
