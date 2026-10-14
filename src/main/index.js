'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

const fs = require('fs');
const os = require('os');

const { TaskCoordinator } = require('../core/task-coordinator.js');
const { TaskStatusManager } = require('../core/task-status.js');
const { ToolRegistry } = require('../tools/tool-registry.js');
const { PermissionAuthority, PERMISSION_MODES } = require('../security/permission-authority.js');
const { CredentialStore } = require('../security/credential-store.js');
const { ProviderAdapter } = require('../providers/provider-adapter.js');
const { CompanionBridge } = require('../companion/companion-bridge.js');
const { registerFileTools } = require('../tools/file-tools.js');
const { registerSystemTools } = require('../tools/system-tools.js');
const { BrowserManager } = require('../tools/browser-manager.js');
const { registerBrowserTools } = require('../tools/browser-tools.js');
const { DesktopAutomationManager } = require('../tools/desktop-automation-manager.js');
const { registerDesktopTools } = require('../tools/desktop-app-tools.js');
const { registerVisualTools } = require('../tools/visual-tools.js');
const { registerMemoryTools } = require('../tools/memory-tools.js');
const { FloatingCompanionWindow } = require('../companion/floating-companion-window.js');
const { MemoryStore } = require('../memory/memory-store.js');
const { TaskContinuityStore } = require('../memory/task-continuity-store.js');
const { Scheduler } = require('../core/scheduler.js');
const { StudentWorkflows } = require('../workflows/student-workflows.js');
const { registerStudentWorkflowTools } = require('../tools/student-workflow-tools.js');
const { WhisperOfflineRecognitionEngine } = require('../voice/whisper-recognition.js');
const {
    validateExecuteRequest,
    validateSetProviderConfig,
    validateClearApiKey,
    validatePermissionResponse,
    validateGetMemories,
    validateAddMemory,
    validateIdentifier,
    validateClearMemoryCategory,
    validateSendVoiceState,
    validateDiscoverOllamaModels,
    validateCancelRequest,
    validateVoiceConfig,
    validateTranscribeAudioRequest
} = require('../security/ipc-validator.js');

// SEC-004: Single-Instance Application Lock
// Acquired immediately before initializing persistent storage or state.
const gotSingleInstanceLock = (app && typeof app.requestSingleInstanceLock === 'function')
    ? app.requestSingleInstanceLock()
    : true;

if (!gotSingleInstanceLock) {
    console.warn('[L.U.C.Y. Process] Another instance of L.U.C.Y. is already running. Exiting secondary process safely.');
    if (app && typeof app.exit === 'function') {
        try { app.exit(0); } catch (_) {}
    }
    process.exit(0);
} else {
    if (app && typeof app.on === 'function') {
        app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
            console.info('[L.U.C.Y. Process] Second instance launch attempt detected. Restoring and focusing existing window.');
            if (mainWindow) {
                if (mainWindow.isMinimized()) {
                    mainWindow.restore();
                }
                if (!mainWindow.isVisible()) {
                    mainWindow.show();
                }
                mainWindow.focus();
            }
        });
    }
}

let mainWindow = null;
let coordinator = null;
let permissionAuthority = null;
let companionBridge = null;
let credStore = null;
let browserManager = null;
let desktopManager = null;
let floatingCompanion = null;
let voiceConfigFile = null;
let memoryStore = null;
let scheduler = null;
let studentWorkflows = null;
let whisperEngine = null;
const pendingPermissionCallbacks = new Map();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1080,
        height: 740,
        minWidth: 900,
        minHeight: 600,
        frame: true,
        backgroundColor: '#070913',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));

    // Restrict navigation: prevent privileged renderer from navigating to external/untrusted URLs
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        try {
            const parsed = new URL(navigationUrl);
            if (parsed.protocol !== 'file:') {
                event.preventDefault();
            }
        } catch {
            event.preventDefault();
        }
    });

    // Deny creation of auxiliary windows from renderer (clickjacking & popup defense)
    mainWindow.webContents.setWindowOpenHandler(() => {
        return { action: 'deny' };
    });

    if (process.env.LUCY_SMOKE_TEST === 'true') {
        mainWindow.webContents.once('did-finish-load', () => {
            console.log('LUCY_ELECTRON_SMOKE_TEST: UI loaded cleanly, terminating smoke run.');
            setTimeout(() => {
                if (mainWindow) mainWindow.close();
                app.quit();
            }, 500);
        });
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (floatingCompanion) {
            try { floatingCompanion.destroy(); } catch (_) {}
        }
        for (const [auditId, resolve] of pendingPermissionCallbacks.entries()) {
            try { resolve(false); } catch (_) {}
        }
        pendingPermissionCallbacks.clear();
    });

    if (floatingCompanion) {
        floatingCompanion.setMainWindow(mainWindow);
    }
}

