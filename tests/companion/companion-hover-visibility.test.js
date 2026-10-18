'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cssPath = path.resolve(__dirname, '../../src/companion/companion.css');
const appJsPath = path.resolve(__dirname, '../../src/companion/companion-app.js');
const htmlPath = path.resolve(__dirname, '../../src/companion/companion.html');

test('L.U.C.Y. Repair 6: Hover-Only Floating Controls and Status Indicators Suite', async (t) => {
    const cssCode = fs.readFileSync(cssPath, 'utf8');
    const appCode = fs.readFileSync(appJsPath, 'utf8');
    const htmlCode = fs.readFileSync(htmlPath, 'utf8');

    // 1. All auxiliary controls hidden by default
    await t.test('1. All auxiliary controls hidden by default in CSS', () => {
        // Control dock hidden by default
        assert.match(cssCode, /\.control-dock\s*\{[^}]*opacity:\s*0;/, '.control-dock must have opacity: 0 by default');
        assert.match(cssCode, /\.control-dock\s*\{[^}]*visibility:\s*hidden;/, '.control-dock must have visibility: hidden by default');
        assert.match(cssCode, /\.control-dock\s*\{[^}]*pointer-events:\s*none;/, '.control-dock must have pointer-events: none by default');

        // Top close button hidden by default
        assert.match(cssCode, /\.top-close-btn\s*\{[^}]*opacity:\s*0;/, '.top-close-btn must have opacity: 0 by default');
        assert.match(cssCode, /\.top-close-btn\s*\{[^}]*visibility:\s*hidden;/, '.top-close-btn must have visibility: hidden by default');
        assert.match(cssCode, /\.top-close-btn\s*\{[^}]*pointer-events:\s*none;/, '.top-close-btn must have pointer-events: none by default');

        // Corner resize grip hidden by default
        assert.match(cssCode, /\.resize-grip\s*\{[^}]*opacity:\s*0;/, '.resize-grip must have opacity: 0 by default');
        assert.match(cssCode, /\.resize-grip\s*\{[^}]*visibility:\s*hidden;/, '.resize-grip must have visibility: hidden by default');
        assert.match(cssCode, /\.resize-grip\s*\{[^}]*pointer-events:\s*none;/, '.resize-grip must have pointer-events: none by default');

        // Side panel collapsed by default in HTML
        assert.match(htmlCode, /class="side-panel\s+collapsed"/, 'Side panel must have class "collapsed" by default in HTML');
    });

    // 2. All status indicators hidden by default
    await t.test('2. All status indicators hidden by default in CSS', () => {
        // Status pill hidden by default
        assert.match(cssCode, /\.status-pill\s*\{[^}]*opacity:\s*0;/, '.status-pill must have opacity: 0 by default');
        assert.match(cssCode, /\.status-pill\s*\{[^}]*visibility:\s*hidden;/, '.status-pill must have visibility: hidden by default');
        assert.match(cssCode, /\.status-pill\s*\{[^}]*pointer-events:\s*none;/, '.status-pill must have pointer-events: none by default');

        // Top bar container pointer-events: none so clicks pass through empty spaces
        assert.match(cssCode, /\.top-bar\s*\{[^}]*pointer-events:\s*none;/, '.top-bar must have pointer-events: none');
    });

    // 3. Controls visible on hover
    await t.test('3. Controls visible on companion hover / focus / controls-visible', () => {
        assert.ok(cssCode.includes('#companionContainer:hover .control-dock'), 'CSS must reveal control-dock on #companionContainer:hover');
        assert.ok(cssCode.includes('#companionContainer:hover .top-close-btn'), 'CSS must reveal top-close-btn on #companionContainer:hover');
        assert.ok(cssCode.includes('#companionContainer:hover .resize-grip'), 'CSS must reveal resize-grip on #companionContainer:hover');
        assert.ok(cssCode.includes('#companionContainer.controls-visible .control-dock'), 'CSS must reveal control-dock on .controls-visible');
        assert.ok(cssCode.includes('#companionContainer.controls-visible .top-close-btn'), 'CSS must reveal top-close-btn on .controls-visible');
    });

    // 4. Status indicators visible on hover according to intended design
    await t.test('4. Status indicators visible on companion hover / focus / controls-visible', () => {
        assert.ok(cssCode.includes('#companionContainer:hover .status-pill'), 'CSS must reveal status-pill on #companionContainer:hover');
        assert.ok(cssCode.includes('#companionContainer:focus-within .status-pill'), 'CSS must reveal status-pill on focus-within');
        assert.ok(cssCode.includes('#companionContainer.controls-visible .status-pill'), 'CSS must reveal status-pill on .controls-visible');
    });

    // 5. Controls hidden again after pointer exit
    await t.test('5. Controls hidden again after pointer exit with debounced scheduleHideControls', () => {
        assert.ok(appCode.includes('function scheduleHideControls('), 'companion-app.js must define scheduleHideControls()');
        assert.ok(appCode.includes("companionContainer.addEventListener('pointerleave'"), 'pointerleave must trigger scheduleHideControls');
        assert.ok(appCode.includes("companionContainer.addEventListener('mouseleave'"), 'mouseleave must trigger scheduleHideControls');
        assert.ok(appCode.includes("companionContainer.classList.remove('controls-visible')"), 'scheduleHideControls must remove controls-visible');
        assert.ok(appCode.includes('collapseSidePanel()'), 'scheduleHideControls must collapse side panel on pointer exit');
    });

    // 6. Pointer movement from the fairy to a control does not flicker
    await t.test('6. Pointer movement from the fairy to a control does not flicker', () => {
        // Single unified parent container with pointer-events: auto ensures hover is not lost across child boundaries
        assert.match(cssCode, /#companionContainer\s*\{[^}]*pointer-events:\s*auto;/, '#companionContainer must maintain pointer-events: auto');
        // scheduleHideControls debounces with a safe delay (e.g. 220ms) to bridge micro-boundaries
        assert.ok(appCode.includes('delayMs = 220'), 'scheduleHideControls must use debounced delay to prevent flicker');
        // Container checks :hover before hiding controls
        assert.ok(appCode.includes("companionContainer.matches(':hover')"), 'Must check matches(:hover) before clearing controls');
    });

    // 7. Idle and landing states do not force visibility
    await t.test('7. Idle and landing states do not force visibility', () => {
        // Initial visual state Happy/Idle does not call displayMessage without hover
        assert.ok(!appCode.includes("renderer.setVisualState({ emotion: 'happy' });\n    displayMessage("), 'Initial state must not force displayMessage');
        // Visual state updates only update renderer and statusText, but do not set controls-visible
        const onVisualUpdateIdx = appCode.indexOf('window.companionIpc.onVisualUpdate');
        assert.ok(onVisualUpdateIdx !== -1, 'onVisualUpdate must exist');
        const visualUpdateSlice = appCode.slice(onVisualUpdateIdx, onVisualUpdateIdx + 700);
        assert.ok(!visualUpdateSlice.includes("classList.add('controls-visible')"), 'onVisualUpdate must not force controls-visible');
    });

    // 8. Speaking and listening states do not force visibility
    await t.test('8. Speaking and listening states do not force visibility when pointer is away', () => {
        // displayMessage checks isUserHovering and focus-within before expanding or uncollapsing
        assert.ok(appCode.includes('if (!isUserHovering && (!companionContainer || !companionContainer.matches(\':focus-within\')))'),
            'displayMessage must check !isUserHovering before opening side panel');
        // onVoiceUpdate idle handler collapses sidePanel and schedules hide controls when pointer is away
        const onVoiceUpdateIdx = appCode.indexOf('window.companionIpc.onVoiceUpdate');
        assert.ok(onVoiceUpdateIdx !== -1, 'onVoiceUpdate must exist');
        const voiceUpdateSlice = appCode.slice(onVoiceUpdateIdx, onVoiceUpdateIdx + 2000);
        assert.ok(voiceUpdateSlice.includes('collapseSidePanel()'), 'onVoiceUpdate idle handler must collapse side panel');
        assert.ok(voiceUpdateSlice.includes('scheduleHideControls'), 'onVoiceUpdate idle handler must schedule hide controls');
    });

    // 9. Petting and stunt animations preserve hover-only behavior
    await t.test('9. Petting and stunt animations preserve hover-only behavior', () => {
        // Trick dropdown closes when pointer leaves
        assert.ok(appCode.includes("trickDropdown.classList.remove('open')"), 'Must close trick dropdown on pointer exit');
        // Petting listener sets isUserHovering so immediate feedback shows while pointer is on fairy
        assert.ok(appCode.includes("fairyStage.addEventListener('click'"), 'fairyStage click listener must be registered');
        // Stunt options trigger renderer.playTrick and clean return
        assert.ok(appCode.includes("renderer.playTrick(trick)"), 'renderer.playTrick must be called for stunts');
    });

    // 10. Hidden controls do not intercept pointer events
    await t.test('10. Hidden controls do not intercept pointer events', () => {
        // All hidden controls have pointer-events: none in CSS
        assert.match(cssCode, /\.control-dock\s*\{[^}]*pointer-events:\s*none;/, 'control-dock has pointer-events: none');
        assert.match(cssCode, /\.top-close-btn\s*\{[^}]*pointer-events:\s*none;/, 'top-close-btn has pointer-events: none');
        assert.match(cssCode, /\.status-pill\s*\{[^}]*pointer-events:\s*none;/, 'status-pill has pointer-events: none');
        assert.match(cssCode, /\.resize-grip\s*\{[^}]*pointer-events:\s*none;/, 'resize-grip has pointer-events: none');
    });

    // 11. Visible controls retain their expected click actions
    await t.test('11. Visible controls retain their expected click actions', () => {
        assert.ok(appCode.includes("talkBtn.addEventListener('click'"), 'talkBtn click listener must be registered');
        assert.ok(appCode.includes("pinBtn.addEventListener('click'"), 'pinBtn click listener must be registered');
        assert.ok(appCode.includes("returnBtn.addEventListener('click'"), 'returnBtn click listener must be registered');
        assert.ok(appCode.includes("closeBtn.addEventListener('click'"), 'closeBtn click listener must be registered');
        assert.ok(appCode.includes("resizeGrip.addEventListener('mousedown'"), 'resizeGrip mousedown listener must be registered');
    });

    // 12. Docking and pinning continue to work
    await t.test('12. Docking and pinning continue to work cleanly', () => {
        assert.ok(appCode.includes('window.companionIpc.togglePin'), 'Pin toggle IPC must be invoked on pin button click');
        assert.ok(appCode.includes('window.companionIpc.returnToApp'), 'Return to app IPC must be invoked on return and close button click');
        assert.ok(appCode.includes('resetCompanionState()'), 'Must reset companion state upon docking');
    });

    // 13. Repeated hover transitions do not create duplicate listeners
    await t.test('13. Repeated hover transitions do not create duplicate listeners', () => {
        // showControls and scheduleHideControls only manipulate classList and timers, without adding DOM listeners inside
        const showControlsIdx = appCode.indexOf('function showControls()');
        const showControlsSlice = appCode.slice(showControlsIdx, showControlsIdx + 300);
        assert.ok(!showControlsSlice.includes('addEventListener'), 'showControls must not register new event listeners');

        const scheduleHideIdx = appCode.indexOf('function scheduleHideControls(');
        const scheduleHideSlice = appCode.slice(scheduleHideIdx, scheduleHideIdx + 800);
        assert.ok(!scheduleHideSlice.includes('addEventListener'), 'scheduleHideControls must not register new event listeners');
    });

    // 14. Accessibility and focus behavior remain correct where supported
    await t.test('14. Accessibility and focus behavior remain correct where supported', () => {
        // Keyboard focus reveals controls
        assert.ok(cssCode.includes('#companionContainer:focus-within .control-dock'), 'CSS reveals control-dock on :focus-within');
        assert.ok(cssCode.includes('#companionContainer:focus-within .status-pill'), 'CSS reveals status-pill on :focus-within');
        assert.ok(cssCode.includes('#companionContainer:focus-within .top-close-btn'), 'CSS reveals top-close-btn on :focus-within');

        // Focus event listeners on container
        assert.ok(appCode.includes("companionContainer.addEventListener('focusin'"), 'companionContainer must handle focusin');
        assert.ok(appCode.includes("companionContainer.addEventListener('focusout'"), 'companionContainer must handle focusout');

        // ARIA attributes on toolbar and regions
        assert.match(htmlCode, /role="toolbar"/, 'Controls dock must have role="toolbar"');
        assert.match(htmlCode, /role="region"/, 'Side panel must have role="region"');
        assert.match(htmlCode, /aria-label="Close Companion"/, 'Close button must have descriptive aria-label');
    });
});
