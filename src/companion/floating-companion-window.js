'use strict';

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { validateMoveWindow, validateExecuteRequest } = require('../security/ipc-validator.js');

/**
 * FloatingCompanionWindow
 * Manages the compact, transparent, borderless desktop window for L.U.C.Y.'s
 * cute fairy companion.
 * 
 * ARCHITECTURAL MANDATES:
 * 1. ZERO autonomous brain: visual and presentation layer only.
 * 2. Complete crash isolation: failure of companion renderer never crashes core assistant.
 * 3. Secure context isolation: sandbox enabled, nodeIntegration disabled.
 * 4. Seamless transitions: coordinated handoff between embedded interface and desktop.
 * 5. Compact, proportionate footprint: unobtrusive miniature desktop companion.
 * 6. High discoverability: reliable summon, pin/unpin, and dock/restore lifecycle.
 */
class FloatingCompanionWindow {
    static MIN_WIDTH = 140;
    static MIN_HEIGHT = 170;
    static DEFAULT_WIDTH = 160;
    static DEFAULT_HEIGHT = 190;
    static MAX_WIDTH = 520;
    static MAX_HEIGHT = 600;

    constructor(options = {}) {
        this.mainWindow = options.mainWindow || null;
        this.onRestoreMainWindow = options.onRestoreMainWindow || null;
        this.onPinChanged = options.onPinChanged || null;
        this.companionBridge = options.companionBridge || null;
        this.coordinator = options.coordinator || null;
        this.browserWindowConstructor = options.BrowserWindow || BrowserWindow;
        this.window = null;
        this.isShown = false;
        this.isPinned = true;
        this.isRestoring = false;
        this.boundsFile = options.boundsFile || null;
        this.currentWidth = FloatingCompanionWindow.DEFAULT_WIDTH;
        this.currentHeight = FloatingCompanionWindow.DEFAULT_HEIGHT;
        this.lastPosition = this._loadSavedBounds();
        this._isMoving = false;
        this._isTemporarySize = false;
        this._moveResetTimer = null;

        this._onDisplayMetricsChanged = () => this.validateAndClampPosition();
        if (screen && typeof screen.on === 'function') {
            try {
                screen.on('display-metrics-changed', this._onDisplayMetricsChanged);
                screen.on('display-removed', this._onDisplayMetricsChanged);
            } catch (_) {}
        }

        this._registerIpcHandlers();
    }

    setOnRestoreMainWindow(fn) {
        this.onRestoreMainWindow = fn;
    }

    _getContentSize() {
        if (!this.window || this.window.isDestroyed()) {
            return [this.currentWidth, this.currentHeight];
        }
        try {
            if (typeof this.window.getContentSize === 'function') {
                const [cw, ch] = this.window.getContentSize();
                if (Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0) {
                    return [cw, ch];
                }
            }
            if (typeof this.window.getSize === 'function') {
                return this.window.getSize();
            }
        } catch (_) {}
        return [this.currentWidth, this.currentHeight];
    }

    _updateWindowPosition(x, y) {
        if (!this.window || this.window.isDestroyed()) return;
        const clamped = this._clampToBounds(x, y, this.currentWidth, this.currentHeight);
        try {
            if (typeof this.window.setBounds === 'function') {
                this.window.setBounds({
                    x: clamped.x,
                    y: clamped.y,
                    width: this.currentWidth,
                    height: this.currentHeight
                });
            } else if (typeof this.window.setPosition === 'function') {
                this.window.setPosition(clamped.x, clamped.y);
            }
        } catch (_) {
            try {
                if (typeof this.window.setPosition === 'function') {
                    this.window.setPosition(clamped.x, clamped.y);
                }
            } catch (_) {}
        }
        this._savePosition(clamped.x, clamped.y);
    }