function initAssistantBackend() {
    const isPackaged = Boolean(app && app.isPackaged);
    const userDataDir = (app && typeof app.getPath === 'function')
        ? app.getPath('userData')
        : path.join(process.env.APPDATA || os.homedir(), 'LUCY');

    voiceConfigFile = path.join(userDataDir, 'voice-config.json');

    const memoryDir = isPackaged
        ? path.join(userDataDir, 'memory')
        : (process.env.LUCY_MEMORY_DIR || path.resolve(__dirname, '../../data/memory'));

    const secureStoreDir = path.join(process.env.APPDATA || os.homedir(), 'LUCY', 'secure');

    const workspaceRoot = process.env.LUCY_WORKSPACE_DIR || (
        isPackaged
            ? path.join(userDataDir, 'workspace')
            : path.resolve(__dirname, '../../')
    );

    if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
    }
    if (!fs.existsSync(secureStoreDir)) {
        fs.mkdirSync(secureStoreDir, { recursive: true });
    }
    if (!fs.existsSync(workspaceRoot)) {
        fs.mkdirSync(workspaceRoot, { recursive: true });
    }

    credStore = new CredentialStore({ storeDir: secureStoreDir });
    permissionAuthority = new PermissionAuthority({
        mode: process.env.LUCY_PERMISSION_MODE || PERMISSION_MODES.STANDARD,
        workspaceRoot
    });

    // Confirmation handler binds interactive prompts to Electron window
    permissionAuthority.setConfirmationHandler((req) => {
        return new Promise((resolve) => {
            pendingPermissionCallbacks.set(req.auditId, resolve);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('lucy:permissionRequest', req);
            } else {
                resolve(false); // Fail closed if window is unavailable
            }
        });
    });

    const toolRegistry = new ToolRegistry({ permissionAuthority });
    registerFileTools(toolRegistry, permissionAuthority.workspaceRoot);
    registerSystemTools(toolRegistry);

    browserManager = new BrowserManager({ workspaceRoot: permissionAuthority.workspaceRoot });
    registerBrowserTools(toolRegistry, browserManager);

    desktopManager = new DesktopAutomationManager();
    registerDesktopTools(toolRegistry, desktopManager);

    const providerAdapter = new ProviderAdapter({
        credentialStore: credStore
    });
    registerVisualTools(toolRegistry, { providerAdapter, browserManager, desktopManager });

    const statusManager = new TaskStatusManager();
    companionBridge = new CompanionBridge();

    memoryStore = new MemoryStore({ memoryDir });
    registerMemoryTools(toolRegistry, memoryStore);
    const taskContinuityStore = new TaskContinuityStore({ storeDir: memoryDir });
    memoryStore.initSqlite().then(() => {
        if (memoryStore.sqliteAdapter) {
            taskContinuityStore.setSqliteAdapter(memoryStore.sqliteAdapter);
        }
    }).catch((err) => {
        console.warn('[Main] SQLite memory initialization error, continuing with JSON:', err.message);
    });

    coordinator = new TaskCoordinator({
        statusManager,
        permissionAuthority,
        toolRegistry,
        providerAdapter,
        memoryStore,
        taskContinuityStore
    });
    coordinator.setCompanionBridge(companionBridge);

    scheduler = new Scheduler({
        storageDir: memoryDir,
        taskCoordinator: coordinator,
        permissionAuthority
    });
    studentWorkflows = new StudentWorkflows({
        browserManager,
        workspaceRoot: permissionAuthority.workspaceRoot,
        scheduler,
        permissionAuthority
    });
    registerStudentWorkflowTools(toolRegistry, studentWorkflows, scheduler);
    scheduler.start();

    floatingCompanion = new FloatingCompanionWindow({
        mainWindow,
        companionBridge,
        coordinator
    });

    whisperEngine = new WhisperOfflineRecognitionEngine();

    // Forward visual updates from companion bridge to renderer & floating companion
    companionBridge.on('visualUpdate', (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('lucy:visualUpdate', state);
        }
        if (floatingCompanion) {
            floatingCompanion.sendVisualUpdate(state);
        }
    });

    // Forward task execution lifecycle events to UI activity & status feed
    statusManager.on('stateChanged', (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('lucy:taskLifecycleEvent', event);
            } catch (_) {}
        }
    });
}

