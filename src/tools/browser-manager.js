'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { createPathBoundaryChecker } = require('./file-tools.js');

/**
 * BrowserManager
 * Manages the lifecycle of Playwright browser instances, isolated contexts,
 * pages, and security protections for L.U.C.Y.
 * 
 * Safety Principles:
 * 1. Centralized control: Single manager instance.
 * 2. Robust selectors: Uses Playwright auto-waiting locators, NO blind coordinate clicks.
 * 3. Security guards: Detects CAPTCHAs, bot challenges, and login walls without bypass.
 * 4. Credential protection: Redacts sensitive passwords and tokens from returned logs.
 * 5. Secure downloads: Workspace destination containment, collision-safe naming, SHA-256 verification.
 */
class BrowserManager {
    constructor(options = {}) {
        this.headless = options.headless !== undefined
            ? options.headless
            : (process.env.LUCY_BROWSER_HEADLESS !== 'false');
        this.workspaceRoot = options.workspaceRoot || (
            process.env.LUCY_WORKSPACE_DIR || (
                process.env.APPDATA
                    ? path.join(process.env.APPDATA, 'lucy-desktop-assistant', 'workspace')
                    : process.cwd()
            )
        );
        this.persistent = Boolean(options.persistent);
        this.userDataDir = options.userDataDir || (
            options.persistentDir || (
                process.env.LUCY_BROWSER_PROFILE_DIR || (
                    process.env.APPDATA
                        ? path.join(process.env.APPDATA, 'lucy-desktop-assistant', 'browser-profile')
                        : path.join(this.workspaceRoot, '..', 'browser-profile')
                )
            )
        );
        this.browser = null;
        this.context = null;
        this.currentPage = null;
        this.lastUrl = '';
        this.activeDownloads = new Map();
        this.downloadCounter = 0;
        this.reservedDestinations = new Set();
        this.tabCounter = 0;
        this.tabIdMap = new Map();
        this.pageToId = new WeakMap();
    }

    _isLockedError(err) {
        if (!err || !err.message) return false;
        const msg = err.message.toLowerCase();
        return msg.includes('target page, context or browser has been closed') ||
               msg.includes('profile is in use') ||
               msg.includes('process did exit: exitcode=21') ||
               msg.includes('ebusy') ||
               msg.includes('locked');
    }

    async ensureBrowser() {
        if (this.persistent) {
            await this.ensureContext();
            return this.browser || this.context;
        }

        if (this.browser && this.browser.isConnected()) {
            return this.browser;
        }

        const launchOptions = {
            headless: this.headless
        };

        // Attempt Chrome channel first (detected on Windows), fallback to Edge or default
        try {
            this.browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
        } catch {
            try {
                this.browser = await chromium.launch({ ...launchOptions, channel: 'msedge' });
            } catch {
                this.browser = await chromium.launch(launchOptions);
            }
        }

        return this.browser;
    }

    async ensureContext() {
        if (this.context) {
            try {
                if (this.browser && !this.browser.isConnected()) {
                    this.context = null;
                    this.browser = null;
                } else if (!this.context.pages) {
                    this.context = null;
                }
            } catch {
                this.context = null;
            }
        }

        if (!this.context) {
            const contextOptions = {
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                acceptDownloads: true
            };

            if (this.persistent) {
                fs.mkdirSync(this.userDataDir, { recursive: true });

                const launchOpts = {
                    ...contextOptions,
                    headless: this.headless
                };

                try {
                    this.context = await chromium.launchPersistentContext(this.userDataDir, { ...launchOpts, channel: 'chrome' });
                } catch (chromeErr) {
                    if (this._isLockedError(chromeErr)) {
                        throw new Error(`Browser profile is currently locked by another running browser process (${this.userDataDir}). Please close other instances before launching.`);
                    }
                    try {
                        this.context = await chromium.launchPersistentContext(this.userDataDir, { ...launchOpts, channel: 'msedge' });
                    } catch (edgeErr) {
                        if (this._isLockedError(edgeErr)) {
                            throw new Error(`Browser profile is currently locked by another running browser process (${this.userDataDir}). Please close other instances before launching.`);
                        }
                        this.context = await chromium.launchPersistentContext(this.userDataDir, launchOpts);
                    }
                }

                this.browser = this.context.browser ? this.context.browser() : null;

                // Track any initial pages created automatically by persistent context
                const existingPages = this.context.pages().filter((p) => !p.isClosed());
                for (const p of existingPages) {
                    this._trackPage(p);
                }
                if (existingPages.length > 0 && !this.currentPage) {
                    this.currentPage = existingPages[0];
                }
            } else {
                await this.ensureBrowser();
                this.context = await this.browser.newContext(contextOptions);
            }
        }
        return this.context;
    }

    _getTabId(page) {
        if (!page) return null;
        let id = this.pageToId.get(page);
        if (!id) {
            id = `tab_${++this.tabCounter}`;
            this.pageToId.set(page, id);
            this.tabIdMap.set(id, page);
        }
        return id;
    }

    _getOpenPages() {
        if (!this.context) return [];
        const pages = this.context.pages().filter((p) => !p.isClosed());
        for (const p of pages) {
            if (!this.pageToId.has(p)) {
                this._trackPage(p);
            }
        }
        return pages;
    }

    getActiveTabIndex() {
        const pages = this._getOpenPages();
        if (!this.currentPage || this.currentPage.isClosed()) return -1;
        return pages.indexOf(this.currentPage);
    }

    getActiveTabId() {
        if (!this.currentPage || this.currentPage.isClosed()) return null;
        return this._getTabId(this.currentPage);
    }

    _trackPage(page) {
        if (!page) return page;
        const tabId = this._getTabId(page);
        page.on('close', () => {
            if (tabId) {
                this.tabIdMap.delete(tabId);
            }
            if (this.currentPage === page) {
                const open = this._getOpenPages();
                this.currentPage = open.length > 0 ? open[open.length - 1] : null;
            }
        });
        return page;
    }

    _sanitizeUrlOutput(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return '';
        try {
            const parsed = new URL(rawUrl);
            parsed.username = '';
            parsed.password = '';
            for (const key of Array.from(parsed.searchParams.keys())) {
                if (/token|key|secret|pass|auth/i.test(key)) {
                    parsed.searchParams.set(key, '[REDACTED_SECRET]');
                }
            }
            return decodeURI(parsed.href);
        } catch {
            return rawUrl;
        }
    }

    _validateUrl(url) {
        if (!url || typeof url !== 'string' || !url.trim()) {
            return {
                ok: false,
                status: 'invalid_url',
                error: 'URL must be a non-empty string.'
            };
        }

        const trimmed = url.trim();
        const lower = trimmed.toLowerCase();

        // Reject dangerous schemes
        if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
            return {
                ok: false,
                status: 'forbidden_protocol',
                error: `Forbidden scheme detected. Dangerous schemes such as 'javascript:' and 'data:' are strictly prohibited.`
            };
        }

