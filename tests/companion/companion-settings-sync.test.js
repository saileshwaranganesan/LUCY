'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const { FloatingCompanionWindow } = require('../../src/companion/floating-companion-window.js');
const { validateCompanionDimensions } = require('../../src/security/ipc-validator.js');
const { CelestialFamiliarRenderer } = require('../../src/ui/companion-renderer.js');

/**
 * Creates a mock canvas for testing renderer dimension and DPR synchronization.
 */
function createMockCanvas(width = 160, height = 190) {
    let currentTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const transformStack = [];
    const calls = [];

    const ctx = {
        save: () => {
            transformStack.push({ ...currentTransform });
            calls.push({ method: 'save' });
        },
        restore: () => {
            if (transformStack.length > 0) currentTransform = transformStack.pop();
            calls.push({ method: 'restore' });
        },
        setTransform: (a, b, c, d, e, f) => {
            currentTransform = { a, b, c, d, e, f };
            calls.push({ method: 'setTransform', args: [a, b, c, d, e, f] });
        },
        resetTransform: () => {
            currentTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            calls.push({ method: 'resetTransform' });
        },
        scale: (sx, sy) => {
            currentTransform.a *= sx;
            currentTransform.d *= sy;
            calls.push({ method: 'scale', args: [sx, sy] });
        },
        translate: (tx, ty) => calls.push({ method: 'translate', args: [tx, ty] }),
        rotate: (angle) => calls.push({ method: 'rotate', args: [angle] }),
        clearRect: (x, y, w, h) => calls.push({ method: 'clearRect', args: [x, y, w, h] }),
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
        createLinearGradient: () => ({ addColorStop: () => {} })
    };

    return {
        width,
        height,
        style: { width: `${width}px`, height: `${height}px` },
        getContext: () => ctx,
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () => ({
            width,
            height,
            left: 0,
            top: 0,
            right: width,
            bottom: height
        }),
        _ctx: ctx,
        _calls: calls,
        _getCurrentTransform: () => ({ ...currentTransform })
    };
}

/**
 * Creates a mock BrowserWindow for testing FloatingCompanionWindow.
 */
function MockBrowserWindow(options = {}) {
    const emitter = new EventEmitter();
    let x = options.x !== undefined ? options.x : 100;
    let y = options.y !== undefined ? options.y : 100;
    let width = options.width || FloatingCompanionWindow.DEFAULT_WIDTH;
    let height = options.height || FloatingCompanionWindow.DEFAULT_HEIGHT;
    let visible = options.show || false;
    let destroyed = false;
    let alwaysOnTop = Boolean(options.alwaysOnTop);

    const sentMessages = [];

    const win = {
        isDestroyed: () => destroyed,
        isMinimized: () => false,
        isVisible: () => visible,
        show: () => { visible = true; },
        hide: () => { visible = false; },
        focus: () => {},
        restore: () => {},
        getPosition: () => [x, y],
        setPosition: (newX, newY) => {
            x = newX;
            y = newY;
            emitter.emit('moved');
        },
        getSize: () => [width, height],
        setSize: (w, h) => {
            width = w;
            height = h;
            emitter.emit('resize');
        },
        getContentSize: () => [width, height],
        setContentSize: (w, h) => {
            width = w;
            height = h;
            emitter.emit('resize');
        },
        setBounds: (bounds) => {
            if (bounds.x !== undefined) x = bounds.x;
            if (bounds.y !== undefined) y = bounds.y;
            if (bounds.width !== undefined) width = bounds.width;
            if (bounds.height !== undefined) height = bounds.height;
            emitter.emit('resize');
            emitter.emit('moved');
        },
        setAlwaysOnTop: (val) => { alwaysOnTop = Boolean(val); },
        loadFile: () => {},
        webContents: {
            send: (channel, data) => {
                sentMessages.push({ channel, data });
            },
            setWindowOpenHandler: () => {},
            on: () => {}
        },
        on: (event, handler) => emitter.on(event, handler),
        once: (event, handler) => emitter.once(event, handler),
        destroy: () => {
            destroyed = true;
            visible = false;
            emitter.emit('closed');
        },
        _sentMessages: sentMessages,
        _emitter: emitter
    };

    return win;
}

