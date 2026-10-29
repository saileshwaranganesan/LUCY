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
        handler: async (params, context = {}) => {
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
        handler: async (params, context = {}) => {
            return await desktopManager.launchApp(params.executable, params.arguments, {
                taskId: context?.taskId,
                signal: context?.signal,
                workspaceRoot: context?.workspaceRoot || desktopManager.workspaceRoot
            });
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
        handler: async (params, context = {}) => {
            return await desktopManager.inspectUI(params.target, {
                maxDepth: params.maxDepth || 3,
                taskId: context?.taskId,
                signal: context?.signal
            });
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
        handler: async (params, context = {}) => {
            return await desktopManager.findElement(params.target, {
                name: params.name,
                automationId: params.automationId,
                controlType: params.controlType,
                className: params.className,
                parentAutomationId: params.parentAutomationId,
                parentName: params.parentName,
                parentControlType: params.parentControlType,
                expectedBoundingBox: params.expectedBoundingBox,
                action: params.action,
                taskId: context?.taskId,
                signal: context?.signal
            });
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'find_element',
                target: params.target,
                name: params.name || null,
                automationId: params.automationId || null,
                controlType: params.controlType || null,
                effect: `Would search for control '${params.name || params.automationId}' in '${params.target}' (read-only)`
            };
        }
    });

    // 4b. desktop_resolve_target
    registry.registerTool({
        id: 'desktop_resolve_target',
        name: 'Desktop Target Resolver',
        description: 'Deterministically resolve and verify a UI target element in an application window using UIA hierarchy and evidence',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId or window title' },
                name: { type: 'string', description: 'Accessible control name/label' },
                automationId: { type: 'string', description: 'Stable UIA AutomationId identifier' },
                controlType: { type: 'string', description: 'UIA control type filter (Button, Edit, Document, etc.)' },
                className: { type: 'string', description: 'Win32/WPF class name' },
                parentAutomationId: { type: 'string', description: 'Parent container AutomationId' },
                parentName: { type: 'string', description: 'Parent container name' },
                parentControlType: { type: 'string', description: 'Parent container control type' },
                action: { type: 'string', description: 'Optional intended action compatibility check (click, type, read)' }
            },
            required: ['target']
        },
        handler: async (params, context = {}) => {
            return await desktopManager.resolveTarget(params.target, {
                name: params.name,
                automationId: params.automationId,
                controlType: params.controlType,
                className: params.className,
                parentAutomationId: params.parentAutomationId,
                parentName: params.parentName,
                parentControlType: params.parentControlType,
                expectedBoundingBox: params.expectedBoundingBox,
                action: params.action,
                allowPhysicalFallback: params.allowPhysicalFallback,
                taskId: context?.taskId,
                signal: context?.signal
            });
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'resolve_target',
                target: params.target,
                name: params.name || null,
                automationId: params.automationId || null,
                controlType: params.controlType || null,
                action: params.action || 'resolve',
                effect: `Would resolve target control in '${params.target}' deterministically without side effects (read-only)`
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
                text: { type: 'string', description: 'Text to enter into the focused/editable control' },
                preferBackground: { type: 'boolean', description: 'Prefer non-intrusive background UI Automation text entry (default true)' },
                allowPhysicalFallback: { type: 'boolean', description: 'Allow physical foreground typing fallback if UIA is unsupported (default false)' },
                isSecret: { type: 'boolean', description: 'Whether the text is a sensitive secret that must be redacted from receipts and logs' },
                automationId: { type: 'string', description: 'Optional specific automationId of target edit control' },
                name: { type: 'string', description: 'Optional specific accessible name of target edit control' },
                controlType: { type: 'string', description: 'Optional control type constraint (Edit, Document)' },
                className: { type: 'string', description: 'Optional class name constraint' }
            },
            required: ['target', 'text']
        },
        handler: async (params, context = {}) => {
            const passwordKeywordRegex = /password|passwd|pwd|pin|secret|credential|token|auth/i;
            const isSecret = Boolean(
                params.isSecret ||
                context?.isSecret ||
                passwordKeywordRegex.test(params.automationId || '') ||
                passwordKeywordRegex.test(params.name || '') ||
                passwordKeywordRegex.test(params.controlName || '') ||
                passwordKeywordRegex.test(params.targetControl || '') ||
                passwordKeywordRegex.test(params.className || '') ||
                passwordKeywordRegex.test(typeof params.target === 'string' ? params.target : '')
            );
            const res = await desktopManager.typeText(params.target, params.text, {
                preferBackground: params.preferBackground !== false,
                allowPhysicalFallback: Boolean(params.allowPhysicalFallback || context?.allowPhysicalFallback),
                isSecret,
                automationId: params.automationId,
                name: params.name,
                controlType: params.controlType,
                className: params.className,
                taskId: context?.taskId,
                signal: context?.signal,
                requireOwnership: true
            });
            return {
                ok: !res.error,
                ...res
            };
        },
        dryRunSimulate: async (params) => {
            const passwordKeywordRegex = /password|passwd|pwd|pin|secret|credential|token|auth/i;
            const isSecret = Boolean(
                params.isSecret ||
                passwordKeywordRegex.test(params.automationId || '') ||
                passwordKeywordRegex.test(params.name || '') ||
                passwordKeywordRegex.test(params.controlName || '') ||
                passwordKeywordRegex.test(params.targetControl || '') ||
                passwordKeywordRegex.test(params.className || '') ||
                passwordKeywordRegex.test(typeof params.target === 'string' ? params.target : '')
            );
            return {
                simulatedAction: 'type_text',
                target: params.target,
                textLength: params.text ? params.text.length : 0,
                preview: isSecret ? '[REDACTED]' : (params.text ? params.text.slice(0, 30) : ''),
                isSecret,
                tier: 3,
                tierName: 'Tier 3 — Windows UI Automation',
                physicalInputUsed: false,
                effect: `Would enter ${params.text ? params.text.length : 0} characters of text into application '${params.target}' non-intrusively`
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
                automationId: { type: 'string', description: 'AutomationId of the control' },
                controlType: { type: 'string', description: 'UIA control type filter (Button, MenuItem, CheckBox, etc.)' },
                className: { type: 'string', description: 'Win32/WPF class name' },
                parentAutomationId: { type: 'string', description: 'Parent container AutomationId' },
                parentName: { type: 'string', description: 'Parent container name' },
                parentControlType: { type: 'string', description: 'Parent container control type' },
                allowPhysicalFallback: { type: 'boolean', description: 'Allow physical mouse click fallback if UIA is unsupported (default false)' }
            },
            required: ['target']
        },
        handler: async (params, context = {}) => {
            const res = await desktopManager.clickElement(params.target, {
                name: params.name,
                automationId: params.automationId,
                controlType: params.controlType,
                className: params.className,
                parentAutomationId: params.parentAutomationId,
                parentName: params.parentName,
                parentControlType: params.parentControlType,
                expectedBoundingBox: params.expectedBoundingBox,
                allowPhysicalFallback: Boolean(params.allowPhysicalFallback || context?.allowPhysicalFallback)
            }, {
                allowPhysicalFallback: Boolean(params.allowPhysicalFallback || context?.allowPhysicalFallback),
                taskId: context?.taskId,
                signal: context?.signal,
                requireOwnership: true
            });
            return {
                ok: res.success !== false,
                ...res
            };
        },
        dryRunSimulate: async (params) => {
            const consequential = isConsequentialClick(params.name, params.automationId);
            return {
                simulatedAction: 'click_element',
                target: params.target,
                name: params.name || null,
                automationId: params.automationId || null,
                controlType: params.controlType || null,
                isConsequential: consequential,
                tier: 3,
                tierName: 'Tier 3 — Windows UI Automation',
                physicalInputUsed: false,
                effect: `Would invoke UI control '${params.name || params.automationId}' in '${params.target}' non-intrusively`
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
                target: { type: 'string', description: 'AppId or window title' },
                allowPlaceholder: { type: 'boolean', description: 'Allow returning synthetic placeholder canvas if pixel capture fails (default false)' }
            },
            required: ['target']
        },
        handler: async (params, context = {}) => {
            const shot = await desktopManager.takeScreenshot(params.target, {
                taskId: context?.taskId,
                signal: context?.signal,
                allowPlaceholder: params.allowPlaceholder
            });
            const base64 = shot?.base64 || (typeof shot === 'string' ? shot : null);
            const format = shot?.format || 'png';
            const captured = Boolean(shot && shot.captured !== false && !shot.isPlaceholder);
            return {
                ok: captured || Boolean(params.allowPlaceholder),
                status: captured ? 'screenshot_captured' : (shot?.isPlaceholder ? 'screenshot_placeholder' : 'screenshot_failed'),
                captured,
                isPlaceholder: Boolean(shot?.isPlaceholder),
                method: shot?.method || 'none',
                target: params.target,
                format,
                width: shot?.width,
                height: shot?.height,
                base64,
                dataUri: base64 ? `data:image/${format};base64,${base64}` : null,
                result: shot,
                verification: {
                    verified: captured || Boolean(params.allowPlaceholder),
                    method: 'desktop_screenshot_check'
                }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'take_screenshot',
                target: params.target,
                allowPlaceholder: Boolean(params.allowPlaceholder),
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
                force: { type: 'boolean', description: 'Force terminate the application process if unresponsive' },
                savePolicy: {
                    type: 'string',
                    enum: ['dont_save', 'save', 'cancel', 'ask'],
                    description: 'Policy when a save confirmation dialog appears (dont_save for authorized disposable changes, save to preserve changes, cancel to abort, ask to prompt user)'
                }
            },
            required: ['target']
        },
        handler: async (params, context = {}) => {
            const isDiscard = params.savePolicy === 'dont_save';
            let userAuthorizedDiscard = false;
            let disposableTestDoc = false;

            if (isDiscard) {
                const perm = context?.permissionDecision;
                if (context?.userAuthorizedDiscard === true) {
                    userAuthorizedDiscard = true;
                } else if (perm?.permitted === true && perm?.userAuthorizedDiscard === true) {
                    userAuthorizedDiscard = true;
                }
                if (context?.trustedTestScope === true || context?.disposableTestDoc === true) {
                    disposableTestDoc = true;
                }
            }

            return await desktopManager.closeApp(params.target, {
                force: Boolean(params.force || context?.force),
                savePolicy: params.savePolicy,
                taskId: context?.taskId,
                signal: context?.signal,
                userAuthorizedDiscard,
                disposableTestDoc,
                trustedTestScope: Boolean(context?.trustedTestScope),
                authorizedTarget: context?.permissionDecision?.target,
                requireOwnership: true
            });
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
                },
                userAuthorizedDiscard: {
                    type: 'boolean',
                    description: 'Explicit user authorization to discard unsaved changes (requires confirmation authority verification)'
                },
                disposableTestDoc: {
                    type: 'boolean',
                    description: 'Scope confirming the document contains disposable test data created exclusively for an automated test (requires trusted test context)'
                },
                isAmbiguous: {
                    type: 'boolean',
                    description: 'Flag indicating if dialog intent or target is ambiguous'
                }
            },
            required: ['target', 'action']
        },
        handler: async (params, context = {}) => {
            const isDiscard = params.action === 'dont_save';
            let userAuthorizedDiscard = false;
            let disposableTestDoc = false;

            if (isDiscard) {
                const perm = context?.permissionDecision;
                // Trusted user authorization must come from PermissionAuthority confirmation or trusted context, NOT model arguments!
                if (context?.userAuthorizedDiscard === true) {
                    userAuthorizedDiscard = true;
                } else if (perm?.permitted === true && perm?.userAuthorizedDiscard === true) {
                    userAuthorizedDiscard = true;
                }

                // Trusted disposable test scope: only trusted execution context can establish test scope
                if (context?.trustedTestScope === true || context?.disposableTestDoc === true) {
                    disposableTestDoc = true;
                }
            }

            return await desktopManager.handleDialog(params.target, params.action, {
                taskId: context?.taskId,
                signal: context?.signal,
                userAuthorizedDiscard,
                disposableTestDoc,
                isAmbiguous: Boolean(params.isAmbiguous),
                trustedTestScope: Boolean(context?.trustedTestScope),
                authorizedTarget: context?.permissionDecision?.target,
                force: Boolean(params.force || context?.force),
                allowForceKill: Boolean(params.allowForceKill || context?.allowForceKill),
                requireOwnership: true
            });
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

    // 10. desktop_focus_window
    registry.registerTool({
        id: 'desktop_focus_window',
        name: 'Desktop Window Focus',
        description: 'Bring an existing application window into focus and foreground',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId, PID, process name, or window title' }
            },
            required: ['target']
        },
        handler: async (params, context = {}) => {
            return await desktopManager.focusWindow(params.target, {
                taskId: context?.taskId,
                signal: context?.signal,
                requireOwnership: true
            });
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'focus_window',
                target: params.target,
                effect: `Would bring window '${params.target}' to foreground without side effects`
            };
        }
    });

    // 11. desktop_inspect_control
    registry.registerTool({
        id: 'desktop_inspect_control',
        name: 'Desktop Control Inspector',
        description: 'Inspect accessibility properties, responsiveness, and readiness of a control or application window (e.g. verify editable control is present before typing)',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId or window title' },
                controlType: { type: 'string', description: 'Optional UIA control type filter (e.g. Edit, Document, Button)' },
                name: { type: 'string', description: 'Optional accessible name of the control' },
                automationId: { type: 'string', description: 'Optional AutomationId of the control' },
                action: { type: 'string', description: 'Intended action to check compatibility for (e.g. type, click, read)' }
            },
            required: ['target']
        },
        handler: async (params, context = {}) => {
            return await desktopManager.inspectControl(params.target, {
                controlType: params.controlType,
                name: params.name,
                automationId: params.automationId,
                action: params.action || 'type',
                taskId: context?.taskId,
                signal: context?.signal
            });
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'inspect_control',
                target: params.target,
                controlType: params.controlType || 'Edit',
                action: params.action || 'type',
                effect: `Would inspect if '${params.target}' has an active, accessible control compatible with action '${params.action || 'type'}' without modifying state`
            };
        }
    });

    // 12. desktop_save_document
    registry.registerTool({
        id: 'desktop_save_document',
        name: 'Desktop Document Saver',
        description: 'Save the active document in a desktop application to an authorized file path and verify outcome',
        riskTier: RISK_TIERS.CONSEQUENTIAL,
        schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'AppId or window title' },
                filePath: { type: 'string', description: 'Destination file path to save the document' }
            },
            required: ['target', 'filePath']
        },
        handler: async (params, context = {}) => {
            const res = await desktopManager.saveDocument(params.target, params.filePath, {
                taskId: context?.taskId,
                signal: context?.signal,
                requireOwnership: true
            });
            return {
                ok: res.ok !== false && res.saved !== false,
                ...res
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'save_document',
                target: params.target,
                filePath: params.filePath,
                isConsequential: true,
                tier: 3,
                tierName: 'Tier 3 — Windows UI Automation',
                effect: `Would save document in '${params.target}' to '${params.filePath}'`
            };
        }
    });
}

module.exports = {
    registerDesktopTools
};
