'use strict';

const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage } = require('electron');
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
const { KokoroTtsService } = require('../voice/kokoro-tts-service.js');
const { SkillRegistry } = require('../tools/skill-registry.js');
const { PluginManager } = require('../tools/plugin-manager.js');
const { createResearchSkill } = require('../workflows/research-skill.js');
const { createDocumentSkill } = require('../workflows/document-skill.js');
const { ConnectionManager } = require('../providers/connection-manager.js');
const { ModelCatalogue } = require('../providers/model-catalogue.js');
const { ModelRouter } = require('../providers/model-router.js');
const {
    validateExecuteRequest,
    validateSetProviderConfig,
    validateClearApiKey,
    validatePermissionResponse,
    validateGetMemories,
    validateAddMemory,
    validateIdentifier,
    validateClearMemoryCategory,
    validateProjectSnapshot,
    validateSupersedeMemory,
    validateImportMemory,
    validateSendVoiceState,
    validateDiscoverOllamaModels,
    validateCancelRequest,
    validateVoiceConfig,
    validateCompanionDimensions,
    validateTranscribeAudioRequest,
    validateSetAppSettings,
    validateSaveConnection,
    validateUpdateConnection,
    validateDeleteConnection,
    validateTestConnection,
    validateSetRoutingConfig,
    ALLOWED_ROUTING_MODES
} = require('../security/ipc-validator.js');

const {
    ApplicationLifecycleManager,
    LIFECYCLE_STATES,
    CLOSE_ACTIONS
} = require('../core/application-lifecycle.js');

// Early CLI argument parsing for user-data-dir and remote-debugging-port
if (Array.isArray(process.argv)) {
    for (const arg of process.argv) {
        if (typeof arg === 'string' && arg.startsWith('--user-data-dir=')) {
            const customUserData = arg.slice('--user-data-dir='.length).trim();
            if (customUserData && app && typeof app.setPath === 'function') {
                try { app.setPath('userData', customUserData); } catch (_) {}
            }
        }
        if (typeof arg === 'string' && arg.startsWith('--remote-debugging-port=')) {
            const customPort = arg.slice('--remote-debugging-port='.length).trim();
            if (customPort && app && app.commandLine) {
                try { app.commandLine.appendSwitch('remote-debugging-port', customPort); } catch (_) {}
            }
        }
    }
}

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
        app.on('second-instance', async (_event, _commandLine, _workingDirectory) => {
            console.info('[L.U.C.Y. Process] Second instance launch attempt detected. Restoring and focusing existing window.');
            await restoreOrRecreateMainWindow();
        });
    }
}

if (app && app.commandLine) {
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

let mainWindow = null;
let coordinator = null;
let permissionAuthority = null;
let companionBridge = null;
let credStore = null;
let connectionManager = null;
let modelCatalogue = null;
let modelRouter = null;
let browserManager = null;
let desktopManager = null;
let floatingCompanion = null;
let voiceConfigFile = null;
let memoryStore = null;
let scheduler = null;
let studentWorkflows = null;
let whisperEngine = null;
let kokoroTtsService = null;
let toolRegistry = null;
let skillRegistry = null;
let pluginManager = null;
let tray = null;
let isExplicitQuitting = false;
let appConfigFile = null;
let appSettings = {
    backgroundMode: true,
    closeAction: 'background',
    closeToTray: true,
    backgroundListening: false,
    startMinimized: false
};
const pendingPermissionCallbacks = new Map();

const lifecycleManager = new ApplicationLifecycleManager();
lifecycleManager.on('stateChanged', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send('lucy:lifecycleStateChanged', data);
        } catch (_) {}
    }
    if (floatingCompanion && floatingCompanion.window && !floatingCompanion.window.isDestroyed()) {
        try {
            floatingCompanion.window.webContents.send('companion:lifecycleStateChanged', data);
        } catch (_) {}
    }
    updateTrayMenu();
});

async function restoreOrRecreateMainWindow() {
    return await lifecycleManager.restoreMainWindow(async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            return mainWindow;
        }
        createWindow();
        return mainWindow;
    });
}

