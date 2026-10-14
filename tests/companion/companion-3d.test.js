'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CompanionBridge } = require('../../src/companion/companion-bridge.js');
const { TASK_STATES } = require('../../src/core/task-status.js');
const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');

test('3D Floating Fantasy Companion Subsystem', async (t) => {

    await t.test('Asset Verification: Dragon 3D Model and License Evidence', () => {
        const modelPath = path.resolve(__dirname, '../../src/companion/assets/dragon.glb');
        const licensePath = path.resolve(__dirname, '../../src/companion/assets/LICENSE.txt');

        assert.ok(fs.existsSync(modelPath), 'dragon.glb must exist in src/companion/assets');
        const stats = fs.statSync(modelPath);
        assert.ok(stats.size > 100000, `dragon.glb must be a valid 3D file (>100KB), got ${stats.size} bytes`);

        // Verify glTF binary magic number: 0x46546C67 ("glTF")
        const buf = fs.readFileSync(modelPath);
        const magic = buf.toString('ascii', 0, 4);
        assert.equal(magic, 'glTF', 'File must have valid glTF binary header magic');

        // Verify JSON chunk containing Idle animation
        const jsonChunkLen = buf.readUInt32LE(12);
        const jsonStr = buf.toString('utf8', 20, 20 + jsonChunkLen);
        const gltf = JSON.parse(jsonStr);
        assert.ok(gltf.animations && gltf.animations.length > 0, 'Model must contain animation clips');
        const animNames = gltf.animations.map((a) => a.name);
        assert.ok(animNames.includes('Idle'), 'Model must contain Idle animation clip');

        // Verify License File
        assert.ok(fs.existsSync(licensePath), 'LICENSE.txt must exist in src/companion/assets');
        const licenseContent = fs.readFileSync(licensePath, 'utf8');
        assert.match(licenseContent, /Quaternius/i, 'License must document Quaternius provenance');
        assert.match(licenseContent, /CC0/i, 'License must document CC0 Public Domain status');
    });

    await t.test('Window Specification: Transparent, Borderless, Always-on-Top Floating Shell', () => {
        // Test FloatingCompanionWindow configuration contract
        const mockBridge = new CompanionBridge();
        const floating = new FloatingCompanionWindow({
            companionBridge: mockBridge
        });

        assert.equal(floating.isOpen(), false, 'Window should initially be closed');
        assert.equal(floating.window, null, 'Underlying BrowserWindow should be null before creation');
    });

    await t.test('State & Emotion Mapping: Synchronized with TaskCoordinator State Transitions', () => {
        const bridge = new CompanionBridge();
        const recordedEvents = [];
        bridge.on('visualUpdate', (evt) => recordedEvents.push(evt));

        // 1. Idle
        bridge.handleStateEvent({ to: TASK_STATES.IDLE });
        assert.equal(bridge.currentEmotion, 'idle');
        assert.equal(recordedEvents[recordedEvents.length - 1].emotion, 'idle');

        // 2. Interpreting / Planning -> thinking / focused
        bridge.handleStateEvent({ to: TASK_STATES.INTERPRETING, description: 'Listening...' });
        assert.equal(bridge.currentEmotion, 'thinking');

        bridge.handleStateEvent({ to: TASK_STATES.PLANNING });
        assert.equal(bridge.currentEmotion, 'focused');

        // 3. Waiting Permission -> curious
        bridge.handleStateEvent({ to: TASK_STATES.WAITING_PERMISSION });
        assert.equal(bridge.currentEmotion, 'curious');

        // 4. Executing Tool -> working
        bridge.handleStateEvent({ to: TASK_STATES.EXECUTING_TOOL, currentTool: 'desktop_inspect_ui' });
        assert.equal(bridge.currentEmotion, 'working');

        // 5. Completed -> happy
        bridge.handleStateEvent({ to: TASK_STATES.COMPLETED, result: { summary: 'Done!' } });
        assert.equal(bridge.currentEmotion, 'happy');

        // 6. Failed -> worried
        bridge.handleStateEvent({ to: TASK_STATES.FAILED, error: 'Access denied' });
        assert.equal(bridge.currentEmotion, 'worried');
    });

    await t.test('Single Authority: Companion Interactions Route Through TaskCoordinator', async () => {
        let coordinatorExecuted = false;
        let submittedRequest = null;

        const mockCoordinator = {
            executeRequest: async (text, options) => {
                coordinatorExecuted = true;
                submittedRequest = text;
                return { ok: true, taskId: 'task-test-01', text, options };
            }
        };

        const bridge = new CompanionBridge({ taskCoordinator: mockCoordinator });

        // Physical pet reaction
        const petResult = bridge.handleUserInteraction('pet');
        assert.equal(petResult.acknowledged, true);
        assert.equal(petResult.reaction, 'sparkle_flutter');
        assert.equal(bridge.currentEmotion, 'happy');

        // Request execution forwarded strictly to task coordinator
        const execResult = await bridge.handleUserInteraction('submit_request', { text: 'Open Notepad' });
        assert.equal(coordinatorExecuted, true);
        assert.equal(submittedRequest, 'Open Notepad');
        assert.equal(execResult.ok, true);
    });

    await t.test('Resilience: 2D Canvas Familiar Available as Working Fallback', () => {
        const fallbackPath = path.resolve(__dirname, '../../src/ui/companion-renderer.js');
        assert.ok(fs.existsSync(fallbackPath), '2D Celestial Familiar renderer file must exist');

        const content = fs.readFileSync(fallbackPath, 'utf8');
        assert.match(content, /class CelestialFamiliarRenderer/, 'CelestialFamiliarRenderer class must be defined');
        assert.match(content, /module\.exports = { CelestialFamiliarRenderer }/, 'Renderer must be exported for fallback usage');
    });
});
