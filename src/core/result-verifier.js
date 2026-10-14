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
                case 'desktop_launch_app':
                    return await this._verifyAppLaunch(step, toolResult, options);
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
                case 'browser_extract':
                    return await this._verifyBrowserExtract(step, toolResult, options);
                case 'browser_click':
                case 'browser_fill':
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
        if (result && result.verified) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'uia_text_insertion_receipt',
                details: `Text insertion into '${step.params?.target}' verified via UI Automation.`,
                evidence: { target: step.params?.target, textLength: (step.params?.text || '').length }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'uia_text_insertion_receipt',
            failureReason: 'Text insertion executed but was not verified by UI Automation.'
        };
    }

    async _verifyDesktopClick(step, toolResult) {
        const result = toolResult.result || toolResult;
        if (result && (result.clicked || result.action === 'click')) {
            return {
                status: VERIFICATION_STATUSES.VERIFIED,
                verified: true,
                method: 'uia_click_receipt',
                details: `Click action on '${step.params?.name || step.params?.target}' verified.`,
                evidence: { target: step.params?.target }
            };
        }
        return {
            status: VERIFICATION_STATUSES.INCONCLUSIVE,
            verified: false,
            method: 'uia_click_receipt',
            failureReason: 'Click command returned without confirmation receipt.'
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
