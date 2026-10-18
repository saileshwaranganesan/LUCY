'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

// Load target modules
const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');

/**
 * Creates a mock canvas with full tracking of 2D transformation calls.
 */
function createMockCanvas(width = 160, height = 190) {
    const transformStack = [];
    let currentTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const callLog = [];

    const ctx = {
        save: () => {
            transformStack.push({ ...currentTransform });
            callLog.push({ method: 'save' });
        },
        restore: () => {
            if (transformStack.length > 0) {
                currentTransform = transformStack.pop();
            }
            callLog.push({ method: 'restore' });
        },
        setTransform: (a, b, c, d, e, f) => {
            currentTransform = { a, b, c, d, e, f };
            callLog.push({ method: 'setTransform', args: [a, b, c, d, e, f] });
        },
        resetTransform: () => {
            currentTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            callLog.push({ method: 'resetTransform' });
        },
        scale: (sx, sy) => {
            currentTransform.a *= sx;
            currentTransform.d *= sy;
            callLog.push({ method: 'scale', args: [sx, sy] });
        },
        translate: (tx, ty) => {
            callLog.push({ method: 'translate', args: [tx, ty] });
        },
        rotate: (angle) => {
            callLog.push({ method: 'rotate', args: [angle] });
        },
        clearRect: (x, y, w, h) => {
            callLog.push({ method: 'clearRect', args: [x, y, w, h] });
        },
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        bezierCurveTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        ellipse: () => {},
        fill: () => {},
        stroke: () => {},
        createRadialGradient: () => ({ addColorStop: () => {} }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        fillText: () => {},
        measureText: () => ({ width: 10 }),
        getCurrentTransform: () => ({ ...currentTransform }),
        getCallLog: () => [...callLog]
    };

    const listeners = new Map();
    const canvas = {
        width,
        height,
        style: { width: width + 'px', height: height + 'px' },
        getContext: (type) => (type === '2d' ? ctx : null),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }),
        addEventListener: (evt, fn) => {
            if (!listeners.has(evt)) listeners.set(evt, []);
            listeners.get(evt).push(fn);
        },
        removeEventListener: (evt, fn) => {
            if (listeners.has(evt)) {
                listeners.set(evt, listeners.get(evt).filter(h => h !== fn));
            }
        }
    };

    return { canvas, ctx };
}

/**
 * Creates a mock BrowserWindow instance that accurately simulates
 * Windows OS behavior where getSize() includes outer frame borders
 * and getContentSize() returns client area dimensions.
 */
function createMockBrowserWindow(options = {}) {
    const emitter = new EventEmitter();
    let currentX = options.x || 100;
    let currentY = options.y || 100;
    let contentW = options.width || 160;
    let contentH = options.height || 190;
    const borderPadding = 8; // Simulates Windows frame overhead
    let destroyed = false;
    let visible = options.show || false;
    let minimized = false;
    let isAlwaysOnTop = Boolean(options.alwaysOnTop);

    const win = {
        _isMockWindow: true,
        on: (evt, fn) => emitter.on(evt, fn),
        once: (evt, fn) => emitter.once(evt, fn),
        emit: (evt, ...args) => emitter.emit(evt, ...args),
        removeListener: (evt, fn) => emitter.removeListener(evt, fn),
        isDestroyed: () => destroyed,
        destroy: () => {
            destroyed = true;
            emitter.emit('closed');
        },
        show: () => {
            visible = true;
        },
        hide: () => {
            visible = false;
        },
        isVisible: () => visible,
        isMinimized: () => minimized,
        minimize: () => {
            minimized = true;
        },
        restore: () => {
            minimized = false;
            visible = true;
        },
        focus: () => {},
        setAlwaysOnTop: (flag) => {
            isAlwaysOnTop = Boolean(flag);
        },
        getPosition: () => [currentX, currentY],
        setPosition: (x, y) => {
            currentX = Math.round(x);
            currentY = Math.round(y);
            // On Windows, setPosition fires move/moved and OS WM_WINDOWPOSCHANGED (resize event)
            emitter.emit('moved');
            emitter.emit('resize');
        },
        getSize: () => [contentW + borderPadding, contentH + borderPadding],
        getContentSize: () => [contentW, contentH],
        setSize: (w, h) => {
            contentW = Math.round(w);
            contentH = Math.round(h);
            emitter.emit('resize');
        },
        setContentSize: (w, h) => {
            contentW = Math.round(w);
            contentH = Math.round(h);
            emitter.emit('resize');
        },
        getBounds: () => ({ x: currentX, y: currentY, width: contentW, height: contentH }),
        setBounds: (b) => {
            if (typeof b.x === 'number') currentX = Math.round(b.x);
            if (typeof b.y === 'number') currentY = Math.round(b.y);
            if (typeof b.width === 'number') contentW = Math.round(b.width);
            if (typeof b.height === 'number') contentH = Math.round(b.height);
            emitter.emit('moved');
        },
        loadFile: () => Promise.resolve(),
        webContents: {
            send: () => {},
            setWindowOpenHandler: () => {},
            on: () => {}
        }
    };

    return win;
}

