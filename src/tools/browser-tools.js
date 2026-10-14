'use strict';

const { RISK_TIERS } = require('../security/permission-authority.js');

/**
 * Register Playwright-backed Browser Tools with L.U.C.Y.'s ToolRegistry.
 * 
 * Enforces:
 * 1. Centralized Permission Authority:
 *    - Public page read / navigation: NETWORK_READ
 *    - Form input filling, consequential button clicks (submit, pay, delete): CONSEQUENTIAL
 * 2. Mechanical Dry-Run Isolation: Tools never open sockets or mutate state in dry-run mode.
 * 3. Selector verification: Always checks action outcome.
 */
function registerBrowserTools(registry, browserManager) {

    // Helper: determine if click target is consequential
    function isConsequentialClick(selector) {
        const lower = String(selector || '').toLowerCase();
        return lower.includes('submit') ||
               lower.includes('buy') ||
               lower.includes('pay') ||
               lower.includes('order') ||
               lower.includes('checkout') ||
               lower.includes('delete') ||
               lower.includes('remove') ||
               lower.includes('publish') ||
               lower.includes('save') ||
               lower.includes('post');
    }

    // 1. browser_navigate
    registry.registerTool({
        id: 'browser_navigate',
        name: 'Browser Navigator',
        description: 'Navigate to an HTTP/HTTPS or local HTML page in the browser',
        riskTier: RISK_TIERS.NETWORK_READ,
        schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to navigate to (e.g. https://example.com)' },
                timeoutMs: { type: 'number', description: 'Optional navigation timeout in ms' }
            },
            required: ['url']
        },
        handler: async (params) => {
            return await browserManager.navigate(params.url, params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'navigate',
                targetUrl: params.url,
                effect: `Would open and navigate browser to ${params.url} under read-only isolation`
            };
        }
    });

    // 2. browser_extract
    registry.registerTool({
        id: 'browser_extract',
        name: 'Browser Content Extractor',
        description: 'Extract visible text, links, or HTML content from the current web page',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Optional CSS or text selector to extract from (defaults to body)' },
                format: { type: 'string', enum: ['text', 'html', 'links'], description: 'Format of extracted content' },
                maxChars: { type: 'number', description: 'Maximum characters to return' }
            }
        },
        handler: async (params) => {
            return await browserManager.extract(params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'extract',
                selector: params.selector || 'body',
                format: params.format || 'text',
                effect: `Would extract visible ${params.format || 'text'} content from current page`
            };
        }
    });

    // 3. browser_click
    registry.registerTool({
        id: 'browser_click',
        name: 'Browser Element Clicker',
        description: 'Click a visible element using robust CSS or text selector on the current page',
        riskTier: RISK_TIERS.CONSEQUENTIAL, // Consequential tier ensures confirmation on form submits / actions
        schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Selector of the element to click (e.g. #submit-btn or text=Confirm)' },
                timeoutMs: { type: 'number', description: 'Timeout in ms to wait for element visibility' }
            },
            required: ['selector']
        },
        handler: async (params) => {
            return await browserManager.click(params.selector, params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'click',
                targetSelector: params.selector,
                isConsequential: isConsequentialClick(params.selector),
                effect: `Would locate and click element matching '${params.selector}'`
            };
        }
    });

    // 4. browser_fill
    registry.registerTool({
        id: 'browser_fill',
        name: 'Browser Field Filler',
        description: 'Fill text into an input field or form on the current web page',
        riskTier: RISK_TIERS.CONSEQUENTIAL, // Form input modifications require confirmation
        schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Selector of the input or textarea element' },
                value: { type: 'string', description: 'Text value to fill into the element' },
                timeoutMs: { type: 'number', description: 'Timeout in ms' }
            },
            required: ['selector', 'value']
        },
        handler: async (params) => {
            return await browserManager.fill(params.selector, params.value, params);
        },
        dryRunSimulate: async (params) => {
            const isPassword = (params.selector || '').toLowerCase().includes('pass');
            return {
                simulatedAction: 'fill',
                targetSelector: params.selector,
                simulatedValue: isPassword ? '[REDACTED_SECRET]' : params.value,
                effect: `Would fill input field '${params.selector}' with specified value`
            };
        }
    });

    // 5. browser_screenshot
    registry.registerTool({
        id: 'browser_screenshot',
        name: 'Browser Screenshotter',
        description: 'Capture a visual PNG screenshot of the current web page or viewport',
        riskTier: RISK_TIERS.NETWORK_READ,
        schema: {
            type: 'object',
            properties: {
                fullPage: { type: 'boolean', description: 'Whether to capture the entire scrollable page' },
                outputPath: { type: 'string', description: 'Optional local file path to save the screenshot' }
            }
        },
        handler: async (params) => {
            return await browserManager.screenshot(params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'screenshot',
                fullPage: Boolean(params.fullPage),
                targetOutput: params.outputPath || 'in_memory',
                effect: 'Would capture visual PNG of current page'
            };
        }
    });

    // 6. browser_new_tab
    registry.registerTool({
        id: 'browser_new_tab',
        name: 'Browser Tab Opener',
        description: 'Open a new browser tab and optionally navigate to a target URL. Returns the new tab stable identifier.',
        riskTier: RISK_TIERS.NETWORK_READ,
        schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Optional URL to navigate to in the new tab' },
                timeoutMs: { type: 'number', description: 'Navigation timeout in ms' }
            }
        },
        handler: async (params) => {
            return await browserManager.newTab(params.url, params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'new_tab',
                targetUrl: params.url || 'about:blank',
                effect: `Would open a new browser tab${params.url ? ` pointing to ${params.url}` : ''}`
            };
        }
    });

    // 7. browser_list_tabs
    registry.registerTool({
        id: 'browser_list_tabs',
        name: 'Browser Tab Lister',
        description: 'List all open browser tabs with their stable IDs, titles, URLs, and active status without changing the active tab',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {}
        },
        handler: async () => {
            return await browserManager.listTabs();
        },
        dryRunSimulate: async () => {
            return {
                simulatedAction: 'list_tabs',
                effect: 'Would query and return the list of all currently open browser tabs without changing active tab'
            };
        }
    });

    // 8. browser_current_tab
    registry.registerTool({
        id: 'browser_current_tab',
        name: 'Browser Current Tab Inspector',
        description: 'Identify which tab is active and provide its stable identifier, current URL, and title',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {}
        },
        handler: async () => {
            return await browserManager.getCurrentTab();
        },
        dryRunSimulate: async () => {
            return {
                simulatedAction: 'current_tab',
                effect: 'Would query and return metadata for the currently active browser tab'
            };
        }
    });

    // 9. browser_switch_tab
    registry.registerTool({
        id: 'browser_switch_tab',
        name: 'Browser Tab Switcher',
        description: 'Switch the active browser tab by its stable identifier (e.g. "tab_1") or zero-based index',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: ['string', 'number'], description: 'Stable tab identifier (e.g. "tab_1") or zero-based tab index' },
                tabId: { type: 'string', description: 'Stable identifier of the tab to make active' },
                index: { type: 'number', description: 'Zero-based index of the tab to make active' }
            }
        },
        handler: async (params) => {
            if (params && params.index !== undefined && (typeof params.index !== 'number' || !Number.isInteger(params.index))) {
                return {
                    ok: false,
                    status: 'invalid_index',
                    error: `Tab index must be an integer, received: ${params.index}`
                };
            }
            const target = params?.tabId ?? (params?.target !== undefined ? params.target : params?.index);
            return await browserManager.switchTab(target);
        },
        dryRunSimulate: async (params) => {
            const target = params?.tabId ?? (params?.target !== undefined ? params.target : params?.index);
            return {
                simulatedAction: 'switch_tab',
                target,
                targetIndex: typeof target === 'number' ? target : undefined,
                targetTabId: typeof target === 'string' ? target : undefined,
                effect: `Would switch active browser tab to '${target}'`
            };
        }
    });

    // 10. browser_close_tab
    registry.registerTool({
        id: 'browser_close_tab',
        name: 'Browser Tab Closer',
        description: 'Close an open browser tab by stable identifier or index, or close the currently active tab if omitted',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                target: { type: ['string', 'number'], description: 'Optional stable tab identifier (e.g. "tab_1") or zero-based tab index' },
                tabId: { type: 'string', description: 'Optional stable tab identifier to close' },
                index: { type: 'number', description: 'Optional zero-based index of the tab to close' }
            }
        },
        handler: async (params) => {
            if (params && params.index !== undefined && (typeof params.index !== 'number' || !Number.isInteger(params.index))) {
                return {
                    ok: false,
                    status: 'tab_out_of_bounds',
                    error: `Cannot close tab at invalid index: ${params.index}.`
                };
            }
            const target = params?.tabId ?? (params?.target !== undefined ? params.target : params?.index);
            return await browserManager.closeTab(target);
        },
        dryRunSimulate: async (params) => {
            const target = params?.tabId ?? (params?.target !== undefined ? params.target : params?.index);
            return {
                simulatedAction: 'close_tab',
                target: target !== undefined ? target : 'active',
                targetIndex: typeof target === 'number' ? target : (target === undefined ? 'active' : undefined),
                targetTabId: typeof target === 'string' ? target : undefined,
                effect: `Would close browser tab '${target !== undefined ? target : 'active'}'`
            };
        }
    });

    // 10. browser_download
    registry.registerTool({
        id: 'browser_download',
        name: 'Browser Secure Downloader',
        description: 'Securely download a file into the workspace downloads folder with containment, collision safety, and SHA-256 verification',
        riskTier: RISK_TIERS.WORKSPACE_WRITE,
        schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL of the file to download' },
                clickSelector: { type: 'string', description: 'CSS/text selector of the download element to click' },
                destinationDir: { type: 'string', description: 'Destination subdirectory inside workspace (defaults to downloads)' },
                customFilename: { type: 'string', description: 'Optional custom filename to save as' },
                expectedSha256: { type: 'string', description: 'Optional expected SHA-256 hash for integrity verification' },
                timeoutMs: { type: 'number', description: 'Download timeout in milliseconds' }
            }
        },
        handler: async (params) => {
            return await browserManager.downloadFile(params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'download',
                targetUrl: params.url || 'from_click',
                destinationDir: params.destinationDir || 'downloads',
                customFilename: params.customFilename,
                expectedSha256: params.expectedSha256,
                effect: `Would securely download file into workspace directory '${params.destinationDir || 'downloads'}' with collision-safe naming and SHA-256 verification`
            };
        }
    });

    // 11. browser_cancel_download
    registry.registerTool({
        id: 'browser_cancel_download',
        name: 'Browser Download Canceller',
        description: 'Cancel an active in-progress browser download by ID and clean up partial files',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                downloadId: { type: 'string', description: 'ID of the download to cancel' }
            },
            required: ['downloadId']
        },
        handler: async (params) => {
            return await browserManager.cancelDownload(params.downloadId);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'cancel_download',
                downloadId: params.downloadId,
                effect: `Would cancel in-progress download '${params.downloadId}' and clean up partial files`
            };
        }
    });

    // 12. browser_list_downloads
    registry.registerTool({
        id: 'browser_list_downloads',
        name: 'Browser Download Lister',
        description: 'List all tracked browser downloads and their statuses in the current session',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {}
        },
        handler: async () => {
            return browserManager.listDownloads();
        },
        dryRunSimulate: async () => {
            return {
                simulatedAction: 'list_downloads',
                effect: 'Would query and return the list of tracked browser downloads'
            };
        }
    });

    // 13. browser_close
    registry.registerTool({
        id: 'browser_close',
        name: 'Browser Session Closer',
        description: 'Close active browser pages and sessions cleanly',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {}
        },
        handler: async () => {
            await browserManager.closeAll();
            return {
                ok: true,
                status: 'browser_closed',
                verification: { verified: true, method: 'browser_close_confirmation' }
            };
        },
        dryRunSimulate: async () => {
            return {
                simulatedAction: 'close',
                effect: 'Would cleanly close browser context and session'
            };
        }
    });
}

module.exports = {
    registerBrowserTools
};
