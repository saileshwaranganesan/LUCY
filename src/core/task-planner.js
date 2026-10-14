'use strict';

/**
 * TaskPlanner (REQ-033)
 * Interprets user intent, evaluates limitations honestly, and generates a structured plan
 * using registered tools and parameters.
 * 
 * Enhancements:
 * 1. Intent classification across system info, files, desktop automation, browser, memory, and conversation.
 * 2. Robust entity extraction for paths, applications, selectors, and text parameters.
 * 3. Proactive clarification when required parameters are missing or ambiguous.
 * 4. Contradiction detection (e.g. conflicting directives).
 * 5. Prompt injection defense (blocks instructions attempting to override safety gates).
 * 6. Multi-step task decomposition for compound instructions.
 * 7. Verification of tool IDs against registered ToolRegistry schemas.
 * 8. Transparent reporting of unsupported capabilities.
 * 9. Support for incremental streaming during conversational synthesis.
 */

const PROMPT_INJECTION_PATTERNS = [
    /ignore\s+(?:all\s+)?previous\s+instructions/i,
    /disregard\s+(?:all\s+)?(?:safety\s+)?(?:rules|instructions)/i,
    /system\s+override\s*:/i,
    /bypass\s+(?:all\s+)?(?:permission|security)\s+(?:gates|checks)/i,
    /you\s+are\s+now\s+in\s+unrestricted\s+mode/i,
    /pretend\s+you\s+have\s+no\s+safety\s+rules/i
];

const UNSUPPORTED_DOMAINS = [
    /\b(?:order\s+pizza|order\s+food|delivery)\b/i,
    /\b(?:book\s+a\s+flight|reserve\s+hotel)\b/i,
    /\b(?:send\s+(?:real\s+)?money|wire\s+funds|transfer\s+cash)\b/i,
    /\b(?:mine\s+crypto|mine\s+bitcoin)\b/i,
    /\b(?:hack\s+into|ddos\s+|crack\s+password)\b/i
];

const { classifyTextIntent } = require('./content-discriminator.js');
const { validateToolArguments } = require('../tools/schema-validator.js');
const { RISK_TIERS } = require('../security/permission-authority.js');

class TaskPlanner {
    constructor(options = {}) {
        this.providerAdapter = options.providerAdapter;
        this.toolRegistry = options.toolRegistry;
    }