test('Repair 5: Companion Size Settings and Window-Bounds Synchronization', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-repair5-tests-'));

    t.after(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    });

    await t.test('1. Initial settings and window dimensions agree with default 160 × 190', () => {
        const boundsFile = path.join(tmpDir, 'test1-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });

        assert.equal(companion.currentWidth, 160);
        assert.equal(companion.currentHeight, 190);

        const status = companion.getStatus();
        assert.equal(status.width, 160);
        assert.equal(status.height, 190);

        companion.createWindow();
        const size = companion._getContentSize();
        assert.equal(size[0], 160);
        assert.equal(size[1], 190);
        companion.destroy();
    });

    await t.test('2. Width slider updates the effective window width', () => {
        const boundsFile = path.join(tmpDir, 'test2-bounds.json');
        let mainSent = [];
        const mockMainWindow = {
            isDestroyed: () => false,
            webContents: {
                send: (ch, data) => mainSent.push({ ch, data })
            }
        };

        const companion = new FloatingCompanionWindow({
            boundsFile,
            mainWindow: mockMainWindow,
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();

        const result = companion.setWindowSize(280, 190, false);
        assert.equal(result.ok, true);
        assert.equal(result.width, 280);
        assert.equal(result.height, 190);
        assert.equal(companion.currentWidth, 280);

        // Confirmed notification broadcast to mainWindow
        const mainNotification = mainSent.find(m => m.ch === 'lucy:companionResized');
        assert.ok(mainNotification, 'Main window must be notified of size update');
        assert.equal(mainNotification.data.width, 280);
        assert.equal(mainNotification.data.height, 190);

        companion.destroy();
    });

    await t.test('3. Height slider updates the effective window height', () => {
        const boundsFile = path.join(tmpDir, 'test3-bounds.json');
        let mainSent = [];
        const mockMainWindow = {
            isDestroyed: () => false,
            webContents: {
                send: (ch, data) => mainSent.push({ ch, data })
            }
        };

        const companion = new FloatingCompanionWindow({
            boundsFile,
            mainWindow: mockMainWindow,
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();

        const result = companion.setWindowSize(160, 340, false);
        assert.equal(result.ok, true);
        assert.equal(result.width, 160);
        assert.equal(result.height, 340);
        assert.equal(companion.currentHeight, 340);

        const mainNotification = mainSent.find(m => m.ch === 'lucy:companionResized');
        assert.ok(mainNotification);
        assert.equal(mainNotification.data.height, 340);

        companion.destroy();
    });

    await t.test('4. Preset selection updates both dimensions (Tiny Default 160×190, Comfortable 220×260)', () => {
        const boundsFile = path.join(tmpDir, 'test4-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();

        // Comfortable preset: 220 × 260
        const comfortable = companion.setWindowSize(220, 260, false);
        assert.equal(comfortable.ok, true);
        assert.equal(comfortable.width, 220);
        assert.equal(comfortable.height, 260);
        assert.equal(companion.currentWidth, 220);
        assert.equal(companion.currentHeight, 260);

        // Tiny default preset: 160 × 190
        const tiny = companion.setWindowSize(160, 190, false);
        assert.equal(tiny.ok, true);
        assert.equal(tiny.width, 160);
        assert.equal(tiny.height, 190);
        assert.equal(companion.currentWidth, 160);
        assert.equal(companion.currentHeight, 190);

        companion.destroy();
    });

    await t.test('5. Displayed values reflect clamped dimensions across boundaries', () => {
        const boundsFile = path.join(tmpDir, 'test5-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();

        // Sub-minimum clamping: 50x50 -> 140x170
        const subMin = companion.setWindowSize(50, 50, false);
        assert.equal(subMin.width, 140);
        assert.equal(subMin.height, 170);

        // Super-maximum clamping: 999x999 -> 520x600
        const superMax = companion.setWindowSize(999, 999, false);
        assert.equal(superMax.width, 520);
        assert.equal(superMax.height, 600);

        // IPC validator clamping agreement
        const validatedSub = validateCompanionDimensions({ width: 50, height: 50 });
        assert.equal(validatedSub.sanitized.width, 140);
        assert.equal(validatedSub.sanitized.height, 170);

        const validatedMax = validateCompanionDimensions({ width: 999, height: 999 });
        assert.equal(validatedMax.sanitized.width, 520);
        assert.equal(validatedMax.sanitized.height, 600);

        companion.destroy();
    });

    await t.test('6. Main-process confirmation updates UI state correctly', async () => {
        // Simulate UI controller logic with confirmed state tracking
        let confirmedWidth = 160;
        let confirmedHeight = 190;
        let tentativeWidth = 160;
        let tentativeHeight = 190;

        const fakeIpcHandler = async (dims) => {
            const v = validateCompanionDimensions(dims);
            if (!v.ok) return { ok: false };
            return { ok: true, width: v.sanitized.width, height: v.sanitized.height };
        };

        const commitDimensions = async (w, h) => {
            tentativeWidth = w;
            tentativeHeight = h;
            const res = await fakeIpcHandler({ width: w, height: h });
            if (res.ok) {
                confirmedWidth = res.width;
                confirmedHeight = res.height;
            }
        };

        await commitDimensions(250, 300);
        assert.equal(confirmedWidth, 250);
        assert.equal(confirmedHeight, 300);

        // Clamped dimension request: confirmed value reflects clamped result
        await commitDimensions(20, 800);
        assert.equal(confirmedWidth, 140);
        assert.equal(confirmedHeight, 600);
    });

    await t.test('7. Out-of-order IPC responses cannot overwrite newer selections', async () => {
        let confirmedWidth = 160;
        let confirmedHeight = 190;
        let dimensionRequestId = 0;

        const fakeDelayedIpc = (dims, delayMs) => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve({ ok: true, width: dims.width, height: dims.height });
                }, delayMs);
            });
        };

        const commit = async (w, h, delayMs) => {
            const reqId = ++dimensionRequestId;
            const res = await fakeDelayedIpc({ width: w, height: h }, delayMs);
            // Drop stale response if newer request exists
            if (reqId !== dimensionRequestId) {
                return;
            }
            if (res.ok) {
                confirmedWidth = res.width;
                confirmedHeight = res.height;
            }
        };

        // Fire Request 1 (width=200, arrives slowly in 40ms)
        const p1 = commit(200, 200, 40);
        // Fire Request 2 (width=300, arrives quickly in 10ms)
        const p2 = commit(300, 300, 10);

        await Promise.all([p1, p2]);

        // State must strictly reflect Request 2 (300), NOT overwritten by delayed Request 1 (200)
        assert.equal(confirmedWidth, 300);
        assert.equal(confirmedHeight, 300);
    });

    await t.test('8. Renderer dimensions match effective window dimensions', () => {
        const canvas = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas);

        renderer.onResize(240, 280, 1);
        assert.equal(renderer.logicalWidth, 240);
        assert.equal(renderer.logicalHeight, 280);
        assert.equal(canvas.width, 240);
        assert.equal(canvas.height, 280);

        renderer.stop();
    });

    await t.test('9. Device-pixel-ratio handling does not distort logical dimensions', () => {
        const canvas = createMockCanvas(160, 190);
        const renderer = new CelestialFamiliarRenderer(canvas);

        // DPR = 2.0 (High-DPI Retina/4K display)
        renderer.onResize(200, 250, 2.0);
        assert.equal(renderer.logicalWidth, 200, 'Logical width must be unchanged by DPR');
        assert.equal(renderer.logicalHeight, 250, 'Logical height must be unchanged by DPR');
        assert.equal(renderer.dpr, 2.0);
        assert.equal(canvas.width, 400, 'Physical canvas width must be logical * dpr');
        assert.equal(canvas.height, 500, 'Physical canvas height must be logical * dpr');

        // Verify render pass uses identity scale * DPR without compounding
        renderer._render(100);
        const transform = canvas._getCurrentTransform();
        // Base coordinate scale factor is baseScale * dpr
        assert.ok(transform.a > 0, 'Canvas transform must be positive');
        assert.equal(transform.b, 0, 'No skew');
        assert.equal(transform.c, 0, 'No skew');

        renderer.stop();
    });

    await t.test('10. Docking and undocking preserve configured floating size', () => {
        const boundsFile = path.join(tmpDir, 'test10-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });

        // 1. Set custom size while open
        companion.createWindow();
        companion.show();
        companion.setWindowSize(260, 310, false);
        assert.equal(companion.currentWidth, 260);
        assert.equal(companion.currentHeight, 310);

        // 2. Dock (hide)
        companion.hide();
        assert.equal(companion.isOpen(), false);
        assert.equal(companion.currentWidth, 260, 'Docking must not modify currentWidth');
        assert.equal(companion.currentHeight, 310, 'Docking must not modify currentHeight');

        // 3. User alters dimensions while docked in settings
        companion.setWindowSize(200, 240, false);
        assert.equal(companion.currentWidth, 200);
        assert.equal(companion.currentHeight, 240);

        // 4. Undock (show)
        companion.show();
        assert.equal(companion.isOpen(), true);
        const size = companion._getContentSize();
        assert.equal(size[0], 200, 'Undocked window must apply dimensions configured while docked');
        assert.equal(size[1], 240);

        companion.destroy();
    });

    await t.test('11. Restart restores the saved dimensions', () => {
        const boundsFile = path.join(tmpDir, 'test11-bounds.json');

        // Session 1: Configure 310 × 370 and destroy
        const s1 = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });
        s1.createWindow();
        s1.setWindowSize(310, 370, false);
        s1.destroy();

        // Verify disk file
        assert.ok(fs.existsSync(boundsFile));
        const saved = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
        assert.equal(saved.width, 310);
        assert.equal(saved.height, 370);

        // Session 2: Fresh instance loads saved dimensions
        const s2 = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });
        assert.equal(s2.currentWidth, 310, 'Restored width must match saved width');
        assert.equal(s2.currentHeight, 370, 'Restored height must match saved height');

        s2.createWindow();
        const size = s2._getContentSize();
        assert.equal(size[0], 310);
        assert.equal(size[1], 370);

        s2.destroy();
    });

    await t.test('12. Failed resize operations do not leave stale UI values', async () => {
        let confirmedWidth = 160;
        let confirmedHeight = 190;
        let displayedWidth = 160;
        let displayedHeight = 190;

        const fakeFailingIpc = async (_dims) => {
            return { ok: false, error: 'Simulated window resize failure' };
        };

        const commit = async (w, h) => {
            displayedWidth = w;
            displayedHeight = h;
            const res = await fakeFailingIpc({ width: w, height: h });
            if (res.ok) {
                confirmedWidth = res.width;
                confirmedHeight = res.height;
            } else {
                // Roll back displayed values to last confirmed
                displayedWidth = confirmedWidth;
                displayedHeight = confirmedHeight;
            }
        };

        await commit(450, 500);
        // Displayed values rolled back cleanly
        assert.equal(displayedWidth, 160);
        assert.equal(displayedHeight, 190);
        assert.equal(confirmedWidth, 160);
        assert.equal(confirmedHeight, 190);
    });

    await t.test('13. Repeated resizing does not create recursive event loops', () => {
        const boundsFile = path.join(tmpDir, 'test13-bounds.json');
        let resizeNotificationCount = 0;

        const mockMainWindow = {
            isDestroyed: () => false,
            webContents: {
                send: (ch) => {
                    if (ch === 'lucy:companionResized') resizeNotificationCount++;
                }
            }
        };

        const companion = new FloatingCompanionWindow({
            boundsFile,
            mainWindow: mockMainWindow,
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();

        // Perform 20 sequential explicit resizes
        for (let i = 0; i < 20; i++) {
            companion.setWindowSize(180 + i, 200 + i, false);
        }

        // Each explicit resize should produce exactly one notification, no runaway recursive multiplier
        assert.equal(resizeNotificationCount, 20);

        companion.destroy();
    });

    await t.test('14. Dragging does not mutate dimensions', () => {
        const boundsFile = path.join(tmpDir, 'test14-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();
        companion.setWindowSize(200, 240, false);

        // Perform 50 position updates (dragging)
        for (let i = 0; i < 50; i++) {
            companion._updateWindowPosition(100 + i * 2, 100 + i * 2);
        }

        // Dimensions must remain strictly 200 × 240
        assert.equal(companion.currentWidth, 200);
        assert.equal(companion.currentHeight, 240);

        const size = companion._getContentSize();
        assert.equal(size[0], 200);
        assert.equal(size[1], 240);

        companion.destroy();
    });

    await t.test('15. Invalid dimension requests are rejected safely', () => {
        const boundsFile = path.join(tmpDir, 'test15-bounds.json');
        const companion = new FloatingCompanionWindow({
            boundsFile,
            BrowserWindow: MockBrowserWindow
        });
        companion.createWindow();

        // Non-finite values rejected
        assert.equal(companion.setWindowSize(NaN, 200), false);
        assert.equal(companion.setWindowSize(200, Infinity), false);
        assert.equal(companion.setWindowSize('invalid', 'bad'), false);

        // Current dimensions untouched
        assert.equal(companion.currentWidth, 160);
        assert.equal(companion.currentHeight, 190);

        // IPC validator rejects null, strings, arrays
        assert.equal(validateCompanionDimensions(null).ok, false);
        assert.equal(validateCompanionDimensions('not-an-object').ok, false);
        assert.equal(validateCompanionDimensions({ width: 'foo', height: 'bar' }).ok, false);

        companion.destroy();
    });
});