// IPC Handlers with Centralized Schema & Type Validation (SEC-008 & REQ-029)
ipcMain.handle('lucy:executeRequest', async (event, userRequest, options = {}) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateExecuteRequest(userRequest, options);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: `Invalid request payload: ${validation.error}` };
    }
    const sender = event.sender;
    const execOptions = {
        ...validation.sanitized.options,
        onChunk: ({ delta, accumulatedText, done }) => {
            if (sender && !sender.isDestroyed()) {
                sender.send('lucy:streamChunk', {
                    delta,
                    accumulatedText,
                    done
                });
            }
        }
    };
    return await coordinator.executeRequest(validation.sanitized.userRequest, execOptions);
});

ipcMain.handle('lucy:cancelRequest', async (_event, taskId) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateCancelRequest(taskId);
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    return coordinator.cancelTask(idValidation.sanitized);
});

ipcMain.handle('lucy:discoverOllamaModels', async (_event, endpointUrl) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateDiscoverOllamaModels(endpointUrl);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    return await coordinator.providerAdapter.discoverOllamaModels(validation.sanitized);
});

ipcMain.handle('lucy:getSystemStatus', async () => {
    if (!coordinator) return { ok: false };
    const provider = coordinator.providerAdapter.provider;
    const hasKey = Boolean(coordinator.providerAdapter.resolveApiKey(provider));
    return {
        ok: true,
        provider,
        model: coordinator.providerAdapter.model,
        permissionMode: permissionAuthority ? permissionAuthority.mode : 'standard',
        workspaceRoot: permissionAuthority ? permissionAuthority.workspaceRoot : process.cwd(),
        hasKey
    };
});

ipcMain.handle('lucy:getProviderConfig', async () => {
    if (!coordinator || !credStore) return { ok: false };
    const provider = coordinator.providerAdapter.provider;
    const model = coordinator.providerAdapter.model;
    const localBaseUrl = coordinator.providerAdapter.localBaseUrl;
    const customOpenAiUrl = coordinator.providerAdapter.customOpenAiUrl;
    const huggingFaceUrl = coordinator.providerAdapter.huggingFaceUrl;
    const hasKey = Boolean(coordinator.providerAdapter.resolveApiKey(provider));
    const configuredKeys = credStore.listConfiguredKeys().map((k) => k.key);
    return {
        ok: true,
        provider,
        model,
        localBaseUrl,
        customOpenAiUrl,
        huggingFaceUrl,
        hasKey,
        configuredKeys
    };
});

ipcMain.handle('lucy:setProviderConfig', async (_event, config = {}) => {
    if (!coordinator || !credStore) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateSetProviderConfig(config);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: `Invalid provider configuration: ${validation.error}` };
    }
    const { provider, model, apiKey, localBaseUrl, customOpenAiUrl, huggingFaceUrl } = config;
    if (provider) {
        coordinator.providerAdapter.setProvider(provider, model);
    }
    if (localBaseUrl) {
        coordinator.providerAdapter.setLocalBaseUrl(localBaseUrl);
    }
    if (customOpenAiUrl !== undefined) {
        coordinator.providerAdapter.setCustomOpenAiUrl(customOpenAiUrl);
    }
    if (huggingFaceUrl !== undefined) {
        coordinator.providerAdapter.setHuggingFaceUrl(huggingFaceUrl);
    }
    if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
        const keyName = `${provider || coordinator.providerAdapter.provider}_api_key`;
        credStore.setSecret(keyName, apiKey.trim());
    }
    const currentProvider = coordinator.providerAdapter.provider;
    const hasKey = Boolean(coordinator.providerAdapter.resolveApiKey(currentProvider));
    return {
        ok: true,
        provider: currentProvider,
        model: coordinator.providerAdapter.model,
        hasKey
    };
});