function getTrayIcon() {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            const dx = Math.abs(x - 7.5);
            const dy = Math.abs(y - 7.5);
            const dist = Math.sqrt(dx * dx + dy * dy);
            const starCross = (dx < 1.6 && dy < 6.5) || (dy < 1.6 && dx < 6.5);
            const core = dist < 2.2;
            const halo = dist < 5.5;

            if (core) {
                buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255; buf[idx + 3] = 255;
            } else if (starCross) {
                buf[idx] = 179; buf[idx + 1] = 136; buf[idx + 2] = 255; buf[idx + 3] = 245;
            } else if (halo) {
                buf[idx] = 128; buf[idx + 1] = 216; buf[idx + 2] = 255;
                buf[idx + 3] = Math.max(0, Math.floor(180 - dist * 32));
            } else {
                buf[idx] = 0; buf[idx + 1] = 0; buf[idx + 2] = 0; buf[idx + 3] = 0;
            }
        }
    }
    return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function updateTrayMenu() {
    if (!tray || tray.isDestroyed()) return;
    const isMainVisible = mainWindow ? (mainWindow.isVisible() && !mainWindow.isMinimized()) : false;
    const isCompanionOpen = floatingCompanion ? floatingCompanion.isOpen() : false;
    const isPinned = floatingCompanion ? floatingCompanion.isPinned : true;
    const currentState = lifecycleManager ? lifecycleManager.getState() : 'unknown';

    const stateDisplayNames = {
        starting: 'Starting Up...',
        main_window_visible: 'Main Window Active',
        companion_only: 'Fairy Companion Active',
        background_tray: 'Running in Background (Tray)',
        restoring: 'Restoring Window...',
        shutting_down: 'Shutting Down...',
        stopped: 'Stopped'
    };
    const stateLabel = stateDisplayNames[currentState] || `State: ${currentState}`;

    const template = [
        {
            label: isMainVisible ? 'Hide Main Window' : 'Open L.U.C.Y.',
            click: async () => {
                if (isMainVisible) {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.hide();
                    }
                    if (floatingCompanion && floatingCompanion.isOpen()) {
                        lifecycleManager.transitionTo(LIFECYCLE_STATES.COMPANION_ONLY, { trigger: 'tray_hide_main' });
                    } else {
                        lifecycleManager.transitionTo(LIFECYCLE_STATES.BACKGROUND_TRAY, { trigger: 'tray_hide_main' });
                    }
                    updateTrayMenu();
                } else {
                    await restoreOrRecreateMainWindow();
                    updateTrayMenu();
                }
            }
        },
        {
            label: isCompanionOpen ? 'Hide Floating Fairy' : 'Show Floating Fairy',
            click: () => {
                if (floatingCompanion) {
                    if (isCompanionOpen) {
                        floatingCompanion.hide();
                    } else {
                        floatingCompanion.show();
                        floatingCompanion.summonToFront();
                    }
                    const mainVis = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
                    if (!mainVis) {
                        lifecycleManager.transitionTo(
                            floatingCompanion.isOpen() ? LIFECYCLE_STATES.COMPANION_ONLY : LIFECYCLE_STATES.BACKGROUND_TRAY,
                            { trigger: 'tray_toggle_companion' }
                        );
                    }
                    updateTrayMenu();
                }
            }
        },
        {
            label: 'Pin Fairy to Top',
            type: 'checkbox',
            checked: isPinned,
            click: (item) => {
                if (floatingCompanion) {
                    floatingCompanion.setPinned(item.checked);
                    updateTrayMenu();
                }
            }
        },
        { type: 'separator' },
        {
            label: `Status: ${stateLabel}`,
            enabled: false
        },
        {
            label: 'Settings',
            click: async () => {
                const win = await restoreOrRecreateMainWindow();
                if (win && win.webContents && !win.isDestroyed()) {
                    win.webContents.send('lucy:openSettings');
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Exit L.U.C.Y.',
            click: async () => {
                isExplicitQuitting = true;
                await lifecycleManager.performCleanShutdown({ trigger: 'tray_exit' });
            }
        }
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
}

function initTray() {
    if (tray && !tray.isDestroyed()) return tray;
    try {
        const icon = getTrayIcon();
        tray = new Tray(icon);
        tray.setToolTip('L.U.C.Y. — Desktop Assistant & Celestial Fairy');

        tray.on('click', async () => {
            await restoreOrRecreateMainWindow();
            updateTrayMenu();
        });

        tray.on('double-click', async () => {
            await restoreOrRecreateMainWindow();
            updateTrayMenu();
        });

        lifecycleManager.registerService('tray', tray);
        updateTrayMenu();
    } catch (err) {
        console.warn('[Tray] Failed to initialize system tray:', err.message);
    }
    return tray;
}

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
            sandbox: true,
            autoplayPolicy: 'no-user-gesture-required',
            backgroundThrottling: false
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
                isExplicitQuitting = true;
                if (mainWindow) mainWindow.close();
                app.quit();
            }, 500);
        });
    }

    // Intercept main-window close: follow configured close action via ApplicationLifecycleManager
    mainWindow.on('close', (event) => {
        if (isExplicitQuitting || lifecycleManager.isShuttingDown) {
            return;
        }
        lifecycleManager.handleMainWindowClose(event, mainWindow, floatingCompanion, appSettings);
        updateTrayMenu();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        lifecycleManager.unregisterService('mainWindow');
        if (floatingCompanion) {
            floatingCompanion.setMainWindow(null);
        }
        for (const [auditId, resolve] of pendingPermissionCallbacks.entries()) {
            try { resolve(false); } catch (_) {}
        }
        pendingPermissionCallbacks.clear();
        updateTrayMenu();
    });

    lifecycleManager.registerService('mainWindow', mainWindow);
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
    appConfigFile = path.join(userDataDir, 'app-config.json');
    try {
        if (fs.existsSync(appConfigFile)) {
            const saved = JSON.parse(fs.readFileSync(appConfigFile, 'utf8'));
            if (saved && typeof saved === 'object') {
                appSettings = { ...appSettings, ...saved };
                if (saved.closeAction) {
                    appSettings.backgroundMode = saved.closeAction !== CLOSE_ACTIONS.EXIT;
                } else if (typeof saved.backgroundMode === 'boolean') {
                    appSettings.closeAction = saved.backgroundMode ? CLOSE_ACTIONS.BACKGROUND : CLOSE_ACTIONS.EXIT;
                }
            }
        }
    } catch (_) {}

    const isInsideAsar = typeof __dirname === 'string' && __dirname.includes('.asar');
    const isPackagedApp = isPackaged || isInsideAsar;

    const memoryDir = isPackagedApp
        ? path.join(userDataDir, 'memory')
        : (process.env.LUCY_MEMORY_DIR || path.resolve(__dirname, '../../data/memory'));

    const secureStoreDir = process.env.LUCY_SECURE_STORE_DIR || path.join(process.env.APPDATA || os.homedir(), 'LUCY', 'secure');

    const workspaceRoot = process.env.LUCY_WORKSPACE_DIR || (
        isPackagedApp
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

    toolRegistry = new ToolRegistry({ permissionAuthority });
    registerFileTools(toolRegistry, permissionAuthority.workspaceRoot);
    registerSystemTools(toolRegistry);

    browserManager = new BrowserManager({ workspaceRoot: permissionAuthority.workspaceRoot });
    registerBrowserTools(toolRegistry, browserManager);

    desktopManager = new DesktopAutomationManager();
    registerDesktopTools(toolRegistry, desktopManager);

    const providerAdapter = new ProviderAdapter({
        credentialStore: credStore
    });

    connectionManager = new ConnectionManager({
        configDir: memoryDir,
        credentialStore: credStore
    });
    connectionManager.init();

    modelCatalogue = new ModelCatalogue({
        configDir: memoryDir
    });

    modelRouter = new ModelRouter({
        providerAdapter,
        connectionManager,
        modelCatalogue,
        configDir: memoryDir
    });

    providerAdapter.setModelRouter(modelRouter);
    providerAdapter.setConnectionManager(connectionManager);

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

    skillRegistry = new SkillRegistry({ toolRegistry, permissionAuthority });
    try {
        skillRegistry.registerSkill(createResearchSkill());
        skillRegistry.registerSkill(createDocumentSkill());
    } catch (e) {
        console.warn('[Main] Warning registering built-in skills:', e.message);
    }

    pluginManager = new PluginManager({ toolRegistry, skillRegistry, permissionAuthority });

    coordinator = new TaskCoordinator({
        statusManager,
        permissionAuthority,
        toolRegistry,
        skillRegistry,
        pluginManager,
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
        coordinator,
        onRestoreMainWindow: restoreOrRecreateMainWindow,
        onPinChanged: () => {
            updateTrayMenu();
        }
    });

    whisperEngine = new WhisperOfflineRecognitionEngine();
    kokoroTtsService = new KokoroTtsService({ threads: 6 });

    lifecycleManager.registerService('coordinator', coordinator);
    lifecycleManager.registerService('skillRegistry', skillRegistry);
    lifecycleManager.registerService('pluginManager', pluginManager);
    lifecycleManager.registerService('desktopManager', desktopManager);
    lifecycleManager.registerService('kokoro', kokoroTtsService);
    lifecycleManager.registerService('whisper', whisperEngine);
    lifecycleManager.registerService('browserManager', browserManager);
    lifecycleManager.registerService('scheduler', scheduler);
    lifecycleManager.registerService('memoryStore', memoryStore);
    lifecycleManager.registerService('permissionAuthority', permissionAuthority);
    lifecycleManager.registerService('floatingCompanion', floatingCompanion);
    lifecycleManager.registerService('app', app);

    // Pre-warm local Kokoro TTS worker in background only if configured engine is Kokoro
    let startupTtsEngine = 'kokoro';
    try {
        if (voiceConfigFile && fs.existsSync(voiceConfigFile)) {
            const persistedVoice = JSON.parse(fs.readFileSync(voiceConfigFile, 'utf8'));
            if (persistedVoice && persistedVoice.ttsEngine) {
                startupTtsEngine = persistedVoice.ttsEngine;
            }
        }
    } catch (_) {}

    if (startupTtsEngine !== 'windows-speech' && kokoroTtsService && typeof kokoroTtsService.loadModel === 'function' && kokoroTtsService.isAvailable()) {
        setTimeout(() => {
            kokoroTtsService.loadModel().catch((err) => {
                logger.warn(`Kokoro pre-warming non-critical warning: ${err.message}`);
            });
        }, 1500);
    }

    // Forward visual updates from companion bridge to renderer & floating companion
    companionBridge.on('visualUpdate', (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('lucy:visualUpdate', state);
        }
        if (floatingCompanion) {
            floatingCompanion.sendVisualUpdate(state);
        }
    });

    // Forward task execution lifecycle events to UI activity & status feed, companion bridge & floating companion
    statusManager.on('stateChanged', (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('lucy:taskLifecycleEvent', event);
            } catch (_) {}
        }
        if (companionBridge && typeof companionBridge.handleStateEvent === 'function') {
            try {
                companionBridge.handleStateEvent(event);
            } catch (_) {}
        }
        if (floatingCompanion && typeof floatingCompanion.sendTaskUpdate === 'function') {
            try {
                floatingCompanion.sendTaskUpdate(event);
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
    const rawResult = await coordinator.executeRequest(validation.sanitized.userRequest, execOptions);
    try {
        return JSON.parse(JSON.stringify(rawResult));
    } catch (_) {
        return rawResult;
    }
});