    validateAndClampPosition() {
        if (!this.window || this.window.isDestroyed()) return;
        try {
            const [x, y] = this.window.getPosition();
            const clamped = this._clampToBounds(x, y, this.currentWidth, this.currentHeight);
            if (clamped.x !== x || clamped.y !== y) {
                this._updateWindowPosition(clamped.x, clamped.y);
            }
        } catch (_) {}
    }

    _debounce(fn, delayMs) {
        let timer = null;
        return (...args) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                fn(...args);
            }, delayMs);
        };
    }

    _getBoundsFile() {
        if (this.boundsFile) return this.boundsFile;
        try {
            const { app } = require('electron');
            if (app && typeof app.getPath === 'function') {
                return path.join(app.getPath('userData'), 'companion-window-bounds.json');
            }
        } catch (_) {}
        return null;
    }

    _clampToBounds(x, y, width = FloatingCompanionWindow.DEFAULT_WIDTH, height = FloatingCompanionWindow.DEFAULT_HEIGHT, customWorkArea = null) {
        if (customWorkArea) {
            const clampedX = Math.round(Math.max(customWorkArea.x + 8, Math.min(x, customWorkArea.x + customWorkArea.width - width - 8)));
            const clampedY = Math.round(Math.max(customWorkArea.y + 8, Math.min(y, customWorkArea.y + customWorkArea.height - height - 8)));
            return { x: clampedX, y: clampedY };
        }
        if (!screen || typeof screen.getAllDisplays !== 'function') {
            return { x, y };
        }
        try {
            const displays = screen.getAllDisplays();
            if (!displays || displays.length === 0) return { x, y };

            const targetPoint = { x: x + width / 2, y: y + height / 2 };
            let matched = screen.getDisplayNearestPoint ? screen.getDisplayNearestPoint(targetPoint) : screen.getPrimaryDisplay();
            if (!matched) matched = displays[0];

            const workArea = matched.workArea;
            const clampedX = Math.round(Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - width - 8)));
            const clampedY = Math.round(Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - height - 8)));
            return { x: clampedX, y: clampedY };
        } catch (_) {
            return { x, y };
        }
    }

    _loadSavedBounds() {
        const file = this._getBoundsFile();
        if (file && fs.existsSync(file)) {
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (data && typeof data === 'object') {
                    if (data.isPinned !== undefined) {
                        this.isPinned = Boolean(data.isPinned);
                    }
                    if (typeof data.width === 'number' && typeof data.height === 'number' && Number.isFinite(data.width) && Number.isFinite(data.height)) {
                        this.currentWidth = Math.max(FloatingCompanionWindow.MIN_WIDTH, Math.min(FloatingCompanionWindow.MAX_WIDTH, Math.round(data.width)));
                        this.currentHeight = Math.max(FloatingCompanionWindow.MIN_HEIGHT, Math.min(FloatingCompanionWindow.MAX_HEIGHT, Math.round(data.height)));
                    } else {
                        this.currentWidth = FloatingCompanionWindow.DEFAULT_WIDTH;
                        this.currentHeight = FloatingCompanionWindow.DEFAULT_HEIGHT;
                    }
                    if (typeof data.x === 'number' && typeof data.y === 'number' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
                        const clamped = this._clampToBounds(data.x, data.y, this.currentWidth, this.currentHeight);
                        this.lastPosition = clamped;
                        return clamped;
                    }
                }
            } catch (_) {}
        }
        this.currentWidth = FloatingCompanionWindow.DEFAULT_WIDTH;
        this.currentHeight = FloatingCompanionWindow.DEFAULT_HEIGHT;
        return null;
    }

    _loadSavedPosition() {
        return this._loadSavedBounds();
    }

    _saveBounds(x, y, width = this.currentWidth, height = this.currentHeight) {
        if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
            this.lastPosition = { x: Math.round(x), y: Math.round(y) };
        }
        if (typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height)) {
            this.currentWidth = Math.max(FloatingCompanionWindow.MIN_WIDTH, Math.min(FloatingCompanionWindow.MAX_WIDTH, Math.round(width)));
            this.currentHeight = Math.max(FloatingCompanionWindow.MIN_HEIGHT, Math.min(FloatingCompanionWindow.MAX_HEIGHT, Math.round(height)));
        }
        const file = this._getBoundsFile();
        if (file) {
            try {
                fs.writeFileSync(file, JSON.stringify({
                    x: this.lastPosition ? this.lastPosition.x : 100,
                    y: this.lastPosition ? this.lastPosition.y : 100,
                    width: this.currentWidth,
                    height: this.currentHeight,
                    isPinned: this.isPinned
                }, null, 2), 'utf8');
            } catch (_) {}
        }
    }

    _savePosition(x, y) {
        if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
            this.lastPosition = { x: Math.round(x), y: Math.round(y) };
        }
        const file = this._getBoundsFile();
        if (file) {
            try {
                fs.writeFileSync(file, JSON.stringify({
                    x: this.lastPosition ? this.lastPosition.x : 100,
                    y: this.lastPosition ? this.lastPosition.y : 100,
                    width: this.currentWidth,
                    height: this.currentHeight,
                    isPinned: this.isPinned
                }, null, 2), 'utf8');
            } catch (_) {}
        }
    }

    setMainWindow(mainWindow) {
        this.mainWindow = mainWindow;
    }

    setCoordinator(coordinator) {
        this.coordinator = coordinator;
    }

    setCompanionBridge(companionBridge) {
        this.companionBridge = companionBridge;
    }

    /**
     * Create or restore the compact floating companion window
     */
    createWindow() {
        if (this.window && !this.window.isDestroyed()) {
            this.show();
            return this.window;
        }

        const winWidth = this.currentWidth || FloatingCompanionWindow.DEFAULT_WIDTH;
        const winHeight = this.currentHeight || FloatingCompanionWindow.DEFAULT_HEIGHT;

        let defaultX = 100;
        let defaultY = 100;
        try {
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
            defaultX = this.lastPosition ? this.lastPosition.x : Math.max(20, screenWidth - winWidth - 30);
            defaultY = this.lastPosition ? this.lastPosition.y : Math.max(20, screenHeight - winHeight - 30);
            const clamped = this._clampToBounds(defaultX, defaultY, winWidth, winHeight);
            defaultX = clamped.x;
            defaultY = clamped.y;
        } catch (_) {}

        const WinCtor = this.browserWindowConstructor || BrowserWindow;
        this.window = new WinCtor({
            width: winWidth,
            height: winHeight,
            useContentSize: true,
            minWidth: FloatingCompanionWindow.MIN_WIDTH,
            minHeight: FloatingCompanionWindow.MIN_HEIGHT,
            maxWidth: FloatingCompanionWindow.MAX_WIDTH,
            maxHeight: FloatingCompanionWindow.MAX_HEIGHT,
            x: defaultX,
            y: defaultY,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            alwaysOnTop: this.isPinned,
            skipTaskbar: true,
            resizable: true,
            movable: true,
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'companion-preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                autoplayPolicy: 'no-user-gesture-required',
                backgroundThrottling: false
            }
        });

        this._applyAlwaysOnTop();

        try {
            if (typeof this.window.setContentSize === 'function') {
                this.window.setContentSize(winWidth, winHeight);
            }
        } catch (_) {}

        const companionHtmlPath = path.join(__dirname, 'companion.html');
        this.window.loadFile(companionHtmlPath);

        // Security: deny external window opening & external navigation
        this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        this.window.webContents.on('will-navigate', (event, url) => {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'file:') event.preventDefault();
            } catch {
                event.preventDefault();
            }
        });

        this.window.once('ready-to-show', () => {
            if (this.window && !this.window.isDestroyed()) {
                try {
                    if (typeof this.window.setContentSize === 'function') {
                        this.window.setContentSize(this.currentWidth, this.currentHeight);
                    }
                } catch (_) {}
                // Non-activating presentation to avoid stealing focus from active desktop apps
                if (typeof this.window.showInactive === 'function') {
                    this.window.showInactive();
                } else {
                    this.window.show();
                }
                this.isShown = true;

                // Re-assert authoritative pin level on presentation
                this._applyAlwaysOnTop();

                // Synchronize authoritative pin state to renderers
                this._syncPinStateToRenderers();

                if (this.window.webContents) {
                    this.window.webContents.send('companion:resized', { width: this.currentWidth, height: this.currentHeight });
                }
                this._notifyMainWindowResized(this.currentWidth, this.currentHeight);

                // Send initial state & play landing arrival
                if (this.companionBridge) {
                    const state = this.companionBridge.getVisualState();
                    this.sendVisualUpdate({ ...state, emotion: 'landing' });
                }
            }
        });

        // Ensure Windows OS restoring or showing reasserts alwaysOnTop
        this.window.on('restore', () => {
            this._applyAlwaysOnTop();
        });
        this.window.on('show', () => {
            this._applyAlwaysOnTop();
        });

        const debouncedSavePosition = this._debounce(() => {
            if (this.window && !this.window.isDestroyed()) {
                try {
                    const [x, y] = this.window.getPosition();
                    this._savePosition(x, y);
                } catch (_) {}
            }
        }, 200);

        this.window.on('resize', () => {
            if (this._isMoving || this._isTemporarySize) {
                return;
            }
            if (this.window && !this.window.isDestroyed()) {
                try {
                    const [w, h] = this._getContentSize();
                    const clampedW = Math.max(FloatingCompanionWindow.MIN_WIDTH, Math.min(FloatingCompanionWindow.MAX_WIDTH, Math.round(w)));
                    const clampedH = Math.max(FloatingCompanionWindow.MIN_HEIGHT, Math.min(FloatingCompanionWindow.MAX_HEIGHT, Math.round(h)));
                    if (Math.abs(clampedW - this.currentWidth) >= 4 || Math.abs(clampedH - this.currentHeight) >= 4) {
                        this.currentWidth = clampedW;
                        this.currentHeight = clampedH;
                        const [x, y] = this.window.getPosition();
                        this._saveBounds(x, y, clampedW, clampedH);
                        if (this.window.webContents) {
                            this.window.webContents.send('companion:resized', { width: clampedW, height: clampedH });
                        }
                        this._notifyMainWindowResized(clampedW, clampedH);
                    }
                } catch (_) {}
            }
        });

        this.window.on('moved', () => {
            debouncedSavePosition();
        });

        // Crash resilience: isolate renderer failure
        this.window.webContents.on('render-process-gone', (_event, details) => {
            console.warn('[FloatingCompanionWindow] Renderer process terminated:', details);
            this.window = null;
            this.isShown = false;
            this._notifyMainWindowState(false);
        });

        this.window.on('closed', () => {
            this.window = null;
            this.isShown = false;
            this._notifyMainWindowState(false);
        });

        return this.window;
    }

    /**
     * Authoritatively apply native window always-on-top level.
     * When pinned, sets topmost level to 'screen-saver' to reliably float above
     * browsers, editors, and other standard desktop applications.
     * When unpinned, resets to 'normal' (standard window stacking order).
     * @returns {{ ok: boolean, isPinned: boolean, error?: string }}
     */
    _applyAlwaysOnTop() {
        if (!this.window || this.window.isDestroyed()) {
            return { ok: true, isPinned: this.isPinned };
        }
        try {
            if (typeof this.window.setAlwaysOnTop === 'function') {
                if (this.isPinned) {
                    this.window.setAlwaysOnTop(true, 'screen-saver');
                } else {
                    this.window.setAlwaysOnTop(false, 'normal');
                }
            }
            let actualPinned = this.isPinned;
            if (typeof this.window.isAlwaysOnTop === 'function') {
                actualPinned = Boolean(this.window.isAlwaysOnTop());
            }
            return { ok: true, isPinned: actualPinned };
        } catch (err) {
            console.error('[FloatingCompanionWindow] Failed to apply always-on-top state:', err);
            return { ok: false, isPinned: this.isPinned, error: err.message };
        }
    }

    _notifyMainWindowPinChanged(isPinned) {
        let targetWin = this.mainWindow;
        if (targetWin && !targetWin.isDestroyed?.() && targetWin.webContents && typeof targetWin.webContents.send === 'function') {
            try {
                targetWin.webContents.send('lucy:companionPinChanged', { isPinned: Boolean(isPinned) });
            } catch (_) {}
        }
    }

    _syncPinStateToRenderers() {
        if (this.window && !this.window.isDestroyed() && this.window.webContents && typeof this.window.webContents.send === 'function') {
            try {
                this.window.webContents.send('companion:pinChanged', { isPinned: this.isPinned });
            } catch (_) {}
        }
        this._notifyMainWindowPinChanged(this.isPinned);
    }

    _notifyMainWindowState(isOpen, details = {}) {
        let targetWin = this.mainWindow;
        if (targetWin && !targetWin.isDestroyed?.() && targetWin.webContents && typeof targetWin.webContents.send === 'function') {
            try {
                targetWin.webContents.send('lucy:companionWindowToggled', { isOpen: Boolean(isOpen), ...details });
            } catch (_) {}
        }
    }

    _notifyMainWindowResized(width, height) {
        let targetWin = this.mainWindow;
        if (targetWin && !targetWin.isDestroyed?.() && targetWin.webContents && typeof targetWin.webContents.send === 'function') {
            try {
                targetWin.webContents.send('lucy:companionResized', { width, height });
            } catch (_) {}
        }
    }

    show(options = {}) {
        if (!this.window || this.window.isDestroyed()) {
            this.createWindow();
        }
        if (this.window && !this.window.isDestroyed()) {
            try {
                if (typeof this.window.setContentSize === 'function') {
                    this.window.setContentSize(this.currentWidth, this.currentHeight);
                } else if (typeof this.window.setSize === 'function') {
                    this.window.setSize(this.currentWidth, this.currentHeight);
                }
            } catch (_) {}

            if (options.activate) {
                this.window.show();
            } else if (typeof this.window.showInactive === 'function') {
                this.window.showInactive();
            } else {
                this.window.show();
            }
            this.isShown = true;
            this._applyAlwaysOnTop();
            this.sendVisualUpdate({ emotion: 'landing' });
            if (this.window.webContents) {
                this.window.webContents.send('companion:resized', { width: this.currentWidth, height: this.currentHeight });
                this.window.webContents.send('companion:visibilityChanged', { isVisible: true });
            }
            this._syncPinStateToRenderers();
            this._notifyMainWindowResized(this.currentWidth, this.currentHeight);
            this._notifyMainWindowState(true);
        }
    }

    hide(options = {}) {
        if (this.window && !this.window.isDestroyed()) {
            try {
                const [x, y] = this.window.getPosition();
                this._savePosition(x, y);
            } catch (_) {}
            try {
                this.window.setAlwaysOnTop(false);
            } catch (_) {}
            if (this.window.webContents) {
                try {
                    this.window.webContents.send('companion:resetState');
                    this.window.webContents.send('companion:visibilityChanged', { isVisible: false });
                } catch (_) {}
            }
            try {
                this.window.hide();
            } catch (_) {}
            this.isShown = false;
            if (!options.suppressNotification) {
                this._notifyMainWindowState(false);
            }
        }
    }

    async toggle() {
        if (this.isShown && this.window && !this.window.isDestroyed()) {
            await this.returnToApp();
            return false;
        } else {
            this.show();
            return true;
        }
    }

    /**
     * Summon floating pet window to the front.
     * Restores window if minimized, unhides if hidden, temporarily raises above
     * other windows so the user can easily find it, and plays a friendly reaction.
     */
    summonToFront() {
        if (!this.window || this.window.isDestroyed()) {
            this.createWindow();
        }
        if (this.window && !this.window.isDestroyed()) {
            if (this.window.isMinimized()) this.window.restore();
            this.window.show();
            this.isShown = true;

            // Ensure coordinates are currently valid on visible display
            try {
                const [x, y] = this.window.getPosition();
                const clamped = this._clampToBounds(x, y, this.currentWidth, this.currentHeight);
                if (clamped.x !== x || clamped.y !== y) {
                    this._updateWindowPosition(clamped.x, clamped.y);
                }
            } catch (_) {}

            // Temporarily set screen-saver level to bring forward over desktop windows
            this.window.setAlwaysOnTop(true, 'screen-saver');
            this.window.focus();

            if (!this.isPinned) {
                setTimeout(() => {
                    if (this.window && !this.window.isDestroyed() && !this.isPinned) {
                        this.window.setAlwaysOnTop(false, 'normal');
                    }
                }, 350);
            }

            this.sendVisualUpdate({
                emotion: 'happy',
                speechBubble: "Sparkle! ✨ I'm right here!"
            });
        }
        return true;
    }

    setPinned(desiredPinned) {
        const targetState = Boolean(desiredPinned);
        const previousState = this.isPinned;
        this.isPinned = targetState;

        if (this.window && !this.window.isDestroyed()) {
            const applied = this._applyAlwaysOnTop();
            if (!applied.ok) {
                // Revert state if applying native always-on-top failed
                this.isPinned = previousState;
                this._syncPinStateToRenderers();
                return this.isPinned;
            }
            this.isPinned = applied.isPinned;
        }

        if (this.lastPosition) {
            this._savePosition(this.lastPosition.x, this.lastPosition.y);
        } else {
            this._saveBounds(100, 100);
        }

        this._syncPinStateToRenderers();
        if (typeof this.onPinChanged === 'function') {
            try {
                this.onPinChanged(this.isPinned);
            } catch (_) {}
        }

        return this.isPinned;
    }

    togglePin() {
        const target = !this.isPinned;
        const result = this.setPinned(target);
        return { ok: result === target, isPinned: this.isPinned };
    }

    getStatus() {
        return {
            isOpen: this.isOpen(),
            isPinned: this.isPinned,
            width: this.currentWidth || FloatingCompanionWindow.DEFAULT_WIDTH,
            height: this.currentHeight || FloatingCompanionWindow.DEFAULT_HEIGHT,
            position: this.lastPosition
        };
    }

    /**
     * Seamless Return Transition:
     * Un-minimizes & focuses main window, hides floating pet, and triggers landing animation in main app.
     */
    async returnToApp() {
        if (this.isRestoring) {
            return { ok: true, inProgress: true };
        }
        this.isRestoring = true;

        try {
            // 1. Immediately hide and unpin floating companion window so it cannot cover mainWindow
            this.hide({ suppressNotification: true });

            // 2. Safely resolve or restore main assistant window
            let targetWin = this.mainWindow;
            if ((!targetWin || targetWin.isDestroyed?.()) && typeof this.onRestoreMainWindow === 'function') {
                targetWin = await this.onRestoreMainWindow();
                this.mainWindow = targetWin;
            }

            if (targetWin && !targetWin.isDestroyed?.()) {
                try {
                    if (typeof targetWin.isMinimized === 'function' && targetWin.isMinimized()) {
                        targetWin.restore();
                    }
                    if (typeof targetWin.isVisible === 'function' && !targetWin.isVisible()) {
                        targetWin.show();
                    }
                    if (typeof targetWin.show === 'function') {
                        targetWin.show();
                    }

                    // Windows OS Focus Guarantee: briefly toggle alwaysOnTop to bring window above any desktop windows
                    try {
                        if (typeof targetWin.setAlwaysOnTop === 'function') {
                            targetWin.setAlwaysOnTop(true);
                            if (typeof targetWin.focus === 'function') targetWin.focus();
                            targetWin.setAlwaysOnTop(false);
                        } else if (typeof targetWin.focus === 'function') {
                            targetWin.focus();
                        }
                    } catch (_) {}

                    if (targetWin.webContents && typeof targetWin.webContents.send === 'function') {
                        targetWin.webContents.send('lucy:companionWindowToggled', { isOpen: false, returning: true });
                    }
                } catch (err) {
                    console.warn('[FloatingCompanionWindow] Error restoring mainWindow:', err.message);
                }
            }

            return { ok: true, restored: true };
        } finally {
            this.isRestoring = false;
        }
    }

    isOpen() {
        return Boolean(this.window && !this.window.isDestroyed() && this.isShown);
    }

    setWindowSize(width, height, isTemporary = false) {
        const rawW = Number(width);
        const rawH = Number(height);
        if (!Number.isFinite(rawW) || !Number.isFinite(rawH)) {
            return false;
        }
        const newW = Math.max(FloatingCompanionWindow.MIN_WIDTH, Math.min(FloatingCompanionWindow.MAX_WIDTH, Math.round(rawW)));
        const newH = Math.max(FloatingCompanionWindow.MIN_HEIGHT, Math.min(FloatingCompanionWindow.MAX_HEIGHT, Math.round(rawH)));
        if (!isTemporary) {
            this.currentWidth = newW;
            this.currentHeight = newH;
            this._isTemporarySize = false;
        } else {
            this._isTemporarySize = true;
        }
        if (this.window && !this.window.isDestroyed()) {
            if (typeof this.window.setContentSize === 'function') {
                this.window.setContentSize(newW, newH);
            } else if (typeof this.window.setSize === 'function') {
                this.window.setSize(newW, newH);
            }
            if (!isTemporary) {
                try {
                    const [x, y] = this.window.getPosition();
                    this._saveBounds(x, y, newW, newH);
                } catch (_) {}
            }
            if (this.window.webContents) {
                this.window.webContents.send('companion:resized', { width: newW, height: newH });
            }
        } else if (!isTemporary) {
            this._saveBounds(this.lastPosition?.x || 100, this.lastPosition?.y || 100, newW, newH);
        }
        if (!isTemporary) {
            this._notifyMainWindowResized(newW, newH);
        }
        return { ok: true, width: newW, height: newH };
    }

    sendVisualUpdate(state) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('companion:visualUpdate', state);
        }
    }

    sendVoiceUpdate(state) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send('companion:voiceUpdate', state);
        }
    }

    _registerIpcHandlers() {
        if (!ipcMain || typeof ipcMain.on !== 'function') {
            return;
        }

        ipcMain.on('companion:moveWindow', (_event, payload) => {
            const validation = validateMoveWindow(payload);
            if (!validation.ok) {
                console.warn('[Security] Dropped invalid moveWindow payload:', validation.error);
                return;
            }
            const { deltaX, deltaY } = validation.sanitized;
            if (this.window && !this.window.isDestroyed()) {
                this._isMoving = true;
                if (this._moveResetTimer) clearTimeout(this._moveResetTimer);
                this._moveResetTimer = setTimeout(() => {
                    this._isMoving = false;
                    this._moveResetTimer = null;
                }, 250);

                const [x, y] = this.window.getPosition();
                const newX = Math.round(x + deltaX);
                const newY = Math.round(y + deltaY);
                this._updateWindowPosition(newX, newY);
            }
        });

        ipcMain.on('companion:focusMainWindow', () => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                if (this.mainWindow.isMinimized()) this.mainWindow.restore();
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        });

        ipcMain.on('companion:toggleMainWindow', () => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                if (this.mainWindow.isVisible()) {
                    this.mainWindow.hide();
                } else {
                    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
                    this.mainWindow.show();
                    this.mainWindow.focus();
                }
            }
        });

        ipcMain.on('companion:closeWindow', () => {
            this.returnToApp();
        });

        ipcMain.handle('companion:returnToApp', async () => {
            return await this.returnToApp();
        });

        ipcMain.handle('companion:togglePin', async () => {
            return this.togglePin();
        });

        ipcMain.handle('companion:getStatus', async () => {
            return { ok: true, ...this.getStatus() };
        });

        ipcMain.handle('companion:summonToFront', async () => {
            this.summonToFront();
            return { ok: true, summoned: true };
        });

        ipcMain.handle('companion:setWindowSize', async (_event, payload = {}) => {
            if (!payload || typeof payload !== 'object') {
                return { ok: false, error: 'Invalid size payload' };
            }
            const isTemp = Boolean(payload.temporary);
            return this.setWindowSize(payload.width, payload.height, isTemp);
        });

        ipcMain.handle('companion:resizeDelta', async (_event, payload = {}) => {
            if (!payload || typeof payload !== 'object') {
                return { ok: false, error: 'Invalid delta payload' };
            }
            const dW = Number(payload.deltaWidth) || 0;
            const dH = Number(payload.deltaHeight) || 0;
            const currentW = this.currentWidth || FloatingCompanionWindow.DEFAULT_WIDTH;
            const currentH = this.currentHeight || FloatingCompanionWindow.DEFAULT_HEIGHT;
            const targetW = currentW + dW;
            const targetH = currentH + dH;
            return this.setWindowSize(targetW, targetH, false);
        });

        ipcMain.handle('companion:playTrick', async (_event, trickName) => {
            const allowedTricks = ['spin', 'jump', 'fly', 'bounce', 'somersault', 'dance', 'pet', 'magic'];
            const trick = String(trickName || '').toLowerCase().trim();
            if (!allowedTricks.includes(trick)) {
                return { ok: false, error: `Unsupported trick: ${trick}` };
            }
            if (this.window && !this.window.isDestroyed()) {
                this.window.webContents.send('companion:playTrick', { trick });
            }
            return { ok: true, trick };
        });

        ipcMain.handle('companion:pet', async (_event, payload = {}) => {
            if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
                this.mainWindow.webContents.send('companion:onPetInteraction', payload);
            }
            if (this.companionBridge) {
                return this.companionBridge.handleUserInteraction('pet', payload);
            }
            return { acknowledged: true };
        });

        ipcMain.handle('companion:magic', async () => {
            if (this.companionBridge) {
                return this.companionBridge.handleUserInteraction('magic');
            }
            return { acknowledged: true };
        });

        ipcMain.handle('companion:submitRequest', async (_event, text) => {
            const validation = validateExecuteRequest(text);
            if (!validation.ok) {
                return { ok: false, code: validation.code, error: validation.error };
            }
            if (this.coordinator) {
                return await this.coordinator.executeRequest(validation.sanitized.userRequest);
            }
            return { ok: false, error: 'Coordinator unavailable' };
        });

        ipcMain.handle('companion:getConfig', async () => {
            return {
                ok: true,
                theme: 'celestial_fairy',
                characterName: 'Lucy Celestial Fairy',
                renderer: 'CelestialFamiliarRenderer'
            };
        });
    }

    destroy() {
        if (this._moveResetTimer) {
            clearTimeout(this._moveResetTimer);
            this._moveResetTimer = null;
        }
        if (screen && typeof screen.removeListener === 'function' && this._onDisplayMetricsChanged) {
            try {
                screen.removeListener('display-metrics-changed', this._onDisplayMetricsChanged);
                screen.removeListener('display-removed', this._onDisplayMetricsChanged);
            } catch (_) {}
        }
        if (this.window && !this.window.isDestroyed()) {
            this.window.destroy();
            this.window = null;
        }
        this.isShown = false;
        this._notifyMainWindowState(false);
        this.mainWindow = null;
        this.onRestoreMainWindow = null;
    }
}

module.exports = {
    FloatingCompanionWindow
};
