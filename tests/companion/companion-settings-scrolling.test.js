'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Repair 2: Companion Settings Scrolling & Layout Architecture', async (suite) => {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const cssPath = path.join(projectRoot, 'src', 'ui', 'style.css');
    const htmlPath = path.join(projectRoot, 'src', 'ui', 'index.html');
    const appJsPath = path.join(projectRoot, 'src', 'ui', 'app.js');

    const cssContent = fs.readFileSync(cssPath, 'utf8');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const appJsContent = fs.readFileSync(appJsPath, 'utf8');

    await suite.test('1. Viewport has min-height: 0 and vertical auto scrolling', () => {
        // Find .jarvis-views-viewport rule
        const viewportMatch = cssContent.match(/\.jarvis-views-viewport\s*\{([^}]+)\}/);
        assert.ok(viewportMatch, '.jarvis-views-viewport rule must exist in style.css');
        const viewportCss = viewportMatch[1];

        assert.ok(viewportCss.includes('min-height: 0'), 'Viewport must define min-height: 0 to prevent nested flex overflow');
        assert.ok(viewportCss.includes('overflow-y: auto'), 'Viewport must enable overflow-y: auto for vertical scrolling');
        assert.ok(viewportCss.includes('overflow-x: hidden'), 'Viewport must clip horizontal overflow');
    });

    await suite.test('2. jarvis-view uses min-height: 100% and does not clamp with height: 100%', () => {
        const viewMatch = cssContent.match(/\.jarvis-view\s*\{([^}]+)\}/);
        assert.ok(viewMatch, '.jarvis-view rule must exist in style.css');
        const viewCss = viewMatch[1];

        assert.ok(viewCss.includes('min-height: 100%'), '.jarvis-view must have min-height: 100%');
        const hasStandaloneHeight = /(?<!min-|max-)height:\s*100%/.test(viewCss);
        assert.equal(hasStandaloneHeight, false, '.jarvis-view must NOT have standalone height: 100% so scrollable content can expand');
        assert.ok(viewCss.includes('padding-bottom:'), '.jarvis-view must have bottom padding to prevent bottom controls clipping');
    });

    await suite.test('3. jarvis-box has flex-shrink: 0 to prevent crushing cards', () => {
        const boxMatch = cssContent.match(/\.jarvis-box\s*\{([^}]+)\}/);
        assert.ok(boxMatch, '.jarvis-box rule must exist in style.css');
        const boxCss = boxMatch[1];

        assert.ok(boxCss.includes('flex-shrink: 0'), '.jarvis-box must have flex-shrink: 0 to prevent cards from collapsing');
    });

    await suite.test('4. Dedicated scrollbar styling exists for jarvis-views-viewport', () => {
        assert.ok(cssContent.includes('.jarvis-views-viewport::-webkit-scrollbar'), 'Must provide webkit-scrollbar styling');
        assert.ok(cssContent.includes('.jarvis-views-viewport::-webkit-scrollbar-thumb'), 'Must provide scrollbar thumb styling');
        assert.ok(cssContent.includes('scrollbar-color:'), 'Must provide standard CSS scrollbar-color property');
    });

    await suite.test('5. View conversation preserves internal height: 100%', () => {
        const convMatch = cssContent.match(/#viewConversation\s*\{([^}]+)\}/);
        assert.ok(convMatch, '#viewConversation rule must exist in style.css');
        assert.ok(convMatch[1].includes('height: 100%'), '#viewConversation must stay clamped to 100% for chat stream');
    });

    await suite.test('6. View switching resets viewport scrollTop to 0', () => {
        assert.ok(appJsContent.includes('const viewport = document.getElementById(\'jarvisViewsViewport\')'), 'switchView must lookup viewport');
        assert.ok(appJsContent.includes('viewport.scrollTop = 0'), 'switchView must reset scrollTop to 0 upon switching tabs');
    });

    await suite.test('7. All required Floating Pet Dimensions & Sizing controls exist', () => {
        assert.ok(htmlContent.includes('id="btnResetTinyPet"'), 'Tiny Default Preset button must exist');
        assert.ok(htmlContent.includes('id="btnMediumPet"'), 'Comfortable Preset button must exist');
        assert.ok(htmlContent.includes('id="settingsToggleFloatBtn"'), 'Float Pet to Desktop button must exist');
        assert.ok(htmlContent.includes('id="sliderCompanionWidth"'), 'Width slider must exist');
        assert.ok(htmlContent.includes('id="sliderCompanionHeight"'), 'Height slider must exist');
        assert.ok(htmlContent.includes('id="companionDimensionsLabel"'), 'Dimensions readout label must exist');
        assert.ok(htmlContent.includes('id="sliderWidthVal"'), 'Width value readout must exist');
        assert.ok(htmlContent.includes('id="sliderHeightVal"'), 'Height value readout must exist');
    });

    await suite.test('8. All required Free Local Fairy Voice (Kokoro-82M) controls exist', () => {
        assert.ok(htmlContent.includes('id="btnTestFairyVoice"'), 'Test Fairy Voice button must exist');
        assert.ok(htmlContent.includes('id="settingsTtsEngineSelect"'), 'TTS Engine select must exist');
        assert.ok(htmlContent.includes('id="settingsKokoroVoiceSelect"'), 'Voice persona select must exist');
        assert.ok(htmlContent.includes('id="sliderVoiceRate"'), 'Speech rate slider must exist');
        assert.ok(htmlContent.includes('id="sliderVoicePitch"'), 'Speech pitch slider must exist');
        assert.ok(htmlContent.includes('id="sliderVoiceVolume"'), 'Speech volume slider must exist');
        assert.ok(htmlContent.includes('id="rateLabelVal"'), 'Rate label readout must exist');
        assert.ok(htmlContent.includes('id="pitchLabelVal"'), 'Pitch label readout must exist');
        assert.ok(htmlContent.includes('id="volumeLabelVal"'), 'Volume label readout must exist');
    });

    await suite.test('9. All required Hands-Free & Background Operations controls exist', () => {
        assert.ok(htmlContent.includes('id="checkWakeWordActive"'), 'Wake-Word checkbox must exist');
        assert.ok(htmlContent.includes('id="settingCloseAction"'), 'Main-Window Close Behaviour select must exist');
        assert.ok(htmlContent.includes('id="closeActionTag"'), 'Close action tag indicator must exist');
        assert.ok(htmlContent.includes('id="checkBackgroundListening"'), 'Background Voice & Listening checkbox must exist');
        assert.ok(htmlContent.includes('id="checkCompanionPinned"'), 'Pin Fairy Companion to Top checkbox must exist');
        assert.ok(htmlContent.includes('id="btnExplicitExitCompanion"'), 'Explicit Application Exit button must exist');
    });
});