ipcMain.handle('lucy:cancelRequest', async (_event, taskId) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateCancelRequest(taskId);
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    return coordinator.cancelTask(idValidation.sanitized);
});

// Capability System IPC Handlers (REQ-CAPABILITY-IPC)
ipcMain.handle('lucy:listTools', async () => {
    if (!toolRegistry) return [];
    return toolRegistry.listTools();
});

ipcMain.handle('lucy:listSkills', async () => {
    if (!skillRegistry) return [];
    return skillRegistry.listSkills();
});

ipcMain.handle('lucy:executeSkill', async (_event, skillId, params = {}, options = {}) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idVal = validateIdentifier(skillId, 'skillId');
    if (!idVal.ok) return { ok: false, code: idVal.code, error: idVal.error };
    const safeParams = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
    const safeOptions = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
    return await coordinator.executeSkill(idVal.sanitized, safeParams, safeOptions);
});

ipcMain.handle('lucy:listPlugins', async () => {
    if (!pluginManager) return [];
    return pluginManager.listPlugins();
});

ipcMain.handle('lucy:enablePlugin', async (_event, pluginId) => {
    if (!pluginManager) return { ok: false, error: 'PluginManager not initialized' };
    const idVal = validateIdentifier(pluginId, 'pluginId');
    if (!idVal.ok) return { ok: false, code: idVal.code, error: idVal.error };
    return await pluginManager.enablePlugin(idVal.sanitized);
});

