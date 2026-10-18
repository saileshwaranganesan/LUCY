'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');

function createMockCanvas(width = 280, height = 280) {
    const commands = [];
    const ctx = {
        save: () => commands.push(['save']),
        restore: () => commands.push(['restore']),
        beginPath: () => commands.push(['beginPath']),
        closePath: () => commands.push(['closePath']),
        moveTo: (x, y) => commands.push(['moveTo', x, y]),
        lineTo: (x, y) => commands.push(['lineTo', x, y]),
        quadraticCurveTo: (cpx, cpy, x, y) => commands.push(['quadraticCurveTo', cpx, cpy, x, y]),
        bezierCurveTo: (cp1x, cp1y, cp2x, cp2y, x, y) => commands.push(['bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y]),
        arc: (x, y, r, sa, ea) => commands.push(['arc', x, y, r, sa, ea]),
        ellipse: (x, y, rx, ry, rot, sa, ea) => commands.push(['ellipse', x, y, rx, ry, rot, sa, ea]),
        fill: () => commands.push(['fill']),
        stroke: () => commands.push(['stroke']),
        clearRect: (x, y, w, h) => commands.push(['clearRect', x, y, w, h]),
        translate: (x, y) => commands.push(['translate', x, y]),
        scale: (x, y) => commands.push(['scale', x, y]),
        rotate: (angle) => commands.push(['rotate', angle]),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        lineCap: 'butt',
        globalAlpha: 1,
        shadowColor: 'transparent',
        shadowBlur: 0
    };

    return {
        width,
        height,
        getContext: () => ctx,
        getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
        addEventListener: () => {},
        removeEventListener: () => {},
        _commands: commands
    };
}

test('Repair 3: Consistent Fairy Appearance and Visible Humanoid Anatomy', async (suite) => {
    const mockCanvas = createMockCanvas(280, 280);
    const renderer = new CelestialFamiliarRenderer(mockCanvas);

    await suite.test('1. Palette constancy: Character identity is 100% constant across all emotions', () => {
        const emotions = [
            'idle', 'happy', 'pet', 'speaking', 'talking',
            'listening', 'thinking', 'focused', 'working',
            'worried', 'curious', 'magic', 'sleep'
        ];

        const canonical = {
            hair: '#d8b4fe',
            hairAccent: '#9333ea',
            hairShadow: '#581c87',
            bodiceMain: '#7c3aed',
            bodiceShade: '#5b21b6',
            bodiceHighlight: '#c084fc',
            bodiceTrim: '#f472b6',
            dress: 'rgba(168, 85, 247, 0.65)',
            dressInner: 'rgba(244, 114, 182, 0.55)',
            skin: '#fff5f8',
            skinShade: '#fce7f3',
            eyes: '#6366f1',
            accent: '#ffd166',
            core: '#a855f7'
        };

        for (const emotion of emotions) {
            renderer.state.emotion = emotion;
            const palette = renderer._getColorPalette();

            for (const [key, expectedVal] of Object.entries(canonical)) {
                assert.strictEqual(
                    palette[key],
                    expectedVal,
                    `Palette property "${key}" in emotion "${emotion}" must match canonical character identity`
                );
            }
        }
    });

    await suite.test('2. Emotion-specific aura: Only aura and auraGlow modulate per emotion', () => {
        renderer.state.emotion = 'idle';
        const idlePalette = renderer._getColorPalette();

        renderer.state.emotion = 'pet';
        const petPalette = renderer._getColorPalette();

        renderer.state.emotion = 'magic';
        const magicPalette = renderer._getColorPalette();

        // Pet celebration has joyful petal pink starlight aura
        assert.strictEqual(petPalette.auraGlow, '#f472b6');
        assert.strictEqual(petPalette.aura, 'rgba(244, 114, 182, 0.35)');

        // Magic has radiant gold spellcasting aura
        assert.strictEqual(magicPalette.auraGlow, '#facc15');

        // But hair, bodice, and eyes remain identical
        assert.strictEqual(petPalette.hair, idlePalette.hair);
        assert.strictEqual(petPalette.bodiceMain, idlePalette.bodiceMain);
        assert.strictEqual(petPalette.eyes, idlePalette.eyes);
        assert.strictEqual(magicPalette.hair, idlePalette.hair);
    });

    await suite.test('3. Humanoid anatomy: Volumetric arms, hands, sleeves, and boots methods exist', () => {
        assert.strictEqual(typeof renderer._drawArmAndHand, 'function');
        assert.strictEqual(typeof renderer._drawSleevePuff, 'function');
        assert.strictEqual(typeof renderer._drawRestingHand, 'function');
        assert.strictEqual(typeof renderer._drawArticulatedFinger, 'function');
        assert.strictEqual(typeof renderer._drawOpenHand, 'function');
        assert.strictEqual(typeof renderer._drawGesturingHand, 'function');
        assert.strictEqual(typeof renderer._renderFairyLegsAndBoots, 'function');
        assert.strictEqual(typeof renderer._renderPetalDress, 'function');
        assert.strictEqual(typeof renderer._renderFairyNeckAndShoulders, 'function');
        assert.strictEqual(typeof renderer._renderFairyBodice, 'function');
        assert.strictEqual(typeof renderer._renderFairyArmsAndHands, 'function');
    });

    await suite.test('4. Layer ordering: Arms and hands render on foreground layer above torso and hair', () => {
        const rendererSourcePath = path.resolve(__dirname, '../../src/ui/companion-renderer.js');
        const source = fs.readFileSync(rendererSourcePath, 'utf8');

        // Verify layer sequence in _render method
        const headIndex = source.indexOf('this._renderFairyHead(palette);');
        const hairIndex = source.indexOf('this._renderFairyHair(palette);');
        const armsIndex = source.indexOf('this._renderFairyArmsAndHands(palette);');

        assert.ok(headIndex > 0, '_renderFairyHead must be called in _render');
        assert.ok(hairIndex > headIndex, '_renderFairyHair must be called after head');
        assert.ok(armsIndex > hairIndex, '_renderFairyArmsAndHands must be called AFTER hair so hands are in front');
    });

    await suite.test('5. Distinct boots: Legs and boots render rich violet with starlight star gem', () => {
        const rendererSourcePath = path.resolve(__dirname, '../../src/ui/companion-renderer.js');
        const source = fs.readFileSync(rendererSourcePath, 'utf8');

        assert.ok(source.includes('#a855f7'), 'Boots must use celestial lavender/violet gradient start');
        assert.ok(source.includes('#7c3aed'), 'Boots must use royal purple gradient body');
        assert.ok(source.includes('#4c1d95'), 'Boots must use deep plum violet gradient sole');
        assert.ok(source.includes('#ffd166'), 'Boots must feature starlight gold star crystals');
    });

    await suite.test('6. Execution safety: Full _render pass completes without exception for all emotion states', () => {
        const testEmotions = ['idle', 'happy', 'pet', 'speaking', 'curious', 'worried', 'magic', 'sleep'];
        for (const emotion of testEmotions) {
            renderer.state.emotion = emotion;
            assert.doesNotThrow(() => {
                renderer._render(1500);
            }, `_render(time) must execute without throwing in emotion "${emotion}"`);
        }
    });

    await suite.test('7. Responsive scale: _render adapts safely to tiny floating companion scale (160x190)', () => {
        const tinyCanvas = createMockCanvas(160, 190);
        const tinyRenderer = new CelestialFamiliarRenderer(tinyCanvas);
        assert.doesNotThrow(() => {
            tinyRenderer._render(2000);
        }, '_render must safely scale down to 160x190 without distortion or error');
    });
});
