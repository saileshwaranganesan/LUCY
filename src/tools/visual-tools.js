'use strict';

const fs = require('fs');
const path = require('path');
const { RISK_TIERS } = require('../security/permission-authority.js');

/**
 * Visual Tools Subsystem
 * Connects visual screenshots (desktop & browser) to multimodal AI model inspection.
 * Enables L.U.C.Y. to inspect, explain, locate elements, and verify UI states visually (DEF-003).
 */

function registerVisualTools(registry, options = {}) {
    const { providerAdapter, browserManager, desktopManager } = options;

    // 1. visual_inspect
    registry.registerTool({
        id: 'visual_inspect',
        name: 'Visual Screen Inspector',
        description: 'Analyze an image or screenshot using visual AI understanding to identify UI elements, read visual content, or verify visual state',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The specific question or visual reasoning goal to perform on the image'
                },
                target: {
                    type: 'string',
                    description: 'Source to capture if image is not provided: "browser" for web page, or desktop application name (e.g. "Notepad", "Calculator", "active", "desktop")'
                },
                imageBase64: {
                    type: 'string',
                    description: 'Optional direct base64 image data from a previous screenshot step'
                },
                imagePath: {
                    type: 'string',
                    description: 'Optional local file path to an existing image file'
                }
            },
            required: ['prompt']
        },
        handler: async (params, context = {}) => {
            let base64 = params.imageBase64 || null;
            let mimeType = 'image/png';
            let source = 'provided_base64';

            // 1. Resolve image source from file path if supplied
            if (!base64 && params.imagePath) {
                if (fs.existsSync(params.imagePath)) {
                    try {
                        const buf = fs.readFileSync(params.imagePath);
                        base64 = buf.toString('base64');
                        source = `file:${params.imagePath}`;
                        const ext = path.extname(params.imagePath).toLowerCase();
                        if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                        else if (ext === '.webp') mimeType = 'image/webp';
                        else if (ext === '.gif') mimeType = 'image/gif';
                    } catch (err) {
                        return {
                            ok: false,
                            status: 'file_read_error',
                            error: `Failed to read image file: ${err.message}`
                        };
                    }
                } else {
                    return {
                        ok: false,
                        status: 'file_not_found',
                        error: `Image file not found at path: ${params.imagePath}`
                    };
                }
            }

            // 2. Resolve image source via dynamic capture if not provided
            if (!base64) {
                const targetLower = (params.target || '').toLowerCase().trim();
                const isBrowserTarget = targetLower === 'browser' || targetLower === 'page' || targetLower === 'website' || targetLower === 'tab';

                if (isBrowserTarget && browserManager) {
                    try {
                        const shot = await browserManager.screenshot();
                        if (shot && shot.ok && shot.base64) {
                            base64 = shot.base64;
                            source = 'browser_viewport';
                        }
                    } catch (err) {
                        return {
                            ok: false,
                            status: 'browser_capture_failed',
                            error: `Browser screenshot capture failed: ${err.message}`
                        };
                    }
                } else if (desktopManager) {
                    try {
                        const appTarget = params.target || 'active';
                        const shot = await desktopManager.takeScreenshot(appTarget, {
                            taskId: context?.taskId,
                            signal: context?.signal
                        });
                        const shotBase64 = shot?.base64 || (typeof shot === 'string' ? shot : null);
                        if (shotBase64) {
                            base64 = shotBase64;
                            source = `desktop:${appTarget}`;
                            if (shot.format && shot.format !== 'png') {
                                mimeType = `image/${shot.format}`;
                            }
                        }
                    } catch (err) {
                        return {
                            ok: false,
                            status: 'desktop_capture_failed',
                            error: `Desktop window screenshot capture failed: ${err.message}`
                        };
                    }
                }
            }

            // 3. Fallback check: if capture failed or image is missing
            if (!base64) {
                return {
                    ok: false,
                    status: 'capture_failed',
                    error: `Failed to acquire image for visual inspection. Target: '${params.target || 'unspecified'}'. Ensure target application or browser is open.`
                };
            }

            // 4. Validate AI provider adapter availability
            const adapter = options.providerAdapter || providerAdapter;
            if (!adapter) {
                return {
                    ok: false,
                    status: 'provider_unavailable',
                    error: 'AI Provider Adapter is not configured for visual inspection.'
                };
            }

            // 5. Send multimodal vision request to model
            const visionPrompt = params.prompt || 'Inspect this image and describe the visible user interface elements, text, and active state.';

            const visionRes = await adapter.complete({
                messages: [
                    {
                        role: 'user',
                        content: visionPrompt,
                        images: [{ mimeType, data: base64 }]
                    }
                ],
                signal: context.signal
            });

            if (!visionRes.ok) {
                return {
                    ok: false,
                    status: 'vision_model_error',
                    code: visionRes.code,
                    error: visionRes.error,
                    provider: visionRes.provider,
                    model: visionRes.model,
                    verification: { verified: false, failureReason: visionRes.error }
                };
            }

            return {
                ok: true,
                status: 'visual_analysis_complete',
                source,
                analysis: visionRes.content,
                provider: visionRes.provider,
                model: visionRes.model,
                result: {
                    analysis: visionRes.content,
                    source,
                    provider: visionRes.provider,
                    model: visionRes.model
                },
                verification: {
                    verified: Boolean(visionRes.content && visionRes.content.length > 0),
                    method: 'multimodal_model_vision_analysis'
                }
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'visual_inspect',
                prompt: params.prompt,
                target: params.target || 'screen',
                effect: `Would capture image of '${params.target || 'screen'}' and request visual AI analysis for: "${params.prompt}"`
            };
        }
    });
}

module.exports = {
    registerVisualTools
};