ipcMain.handle('lucy:disablePlugin', async (_event, pluginId) => {
    if (!pluginManager) return { ok: false, error: 'PluginManager not initialized' };
    const idVal = validateIdentifier(pluginId, 'pluginId');
    if (!idVal.ok) return { ok: false, code: idVal.code, error: idVal.error };
    return await pluginManager.disablePlugin(idVal.sanitized);
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
    const lastRoute = modelRouter ? modelRouter.getLastUsedRoute() : null;

    let connectionState = 'not_configured';
    let hasValidCredentials = false;
    let activeConnection = null;

    if (connectionManager) {
        const conns = connectionManager.listConnections().filter((c) => c.enabled);
        if (conns.length > 0) {
            activeConnection = (lastRoute?.connectionId ? conns.find((c) => c.id === lastRoute.connectionId) : null)
                || conns.find((c) => c.provider === provider)
                || conns[0];
            if (activeConnection) {
                connectionState = activeConnection.state || (activeConnection.hasKey ? 'unverified' : 'not_configured');
                hasValidCredentials = activeConnection.state === 'connected';
            }
        }
    }

    return {
        ok: true,
        provider: lastRoute ? lastRoute.provider : provider,
        model: lastRoute ? lastRoute.model : coordinator.providerAdapter.model,
        connectionLabel: lastRoute ? lastRoute.connectionLabel : (activeConnection?.label || null),
        connectionState,
        hasValidCredentials,
        routingMode: modelRouter ? modelRouter.mode : 'auto',
        permissionMode: permissionAuthority ? permissionAuthority.mode : 'standard',
        workspaceRoot: permissionAuthority ? permissionAuthority.workspaceRoot : process.cwd(),
        hasKey
    };
});