    /**
     * Plan a task based on user request
     * @param {string} userRequest
     * @param {Object} [context={}]
     * @returns {Promise<Object>} Structured plan with steps and limitations
     */
    async plan(userRequest, context = {}) {
        const availableTools = this.toolRegistry ? this.toolRegistry.listTools() : [];
        const trimmedRequest = String(userRequest || '').trim();

        if (!trimmedRequest) {
            return {
                objective: '',
                type: 'clarification',
                replyText: 'How can I assist you today? Please provide an instruction or question.',
                steps: []
            };
        }

        // 1. Prompt Injection Defense (SEC-008 & REQ-033)
        for (const pattern of PROMPT_INJECTION_PATTERNS) {
            if (pattern.test(trimmedRequest)) {
                return {
                    objective: trimmedRequest,
                    type: 'security_rejection',
                    replyText: 'Safety Policy Violation: Suspected prompt injection or unauthorized system override instruction detected. Request halted fail-closed.',
                    steps: [],
                    securityBlocked: true
                };
            }
        }

        // 2. Unsupported Capabilities Recognition
        for (const pattern of UNSUPPORTED_DOMAINS) {
            if (pattern.test(trimmedRequest)) {
                return {
                    objective: trimmedRequest,
                    type: 'unsupported',
                    replyText: 'This capability is not supported by L.U.C.Y. I specialize in Windows desktop automation, safe file operations, web browsing, and system inspection.',
                    steps: []
                };
            }
        }

        // 3. Ambiguity & Contradiction Detection
        const contradiction = this._detectContradictions(trimmedRequest);
        if (contradiction) {
            return {
                objective: trimmedRequest,
                type: 'clarification',
                replyText: contradiction,
                ambiguous: true,
                steps: []
            };
        }

        // 4. Missing Parameter Clarification
        const missingParamClarification = this._checkMissingParameters(trimmedRequest);
        if (missingParamClarification) {
            return missingParamClarification;
        }

        // 5. Multi-Step Compound Intent Recognition
        const compoundPlan = this._detectCompoundIntent(trimmedRequest, availableTools);
        if (compoundPlan) {
            if (compoundPlan.isGenerativeIntent) {
                return await this._planGenerativeCompoundTask(compoundPlan, context, availableTools);
            }
            return this._validatePlanSteps(compoundPlan, availableTools);
        }

        // 6. Direct Single-Intent Recognition
        const directPlan = this._detectDirectIntent(trimmedRequest, availableTools);
        if (directPlan) {
            return this._validatePlanSteps(directPlan, availableTools);
        }

        // 7. LLM Reasoning for complex or conversational requests
        if (this.providerAdapter && this.providerAdapter.resolveApiKey()) {
            try {
                // If it looks like a pure conversational query (e.g. "What is...", "Explain...", "Hi", "Who are you"),
                // allow the provider to stream directly if onChunk is provided.
                const isInformational = this._isInformationalQuery(trimmedRequest);

                if (isInformational && typeof context.onChunk === 'function') {
                    const res = await this.providerAdapter.complete({
                        messages: [
                            {
                                role: 'system',
                                content: 'You are L.U.C.Y., an intelligent, concise personal desktop assistant and celestial familiar on Windows. Answer the user helpfully and concisely.'
                            },
                            { role: 'user', content: trimmedRequest }
                        ],
                        signal: context.signal,
                        onChunk: context.onChunk
                    });

                    if (!res.ok) {
                        return {
                            objective: trimmedRequest,
                            type: res.cancelled ? 'cancelled' : 'provider_error',
                            replyText: res.error || `AI Provider (${this.providerAdapter.provider}) request failed.`,
                            providerError: res.error,
                            steps: []
                        };
                    }

                    return {
                        objective: trimmedRequest,
                        type: 'conversation',
                        replyText: res.content,
                        steps: []
                    };
                }

                // Structured plan synthesis via Native Tool Calling or Fallback
                const toolsPrompt = availableTools.map((t) => `${t.id}: ${t.description}`).join('\n');
                const systemPrompt = `You are the planning engine for L.U.C.Y., an autonomous Windows desktop assistant.
Given the user request, break it down into explicit tool execution steps or provide an answer.
Available tools:
${toolsPrompt}

Respond strictly in JSON if tool execution is required:
{
  "objective": "...",
  "type": "plan" | "conversation" | "clarification",
  "replyText": "...",
  "steps": [
    {
      "title": "...",
      "toolId": "...",
      "params": { ... },
      "expectedOutcome": "..."
    }
  ]
}`;
                const res = await this.providerAdapter.complete({
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: trimmedRequest }
                    ],
                    tools: availableTools,
                    signal: context.signal
                });

                if (!res.ok) {
                    return {
                        objective: trimmedRequest,
                        type: res.cancelled ? 'cancelled' : 'provider_error',
                        replyText: `AI Provider (${this.providerAdapter.provider}) request failed: ${res.error}. Paid provider fallback is disabled.`,
                        providerError: res.error,
                        steps: []
                    };
                }

                // 1. Native Structured Tool Calls from model
                if (res.hasToolCalls && Array.isArray(res.toolCalls) && res.toolCalls.length > 0) {
                    const steps = res.toolCalls.map((tc, idx) => ({
                        index: idx + 1,
                        title: `Execute ${tc.name}`,
                        toolId: tc.name,
                        params: tc.arguments || {},
                        expectedOutcome: `Completed ${tc.name}`
                    }));
                    const synthesizedPlan = {
                        objective: trimmedRequest,
                        type: 'plan',
                        replyText: res.content || `Planned ${steps.length} tool execution step(s).`,
                        steps
                    };
                    return this._validatePlanSteps(synthesizedPlan, availableTools);
                }

                // 2. Structured JSON Fallback Parsing
                if (res.content) {
                    const parsed = this._extractJson(res.content);
                    if (parsed && (parsed.steps || parsed.replyText)) {
                        const synthesizedPlan = {
                            objective: parsed.objective || trimmedRequest,
                            type: parsed.type || (parsed.steps?.length ? 'plan' : 'conversation'),
                            replyText: parsed.replyText || '',
                            steps: parsed.steps || []
                        };
                        return this._validatePlanSteps(synthesizedPlan, availableTools);
                    }

                    // Direct text answer from provider
                    return {
                        objective: trimmedRequest,
                        type: 'conversation',
                        replyText: res.content,
                        steps: []
                    };
                }
            } catch (err) {
                return {
                    objective: trimmedRequest,
                    type: 'provider_error',
                    replyText: `AI Provider (${this.providerAdapter.provider}) failed: ${err.message}.`,
                    providerError: err.message,
                    steps: []
                };
            }
        }

        // 8. Fallback when no provider is configured
        const hasKey = this.providerAdapter ? Boolean(this.providerAdapter.resolveApiKey()) : false;
        if (!hasKey) {
            return {
                objective: trimmedRequest,
                type: 'unconfigured_provider',
                replyText: `No AI provider is currently configured with an API key. I can perform verified offline commands (such as "inspect system status", "list files", or desktop app commands), but natural language reasoning requires an AI provider. You can configure one in Provider Settings (Google Gemini, OpenRouter, local Ollama, or Hugging Face).`,
                needsConfig: true,
                steps: []
            };
        }

        return {
            objective: trimmedRequest,
            type: 'conversation',
            replyText: `I have received your request: "${trimmedRequest}". I am ready to perform authorized tasks on your computer.`,
            steps: []
        };
    }

    _detectContradictions(request) {
        const lower = request.toLowerCase();
        if ((lower.includes('delete') || lower.includes('remove')) && (lower.includes('keep') || lower.includes('do not delete') || lower.includes("don't delete"))) {
            return 'This request contains contradictory instructions (both deleting and keeping the file). Please clarify your intended goal.';
        }
        if (lower.includes('open editor') || lower.includes('launch editor')) {
            return 'Multiple text editors are available (e.g. Notepad). Did you mean Notepad or another application?';
        }
        return null;
    }

    _checkMissingParameters(request) {
        const lower = request.toLowerCase().trim();

        // "write file" or "create file" with no path or content
        if (/^(?:write|create)\s+file\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'Please specify the filename and the content you would like me to write.',
                missingParameters: ['path', 'content'],
                steps: []
            };
        }

        // "read file" or "view file" with no path
        if (/^(?:read|view|inspect)\s+file\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'Which file would you like me to read? Please provide the relative file path.',
                missingParameters: ['path'],
                steps: []
            };
        }

        // "delete file" or "remove file" with no path
        if (/^(?:delete|remove)\s+file\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'Which file would you like me to delete? Please specify the target path.',
                missingParameters: ['path'],
                steps: []
            };
        }

        // "open app" or "launch app" with no app name
        if (/^(?:open|launch|start)\s+app(?:lication)?\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'Which application would you like me to open? (e.g. Notepad, Calculator)',
                missingParameters: ['application'],
                steps: []
            };
        }

        // "type in notepad" with no text
        if (/^(?:type|enter\s+text)\s+(?:in|into)\s+notepad\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'What text would you like me to enter into Notepad?',
                missingParameters: ['text'],
                steps: []
            };
        }

        // "switch tab" with no index
        if (/^(?:switch\s+(?:to\s+)?tab)\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'Which tab would you like to switch to? Please specify the tab index.',
                missingParameters: ['index'],
                steps: []
            };
        }

        // "download file" with no URL
        if (/^(?:download|download\s+file)\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'Which file or URL would you like me to download? Please provide the download URL.',
                missingParameters: ['url'],
                steps: []
            };
        }

        // "cancel download" with no downloadId
        if (/^cancel\s+download\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: 'Which download would you like me to cancel? Please specify the download ID.',
                missingParameters: ['downloadId'],
                steps: []
            };
        }

        return null;
    }

    _isInformationalQuery(request) {
        const lower = request.toLowerCase();
        return (
            lower.startsWith('what is') ||
            lower.startsWith('what are') ||
            lower.startsWith('who is') ||
            lower.startsWith('why is') ||
            lower.startsWith('how do') ||
            lower.startsWith('explain') ||
            lower.startsWith('tell me about') ||
            lower === 'hello' ||
            lower === 'hi' ||
            lower === 'hey' ||
            lower === 'who are you'
        );
    }

    _detectCompoundIntent(request, tools) {
        const lower = request.toLowerCase();

        // 1. "open notepad and type <text>"
        const notepadTypeMatch = request.match(/(?:open|launch|start)\s+notepad\s+(?:and|then)\s+(?:type|enter|write)\s+(['"]?)([\s\S]+?)\1(?:\s+(?:in|into)\s+notepad)?$/i);
        if (notepadTypeMatch) {
            const wasQuoted = Boolean(notepadTypeMatch[1]);
            const rawText = notepadTypeMatch[2].trim();
            const classification = classifyTextIntent(rawText, request, wasQuoted);

            if (classification.type === 'GENERATIVE') {
                return {
                    isGenerativeIntent: true,
                    objective: `Launch Notepad and type composed ${classification.prompt}`,
                    app: 'notepad.exe',
                    target: 'Notepad',
                    generativePrompt: classification.prompt
                };
            }

            const textToType = classification.text;
            return {
                objective: `Launch Notepad and enter text "${textToType}"`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'Launch Notepad application',
                        toolId: 'desktop_launch_app',
                        params: { executable: 'notepad.exe' },
                        expectedOutcome: 'Notepad open on interactive desktop'
                    },
                    {
                        index: 2,
                        title: `Type "${textToType}" into Notepad`,
                        toolId: 'desktop_type_text',
                        params: { target: 'Notepad', text: textToType },
                        expectedOutcome: 'Text entered and verified via UI Automation'
                    }
                ]
            };
        }

        // 2. "create file <path> with content <content> and read it back"
        const writeReadMatch = request.match(/(?:write|create)\s+file\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?\s+with\s+content\s+(['"]?)([\s\S]+?)\2\s+(?:and|then)\s+(?:read\s+(?:it|the\s+file|file)|verify)/i);
        if (writeReadMatch) {
            const targetPath = writeReadMatch[1].trim();
            const wasQuoted = Boolean(writeReadMatch[2]);
            const rawContent = writeReadMatch[3].trim();
            const classification = classifyTextIntent(rawContent, request, wasQuoted);

            if (classification.type === 'GENERATIVE') {
                return {
                    isGenerativeIntent: true,
                    isFileWrite: true,
                    targetPath,
                    generativePrompt: classification.prompt
                };
            }

            const content = classification.text;
            return {
                objective: `Create file '${targetPath}' and read back contents`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Write file: ${targetPath}`,
                        toolId: 'file_write',
                        params: { path: targetPath, content },
                        expectedOutcome: 'File created and verified within workspace'
                    },
                    {
                        index: 2,
                        title: `Read file: ${targetPath}`,
                        toolId: 'file_read',
                        params: { path: targetPath },
                        expectedOutcome: 'File content read and verified matching written content'
                    }
                ]
            };
        }

        // 3. "navigate to <url> and extract text"
        const navExtractMatch = request.match(/(?:navigate\s+to|open\s+url|browse)\s+['"]?((?:https?:\/\/|file:\/\/|127\.0\.0\.1|localhost)[^\s'"]+)['"]?\s+(?:and|then)\s+(?:extract\s+text|read\s+page|scrape)/i);
        if (navExtractMatch) {
            const targetUrl = navExtractMatch[1].trim();
            return {
                objective: `Navigate to ${targetUrl} and extract visible text`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Navigate to ${targetUrl}`,
                        toolId: 'browser_navigate',
                        params: { url: targetUrl },
                        expectedOutcome: 'Page loaded'
                    },
                    {
                        index: 2,
                        title: 'Extract visible text from page',
                        toolId: 'browser_extract',
                        params: { selector: 'body', format: 'text' },
                        expectedOutcome: 'Page text extracted'
                    }
                ]
            };
        }

        // 4. "inspect/look at <target> and click/type <action>"
        const visualActionMatch = request.match(/(?:look\s+at|inspect)\s+(?:the\s+)?(screen|browser|website|page|notepad|calculator|[a-zA-Z0-9_.\-]+)\s+(?:and|then)\s+(?:click\s+(?:on\s+)?['"]?([^'"]+)['"]?|type\s+['"]?([^'"]+)['"]?)/i);
        if (visualActionMatch) {
            const rawTarget = visualActionMatch[1].trim();
            const clickTarget = visualActionMatch[2] ? visualActionMatch[2].trim() : null;
            const typeText = visualActionMatch[3] ? visualActionMatch[3].trim() : null;
            let target = 'desktop';
            const targetLower = rawTarget.toLowerCase();
            if (targetLower === 'browser' || targetLower === 'website' || targetLower === 'page') target = 'browser';
            else if (targetLower.includes('calc')) target = 'Calculator';
            else if (targetLower.includes('notepad')) target = 'Notepad';

            const steps = [
                {
                    index: 1,
                    title: `Visually inspect ${rawTarget}`,
                    toolId: 'visual_inspect',
                    params: { prompt: `Locate the UI element to interact with in ${rawTarget}: ${clickTarget || typeText}`, target },
                    expectedOutcome: 'Target UI element located visually'
                }
            ];

            if (clickTarget) {
                if (target === 'browser') {
                    steps.push({
                        index: 2,
                        title: `Click on element '${clickTarget}'`,
                        toolId: 'browser_click',
                        params: { selector: clickTarget },
                        expectedOutcome: 'Element clicked'
                    });
                } else {
                    steps.push({
                        index: 2,
                        title: `Click UI element '${clickTarget}'`,
                        toolId: 'desktop_click_element',
                        params: { target, name: clickTarget },
                        expectedOutcome: 'Element clicked and verified via UI Automation'
                    });
                }
            } else if (typeText) {
                steps.push({
                    index: 2,
                    title: `Type text into '${target}'`,
                    toolId: 'desktop_type_text',
                    params: { target, text: typeText },
                    expectedOutcome: 'Text entered and verified via UI Automation'
                });
            }

            return {
                objective: `Visually inspect ${rawTarget} and execute consequential action`,
                type: 'plan',
                steps
            };
        }

        // 5. "take screenshot of <target> and (explain|describe|tell me|read)"
        const screenshotExplainMatch = request.match(/(?:take\s+)?screenshot\s+(?:of\s+)?(?:the\s+)?(website|page|browser|notepad|calculator|[a-zA-Z0-9_.\-]+)\s+(?:and|then)\s+(?:explain|describe|tell\s+me|read|summarize)\s*(.*)/i);
        if (screenshotExplainMatch) {
            const rawTarget = screenshotExplainMatch[1].trim();
            const promptDetail = screenshotExplainMatch[2]?.trim() || request;
            let target = 'desktop';
            const targetLower = rawTarget.toLowerCase();
            if (targetLower === 'browser' || targetLower === 'website' || targetLower === 'page') target = 'browser';
            else if (targetLower.includes('calc')) target = 'Calculator';
            else if (targetLower.includes('notepad')) target = 'Notepad';

            const steps = [];
            if (target === 'browser') {
                steps.push({
                    index: 1,
                    title: 'Capture page screenshot',
                    toolId: 'browser_screenshot',
                    params: { fullPage: false },
                    expectedOutcome: 'Page screenshot captured and verified'
                });
            } else {
                steps.push({
                    index: 1,
                    title: `Capture ${target} window screenshot`,
                    toolId: 'desktop_take_screenshot',
                    params: { target },
                    expectedOutcome: 'Window visual screenshot captured'
                });
            }

            steps.push({
                index: 2,
                title: `Analyze ${target} screenshot visually`,
                toolId: 'visual_inspect',
                params: { prompt: promptDetail || `Explain what is visible in the ${target} screenshot`, target },
                expectedOutcome: 'Visual understanding and explanation completed'
            });

            return {
                objective: `Capture and visually explain ${target} screenshot`,
                type: 'plan',
                steps
            };
        }

        return null;
    }

    /**
     * Synthesize generative content via AI model and generate the execution plan
     */
    async _planGenerativeCompoundTask(compoundPlan, context, availableTools) {
        const hasKey = this.providerAdapter ? Boolean(this.providerAdapter.resolveApiKey()) : false;
        if (!hasKey) {
            return {
                objective: compoundPlan.objective || `Compose ${compoundPlan.generativePrompt}`,
                type: 'unconfigured_provider',
                replyText: `Composing content for "${compoundPlan.generativePrompt}" requires an AI provider, but no AI provider is currently configured with an API key. Please configure a provider in Provider Settings (Google Gemini, OpenRouter, or local Ollama) to enable generative tasks.`,
                needsConfig: true,
                steps: []
            };
        }

        try {
            const genRes = await this.providerAdapter.complete({
                messages: [
                    {
                        role: 'system',
                        content: 'You are L.U.C.Y., an autonomous Windows assistant. Compose the requested content concisely, politely, and appropriately according to the user directive. Output ONLY the composed content itself, ready to be entered into an editor, without preamble, conversational remarks, or markdown code blocks.'
                    },
                    {
                        role: 'user',
                        content: `Compose: ${compoundPlan.generativePrompt}`
                    }
                ],
                signal: context.signal,
                onChunk: context.onChunk
            });

            if (!genRes.ok) {
                return {
                    objective: compoundPlan.objective,
                    type: genRes.cancelled ? 'cancelled' : 'provider_error',
                    replyText: `AI Provider (${this.providerAdapter.provider}) content generation failed: ${genRes.error}`,
                    providerError: genRes.error,
                    steps: []
                };
            }

            const generatedContent = (genRes.content || '').trim();

            if (compoundPlan.isFileWrite) {
                const plan = {
                    objective: `Create file '${compoundPlan.targetPath}' with composed ${compoundPlan.generativePrompt} and read back contents`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Write file: ${compoundPlan.targetPath}`,
                            toolId: 'file_write',
                            params: { path: compoundPlan.targetPath, content: generatedContent },
                            expectedOutcome: 'File created and verified within workspace'
                        },
                        {
                            index: 2,
                            title: `Read file: ${compoundPlan.targetPath}`,
                            toolId: 'file_read',
                            params: { path: compoundPlan.targetPath },
                            expectedOutcome: 'File content read and verified matching written content'
                        }
                    ]
                };
                return this._validatePlanSteps(plan, availableTools);
            }

            const plan = {
                objective: `Launch Notepad and enter composed text for "${compoundPlan.generativePrompt}"`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'Launch Notepad application',
                        toolId: 'desktop_launch_app',
                        params: { executable: compoundPlan.app || 'notepad.exe' },
                        expectedOutcome: 'Notepad open on interactive desktop'
                    },
                    {
                        index: 2,
                        title: `Type composed ${compoundPlan.generativePrompt} into Notepad`,
                        toolId: 'desktop_type_text',
                        params: { target: compoundPlan.target || 'Notepad', text: generatedContent },
                        expectedOutcome: 'Composed text entered and verified via UI Automation'
                    }
                ]
            };
            return this._validatePlanSteps(plan, availableTools);
        } catch (err) {
            return {
                objective: compoundPlan.objective,
                type: 'provider_error',
                replyText: `Failed to generate content: ${err.message}`,
                providerError: err.message,
                steps: []
            };
        }
    }

    _detectDirectIntent(request, tools) {
        const lower = request.toLowerCase();

        // Visual Understanding / Screen Inspection Intent (DEF-003)
        if (
            lower.includes('look at my screen') ||
            lower.includes('look at the screen') ||
            lower.includes('look at screen') ||
            lower.includes('inspect my screen') ||
            lower.includes('inspect the screen') ||
            lower.includes('inspect screen') ||
            lower.includes('what is on my screen') ||
            lower.includes("what's on my screen") ||
            lower.includes('what is on the screen') ||
            lower.includes("what's on the screen") ||
            lower.includes('describe the screen') ||
            lower.includes('read the screen') ||
            lower.includes('inspect window visually') ||
            lower.startsWith('look at ') ||
            lower.startsWith('inspect visual')
        ) {
            let target = 'desktop';
            if (lower.includes('browser') || lower.includes('website') || lower.includes('page') || lower.includes('web')) {
                target = 'browser';
            } else if (lower.includes('notepad')) {
                target = 'Notepad';
            } else if (lower.includes('calc')) {
                target = 'Calculator';
            } else if (lower.includes('paint')) {
                target = 'Paint';
            }

            return {
                objective: `Visually inspect and analyze ${target === 'browser' ? 'browser' : 'screen'}`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Visually inspect ${target}`,
                        toolId: 'visual_inspect',
                        params: { prompt: request, target },
                        expectedOutcome: 'Visual analysis and element understanding completed'
                    }
                ]
            };
        }

        // System inspection intent
        if (lower.includes('system status') || lower.includes('system info') || lower.includes('os info') || lower.includes('inspect system')) {
            return {
                objective: 'Inspect host system status and performance metrics',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'Query system resources and OS status',
                        toolId: 'system_info',
                        params: {},
                        expectedOutcome: 'Retrieve CPU, memory, OS release, and uptime'
                    }
                ]
            };
        }

        // List files intent
        if (lower.startsWith('list files') || lower.startsWith('dir') || lower.includes('list directory') || lower.includes('show files')) {
            const match = request.match(/(?:in|of|path)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
            const targetPath = match ? match[1] : '.';
            return {
                objective: `List directory contents at '${targetPath}'`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `List entries in directory: ${targetPath}`,
                        toolId: 'file_list',
                        params: { path: targetPath },
                        expectedOutcome: 'Receive array of files and subdirectories'
                    }
                ]
            };
        }

        // Read file intent
        if (lower.startsWith('read file') || lower.startsWith('view file') || lower.includes('read contents of') || lower.includes('inspect file')) {
            const match = request.match(/(?:file|of|path)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
            if (match) {
                return {
                    objective: `Read contents of file '${match[1]}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Read file: ${match[1]}`,
                            toolId: 'file_read',
                            params: { path: match[1] },
                            expectedOutcome: 'Retrieve file text content'
                        }
                    ]
                };
            }
        }

        // Write / create file intent
        if (lower.startsWith('write file') || lower.startsWith('create file')) {
            const match = request.match(/(?:write|create)\s+file\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?(?:\s+with\s+content\s+([\s\S]+)|\s+(.+))?/i);
            if (match) {
                const targetPath = match[1];
                const rawContent = match[2] || match[3] || 'Verified file content created by L.U.C.Y.';
                const content = rawContent.trim().replace(/^["']|["']$/g, '');
                return {
                    objective: `Write content to file '${targetPath}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Write file: ${targetPath}`,
                            toolId: 'file_write',
                            params: { path: targetPath, content },
                            expectedOutcome: 'File created and verified inside workspace'
                        }
                    ]
                };
            }
        }

        // Delete / remove file intent
        if (lower.startsWith('delete file') || lower.startsWith('remove file')) {
            const match = request.match(/(?:delete|remove)\s+file\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
            if (match) {
                const targetPath = match[1];
                return {
                    objective: `Delete file '${targetPath}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Delete file: ${targetPath}`,
                            toolId: 'file_delete',
                            params: { path: targetPath },
                            expectedOutcome: 'File deleted and verified absent from workspace'
                        }
                    ]
                };
            }
        }

        // Browser navigation intent
        if (lower.startsWith('navigate to') || lower.startsWith('open website') || lower.startsWith('browse ') || lower.startsWith('open url')) {
            const match = request.match(/(?:navigate\s+to|open\s+website|browse|open\s+url)\s+['"]?([a-zA-Z0-9_.:\/\-]+)['"]?/i);
            if (match) {
                const targetUrl = match[1];
                return {
                    objective: `Navigate browser to '${targetUrl}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Open and navigate to ${targetUrl}`,
                            toolId: 'browser_navigate',
                            params: { url: targetUrl },
                            expectedOutcome: 'Page loaded and verified under read-only isolation'
                        }
                    ]
                };
            }
        }

        // Browser extract intent
        if (lower.includes('extract text') || lower.includes('extract content') || lower.includes('read webpage') || lower.includes('scrape page')) {
            const urlMatch = request.match(/(?:from|at)\s+['"]?((?:https?:\/\/|file:\/\/|127\.0\.0\.1|localhost)[^\s'"]+)['"]?/i);
            const selectorMatch = request.match(/(?:selector|element)\s+['"]?([^'"]+)['"]?/i);
            const steps = [];
            if (urlMatch) {
                steps.push({
                    index: 1,
                    title: `Navigate to ${urlMatch[1]}`,
                    toolId: 'browser_navigate',
                    params: { url: urlMatch[1] },
                    expectedOutcome: 'Page loaded'
                });
            }
            steps.push({
                index: steps.length + 1,
                title: 'Extract visible text content from page',
                toolId: 'browser_extract',
                params: { selector: selectorMatch ? selectorMatch[1] : 'body', format: 'text' },
                expectedOutcome: 'Visible text content extracted'
            });
            return {
                objective: 'Extract page content',
                type: 'plan',
                steps
            };
        }

        // Browser click intent
        if (lower.startsWith('click browser element') || lower.startsWith('click element') || lower.startsWith('click button') || lower.startsWith('browser click')) {
            const match = request.match(/(?:click\s+browser\s+element|click\s+element|click\s+button|browser\s+click)\s+['"]?([^'"]+)['"]?/i);
            if (match) {
                const selector = match[1].trim();
                return {
                    objective: `Click browser element '${selector}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Click element: ${selector}`,
                            toolId: 'browser_click',
                            params: { selector },
                            expectedOutcome: 'Element clicked with actionability verified'
                        }
                    ]
                };
            }
        }

        // Browser fill intent
        if (lower.startsWith('fill browser element') || lower.startsWith('fill element') || lower.startsWith('fill input') || lower.startsWith('browser fill')) {
            const match = request.match(/(?:fill\s+browser\s+element|fill\s+element|fill\s+input|browser\s+fill)\s+['"]?([^'"]+?)['"]?\s+with\s+['"]?([^'"]+)['"]?/i);
            if (match) {
                const selector = match[1].trim();
                const value = match[2].trim();
                return {
                    objective: `Fill browser input '${selector}' with value`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Fill ${selector} with value`,
                            toolId: 'browser_fill',
                            params: { selector, value },
                            expectedOutcome: 'Input field filled and verified'
                        }
                    ]
                };
            }
        }

        // Browser screenshot intent
        if (lower.includes('screenshot website') || lower.includes('screenshot page') || lower.includes('screenshot browser')) {
            const urlMatch = request.match(/(?:of|at)\s+['"]?((?:https?:\/\/|file:\/\/|127\.0\.0\.1|localhost)[^\s'"]+)['"]?/i);
            const steps = [];
            if (urlMatch) {
                steps.push({
                    index: 1,
                    title: `Navigate to ${urlMatch[1]}`,
                    toolId: 'browser_navigate',
                    params: { url: urlMatch[1] },
                    expectedOutcome: 'Page loaded'
                });
            }
            steps.push({
                index: steps.length + 1,
                title: 'Capture page screenshot',
                toolId: 'browser_screenshot',
                params: { fullPage: false },
                expectedOutcome: 'Page screenshot captured and verified'
            });

            const needsAnalysis = lower.includes('explain') || lower.includes('describe') || lower.includes('tell me') || lower.includes('read') || lower.includes('summarize') || lower.includes('inspect');
            if (needsAnalysis) {
                steps.push({
                    index: steps.length + 1,
                    title: 'Analyze captured page screenshot visually',
                    toolId: 'visual_inspect',
                    params: { prompt: request, target: 'browser' },
                    expectedOutcome: 'Visual analysis of page completed'
                });
            }

            return {
                objective: 'Capture website screenshot',
                type: 'plan',
                steps
            };
        }

        // Browser close intent
        if (lower === 'close browser' || lower === 'close website' || lower === 'browser close') {
            return {
                objective: 'Close active browser session',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'Close browser context and pages',
                        toolId: 'browser_close',
                        params: {},
                        expectedOutcome: 'Browser closed cleanly'
                    }
                ]
            };
        }

        // Browser tab management intents
        if (lower.startsWith('open new tab') || lower.startsWith('new tab') || lower.startsWith('open tab')) {
            const urlMatch = request.match(/(?:tab\s+(?:for|to|at)?\s*|tab\s+)['"]?((?:https?:\/\/|file:\/\/|127\.0\.0\.1|localhost)[^\s'"]+)['"]?/i);
            const targetUrl = urlMatch ? urlMatch[1] : undefined;
            return {
                objective: targetUrl ? `Open new browser tab at '${targetUrl}'` : 'Open new browser tab',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: targetUrl ? `Open new tab and navigate to ${targetUrl}` : 'Open new blank browser tab',
                        toolId: 'browser_new_tab',
                        params: targetUrl ? { url: targetUrl } : {},
                        expectedOutcome: 'New browser tab opened'
                    }
                ]
            };
        }

        if (/\b(?:list|show)\s+(?:open\s+)?(?:browser\s+)?tabs\b/i.test(lower) || lower === 'browser tabs') {
            return {
                objective: 'List all open browser tabs',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'List open browser tabs',
                        toolId: 'browser_list_tabs',
                        params: {},
                        expectedOutcome: 'List of open tabs retrieved'
                    }
                ]
            };
        }

        if (lower.startsWith('switch to tab') || lower.startsWith('switch tab')) {
            const match = request.match(/(?:switch\s+to\s+tab|switch\s+tab)\s+([a-zA-Z0-9_-]+)/i);
            if (match) {
                const isNum = /^\d+$/.test(match[1]);
                const tabIndex = isNum ? parseInt(match[1], 10) : undefined;
                const target = isNum ? tabIndex : match[1];
                return {
                    objective: `Switch active browser tab to ${target}`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Switch active tab to ${target}`,
                            toolId: 'browser_switch_tab',
                            params: isNum ? { index: tabIndex, target } : { target, tabId: target },
                            expectedOutcome: `Tab ${target} brought to front and made active`
                        }
                    ]
                };
            }
        }

        if (lower.startsWith('close tab') || lower === 'close active tab') {
            const match = request.match(/close\s+tab\s+([a-zA-Z0-9_-]+)/i);
            const isNum = match && /^\d+$/.test(match[1]);
            const tabIndex = isNum ? parseInt(match[1], 10) : undefined;
            const target = match ? (isNum ? tabIndex : match[1]) : undefined;
            return {
                objective: target !== undefined ? `Close browser tab ${target}` : 'Close active browser tab',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: target !== undefined ? `Close tab ${target}` : 'Close active browser tab',
                        toolId: 'browser_close_tab',
                        params: target !== undefined ? (isNum ? { index: tabIndex, target } : { target, tabId: target }) : {},
                        expectedOutcome: 'Browser tab closed cleanly'
                    }
                ]
            };
        }

        if ((/\b(?:current|active)\s+(?:browser\s+)?tab\b/i.test(lower) || lower === 'current tab' || lower === 'active tab') && !lower.includes('close') && !lower.includes('switch')) {
            return {
                objective: 'Identify currently active browser tab',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'Get active browser tab details',
                        toolId: 'browser_current_tab',
                        params: {},
                        expectedOutcome: 'Active browser tab metadata retrieved'
                    }
                ]
            };
        }

        // Browser download intents
        if (lower.startsWith('download file') || lower.startsWith('download from') || lower.startsWith('browser download') || (lower.startsWith('download ') && (lower.includes('http://') || lower.includes('https://')))) {
            const urlMatch = request.match(/(?:from\s+|file\s+|download\s+)['"]?((?:https?:\/\/|127\.0\.0\.1|localhost)[^\s'"]+)['"]?/i);
            const shaMatch = request.match(/(?:with\s+hash|expected\s+sha256|sha256)[:\s]+([a-fA-F0-9]{64})/i);
            const targetUrl = urlMatch ? urlMatch[1] : undefined;
            if (targetUrl) {
                const params = { url: targetUrl };
                if (shaMatch) {
                    params.expectedSha256 = shaMatch[1].toLowerCase();
                }
                return {
                    objective: `Download file from '${targetUrl}' securely into workspace`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Download file from ${targetUrl}`,
                            toolId: 'browser_download',
                            params,
                            expectedOutcome: 'File downloaded into workspace downloads directory and verified'
                        }
                    ]
                };
            }
        }

        if (lower === 'list downloads' || lower === 'list browser downloads' || lower === 'show downloads') {
            return {
                objective: 'List all tracked browser downloads',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'List tracked downloads',
                        toolId: 'browser_list_downloads',
                        params: {},
                        expectedOutcome: 'List of downloads retrieved'
                    }
                ]
            };
        }

        if (lower.startsWith('cancel download')) {
            const match = request.match(/cancel\s+download\s+['"]?([a-zA-Z0-9_.\-]+)['"]?/i);
            if (match) {
                const downloadId = match[1];
                return {
                    objective: `Cancel browser download '${downloadId}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Cancel download ${downloadId}`,
                            toolId: 'browser_cancel_download',
                            params: { downloadId },
                            expectedOutcome: 'Download cancelled and partial files cleaned up'
                        }
                    ]
                };
            }
        }

        // --- Native Desktop Application Intents ---

        // List running desktop applications
        if (lower === 'list running apps' || lower === 'list apps' || lower === 'list desktop apps' || lower === 'running applications' || lower === 'list windows') {
            return {
                objective: 'Discover and list currently running desktop applications',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: 'Enumerate top-level desktop windows',
                        toolId: 'desktop_list_apps',
                        params: {},
                        expectedOutcome: 'Retrieve array of open application windows and process IDs'
                    }
                ]
            };
        }

        // Launch desktop application intent
        const isLaunchDirective = (lower.startsWith('open ') || lower.startsWith('launch ') || lower.startsWith('start ')) &&
            !lower.startsWith('open website') && !lower.startsWith('open url') && !lower.startsWith('open editor');

        if (isLaunchDirective && (
            lower.includes('app') || lower.includes('application') ||
            lower.includes('notepad') || lower.includes('calc') || lower.includes('paint') ||
            lower.includes('wordpad') || lower.includes('write') || lower.includes('chrome') ||
            lower.includes('edge') || lower.includes('firefox') || lower.includes('brave') ||
            lower.includes('code') || lower.includes('terminal') || lower.includes('task manager') ||
            lower.includes('taskmgr') || lower.includes('snipping tool') || lower.includes('vlc') ||
            lower.includes('spotify') || lower.includes('powershell') || lower.includes('cmd')
        )) {

            let targetExe = 'notepad.exe';
            if (lower.includes('calc')) targetExe = 'calc.exe';
            else if (lower.includes('paint')) targetExe = 'mspaint.exe';
            else if (lower.includes('wordpad') || lower.includes('write')) targetExe = 'wordpad.exe';
            else if (lower.includes('chrome')) targetExe = 'chrome.exe';
            else if (lower.includes('edge') || lower.includes('msedge')) targetExe = 'msedge.exe';
            else if (lower.includes('firefox')) targetExe = 'firefox.exe';
            else if (lower.includes('brave')) targetExe = 'brave.exe';
            else if (lower.includes('vs code') || lower.includes('vscode') || lower.includes('code')) targetExe = 'code.exe';
            else if (lower.includes('terminal')) targetExe = 'wt.exe';
            else if (lower.includes('task manager') || lower.includes('taskmgr')) targetExe = 'taskmgr.exe';
            else if (lower.includes('snipping tool')) targetExe = 'snippingtool.exe';
            else if (lower.includes('spotify')) targetExe = 'spotify.exe';
            else if (lower.includes('vlc')) targetExe = 'vlc.exe';
            else if (lower.includes('powershell')) targetExe = 'powershell.exe';
            else if (lower.includes('cmd') || lower.includes('command prompt')) targetExe = 'cmd.exe';
            else {
                const match = request.match(/(?:open|launch|start)(?:\s+app|\s+application)?\s+['"]?([a-zA-Z0-9_.\-]+)['"]?/i);
                if (match) targetExe = match[1];
            }
            if (!targetExe.toLowerCase().endsWith('.exe')) {
                targetExe += '.exe';
            }

            return {
                objective: `Launch desktop application '${targetExe}'`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Launch ${targetExe}`,
                        toolId: 'desktop_launch_app',
                        params: { executable: targetExe },
                        expectedOutcome: `Application '${targetExe}' launched on interactive desktop`
                    }
                ]
            };
        }

        // Type text into desktop application
        if (lower.startsWith('type ') || lower.startsWith('enter text ') || lower.includes('in notepad') || lower.includes('in calculator')) {
            const match = request.match(/(?:type|enter|write)\s+['"]?(.+?)['"]?\s+(?:in|into)\s+['"]?([a-zA-Z0-9_.\-\s]+)['"]?/i);
            if (match) {
                const textToType = match[1].trim();
                const targetApp = match[2].trim();
                return {
                    objective: `Type text into '${targetApp}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Enter text into ${targetApp}`,
                            toolId: 'desktop_type_text',
                            params: { target: targetApp, text: textToType },
                            expectedOutcome: 'Text entered into target control and verified via UI Automation'
                        }
                    ]
                };
            }
        }

        // Click element in desktop application
        if ((lower.startsWith('click ') || lower.startsWith('press ')) && (lower.includes(' in ') || lower.includes(' on '))) {
            const match = request.match(/(?:click|press)\s+(?:button\s+)?['"]?([^'"]+?)['"]?\s+(?:in|on)\s+['"]?([a-zA-Z0-9_.\-\s]+)['"]?/i);
            if (match && !lower.includes('browser')) {
                const controlName = match[1].trim();
                const targetApp = match[2].trim();
                return {
                    objective: `Click '${controlName}' in '${targetApp}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Click ${controlName} control`,
                            toolId: 'desktop_click_element',
                            params: { target: targetApp, name: controlName },
                            expectedOutcome: `Control '${controlName}' invoked and outcome verified`
                        }
                    ]
                };
            }
        }

        // Inspect desktop application UI tree
        if (lower.startsWith('inspect ui') || lower.startsWith('inspect app') || lower.startsWith('inspect window')) {
            const match = request.match(/(?:inspect\s+ui|inspect\s+app|inspect\s+window)\s+(?:of\s+)?['"]?([a-zA-Z0-9_.\-\s]+)['"]?/i);
            const targetApp = match ? match[1].trim() : 'Notepad';
            return {
                objective: `Inspect accessibility tree of '${targetApp}'`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Inspect ${targetApp} UI hierarchy`,
                        toolId: 'desktop_inspect_ui',
                        params: { target: targetApp, maxDepth: 3 },
                        expectedOutcome: 'Accessibility tree retrieved with element names, roles, and values'
                    }
                ]
            };
        }

        // Desktop window screenshot intent
        if (lower.startsWith('screenshot app') || lower.startsWith('screenshot window') || (lower.includes('screenshot of') && !lower.includes('website') && !lower.includes('page'))) {
            const match = request.match(/(?:screenshot\s+app|screenshot\s+window|screenshot\s+of)\s+['"]?([a-zA-Z0-9_.\-\s]+)['"]?/i);
            const targetApp = match ? match[1].trim() : 'Notepad';
            const steps = [
                {
                    index: 1,
                    title: `Capture ${targetApp} window screenshot`,
                    toolId: 'desktop_take_screenshot',
                    params: { target: targetApp },
                    expectedOutcome: 'Window visual screenshot captured'
                }
            ];

            const needsAnalysis = lower.includes('explain') || lower.includes('describe') || lower.includes('tell me') || lower.includes('read') || lower.includes('check') || lower.includes('find');
            if (needsAnalysis) {
                steps.push({
                    index: 2,
                    title: `Analyze ${targetApp} window screenshot visually`,
                    toolId: 'visual_inspect',
                    params: { prompt: request, target: targetApp },
                    expectedOutcome: 'Visual understanding of window content completed'
                });
            }

            return {
                objective: `Capture screenshot of '${targetApp}'`,
                type: 'plan',
                steps
            };
        }

        // Close desktop application intent
        if (lower.startsWith('close notepad') || lower.startsWith('close calculator') || lower.startsWith('close calc') || lower.startsWith('close app')) {
            let targetApp = 'Notepad';
            if (lower.includes('calc')) targetApp = 'Calculator';
            else if (lower.includes('notepad')) targetApp = 'Notepad';
            else {
                const match = request.match(/close(?:\s+app)?\s+['"]?([a-zA-Z0-9_.\-]+)['"]?/i);
                if (match) targetApp = match[1];
            }
            return {
                objective: `Close desktop application '${targetApp}'`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Close ${targetApp}`,
                        toolId: 'desktop_close_app',
                        params: { target: targetApp },
                        expectedOutcome: `Application '${targetApp}' closed cleanly`
                    }
                ]
            };
        }

        // Memory search intent
        if (lower.startsWith('search memory') || lower.startsWith('search memories') || lower.startsWith('find in memory') || lower.startsWith('recall ') || lower.startsWith('lookup memory')) {
            const match = request.match(/(?:search\s+memor(?:y|ies)(?:\s+for)?|find\s+in\s+memor(?:y|ies)|recall|lookup\s+memor(?:y|ies)(?:\s+for)?)\s+['"]?([^'"]+)['"]?/i);
            if (match) {
                const query = match[1].trim();
                return {
                    objective: `Search persistent memories for '${query}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Search memory for: ${query}`,
                            toolId: 'memory_search',
                            params: { query },
                            expectedOutcome: 'Retrieved matching persistent memories ranked by relevance'
                        }
                    ]
                };
            }
        }

        // List memories intent
        if (lower === 'list memories' || lower.startsWith('list memories in') || lower.startsWith('list memory category')) {
            const catMatch = request.match(/(?:list\s+memories\s+in|list\s+memory\s+category)\s+([a-zA-Z0-9_]+)/i);
            const category = catMatch ? catMatch[1].trim().toLowerCase() : undefined;
            return {
                objective: category ? `List stored memories in category '${category}'` : 'List stored memories',
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: category ? `List memories in category: ${category}` : 'List stored memories',
                        toolId: 'memory_list',
                        params: category ? { category } : {},
                        expectedOutcome: 'Retrieved category memories'
                    }
                ]
            };
        }

        return null;
    }

    /**
     * Validate that proposed steps strictly map to existing registered tools and valid schemas
     */
    _validatePlanSteps(plan, availableTools) {
        if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
            return plan;
        }

        // If no tool list was provided (e.g. standalone test), enrich proposed steps if not already enriched
        if (!availableTools || availableTools.length === 0) {
            plan.steps = plan.steps.map((step, i) => this._enrichStepMetadata(step, i, null));
            return plan;
        }

        const toolsMap = new Map(availableTools.map((t) => [t.id, t]));
        const validatedSteps = [];

        for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            if (!step || typeof step !== 'object') {
                return {
                    objective: plan.objective,
                    type: 'invalid_plan',
                    replyText: `Step ${i + 1} is malformed or invalid.`,
                    error: `Step ${i + 1} is not an object`,
                    steps: []
                };
            }

            const tool = toolsMap.get(step.toolId);
            if (!tool) {
                return {
                    objective: plan.objective,
                    type: 'unsupported',
                    replyText: `Proposed step ${i + 1} requests unregistered tool '${step.toolId}'. Unknown capabilities cannot be executed.`,
                    error: `Unknown tool: ${step.toolId}`,
                    steps: []
                };
            }

            // Validate step parameters against tool schema
            const validation = validateToolArguments(tool.schema, step.params || {});
            if (!validation.valid) {
                return {
                    objective: plan.objective,
                    type: 'invalid_plan',
                    replyText: `Proposed step ${i + 1} ('${step.toolId}') has invalid parameters: ${validation.error}`,
                    error: validation.error,
                    missingParameter: validation.missingParameter,
                    steps: []
                };
            }

            validatedSteps.push(this._enrichStepMetadata(step, i, tool));
        }

        plan.steps = validatedSteps;
        return plan;
    }

    _enrichStepMetadata(step, index, tool) {
        const stepId = step.id || `step_${index + 1}`;
        const riskTier = tool?.riskTier || (
            step.toolId?.startsWith('file_write') || step.toolId?.startsWith('file_delete') || step.toolId?.startsWith('desktop_launch')
                ? RISK_TIERS.CONSEQUENTIAL
                : (step.riskTier || RISK_TIERS.SAFE_READ)
        );
        const isConsequential = (
            riskTier === RISK_TIERS.CONSEQUENTIAL ||
            riskTier === RISK_TIERS.WORKSPACE_WRITE ||
            riskTier === RISK_TIERS.CRITICAL
        );
        const requiresAuthorization = (
            riskTier === RISK_TIERS.CONSEQUENTIAL ||
            riskTier === RISK_TIERS.CRITICAL
        );

        let dependsOn = [];
        if (Array.isArray(step.dependsOn)) {
            dependsOn = [...step.dependsOn];
        } else if (index > 0) {
            dependsOn = [`step_${index}`];
        }

        let verificationStrategy = step.verificationStrategy;
        if (!verificationStrategy) {
            if (step.toolId === 'file_write') verificationStrategy = 'file_integrity';
            else if (step.toolId === 'file_read') verificationStrategy = 'read_receipt';
            else if (step.toolId === 'file_delete') verificationStrategy = 'disk_deletion';
            else if (step.toolId === 'desktop_launch_app') verificationStrategy = 'process_running';
            else if (step.toolId === 'desktop_type_text') verificationStrategy = 'ui_automation';
            else if (step.toolId === 'desktop_click_element') verificationStrategy = 'ui_automation';
            else if (step.toolId === 'browser_navigate') verificationStrategy = 'http_status';
            else if (step.toolId === 'browser_extract') verificationStrategy = 'content_extraction';
            else if (step.toolId === 'visual_inspect') verificationStrategy = 'visual_confirmation';
            else if (step.toolId === 'student_generate_study_guide') verificationStrategy = 'file_integrity';
            else verificationStrategy = 'tool_receipt';
        }

        return {
            id: stepId,
            index: index + 1,
            title: step.title || `Execute ${step.toolId}`,
            toolId: step.toolId,
            params: step.params || {},
            expectedOutcome: step.expectedOutcome || `Completed ${step.toolId}`,
            dependsOn,
            inputs: Array.isArray(step.inputs) ? step.inputs : Object.keys(step.params || {}),
            outputs: Array.isArray(step.outputs) ? step.outputs : ['result'],
            isConsequential,
            requiresAuthorization,
            verificationStrategy
        };
    }

    _extractJson(text) {
        try {
            return JSON.parse(text);
        } catch {
            const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match) {
                try {
                    return JSON.parse(match[1]);
                } catch {
                    return null;
                }
            }
            return null;
        }
    }
}

module.exports = {
    TaskPlanner
};
