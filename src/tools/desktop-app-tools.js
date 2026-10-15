'use strict';

const { RISK_TIERS } = require('../security/permission-authority.js');

/**
 * Register native Windows desktop automation tools with L.U.C.Y.'s central ToolRegistry.
 * 
 * Enforces:
 * 1. Centralized Permission Authority:
 *    - Reading apps, UI trees, finding elements, screenshots: SAFE_READ
 *    - Launching allowlisted applications: WORKSPACE_WRITE
 *    - Typing text, clicking buttons, closing applications: CONSEQUENTIAL (interactive confirmation gate)
 * 2. Consequential Button Detection: Identifies high-impact buttons (delete, pay, submit, save).
 * 3. Mechanical Dry-Run Isolation: Tools never perform real side effects during dry run.
 * 4. Action Verification Receipts: Outcomes are read back and verified via UI Automation.
 */
function registerDesktopTools(registry, desktopManager) {
    if (!registry || typeof registry.registerTool !== 'function') {
        throw new Error('Valid ToolRegistry required to register desktop tools');
    }
    if (!desktopManager) {
        throw new Error('Valid DesktopAutomationManager required to register desktop tools');
    }

    // Helper: determine if click target is consequential
    function isConsequentialClick(name, automationId) {
        const text = `${name || ''} ${automationId || ''}`.toLowerCase();
        return text.includes('delete') ||
               text.includes('remove') ||
               text.includes('pay') ||
               text.includes('buy') ||
               text.includes('order') ||
               text.includes('checkout') ||
               text.includes('submit') ||
               text.includes('send') ||
               text.includes('confirm') ||
               text.includes('save') ||
               text.includes('post');
    }

    // 1. desktop_list_apps
    registry.registerTool({
        id: 'desktop_list_apps',
        name: 'Desktop Application Lister',
        description: 'Discover and list currently running Windows applications with accessible top-level windows',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                filter: { type: 'string', description: 'Optional process name or title filter' }
            }
        },
        handler: async (params) => {
            const apps = await desktopManager.listApps();
            if (params.filter) {
                const f = params.filter.toLowerCase();
                return apps.filter(a => (a.name || '').toLowerCase().includes(f) || (a.processName || '').toLowerCase().includes(f));
            }
            return apps;
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'list_apps',
                filter: params.filter || null,
                effect: 'Would query active top-level windows from interactive desktop session (read-only)'
            };
        }
    });

    // 2. desktop_launch_app
    registry.registerTool({
        id: 'desktop_launch_app',
        name: 'Desktop Application Launcher',
        description: 'Launch an authorized native Windows application (e.g. notepad.exe, calc.exe)',
        riskTier: RISK_TIERS.WORKSPACE_WRITE,
        schema: {
            type: 'object',
            properties: {
                executable: { type: 'string', description: 'Executable name or path (e.g. notepad.exe, calc.exe)' },
                arguments: { type: 'string', description: 'Optional command-line arguments' }
            },
            required: ['executable']
        },
        handler: async (params) => {
            return await desktopManager.launchApp(params.executable, params.arguments);
        },
        dryRunSimulate: async (params) => {
            const validation = desktopManager.validateExecutable(params.executable);
            const safeArgs = typeof desktopManager.validateArguments === 'function'
                ? desktopManager.validateArguments(validation.resolvedPath, params.arguments)
                : (params.arguments || '');
            return {
                simulatedAction: 'launch_app',
                targetExecutable: validation.resolvedPath,
                arguments: safeArgs,
                isAllowlisted: validation.isAllowlisted,
                effect: `Would launch application '${validation.resolvedPath}' on interactive desktop without side effects`
            };
        }
    });

    // 3. desktop_inspect_ui
    registry.registerTool({
        id: 'desktop_inspect_ui',
        name: 'Desktop UI Inspector',
        description: 'Inspect the accessible UI Automation element hierarchy of a window by appId or title',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId (e.g. app_1234) or window title (e.g. Notepad, Calculator)' },
                maxDepth: { type: 'number', description: 'Maximum tree traversal depth (default 3, max 6)' }
            },
            required: ['target']
        },
        handler: async (params) => {
            return await desktopManager.inspectUI(params.target, { maxDepth: params.maxDepth || 3 });
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'inspect_ui',
                target: params.target,
                maxDepth: params.maxDepth || 3,
                effect: `Would inspect UI Automation accessibility tree for '${params.target}' (read-only)`
            };
        }
    });

    // 4. desktop_find_element
    registry.registerTool({
        id: 'desktop_find_element',
        name: 'Desktop Control Finder',
        description: 'Find a specific control in an application window by accessible name, automationId, or controlType',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId or window title' },
                name: { type: 'string', description: 'Accessible control name/label (e.g. "Text editor", "Clear", "Five")' },
                automationId: { type: 'string', description: 'Stable UIA AutomationId identifier' },
                controlType: { type: 'string', description: 'UIA control type filter (Button, Edit, Document, etc.)' }
            },
            required: ['target']
        },
        handler: async (params) => {
            return await desktopManager.findElement(params.target, {
                name: params.name,
                automationId: params.automationId,
                controlType: params.controlType
            });
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'find_element',
                target: params.target,
                name: params.name || null,
                automationId: params.automationId || null,
                effect: `Would search for control '${params.name || params.automationId}' in '${params.target}' (read-only)`
            };
        }
    });

    // 5. desktop_type_text
    registry.registerTool({
        id: 'desktop_type_text',
        name: 'Desktop Text Typer',
        description: 'Enter verified text into an editable field or document in a desktop application',
        riskTier: RISK_TIERS.CONSEQUENTIAL,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId or window title' },
                text: { type: 'string', description: 'Text to enter into the focused/editable control' }
            },
            required: ['target', 'text']
        },
        handler: async (params) => {
            return await desktopManager.typeText(params.target, params.text);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'type_text',
                target: params.target,
                textLength: params.text.length,
                preview: params.text.slice(0, 30),
                effect: `Would enter ${params.text.length} characters of text into application '${params.target}'`
            };
        }
    });

    // 6. desktop_click_element
    registry.registerTool({
        id: 'desktop_click_element',
        name: 'Desktop Element Clicker',
        description: 'Click or invoke a button, menu item, or toggle control in a desktop application',
        riskTier: RISK_TIERS.CONSEQUENTIAL,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId or window title' },
                name: { type: 'string', description: 'Accessible name of the control to click' },
                automationId: { type: 'string', description: 'AutomationId of the control' }
            },
            required: ['target']
        },
        handler: async (params) => {
            return await desktopManager.clickElement(params.target, {
                name: params.name,
                automationId: params.automationId
            });
        },
        dryRunSimulate: async (params) => {
            const consequential = isConsequentialClick(params.name, params.automationId);
            return {
                simulatedAction: 'click_element',
                target: params.target,
                name: params.name || null,
                automationId: params.automationId || null,
                isConsequential: consequential,
                effect: `Would invoke UI control '${params.name || params.automationId}' in '${params.target}'`
            };
        }
    });

    // 7. desktop_take_screenshot
    registry.registerTool({
        id: 'desktop_take_screenshot',
        name: 'Desktop Window Screenshot',
        description: 'Capture a visual PNG screenshot of the specified desktop application window',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId or window title' }
            },
            required: ['target']
        },
        handler: async (params) => {
            const shot = await desktopManager.takeScreenshot(params.target);
            const base64 = shot?.base64 || (typeof shot === 'string' ? shot : null);
            const format = shot?.format || 'png';
            return {
                ok: true,
                status: 'screenshot_captured',
                target: params.target,
                format,
                width: shot?.width,
                height: shot?.height,
                base64,
                dataUri: base64 ? `data:image/${format};base64,${base64}` : null,
                result: shot,
                verification: {
                    verified: Boolean(shot && (base64 || shot.format || typeof shot === 'object')),
                    method: 'desktop_screenshot_check'
                }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'take_screenshot',
                target: params.target,
                effect: `Would capture image snapshot of window '${params.target}' (read-only)`
            };
        }
    });

    // 8. desktop_close_app
    registry.registerTool({
        id: 'desktop_close_app',
        name: 'Desktop Application Closer',
        description: 'Gracefully close or terminate a desktop application window with modal save-confirmation handling',
        riskTier: RISK_TIERS.CONSEQUENTIAL,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId, PID, or window title' },
                savePolicy: {
                    type: 'string',
                    enum: ['dont_save', 'save', 'cancel', 'ask'],
                    description: 'Policy when a save confirmation dialog appears (dont_save for authorized disposable changes, save to preserve changes, cancel to abort, ask to prompt user)'
                }
            },
            required: ['target']
        },
        handler: async (params) => {
            return await desktopManager.closeApp(params.target, { savePolicy: params.savePolicy });
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'close_app',
                target: params.target,
                savePolicy: params.savePolicy || 'ask',
                effect: `Would request closing application window '${params.target}' with savePolicy '${params.savePolicy || 'ask'}'`
            };
        }
    });

    // 9. desktop_handle_dialog
    registry.registerTool({
        id: 'desktop_handle_dialog',
        name: 'Desktop Modal Dialog Handler',
        description: 'Detect and resolve modal save confirmation dialogs in desktop applications',
        riskTier: RISK_TIERS.CONSEQUENTIAL,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId, PID, or window title' },
                action: {
                    type: 'string',
                    enum: ['save', 'dont_save', 'cancel'],
                    description: 'Action to perform on the dialog (save, dont_save, or cancel)'
                }
            },
            required: ['target', 'action']
        },
        handler: async (params) => {
            return await desktopManager.handleDialog(params.target, params.action);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'handle_dialog',
                target: params.target,
                action: params.action,
                effect: `Would invoke action '${params.action}' on confirmation dialog for '${params.target}'`
            };
        }
    });
}

module.exports = {
    registerDesktopTools
};