// Multi-Provider & Model Orchestration IPC Handlers
ipcMain.handle('lucy:getConnectionList', async () => {
    if (!connectionManager) return { ok: false, error: 'ConnectionManager not initialized' };
    try {
        const connections = connectionManager.listSanitizedConnections();
        return { ok: true, connections };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:saveConnection', async (_event, payload = {}) => {
    if (!connectionManager) return { ok: false, error: 'ConnectionManager not initialized' };
    const validation = validateSaveConnection(payload);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const saved = connectionManager.saveConnection(validation.sanitized);
        return { ok: true, connection: saved };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:updateConnection', async (_event, payload = {}) => {
    if (!connectionManager) return { ok: false, error: 'ConnectionManager not initialized' };
    const validation = validateUpdateConnection(payload);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const updated = connectionManager.updateConnection(validation.sanitized.id, validation.sanitized);
        return { ok: true, connection: updated };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:deleteConnection', async (_event, payload) => {
    if (!connectionManager) return { ok: false, error: 'ConnectionManager not initialized' };
    const validation = validateDeleteConnection(payload);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const deleted = connectionManager.deleteConnection(validation.sanitized.id);
        return { ok: true, deleted };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:testConnection', async (_event, payload) => {
    if (!connectionManager || !coordinator) return { ok: false, error: 'Provider services not initialized' };
    const validation = validateTestConnection(payload);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const result = await connectionManager.testConnection(validation.sanitized.id, coordinator.providerAdapter);
        return result;
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:getRoutingConfig', async () => {
    if (!modelRouter) return { ok: false, error: 'ModelRouter not initialized' };
    return {
        ok: true,
        config: modelRouter.getConfig(),
        routingModes: Array.from(ALLOWED_ROUTING_MODES),
        recentRoute: modelRouter.getLastUsedRoute()
    };
});

ipcMain.handle('lucy:setRoutingConfig', async (_event, config = {}) => {
    if (!modelRouter) return { ok: false, error: 'ModelRouter not initialized' };
    const validation = validateSetRoutingConfig(config);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const updated = modelRouter.setConfig(validation.sanitized);
        return { ok: true, config: updated };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:getModelCatalogue', async () => {
    if (!modelCatalogue) return { ok: false, error: 'ModelCatalogue not initialized' };
    return {
        ok: true,
        models: modelCatalogue.listModels(),
        providers: modelCatalogue.listProviders()
    };
});

ipcMain.handle('lucy:getRoutingDiagnostics', async () => {
    if (!modelRouter) return { ok: false, error: 'ModelRouter not initialized' };
    return {
        ok: true,
        events: modelRouter.getDiagnostics(),
        lastRoute: modelRouter.getLastUsedRoute()
    };
});

ipcMain.handle('lucy:getLocalResourceStatus', async () => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const adapter = coordinator.providerAdapter;
    const availability = await adapter.checkLocalServiceAvailability();
    const loaded = await adapter.getLoadedModels();
    return {
        ok: true,
        available: availability.ok,
        version: availability.version,
        endpoint: availability.endpoint || adapter.localBaseUrl,
        loadedModels: loaded.models || [],
        count: loaded.count || 0
    };
});

