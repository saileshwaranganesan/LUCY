'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WakeWordEngine, PRIVACY_STATES, WAKE_WORD_LICENCE } = require('../../src/voice/wake-word-engine');

test('REQ-028: Wake-Word Detection with Explicit Privacy Controls & Verified Licences', async (t) => {
    await t.test('verifies permissive open-source licence and non-commercial disclaimer', () => {
        const engine = new WakeWordEngine();
        const info = engine.getLicenceInfo();

        assert.equal(info.licence, 'Apache-2.0');
        assert.equal(WAKE_WORD_LICENCE, 'Apache-2.0');
        assert.ok(info.licenceType.includes('Permissive'));
        assert.ok(info.thirdPartyRestrictions.includes('Rejects CC-BY-NC'));
    });

    await t.test('enforces opt-in privacy default (disabled on creation)', () => {
        const engine = new WakeWordEngine();
        const state = engine.getPrivacyState();

        assert.equal(state.enabled, false);
        assert.equal(state.isMicActive, false);
        assert.equal(state.state, PRIVACY_STATES.DISABLED);
    });

    await t.test('provides explicit hardware mute and pause kill-switches', () => {
        const engine = new WakeWordEngine({ enabled: true });
        assert.equal(engine.getPrivacyState().isMicActive, true);

        // Test Mute
        engine.mute();
        let state = engine.getPrivacyState();
        assert.equal(state.isMuted, true);
        assert.equal(state.isMicActive, false);
        assert.equal(state.state, PRIVACY_STATES.MUTED);

        // Muted engine must reject inputs
        const resWhileMuted = engine.processInput({ transcriptCandidate: 'Hey Lucy wake up' });
        assert.equal(resWhileMuted, null);

        // Test Unmute
        engine.unmute();
        state = engine.getPrivacyState();
        assert.equal(state.isMuted, false);
        assert.equal(state.isMicActive, true);

        // Test Pause
        engine.pause();
        state = engine.getPrivacyState();
        assert.equal(state.isPaused, true);
        assert.equal(state.isMicActive, false);

        engine.resume();
        assert.equal(engine.getPrivacyState().isMicActive, true);

        engine.dispose();
    });

    await t.test('detects wake-word keyword and emits wakeWordDetected event', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            keywords: ['hey lucy', 'sparkle'],
            confidenceThreshold: 0.7
        });

        let detected = null;
        engine.on('wakeWordDetected', (result) => {
            detected = result;
        });

        const res = engine.processInput({
            transcriptCandidate: 'Can you hear me Hey Lucy please help',
            confidence: 0.95
        });

        assert.ok(res !== null);
        assert.equal(res.keyword, 'hey lucy');
        assert.equal(res.confidence, 0.95);
        assert.equal(res.licence, 'Apache-2.0');
        assert.equal(detected.keyword, 'hey lucy');

        // Test Cooldown: immediately subsequent input should be suppressed
        const rapidSecondInput = engine.processInput({
            transcriptCandidate: 'Hey Lucy again',
            confidence: 0.95
        });
        assert.equal(rapidSecondInput, null);

        engine.dispose();
    });

    await t.test('processes local PCM audio frame in-memory without network', () => {
        const engine = new WakeWordEngine({
            enabled: true,
            confidenceThreshold: 0.5,
            cooldownMs: 0
        });

        // Simulate a PCM buffer with sinusoidal acoustic energy
        const pcmFrame = new Float32Array(512);
        for (let i = 0; i < pcmFrame.length; i++) {
            pcmFrame[i] = Math.sin(i / 10) * 0.8;
        }

        const res = engine.processInput({ audioFrame: pcmFrame });
        assert.ok(res !== null);
        assert.equal(res.keyword, 'hey lucy');
        assert.ok(res.confidence >= 0.5);

        engine.dispose();
    });
});
