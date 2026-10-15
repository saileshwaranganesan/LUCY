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
    static DEFAULT_WIDTH = 220;
    static DEFAULT_HEIGHT = 260;

    constructor(options = {}) {
        this.mainWindow = options.mainWindow || null;
        this.companionBridge = options.companionBridge || null;
        this.coordinator = options.coordinator || null;
        this.browserWindowConstructor = options.BrowserWindow || BrowserWindow;
        this.window = null;
        this.isShown = false;
        this.isPinned = true;
        this.currentWidth = FloatingCompanionWindow.DEFAULT_WIDTH;
        this.currentHeight = FloatingCompanionWindow.DEFAULT_HEIGHT;
        this.lastPosition = this._loadSavedBounds();

        this._registerIpcHandlers();
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
        try {
            const { app } = require('electron');
            if (app && typeof app.getPath === 'function') {
                return path.join(app.getPath('userData'), 'companion-window-bounds.json');
            }
        } catch (_) {}
        return null;
    }

    _clampToBounds(x, y, width = FloatingCompanionWindow.DEFAULT_WIDTH, height = FloatingCompanionWindow.DEFAULT_HEIGHT) {
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
                if (data && typeof data.x === 'number' && typeof data.y === 'number') {
                    if (data.isPinned !== undefined) {
                        this.isPinned = Boolean(data.isPinned);
                    }
                    if (typeof data.width === 'number' && typeof data.height === 'number') {
                        this.currentWidth = Math.max(180, Math.min(520, Math.round(data.width)));
                        this.currentHeight = Math.max(220, Math.min(600, Math.round(data.height)));
                    }
                    const clamped = this._clampToBounds(data.x, data.y, this.currentWidth, this.currentHeight);
                    this.lastPosition = clamped;
                    return clamped;
                }
            } catch (_) {}
        }
        return null;
    }

    _loadSavedPosition() {
        return this._loadSavedBounds();
    }

    _saveBounds(x, y, width = this.currentWidth, height = this.currentHeight) {
        this.lastPosition = { x, y };
        this.currentWidth = Math.max(180, Math.min(520, Math.round(width)));
        this.currentHeight = Math.max(220, Math.min(600, Math.round(height)));
        const file = this._getBoundsFile();
        if (file) {
            try {
                fs.writeFileSync(file, JSON.stringify({
                    x,
                    y,
                    width: this.currentWidth,
                    height: this.currentHeight,
                    isPinned: this.isPinned
                }, null, 2), 'utf8');
            } catch (_) {}
        }
    }

    _savePosition(x, y) {
        this._saveBounds(x, y, this.currentWidth, this.currentHeight);
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
            this.window.show();
            this.isShown = true;
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
            minWidth: 180,
            minHeight: 220,
            maxWidth: 520,
            maxHeight: 600,
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
                sandbox: true
            }
        });

        if (this.isPinned) {
            this.window.setAlwaysOnTop(true, 'screen-saver');
        }

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
                this.window.show();
                this.isShown = true;

                // Sync pin state to renderer
                this.window.webContents.send('companion:pinChanged', { isPinned: this.isPinned });

                // Send initial state & play landing arrival
                if (this.companionBridge) {
                    const state = this.companionBridge.getVisualState();
                    this.sendVisualUpdate({ ...state, emotion: 'landing' });
                }
            }
        });

        const debouncedSave = this._debounce(() => {
            if (this.window && !this.window.isDestroyed()) {
                try {
                    const [x, y] = this.window.getPosition();
                    const [w, h] = (typeof this.window.getSize === 'function')
                        ? this.window.getSize()
                        : [this.currentWidth, this.currentHeight];
                    this._saveBounds(x, y, w, h);
                } catch (_) {}
            }
        }, 300);

        this.window.on('resize', () => {
            if (this.window && !this.window.isDestroyed()) {
                try {
                    if (typeof this.window.getSize === 'function') {
                        const [w, h] = this.window.getSize();
                        this.currentWidth = w;
                        this.currentHeight = h;
                        if (this.window.webContents) {
                            this.window.webContents.send('companion:resized', { width: w, height: h });
                        }
                    }
                } catch (_) {}
            }
            debouncedSave();
        });

        this.window.on('moved', () => {
            debouncedSave();
        });

        // Crash resilience: isolate renderer failure
        this.window.webContents.on('render-process-gone', (_event, details) => {
            console.warn('[FloatingCompanionWindow] Renderer process terminated:', details);
            this.window = null;
            this.isShown = false;
        });

        this.window.on('closed', () => {
            this.window = null;
            this.isShown = false;
        });

        return this.window;
    }

    show() {
        if (!this.window || this.window.isDestroyed()) {
            this.createWindow();
        }
        if (this.window && !this.window.isDestroyed()) {
            this.window.show();
            this.isShown = true;
            this.sendVisualUpdate({ emotion: 'landing' });
            if (this.window.webContents) {
                this.window.webContents.send('companion:visibilityChanged', { isVisible: true });
            }
        }
    }

    hide() {
        if (this.window && !this.window.isDestroyed()) {
            try {
                const [x, y] = this.window.getPosition();
                const [w, h] = (typeof this.window.getSize === 'function')
                    ? this.window.getSize()
                    : [this.currentWidth, this.currentHeight];
                this._saveBounds(x, y, w, h);
            } catch (_) {}
            if (this.window.webContents) {
                this.window.webContents.send('companion:visibilityChanged', { isVisible: false });
            }
            this.window.hide();
            this.isShown = false;
        }
    }

    toggle() {
        if (this.isShown && this.window && !this.window.isDestroyed()) {
            return this.returnToApp();
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
                const clamped = this._clampToBounds(x, y);
                if (clamped.x !== x || clamped.y !== y) {
                    this.window.setPosition(clamped.x, clamped.y);
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

    setPinned(isPinned) {
        this.isPinned = Boolean(isPinned);
        if (this.window && !this.window.isDestroyed()) {
            this.window.setAlwaysOnTop(this.isPinned, this.isPinned ? 'screen-saver' : 'normal');
            this.window.webContents.send('companion:pinChanged', { isPinned: this.isPinned });
        }
        if (this.lastPosition) {
            this._savePosition(this.lastPosition.x, this.lastPosition.y);
        }
        return this.isPinned;
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
    returnToApp() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            if (this.mainWindow.isMinimized()) {
                this.mainWindow.restore();
            }
            this.mainWindow.show();
            this.mainWindow.focus();
            this.mainWindow.webContents.send('lucy:companionWindowToggled', { isOpen: false, returning: true });
        }

        this.hide();
        return false;
    }

    isOpen() {
        return Boolean(this.window && !this.window.isDestroyed() && this.isShown);
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
                const [x, y] = this.window.getPosition();
                const newX = Math.round(x + deltaX);
                const newY = Math.round(y + deltaY);
                const clamped = this._clampToBounds(newX, newY, this.currentWidth, this.currentHeight);
                this.window.setPosition(clamped.x, clamped.y);
                this._saveBounds(clamped.x, clamped.y, this.currentWidth, this.currentHeight);
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
            this.returnToApp();
            return { ok: true, returned: true };
        });

        ipcMain.handle('companion:togglePin', async () => {
            const newPin = this.setPinned(!this.isPinned);
            return { ok: true, isPinned: newPin };
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
            const rawW = Number(payload.width);
            const rawH = Number(payload.height);
            if (!Number.isFinite(rawW) || !Number.isFinite(rawH)) {
                return { ok: false, error: 'Non-finite dimensions' };
            }
            const newW = Math.max(180, Math.min(520, Math.round(rawW)));
            const newH = Math.max(220, Math.min(600, Math.round(rawH)));
            this.currentWidth = newW;
            this.currentHeight = newH;
            if (this.window && !this.window.isDestroyed()) {
                if (typeof this.window.setSize === 'function') {
                    this.window.setSize(newW, newH);
                }
                const [x, y] = this.window.getPosition();
                this._saveBounds(x, y, newW, newH);
                if (this.window.webContents) {
                    this.window.webContents.send('companion:resized', { width: newW, height: newH });
                }
            }
            return { ok: true, width: newW, height: newH };
        });

        ipcMain.handle('companion:resizeDelta', async (_event, payload = {}) => {
            if (!payload || typeof payload !== 'object') {
                return { ok: false, error: 'Invalid delta payload' };
            }
            const dW = Number(payload.deltaWidth) || 0;
            const dH = Number(payload.deltaHeight) || 0;
            const newW = Math.max(180, Math.min(520, Math.round((this.currentWidth || 220) + dW)));
            const newH = Math.max(220, Math.min(600, Math.round((this.currentHeight || 260) + dH)));
            this.currentWidth = newW;
            this.currentHeight = newH;
            if (this.window && !this.window.isDestroyed()) {
                if (typeof this.window.setSize === 'function') {
                    this.window.setSize(newW, newH);
                }
                const [x, y] = this.window.getPosition();
                this._saveBounds(x, y, newW, newH);
                if (this.window.webContents) {
                    this.window.webContents.send('companion:resized', { width: newW, height: newH });
                }
            }
            return { ok: true, width: newW, height: newH };
        });

        ipcMain.handle('companion:playTrick', async (_event, trickName) => {
            const allowedTricks = ['spin', 'jump', 'fly', 'bounce', 'pet', 'magic'];
            const trick = String(trickName || '').toLowerCase().trim();
            if (!allowedTricks.includes(trick)) {
                return { ok: false, error: `Unsupported trick: ${trick}` };
            }
            if (this.window && !this.window.isDestroyed()) {
                this.window.webContents.send('companion:playTrick', { trick });
            }
            return { ok: true, trick };
        });

        ipcMain.handle('companion:pet', async () => {
            if (this.companionBridge) {
                return this.companionBridge.handleUserInteraction('pet');
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
        if (this.window && !this.window.isDestroyed()) {
            this.window.destroy();
            this.window = null;
        }
        this.isShown = false;
    }
}

module.exports = {
    FloatingCompanionWindow
};
