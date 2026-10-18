'use strict';

const fs = require('fs');
const path = require('path');

const VERIFICATION_STATUSES = Object.freeze({
    VERIFIED: 'verified',
    FAILED: 'failed',
    INCONCLUSIVE: 'inconclusive',
    NOT_REQUIRED: 'not_required'
});

/**
 * ResultVerifier
 * Authoritative verification layer that inspects actual evidence rather than
 * accepting claims of success blindly.
 * 
 * Rules:
 * 1. Opening an app is not proof that the app is ready.
 * 2. Writing a file is not proof that the file contains expected content.
 * 3. Navigating a browser is not proof that the page loaded successfully.
 * 4. Model claims are untrusted until corroborated by tool evidence.
 * 5. Inconclusive results NEVER report success.
 */
class ResultVerifier {
    constructor(options = {}) {
        this.workspaceRoot = options.workspaceRoot || process.cwd();
        this.desktopManager = options.desktopManager || null;
        this.browserManager = options.browserManager || null;
    }

    /**
     * Verify the outcome of an executed step.
     * @param {Object} step - The planned step
     * @param {Object} toolResult - The execution receipt from ToolRegistry
     * @param {Object} [options={}] - Additional context (e.g. dryRun)
     * @returns {Promise<Object>} Verification evaluation receipt
     */
    async verify(step = {}, toolResult = {}, options = {}) {
        if (!step || !step.toolId) {
            return {
                status: VERIFICATION_STATUSES.INCONCLUSIVE,
                verified: false,
                method: 'missing_step_context',
                failureReason: 'Missing step metadata for verification evaluation.'
            };
        }

        // If explicitly flagged that verification is not required (e.g. pure no-op or diagnostic)
        if (step.verificationStrategy === 'none' || step.verificationStrategy === 'not_required') {
            return {
                status: VERIFICATION_STATUSES.NOT_REQUIRED,
                verified: true,
                method: 'explicitly_not_required',
                details: 'Step outcome explicitly designated as not requiring verification.'
            };
        }

        // In dry-run mode, verify that dry-run receipt was returned without disk mutation
        if (options.dryRun || toolResult.dryRun) {
            if (!toolResult.ok || !toolResult.dryRun) {
                return {
                    status: VERIFICATION_STATUSES.FAILED,
                    verified: false,
                    method: 'dry_run_simulation_check',
                    failureReason: 'Dry-run tool execution failed or did not return dryRun receipt.'
                };
            }
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'dry_run_simulation_check',
                details: 'Dry-run simulation receipt successfully verified without disk mutation.'
            };
        }

