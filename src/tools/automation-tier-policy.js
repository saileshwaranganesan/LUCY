'use strict';

/**
 * L.U.C.Y. Automation Tier & Non-Intrusive Execution Policy (Repair 9)
 * 
 * Defines a 4-tier hierarchy for desktop and computer actions:
 * Tier 1 — Direct APIs and application integrations (File system, CLI, HTTP, In-process APIs)
 * Tier 2 — Background or isolated browser automation (Playwright headless/isolated DOM)
 * Tier 3 — Windows UI Automation & Accessibility (ValuePattern, InvokePattern, TogglePattern, SelectionItemPattern)
 * Tier 4 — Physical mouse and keyboard fallback (SetCursorPos, mouse_event, keybd_event)
 */

const AUTOMATION_TIERS = Object.freeze({
    TIER_1_DIRECT_API: 1,
    TIER_2_BROWSER_DOM: 2,
    TIER_3_ACCESSIBILITY_UIA: 3,
    TIER_3_UI_AUTOMATION: 3,
    TIER_4_PHYSICAL_FALLBACK: 4
});

const TIER_NAMES = Object.freeze({
    [AUTOMATION_TIERS.TIER_1_DIRECT_API]: 'direct_api',
    [AUTOMATION_TIERS.TIER_2_BROWSER_DOM]: 'browser_dom',
    [AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA]: 'accessibility_uia',
    [AUTOMATION_TIERS.TIER_4_PHYSICAL_FALLBACK]: 'physical_fallback'
});

const INTERACTION_MODES = Object.freeze({
    NON_INTRUSIVE: 'non_intrusive',              // Default: Prefer Tier 1-3, block unauthorized physical cursor/keyboard
    FOREGROUND_REQUIRED: 'foreground_required',  // Task legitimately requires visible desktop foreground focus
    WAITING_APPROVAL: 'waiting_approval',        // Consequential action or physical takeover awaiting user confirmation
    PAUSED_OR_CANCELLED: 'paused_or_cancelled'   // Halted execution; zero input sent
});

/**
 * Action Capability Descriptor
 * Declares the execution requirements and capabilities of any registered tool.
 * 
 * @param {string} toolId
 * @param {Object} [params={}]
 * @param {Object} [options={}]
 * @returns {Object} Action capability model
 */
