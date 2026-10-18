'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('L.U.C.Y. Repair 10: Unified Settings Center Architecture & Consolidation Suite', async (suite) => {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const htmlPath = path.join(projectRoot, 'src', 'ui', 'index.html');
    const cssPath = path.join(projectRoot, 'src', 'ui', 'style.css');
    const appJsPath = path.join(projectRoot, 'src', 'ui', 'app.js');

    assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
    assert.ok(fs.existsSync(cssPath), 'style.css must exist');
    assert.ok(fs.existsSync(appJsPath), 'app.js must exist');

    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    const appJsContent = fs.readFileSync(appJsPath, 'utf8');

    await suite.test('1. Single Canonical Settings Entry Point in HTML Navigation Deck', () => {
        // Authoritative Settings tab in the JARVIS deck
        assert.ok(htmlContent.includes('id="tabNavSettings"'), 'Authoritative tabNavSettings must exist');
        assert.ok(htmlContent.includes('data-view="viewSettings"'), 'tabNavSettings must target canonical viewSettings');

        // Sidebar and HUD buttons
        assert.ok(htmlContent.includes('id="sidebarSettingsBtn"'), 'Sidebar Settings Center button must exist');
        assert.ok(htmlContent.includes('id="hudSettingsBtn"'), 'HUD settings button must exist');

        // Canonical Settings view section
        assert.ok(htmlContent.includes('<section class="jarvis-view" id="viewSettings"'), 'Canonical viewSettings section must exist');

        // Backwards compatibility for existing tests checking viewCompanionSettings
        assert.ok(htmlContent.includes('id="viewCompanionSettings"'), 'viewCompanionSettings ID must be preserved for legacy test suite');
        assert.ok(htmlContent.includes('data-view="viewCompanionSettings"'), 'data-view="viewCompanionSettings" must be preserved for test suite compatibility');
    });

    await suite.test('2. Retired Settings Modal is cleanly decommissioned without duplicate forms', () => {
        // Old modal must be hidden/retired
        assert.ok(htmlContent.includes('id="settingsModal"'), 'settingsModal ID preserved as compatibility stub');
        assert.ok(htmlContent.includes('display: none !important'), 'settingsModal must be decommissioned with display: none !important');
        assert.ok(htmlContent.includes('pointer-events: none'), 'settingsModal must not intercept pointer events');
    });

    await suite.test('3. Exactly 8 Canonical Settings Categories Exist with Matching Tab Buttons and Panes', () => {
        const canonicalTabs = [
            'general',
            'companion',
            'voice',
            'ai',
            'handsfree',
            'memory',
            'automation',
            'about'
        ];

        canonicalTabs.forEach((tab) => {
            // Check tab button
            const btnRegex = new RegExp(`class="settings-center-tab-btn[^"]*".*?data-settings-tab="${tab}"`, 's');
            assert.ok(btnRegex.test(htmlContent), `Tab button for [${tab}] must exist in settings-center-tabs`);

            // Check pane
            const paneRegex = new RegExp(`class="settings-center-pane[^"]*".*?data-settings-tab="${tab}"`, 's');
            assert.ok(paneRegex.test(htmlContent), `Content pane for [${tab}] must exist in settings-center-viewport`);
        });

        // Specific canonical pane IDs
        assert.ok(htmlContent.includes('id="paneGeneral"'), 'paneGeneral exists');
        assert.ok(htmlContent.includes('id="paneCompanion"'), 'paneCompanion exists');
        assert.ok(htmlContent.includes('id="paneVoice"'), 'paneVoice exists');
        assert.ok(htmlContent.includes('id="paneAi"'), 'paneAi exists');
        assert.ok(htmlContent.includes('id="paneHandsfree"'), 'paneHandsfree exists');
        assert.ok(htmlContent.includes('id="paneMemory"'), 'paneMemory exists');
        assert.ok(htmlContent.includes('id="paneAutomation"'), 'paneAutomation exists');
        assert.ok(htmlContent.includes('id="paneAbout"'), 'paneAbout exists');
    });

    await suite.test('4. General Tab: Single canonical location for close action, background listening, lifecycle', () => {
        assert.ok(htmlContent.includes('id="settingCloseAction"'), 'settingCloseAction exists in General pane');
        assert.ok(htmlContent.includes('id="closeActionTag"'), 'closeActionTag exists in General pane');
        assert.ok(htmlContent.includes('id="checkBackgroundListening"'), 'checkBackgroundListening exists in General pane');
        assert.ok(htmlContent.includes('id="lifecycleStateBadge"'), 'lifecycleStateBadge exists in General pane');
        assert.ok(htmlContent.includes('id="btnExplicitExitCompanion"'), 'btnExplicitExitCompanion exists in General pane');
    });

    await suite.test('5. Companion Tab: Single canonical location for floating dimensions, presets, stunts, pin', () => {
        assert.ok(htmlContent.includes('id="sliderCompanionWidth"'), 'sliderCompanionWidth exists in Companion pane');
        assert.ok(htmlContent.includes('id="sliderCompanionHeight"'), 'sliderCompanionHeight exists in Companion pane');
        assert.ok(htmlContent.includes('id="companionDimensionsLabel"'), 'companionDimensionsLabel exists in Companion pane');
        assert.ok(htmlContent.includes('id="btnResetTinyPet"'), 'btnResetTinyPet preset exists in Companion pane');
        assert.ok(htmlContent.includes('id="btnMediumPet"'), 'btnMediumPet preset exists in Companion pane');
        assert.ok(htmlContent.includes('id="settingsToggleFloatBtn"'), 'settingsToggleFloatBtn exists in Companion pane');
        assert.ok(htmlContent.includes('id="checkCompanionPinned"'), 'checkCompanionPinned exists in Companion pane');
        assert.ok(htmlContent.includes('data-trick="spin"'), 'Spin stunt button exists');
        assert.ok(htmlContent.includes('data-trick="jump"'), 'Jump stunt button exists');
        assert.ok(htmlContent.includes('data-trick="fly"'), 'Fly stunt button exists');
    });

    await suite.test('6. Voice & Audio Tab: Dual-engine support with Kokoro-82M and Windows Speech SAPI5', () => {
        assert.ok(htmlContent.includes('id="settingsTtsEngineSelect"'), 'settingsTtsEngineSelect exists in Voice pane');
        assert.ok(htmlContent.includes('id="kokoroPersonaContainer"'), 'kokoroPersonaContainer exists for local Kokoro voices');
        assert.ok(htmlContent.includes('id="settingsKokoroVoiceSelect"'), 'settingsKokoroVoiceSelect exists for Bella/Sky');
        assert.ok(htmlContent.includes('id="sapi5VoiceContainer"'), 'sapi5VoiceContainer exists for Windows SAPI5 voices');
        assert.ok(htmlContent.includes('id="settingVoiceSelect"'), 'settingVoiceSelect exists');
        assert.ok(htmlContent.includes('id="sliderVoiceRate"'), 'sliderVoiceRate exists');
        assert.ok(htmlContent.includes('id="sliderVoicePitch"'), 'sliderVoicePitch exists');
        assert.ok(htmlContent.includes('id="sliderVoiceVolume"'), 'sliderVoiceVolume exists');
        assert.ok(htmlContent.includes('id="rateLabelVal"'), 'rateLabelVal readout exists');
        assert.ok(htmlContent.includes('id="pitchLabelVal"'), 'pitchLabelVal readout exists');
        assert.ok(htmlContent.includes('id="volumeLabelVal"'), 'volumeLabelVal readout exists');
        assert.ok(htmlContent.includes('id="btnTestFairyVoice"'), 'btnTestFairyVoice audition button exists');
        assert.ok(htmlContent.includes('id="resetVoiceDefaultsBtn"'), 'resetVoiceDefaultsBtn exists');
    });

    await suite.test('7. AI & Models Tab: Multi-provider connections, routing policy, and diagnostics sub-tabs', () => {
        // Sub-tabs
        assert.ok(htmlContent.includes('data-ai-sub="connections"'), 'Connections sub-tab exists');
        assert.ok(htmlContent.includes('data-ai-sub="routing"'), 'Routing sub-tab exists');
        assert.ok(htmlContent.includes('data-ai-sub="diagnostics"'), 'Diagnostics sub-tab exists');

        // Connections elements
        assert.ok(htmlContent.includes('id="connectionsListContainer"'), 'connectionsListContainer exists');
        assert.ok(htmlContent.includes('id="showAddConnBtn"'), 'showAddConnBtn exists');
        assert.ok(htmlContent.includes('id="saveConnBtn"'), 'saveConnBtn exists');

        // Routing elements
        assert.ok(htmlContent.includes('id="routingModeSelect"'), 'routingModeSelect exists');
        assert.ok(htmlContent.includes('id="saveRoutingConfigBtn"'), 'saveRoutingConfigBtn exists');

        // Diagnostics elements
        assert.ok(htmlContent.includes('id="refreshDiagnosticsBtn"'), 'refreshDiagnosticsBtn exists');
        assert.ok(htmlContent.includes('id="diagnosticsFeed"'), 'diagnosticsFeed exists');
    });

    await suite.test('8. Hands-Free Tab: Local wake-word activation, continuous conversation, and VAD endpointing', () => {
        assert.ok(htmlContent.includes('id="checkWakeWordActive"'), 'checkWakeWordActive exists in Hands-Free pane');
        assert.ok(htmlContent.includes('id="wakeWordStatusBadge"'), 'wakeWordStatusBadge exists');
        assert.ok(htmlContent.includes('id="settingWakeWordSensitivity"'), 'settingWakeWordSensitivity slider exists');
        assert.ok(htmlContent.includes('id="wakeWordSensitivityVal"'), 'wakeWordSensitivityVal readout exists');
        assert.ok(htmlContent.includes('id="settingContinuousConversation"'), 'settingContinuousConversation exists');
        assert.ok(htmlContent.includes('id="settingBargeInEnabled"'), 'settingBargeInEnabled exists');
        assert.ok(htmlContent.includes('id="settingVadSensitivity"'), 'settingVadSensitivity exists');
    });

    await suite.test('9. Memory & Automation Tabs: Long-term retention, modal bridge, automation mode, and dry-run sync', () => {
        // Memory Tab
        assert.ok(htmlContent.includes('id="btnOpenMemoryVaultModal"'), 'btnOpenMemoryVaultModal exists to bridge into detailed vault');
        assert.ok(htmlContent.includes('id="settingsToggleLongTerm"'), 'settingsToggleLongTerm exists');
        assert.ok(htmlContent.includes('id="settingsExportMemoryBtn"'), 'settingsExportMemoryBtn exists');
        assert.ok(htmlContent.includes('id="settingsImportMemoryBtn"'), 'settingsImportMemoryBtn exists');
        assert.ok(htmlContent.includes('id="settingsClearWorkingDataBtn"'), 'settingsClearWorkingDataBtn exists');

        // Automation Tab
        assert.ok(htmlContent.includes('id="settingAutomationMode"'), 'settingAutomationMode exists');
        assert.ok(htmlContent.includes('id="automationTierTag"'), 'automationTierTag exists');
        assert.ok(htmlContent.includes('id="toggleDryRunSettingsBtn"'), 'toggleDryRunSettingsBtn exists in Automation pane');
    });

    await suite.test('10. CSS Architecture: Dedicated styling for Settings Center tabs, viewport, and scrollbar', () => {
        assert.ok(cssContent.includes('.settings-center-container'), '.settings-center-container rule exists');
        assert.ok(cssContent.includes('.settings-center-header'), '.settings-center-header rule exists');
        assert.ok(cssContent.includes('.settings-center-tabs'), '.settings-center-tabs rule exists');
        assert.ok(cssContent.includes('.settings-center-tab-btn'), '.settings-center-tab-btn rule exists');
        assert.ok(cssContent.includes('.settings-center-tab-btn.active'), '.settings-center-tab-btn.active rule exists');
        assert.ok(cssContent.includes('.settings-center-viewport'), '.settings-center-viewport rule exists');
        assert.ok(cssContent.includes('.settings-center-pane'), '.settings-center-pane rule exists');
        assert.ok(cssContent.includes('.settings-center-pane.active'), '.settings-center-pane.active rule exists');

        // Viewport must allow vertical scrolling
        const viewportMatch = cssContent.match(/\.settings-center-viewport\s*\{([^}]+)\}/);
        assert.ok(viewportMatch, '.settings-center-viewport rule exists');
        assert.ok(viewportMatch[1].includes('overflow-y: auto'), 'Settings viewport must have overflow-y: auto');
    });

    await suite.test('11. JavaScript Controller: switchSettingsCenterTab, openSettings, and IPC routing', () => {
        assert.ok(appJsContent.includes('function switchSettingsCenterTab('), 'switchSettingsCenterTab must be implemented');
        assert.ok(appJsContent.includes('function openSettings('), 'openSettings must be implemented');
        assert.ok(appJsContent.includes('function updateEngineUiVisibility('), 'updateEngineUiVisibility must be implemented');
        assert.ok(appJsContent.includes('function refreshGeneralSettings('), 'refreshGeneralSettings must be implemented');
        assert.ok(appJsContent.includes('function refreshVoiceSettingsUI('), 'refreshVoiceSettingsUI must be implemented');
        assert.ok(appJsContent.includes('function syncDryRunUI('), 'syncDryRunUI must be implemented');

        // Global exports
        assert.ok(appJsContent.includes('window.openSettings = openSettings;'), 'openSettings must be exported to window');
        assert.ok(appJsContent.includes('window.switchSettingsCenterTab = switchSettingsCenterTab;'), 'switchSettingsCenterTab must be exported to window');

        // Legacy routing in switchView
        assert.ok(appJsContent.includes("targetViewId === 'viewCompanionSettings'"), 'switchView must intercept viewCompanionSettings');
        assert.ok(appJsContent.includes("actualViewId = 'viewSettings'"), 'switchView must route viewCompanionSettings to viewSettings');
        assert.ok(appJsContent.includes("targetSettingsCategory = 'companion'"), 'switchView must switch to companion category tab');
    });
});