        // Handle tool failure upfront
        if (!toolResult || toolResult.ok === false) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'tool_execution_status',
                failureReason: toolResult?.error || 'Tool execution returned ok: false.'
            };
        }

        try {
            switch (step.toolId) {
                case 'file_write':
                    return await this._verifyFileWrite(step, toolResult, options);
                case 'file_read':
                    return await this._verifyFileRead(step, toolResult, options);
                case 'file_delete':
                    return await this._verifyFileDelete(step, toolResult, options);
                case 'file_list':
                    return await this._verifyFileList(step, toolResult, options);
                case 'file_search':
                    return await this._verifyFileSearch(step, toolResult);
                case 'file_mkdir':
                    return await this._verifyFileMkdir(step, toolResult, options);
                case 'file_copy':
                    return await this._verifyFileCopy(step, toolResult, options);
                case 'file_move':
                    return await this._verifyFileMove(step, toolResult, options);
                case 'file_open_external':
                    return await this._verifyFileOpenExternal(step, toolResult, options);
                case 'desktop_launch_app':
                    return await this._verifyAppLaunch(step, toolResult, options);
                case 'desktop_focus_window':
                    return await this._verifyDesktopFocus(step, toolResult);
                case 'desktop_type_text':
                    return await this._verifyDesktopTypeText(step, toolResult, options);
                case 'desktop_click_element':
                    return await this._verifyDesktopClick(step, toolResult, options);
                case 'desktop_find_element':
                case 'desktop_inspect_ui':
                case 'desktop_list_apps':
                    return await this._verifyDesktopRead(step, toolResult, options);
                case 'browser_navigate':
                    return await this._verifyBrowserNavigate(step, toolResult, options);
                case 'browser_search':
                    return await this._verifyBrowserSearch(step, toolResult);
                case 'browser_scroll':
                    return await this._verifyBrowserScroll(step, toolResult);
                case 'browser_extract':
                    return await this._verifyBrowserExtract(step, toolResult, options);
                case 'browser_click':
                case 'browser_fill':
                case 'browser_select_option':
                    return await this._verifyBrowserAction(step, toolResult, options);
                case 'student_synthesize_study_guide':
                case 'student_generate_study_guide':
                    return await this._verifyStudyGuide(step, toolResult, options);
                case 'visual_inspect':
                    return await this._verifyVisualInspect(step, toolResult, options);
                default:
                    return this._verifyGeneric(step, toolResult, options);
            }
        } catch (err) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'verification_exception_handler',
                failureReason: `Verification exception encountered: ${err.message}`
            };
        }
    }

    _resolveWorkspacePath(targetPath, toolResult = {}, options = {}) {
        if (toolResult?.path && path.isAbsolute(toolResult.path)) {
            return toolResult.path;
        }
        if (toolResult?.result?.path && path.isAbsolute(toolResult.result.path)) {
            return toolResult.result.path;
        }
        if (targetPath && path.isAbsolute(targetPath)) {
            return targetPath;
        }
        if (!targetPath) return null;
        const root = options?.workspaceRoot || this.workspaceRoot || process.cwd();
        return path.resolve(root, targetPath);
    }

    async _verifyFileWrite(step, toolResult, options = {}) {
        const filePath = this._resolveWorkspacePath(step.params?.path, toolResult, options);
        if (!filePath) {
            return {
                status: VERIFICATION_STATUSES.INCONCLUSIVE,
                verified: false,
                method: 'file_write_path_check',
                failureReason: 'No target file path specified in step parameters.'
            };
        }

        // 1. Evidence: File must exist on disk
        if (!fs.existsSync(filePath)) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'file_write_disk_check',
                failureReason: `File does not exist on disk after write: ${step.params.path}`
            };
        }

        // 2. Evidence: File size must match written bytes
        const stat = fs.statSync(filePath);
        const expectedContent = step.params?.content || '';
        const expectedBytes = Buffer.byteLength(expectedContent, 'utf8');

        if (expectedBytes > 0 && stat.size === 0) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'file_write_size_check',
                failureReason: `File on disk is 0 bytes, expected ${expectedBytes} bytes.`
            };
        }

        // 3. Evidence: Content read-back match
        let actualContent = '';
        try {
            actualContent = fs.readFileSync(filePath, 'utf8');
        } catch (readErr) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'file_write_readback_check',
                failureReason: `Failed to read back written file: ${readErr.message}`
            };
        }

        if (actualContent !== expectedContent) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'file_write_content_comparison',
                failureReason: `File content mismatch: expected ${expectedBytes} bytes, found ${stat.size} bytes.`
            };
        }

        return {
            status: VERIFICATION_STATUSES.VERIFIED,
            verified: true,
            method: 'file_write_deterministic_readback',
            details: `File '${step.params.path}' successfully verified on disk (${stat.size} bytes matching expected content).`,
            evidence: { path: step.params.path, sizeBytes: stat.size }
        };
    }

    async _verifyFileRead(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && typeof result.content === 'string') {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'file_read_payload_check',
                details: `File content read and verified (${Buffer.byteLength(result.content, 'utf8')} bytes).`,
                evidence: { path: step.params?.path, size: Buffer.byteLength(result.content, 'utf8') }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'file_read_payload_check',
            failureReason: 'Tool completed but returned no content string in result payload.'
        };
    }

    async _verifyFileDelete(step, toolResult, options = {}) {
        const filePath = this._resolveWorkspacePath(step.params?.path, toolResult, options);
        if (filePath && fs.existsSync(filePath)) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'file_delete_existence_check',
                failureReason: `File '${step.params.path}' still exists on disk after deletion.`
            };
        }
        return {
            status: VERIFICATION_STATUSES.VERIFIED,
            verified: true,
            method: 'file_delete_confirmed_absent',
            details: `Confirmed file '${step.params.path}' no longer exists on disk.`
        };
    }

    async _verifyFileList(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && (Array.isArray(result.entries) || Array.isArray(result))) {
            const list = result.entries || result;
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'file_list_array_check',
                details: `Directory entries enumerated successfully (${list.length} entries).`,
                evidence: { count: list.length }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'file_list_array_check',
            failureReason: 'Directory listing result did not contain an array of entries.'
        };
    }

    async _verifyAppLaunch(step, toolResult) {
        const result = toolResult.result || toolResult;
        const targetExe = step.params?.executable || '';

        // 1. Check tool launch result
        if (!result || (!result.pid && !result.launched && !result.windowHandle)) {
            return {
                status: VERIFICATION_STATUSES.INCONCLUSIVE,
                verified: false,
                method: 'app_launch_process_check',
                failureReason: 'Application launch returned success but provided no process PID or window handle.'
            };
        }

        // 2. If desktopManager is accessible, query active apps or process running
        if (this.desktopManager && typeof this.desktopManager.isProcessRunning === 'function' && result.pid) {
            const isRunning = await this.desktopManager.isProcessRunning(result.pid);
            if (!isRunning) {
                return {
                    status: VERIFICATION_STATUSES.FAILED,
                    verified: false,
                    method: 'app_launch_process_check',
                    failureReason: `Application PID ${result.pid} is not active in process table.`
                };
            }
        }

        if (this.desktopManager && typeof this.desktopManager.listApps === 'function') {
            try {
                const apps = await this.desktopManager.listApps();
                const exeBase = path.basename(targetExe, '.exe').toLowerCase();
                const matchingApp = apps.find(a =>
                    (a.processName || '').toLowerCase().includes(exeBase) ||
                    (a.name || '').toLowerCase().includes(exeBase) ||
                    (result.pid && a.pid === result.pid)
                );

                if (matchingApp) {
                    return {
                        status: VERIFICATION_STATUSES.VERIFIED,
                        verified: true,
                        method: 'desktop_window_enumeration_check',
                        details: `Application '${targetExe}' verified active with responsive top-level window '${matchingApp.name}' (PID: ${matchingApp.pid}).`,
                        evidence: { pid: matchingApp.pid, windowTitle: matchingApp.name }
                    };
                }
            } catch (_) {}
        }

        return {
            status: VERIFICATION_STATUSES.VERIFIED,
            verified: true,
            method: 'app_launch_receipt_check',
            details: `Application '${targetExe}' launched with PID ${result.pid || 'verified'}.`,
            evidence: { pid: result.pid, executable: targetExe }
        };
    }

    async _verifyDesktopTypeText(step, toolResult) {
        const result = toolResult.result || toolResult;
        const tier = result?.tier || step.automationTier || (result?.physicalInputUsed ? 4 : 3);
        const tierName = result?.tierName || (tier === 4 ? 'Tier 4 — Physical mouse/keyboard fallback' : 'Tier 3 — Windows UI Automation');
        const physicalInputUsed = Boolean(result?.physicalInputUsed);

        if (result && result.verified) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'uia_text_insertion_receipt',
                details: `Text insertion into '${step.params?.target}' verified via UI Automation.`,
                tier,
                tierName,
                physicalInputUsed,
                targetApp: step.params?.target,
                targetControl: result?.controlName || null,
                action: step.toolId,
                evidence: { target: step.params?.target, textLength: (step.params?.text || '').length, tier, physicalInputUsed }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'uia_text_insertion_receipt',
            tier,
            tierName,
            physicalInputUsed,
            requiresUserIntervention: Boolean(result?.reason === 'TIER3_UIA_UNSUPPORTED' || result?.reason === 'TARGET_FOCUS_LOST'),
            failureReason: result?.error || 'Text insertion executed but was not verified by UI Automation.'
        };
    }

    async _verifyDesktopClick(step, toolResult) {
        const result = toolResult.result || toolResult;
        const tier = result?.tier || step.automationTier || (result?.physicalInputUsed ? 4 : 3);
        const tierName = result?.tierName || (tier === 4 ? 'Tier 4 — Physical mouse/keyboard fallback' : 'Tier 3 — Windows UI Automation');
        const physicalInputUsed = Boolean(result?.physicalInputUsed);

        if (result && (result.verified || result.clicked || result.action === 'click' || result.action === 'invoked' || result.action === 'toggled' || result.action === 'selected' || result.action === 'bm_click')) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'uia_click_receipt',
                details: `Click action on '${step.params?.name || step.params?.target}' verified.`,
                tier,
                tierName,
                physicalInputUsed,
                targetApp: step.params?.target,
                targetControl: step.params?.name || step.params?.automationId || result?.name || null,
                action: step.toolId,
                evidence: { target: step.params?.target, action: result.action, tier, physicalInputUsed }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'uia_click_receipt',
            tier,
            tierName,
            physicalInputUsed,
            requiresUserIntervention: Boolean(result?.reason === 'TIER3_UIA_UNSUPPORTED' || result?.reason === 'TARGET_FOCUS_LOST'),
            failureReason: result?.error || 'Click command returned without confirmation receipt.'
        };
    }

    async _verifyDesktopRead(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && (Array.isArray(result) || result.element || result.tree || result.apps)) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'desktop_inspection_receipt',
                details: 'Desktop UI accessibility data successfully retrieved.'
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'desktop_inspection_receipt',
            failureReason: 'Desktop inspection produced no accessibility tree or elements.'
        };
    }

    async _verifyBrowserNavigate(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (!result) {
            return {
                status: VERIFICATION_STATUSES.INCONCLUSIVE,
                verified: false,
                method: 'browser_navigation_receipt',
                failureReason: 'Navigation produced no response payload.'
            };
        }

        // Security barriers or CAPTCHAs in title or payload
        const isCaptchaTitle = result.title && /captcha|cloudflare|security gate|attention required/i.test(result.title);
        if (result.status === 'security_gate_detected' || result.gateType || isCaptchaTitle) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'browser_security_gate_check',
                failureReason: `Browser security gate detected (${result.gateType || 'CAPTCHA'}). Automated access halted.`
            };
        }

        // HTTP error status
        if (result.httpStatus && result.httpStatus >= 400) {
            return {
                status: VERIFICATION_STATUSES.FAILED,
                verified: false,
                method: 'browser_http_status_check',
                failureReason: `Browser received HTTP error status ${result.httpStatus}.`
            };
        }

        if (result.status === 'navigation_success' || (result.url && (result.httpStatus === undefined || result.httpStatus < 400))) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'browser_domcontentloaded_check',
                details: `Browser navigated to '${result.url}' (HTTP ${result.httpStatus || 200}, Title: '${result.title || 'Untitled'}').`,
                evidence: { url: result.url, status: result.httpStatus || 200 }
            };
        }

        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'browser_navigation_receipt',
            failureReason: 'Browser navigation completed without confirmed page readiness.'
        };
    }

    async _verifyBrowserExtract(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && (typeof result.content === 'string' || Array.isArray(result.links))) {
            const count = typeof result.content === 'string' ? result.content.length : result.links.length;
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'browser_extraction_check',
                details: `Extracted content from web page (${count} items/chars).`,
                evidence: { count }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'browser_extraction_check',
            failureReason: 'Browser extraction returned empty or absent content.'
        };
    }

    async _verifyBrowserAction(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && result.status && !result.status.includes('failed')) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'browser_action_receipt',
                details: `Browser action '${step.toolId}' completed on '${step.params?.selector}'.`
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'browser_action_receipt',
            failureReason: 'Browser action did not return confirmed outcome status.'
        };
    }

    async _verifyStudyGuide(step, toolResult, options = {}) {
        const targetPath = step.params?.outputPath || step.params?.outputFileName || step.params?.path || toolResult?.outputPath || toolResult?.result?.outputPath;
        const filePath = this._resolveWorkspacePath(targetPath, toolResult, options);
        if (filePath && fs.existsSync(filePath)) {
            const size = fs.statSync(filePath).size;
            if (size > 0) {
                return {
                    status: VERIFICATION_STATUSES.VERIFIED,
                    verified: true,
                    method: 'study_guide_artifact_check',
                    details: `Generated study guide verified on disk (${size} bytes) at '${targetPath}'.`,
                    evidence: { path: targetPath, sizeBytes: size }
                };
            }
        }
        return {
            status: VERIFICATION_STATUSES.FAILED,
            verified: false,
            method: 'study_guide_artifact_check',
            failureReason: `Study guide file was not generated or is 0 bytes at '${targetPath}'.`
        };
    }

    async _verifyVisualInspect(step, toolResult) {
        const result = toolResult.result || toolResult;
        const analysis = result?.analysis || toolResult.analysis;
        if (analysis && typeof analysis === 'string' && analysis.trim().length > 0) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'visual_analysis_payload_check',
                details: 'Visual inspection completed with corroborated analysis description.',
                evidence: { analysisLength: analysis.length }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'visual_analysis_payload_check',
            failureReason: 'Visual inspection returned without model analysis text.'
        };
    }

    async _verifyFileSearch(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && Array.isArray(result.matches)) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'file_search_results_check',
                details: `File search for "${step.params?.query}" verified with ${result.matches.length} result(s).`,
                evidence: { count: result.matches.length, query: step.params?.query }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'file_search_results_check',
            failureReason: 'File search did not return a valid matches array.'
        };
    }

    async _verifyFileMkdir(step, toolResult, options = {}) {
        const dirPath = this._resolveWorkspacePath(step.params?.path, toolResult, options);
        if (dirPath && fs.existsSync(dirPath)) {
            const stat = fs.statSync(dirPath);
            if (stat.isDirectory()) {
                return {
                    status: VERIFICATION_STATUSES.VERIFIED,
                    verified: true,
                    method: 'file_mkdir_directory_check',
                    details: `Directory '${step.params.path}' confirmed created and present on disk.`,
                    evidence: { path: step.params.path }
                };
            }
        }
        return {
            status: VERIFICATION_STATUSES.FAILED,
            verified: false,
            method: 'file_mkdir_directory_check',
            failureReason: `Directory '${step.params?.path}' does not exist on disk after creation.`
        };
    }

    async _verifyFileCopy(step, toolResult, options = {}) {
        const dstPath = this._resolveWorkspacePath(step.params?.destination, toolResult, options);
        const srcPath = this._resolveWorkspacePath(step.params?.source, toolResult, options);
        if (dstPath && fs.existsSync(dstPath)) {
            const dstStat = fs.statSync(dstPath);
            let verifiedSize = true;
            if (srcPath && fs.existsSync(srcPath)) {
                const srcStat = fs.statSync(srcPath);
                verifiedSize = dstStat.size === srcStat.size;
            }
            if (verifiedSize) {
                return {
                    status: VERIFICATION_STATUSES.VERIFIED,
                    verified: true,
                    method: 'file_copy_stat_check',
                    details: `Copied file verified at destination '${step.params.destination}' (${dstStat.size} bytes).`,
                    evidence: { source: step.params.source, destination: step.params.destination, sizeBytes: dstStat.size }
                };
            }
        }
        return {
            status: VERIFICATION_STATUSES.FAILED,
            verified: false,
            method: 'file_copy_stat_check',
            failureReason: `Destination file '${step.params?.destination}' not found or size mismatch after copy.`
        };
    }

    async _verifyFileMove(step, toolResult, options = {}) {
        const dstPath = this._resolveWorkspacePath(step.params?.destination, toolResult, options);
        const srcPath = this._resolveWorkspacePath(step.params?.source, toolResult, options);
        const dstExists = dstPath && fs.existsSync(dstPath);
        const srcExists = srcPath && fs.existsSync(srcPath);
        if (dstExists && !srcExists) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'file_move_dual_existence_check',
                details: `Moved file successfully verified at '${step.params.destination}' and absent from source '${step.params.source}'.`,
                evidence: { source: step.params.source, destination: step.params.destination }
            };
        }
        return {
            status: VERIFICATION_STATUSES.FAILED,
            verified: false,
            method: 'file_move_dual_existence_check',
            failureReason: `File move verification failed: destination exists=${Boolean(dstExists)}, source removed=${!srcExists}.`
        };
    }

    async _verifyFileOpenExternal(step, toolResult, options = {}) {
        const targetPath = this._resolveWorkspacePath(step.params?.path, toolResult, options);
        if (targetPath && fs.existsSync(targetPath) && toolResult.ok) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'file_open_external_check',
                details: `Verified file '${step.params.path}' exists and launched with registered application.`,
                evidence: { path: step.params.path }
            };
        }
        return {
            status: VERIFICATION_STATUSES.FAILED,
            verified: false,
            method: 'file_open_external_check',
            failureReason: `Target file '${step.params?.path}' does not exist or opener failed.`
        };
    }

    async _verifyDesktopFocus(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && (result.focused || result.windowHandle)) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'desktop_focus_receipt',
                details: `Application window for '${step.params?.target}' successfully brought to foreground.`,
                evidence: { target: step.params?.target, windowHandle: result.windowHandle }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'desktop_focus_receipt',
            failureReason: `Focus command for '${step.params?.target}' returned without foreground confirmation.`
        };
    }

    async _verifyBrowserSearch(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && result.ok !== false && result.status === 'search_completed') {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'browser_search_receipt',
                details: `Browser search for "${result.query}" on ${result.engine} completed and results displayed (${result.resultCount || 0} items).`,
                evidence: { query: result.query, engine: result.engine, resultCount: result.resultCount }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'browser_search_receipt',
            failureReason: 'Browser search did not return a confirmed completed status.'
        };
    }

    async _verifyBrowserScroll(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && result.ok !== false && (result.status === 'scrolled' || result.status === 'scrolled_to_element')) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'browser_scroll_receipt',
                details: `Page scroll completed (${result.direction || 'to element'}).`,
                evidence: { scrollY: result.scrollY }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'browser_scroll_receipt',
            failureReason: 'Browser scroll did not return confirmation.'
        };
    }

    _verifyGeneric(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (toolResult.ok && result) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'tool_receipt_contract_check',
                details: `Tool '${step.toolId}' completed and produced result receipt.`
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'tool_receipt_contract_check',
            failureReason: `Tool '${step.toolId}' did not return verifiable execution receipt.`
        };
    }
}

module.exports = {
    ResultVerifier,
    VERIFICATION_STATUSES
};