ipcMain.handle('lucy:clearApiKey', async (_event, provider) => {
    if (!credStore || !coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateClearApiKey(provider);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    const targetProvider = provider || coordinator.providerAdapter.provider;
    const keyName = `${targetProvider}_api_key`;
    credStore.deleteSecret(keyName);
    const hasKey = Boolean(coordinator.providerAdapter.resolveApiKey(targetProvider));
    return { ok: true, hasKey };
});

ipcMain.on('lucy:permissionResponse', (_event, rawPayload) => {
    const validation = validatePermissionResponse(rawPayload);
    if (!validation.ok) {
        console.warn('[Security] Dropped invalid permission response:', validation.error);
        return;
    }
    const { auditId, approved } = validation.sanitized;
    const callback = pendingPermissionCallbacks.get(auditId);
    if (callback) {
        pendingPermissionCallbacks.delete(auditId);
        callback(Boolean(approved));
    } else {
        // Late response after timeout or cancellation: safely ignored, cannot revive request
        console.info(`[Security] Ignored expired or duplicate permission response for auditId: ${auditId}`);
    }
});

// Memory & Continuity IPC Handlers
ipcMain.handle('lucy:getMemories', async (_event, options) => {
    if (!coordinator) return { ok: false, memories: [] };
    const validation = validateGetMemories(options);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error, memories: [] };
    }
    try {
        const list = coordinator.getMemories(validation.sanitized);
        return { ok: true, memories: list };
    } catch (err) {
        return { ok: false, error: err.message, memories: [] };
    }
});