test('Repair 4: Floating Companion Scale Stability and Dragging', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-repair4-test-'));

    t.after(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test('1. Repeated dragging does not change window width or height', () => {
        const boundsFile = path.join(tmpDir, 'drag-test-bounds.json');
        let createdMockWin = null;

        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                createdMockWin = createMockBrowserWindow(opts);
                return createdMockWin;
            }
        });

        companion.createWindow();
        assert.ok(companion.window, 'Window must be created');

        const initialW = companion.currentWidth;
        const initialH = companion.currentHeight;
        assert.equal(initialW, 160);
        assert.equal(initialH, 190);

        // Perform 50 rapid drag move steps
        for (let i = 0; i < 50; i++) {
            const [curX, curY] = companion.window.getPosition();
            companion._isMoving = true;
            companion._updateWindowPosition(curX + 5, curY + 3);
        }

        // Window dimensions must remain exactly 160 x 190
        assert.equal(companion.currentWidth, initialW, 'currentWidth must not grow during dragging');
        assert.equal(companion.currentHeight, initialH, 'currentHeight must not grow during dragging');
        const [contentW, contentH] = companion.window.getContentSize();
        assert.equal(contentW, initialW, 'Content width must remain 160');
        assert.equal(contentH, initialH, 'Content height must remain 190');

        companion.destroy();
    });

    await t.test('2. Repeated dragging does not change renderer scale', () => {
        const { canvas, ctx } = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas, { width: 160, height: 190 });

        const initialBaseScale = Math.min(renderer.logicalWidth / 240, renderer.logicalHeight / 220);

        // Render frame 1
        renderer._render(100);
        const transform1 = ctx.getCurrentTransform();

        // Simulate 30 drag position changes in parent
        for (let i = 0; i < 30; i++) {
            // Drag moves desktop position, does NOT call onResize with new sizes
            renderer._render(100 + i * 16);
        }

        const transformFinal = ctx.getCurrentTransform();
        // Because of deterministic transform reset, scale across frames does not accumulate
        assert.equal(transformFinal.a, 1, 'Final root transform matrix must reset cleanly');
        assert.equal(transformFinal.d, 1, 'Final root transform matrix must reset cleanly');
        assert.equal(renderer.logicalWidth, 160, 'Renderer logical width must remain 160');
        assert.equal(renderer.logicalHeight, 190, 'Renderer logical height must remain 190');

        const finalBaseScale = Math.min(renderer.logicalWidth / 240, renderer.logicalHeight / 220);
        assert.equal(finalBaseScale, initialBaseScale, 'Renderer baseScale must remain strictly invariant');

        renderer.destroy();
    });

    await t.test('3. Canvas backing-store scaling is applied exactly once per genuine resize', () => {
        const { canvas } = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas, { width: 160, height: 190 });

        // Set DPR to 1.5 (e.g. 150% Windows display scaling)
        renderer.onResize(160, 190, 1.5);

        assert.equal(renderer.logicalWidth, 160);
        assert.equal(renderer.logicalHeight, 190);
        assert.equal(canvas.width, 240, 'Backing store width must be 160 * 1.5 = 240');
        assert.equal(canvas.height, 285, 'Backing store height must be 190 * 1.5 = 285');

        // Calling onResize again with identical dimensions must not multiply or change backing store
        renderer.onResize(160, 190, 1.5);
        assert.equal(canvas.width, 240, 'Backing store width must not be multiplied on subsequent call');
        assert.equal(canvas.height, 285, 'Backing store height must not be multiplied on subsequent call');

        renderer.destroy();
    });

    await t.test('4. Reinitializing the renderer does not compound scaling', () => {
        const { canvas } = createMockCanvas(160, 190);

        const renderer1 = new CelestialFamiliarRenderer(canvas, { width: 160, height: 190 });
        renderer1.onResize(160, 190, 1.25);
        assert.equal(canvas.width, 200);
        assert.equal(canvas.height, 238);
        renderer1.destroy();

        // Reinitialize renderer on the same canvas
        const renderer2 = new CelestialFamiliarRenderer(canvas, { width: 160, height: 190 });
        renderer2.onResize(160, 190, 1.25);
        assert.equal(canvas.width, 200, 'Reinitialization must calculate clean 160 * 1.25 = 200, not compound');
        assert.equal(canvas.height, 238, 'Reinitialization must calculate clean 190 * 1.25 = 238, not compound');
        renderer2.destroy();
    });

    await t.test('5. Animation frames do not accumulate transforms across frames', () => {
        const { canvas, ctx } = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas, { width: 160, height: 190 });
        renderer.dpr = 1.25;

        // Render 60 consecutive frames with tricks and stunts that apply rotation, flight offset, scale
        renderer.triggerSomersault();
        for (let f = 0; f < 60; f++) {
            renderer._update(f * 16, 0.016);
            renderer._render(f * 16);
        }

        // Post-render state: transform must be cleanly reset to identity (1, 0, 0, 1, 0, 0)
        const curTransform = ctx.getCurrentTransform();
        assert.equal(curTransform.a, 1, 'Scale X must reset to 1');
        assert.equal(curTransform.d, 1, 'Scale Y must reset to 1');

        renderer.destroy();
    });

    await t.test('6. Explicit resizing updates the window and renderer correctly', () => {
        const boundsFile = path.join(tmpDir, 'resize-test-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        companion.createWindow();

        // Explicit user resize to 220 x 260
        const result = companion.setWindowSize(220, 260, false);
        assert.ok(result.ok);
        assert.equal(companion.currentWidth, 220);
        assert.equal(companion.currentHeight, 260);

        const [cw, ch] = companion.window.getContentSize();
        assert.equal(cw, 220);
        assert.equal(ch, 260);

        // Renderer responds to legitimate resize
        const { canvas } = createMockCanvas(220, 260);
        const renderer = new CelestialFamiliarRenderer(canvas, { width: 220, height: 260 });
        renderer.onResize(220, 260, 1.0);
        assert.equal(renderer.logicalWidth, 220);
        assert.equal(renderer.logicalHeight, 260);

        companion.destroy();
        renderer.destroy();
    });

    await t.test('7. Changing size presets preserves the selected dimensions', () => {
        const boundsFile = path.join(tmpDir, 'preset-test-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        companion.createWindow();

        // Preset 1: Tiny (140 x 170)
        companion.setWindowSize(140, 170, false);
        assert.equal(companion.currentWidth, 140);
        assert.equal(companion.currentHeight, 170);

        // Preset 2: Standard (160 x 190)
        companion.setWindowSize(160, 190, false);
        assert.equal(companion.currentWidth, 160);
        assert.equal(companion.currentHeight, 190);

        // Preset 3: Large (240 x 280)
        companion.setWindowSize(240, 280, false);
        assert.equal(companion.currentWidth, 240);
        assert.equal(companion.currentHeight, 280);

        companion.destroy();
    });

    await t.test('8. Docking and undocking preserve configured size', async () => {
        const boundsFile = path.join(tmpDir, 'dock-test-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        companion.createWindow();
        companion.setWindowSize(180, 210, false);

        // Dock into app (hide)
        companion.hide({ suppressNotification: true });
        assert.equal(companion.isShown, false);
        assert.equal(companion.currentWidth, 180, 'Width preserved across dock/hide');
        assert.equal(companion.currentHeight, 210, 'Height preserved across dock/hide');

        // Undock back to desktop (show)
        companion.show();
        assert.equal(companion.isShown, true);
        assert.equal(companion.currentWidth, 180, 'Width preserved upon undock/show');
        assert.equal(companion.currentHeight, 210, 'Height preserved upon undock/show');

        companion.destroy();
    });

    await t.test('9. Restoring a window preserves its dimensions', () => {
        const boundsFile = path.join(tmpDir, 'restore-test-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        companion.createWindow();
        companion.setWindowSize(175, 205, false);

        // Minimize window
        companion.window.minimize();
        assert.equal(companion.window.isMinimized(), true);

        // Summon/restore window
        companion.summonToFront();
        assert.equal(companion.window.isMinimized(), false);
        assert.equal(companion.currentWidth, 175, 'Width must remain 175 after restore');
        assert.equal(companion.currentHeight, 205, 'Height must remain 205 after restore');

        companion.destroy();
    });

    await t.test('10. Monitor/DPI changes do not cause progressive growth', () => {
        const { canvas } = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas, { width: 160, height: 190 });

        // Simulate switching between monitor 1 (1.0x DPI) and monitor 2 (1.5x DPI) 10 times
        for (let i = 0; i < 10; i++) {
            renderer.onResize(160, 190, 1.0);
            assert.equal(renderer.logicalWidth, 160);
            assert.equal(renderer.logicalHeight, 190);
            assert.equal(canvas.width, 160);
            assert.equal(canvas.height, 190);

            renderer.onResize(160, 190, 1.5);
            assert.equal(renderer.logicalWidth, 160);
            assert.equal(renderer.logicalHeight, 190);
            assert.equal(canvas.width, 240);
            assert.equal(canvas.height, 285);
        }

        // Return to 1.25x DPI
        renderer.onResize(160, 190, 1.25);
        assert.equal(renderer.logicalWidth, 160);
        assert.equal(renderer.logicalHeight, 190);
        assert.equal(canvas.width, 200);
        assert.equal(canvas.height, 238);

        renderer.destroy();
    });

    await t.test('11. Repeated IPC position updates do not mutate size', () => {
        const boundsFile = path.join(tmpDir, 'ipc-pos-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        companion.createWindow();

        const initialW = companion.currentWidth;
        const initialH = companion.currentHeight;

        // Simulate 40 IPC moveWindow calls
        for (let i = 0; i < 40; i++) {
            const [x, y] = companion.window.getPosition();
            companion._isMoving = true;
            companion._updateWindowPosition(x + 2, y + 2);
        }

        assert.equal(companion.currentWidth, initialW);
        assert.equal(companion.currentHeight, initialH);

        companion.destroy();
    });

    await t.test('12. Invalid dimensions are rejected or clamped using existing safety bounds', () => {
        const boundsFile = path.join(tmpDir, 'clamping-test-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        companion.createWindow();

        // Sub-minimum dimensions clamp to MIN_WIDTH (140) and MIN_HEIGHT (170)
        companion.setWindowSize(50, 50, false);
        assert.equal(companion.currentWidth, FloatingCompanionWindow.MIN_WIDTH);
        assert.equal(companion.currentHeight, FloatingCompanionWindow.MIN_HEIGHT);

        // Super-maximum dimensions clamp to MAX_WIDTH (520) and MAX_HEIGHT (600)
        companion.setWindowSize(9999, 9999, false);
        assert.equal(companion.currentWidth, FloatingCompanionWindow.MAX_WIDTH);
        assert.equal(companion.currentHeight, FloatingCompanionWindow.MAX_HEIGHT);

        // NaN / non-finite inputs are safely rejected
        const badResult = companion.setWindowSize(NaN, 'invalid');
        assert.equal(badResult, false);

        companion.destroy();
    });

    await t.test('13. Settings persistence restores the correct dimensions', () => {
        const boundsFile = path.join(tmpDir, 'persistence-test-bounds.json');

        // Session 1: configure custom dimensions and save
        const companion1 = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        companion1.createWindow();
        companion1.setWindowSize(200, 230, false);
        companion1.destroy();

        // Verify bounds file content
        assert.ok(fs.existsSync(boundsFile));
        const saved = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
        assert.equal(saved.width, 200);
        assert.equal(saved.height, 230);

        // Session 2: start new instance and verify exact dimensions restored
        const companion2 = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: function (opts) {
                return createMockBrowserWindow(opts);
            }
        });
        assert.equal(companion2.currentWidth, 200, 'Restored width must be 200');
        assert.equal(companion2.currentHeight, 230, 'Restored height must be 230');

        companion2.createWindow();
        const [cw, ch] = companion2.window.getContentSize();
        assert.equal(cw, 200);
        assert.equal(ch, 230);

        companion2.destroy();
    });

    await t.test('14. No duplicate resize observers or animation loops are created', () => {
        const { canvas } = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas, { width: 160, height: 190 });

        // Starting renderer multiple times does not create multiple RAF loops
        renderer.start();
        const firstRaf = renderer.rafId;
        renderer.start();
        assert.equal(renderer.running, true);
        assert.equal(renderer.rafId, firstRaf, 'Repeated start() must not spawn duplicate loops');

        renderer.stop();
        assert.equal(renderer.running, false);
        assert.equal(renderer.rafId, null, 'Stopping renderer clears active RAF ID');

        renderer.destroy();
    });
});