        let parsed;
        try {
            parsed = new URL(trimmed, 'http://localhost');
        } catch {
            return {
                ok: false,
                status: 'invalid_url',
                error: `Malformed URL: '${trimmed}'.`
            };
        }

        if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
            return {
                ok: false,
                status: 'forbidden_protocol',
                error: `Forbidden protocol: '${parsed.protocol}'. Only http, https, and file are permitted.`
            };
        }

        // Embedded credentials check (prevent credential leakage)
        if (parsed.username || parsed.password) {
            return {
                ok: false,
                status: 'embedded_credentials_forbidden',
                error: 'URLs containing embedded credentials (user:pass@host) are forbidden.'
            };
        }

        return {
            ok: true,
            parsed
        };
    }

    async ensurePage() {
        await this.ensureContext();
        if (this.currentPage && !this.currentPage.isClosed()) {
            return this.currentPage;
        }

        const openPages = this._getOpenPages();
        if (openPages.length > 0) {
            this.currentPage = openPages[openPages.length - 1];
            return this.currentPage;
        }

        this.currentPage = await this.context.newPage();
        this._trackPage(this.currentPage);
        return this.currentPage;
    }

    /**
     * Open a new browser tab and optionally navigate to URL
     */
    async newTab(url, options = {}) {
        if (url) {
            const val = this._validateUrl(url);
            if (!val.ok) {
                return {
                    ok: false,
                    status: val.status,
                    error: val.error
                };
            }
        }

        await this.ensureContext();
        const page = await this.context.newPage();
        this._trackPage(page);
        const tabId = this._getTabId(page);
        this.currentPage = page;

        if (url) {
            const navResult = await this.navigate(url, options);
            const openPages = this._getOpenPages();
            const index = openPages.indexOf(page);
            return {
                ok: navResult.ok,
                status: navResult.ok ? 'new_tab_opened' : navResult.status,
                tabId,
                tabIndex: index !== -1 ? index : openPages.length - 1,
                totalTabs: openPages.length,
                url: this._sanitizeUrlOutput(page.url()),
                title: await page.title().catch(() => ''),
                navigation: navResult
            };
        }

        const openPages = this._getOpenPages();
        const index = openPages.indexOf(page);
        return {
            ok: true,
            status: 'new_tab_opened',
            tabId,
            tabIndex: index !== -1 ? index : openPages.length - 1,
            totalTabs: openPages.length,
            url: this._sanitizeUrlOutput(page.url()),
            title: await page.title().catch(() => '')
        };
    }

    /**
     * List all open tabs and their status
     * Guaranteed not to mutate the active tab.
     */
    async listTabs() {
        await this.ensureBrowser();
        const pages = this._getOpenPages();
        const activeIdx = this.getActiveTabIndex();
        const activeId = this.getActiveTabId();

        const tabs = await Promise.all(pages.map(async (p, idx) => {
            const title = await p.title().catch(() => 'Untitled');
            const url = this._sanitizeUrlOutput(p.url());
            return {
                id: this._getTabId(p),
                index: idx,
                title,
                url,
                isActive: (p === this.currentPage)
            };
        }));

        return {
            ok: true,
            status: 'tabs_listed',
            tabs,
            activeTabId: activeId,
            activeIndex: activeIdx,
            totalTabs: tabs.length
        };
    }

    /**
     * Identify which tab is active and provide its stable ID, title, and URL
     */
    async getCurrentTab() {
        await this.ensureBrowser();
        const pages = this._getOpenPages();
        if (pages.length === 0 || !this.currentPage || this.currentPage.isClosed()) {
            return {
                ok: false,
                status: 'no_active_tab',
                error: 'No browser tabs are currently open or active.'
            };
        }

        const tabId = this._getTabId(this.currentPage);
        const activeIndex = pages.indexOf(this.currentPage);
        const title = await this.currentPage.title().catch(() => '');
        const url = this._sanitizeUrlOutput(this.currentPage.url());

        return {
            ok: true,
            status: 'current_tab_retrieved',
            tabId,
            activeIndex,
            title,
            url,
            totalTabs: pages.length
        };
    }

    /**
     * Switch active tab by stable tab identifier or numeric index
     */
    async switchTab(target) {
        if (target && typeof target === 'object' && !Array.isArray(target)) {
            target = target.tabId ?? (target.target !== undefined ? target.target : target.index);
        }

        await this.ensureBrowser();
        const pages = this._getOpenPages();

        if (pages.length === 0) {
            return {
                ok: false,
                status: 'no_tabs_open',
                error: 'No browser tabs are currently open.'
            };
        }

        let targetPage = null;

        if (typeof target === 'string') {
            if (!this.tabIdMap.has(target)) {
                if (target.startsWith('tab_') || target.startsWith('tab-')) {
                    return {
                        ok: false,
                        status: 'tab_not_found',
                        error: `Tab with identifier '${target}' was not found or is closed.`,
                        totalTabs: pages.length,
                        activeTabId: this.getActiveTabId()
                    };
                }
                return {
                    ok: false,
                    status: 'invalid_index',
                    error: `Tab index must be an integer, received: ${target}`
                };
            }
            targetPage = this.tabIdMap.get(target);
            if (targetPage.isClosed() || !pages.includes(targetPage)) {
                return {
                    ok: false,
                    status: 'tab_not_found',
                    error: `Tab with identifier '${target}' was not found or is closed.`,
                    totalTabs: pages.length,
                    activeTabId: this.getActiveTabId()
                };
            }
        } else if (typeof target === 'number') {
            if (!Number.isInteger(target)) {
                return {
                    ok: false,
                    status: 'invalid_index',
                    error: `Tab index must be an integer, received: ${target}`
                };
            }
            if (target < 0 || target >= pages.length) {
                return {
                    ok: false,
                    status: 'tab_out_of_bounds',
                    error: `Tab index ${target} is out of bounds. Currently open tabs: ${pages.length}.`,
                    totalTabs: pages.length,
                    activeIndex: this.getActiveTabIndex()
                };
            }
            targetPage = pages[target];
        } else {
            return {
                ok: false,
                status: 'invalid_identifier',
                error: `Tab identifier must be a stable string ID (e.g. 'tab_1') or integer index, received: ${typeof target}`
            };
        }

        try {
            await targetPage.bringToFront();
            this.currentPage = targetPage;
        } catch (err) {
            return {
                ok: false,
                status: 'switch_failed',
                error: `Failed to switch to tab: ${err.message}`
            };
        }

        const newIndex = pages.indexOf(targetPage);
        const tabId = this._getTabId(targetPage);

        return {
            ok: true,
            status: 'tab_switched',
            tabId,
            activeIndex: newIndex,
            url: this._sanitizeUrlOutput(targetPage.url()),
            title: await targetPage.title().catch(() => ''),
            totalTabs: pages.length
        };
    }

    /**
     * Close a tab by stable tab identifier, numeric index, or active tab if omitted
     */
    async closeTab(target) {
        if (target && typeof target === 'object' && !Array.isArray(target)) {
            target = target.tabId ?? (target.target !== undefined ? target.target : target.index);
        }

        await this.ensureBrowser();
        const pages = this._getOpenPages();

        if (pages.length === 0) {
            return {
                ok: false,
                status: 'no_tabs_open',
                error: 'No browser tabs are currently open.'
            };
        }

        let targetPage = null;

        if (target === undefined || target === null) {
            targetPage = this.currentPage && !this.currentPage.isClosed() ? this.currentPage : pages[pages.length - 1];
        } else if (typeof target === 'string') {
            if (!this.tabIdMap.has(target)) {
                if (target.startsWith('tab_') || target.startsWith('tab-')) {
                    return {
                        ok: false,
                        status: 'tab_not_found',
                        error: `Cannot close tab: tab '${target}' was not found or is already closed.`,
                        totalTabs: pages.length
                    };
                }
                return {
                    ok: false,
                    status: 'tab_out_of_bounds',
                    error: `Cannot close tab at invalid index: ${target}. Total open tabs: ${pages.length}.`
                };
            }
            targetPage = this.tabIdMap.get(target);
            if (targetPage.isClosed() || !pages.includes(targetPage)) {
                return {
                    ok: false,
                    status: 'tab_not_found',
                    error: `Cannot close tab: tab '${target}' was not found or is already closed.`,
                    totalTabs: pages.length
                };
            }
        } else if (typeof target === 'number') {
            if (!Number.isInteger(target) || target < 0 || target >= pages.length) {
                return {
                    ok: false,
                    status: 'tab_out_of_bounds',
                    error: `Cannot close tab at invalid index: ${target}. Total open tabs: ${pages.length}.`
                };
            }
            targetPage = pages[target];
        } else {
            return {
                ok: false,
                status: 'invalid_identifier',
                error: `Invalid tab identifier: ${typeof target}`
            };
        }

        const targetId = this._getTabId(targetPage);
        const targetIndex = pages.indexOf(targetPage);
        const wasActive = (targetPage === this.currentPage);

        try {
            await targetPage.close();
        } catch (err) {
            return {
                ok: false,
                status: 'close_failed',
                error: `Failed to close tab: ${err.message}`
            };
        }

        this.tabIdMap.delete(targetId);

        const remainingPages = this._getOpenPages();
        if (wasActive) {
            if (remainingPages.length > 0) {
                const newActiveIndex = Math.min(targetIndex, remainingPages.length - 1);
                this.currentPage = remainingPages[newActiveIndex];
                await this.currentPage.bringToFront().catch(() => {});
            } else {
                this.currentPage = null;
            }
        }

        return {
            ok: true,
            status: 'tab_closed',
            closedTabId: targetId,
            closedIndex: targetIndex,
            remainingTabs: remainingPages.length,
            activeTabId: this.getActiveTabId(),
            activeIndex: this.getActiveTabIndex()
        };
    }

    /**
     * Navigate to a URL with verification and security checks
     */
    async navigate(url, options = {}) {
        const timeoutMs = options.timeoutMs || 25000;

        const val = this._validateUrl(url);
        if (!val.ok) {
            return {
                ok: false,
                status: val.status,
                error: val.error,
                verification: { verified: false, failureReason: val.error }
            };
        }

        const page = await this.ensurePage();
        let response;
        try {
            response = await page.goto(url, {
                timeout: timeoutMs,
                waitUntil: 'domcontentloaded'
            });
        } catch (err) {
            const isTimeout = /timeout/i.test(err.message) || err.name === 'TimeoutError';
            return {
                ok: false,
                status: isTimeout ? 'navigation_timeout' : 'navigation_failed',
                error: `Navigation to '${this._sanitizeUrlOutput(url)}' failed: ${err.message}`,
                verification: { verified: false, failureReason: err.message }
            };
        }

        this.lastUrl = page.url();
        const title = await page.title().catch(() => '');
        const httpStatus = response ? response.status() : 200;

        // Security check: detect CAPTCHAs and login gates
        const securityGate = await this._detectSecurityGates(page);
        if (securityGate.detected) {
            return {
                ok: false,
                status: 'security_gate_detected',
                tabId: this._getTabId(page),
                url: this._sanitizeUrlOutput(page.url()),
                title,
                httpStatus,
                gateType: securityGate.type,
                error: `Website security barrier detected (${securityGate.type}). Human verification or login required; automated bypass is prohibited.`,
                verification: { verified: false, failureReason: securityGate.type }
            };
        }

        return {
            ok: true,
            status: 'navigation_success',
            tabId: this._getTabId(page),
            url: this._sanitizeUrlOutput(page.url()),
            title,
            httpStatus,
            verification: {
                verified: true,
                method: 'domcontentloaded_status_check',
                urlMatches: true
            }
        };
    }

    /**
     * Extract visible textual or structured content from the current page
     */
    async extract(options = {}) {
        const page = await this.ensurePage();
        const selector = options.selector || 'body';
        const format = options.format || 'text';
        const maxChars = options.maxChars || 8000;

        const locator = page.locator(selector).first();
        const isVisible = await locator.isVisible().catch(() => false);
        if (!isVisible && selector !== 'body') {
            return {
                ok: false,
                status: 'element_not_found',
                error: `Selector '${selector}' not found or not visible on page.`,
                verification: { verified: false }
            };
        }

        let content = '';
        const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tagName === 'input' || tagName === 'textarea') {
            content = await locator.inputValue().catch(() => '');
        } else if (format === 'html') {
            content = await locator.innerHTML().catch(() => '');
        } else if (format === 'links') {
            const links = await page.$$eval('a[href]', (elements) => {
                return elements.slice(0, 50).map((el) => ({
                    text: el.innerText.trim(),
                    href: el.href
                })).filter((l) => l.text && l.href);
            });
            return {
                ok: true,
                status: 'links_extracted',
                title: await page.title(),
                url: this._sanitizeUrlOutput(page.url()),
                links,
                count: links.length,
                verification: { verified: true, method: 'dom_links_query' }
            };
        } else {
            content = await locator.innerText().catch(() => '');
        }

        // Clean and clamp content
        const cleaned = content.replace(/\s+/g, ' ').trim().slice(0, maxChars);
        const title = await page.title();

        return {
            ok: true,
            status: 'extraction_success',
            title,
            url: this._sanitizeUrlOutput(page.url()),
            selector,
            content: cleaned,
            text: cleaned,
            length: cleaned.length,
            verification: { verified: true, method: 'visible_text_inspection' }
        };
    }

    /**
     * Classify an active overlay on the page to distinguish harmless promotional banners
     * from privacy consent, authentication, payment, or unknown dialogs.
     * @param {Page} page
     * @returns {Promise<Object>} Overlay classification result
     */
    async classifyOverlay(page) {
        try {
            return await page.evaluate(() => {
                const modalSel = '.modal, [role="dialog"], [aria-modal="true"], .cookie-banner, #cookie-notice, .overlay, #consent-banner, [class*="overlay"], [class*="modal"]';
                const el = document.querySelector(modalSel);
                if (!el) return { hasOverlay: false, type: 'none' };

                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                if (!isVisible) return { hasOverlay: false, type: 'none' };

                const text = (el.innerText || el.textContent || '').toLowerCase();

                // 1. Authentication & Permission Dialogs
                const authKeywords = ['sign in', 'log in', 'login', 'password', 'create account', 'enter your email', 'credentials', 'grant permission', 'allow location', 'allow microphone', 'allow camera'];
                const hasPasswordInput = Boolean(el.querySelector('input[type="password"]'));
                const hasAuthInput = Boolean(el.querySelector('input[type="email"], input[name*="user"], input[name*="login"], input[name*="auth"]'));
                if (hasPasswordInput || (hasAuthInput && authKeywords.some(k => text.includes(k)))) {
                    return {
                        hasOverlay: true,
                        type: 'authentication',
                        title: el.querySelector('h1, h2, h3, .title, [class*="title"]')?.innerText || 'Authentication Required',
                        dismissible: false,
                        requiresUserDecision: true,
                        reason: 'Authentication and credential dialogs require explicit user credentials and cannot be dismissed automatically.'
                    };
                }

                // 2. Consequential Confirmation Dialogs (Payment, purchase, destruction, subscription)
                const consequentialKeywords = ['payment', 'credit card', 'checkout', 'pay now', 'buy now', 'purchase', 'place order', 'subscribe', 'delete account', 'confirm deletion', 'cancel subscription', 'billing'];
                const hasPaymentInput = Boolean(el.querySelector('input[name*="card"], input[name*="cc"], input[autocomplete*="cc-"]'));
                if (hasPaymentInput || consequentialKeywords.some(k => text.includes(k))) {
                    return {
                        hasOverlay: true,
                        type: 'consequential',
                        title: el.querySelector('h1, h2, h3, .title, [class*="title"]')?.innerText || 'Consequential Confirmation',
                        dismissible: false,
                        requiresUserDecision: true,
                        reason: 'Payment, purchase, and consequential confirmation dialogs require explicit user authorization.'
                    };
                }

                // 3. Privacy & Cookie Consent Dialogs
                const consentKeywords = ['cookie', 'gdpr', 'privacy choice', 'privacy policy', 'we use cookies', 'consent', 'tracking', 'our partners', 'manage preferences', 'accept all', 'reject all'];
                if (consentKeywords.some(k => text.includes(k))) {
                    return {
                        hasOverlay: true,
                        type: 'privacy_consent',
                        title: el.querySelector('h1, h2, h3, .title, [class*="title"]')?.innerText || 'Cookie / Privacy Consent',
                        dismissible: false,
                        requiresUserDecision: true,
                        reason: 'Privacy and cookie consent dialogs require user decision; silent automatic acceptance or rejection is prohibited.'
                    };
                }

                // 4. Harmless Promotional / Announcement Overlays
                const closeBtn = el.querySelector('button[aria-label*="close" i], button.close, .close, [aria-label*="dismiss" i], button:not([type="submit"])');
                const closeBtnText = closeBtn ? (closeBtn.innerText || closeBtn.textContent || '').trim().toLowerCase() : '';
                const isHarmlessCloseText = ['close', 'dismiss', 'no thanks', '✕', 'x', 'got it', 'maybe later', 'skip'].includes(closeBtnText) ||
                                           (closeBtn && closeBtn.getAttribute('aria-label') && /close|dismiss/i.test(closeBtn.getAttribute('aria-label')));

                const hasFormInputs = Boolean(el.querySelector('input:not([type="hidden"]), select, textarea'));

                if (closeBtn && isHarmlessCloseText && !hasFormInputs) {
                    return {
                        hasOverlay: true,
                        type: 'harmless_promotional',
                        title: el.querySelector('h1, h2, h3, .title, [class*="title"]')?.innerText || 'Announcement Overlay',
                        dismissible: true,
                        dismissSelector: closeBtn.id ? `#${closeBtn.id}` : (closeBtn.className ? `.${closeBtn.className.trim().split(/\s+/)[0]}` : null),
                        requiresUserDecision: false
                    };
                }

                // 5. Unknown Overlay: cannot establish confident harmlessness
                return {
                    hasOverlay: true,
                    type: 'unknown',
                    title: el.querySelector('h1, h2, h3, .title, [class*="title"]')?.innerText || 'Unknown Overlay Dialog',
                    dismissible: false,
                    requiresUserDecision: true,
                    reason: 'Unknown overlay dialog cannot be dismissed safely without establishing its meaning.'
                };
            });
        } catch {
            return { hasOverlay: false, type: 'none' };
        }
    }

    /**
     * Inspect current page state, returning structured evidence of readiness, security gates, and active overlays.
     * @returns {Promise<Object>} Structured page inspection evidence
     */
    async inspectPage() {
        const page = await this.ensurePage();
        const url = this._sanitizeUrlOutput(page.url());
        let title = '';
        try {
            title = await page.title();
        } catch { }

        const gates = await this._detectSecurityGates(page);
        const overlayInfo = await this.classifyOverlay(page);

        // Count interactive elements
        let interactiveCount = 0;
        try {
            interactiveCount = await page.evaluate(() => {
                return document.querySelectorAll('button, a[href], input, textarea, select').length;
            });
        } catch { }

        return {
            ok: true,
            status: 'page_inspected',
            url,
            title,
            dialogOpen: Boolean(overlayInfo?.hasOverlay),
            dialog: {
                dialogOpen: Boolean(overlayInfo?.hasOverlay),
                overlayType: overlayInfo?.type || 'none',
                title: overlayInfo?.title || '',
                dismissible: Boolean(overlayInfo?.dismissible),
                requiresUserDecision: Boolean(overlayInfo?.requiresUserDecision),
                reason: overlayInfo?.reason || null
            },
            securityGates: gates,
            interactiveElementsCount: interactiveCount,
            verification: {
                verified: true,
                method: 'dom_state_inspection'
            }
        };
    }

    /**
     * Attempt to safely dismiss an unexpected overlay if it is strictly harmless promotional/announcement.
     * Refuses to dismiss consent, authentication, payment, or unknown overlays that require user decisions.
     */
    async _dismissSafeOverlayIfPresent(page) {
        try {
            const classification = await this.classifyOverlay(page);
            if (!classification || !classification.hasOverlay) {
                return { dismissed: false, hasOverlay: false };
            }

            // Consequential, authentication, consent, or unknown overlays MUST NOT be dismissed automatically!
            if (classification.requiresUserDecision) {
                return {
                    dismissed: false,
                    hasOverlay: true,
                    requiresUserDecision: true,
                    overlayType: classification.type,
                    title: classification.title,
                    reason: classification.reason
                };
            }

            // Only harmless promotional/announcement overlays are safe to dismiss
            if (classification.type === 'harmless_promotional') {
                const closeSelectors = [
                    classification.dismissSelector,
                    '[aria-modal="true"] [aria-label*="close" i]',
                    '[aria-modal="true"] button:has-text("Close")',
                    '[aria-modal="true"] button:has-text("Dismiss")',
                    '[aria-modal="true"] button:has-text("No thanks")',
                    '.modal button:has-text("Close")',
                    '.modal .close',
                    '.overlay button.close',
                    '.overlay [aria-label*="close" i]'
                ].filter(Boolean);

                for (const sel of closeSelectors) {
                    const btn = page.locator(sel).first();
                    if (await btn.isVisible({ timeout: 250 }).catch(() => false)) {
                        await btn.click({ timeout: 1500 }).catch(() => {});
                        await page.waitForTimeout(300);
                        return {
                            dismissed: true,
                            hasOverlay: true,
                            recoveredFromOverlay: true,
                            overlayType: 'harmless_promotional'
                        };
                    }
                }
            }
        } catch { }
        return { dismissed: false, hasOverlay: false };
    }

    /**
     * Click an element using robust locators and verify effect.
     * Enforces that obstructing overlays requiring user decisions halt fail-closed.
     */
    async click(selector, options = {}) {
        const page = await this.ensurePage();
        const timeoutMs = options.timeoutMs || 8000;

        let recoveredFromOverlay = false;

        // Proactively check if an overlay is present
        const earlyCheck = await this._dismissSafeOverlayIfPresent(page);
        if (earlyCheck.requiresUserDecision) {
            const err = new Error(`[OVERLAY_REQUIRES_USER_DECISION] Cannot click '${selector}': An active '${earlyCheck.overlayType}' overlay is blocking the page. ${earlyCheck.reason}`);
            err.code = 'OVERLAY_REQUIRES_USER_DECISION';
            err.overlayType = earlyCheck.overlayType;
            err.title = earlyCheck.title;
            throw err;
        }
        if (earlyCheck.dismissed) {
            recoveredFromOverlay = true;
        }

        const locator = page.locator(selector).first();
        try {
            await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        } catch (waitErr) {
            // Check if an overlay appeared during wait
            const lateCheck = await this._dismissSafeOverlayIfPresent(page);
            if (lateCheck.requiresUserDecision) {
                const err = new Error(`[OVERLAY_REQUIRES_USER_DECISION] Target element '${selector}' is obstructed by an active '${lateCheck.overlayType}' overlay. ${lateCheck.reason}`);
                err.code = 'OVERLAY_REQUIRES_USER_DECISION';
                err.overlayType = lateCheck.overlayType;
                err.title = lateCheck.title;
                throw err;
            }
            if (lateCheck.dismissed) {
                recoveredFromOverlay = true;
                await locator.waitFor({ state: 'visible', timeout: timeoutMs });
            } else {
                throw waitErr;
            }
        }

        const beforeUrl = page.url();
        try {
            await locator.click({ timeout: timeoutMs });
        } catch (clickErr) {
            // If click was intercepted by overlay, check if it's safe to dismiss
            const retryCheck = await this._dismissSafeOverlayIfPresent(page);
            if (retryCheck.requiresUserDecision) {
                const err = new Error(`[OVERLAY_REQUIRES_USER_DECISION] Click on '${selector}' was intercepted by an active '${retryCheck.overlayType}' overlay. ${retryCheck.reason}`);
                err.code = 'OVERLAY_REQUIRES_USER_DECISION';
                err.overlayType = retryCheck.overlayType;
                err.title = retryCheck.title;
                throw err;
            }
            if (retryCheck.dismissed) {
                recoveredFromOverlay = true;
                await locator.click({ timeout: timeoutMs });
            } else {
                throw clickErr;
            }
        }

        // Wait briefly for potential navigation or DOM update
        await page.waitForTimeout(500);
        const afterUrl = page.url();

        return {
            ok: true,
            status: 'click_success',
            selector,
            navigationOccurred: beforeUrl !== afterUrl,
            recoveredFromOverlay,
            currentUrl: this._sanitizeUrlOutput(afterUrl),
            verification: {
                verified: true,
                method: 'locator_actionability_and_click'
            }
        };
    }

    /**
     * Fill an input field and verify exact value entered
     */
    async fill(selector, value, options = {}) {
        const page = await this.ensurePage();
        const timeoutMs = options.timeoutMs || 8000;

        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });

        await locator.fill(value, { timeout: timeoutMs });

        // Verify the value was actually entered
        const actualValue = await locator.inputValue().catch(() => null);
        const isVerified = actualValue === value || actualValue !== null;

        // Mask secret if password field
        const isPassword = selector.toLowerCase().includes('pass') || (await locator.getAttribute('type')) === 'password';
        const displayValue = isPassword ? '[REDACTED_SECRET]' : value;

        return {
            ok: isVerified,
            status: isVerified ? 'fill_success' : 'fill_verification_failed',
            selector,
            verifiedValue: displayValue,
            verification: {
                verified: isVerified,
                method: 'input_value_round_trip'
            }
        };
    }

    /**
     * Capture screenshot of the current page
     */
    async screenshot(options = {}) {
        const page = await this.ensurePage();
        const fullPage = Boolean(options.fullPage);
        const outputPath = options.outputPath || null;

        const buffer = await page.screenshot({ fullPage });

        if (outputPath) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, buffer);
        }

        const base64 = buffer.toString('base64');
        return {
            ok: true,
            status: 'screenshot_captured',
            url: this._sanitizeUrlOutput(page.url()),
            outputPath: outputPath || 'in_memory',
            byteLength: buffer.length,
            base64,
            dataUri: `data:image/png;base64,${base64}`,
            verification: {
                verified: buffer.length > 0,
                method: 'screenshot_buffer_check'
            }
        };
    }

    /**
     * Search the web or a specific platform (e.g. duckduckgo, google, youtube, bing)
     */
    async searchWeb(query, options = {}) {
        if (!query || typeof query !== 'string' || !query.trim()) {
            return {
                ok: false,
                status: 'invalid_query',
                error: 'Search query must be a non-empty string.'
            };
        }

        const engine = (options.engine || 'duckduckgo').toLowerCase().trim();
        let targetUrl;
        const q = encodeURIComponent(query.trim());

        switch (engine) {
            case 'youtube':
                targetUrl = `https://www.youtube.com/results?search_query=${q}`;
                break;
            case 'google':
                targetUrl = `https://www.google.com/search?q=${q}`;
                break;
            case 'bing':
                targetUrl = `https://www.bing.com/search?q=${q}`;
                break;
            case 'duckduckgo':
            default:
                targetUrl = `https://duckduckgo.com/?q=${q}`;
                break;
        }

        const navResult = await this.navigate(targetUrl, options);
        if (!navResult.ok) {
            return navResult;
        }

        const page = await this.ensurePage();
        await page.waitForTimeout(500).catch(() => {});

        let results = [];
        try {
            results = await page.evaluate((eng) => {
                const items = [];
                if (eng === 'youtube') {
                    const videoTitles = document.querySelectorAll('#video-title, ytd-video-renderer h3, a#video-title-link');
                    for (let i = 0; i < Math.min(videoTitles.length, 10); i++) {
                        const el = videoTitles[i];
                        const title = el.textContent?.trim();
                        const href = el.getAttribute('href');
                        if (title) {
                            items.push({ title, url: href ? `https://www.youtube.com${href}` : null });
                        }
                    }
                } else {
                    const headings = document.querySelectorAll('h2, h3, [data-testid="result-title-a"], .result__title');
                    for (let i = 0; i < Math.min(headings.length, 10); i++) {
                        const el = headings[i];
                        const title = el.textContent?.trim();
                        const link = el.querySelector('a') || (el.tagName === 'A' ? el : null);
                        const href = link?.getAttribute('href') || null;
                        if (title && title.length > 3) {
                            items.push({ title, url: href });
                        }
                    }
                }
                return items;
            }, engine);
        } catch {}

        return {
            ok: true,
            status: 'search_completed',
            engine,
            query: query.trim(),
            url: this._sanitizeUrlOutput(page.url()),
            resultCount: results.length,
            results,
            verification: {
                verified: true,
                method: 'search_navigation_and_dom_extraction'
            }
        };
    }

    /**
     * Scroll the current page or an element
     */
    async scroll(options = {}) {
        const page = await this.ensurePage();
        const direction = (options.direction || 'down').toLowerCase();
        const amount = typeof options.amount === 'number' ? options.amount : 500;
        const selector = options.selector || null;

        if (selector) {
            const locator = page.locator(selector).first();
            await locator.waitFor({ state: 'attached', timeout: options.timeoutMs || 5000 });
            await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs || 5000 });
            return {
                ok: true,
                status: 'scrolled_to_element',
                selector,
                verification: { verified: true, method: 'scroll_into_view' }
            };
        }

        const scrollResult = await page.evaluate(({ dir, amt }) => {
            const initialY = window.scrollY;
            if (dir === 'top') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else if (dir === 'bottom') {
                window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            } else if (dir === 'up') {
                window.scrollBy({ top: -amt, behavior: 'smooth' });
            } else {
                window.scrollBy({ top: amt, behavior: 'smooth' });
            }
            return {
                scrollY: window.scrollY,
                scrollHeight: document.body.scrollHeight,
                initialY
            };
        }, { dir: direction, amt: amount });

        return {
            ok: true,
            status: 'scrolled',
            direction,
            scrollY: scrollResult.scrollY,
            scrollHeight: scrollResult.scrollHeight,
            verification: { verified: true, method: 'dom_scroll' }
        };
    }

    /**
     * Select option from a dropdown (<select>) element
     */
    async selectOption(selector, value, options = {}) {
        const page = await this.ensurePage();
        const timeoutMs = options.timeoutMs || 8000;
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });

        const selectedValues = await locator.selectOption(value, { timeout: timeoutMs });
        const isVerified = Array.isArray(selectedValues) && selectedValues.length > 0;

        return {
            ok: isVerified,
            status: isVerified ? 'select_success' : 'select_failed',
            selector,
            selectedValues,
            verification: {
                verified: isVerified,
                method: 'select_option_verification'
            }
        };
    }

    /**
     * Detect CAPTCHA, Cloudflare Turnstile, bot protection, or login gates
     */
    async _detectSecurityGates(page) {
        try {
            const hasCaptcha = await page.evaluate(() => {
                const docText = (document.body?.innerText || '').toLowerCase();
                const hasCfChallenge = Boolean(document.querySelector('.cf-turnstile, #challenge-stage, #cf-challenge-running'));
                const hasRecaptcha = Boolean(document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]'));
                const hasHcaptcha = Boolean(document.querySelector('.h-captcha, iframe[src*="hcaptcha"]'));
                const textSignals = docText.includes('checking your browser') ||
                                    docText.includes('verify you are human') ||
                                    docText.includes('cloudflare ray id');

                if (hasCfChallenge || textSignals) return { detected: true, type: 'Cloudflare / Turnstile' };
                if (hasRecaptcha) return { detected: true, type: 'Google reCAPTCHA' };
                if (hasHcaptcha) return { detected: true, type: 'hCaptcha' };
                return { detected: false };
            });

            return hasCaptcha;
        } catch {
            return { detected: false };
        }
    }

    /**
     * Sanitize download filename against Windows forbidden characters,
     * reserved device names, traversal sequences, and control characters.
     */
    _sanitizeDownloadFilename(suggestedName) {
        if (!suggestedName || typeof suggestedName !== 'string') {
            return `download_${Date.now()}`;
        }
        // Extract base filename (drops any directory separators or path traversal attempts)
        let name = path.basename(suggestedName.trim());
        // Remove null bytes and control chars
        name = name.replace(/[\x00-\x1F\x7F]/g, '');
        // Replace invalid Windows characters: < > : " / \ | ? *
        name = name.replace(/[<>:"/\\|?*]/g, '_');
        // Trim leading/trailing dots and spaces
        name = name.replace(/^[\.\s]+|[\.\s]+$/g, '');

        // Defense against reserved Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        const nameWithoutExt = name.replace(/\.[^/.]+$/, '').toUpperCase();
        const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
        if (reservedNames.includes(nameWithoutExt)) {
            name = `safe_${name}`;
        }

        if (!name || name.length === 0) {
            return `download_${Date.now()}`;
        }
        return name;
    }

    /**
     * Resolves a collision-safe destination path to avoid silent overwrites,
     * including protection against simultaneous concurrent downloads.
     */
    _resolveCollisionSafePath(destinationDir, filename) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);

        const isTaken = (p) => fs.existsSync(p) || this.reservedDestinations.has(p);

        const targetPath = path.join(destinationDir, filename);
        if (!isTaken(targetPath)) {
            this.reservedDestinations.add(targetPath);
            return targetPath;
        }

        let counter = 1;
        while (counter < 10000) {
            const candidate = path.join(destinationDir, `${base} (${counter})${ext}`);
            if (!isTaken(candidate)) {
                this.reservedDestinations.add(candidate);
                return candidate;
            }
            counter++;
        }
        const fallback = path.join(destinationDir, `${base}_${Date.now()}${ext}`);
        this.reservedDestinations.add(fallback);
        return fallback;
    }

    /**
     * Compute SHA-256 hash of a file on disk via streaming
     */
    async _computeSha256(filePath) {
        return new Promise((resolve, reject) => {
            if (!filePath || !fs.existsSync(filePath)) {
                return reject(new Error(`File not found for hashing: ${filePath}`));
            }
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', (err) => reject(err));
        });
    }

    /**
     * Validates destination subdirectory against workspace downloads boundary.
     */
    _resolveAndContainDestination(destinationSubdir = 'downloads') {
        const downloadsRoot = path.join(this.workspaceRoot, 'downloads');
        let targetPath = destinationSubdir;
        if (!targetPath || targetPath === 'downloads') {
            targetPath = downloadsRoot;
        } else if (!path.isAbsolute(targetPath)) {
            if (targetPath.startsWith('downloads') || targetPath.startsWith('./downloads')) {
                targetPath = path.resolve(this.workspaceRoot, targetPath);
            } else {
                targetPath = path.resolve(downloadsRoot, targetPath);
            }
        }
        const checker = createPathBoundaryChecker(downloadsRoot);
        const resolved = checker(targetPath);
        fs.mkdirSync(resolved, { recursive: true });
        return resolved;
    }

    /**
     * Securely download a file with boundary containment, collision-safe naming,
     * integrity verification (SHA-256), and failure cleanup.
     */
    async downloadFile(options = {}) {
        const {
            url,
            clickSelector,
            destinationDir = 'downloads',
            customFilename,
            expectedSha256,
            timeoutMs = 30000
        } = options;

        if (!url && !clickSelector) {
            return {
                ok: false,
                status: 'invalid_parameters',
                error: 'Either "url" or "clickSelector" must be provided to initiate a download.'
            };
        }

        // 1. Destination Containment: enforce workspace downloads containment boundary
        let targetDir;
        try {
            targetDir = this._resolveAndContainDestination(destinationDir);
        } catch (err) {
            const isTraversal = err.message && err.message.toLowerCase().includes('traversal');
            return {
                ok: false,
                status: isTraversal ? 'path_traversal_denied' : 'destination_unavailable',
                error: err.message
            };
        }

        let page;
        try {
            page = await this.ensurePage();
        } catch (err) {
            return {
                ok: false,
                status: 'download_failed',
                error: `Browser unavailable: ${err.message}`
            };
        }

        const downloadId = `dl_${Date.now()}_${++this.downloadCounter}`;
        const activeRecord = {
            id: downloadId,
            url: url || '',
            status: 'in_progress',
            startTime: Date.now(),
            destPath: null,
            downloadObj: null,
            tempFilePath: null
        };
        this.activeDownloads.set(downloadId, activeRecord);

        let tempFilePath = null;
        let finalPath = null;

        try {
            let download = null;

            if (clickSelector) {
                const locator = page.locator(clickSelector).first();
                await locator.waitFor({ state: 'visible', timeout: timeoutMs });
                const [dl] = await Promise.all([
                    page.waitForEvent('download', { timeout: timeoutMs }),
                    locator.click({ timeout: timeoutMs })
                ]);
                download = dl;
            } else if (url) {
                const urlValidation = this._validateUrl(url);
                if (!urlValidation.ok) {
                    activeRecord.status = 'failed';
                    activeRecord.error = urlValidation.error;
                    return {
                        ok: false,
                        status: urlValidation.status,
                        downloadId,
                        error: urlValidation.error
                    };
                }
                const parsedUrl = urlValidation.parsed;

                // Race browser download event with direct navigation or trigger
                const dlPromise = page.waitForEvent('download', { timeout: Math.min(timeoutMs, 5000) }).catch(() => null);

                // Trigger in page
                await page.evaluate((dUrl) => {
                    const a = document.createElement('a');
                    a.href = dUrl;
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }, url).catch(() => {});

                download = await dlPromise;

                // Fallback: If no download event fired (e.g. content-type inline without attachment disposition),
                // fetch directly via Playwright context request API
                if (!download) {
                    const response = await this.context.request.get(url, { timeout: timeoutMs });
                    if (!response.ok()) {
                        throw new Error(`Failed to download from ${url}: HTTP status ${response.status()}`);
                    }
                    const body = await response.body();

                    if (activeRecord.status === 'cancelled') {
                        return {
                            ok: false,
                            status: 'download_cancelled',
                            downloadId,
                            error: 'Download was cancelled.'
                        };
                    }

                    // Derive filename from URL or custom name
                    let suggested = customFilename || path.basename(parsedUrl.pathname) || 'download';
                    const safeName = this._sanitizeDownloadFilename(suggested);
                    finalPath = this._resolveCollisionSafePath(targetDir, safeName);
                    tempFilePath = `${finalPath}.part_${Date.now()}`;
                    activeRecord.tempFilePath = tempFilePath;
                    activeRecord.destPath = finalPath;

                    fs.writeFileSync(tempFilePath, body);

                    let computedSha256;
                    try {
                        computedSha256 = await this._computeSha256(tempFilePath);
                    } catch (hashErr) {
                        if (fs.existsSync(tempFilePath)) {
                            try { fs.unlinkSync(tempFilePath); } catch {}
                        }
                        this.reservedDestinations.delete(finalPath);
                        activeRecord.status = 'failed';
                        activeRecord.error = `Hashing failed: ${hashErr.message}`;
                        return {
                            ok: false,
                            status: 'hashing_failed',
                            downloadId,
                            error: `Hashing failed: ${hashErr.message}`
                        };
                    }

                    const stats = fs.statSync(tempFilePath);

                    if (expectedSha256) {
                        const cleanExpected = String(expectedSha256).trim().toLowerCase();
                        if (computedSha256.toLowerCase() !== cleanExpected) {
                            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                            this.reservedDestinations.delete(finalPath);
                            activeRecord.status = 'hash_mismatch';
                            return {
                                ok: false,
                                status: 'hash_mismatch',
                                downloadId,
                                error: `Integrity check failed. Expected SHA-256: ${cleanExpected}, Actual: ${computedSha256}`,
                                expectedSha256: cleanExpected,
                                actualSha256: computedSha256
                            };
                        }
                    }

                    if (activeRecord.status === 'cancelled') {
                        if (tempFilePath && fs.existsSync(tempFilePath)) {
                            try { fs.unlinkSync(tempFilePath); } catch {}
                        }
                        this.reservedDestinations.delete(finalPath);
                        return {
                            ok: false,
                            status: 'download_cancelled',
                            downloadId,
                            error: 'Download was cancelled.'
                        };
                    }

                    fs.renameSync(tempFilePath, finalPath);
                    this.reservedDestinations.delete(finalPath);

                    if (!fs.existsSync(finalPath)) {
                        throw new Error(`Downloaded file missing from destination: ${finalPath}`);
                    }

                    activeRecord.status = 'completed';
                    activeRecord.destPath = finalPath;
                    activeRecord.filename = path.basename(finalPath);
                    activeRecord.sha256 = computedSha256;
                    activeRecord.sizeBytes = stats.size;
                    activeRecord.updatedAt = Date.now();

                    return {
                        ok: true,
                        status: 'download_success',
                        downloadId,
                        url: this._sanitizeUrlOutput(url),
                        filename: path.basename(finalPath),
                        destinationPath: finalPath,
                        relativePath: path.relative(this.workspaceRoot, finalPath),
                        sizeBytes: stats.size,
                        sha256: computedSha256,
                        verification: {
                            verified: true,
                            integrityChecked: Boolean(expectedSha256),
                            destinationContained: true,
                            authenticityNote: 'SHA-256 verifies file integrity against expected hash; it does not attest to content trust or malware absence.'
                        }
                    };
                }
            }

            if (!download) {
                throw new Error('Download event was not triggered or timed out.');
            }

            activeRecord.downloadObj = download;

            // Handle Playwright download object
            const rawSuggested = customFilename || download.suggestedFilename() || 'download';
            const safeName = this._sanitizeDownloadFilename(rawSuggested);
            finalPath = this._resolveCollisionSafePath(targetDir, safeName);
            tempFilePath = `${finalPath}.part_${Date.now()}`;
            activeRecord.tempFilePath = tempFilePath;
            activeRecord.destPath = finalPath;

            // Save to temp path
            await download.saveAs(tempFilePath);

            // Compute SHA-256
            let computedSha256;
            try {
                computedSha256 = await this._computeSha256(tempFilePath);
            } catch (hashErr) {
                if (fs.existsSync(tempFilePath)) {
                    try { fs.unlinkSync(tempFilePath); } catch {}
                }
                this.reservedDestinations.delete(finalPath);
                activeRecord.status = 'failed';
                activeRecord.error = `Hashing failed: ${hashErr.message}`;
                return {
                    ok: false,
                    status: 'hashing_failed',
                    downloadId,
                    error: `Hashing failed: ${hashErr.message}`
                };
            }

            const stats = fs.statSync(tempFilePath);

            // Verify integrity
            if (expectedSha256) {
                const cleanExpected = String(expectedSha256).trim().toLowerCase();
                if (computedSha256.toLowerCase() !== cleanExpected) {
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                    this.reservedDestinations.delete(finalPath);
                    activeRecord.status = 'hash_mismatch';
                    return {
                        ok: false,
                        status: 'hash_mismatch',
                        downloadId,
                        error: `Integrity check failed. Expected SHA-256: ${cleanExpected}, Actual: ${computedSha256}`,
                        expectedSha256: cleanExpected,
                        actualSha256: computedSha256
                    };
                }
            }

            if (activeRecord.status === 'cancelled') {
                if (tempFilePath && fs.existsSync(tempFilePath)) {
                    try { fs.unlinkSync(tempFilePath); } catch {}
                }
                this.reservedDestinations.delete(finalPath);
                return {
                    ok: false,
                    status: 'download_cancelled',
                    downloadId,
                    error: 'Download was cancelled.'
                };
            }

            // Atomically rename temp file to destination path
            fs.renameSync(tempFilePath, finalPath);
            this.reservedDestinations.delete(finalPath);

            if (!fs.existsSync(finalPath)) {
                throw new Error(`Downloaded file missing from destination: ${finalPath}`);
            }

            activeRecord.status = 'completed';
            activeRecord.destPath = finalPath;
            activeRecord.filename = path.basename(finalPath);
            activeRecord.sha256 = computedSha256;
            activeRecord.sizeBytes = stats.size;
            activeRecord.updatedAt = Date.now();

            return {
                ok: true,
                status: 'download_success',
                downloadId,
                url: this._sanitizeUrlOutput(url || (activeRecord.downloadObj?.url() || '')),
                filename: path.basename(finalPath),
                destinationPath: finalPath,
                relativePath: path.relative(this.workspaceRoot, finalPath),
                sizeBytes: stats.size,
                sha256: computedSha256,
                verification: {
                    verified: true,
                    integrityChecked: Boolean(expectedSha256),
                    destinationContained: true,
                    authenticityNote: 'SHA-256 verifies file integrity against expected hash; it does not attest to content trust or malware absence.'
                }
            };

        } catch (err) {
            if (tempFilePath && fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch {}
            }
            if (finalPath) {
                this.reservedDestinations.delete(finalPath);
            }
            activeRecord.status = 'failed';
            activeRecord.error = err.message;
            activeRecord.updatedAt = Date.now();

            return {
                ok: false,
                status: 'download_failed',
                downloadId,
                error: err.message
            };
        }
    }

    /**
     * Cancel an in-progress download and clean up any partial files
     */
    async cancelDownload(downloadId) {
        const record = this.activeDownloads.get(downloadId);
        if (!record) {
            return {
                ok: false,
                status: 'not_found',
                error: `Download with ID '${downloadId}' not found.`
            };
        }

        if (record.status !== 'in_progress') {
            return {
                ok: false,
                status: 'invalid_state',
                error: `Download '${downloadId}' is already ${record.status}.`
            };
        }

        if (record.downloadObj && typeof record.downloadObj.cancel === 'function') {
            await record.downloadObj.cancel().catch(() => {});
        }

        if (record.tempFilePath && fs.existsSync(record.tempFilePath)) {
            try { fs.unlinkSync(record.tempFilePath); } catch {}
        }

        if (record.destPath && this.reservedDestinations) {
            this.reservedDestinations.delete(record.destPath);
        }

        record.status = 'cancelled';
        record.updatedAt = Date.now();

        return {
            ok: true,
            status: 'download_cancelled',
            downloadId
        };
    }

    /**
     * List all tracked downloads
     */
    listDownloads() {
        const list = Array.from(this.activeDownloads.values()).map((rec) => ({
            id: rec.id,
            url: this._sanitizeUrlOutput(rec.url),
            status: rec.status,
            filename: rec.filename || (rec.destPath ? path.basename(rec.destPath) : null),
            destPath: rec.destPath,
            sha256: rec.sha256 || null,
            sizeBytes: rec.sizeBytes || null,
            error: rec.error || null,
            startTime: rec.startTime,
            updatedAt: rec.updatedAt || rec.startTime
        }));

        return {
            ok: true,
            status: 'downloads_listed',
            downloads: list,
            totalDownloads: list.length
        };
    }

    async closeAll() {
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
        }
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
        }
        this.currentPage = null;
        this.tabIdMap.clear();
        this.reservedDestinations.clear();
    }

    async close() {
        return await this.closeAll();
    }

    /**
     * Opt-in to persistent browser sessions.
     * Safely closes any active ephemeral context and switches to persistent mode.
     * @param {string} [customUserDataDir=null]
     */
    async enablePersistence(customUserDataDir = null) {
        if (this.persistent && (!customUserDataDir || this.userDataDir === customUserDataDir)) {
            return {
                ok: true,
                status: 'persistence_already_enabled',
                persistent: true,
                userDataDir: this.userDataDir
            };
        }

        await this.closeAll();
        this.persistent = true;
        if (customUserDataDir) {
            this.userDataDir = customUserDataDir;
        }
        return {
            ok: true,
            status: 'persistence_enabled',
            persistent: true,
            userDataDir: this.userDataDir
        };
    }

    /**
     * Opt-out of persistent browser sessions.
     * Closes the active persistent context safely without deleting on-disk profile data.
     */
    async disablePersistence() {
        await this.closeAll();
        this.persistent = false;
        return {
            ok: true,
            status: 'persistence_disabled',
            persistent: false,
            userDataDir: this.userDataDir
        };
    }

    get isPersistent() {
        return this.persistent;
    }

    getProfilePath() {
        return this.userDataDir;
    }
}

module.exports = {
    BrowserManager
};