function getActionCapability(toolId, params = {}, options = {}) {
    const id = String(toolId || '').toLowerCase().trim();

    // -------------------------------------------------------------
    // Tier 1 — Direct APIs (Files, Memory, System, Workflows)
    // -------------------------------------------------------------
    if (id.startsWith('file_') ||
        id.startsWith('memory_') ||
        id.startsWith('system_') ||
        id.startsWith('student_') ||
        id === 'desktop_launch_app') {

        const isConsequential = (id === 'file_delete');
        return {
            tier: AUTOMATION_TIERS.TIER_1_DIRECT_API,
            tierName: TIER_NAMES[AUTOMATION_TIERS.TIER_1_DIRECT_API],
            requiresForegroundFocus: false,
            requiresPhysicalInput: false,
            canExecuteInBackground: true,
            requiresVisibleWindow: id === 'desktop_launch_app',
            requiresElevatedPermissions: false,
            isReversible: (id === 'file_write' || id === 'file_mkdir'),
            requiresConfirmation: isConsequential,
            canCancelSafely: true,
            targetApp: params.executable || null,
            targetControl: null,
            justification: id === 'desktop_launch_app'
                ? 'Launches verified application process directly via Win32 CreateProcess API without physical input.'
                : 'Direct API executes in-process or via file-system without desktop or cursor interference.'
        };
    }

    // -------------------------------------------------------------
    // Tier 2 — Browser DOM Automation (Playwright)
    // -------------------------------------------------------------
    if (id.startsWith('browser_')) {
        const isConsequential = id === 'browser_click' &&
            Boolean(params.selector && /submit|buy|pay|order|delete|remove|checkout/i.test(params.selector));

        return {
            tier: AUTOMATION_TIERS.TIER_2_BROWSER_DOM,
            tierName: TIER_NAMES[AUTOMATION_TIERS.TIER_2_BROWSER_DOM],
            requiresForegroundFocus: false,
            requiresPhysicalInput: false,
            canExecuteInBackground: true,
            requiresVisibleWindow: false,
            requiresElevatedPermissions: false,
            isReversible: false,
            requiresConfirmation: isConsequential,
            canCancelSafely: true,
            targetApp: 'Playwright Browser',
            targetControl: params.selector || null,
            justification: 'Browser automation uses synthetic DOM events and semantic locators in an isolated browser context.'
        };
    }

    // -------------------------------------------------------------
    // Tier 3 & Tier 4 — Desktop Automation & UI Automation
    // -------------------------------------------------------------
    if (id.startsWith('desktop_')) {
        // Read-only desktop tools (UIA tree traversal, element discovery, window screenshot)
        if (id === 'desktop_list_apps' ||
            id === 'desktop_inspect_ui' ||
            id === 'desktop_find_element' ||
            id === 'desktop_take_screenshot') {
            return {
                tier: AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA,
                tierName: TIER_NAMES[AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA],
                requiresForegroundFocus: false,
                requiresPhysicalInput: false,
                canExecuteInBackground: true,
                requiresVisibleWindow: id === 'desktop_take_screenshot',
                requiresElevatedPermissions: false,
                isReversible: true,
                requiresConfirmation: false,
                canCancelSafely: true,
                targetApp: params.target || null,
                targetControl: params.name || params.automationId || null,
                justification: 'Read-only desktop inspection querying UI Automation accessibility tree without user input.'
            };
        }

        // Text input into controls
        if (id === 'desktop_type_text') {
            const allowPhysical = Boolean(params.allowPhysicalFallback || options.allowPhysicalFallback);
            const preferBackground = options.preferBackground !== false && params.preferBackground !== false;

            return {
                tier: allowPhysical ? AUTOMATION_TIERS.TIER_4_PHYSICAL_FALLBACK : AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA,
                tierName: allowPhysical ? TIER_NAMES[AUTOMATION_TIERS.TIER_4_PHYSICAL_FALLBACK] : TIER_NAMES[AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA],
                requiresForegroundFocus: !preferBackground || allowPhysical,
                requiresPhysicalInput: allowPhysical,
                canExecuteInBackground: preferBackground && !allowPhysical,
                requiresVisibleWindow: true,
                requiresElevatedPermissions: false,
                isReversible: true,
                requiresConfirmation: true,
                canCancelSafely: true,
                targetApp: params.target || null,
                targetControl: 'Document/Edit',
                justification: allowPhysical
                    ? 'Physical keyboard fallback requested for text entry into control lacking ValuePattern.'
                    : 'Sets text semantically via UI Automation ValuePattern or WM_SETTEXT without moving cursor or global keystrokes.'
            };
        }

        // Control clicking and invoking
        if (id === 'desktop_click_element') {
            const allowPhysical = Boolean(params.allowPhysicalFallback || options.allowPhysicalFallback);

            return {
                tier: allowPhysical ? AUTOMATION_TIERS.TIER_4_PHYSICAL_FALLBACK : AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA,
                tierName: allowPhysical ? TIER_NAMES[AUTOMATION_TIERS.TIER_4_PHYSICAL_FALLBACK] : TIER_NAMES[AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA],
                requiresForegroundFocus: allowPhysical,
                requiresPhysicalInput: allowPhysical,
                canExecuteInBackground: !allowPhysical,
                requiresVisibleWindow: true,
                requiresElevatedPermissions: false,
                isReversible: false,
                requiresConfirmation: true,
                canCancelSafely: true,
                targetApp: params.target || null,
                targetControl: params.name || params.automationId || null,
                justification: allowPhysical
                    ? 'Physical mouse movement and click requested because control lacks accessible patterns.'
                    : 'Invokes control semantically via InvokePattern, TogglePattern, SelectionItemPattern, or Win32 messages without physical cursor.'
            };
        }

        // Window focus
        if (id === 'desktop_focus_window') {
            return {
                tier: AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA,
                tierName: TIER_NAMES[AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA],
                requiresForegroundFocus: true,
                requiresPhysicalInput: false,
                canExecuteInBackground: false,
                requiresVisibleWindow: true,
                requiresElevatedPermissions: false,
                isReversible: true,
                requiresConfirmation: false,
                canCancelSafely: true,
                targetApp: params.target || null,
                targetControl: null,
                justification: 'Brings target window into foreground focus.'
            };
        }

        // Closing windows / tabs / dialogs
        if (id === 'desktop_close_app' || id === 'desktop_close_tab' || id === 'desktop_handle_dialog') {
            const isTab = (id === 'desktop_close_tab');
            return {
                tier: AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA,
                tierName: TIER_NAMES[AUTOMATION_TIERS.TIER_3_ACCESSIBILITY_UIA],
                requiresForegroundFocus: isTab,
                requiresPhysicalInput: false,
                canExecuteInBackground: !isTab,
                requiresVisibleWindow: true,
                requiresElevatedPermissions: false,
                isReversible: false,
                requiresConfirmation: true,
                canCancelSafely: true,
                targetApp: params.target || null,
                targetControl: null,
                justification: 'Closes target window or tab using WindowPattern, WM_SYSCOMMAND SC_CLOSE, or scoped dialog handling.'
            };
        }
    }

    // Default generic tool capability
    return {
        tier: AUTOMATION_TIERS.TIER_1_DIRECT_API,
        tierName: TIER_NAMES[AUTOMATION_TIERS.TIER_1_DIRECT_API],
        requiresForegroundFocus: false,
        requiresPhysicalInput: false,
        canExecuteInBackground: true,
        requiresVisibleWindow: false,
        requiresElevatedPermissions: false,
        isReversible: false,
        requiresConfirmation: false,
        canCancelSafely: true,
        targetApp: null,
        targetControl: null,
        justification: 'Generic tool execution operates non-intrusively by default.'
    };
}

module.exports = {
    AUTOMATION_TIERS,
    TIER_NAMES,
    INTERACTION_MODES,
    getActionCapability
};
