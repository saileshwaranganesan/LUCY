'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload Script
 * Secure IPC isolation boundary between Electron main process and UI.
 * Strictly adheres to Least Privilege:
 * NEVER exposes direct node fs, child_process, or unrestricted shell access to renderer.
 */
contextBridge.exposeInMainWorld('lucyIpc', {
    executeRequest: (userRequest, options) => ipcRenderer.invoke('lucy:executeRequest', userRequest, options),
    getSystemStatus: () => ipcRenderer.invoke('lucy:getSystemStatus'),
    getProviderConfig: () => ipcRenderer.invoke('lucy:getProviderConfig'),
    setProviderConfig: (config) => ipcRenderer.invoke('lucy:setProviderConfig', config),
    clearApiKey: (provider) => ipcRenderer.invoke('lucy:clearApiKey', provider),
    onVisualUpdate: (callback) => {
        ipcRenderer.on('lucy:visualUpdate', (_event, data) => callback(data));
    },
    onPermissionRequest: (callback) => {
        ipcRenderer.on('lucy:permissionRequest', (_event, request) => callback(request));
    },
    respondPermission: (auditId, approved) => {
        ipcRenderer.send('lucy:permissionResponse', { auditId, approved });
    },
    // Streaming & Cancellation APIs (REQ-029)
    onStreamChunk: (callback) => {
        ipcRenderer.on('lucy:streamChunk', (_event, data) => callback(data));
    },
    cancelRequest: (taskId) => ipcRenderer.invoke('lucy:cancelRequest', taskId),
    // Multi-Provider & Ollama Discovery APIs (REQ-030 & REQ-031)
    discoverOllamaModels: (endpointUrl) => ipcRenderer.invoke('lucy:discoverOllamaModels', endpointUrl),
    // Memory & Continuity APIs
    getMemories: (options) => ipcRenderer.invoke('lucy:getMemories', options),
    addMemory: (entry) => ipcRenderer.invoke('lucy:addMemory', entry),
    updateMemory: (idOrCategory, maybeKeyOrUpdates, maybeUpdates) => {
        if (maybeUpdates !== undefined) {
            const target = (maybeKeyOrUpdates && typeof maybeKeyOrUpdates === 'string' && maybeKeyOrUpdates.trim())
                ? maybeKeyOrUpdates.trim()
                : idOrCategory;
            return ipcRenderer.invoke('lucy:updateMemory', target, maybeUpdates);
        }
        return ipcRenderer.invoke('lucy:updateMemory', idOrCategory, maybeKeyOrUpdates);
    },
    deleteMemory: (idOrCategory, maybeKey) => {
        const target = (maybeKey && typeof maybeKey === 'string' && maybeKey.trim())
            ? maybeKey.trim()
            : idOrCategory;
        return ipcRenderer.invoke('lucy:deleteMemory', target);
    },
    clearMemoryCategory: (category) => ipcRenderer.invoke('lucy:clearMemoryCategory', category),
    toggleLongTermMemory: (enabled) => ipcRenderer.invoke('lucy:toggleLongTermMemory', enabled),
    getMemorySummary: () => ipcRenderer.invoke('lucy:getMemorySummary'),
    getInterruptedTasks: () => ipcRenderer.invoke('lucy:getInterruptedTasks'),
    inspectTask: (taskId) => ipcRenderer.invoke('lucy:inspectTask', taskId),
    resumeTask: (taskId, options) => ipcRenderer.invoke('lucy:resumeTask', taskId, options),
    discardTask: (taskId) => ipcRenderer.invoke('lucy:discardTask', taskId),
    // Floating 3D Companion APIs
    toggleCompanionWindow: () => ipcRenderer.invoke('lucy:toggleCompanionWindow'),
    getCompanionStatus: () => ipcRenderer.invoke('lucy:getCompanionStatus'),
    sendVoiceState: (voiceData) => ipcRenderer.send('lucy:sendVoiceState', voiceData),
    onCompanionWindowToggled: (callback) => {
        ipcRenderer.on('lucy:companionWindowToggled', (_event, data) => callback(data));
    },
    // Voice Customization & Lifecycle APIs
    getVoiceConfig: () => ipcRenderer.invoke('lucy:getVoiceConfig'),
    setVoiceConfig: (config) => ipcRenderer.invoke('lucy:setVoiceConfig', config)
});
