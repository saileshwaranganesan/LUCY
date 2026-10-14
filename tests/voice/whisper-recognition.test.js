'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { WhisperOfflineRecognitionEngine, WHISPER_LICENCE } = require('../../src/voice/whisper-recognition');

function createTempDir() {
    const tmp = path.join(os.tmpdir(), `lucy_whisper_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
}

test('REQ-027: Offline Speech Recognition via whisper.cpp', async (t) => {
    let tempDir = null;

    t.beforeEach(() => {
        tempDir = createTempDir();
    });

    t.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (_) {}
        }
    });

    await t.test('verifies engine metadata and permissive MIT license', () => {
        const engine = new WhisperOfflineRecognitionEngine();
        const status = engine.getStatus();

        assert.equal(status.engine, 'whisper.cpp');
        assert.equal(status.license, 'MIT');
        assert.equal(WHISPER_LICENCE, 'MIT');
        assert.equal(typeof status.isAvailable, 'boolean');
        assert.ok(status.message.length > 0);
    });

    await t.test('gracefully signals fallbackRequired when whisper binary is not present', async () => {
        const engine = new WhisperOfflineRecognitionEngine({
            binaryPath: path.join(tempDir, 'non_existent_whisper.exe'),
            modelPath: path.join(tempDir, 'non_existent_model.bin')
        });

        assert.equal(engine.isAvailable(), false);

        const result = await engine.transcribeAudio(Buffer.from('fake wav content'));
        assert.equal(result.ok, false);
        assert.equal(result.fallbackRequired, true);
        assert.ok(result.error.includes('not detected'));
    });

    await t.test('executes mock whisper binary and captures transcript output', async () => {
        // Create a mock executable script on Windows/Node
        const mockBinaryPath = path.join(tempDir, 'mock_whisper.cmd');
        fs.writeFileSync(mockBinaryPath, '@echo off\r\necho Hello Lucy this is an offline test transcript\r\n', 'utf8');

        const mockModelPath = path.join(tempDir, 'ggml-tiny.bin');
        fs.writeFileSync(mockModelPath, 'mock model weights binary', 'utf8');

        const mockWavPath = path.join(tempDir, 'test.wav');
        fs.writeFileSync(mockWavPath, 'RIFF mock wav data', 'utf8');

        const engine = new WhisperOfflineRecognitionEngine({
            binaryPath: mockBinaryPath,
            modelPath: mockModelPath,
            language: 'en'
        });

        assert.equal(engine.isAvailable(), true);

        const res = await engine.transcribeAudio(mockWavPath);
        assert.equal(res.ok, true);
        assert.equal(res.transcript, 'Hello Lucy this is an offline test transcript');
        assert.equal(res.engine, 'whisper.cpp');
        assert.equal(res.license, 'MIT');
    });

    await t.test('cleans up temporary audio buffer files after transcription', async () => {
        const mockBinaryPath = path.join(tempDir, 'mock_whisper.cmd');
        fs.writeFileSync(mockBinaryPath, '@echo off\r\necho Buffer transcription success\r\n', 'utf8');

        const mockModelPath = path.join(tempDir, 'ggml-tiny.bin');
        fs.writeFileSync(mockModelPath, 'mock model weights', 'utf8');

        const engine = new WhisperOfflineRecognitionEngine({
            binaryPath: mockBinaryPath,
            modelPath: mockModelPath
        });

        const initialTmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('lucy_whisper_'));

        const buffer = Buffer.from('RIFF mock wav binary audio');
        const res = await engine.transcribeAudio(buffer);

        assert.equal(res.ok, true);
        assert.equal(res.transcript, 'Buffer transcription success');

        // Verify temporary buffer file was unlinked
        const finalTmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('lucy_whisper_'));
        assert.equal(finalTmpFiles.length, initialTmpFiles.length);
    });
});
