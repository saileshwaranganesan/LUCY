'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Companion Preload Script
 * Secure IPC isolation boundary for the Desktop Floating Fairy Companion window.
 * Strictly adheres to Least Privilege:
 * NEVER exposes direct node fs, child_process, or unrestricted shell access.
 */
contextBridge.exposeInMainWorld('companionIpc', {
    // Listeners for updates from main process / task coordinator
    onVisualUpdate: (callback) => {
        ipcRenderer.on('companion:visualUpdate', (_event, data) => callback(data));
    },
    onVoiceUpdate: (callback) => {
        ipcRenderer.on('companion:voiceUpdate', (_event, data) => callback(data));
    },
    onPinChanged: (callback) => {
        ipcRenderer.on('companion:pinChanged', (_event, data) => callback(data));
    },
    onResized: (callback) => {
        ipcRenderer.on('companion:resized', (_event, data) => callback(data));
    },
    onVisibilityChanged: (callback) => {
        ipcRenderer.on('companion:visibilityChanged', (_event, data) => callback(data));
    },
    onPlayTrick: (callback) => {
        ipcRenderer.on('companion:playTrick', (_event, data) => callback(data));
    },

    // Window controls
    moveWindow: (deltaX, deltaY) => {
        ipcRenderer.send('companion:moveWindow', { deltaX, deltaY });
    },
    setWindowSize: (width, height) => {
        return ipcRenderer.invoke('companion:setWindowSize', { width, height });
    },
    resizeDelta: (deltaWidth, deltaHeight) => {
        return ipcRenderer.invoke('companion:resizeDelta', { deltaWidth, deltaHeight });
    },
    focusMainWindow: () => {
        ipcRenderer.send('companion:focusMainWindow');
    },
    toggleMainWindow: () => {
        ipcRenderer.send('companion:toggleMainWindow');
    },
    closeCompanionWindow: () => {
        ipcRenderer.send('companion:closeWindow');
    },
    returnToApp: () => {
        return ipcRenderer.invoke('companion:returnToApp');
    },
    togglePin: () => {
        return ipcRenderer.invoke('companion:togglePin');
    },
    getStatus: () => {
        return ipcRenderer.invoke('companion:getStatus');
    },

    // Companion interactions (routed strictly through central task coordinator)
    petCompanion: () => {
        return ipcRenderer.invoke('companion:pet');
    },
    magicCompanion: () => {
        return ipcRenderer.invoke('companion:magic');
    },
    playTrick: (trick) => {
        return ipcRenderer.invoke('companion:playTrick', trick);
    },
    submitRequest: (text) => {
        return ipcRenderer.invoke('companion:submitRequest', text);
    },
    getCompanionConfig: () => {
        return ipcRenderer.invoke('companion:getConfig');
    }
});
