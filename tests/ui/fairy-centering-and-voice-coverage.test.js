'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');
const { cleanTextForSpeech } = require('../../src/voice/speech-text-cleaner.js');

test('L.U.C.Y. Repair 11: Fairy Stage Centering, Universal Voice Coverage & Action Word Sanitization', async (t) => {
    const htmlPath = path.join(__dirname, '../../src/ui/index.html');
    const cssPath = path.join(__dirname, '../../src/ui/style.css');
    const appJsPath = path.join(__dirname, '../../src/ui/app.js');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const appJs = fs.readFileSync(appJsPath, 'utf8');

    await t.test('1. Stage Centering: CelestialFamiliarRenderer adapts to container canvas dimensions', () => {
        // Mock 280x270 stage canvas (as in main window sidebar)
        const mockContext = {
            setTransform: () => {},
            resetTransform: () => {},
            clearRect: () => {},
            save: () => {},
            restore: () => {},
            translate: () => {},
            scale: () => {},
            rotate: () => {},
            beginPath: () => {},
            arc: () => {},
            fill: () => {},
            stroke: () => {}
        };

        const mockCanvas280 = {
            width: 280,
            height: 270,
            clientWidth: 280,
            clientHeight: 270,
            getBoundingClientRect: () => ({ width: 280, height: 270 }),
            getContext: () => mockContext,
            addEventListener: () => {},
            removeEventListener: () => {}
        };

        const renderer = new CelestialFamiliarRenderer(mockCanvas280);
        assert.equal(renderer.logicalWidth, 280, 'Renderer must adopt canvas width of 280 rather than hardcoded 160');
        assert.equal(renderer.logicalHeight, 270, 'Renderer must adopt canvas height of 270 rather than hardcoded 190');

        // Verify resize updates logical bounds
        renderer.onResize(320, 300, 1.0);
        assert.equal(renderer.logicalWidth, 320);
        assert.equal(renderer.logicalHeight, 300);
        assert.equal(mockCanvas280.width, 320);
        assert.equal(mockCanvas280.height, 300);
    });

    await t.test('2. Stage Centering: CSS rules guarantee block centering without offset', () => {
        assert.match(css, /\.creature-stage\s*\{[^}]*display:\s*flex;/i);
        assert.match(css, /\.creature-stage\s*\{[^}]*align-items:\s*center;/i);
        assert.match(css, /\.creature-stage\s*\{[^}]*justify-content:\s*center;/i);
        assert.match(css, /#creatureCanvas\s*\{[^}]*display:\s*block;/i);
        assert.match(css, /#creatureCanvas\s*\{[^}]*margin:\s*0\s+auto;/i);
    });

    await t.test('3. Stage Centering: app.js binds ResizeObserver and responsive measurement for main canvas', () => {
        assert.match(appJs, /function resizeMainCompanionCanvas\(\)/);
        assert.match(appJs, /new CelestialFamiliarRenderer\(canvas,\s*\{\s*width:\s*initialStageW,\s*height:\s*initialStageH\s*\}\)/);
        assert.match(appJs, /window\.addEventListener\('resize',\s*resizeMainCompanionCanvas\)/);
        assert.match(appJs, /ResizeObserver/);
    });

    await t.test('4. Action Word Sanitization: Strips leading onomatopoeia exclamations', () => {
        assert.equal(cleanTextForSpeech('Boing! 🦘 High fairy leap into the air!'), 'High fairy leap into the air!');
        assert.equal(cleanTextForSpeech('Boing! High fairy leap!'), 'High fairy leap!');
        assert.equal(cleanTextForSpeech('Sparkle! ✨ Bouncing with celestial happiness!'), 'Bouncing with celestial happiness!');
        assert.equal(cleanTextForSpeech('Sparkle! Happy flutter bounce!'), 'Happy flutter bounce!');
        assert.equal(cleanTextForSpeech('Sparkle sparkle! You always brighten my day! 💫'), 'You always brighten my day!');
        assert.equal(cleanTextForSpeech('Twirl! 💫 Watch me spin through the stardust!'), 'Watch me spin through the stardust!');
        assert.equal(cleanTextForSpeech('Twirl! Spinning through the stars!'), 'Spinning through the stars!');
        assert.equal(cleanTextForSpeech('Swoosh! 🦋 Gliding on celestial wings!'), 'Gliding on celestial wings!');
        assert.equal(cleanTextForSpeech('Wheee! 🤸 Full aerial loop-de-loop!'), 'Full aerial loop-de-loop!');
        assert.equal(cleanTextForSpeech('La la la! 💃 Dancing to the starlight melody!'), 'Dancing to the starlight melody!');
        assert.equal(cleanTextForSpeech('Giggle! My wings are fluttering with joy! 🦋'), 'My wings are fluttering with joy!');
    });

    await t.test('5. Action Word Sanitization: Strips roleplay asterisks, brackets, and parentheticals', () => {
        assert.equal(cleanTextForSpeech('*boing* *sparkle* Ready to assist!'), 'Ready to assist!');
        assert.equal(cleanTextForSpeech('I have finished your request. (sparkle) Have a nice day!'), 'I have finished your request. Have a nice day!');
        assert.equal(cleanTextForSpeech('[sparkle] [action: flutter] All tasks completed!'), 'All tasks completed!');
        assert.equal(cleanTextForSpeech('Sparkle! ✨'), 'Ready!');
        assert.equal(cleanTextForSpeech('Boing!'), 'Ready!');
    });

    await t.test('6. Universal Voice Coverage: Task failures, errors, and cancellation trigger spoken audio', () => {
        // Verify failure handler speaks response
        assert.match(appJs, /const failSpeech = response\.replyText/);
        assert.match(appJs, /voiceController\.speakResponse\(failSpeech\)/);

        // Verify catch block speaks error
        assert.match(appJs, /const errMsg = `I encountered an issue executing that command:/);
        assert.match(appJs, /voiceController\.speakResponse\(errMsg\)/);

        // Verify cancellation speaks cancel message
        assert.match(appJs, /const cancelMsg = 'Response was cancelled\.'/);
        assert.match(appJs, /voiceController\.speak\(cancelMsg\)/);
    });

    await t.test('7. Universal Voice Coverage: Completed responses speak with fallback for streaming buffer', () => {
        assert.match(appJs, /const completedReply = response\.replyText \|\| streamingBuffer/);
        assert.match(appJs, /voiceController\.speakResponse\(completedReply\)/);
    });

    await t.test('8. Universal Voice Coverage: Stunts & tricks in dropdown and settings pane speak', () => {
        // Dropdown stunts
        assert.match(appJs, /trickButtons\.forEach[\s\S]*?voiceController\.speak\(msg\)/);
        // Settings pane stunts
        assert.match(appJs, /stuntButtons\.forEach[\s\S]*?voiceController\.speak\(msg\)/);
    });

    await t.test('9. Universal Voice Coverage: Docking and floating lifecycle events speak', () => {
        assert.match(appJs, /async function floatFairyToDesktop[\s\S]*?voiceController\.speak\("Taking flight to your desktop!"\)/);
        assert.match(appJs, /async function dockFairyToApp[\s\S]*?voiceController\.speak\("I'm back! Ready to assist\."\)/);
    });

    await t.test('10. Universal Voice Coverage: Wake-word detection and voice toggle confirm audibly', () => {
        assert.match(appJs, /onWakeWord:[\s\S]*?voiceController\.speak\("I'm listening! How can I help\?"\)/);
        assert.match(appJs, /toggleTtsBtn\.addEventListener[\s\S]*?voiceController\.speak\('Spoken responses enabled\. Ready for instructions\.'\)/);
    });
});