ipcMain.handle('lucy:unloadLocalModel', async (_event, modelName) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    if (!modelName || typeof modelName !== 'string') {
        return { ok: false, error: 'Invalid model name' };
    }
    return await coordinator.providerAdapter.unloadModel(modelName.trim());
});

ipcMain.handle('lucy:getUsageAccounting', async () => {
    if (!modelRouter) return { ok: false, error: 'ModelRouter not initialized' };
    return {
        ok: true,
        usage: modelRouter.getUsageAccounting()
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
        if (connectionManager) {
            const targetProv = provider || coordinator.providerAdapter.provider;
            const conns = connectionManager.listConnections();
            for (const c of conns) {
                if (c.provider === targetProv) {
                    c.state = 'unverified';
                    c.lastTestedAt = null;
                    c.lastError = null;
                }
            }
            connectionManager._saveConnections();
        }
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
    if (connectionManager) {
        const conns = connectionManager.listConnections();
        for (const c of conns) {
            if (c.provider === targetProvider) {
                credStore.deleteSecret(`conn_${c.id}_key`);
                c.state = 'not_configured';
                c.lastTestedAt = null;
                c.lastError = null;
            }
        }
        connectionManager._saveConnections();
    }
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

ipcMain.handle('lucy:exportMemory', async () => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    try {
        const exportData = coordinator.exportMemory();
        return { ok: true, data: exportData };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:importMemory', async (_event, payload, options) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateImportMemory(payload);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const result = coordinator.importMemory(validation.sanitized, options);
        return { ok: true, ...result };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:createMemoryBackup', async () => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    try {
        const backupResult = coordinator.createMemoryBackup();
        return { ok: true, ...backupResult };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:restoreMemoryBackup', async (_event, backupPath) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateIdentifier(backupPath, 'Backup path');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    try {
        const restoreResult = coordinator.restoreMemoryBackup(idValidation.sanitized);
        return { ok: true, ...restoreResult };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:saveProjectSnapshot', async (_event, snapshot) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateProjectSnapshot(snapshot);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const saved = coordinator.saveProjectSnapshot(validation.sanitized.projectId, validation.sanitized);
        return { ok: true, snapshot: saved };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:getProjectSnapshot', async (_event, projectId) => {
    if (!coordinator) return { ok: false, snapshot: null };
    const idValidation = validateIdentifier(projectId, 'Project identifier');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error, snapshot: null };
    }
    try {
        const snapshot = coordinator.getProjectSnapshot(idValidation.sanitized);
        return { ok: true, snapshot };
    } catch (err) {
        return { ok: false, error: err.message, snapshot: null };
    }
});

ipcMain.handle('lucy:listProjects', async () => {
    if (!coordinator) return { ok: false, projects: [] };
    try {
        const list = coordinator.listProjects();
        return { ok: true, projects: list };
    } catch (err) {
        return { ok: false, error: err.message, projects: [] };
    }
});

ipcMain.handle('lucy:deleteProjectSnapshot', async (_event, projectId) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const idValidation = validateIdentifier(projectId, 'Project identifier');
    if (!idValidation.ok) {
        return { ok: false, code: idValidation.code, error: idValidation.error };
    }
    try {
        const deleted = coordinator.deleteProjectSnapshot(idValidation.sanitized);
        return { ok: true, deleted };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:supersedeMemory', async (_event, payload) => {
    if (!coordinator) return { ok: false, error: 'Coordinator not initialized' };
    const validation = validateSupersedeMemory(payload);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    try {
        const result = coordinator.supersedeMemory(validation.sanitized.oldIdOrKey, validation.sanitized.newEntry);
        return { ok: true, ...result };
    } catch (err) {
        return { ok: false, error: err.message };
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
        await floatingCompanion.returnToApp();
        return { ok: true, isOpen: false };
    }
    const isOpen = await floatingCompanion.toggle();
    return { ok: true, isOpen: Boolean(isOpen) };
});

ipcMain.handle('lucy:summonCompanionWindow', async () => {
    if (!floatingCompanion) return { ok: false, summoned: false };
    floatingCompanion.summonToFront();
    return { ok: true, summoned: true, isOpen: true };
});

ipcMain.handle('lucy:setCompanionPin', async (_event, isPinned) => {
    if (!floatingCompanion) return { ok: false, isPinned: false };
    const res = floatingCompanion.setPinned(isPinned);
    const pinned = typeof res === 'object' && res !== null ? Boolean(res.isPinned) : Boolean(res);
    updateTrayMenu();
    return { ok: true, isPinned: pinned };
});

ipcMain.handle('lucy:getCompanionStatus', async () => {
    if (!floatingCompanion) return { ok: false, isOpen: false, isPinned: true };
    return { ok: true, ...floatingCompanion.getStatus() };
});

ipcMain.handle('lucy:playCompanionTrick', async (_event, trick) => {
    const allowedTricks = ['spin', 'jump', 'fly', 'bounce', 'somersault', 'dance', 'pet', 'magic'];
    const sanitized = String(trick || '').toLowerCase().trim();
    if (!allowedTricks.includes(sanitized)) {
        return { ok: false, error: `Invalid trick: ${sanitized}` };
    }
    if (floatingCompanion && floatingCompanion.window && !floatingCompanion.window.isDestroyed()) {
        floatingCompanion.window.webContents.send('companion:playTrick', { trick: sanitized });
    }
    return { ok: true, trick: sanitized };
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
        ttsEngine: 'kokoro',
        kokoroVoice: 'af_bella',
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
        ttsEngine: 'kokoro',
        kokoroVoice: 'af_bella',
        wakeWordEnabled: false,
        wakeWordSensitivity: 0.5,
        continuousConversation: true,
        bargeInEnabled: true,
        vadSensitivity: 'normal'
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

// Local Kokoro-82M Neural Speech Synthesis IPC Handlers
ipcMain.handle('lucy:getKokoroStatus', async () => {
    if (!kokoroTtsService) {
        return { isAvailable: false, isLoaded: false, voices: [] };
    }
    return {
        isAvailable: kokoroTtsService.isAvailable(),
        isLoaded: kokoroTtsService.isLoaded,
        voices: ['af_bella', 'af_sky'],
        defaultVoice: kokoroTtsService.voiceName,
        memory: kokoroTtsService.lastMemoryInfo || null
    };
});

ipcMain.handle('lucy:synthesizeSpeech', async (_event, text, options = {}) => {
    if (!kokoroTtsService) {
        return { ok: false, error: 'Kokoro TTS service not initialized' };
    }
    if (!text || typeof text !== 'string') {
        return { ok: false, error: 'Text is required for speech synthesis' };
    }
    try {
        const rawRate = options.rate !== undefined ? options.rate : (options.speed !== undefined ? options.speed : 1.0);
        const pitch = options.pitch !== undefined ? options.pitch : 1.0;
        const effectiveSpeed = Math.max(0.5, Math.min(2.0, (pitch && pitch > 0.1) ? (rawRate / pitch) : rawRate));

        if (!kokoroTtsService.isLoaded) {
            const loaded = await kokoroTtsService.loadModel();
            if (!loaded) {
                return { ok: false, error: 'Failed to load Kokoro-82M TTS model' };
            }
        }

        const res = await kokoroTtsService._sendCommand({
            cmd: 'synthesize',
            text: text.slice(0, 2000),
            voice: options.voice || kokoroTtsService.voiceName || 'af_bella',
            speed: effectiveSpeed,
            lang: options.lang || 'en-us'
        });
        if (res.status === 'ok') {
            return {
                ok: true,
                audio: res.audio,
                duration_s: res.duration_s,
                latency_ms: res.latency_ms,
                rtf: res.rtf,
                voice: res.voice
            };
        } else {
            return { ok: false, error: res.error || 'Synthesis error' };
        }
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('lucy:stopKokoroSpeech', async () => {
    if (kokoroTtsService) {
        kokoroTtsService.stop();
    }
    return { ok: true };
});

ipcMain.handle('lucy:setCompanionDimensions', async (_event, dims = {}) => {
    const validation = validateCompanionDimensions(dims);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    const { width, height } = validation.sanitized;
    if (floatingCompanion) {
        const result = floatingCompanion.setWindowSize(width, height, false);
        if (result && result.ok) {
            return { ok: true, width: result.width, height: result.height };
        }
    }
    return { ok: true, width, height };
});

// Persistent Background Runtime & Lifecycle IPC Handlers
ipcMain.handle('lucy:getLifecycleState', async () => {
    return {
        ok: true,
        currentState: lifecycleManager.getState(),
        history: lifecycleManager.getStateHistory()
    };
});

ipcMain.handle('lucy:getAppSettings', async () => {
    return { ok: true, settings: { ...appSettings } };
});

ipcMain.handle('lucy:setAppSettings', async (_event, updates = {}) => {
    const validation = validateSetAppSettings(updates);
    if (!validation.ok) {
        return { ok: false, code: validation.code, error: validation.error };
    }
    const sanitized = validation.sanitized;
    if (sanitized.backgroundMode !== undefined) appSettings.backgroundMode = sanitized.backgroundMode;
    if (sanitized.closeAction !== undefined) appSettings.closeAction = sanitized.closeAction;
    if (sanitized.closeToTray !== undefined) appSettings.closeToTray = sanitized.closeToTray;
    if (sanitized.backgroundListening !== undefined) appSettings.backgroundListening = sanitized.backgroundListening;
    if (sanitized.startMinimized !== undefined) appSettings.startMinimized = sanitized.startMinimized;

    if (sanitized.closeAction) {
        appSettings.backgroundMode = sanitized.closeAction !== CLOSE_ACTIONS.EXIT;
    } else if (sanitized.backgroundMode !== undefined) {
        appSettings.closeAction = sanitized.backgroundMode ? CLOSE_ACTIONS.BACKGROUND : CLOSE_ACTIONS.EXIT;
    }

    try {
        if (appConfigFile) {
            fs.writeFileSync(appConfigFile, JSON.stringify(appSettings, null, 2), 'utf8');
        }
    } catch (err) {
        console.warn('[Settings] Failed to save app-config.json:', err.message);
    }
    updateTrayMenu();
    return { ok: true, settings: { ...appSettings } };
});

ipcMain.handle('lucy:exitApp', async () => {
    isExplicitQuitting = true;
    await lifecycleManager.performCleanShutdown({ trigger: 'ipc_exit' });
    return { ok: true };
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
            session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
                return permission === 'media' || permission === 'audio-capture';
            });
        }

        initAssistantBackend();
        createWindow();
        initTray();
        lifecycleManager.transitionTo(LIFECYCLE_STATES.MAIN_WINDOW_VISIBLE, { trigger: 'app_ready' });

        app.on('activate', async () => {
            await restoreOrRecreateMainWindow();
            updateTrayMenu();
        });
    });

    app.on('window-all-closed', () => {
        const closeAction = appSettings.closeAction || (appSettings.backgroundMode ? CLOSE_ACTIONS.BACKGROUND : CLOSE_ACTIONS.EXIT);
        if (isExplicitQuitting || closeAction === CLOSE_ACTIONS.EXIT || process.platform === 'darwin') {
            lifecycleManager.performCleanShutdown({ trigger: 'all_windows_closed' });
        }
    });

    app.on('before-quit', async () => {
        isExplicitQuitting = true;
        await lifecycleManager.performCleanShutdown({ trigger: 'before_quit' });
    });
}