ipcMain.handle('lucy:addMemory', async (_event, entry) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateAddMemory(entry);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const mem = coordinator.addMemory(entry);
        return { ok: true, memory: mem };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:updateMemory', async (_event, idOrKey, updates) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateIdentifier(idOrKey, 'Memory identifier');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    const updatePayload = typeof updates === 'string'
        ? { content: updates }
        : updates;
    if (typeof updatePayload !== 'object' || updatePayload === null || Array.isArray(updatePayload)) {
        return { ok: false, code: 'INVALID_UPDATES', error: 'Memory updates must be an object or string content.' };
    }
    try {
        const mem = coordinator.updateMemory(idValidation.sanitized, updatePayload);
        return { ok: true, memory: mem };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:deleteMemory', async (_event, idOrKey) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateIdentifier(idOrKey, 'Memory identifier');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    try {
        const result = coordinator.deleteMemory(idValidation.sanitized);
        if (!result) {
            return { ok: false, code: 'NOT_FOUND', error: `Memory record '${idValidation.sanitized}' was not found.` };
        }
        return { ok: true, deleted: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:clearMemoryCategory', async (_event, category) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateClearMemoryCategory(category);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const result = coordinator.clearCategory(validation.sanitized);
        return { ok: true, ...result };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:toggleLongTermMemory', async (_event, enabled) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    if (typeof enabled !== 'boolean' && enabled !== undefined) {
        return { ok: false, code: 'INVALID_TYPE', error: 'Enabled parameter must be a boolean.' };
    }
    try {
        const result = coordinator.toggleLongTermMemory(Boolean(enabled));
        return { ok: true, longTermEnabled: result };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:getMemorySummary', async () => {
    if (!coordinator) return { ok: false, totalCount: 0, longTermEnabled: false, categories: {} };
    try {
        const summary = coordinator.getMemorySummary();
        return { ok: true, ...summary };
    } catch (err) {
        return { ok: false, error: err.message, totalCount: 0, longTermEnabled: false, categories: {} };
    }
});

ipcMain.handle('lucy:getInterruptedTasks', async () => {
    if (!coordinator) return { ok: false, interruptedTasks: [] };
    try {
        const tasks = coordinator.getInterruptedTasks();
        return { ok: true, interruptedTasks: tasks };
    } catch (err) {
        return { ok: false, error: err.message, interruptedTasks: [] };
    }
});

ipcMain.handle('lucy:inspectTask', async (_event, taskId) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateIdentifier(taskId, 'Task ID');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    try {
        const inspection = coordinator.inspectTask(idValidation.sanitized);
        return { ok: true, ...inspection };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:resumeTask', async (_event, taskId, options) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateIdentifier(taskId, 'Task ID');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
        return { ok: false, code: 'INVALID_OPTIONS', error: 'Task resume options must be a plain object.' };
    }
    try {
        const result = await coordinator.resumeTask(idValidation.sanitized, options);
        return result;
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:discardTask', async (_event, taskId) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateIdentifier(taskId, 'Task ID');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    try {
        const result = coordinator.discardTask(idValidation.sanitized);
        if (!result) {
            return { ok: false, code: 'NOT_FOUND', error: `Task checkpoint '${idValidation.sanitized}' was not found.` };
        }
        return { ok: true, discarded: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Floating Fairy Companion IPC Handlers
ipcMain.handle('lucy:toggleCompanionWindow', async (_event, options = {}) => {
    if (!floatingCompanion) return { ok: false, isOpen: false };
    if (options && options.action === 'float') {
        floatingCompanion.show();
        return { ok: true, isOpen: true };
    }
    if (options && options.action === 'dock') {
        floatingCompanion.returnToApp();
        return { ok: true, isOpen: false };
    }
    const isOpen = floatingCompanion.toggle();
    return { ok: true, isOpen };
});

ipcMain.handle('lucy:getCompanionStatus', async () => {
    if (!floatingCompanion) return { ok: false, isOpen: false };
    return { ok: true, isOpen: floatingCompanion.isOpen() };
});

ipcMain.on('lucy:sendVoiceState', (_event, voiceData) => {
    const validation = validateSendVoiceState(voiceData);
    if (!validation.ok) {
        console.warn('[Security] Dropped invalid voice state IPC:', validation.error);
        return;
    }
    if (floatingCompanion) {
        floatingCompanion.sendVoiceUpdate(voiceData);
    }
});

// Voice Customization & Lifecycle IPC Handlers
ipcMain.handle('lucy:getVoiceConfig', async () => {
    const defaults = {
        pitch: 1.05,
        rate: 1.02,
        volume: 1.0,
        voiceName: '',
        preferredVoiceName: '',
        ttsEnabled: true,
        wakeWordEnabled: false,
        wakeWordSensitivity: 0.5
    };
    if (!voiceConfigFile || !fs.existsSync(voiceConfigFile)) {
        return { ok: true, config: defaults };
    }
    try {
        const raw = fs.readFileSync(voiceConfigFile, 'utf8');
        const parsed = JSON.parse(raw);
        return { ok: true, config: { ...defaults, ...parsed } };
    } catch {
        return { ok: true, config: defaults };
    }
});

ipcMain.handle('lucy:setVoiceConfig', async (_event, config = {}) => {
    const validation = validateVoiceConfig(config);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: `Invalid voice configuration: ${validation.error}` };
    }
    let merged = {
        pitch: 1.05,
        rate: 1.02,
        volume: 1.0,
        voiceName: '',
        preferredVoiceName: '',
        ttsEnabled: true,
        wakeWordEnabled: false,
        wakeWordSensitivity: 0.5
    };
    if (config.resetToDefaults !== true && voiceConfigFile && fs.existsSync(voiceConfigFile)) {
        try {
            merged = { ...merged, ...JSON.parse(fs.readFileSync(voiceConfigFile, 'utf8')) };
        } catch {}
    }
    merged = { ...merged, ...validation.sanitized };
    delete merged.resetToDefaults;
    if (voiceConfigFile) {
        try {
            fs.mkdirSync(path.dirname(voiceConfigFile), { recursive: true });
            fs.writeFileSync(voiceConfigFile, JSON.stringify(merged, null, 2), 'utf8');
        } catch (err) {
            console.warn('[Voice] Failed to persist voice config to disk:', err.message);
        }
    }
    return { ok: true, config: merged };
});

// Offline Speech Recognition IPC Handlers (REQ-027)
ipcMain.handle('lucy:getWhisperStatus', async () => {
    if (!whisperEngine) {
        return { engine: 'whisper.cpp', isAvailable: false, message: 'Whisper engine not initialized in main process' };
    }
    return whisperEngine.getStatus();
});

ipcMain.handle('lucy:transcribeAudio', async (_event, audioData, options = {}) => {
    if (!whisperEngine) {
        return { ok: false, transcript: '', error: 'Whisper engine not initialized in main process' };
    }
    const validation = validateTranscribeAudioRequest(audioData, options);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    return await whisperEngine.transcribeAudio(
        validation.sanitized.audioBuffer,
        validation.sanitized.options
    );
});

if (gotSingleInstanceLock && app && typeof app.whenReady === 'function') {
    app.whenReady().then(() => {
        // Safely allow microphone capture for local assistant UI without unhandled prompt crashes
        if (session && session.defaultSession) {
            session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
                if (permission === 'media' || permission === 'audio-capture') {
                    callback(true);
                    return;
                }
                callback(false);
            });
        }

        initAssistantBackend();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('before-quit', async () => {
        // Fail-closed all pending permission confirmations
        for (const [auditId, resolve] of pendingPermissionCallbacks.entries()) {
            try { resolve(false); } catch (_) {}
        }
        pendingPermissionCallbacks.clear();
        if (permissionAuthority) {
            permissionAuthority.cancelAllPendingConfirmations('Application shutting down');
        }
        if (browserManager) {
            await browserManager.closeAll().catch(() => {});
        }
        if (desktopManager) {
            desktopManager.cleanup();
        }
        if (scheduler) {
            scheduler.dispose();
        }
        if (floatingCompanion) {
            floatingCompanion.destroy();
        }
        if (memoryStore) {
            memoryStore.close();
        }
    });
}
