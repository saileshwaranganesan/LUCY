'use strict';

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { validateMoveWindow, validateExecuteRequest } = require('../security/ipc-validator.js');

/**
 * FloatingCompanionWindow
 * Manages the transparent, borderless, always-on-top desktop window for L.U.C.Y.'s
 * cute fairy companion.
 * 
 * ARCHITECTURAL MANDATES:
 * 1. ZERO autonomous brain: visual and presentation layer only.
 * 2. Complete crash isolation: failure of companion renderer never crashes core assistant.
 * 3. Secure context isolation: sandbox enabled, nodeIntegration disabled.
 * 4. Seamless transitions: coordinated handoff between embedded interface and desktop.
 */
class FloatingCompanionWindow {
    constructor(options = {}) {
        this.mainWindow = options.mainWindow || null;
        this.companionBridge = options.companionBridge || null;
        this.coordinator = options.coordinator || null;
        this.window = null;
        this.isShown = false;
        this.isPinned = true;
        this.lastPosition = this._loadSavedPosition();

        this._registerIpcHandlers();
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

    _loadSavedPosition() {
        const file = this._getBoundsFile();
        if (file && fs.existsSync(file)) {
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (data && typeof data.x === 'number' && typeof data.y === 'number') {
                    return data;
                }
            } catch (_) {}
        }
        return null;
    }

    _savePosition(x, y) {
        this.lastPosition = { x, y };
        const file = this._getBoundsFile();
        if (file) {
            try {
                fs.writeFileSync(file, JSON.stringify({ x, y }, null, 2), 'utf8');
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
     * Create or restore the floating companion window
     */
    createWindow() {
        if (this.window && !this.window.isDestroyed()) {
            this.window.show();
            this.isShown = true;
            return this.window;
        }

        // Calculate initial default position: bottom-right corner of primary display
        let defaultX = 100;
        let defaultY = 100;
        try {
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
            const winWidth = 320;
            const winHeight = 380;
            defaultX = this.lastPosition ? this.lastPosition.x : Math.max(20, screenWidth - winWidth - 30);
            defaultY = this.lastPosition ? this.lastPosition.y : Math.max(20, screenHeight - winHeight - 30);
        } catch (_) {}

        this.window = new BrowserWindow({
            width: 320,
            height: 380,
            x: defaultX,
            y: defaultY,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            alwaysOnTop: this.isPinned,
            skipTaskbar: true,
            resizable: false,
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

                // Send initial state & play landing arrival
                if (this.companionBridge) {
                    const state = this.companionBridge.getVisualState();
                    this.sendVisualUpdate({ ...state, emotion: 'landing' });
                }
            }
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
        }
    }

    hide() {
        if (this.window && !this.window.isDestroyed()) {
            try {
                const [x, y] = this.window.getPosition();
                this._savePosition(x, y);
            } catch (_) {}
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
                this.window.setPosition(newX, newY);
                this._savePosition(newX, newY);
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
            this.isPinned = !this.isPinned;
            if (this.window && !this.window.isDestroyed()) {
                this.window.setAlwaysOnTop(this.isPinned, this.isPinned ? 'screen-saver' : 'normal');
            }
            return { ok: true, isPinned: this.isPinned };
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
    }
}

module.exports = {
    FloatingCompanionWindow
};
