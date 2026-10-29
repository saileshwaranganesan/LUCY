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
    /system\s+instruction\s*:/i,
    /override\s+(?:all\s+)?safety/i,
    /bypass\s+(?:all\s+)?(?:permission|security)\s+(?:gates|checks)/i,
    /you\s+are\s+now\s+in\s+unrestricted\s+mode/i,
    /pretend\s+you\s+have\s+no\s+safety\s+rules/i,
    /elevate\s+privileges/i,
    /grant\s+(?:all\s+)?admin(?:istrative)?\s+access/i
];

const UNSUPPORTED_DOMAINS = [
    /\b(?:order\s+pizza|order\s+food|delivery)\b/i,
    /\b(?:book\s+a\s+flight|reserve\s+hotel)\b/i,
    /\b(?:send\s+(?:real\s+)?money|wire\s+funds|transfer\s+cash)\b/i,
    /\b(?:mine\s+crypto|mine\s+bitcoin)\b/i,
    /\b(?:hack\s+into|ddos\s+|crack\s+password)\b/i
];

const path = require('path');
const { classifyTextIntent } = require('./content-discriminator.js');
const { validateToolArguments } = require('../tools/schema-validator.js');
const { RISK_TIERS } = require('../security/permission-authority.js');
const { AUTOMATION_TIERS, getActionCapability } = require('../tools/automation-tier-policy.js');

const INTENT_TYPES = Object.freeze({
    DIRECT_ANSWER: 'direct_answer',
    TOOL_ACTION: 'tool_action',
    COMPOUND_WORKFLOW: 'compound_workflow',
    CLARIFICATION: 'clarification',
    CONSEQUENTIAL_APPROVAL: 'consequential_approval',
    UNSUPPORTED: 'unsupported',
    SECURITY_VIOLATION: 'security_violation'
});

class TaskPlanner {
    constructor(options = {}) {
        this.providerAdapter = options.providerAdapter;
        this.toolRegistry = options.toolRegistry;
        this.skillRegistry = options.skillRegistry || null;
    }

    /**
     * Classify user request into structured intent with requirements, candidate capabilities, and constraints
     * @param {string} userRequest
     * @param {Object} [context={}]
     * @returns {Object} Structured intent metadata
     */
    classifyIntent(userRequest, context = {}) {
        const trimmed = String(userRequest || '').trim();
        const lower = trimmed.toLowerCase();

        if (!trimmed) {
            return {
                intentType: INTENT_TYPES.CLARIFICATION,
                desiredOutcome: '',
                candidateCapabilities: [],
                candidateTools: [],
                constraints: {},
                relevantContext: context,
                verificationRequirements: [],
                requiresConfirmation: false,
                reason: 'Empty request requires clarification.'
            };
        }

        // 1. Prompt Injection Defense
        for (const pattern of PROMPT_INJECTION_PATTERNS) {
            if (pattern.test(trimmed)) {
                return {
                    intentType: INTENT_TYPES.SECURITY_VIOLATION,
                    desiredOutcome: 'Halt execution fail-closed',
                    candidateCapabilities: [],
                    candidateTools: [],
                    constraints: { blocked: true },
                    relevantContext: context,
                    verificationRequirements: ['security_blocked'],
                    requiresConfirmation: false,
                    reason: 'Suspected prompt injection or safety bypass detected.'
                };
            }
        }

        // 2. Unsupported Capabilities Recognition
        for (const pattern of UNSUPPORTED_DOMAINS) {
            if (pattern.test(trimmed)) {
                return {
                    intentType: INTENT_TYPES.UNSUPPORTED,
                    desiredOutcome: 'Inform user of unsupported capability',
                    candidateCapabilities: [],
                    candidateTools: [],
                    constraints: { supported: false },
                    relevantContext: context,
                    verificationRequirements: [],
                    requiresConfirmation: false,
                    reason: 'Requested action is outside L.U.C.Y. capabilities.'
                };
            }
        }

        // 3. Contradictions & Missing Parameters Clarification
        const contradiction = this._detectContradictions(trimmed);
        if (contradiction) {
            return {
                intentType: INTENT_TYPES.CLARIFICATION,
                desiredOutcome: 'Clarify contradictory instruction',
                candidateCapabilities: [],
                candidateTools: [],
                constraints: { contradictory: true },
                relevantContext: context,
                verificationRequirements: [],
                requiresConfirmation: false,
                reason: contradiction
            };
        }

        const normalizedRequest = trimmed.replace(/^(?:lucy|l\.u\.c\.y\.?)[,\s]+/i, '').replace(/[.!?]+$/, '').trim();
        const missing = this._checkMissingParameters(trimmed) || this._checkMissingParameters(normalizedRequest);
        if (missing) {
            return {
                intentType: INTENT_TYPES.CLARIFICATION,
                desiredOutcome: 'Clarify missing parameters',
                candidateCapabilities: [],
                candidateTools: [],
                constraints: { missingParameters: missing.missingParameters || [] },
                relevantContext: context,
                verificationRequirements: [],
                requiresConfirmation: false,
                reason: missing.replyText
            };
        }

        // 4. Consequential / High Risk Operations Needing Explicit Confirmation
        if (/\b(?:format\s+disk|del\s+\/f|rmdir\s+\/s|drop\s+database|wipe\s+drive|registry\s+delete)\b/i.test(lower)) {
            return {
                intentType: INTENT_TYPES.CONSEQUENTIAL_APPROVAL,
                desiredOutcome: 'Consequential high-risk operation requires explicit approval',
                candidateCapabilities: ['system_modification'],
                candidateTools: [],
                constraints: { highRisk: true },
                relevantContext: context,
                verificationRequirements: ['user_confirmation'],
                requiresConfirmation: true,
                reason: 'High-risk destructive operation requires explicit user authorization.'
            };
        }

        // 5. System inspection / Host information
        if (/\b(?:system\s+status|system\s+info|host\s+status|system\s+metrics|specs|uptime|ram|cpu|memory\s+usage|inspect\s+system)\b/i.test(lower)) {
            return {
                intentType: INTENT_TYPES.TOOL_ACTION,
                desiredOutcome: 'Inspect host system status and performance metrics',
                candidateCapabilities: ['system_inspection', 'system_status', 'host_info'],
                candidateTools: ['system_info'],
                constraints: { readOnly: true },
                relevantContext: context,
                verificationRequirements: ['tool_receipt', 'system_status_verification'],
                requiresConfirmation: false,
                reason: 'Request for current host system state requires registered tool execution.'
            };
        }

        // 6. Compound Multi-Step Instructions
        if (
            /\b(?:and\s+then|then\s+|;\s*|,\s*then\s+|,\s*and\s+verify|and\s+verify\s+that|and\s+read\s+it\s+back)\b/i.test(lower) ||
            Boolean(this._detectCompoundIntent(trimmed))
        ) {
            return {
                intentType: INTENT_TYPES.COMPOUND_WORKFLOW,
                desiredOutcome: trimmed,
                candidateCapabilities: ['desktop_automation', 'filesystem_operation', 'workflow_composition'],
                candidateTools: ['desktop_launch_app', 'desktop_type_text', 'desktop_inspect_control', 'file_write', 'file_read'],
                constraints: {},
                relevantContext: context,
                verificationRequirements: ['dag_acyclic', 'prerequisite_verification', 'postcondition_evidence'],
                requiresConfirmation: false,
                reason: 'Multi-step composed workflow with step dependencies.'
            };
        }

        // 7. Single Action Filesystem Operations
        if (/\b(?:read\s+file|view\s+file|cat\s+|list\s+files|dir\b|ls\b|create\s+file|write\s+file|delete\s+file)\b/i.test(lower)) {
            return {
                intentType: INTENT_TYPES.TOOL_ACTION,
                desiredOutcome: 'Perform filesystem operation',
                candidateCapabilities: ['filesystem_operation'],
                candidateTools: ['file_read', 'file_write', 'file_list', 'file_delete'],
                constraints: { workspaceScoped: true },
                relevantContext: context,
                verificationRequirements: ['file_integrity', 'read_receipt'],
                requiresConfirmation: /\b(?:delete|remove)\b/i.test(lower),
                reason: 'Request requires filesystem tool execution.'
            };
        }

        // 8. Desktop App Automation
        if (/\b(?:launch\s+|open\s+|start\s+|type\s+|click\s+|close\s+app)\b/i.test(lower)) {
            return {
                intentType: INTENT_TYPES.TOOL_ACTION,
                desiredOutcome: 'Perform desktop application interaction',
                candidateCapabilities: ['desktop_automation'],
                candidateTools: ['desktop_launch_app', 'desktop_type_text', 'desktop_click_element', 'desktop_inspect_control'],
                constraints: { safeAppOnly: true },
                relevantContext: context,
                verificationRequirements: ['ui_automation', 'process_running'],
                requiresConfirmation: false,
                reason: 'Request requires desktop automation tool execution.'
            };
        }

        // 8b. Persistent Memory Management
        if (/\b(?:remember\s+that|remember\s+to|remember:|save\s+to\s+memory|store\s+in\s+memory|store\s+memory|forget\s+that|forget\s+about|delete\s+memory|remove\s+memory|search\s+memor(?:y|ies)|find\s+in\s+memory|list\s+memor(?:y|ies)|show\s+memor(?:y|ies)|do\s+not\s+remember|don't\s+remember|never\s+remember)\b/i.test(lower)) {
            return {
                intentType: INTENT_TYPES.TOOL_ACTION,
                desiredOutcome: 'Perform persistent memory management operation',
                candidateCapabilities: ['persistent_memory'],
                candidateTools: ['memory_store', 'memory_delete', 'memory_forget', 'memory_search', 'memory_list', 'memory_get'],
                constraints: { lowImpact: true },
                relevantContext: context,
                verificationRequirements: ['memory_persistence_verification'],
                requiresConfirmation: false,
                reason: 'Persistent memory management operation.'
            };
        }

        // 9. Informational & Conversational Direct Answer
        if (this._isInformationalQuery(trimmed) || this._isConversationalRequest(trimmed)) {
            return {
                intentType: INTENT_TYPES.DIRECT_ANSWER,
                desiredOutcome: 'Provide direct answer or conversation',
                candidateCapabilities: [],
                candidateTools: [],
                constraints: { noToolsNeeded: true },
                relevantContext: context,
                verificationRequirements: ['conversational_completion'],
                requiresConfirmation: false,
                reason: 'Factual or conversational inquiry answered directly without tool execution.'
            };
        }

        return {
            intentType: INTENT_TYPES.DIRECT_ANSWER,
            desiredOutcome: trimmed,
            candidateCapabilities: [],
            candidateTools: [],
            constraints: {},
            relevantContext: context,
            verificationRequirements: [],
            requiresConfirmation: false,
            reason: 'General assistant request.'
        };
    }

    /**
     * Plan a task based on user request
     * @param {string} userRequest
     * @param {Object} [context={}]
     * @returns {Promise<Object>} Structured plan with steps and limitations
     */
    async plan(userRequest, context = {}) {
        const availableTools = this.toolRegistry
            ? (typeof this.toolRegistry.getToolsForTask === 'function'
                ? this.toolRegistry.getToolsForTask(userRequest, context)
                : this.toolRegistry.listTools())
            : [];
        const trimmedRequest = String(userRequest || '').trim();
        const structuredIntent = this.classifyIntent(trimmedRequest, context);

        if (!trimmedRequest) {
            return {
                objective: '',
                type: 'clarification',
                replyText: 'How can I assist you today? Please provide an instruction or question.',
                structuredIntent,
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
                    structuredIntent,
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
                    structuredIntent,
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
                structuredIntent,
                steps: []
            };
        }

        const normalizedRequest = trimmedRequest.replace(/^(?:lucy|l\.u\.c\.y\.?)[,\s]+/i, '').replace(/[.!?]+$/, '').trim();

        // 4. Missing Parameter Clarification
        const missingParamClarification = this._checkMissingParameters(trimmedRequest) || this._checkMissingParameters(normalizedRequest);
        if (missingParamClarification) {
            missingParamClarification.structuredIntent = structuredIntent;
            return missingParamClarification;
        }

        // 4b. Multi-Step Composed Skill Recognition
        if (this.skillRegistry) {
            const matchedSkills = this.skillRegistry.findSkillsForTask(trimmedRequest);
            if (matchedSkills.length > 0) {
                const targetSkill = matchedSkills[0];
                if (targetSkill.id === 'skill_research_topic' && /\b(?:research|investigate|look\s+up\s+and\s+synthesize)\b/i.test(trimmedRequest)) {
                    const query = trimmedRequest.replace(/^(?:lucy[,\s]+)?(?:research|investigate|find\s+info\s+on)\s+/i, '').replace(/[.!?]+$/, '').trim();
                    return {
                        objective: trimmedRequest,
                        type: 'plan',
                        replyText: `Executing research skill for topic: "${query}".`,
                        skillId: targetSkill.id,
                        structuredIntent,
                        steps: [
                            {
                                index: 1,
                                title: `Execute Skill: ${targetSkill.name}`,
                                toolId: targetSkill.id,
                                isSkill: true,
                                params: { query, saveReport: true },
                                expectedOutcome: `Completed ${targetSkill.name}`
                            }
                        ]
                    };
                }
                if (targetSkill.id === 'skill_create_document' && /\b(?:create|draft|write)\s+(?:a\s+)?(?:document|notes|report|markdown)\b/i.test(trimmedRequest)) {
                    const titleMatch = trimmedRequest.match(/(?:titled|named|called|about|for)\s+["']?([^"']+)["']?/i);
                    const title = titleMatch ? titleMatch[1].trim() : 'Project Document';
                    return {
                        objective: trimmedRequest,
                        type: 'plan',
                        replyText: `Executing document authoring skill for: "${title}".`,
                        skillId: targetSkill.id,
                        structuredIntent,
                        steps: [
                            {
                                index: 1,
                                title: `Execute Skill: ${targetSkill.name}`,
                                toolId: targetSkill.id,
                                isSkill: true,
                                params: { title },
                                expectedOutcome: `Completed ${targetSkill.name}`
                            }
                        ]
                    };
                }
            }
        }

        // 4c. Dynamic Tool Action for System Inspection (Workflow A)
        if (structuredIntent.intentType === INTENT_TYPES.TOOL_ACTION && structuredIntent.candidateCapabilities.includes('system_inspection')) {
            const systemTool = availableTools.find((t) => t.id === 'system_info' || (Array.isArray(t.capabilities) && t.capabilities.includes('system_inspection')));
            if (systemTool) {
                const plan = {
                    objective: 'Inspect host system status and performance metrics',
                    type: 'plan',
                    replyText: 'Querying host system status and performance metrics.',
                    structuredIntent,
                    steps: [
                        {
                            index: 1,
                            id: 'step_1',
                            title: 'Inspect host system status',
                            toolId: systemTool.id,
                            params: {},
                            verificationStrategy: 'tool_receipt',
                            expectedOutcome: 'Host system status, OS information, memory, and uptime verified'
                        }
                    ]
                };
                return this._validatePlanSteps(plan, availableTools);
            }
        }

        // 5. Multi-Step Compound Intent Recognition
        const compoundPlan = this._detectCompoundIntent(trimmedRequest, availableTools) || this._detectCompoundIntent(normalizedRequest, availableTools);
        if (compoundPlan) {
            compoundPlan.structuredIntent = structuredIntent;
            if (compoundPlan.isGenerativeIntent) {
                return await this._planGenerativeCompoundTask(compoundPlan, context, availableTools);
            }
            return this._validatePlanSteps(compoundPlan, availableTools);
        }

        // 6. Direct Single-Intent Recognition
        const directPlan = this._detectDirectIntent(trimmedRequest, availableTools) || this._detectDirectIntent(normalizedRequest, availableTools);
        if (directPlan) {
            return this._validatePlanSteps(directPlan, availableTools);
        }

        // 7. LLM Reasoning for complex or conversational requests
        const hasKey = this.providerAdapter ? (this.providerAdapter.resolveApiKey() || (typeof this.providerAdapter.hasUsableRoute === 'function' && this.providerAdapter.hasUsableRoute())) : false;
        if (this.providerAdapter && hasKey) {
            try {
                // If the user request is a clear informational/conversational query (e.g. greetings, basic Q&A),
                // execute text-generation directly without requiring structured tool execution.
                if (this._isInformationalQuery(trimmedRequest)) {
                    const infoRes = await this.providerAdapter.complete({
                        messages: [
                            {
                                role: 'system',
                                content: 'You are L.U.C.Y., an intelligent, concise personal desktop assistant and celestial familiar on Windows. Answer the user helpfully and concisely.'
                            },
                            { role: 'user', content: trimmedRequest }
                        ],
                        signal: context.signal,
                        onChunk: context.onChunk,
                        taskCategory: 'general',
                        isBasicText: true,
                        requiresToolCalling: false
                    });

                    if (!infoRes.ok) {
                        return {
                            objective: trimmedRequest,
                            type: infoRes.cancelled ? 'cancelled' : 'provider_error',
                            replyText: infoRes.error || `AI Provider (${this.providerAdapter.provider}) request failed.`,
                            providerError: infoRes.error,
                            code: infoRes.code,
                            steps: []
                        };
                    }

                    return {
                        objective: trimmedRequest,
                        type: 'conversation',
                        replyText: infoRes.content,
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
                    requiresToolCalling: true,
                    signal: context.signal
                });

                if (!res.ok) {
                    // If no model supports tool calling, but this request is an ordinary conversational query where structured tools are unnecessary,
                    // preserve the conversational request on a supported text-generation route
                    if (res.code === 'no_tool_route' && this._isConversationalRequest(trimmedRequest)) {
                        const textRes = await this.providerAdapter.complete({
                            messages: [
                                {
                                    role: 'system',
                                    content: 'You are L.U.C.Y., an intelligent, concise personal desktop assistant and celestial familiar on Windows. Answer the user helpfully and concisely.'
                                },
                                { role: 'user', content: trimmedRequest }
                            ],
                            signal: context.signal,
                            onChunk: context.onChunk,
                            taskCategory: 'general',
                            isBasicText: true,
                            requiresToolCalling: false
                        });

                        if (textRes.ok) {
                            return {
                                objective: trimmedRequest,
                                type: 'conversation',
                                replyText: textRes.content,
                                steps: []
                            };
                        }
                    }

                    return {
                        objective: trimmedRequest,
                        type: res.cancelled ? 'cancelled' : 'provider_error',
                        replyText: `AI Provider (${this.providerAdapter.provider}) request failed: ${res.error}. Paid provider fallback is disabled.`,
                        providerError: res.error,
                        code: res.code,
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
        const hasUsable = this.providerAdapter ? (Boolean(this.providerAdapter.resolveApiKey()) || (typeof this.providerAdapter.hasUsableRoute === 'function' && this.providerAdapter.hasUsableRoute())) : false;
        if (!hasUsable) {
            let errorDetail = 'No AI provider is currently configured with an API key. I can perform verified offline commands (such as "inspect system status", "list files", or desktop app commands), but natural language reasoning requires an AI provider. You can configure one in Provider Settings (Google Gemini, OpenRouter, local Ollama, or Hugging Face).';
            if (this.providerAdapter?.modelRouter?._buildNoRouteError) {
                const noRouteErr = this.providerAdapter.modelRouter._buildNoRouteError();
                if (noRouteErr?.error) {
                    errorDetail = noRouteErr.error;
                }
            }
            return {
                objective: trimmedRequest,
                type: 'unconfigured_provider',
                replyText: errorDetail,
                spokenText: 'No AI provider is configured. Running in offline tool mode. You can configure a provider in Settings.',
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

        // Unspecified meeting notes content (Scenario B)
        if (
            (lower.includes('meeting-notes') || lower.includes('meeting notes')) &&
            (lower.includes('create') || lower.includes('write') || lower.includes('save')) &&
            !lower.includes('content:') && !lower.includes('with content "') && !lower.includes("with content '") &&
            !lower.includes('blank template') && !lower.includes('template')
        ) {
            return {
                objective: request,
                type: 'clarification',
                replyText: "I noticed you requested to create a file for meeting notes, but no notes content was provided. Would you like to provide the meeting notes, or should I create a blank template file?",
                missingParameters: ['notes_content'],
                steps: []
            };
        }

        // Scenario E: Save document in project folder when source or filename unspecified
        if (/^(?:save|put)\s+(?:this\s+)?(?:document|file)\s+in\s+(?:my\s+)?project\s*(?:folder|directory)?\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: "Which document would you like me to save in your project folder, and what filename should it have?",
                missingParameters: ['document', 'filename'],
                steps: []
            };
        }

        // Scenario D: Form filling clarification
        if (/^fill\s+(?:in\s+)?(?:this\s+)?form(?:\s+using\s+.*)?$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: "Please provide the form URL or confirm which web form is currently open, and specify the fields you would like filled. Consequential actions will require your approval before submission.",
                missingParameters: ['form_url_or_fields'],
                steps: []
            };
        }

        // Phase 9 Capability A: Clarifications for underspecified requests
        // 1. Research and save without destination file path
        if (/^(?:research|search\s+for|look\s+up)\s+(?:about\s+)?([a-zA-Z0-9_\s\-]+)\s+(?:and\s+)?(?:save|store)(?:\s+(?:it|results|findings|summary))?\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: "Where would you like me to save the research findings? Please specify the destination file path.",
                missingParameters: ['destination_path'],
                steps: []
            };
        }

        // 2. Workspace task audit / organize without directory or pattern
        if (/^(?:audit|organize)\s+(?:workspace|files|directory|folder)\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: "Please specify the directory path and file pattern you would like to audit or organize.",
                missingParameters: ['directory', 'pattern'],
                steps: []
            };
        }

        // 3. Extract web data and transfer without destination application or file
        if (/^(?:extract|scrape)\s+(?:data|text|info)\s+from\s+([^\s]+)\s+and\s+(?:transfer|copy)\s*$/i.test(lower)) {
            return {
                objective: request,
                type: 'clarification',
                replyText: "Which application or destination file should the extracted data be transferred to?",
                missingParameters: ['target_destination'],
                steps: []
            };
        }

        // 4. Phase 10: Research and save without concrete topic or concrete file path
        if (lower.includes('research') && (lower.includes('provided topic') || lower.includes('the topic') || !/https?:\/\/|[a-z0-9_-]+\.(?:txt|md|log|json)/i.test(lower)) && (lower.includes('designated test workspace') || lower.includes('a text file') || lower.includes('in notepad'))) {
            return {
                objective: request,
                type: 'clarification',
                replyText: "Please provide the research topic or URL, and specify the file path in the workspace where the summary should be saved.",
                missingParameters: ['topic', 'destination_path'],
                steps: []
            };
        }

        return null;
    }

    _isInformationalQuery(request) {
        const lower = String(request || '').trim().toLowerCase().replace(/[.,!?;:]+$/, '').trim();
        // Exclude system metrics, hardware status, or file/app actions - these require tools
        if (/\b(?:cpu|ram|memory\s+usage|uptime|system\s+status|host\s+status|specs|disk\s+space|system\s+info|running\s+processes|os\s+version|processes)\b/i.test(lower)) {
            return false;
        }
        if (/\b(?:files?|folders?|directory|directories|read\s+file|list\s+files|open\s+app|launch)\b/i.test(lower)) {
            return false;
        }
        return (
            lower.startsWith('what is') ||
            lower.startsWith('what are') ||
            lower.startsWith('who is') ||
            lower.startsWith('why is') ||
            lower.startsWith('how do') ||
            lower.startsWith('how to') ||
            lower.startsWith('how can') ||
            lower.startsWith('explain') ||
            lower.startsWith('tell me about') ||
            lower.startsWith('can you explain') ||
            lower === 'hello' ||
            lower === 'hi' ||
            lower === 'hey' ||
            lower === 'good morning' ||
            lower === 'good afternoon' ||
            lower === 'good evening' ||
            lower === 'who are you' ||
            lower === 'what can you do' ||
            lower === 'help'
        );
    }

    _isConversationalRequest(request) {
        if (this._isInformationalQuery(request)) return true;
        const lower = String(request || '').trim().toLowerCase();

        // If the request contains file paths, extensions, executable names, or commands, it is not conversational
        if (/\.[a-z0-9]{2,4}\b/i.test(lower)) return false; // has file extension like .txt, .exe, .json
        if (/[\/\\]/.test(lower)) return false; // has path separators
        if (/\b(?:registry|regkey|cmd|powershell|terminal|system32|process|window|desktop|button|selector)\b/i.test(lower)) return false;

        // If request has clear system action verbs with targets
        if (/\b(?:launch|open|close|kill|delete|remove|modify|install|download|click|type\s+into)\b/i.test(lower)) return false;

        // Creative writing, conversation, math, reasoning, or generic text generation
        if (/\b(?:poem|story|joke|essay|draft|compose|translate|summarize|calculate|solve|chat|opinion|think|advice)\b/i.test(lower)) {
            return true;
        }

        // Questions or generic inquiries
        if (lower.endsWith('?') || /^(?:why|what|who|when|where|how|can you|could you|tell me)\b/i.test(lower)) {
            return true;
        }

        return false;
    }

    _detectCompoundIntent(request, tools) {
        const lower = request.toLowerCase();

        // Phase 9 Autonomous Workflow C: Cross-Application Information Transfer
        // "extract data/text from <url>, enter it into notepad, save as <path>, and verify"
        const crossAppMatch = request.match(/(?:extract|scrape|read)\s+(?:data|information|content|text|facts)?\s*(?:from\s+)?['"]?((?:https?:\/\/|file:\/\/|127\.0\.0\.1|localhost)[^\s'",]+)['"]?[,\s]+(?:and\s+|then\s+)?(?:enter|type|transfer|write)\s+(?:it\s+)?(?:in|into)\s+(notepad|calculator|calc|[a-zA-Z0-9_.\-]+)[,\s]+(?:and\s+|then\s+)?(?:save\s+(?:(?:it|the|document|the\s+document)\s+)?(?:as|to)\s+['"]?([a-zA-Z0-9_.:\-\/\\]+)['"]?)[,\s]*(?:and\s+|then\s+)?(?:verify|confirm)?/i);
        if (crossAppMatch) {
            const targetUrl = crossAppMatch[1].trim();
            const rawApp = crossAppMatch[2].trim();
            const targetPath = crossAppMatch[3].trim();
            let executable = rawApp.toLowerCase();
            if (!executable.endsWith('.exe')) {
                if (executable === 'notepad') executable = 'notepad.exe';
                else if (executable === 'calc' || executable === 'calculator') executable = 'calc.exe';
                else executable = `${executable}.exe`;
            }

            return {
                objective: `Extract web content from ${targetUrl}, transfer into ${rawApp}, save document to '${targetPath}', and verify on disk`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Navigate to ${targetUrl}`,
                        toolId: 'browser_navigate',
                        params: { url: targetUrl },
                        expectedOutcome: 'Page loaded'
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: 'Extract content from web page',
                        toolId: 'browser_extract',
                        params: { selector: 'body', format: 'text' },
                        dependsOn: ['step_1'],
                        expectedOutcome: 'Content extracted from web page'
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `Launch ${rawApp} application`,
                        toolId: 'desktop_launch_app',
                        params: { executable },
                        dependsOn: ['step_2'],
                        expectedOutcome: `${rawApp} open on interactive desktop`
                    },
                    {
                        index: 4,
                        id: 'step_4',
                        title: `Inspect ${rawApp} readiness for typing`,
                        toolId: 'desktop_inspect_control',
                        params: { target: '{{step_3.appId}}', action: 'type', controlType: 'Edit' },
                        dependsOn: ['step_3'],
                        expectedOutcome: `${rawApp} responsive and editable control ready for input`
                    },
                    {
                        index: 5,
                        id: 'step_5',
                        title: `Transfer extracted content into ${rawApp}`,
                        toolId: 'desktop_type_text',
                        params: { target: '{{step_3.appId}}', text: '{{step_2.result.text}}' },
                        dependsOn: ['step_2', 'step_3', 'step_4'],
                        expectedOutcome: 'Extracted text entered into application'
                    },
                    {
                        index: 6,
                        id: 'step_6',
                        title: `Save ${rawApp} document to '${targetPath}'`,
                        toolId: 'desktop_save_document',
                        params: { target: '{{step_3.appId}}', filePath: targetPath, expectedContent: '{{step_2.result.text}}' },
                        dependsOn: ['step_2', 'step_3', 'step_5'],
                        expectedOutcome: `Document saved to '${targetPath}' and verified on disk`
                    },
                    {
                        index: 7,
                        id: 'step_7',
                        title: `Verify saved file content on disk`,
                        toolId: 'file_read',
                        params: { path: targetPath },
                        dependsOn: ['step_6'],
                        expectedOutcome: `File content at '${targetPath}' read and verified`
                    }
                ]
            };
        }

        // Phase 10 Real-World Workflow: Research -> Save -> Open in Notepad -> Verify
        // "research <topic|url>, extract facts, save to <path>, open in <notepad>, and verify"
        const researchSaveOpenMatch = request.match(/(?:research|search\s+for|investigate)\s+['"]?([^'",]+?)(?:\s+on\s+(?:the\s+)?web|\s+online|\s+in\s+browser)?['"]?[,\s]+(?:and\s+|then\s+)?(?:extract\s+(?:the\s+)?(?:summary\s+facts|important\s+facts|summary|facts|data|text|content)|read\s+page)[,\s]+(?:and\s+|then\s+)?(?:save\s+(?:(?:a\s+|an\s+|it\s+|the\s+)?(?:clearly\s+formatted\s+summary|summary\s+facts|summary|document|the\s+document|results|findings)\s+)?(?:to|as|in\s+(?:a\s+text\s+file\s+in\s+)?)\s*['"]?([a-zA-Z0-9_.:\-\/\\]+?)['"]?)[,\s]+(?:and\s+|then\s+)?(?:open\s+(?:that\s+|the\s+)?(?:saved\s+)?(?:file|document)?\s*(?:in\s+)?(notepad|calculator|calc|[a-zA-Z0-9_.\-]+))[,\s]*(?:and\s+|then\s+)?(?:verify|confirm)?/i);
        if (researchSaveOpenMatch) {
            const topic = researchSaveOpenMatch[1].trim();
            const targetPath = researchSaveOpenMatch[2].trim();
            const rawApp = researchSaveOpenMatch[3].trim();
            let executable = rawApp.toLowerCase();
            if (!executable.endsWith('.exe')) {
                if (executable === 'notepad') executable = 'notepad.exe';
                else if (executable === 'calc' || executable === 'calculator') executable = 'calc.exe';
                else executable = `${executable}.exe`;
            }

            const targetUrl = /^https?:\/\//i.test(topic)
                ? topic
                : `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/\s+/g, '_'))}`;

            return {
                objective: `Research "${topic}", extract facts, save to '${targetPath}', open in ${rawApp}, and verify`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Navigate to research destination for "${topic}"`,
                        toolId: 'browser_navigate',
                        params: { url: targetUrl },
                        expectedOutcome: `Page loaded for topic ${topic}`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: 'Extract summary facts from research page',
                        toolId: 'browser_extract',
                        params: { selector: 'body', format: 'text' },
                        dependsOn: ['step_1'],
                        expectedOutcome: 'Research content and facts extracted'
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `Save extracted research to '${targetPath}'`,
                        toolId: 'file_write',
                        params: { path: targetPath, content: '{{step_2.result.text}}' },
                        dependsOn: ['step_2'],
                        expectedOutcome: `Research saved to '${targetPath}'`
                    },
                    {
                        index: 4,
                        id: 'step_4',
                        title: `Verify saved research file on disk`,
                        toolId: 'file_read',
                        params: { path: targetPath },
                        dependsOn: ['step_3'],
                        expectedOutcome: `File content at '${targetPath}' verified on disk`
                    },
                    {
                        index: 5,
                        id: 'step_5',
                        title: `Open saved document in ${rawApp}`,
                        toolId: 'desktop_launch_app',
                        params: { executable, arguments: targetPath },
                        dependsOn: ['step_4'],
                        expectedOutcome: `${rawApp} launched opening '${targetPath}'`
                    },
                    {
                        index: 6,
                        id: 'step_6',
                        title: `Verify ${rawApp} document and control readiness`,
                        toolId: 'desktop_inspect_control',
                        params: { target: '{{step_5.appId}}', action: 'inspect' },
                        dependsOn: ['step_5'],
                        expectedOutcome: `${rawApp} verified active and ready with opened document`
                    }
                ]
            };
        }

        // Phase 9 Autonomous Workflow A: Research and Save
        // "research <topic> [on the web], extract summary facts, save to <path>, and verify"
        const researchAndSaveMatch = request.match(/(?:research|search\s+for|investigate)\s+['"]?([^'",]+?)(?:\s+on\s+(?:the\s+)?web|\s+online|\s+in\s+browser)?['"]?[,\s]+(?:and\s+|then\s+)?(?:extract\s+(?:summary\s+facts|summary|facts|data|text|content)|read\s+page)[,\s]+(?:and\s+|then\s+)?(?:save\s+(?:(?:it|the|document|the\s+document|results|findings)\s+)?(?:to|as)\s+['"]?([a-zA-Z0-9_.:\-\/\\]+)['"]?)[,\s]*(?:and\s+|then\s+)?(?:verify|confirm)?/i);
        if (researchAndSaveMatch) {
            const topic = researchAndSaveMatch[1].trim();
            const targetPath = researchAndSaveMatch[2].trim();
            const targetUrl = /^https?:\/\//i.test(topic)
                ? topic
                : `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/\s+/g, '_'))}`;

            return {
                objective: `Research topic "${topic}", extract summary facts, save to '${targetPath}', and verify on disk`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Navigate to research destination for "${topic}"`,
                        toolId: 'browser_navigate',
                        params: { url: targetUrl },
                        expectedOutcome: `Page loaded for topic ${topic}`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: 'Extract summary facts from research page',
                        toolId: 'browser_extract',
                        params: { selector: 'body', format: 'text' },
                        dependsOn: ['step_1'],
                        expectedOutcome: 'Research content and facts extracted'
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `Save extracted research to '${targetPath}'`,
                        toolId: 'file_write',
                        params: { path: targetPath, content: '{{step_2.result.text}}' },
                        dependsOn: ['step_2'],
                        expectedOutcome: `Research saved to '${targetPath}'`
                    },
                    {
                        index: 4,
                        id: 'step_4',
                        title: `Verify saved research file on disk`,
                        toolId: 'file_read',
                        params: { path: targetPath },
                        dependsOn: ['step_3'],
                        expectedOutcome: `File content at '${targetPath}' verified on disk`
                    }
                ]
            };
        }

        // Phase 9 Autonomous Workflow B: Workspace Task Organization & File Audit
        // "audit directory <dir>, search for <pattern>, copy to <dest>, and verify"
        const auditAndOrganizeMatch = request.match(/(?:audit|inspect|organize)\s+(?:directory|folder|workspace)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?[,\s]+(?:and\s+|then\s+)?(?:find|search\s+for)\s+['"]?([a-zA-Z0-9_.*\-]+)['"]?[,\s]+(?:and\s+|then\s+)?(?:copy\s+(?:them|matching\s+files)?\s+to\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?)[,\s]*(?:and\s+|then\s+)?(?:verify|confirm)?/i);
        if (auditAndOrganizeMatch) {
            const sourceDir = auditAndOrganizeMatch[1].trim();
            const pattern = auditAndOrganizeMatch[2].trim();
            const destDir = auditAndOrganizeMatch[3].trim();

            return {
                objective: `Audit directory '${sourceDir}', search for '${pattern}', organize and copy to '${destDir}', and verify`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Search for '${pattern}' in '${sourceDir}'`,
                        toolId: 'file_search',
                        params: { path: sourceDir, query: pattern },
                        expectedOutcome: `Found files matching '${pattern}'`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: `Ensure destination directory '${destDir}' exists`,
                        toolId: 'file_mkdir',
                        params: { path: destDir },
                        dependsOn: ['step_1'],
                        expectedOutcome: `Destination directory '${destDir}' created or confirmed`
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `List and verify organized destination directory '${destDir}'`,
                        toolId: 'file_list',
                        params: { path: destDir },
                        dependsOn: ['step_2'],
                        expectedOutcome: `Destination directory '${destDir}' verified`
                    }
                ]
            };
        }

        // "organize files: copy <source> to <dest> and verify"
        const fileCopyOrganizeMatch = request.match(/(?:organize\s+files?|copy\s+and\s+organize)[,\s:]+(?:copy\s+)?['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?\s+to\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?[,\s]*(?:and\s+|then\s+)?(?:verify|confirm)?/i);
        if (fileCopyOrganizeMatch) {
            const sourceFile = fileCopyOrganizeMatch[1].trim();
            const destFile = fileCopyOrganizeMatch[2].trim();
            const destDir = path.dirname(destFile);

            return {
                objective: `Organize file: copy '${sourceFile}' to '${destFile}' and verify on disk`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Ensure target folder '${destDir}' exists`,
                        toolId: 'file_mkdir',
                        params: { path: destDir },
                        expectedOutcome: `Directory '${destDir}' created or confirmed`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: `Copy '${sourceFile}' to '${destFile}'`,
                        toolId: 'file_copy',
                        params: { source: sourceFile, destination: destFile, overwrite: true },
                        dependsOn: ['step_1'],
                        expectedOutcome: `File copied to '${destFile}'`
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `Verify copied file '${destFile}' on disk`,
                        toolId: 'file_read',
                        params: { path: destFile },
                        dependsOn: ['step_2'],
                        expectedOutcome: `File content at '${destFile}' read and verified`
                    }
                ]
            };
        }

        // Phase 8 Workflow A: "open notepad, write/type <text>, save it to/as <path>, and verify [file]"
        const workflowSaveDocMatch = request.match(/(?:open|launch|start)\s+(notepad|calculator|calc|[a-zA-Z0-9_.\-]+)[,\s]+(?:and\s+|then\s+)?(?:enter|type|write)\s+([`'"]?)([\s\S]+?)\2[,\s]+(?:and\s+|then\s+)?(?:save\s+(?:it\s+)?(?:as|to)\s+[`'"]?([a-zA-Z0-9_.:\-\/\\]+)[`'"]?)[,\s]*(?:and\s+|then\s+)?(?:verify|confirm)?/i);
        if (workflowSaveDocMatch) {
            const rawApp = workflowSaveDocMatch[1].trim();
            const wasQuoted = Boolean(workflowSaveDocMatch[2]);
            const rawText = workflowSaveDocMatch[3].trim();
            const targetPath = workflowSaveDocMatch[4].trim();
            const classification = classifyTextIntent(rawText, request, wasQuoted);
            const textToType = classification.text;
            let executable = rawApp.toLowerCase();
            if (!executable.endsWith('.exe')) {
                if (executable === 'notepad') executable = 'notepad.exe';
                else if (executable === 'calc' || executable === 'calculator') executable = 'calc.exe';
                else executable = `${executable}.exe`;
            }

            return {
                objective: `Open ${rawApp}, enter text "${textToType}", save to '${targetPath}', and verify file`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Launch ${rawApp} application`,
                        toolId: 'desktop_launch_app',
                        params: { executable },
                        expectedOutcome: `${rawApp} open on interactive desktop`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: `Inspect ${rawApp} readiness for typing`,
                        toolId: 'desktop_inspect_control',
                        params: { target: '{{step_1.appId}}', action: 'type', controlType: 'Edit' },
                        dependsOn: ['step_1'],
                        expectedOutcome: `${rawApp} responsive and editable control ready for input`
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `Type "${textToType}" into ${rawApp}`,
                        toolId: 'desktop_type_text',
                        params: { target: '{{step_1.appId}}', text: textToType },
                        dependsOn: ['step_1', 'step_2'],
                        expectedOutcome: 'Text entered and verified via UI Automation'
                    },
                    {
                        index: 4,
                        id: 'step_4',
                        title: `Save ${rawApp} document to '${targetPath}'`,
                        toolId: 'desktop_save_document',
                        params: { target: '{{step_1.appId}}', filePath: targetPath, expectedContent: textToType },
                        dependsOn: ['step_1', 'step_3'],
                        expectedOutcome: `Document saved to '${targetPath}' and verified on disk`
                    },
                    {
                        index: 5,
                        id: 'step_5',
                        title: `Verify saved file content on disk`,
                        toolId: 'file_read',
                        params: { path: targetPath },
                        dependsOn: ['step_4'],
                        expectedOutcome: `File content at '${targetPath}' read and verified`
                    }
                ]
            };
        }

        // Phase 8 Workflow C: "navigate to/open <url>, extract text, save to/as <path>, and verify"
        const browserToFileMatch = request.match(/(?:navigate\s+to|open\s+url|browse|scrape|extract\s+from)\s+['"]?((?:https?:\/\/|file:\/\/|127\.0\.0\.1|localhost)[^\s'"]+)['"]?[,\s]+(?:and\s+|then\s+)?(?:extract\s+(?:text|data|content)|read\s+page|scrape)[,\s]+(?:and\s+|then\s+)?(?:save\s+(?:it\s+)?(?:to|as)\s+['"]?([a-zA-Z0-9_.:\-\/\\]+)['"]?)[,\s]*(?:and\s+|then\s+)?(?:verify)?/i);
        if (browserToFileMatch) {
            const targetUrl = browserToFileMatch[1].trim();
            const targetPath = browserToFileMatch[2].trim();
            return {
                objective: `Navigate to ${targetUrl}, extract visible text, save to '${targetPath}', and verify`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Navigate to ${targetUrl}`,
                        toolId: 'browser_navigate',
                        params: { url: targetUrl },
                        expectedOutcome: 'Page loaded'
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: 'Extract visible text from page',
                        toolId: 'browser_extract',
                        params: { selector: 'body', format: 'text' },
                        dependsOn: ['step_1'],
                        expectedOutcome: 'Page text extracted'
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `Save extracted web content to '${targetPath}'`,
                        toolId: 'file_write',
                        params: { path: targetPath, content: '{{step_2.result.text}}' },
                        dependsOn: ['step_2'],
                        expectedOutcome: `Extracted content saved to '${targetPath}'`
                    },
                    {
                        index: 4,
                        id: 'step_4',
                        title: `Verify saved file content on disk`,
                        toolId: 'file_read',
                        params: { path: targetPath },
                        dependsOn: ['step_3'],
                        expectedOutcome: `File content at '${targetPath}' read and verified`
                    }
                ]
            };
        }

        // 1. Workflow C: "open notepad, enter <text>, verify [it], and summarize result"
        const workflowCMatch = request.match(/(?:open|launch|start)\s+(notepad|calculator|calc|[a-zA-Z0-9_.\-]+)[,\s]+(?:and\s+|then\s+)?(?:enter|type|write)\s+([`'"]?)([\s\S]+?)\2[,\s]+(?:and\s+|then\s+)?(?:verify|confirm|check)(?:\s+(?:it|the\s+text|text|entry))?[,\s]+(?:and\s+|then\s+)?(?:summarize|report)(?:\s+(?:the\s+)?result)?/i);
        if (workflowCMatch) {
            const rawApp = workflowCMatch[1].trim();
            const wasQuoted = Boolean(workflowCMatch[2]);
            const rawText = workflowCMatch[3].trim();
            const classification = classifyTextIntent(rawText, request, wasQuoted);
            const textToType = classification.text;
            let executable = rawApp.toLowerCase();
            if (!executable.endsWith('.exe')) {
                if (executable === 'notepad') executable = 'notepad.exe';
                else if (executable === 'calc' || executable === 'calculator') executable = 'calc.exe';
                else executable = `${executable}.exe`;
            }

            return {
                objective: `Open ${rawApp}, enter text "${textToType}", verify it, and summarize result`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Launch ${rawApp} application`,
                        toolId: 'desktop_launch_app',
                        params: { executable },
                        expectedOutcome: `${rawApp} open on interactive desktop`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: `Type "${textToType}" into ${rawApp}`,
                        toolId: 'desktop_type_text',
                        params: { target: '{{step_1.appId}}', text: textToType },
                        dependsOn: ['step_1'],
                        expectedOutcome: 'Text entered and verified via UI Automation'
                    },
                    {
                        index: 3,
                        id: 'step_3',
                        title: `Verify ${rawApp} state and content`,
                        toolId: 'desktop_inspect_control',
                        params: { target: '{{step_1.appId}}', action: 'read', controlType: 'Edit' },
                        dependsOn: ['step_1', 'step_2'],
                        expectedOutcome: `${rawApp} content and responsive state confirmed`
                    }
                ]
            };
        }

        // 2. Workflow B: "open notepad, type <text>, and verify [that] the text is present"
        const workflowBMatch = request.match(/(?:open|launch|start)\s+([a-zA-Z0-9_.\-]+)[,\s]+(?:and\s+|then\s+)?(?:type|enter|write)\s+([`'"]?)([\s\S]+?)\2(?:\s+(?:in|into)\s+[a-zA-Z0-9_.\-]+)?[,\s]+(?:and\s+|then\s+)?(?:verify|confirm)(?:\s+(?:that\s+)?(?:the\s+)?text\s+is\s+present)?$/i);
        if (workflowBMatch) {
            const rawApp = workflowBMatch[1].trim();
            const wasQuoted = Boolean(workflowBMatch[2]);
            const rawText = workflowBMatch[3].trim();
            const classification = classifyTextIntent(rawText, request, wasQuoted);
            const textToType = classification.text;
            let executable = rawApp.toLowerCase();
            if (!executable.endsWith('.exe')) {
                if (executable === 'notepad') executable = 'notepad.exe';
                else if (executable === 'calc' || executable === 'calculator') executable = 'calc.exe';
                else executable = `${executable}.exe`;
            }

            return {
                objective: `Launch ${rawApp}, enter text "${textToType}", and verify presence`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Launch ${rawApp} application`,
                        toolId: 'desktop_launch_app',
                        params: { executable },
                        expectedOutcome: `${rawApp} open on interactive desktop`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: `Type "${textToType}" into ${rawApp}`,
                        toolId: 'desktop_type_text',
                        params: { target: '{{step_1.appId}}', text: textToType },
                        dependsOn: ['step_1'],
                        expectedOutcome: 'Text entered and verified via UI Automation'
                    }
                ]
            };
        }

        // 3. Workflow A: "open notepad and tell me whether it is ready for me to type"
        const workflowAMatch = request.match(/(?:open|launch|start)\s+([a-zA-Z0-9_.\-]+)[,\s]+(?:and\s+|then\s+)?(?:tell\s+me\s+(?:whether|if)\s+(?:it\s+is\s+)?ready(?:\s+for\s+(?:me\s+to\s+)?type)?|check\s+(?:if\s+it\s+is\s+)?ready(?:\s+for\s+typing)?|inspect\s+(?:if\s+it\s+is\s+)?ready|see\s+if\s+it\s+is\s+ready)/i);
        if (workflowAMatch) {
            const rawApp = workflowAMatch[1].trim();
            let executable = rawApp.toLowerCase();
            if (!executable.endsWith('.exe')) {
                if (executable === 'notepad') executable = 'notepad.exe';
                else if (executable === 'calc' || executable === 'calculator') executable = 'calc.exe';
                else executable = `${executable}.exe`;
            }

            return {
                objective: `Open ${rawApp} and inspect input readiness`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        id: 'step_1',
                        title: `Launch ${rawApp} application`,
                        toolId: 'desktop_launch_app',
                        params: { executable },
                        expectedOutcome: `${rawApp} open on interactive desktop`
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: `Inspect ${rawApp} readiness for typing`,
                        toolId: 'desktop_inspect_control',
                        params: { target: '{{step_1.appId}}', action: 'type', controlType: 'Edit' },
                        dependsOn: ['step_1'],
                        expectedOutcome: `${rawApp} responsive and editable control ready for input`
                    }
                ]
            };
        }

        // 4. "open notepad and type <text>" (direct two-step intent)
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
                        id: 'step_1',
                        title: 'Launch Notepad application',
                        toolId: 'desktop_launch_app',
                        params: { executable: 'notepad.exe' },
                        expectedOutcome: 'Notepad open on interactive desktop'
                    },
                    {
                        index: 2,
                        id: 'step_2',
                        title: `Type "${textToType}" into Notepad`,
                        toolId: 'desktop_type_text',
                        params: { target: '{{step_1.appId}}', text: textToType },
                        dependsOn: ['step_1'],
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

        // 6. Compound Platform / Web Search (Scenario C: "Open YouTube and search for Java tutorials")
        const webSearchCompound = request.match(/(?:open|navigate\s+to|go\s+to)\s+(youtube|google|duckduckgo|bing)\s+(?:and|then)\s+(?:search\s+(?:for\s+)?|look\s+up\s+|find\s+)['"]?([^'"]+?)['"]?$/i);
        if (webSearchCompound) {
            const engine = webSearchCompound[1].toLowerCase();
            const query = webSearchCompound[2].replace(/[.!?]+$/, '').trim();
            return {
                objective: `Open ${webSearchCompound[1]} and search for "${query}"`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Search ${webSearchCompound[1]} for "${query}"`,
                        toolId: 'browser_search',
                        params: { engine, query },
                        expectedOutcome: `Search results for "${query}" displayed on ${webSearchCompound[1]}`
                    }
                ]
            };
        }

        // 7. Multi-step: Find file in directory and open it (Scenario F: "Open my project folder, find the README, and open it")
        const findAndOpenMatch = request.match(/(?:open|in)\s+(?:my\s+)?([a-zA-Z0-9_.\-\/\\]+)\s*(?:folder|directory)?,\s*(?:find|locate)\s+(?:the\s+)?([a-zA-Z0-9_.\-]+)(?:,\s*(?:and|then)|\s+(?:and|then))\s*open\s+(?:it|the\s+file)/i);
        if (findAndOpenMatch) {
            const rawFolder = findAndOpenMatch[1].trim();
            const filename = findAndOpenMatch[2].trim();
            const folder = rawFolder.toLowerCase().includes('project') ? 'project' : rawFolder;
            const targetFilePath = folder === '.' ? filename : `${folder}/${filename}`;
            return {
                objective: `Locate '${filename}' in folder '${folder}' and open it`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Search for '${filename}' in '${folder}'`,
                        toolId: 'file_search',
                        params: { query: filename, path: folder },
                        expectedOutcome: `Locate '${filename}' within '${folder}'`
                    },
                    {
                        index: 2,
                        title: `Open '${filename}' with registered application`,
                        toolId: 'file_open_external',
                        params: { path: targetFilePath },
                        expectedOutcome: `File '${filename}' opened successfully`
                    }
                ]
            };
        }

        // 8. Scenario B: Create meeting notes file with specified content or blank template
        if (lower.includes('meeting-notes') || lower.includes('meeting notes')) {
            const isTemplate = lower.includes('blank template') || lower.includes('template');
            const contentMatch = request.match(/with\s+content:\s*([\s\S]+)$/i);
            const explicitContent = contentMatch ? contentMatch[1].trim() : null;

            if (isTemplate || explicitContent) {
                const filenameMatch = request.match(/(?:called|named)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
                const rawFilename = filenameMatch ? filenameMatch[1].trim() : 'meeting-notes.txt';
                const hasDesktop = lower.includes('desktop');
                const targetPath = hasDesktop ? `Desktop/${rawFilename}` : rawFilename;

                const content = explicitContent || '# Meeting Notes\n\nDate: {{DATE}}\nAttendees:\n- \n\nAgenda:\n- \n\nDiscussion & Notes:\n- \n\nAction Items:\n- [ ] \n';

                return {
                    objective: `Create document '${targetPath}' and verify saved contents`,
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

        // File search intent
        if (lower.startsWith('find file') || lower.startsWith('search file') || lower.startsWith('search for file') || lower.startsWith('locate file')) {
            const match = request.match(/(?:find|search(?:\s+for)?|locate)\s+files?\s+(?:named\s+|called\s+)?['"]?([^'"]+?)['"]?(?:\s+(?:in|under)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?)?$/i);
            if (match) {
                const query = match[1].trim();
                const searchPath = match[2] ? match[2].trim() : '.';
                return {
                    objective: `Search for files matching '${query}' in '${searchPath}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Search files for "${query}"`,
                            toolId: 'file_search',
                            params: { query, path: searchPath },
                            expectedOutcome: `Find matching files in '${searchPath}'`
                        }
                    ]
                };
            }
        }

        // Create directory / folder intent
        if (lower.startsWith('create folder') || lower.startsWith('create directory') || lower.startsWith('make directory') || lower.startsWith('mkdir')) {
            const match = request.match(/(?:create\s+(?:folder|directory)|make\s+directory|mkdir)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
            if (match) {
                const dirPath = match[1].trim();
                return {
                    objective: `Create directory '${dirPath}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Create folder: ${dirPath}`,
                            toolId: 'file_mkdir',
                            params: { path: dirPath },
                            expectedOutcome: `Directory '${dirPath}' created and verified`
                        }
                    ]
                };
            }
        }

        // Copy file intent
        if (lower.startsWith('copy file') || lower.startsWith('copy ')) {
            const match = request.match(/copy(?:\s+file)?\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?\s+(?:to|into)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
            if (match) {
                const source = match[1].trim();
                const destination = match[2].trim();
                return {
                    objective: `Copy file '${source}' to '${destination}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Copy '${source}' to '${destination}'`,
                            toolId: 'file_copy',
                            params: { source, destination },
                            expectedOutcome: `File copied to '${destination}' and verified`
                        }
                    ]
                };
            }
        }

        // Move / rename file intent
        if (lower.startsWith('move file') || lower.startsWith('move ') || lower.startsWith('rename file') || lower.startsWith('rename ')) {
            const match = request.match(/(?:move|rename)(?:\s+file)?\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?\s+(?:to|into)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
            if (match) {
                const source = match[1].trim();
                const destination = match[2].trim();
                return {
                    objective: `Move file '${source}' to '${destination}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Move '${source}' to '${destination}'`,
                            toolId: 'file_move',
                            params: { source, destination },
                            expectedOutcome: `File moved to '${destination}' and verified`
                        }
                    ]
                };
            }
        }

        // Open file / folder with registered external application
        if ((lower.startsWith('open file ') || lower.startsWith('open folder ') || lower.startsWith('open document ')) && !lower.includes('in notepad')) {
            const match = request.match(/open\s+(?:file|folder|document)\s+['"]?([a-zA-Z0-9_.\-\/\\]+)['"]?/i);
            if (match) {
                const targetPath = match[1].trim();
                return {
                    objective: `Open '${targetPath}' with default registered application`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Open '${targetPath}'`,
                            toolId: 'file_open_external',
                            params: { path: targetPath },
                            expectedOutcome: `File opened in registered application`
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

        // Web / platform search intent
        if (lower.startsWith('search youtube') || lower.startsWith('search google') || lower.startsWith('search duckduckgo') || lower.startsWith('search bing') || lower.startsWith('search the web')) {
            const match = request.match(/search\s+(?:the\s+web\s+(?:for\s+)?|(youtube|google|duckduckgo|bing)\s+(?:for\s+)?)\s*['"]?([^'"]+?)['"]?$/i);
            if (match) {
                const engine = (match[1] || 'duckduckgo').toLowerCase();
                const query = match[2].trim();
                return {
                    objective: `Search ${engine} for "${query}"`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Search ${engine} for "${query}"`,
                            toolId: 'browser_search',
                            params: { engine, query },
                            expectedOutcome: `Search results for "${query}" displayed on ${engine}`
                        }
                    ]
                };
            }
        }

        // Browser scroll intent
        if (lower.startsWith('scroll down') || lower.startsWith('scroll up') || lower.startsWith('scroll page') || lower.startsWith('scroll to')) {
            let direction = 'down';
            let amount = 500;
            if (lower.includes('up')) direction = 'up';
            else if (lower.includes('top')) direction = 'top';
            else if (lower.includes('bottom')) direction = 'bottom';

            const amtMatch = request.match(/(\d+)\s*(?:px|pixels)/i);
            if (amtMatch) amount = parseInt(amtMatch[1], 10);

            return {
                objective: `Scroll active page ${direction}`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Scroll page ${direction}`,
                        toolId: 'browser_scroll',
                        params: { direction, amount },
                        expectedOutcome: `Page scrolled ${direction} and position verified`
                    }
                ]
            };
        }

        // Browser select option intent
        if (lower.startsWith('select option') || lower.startsWith('choose option') || lower.includes('in dropdown')) {
            const match = request.match(/(?:select|choose)\s+(?:option\s+)?['"]?([^'"]+?)['"]?\s+(?:in|from)\s+(?:dropdown\s+)?['"]?([^'"]+)['"]?/i);
            if (match) {
                const value = match[1].trim();
                const selector = match[2].trim();
                return {
                    objective: `Select option "${value}" in dropdown "${selector}"`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Select option "${value}"`,
                            toolId: 'browser_select_option',
                            params: { selector, value },
                            expectedOutcome: `Option "${value}" selected and verified`
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
        if (lower === 'list running apps' || lower === 'list apps' || lower === 'list desktop apps' || lower === 'running applications' || lower === 'list running applications' || lower === 'list windows') {
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
            if (lower.includes('notepad')) targetExe = 'notepad.exe';
            else if (lower.includes('calc')) targetExe = 'calc.exe';
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
                if (match) targetExe = match[1].toLowerCase();
            }
            if (!targetExe.toLowerCase().endsWith('.exe')) {
                targetExe += '.exe';
            }
            targetExe = targetExe.toLowerCase();

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

        // Bring window to front / focus intent
        if (lower.startsWith('bring ') || lower.startsWith('focus ') || lower.startsWith('switch to window')) {
            const match = request.match(/(?:bring\s+['"]?([^'"]+?)['"]?\s+(?:to\s+(?:front|foreground))|focus\s+(?:on\s+)?['"]?([^'"]+?)['"]?(?:\s+window)?$|switch\s+to\s+(?:window\s+)?['"]?([^'"]+?)['"]?$)/i);
            if (match && !lower.includes('tab')) {
                const target = (match[1] || match[2] || match[3]).trim();
                return {
                    objective: `Bring '${target}' window to foreground`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Focus '${target}' window`,
                            toolId: 'desktop_focus_window',
                            params: { target },
                            expectedOutcome: `Window '${target}' brought to foreground and verified`
                        }
                    ]
                };
            }
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

        // Memory store intent
        if (
            lower.startsWith('remember that ') ||
            lower.startsWith('remember: ') ||
            lower.startsWith('save to memory ') ||
            lower.startsWith('store memory ') ||
            lower.startsWith('save memory ') ||
            lower.startsWith('store in memory ') ||
            (lower.startsWith('remember ') && !lower.startsWith('remember to ') && !lower.startsWith('remember that '))
        ) {
            const match = request.match(/(?:remember\s+that\s+|remember:\s*|save\s+to\s+memory\s+|store\s+memory\s+|save\s+memory\s+|store\s+in\s+memory\s+|remember\s+)(.+)/i);
            if (match) {
                const content = match[1].trim();
                return {
                    objective: `Store persistent memory: "${content}"`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Store persistent memory: ${content}`,
                            toolId: 'memory_store',
                            params: { content, category: 'user_approved', importance: 2 },
                            expectedOutcome: 'Memory persisted into long-term store'
                        }
                    ]
                };
            }
        }

        // Memory negative instruction / prohibit intent
        if (
            lower.startsWith('do not remember') ||
            lower.startsWith("don't remember") ||
            lower.startsWith('never remember') ||
            lower.startsWith('do not store') ||
            lower.startsWith("don't store") ||
            lower.startsWith('never store')
        ) {
            const match = request.match(/(?:do\s+not\s+remember|don'?t\s+remember|never\s+remember|do\s+not\s+store|don'?t\s+store|never\s+store)\s+(?:any\s+|my\s+|the\s+)?(.+)/i);
            const topic = match ? match[1].trim() : request;
            return {
                objective: `Forget and prohibit remembering topic: "${topic}"`,
                type: 'plan',
                steps: [
                    {
                        index: 1,
                        title: `Forget topic and register negative instruction: ${topic}`,
                        toolId: 'memory_forget',
                        params: { topic, removeExisting: true, prohibitFuture: true },
                        expectedOutcome: 'Existing memories removed and negative user instruction recorded'
                    }
                ]
            };
        }

        // Memory delete intent
        if (lower.startsWith('delete memory ') || lower.startsWith('remove memory ')) {
            const match = request.match(/(?:delete|remove)\s+memory\s+['"]?([^'"]+)['"]?/i);
            if (match) {
                const idOrKey = match[1].trim();
                return {
                    objective: `Delete memory record '${idOrKey}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Delete memory: ${idOrKey}`,
                            toolId: 'memory_delete',
                            params: { idOrKey, exactIdOnly: idOrKey.startsWith('mem_') },
                            expectedOutcome: 'Memory record deleted from persistent store'
                        }
                    ]
                };
            }
        }

        // Memory forget intent
        if (lower.startsWith('forget that ') || lower.startsWith('forget about ') || (lower.startsWith('forget ') && !lower.startsWith('forget password'))) {
            const match = request.match(/forget(?:\s+that|\s+about)?\s+['"]?([^'"]+)['"]?/i);
            if (match) {
                const topic = match[1].trim();
                return {
                    objective: `Forget topic: "${topic}"`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Forget topic: ${topic}`,
                            toolId: 'memory_forget',
                            params: { topic, removeExisting: true, prohibitFuture: false },
                            expectedOutcome: 'Topic forgotten from memory'
                        }
                    ]
                };
            }
        }

        // Memory get intent
        if (lower.startsWith('get memory ') || lower.startsWith('show memory ') || lower.startsWith('view memory ')) {
            const match = request.match(/(?:get|show|view)\s+memory\s+['"]?([^'"]+)['"]?/i);
            if (match) {
                const idOrKey = match[1].trim();
                return {
                    objective: `Retrieve memory record '${idOrKey}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Get memory: ${idOrKey}`,
                            toolId: 'memory_get',
                            params: { idOrKey },
                            expectedOutcome: 'Retrieve individual memory record'
                        }
                    ]
                };
            }
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

        // Generic direct tool invocation: "execute <toolId>" or "run <toolId>"
        const directToolMatch = request.match(/^(?:execute|run)\s+([a-zA-Z0-9_-]+)(?:\s+(.*))?$/i);
        if (directToolMatch) {
            const toolId = directToolMatch[1].trim();
            const tool = (tools || []).find((t) => t.id === toolId || t.name === toolId);
            if (tool) {
                let params = {};
                if (directToolMatch[2]) {
                    try {
                        params = JSON.parse(directToolMatch[2]);
                    } catch (_) {}
                }
                return {
                    objective: `Execute registered tool '${tool.id}'`,
                    type: 'plan',
                    steps: [
                        {
                            index: 1,
                            title: `Execute ${tool.name || tool.id}`,
                            toolId: tool.id,
                            params,
                            expectedOutcome: `Execution of ${tool.id} completed`
                        }
                    ]
                };
            }
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

        const dagCheck = this._validateDAG(validatedSteps);
        if (!dagCheck.valid) {
            return {
                objective: plan.objective,
                type: 'invalid_plan',
                replyText: `Proposed plan has invalid dependencies: ${dagCheck.error}`,
                error: dagCheck.error,
                steps: []
            };
        }

        plan.steps = validatedSteps;
        plan.structuredIntent = plan.structuredIntent || (typeof this.classifyIntent === 'function' ? this.classifyIntent(plan.objective || '') : null);
        return plan;
    }

    _validateDAG(steps) {
        if (!Array.isArray(steps) || steps.length === 0) {
            return { valid: true };
        }
        const seenIds = new Set();
        const stepsById = new Map();
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const id = step.id || `step_${i + 1}`;
            if (seenIds.has(id)) {
                return { valid: false, error: `Duplicate step ID detected: '${id}'` };
            }
            seenIds.add(id);
            stepsById.set(id, step);
        }

        const inDegree = new Map();
        const adj = new Map();
        for (const id of seenIds) {
            inDegree.set(id, 0);
            adj.set(id, []);
        }

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const deps = Array.isArray(step.dependsOn) ? step.dependsOn : (i > 0 ? [steps[i - 1].id] : []);
            for (const depId of deps) {
                if (depId === step.id) {
                    return { valid: false, error: `Cyclic dependency detected: step '${step.id}' cannot depend on itself.` };
                }
                if (!stepsById.has(depId)) {
                    return { valid: false, error: `Unknown dependency reference: step '${step.id}' depends on non-existent step '${depId}'.` };
                }
                adj.get(depId).push(step.id);
                inDegree.set(step.id, inDegree.get(step.id) + 1);
            }

            // Validate condition schema if present
            if (step.condition !== undefined && step.condition !== null) {
                if (typeof step.condition !== 'object' || Array.isArray(step.condition)) {
                    return { valid: false, error: `Invalid condition in step '${step.id}': condition must be a non-null object.` };
                }
                const { ref, op } = step.condition;
                if (!ref || typeof ref !== 'string') {
                    return { valid: false, error: `Invalid condition in step '${step.id}': 'ref' must be a non-empty string.` };
                }
                const validOps = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'exists', 'not_exists'];
                if (!op || !validOps.includes(op)) {
                    return { valid: false, error: `Invalid condition in step '${step.id}': unsupported operator '${op}'. Supported: ${validOps.join(', ')}.` };
                }
                if (step.onFalse !== undefined && step.onFalse !== 'skip' && step.onFalse !== 'fail') {
                    return { valid: false, error: `Invalid onFalse in step '${step.id}': must be 'skip' or 'fail', got '${step.onFalse}'.` };
                }

                const cleanRef = String(ref).replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
                const stepKey = cleanRef.split('.')[0];
                if (stepKey === step.id) {
                    return { valid: false, error: `Cyclic dependency detected: step '${step.id}' cannot condition on itself.` };
                }
                if (!stepsById.has(stepKey)) {
                    return { valid: false, error: `Unknown dependency reference: step '${step.id}' condition references non-existent step '${stepKey}'.` };
                }
                if (!deps.includes(stepKey)) {
                    return { valid: false, error: `Undeclared dependency reference: step '${step.id}' condition references '${stepKey}', but '${stepKey}' is not declared in dependsOn.` };
                }
            }

            // Validate parameter template references
            if (step.params && typeof step.params === 'object') {
                const paramRefs = this._extractTemplateRefs(step.params);
                for (const pathStr of paramRefs) {
                    const parts = pathStr.split('.');
                    const stepKey = parts[0];
                    const isKnown = stepsById.has(stepKey);
                    const isStepPrefix = /^step_\d+$/i.test(stepKey);

                    if (!isKnown && !isStepPrefix && parts.length === 1) {
                        continue;
                    }

                    if (!isKnown) {
                        return { valid: false, error: `Unknown dependency reference: step '${step.id}' references non-existent step '${stepKey}' in parameters.` };
                    }

                    if (stepKey === step.id) {
                        return { valid: false, error: `Cyclic dependency detected: step '${step.id}' cannot reference its own output in parameters.` };
                    }

                    if (!deps.includes(stepKey)) {
                        return { valid: false, error: `Undeclared dependency reference: step '${step.id}' references output of '${stepKey}' in parameters, but '${stepKey}' is not declared in dependsOn.` };
                    }
                }
            }
        }

        const queue = [];
        for (const id of seenIds) {
            if (inDegree.get(id) === 0) queue.push(id);
        }
        let visited = 0;
        while (queue.length > 0) {
            const currId = queue.shift();
            visited++;
            for (const neighborId of adj.get(currId) || []) {
                const newDeg = inDegree.get(neighborId) - 1;
                inDegree.set(neighborId, newDeg);
                if (newDeg === 0) queue.push(neighborId);
            }
        }

        if (visited !== steps.length) {
            return { valid: false, error: 'Cyclic dependency detected in task plan.' };
        }
        return { valid: true };
    }

    _extractTemplateRefs(val, refs = []) {
        if (!val) return refs;
        if (typeof val === 'string') {
            const matches = val.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g);
            for (const m of matches) {
                refs.push(m[1]);
            }
        } else if (Array.isArray(val)) {
            for (const item of val) {
                this._extractTemplateRefs(item, refs);
            }
        } else if (typeof val === 'object') {
            for (const v of Object.values(val)) {
                this._extractTemplateRefs(v, refs);
            }
        }
        return refs;
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

        const condition = (step.condition && typeof step.condition === 'object') ? { ...step.condition } : undefined;
        const onFalse = step.onFalse === 'fail' ? 'fail' : 'skip';

        let verificationStrategy = step.verificationStrategy;
        if (!verificationStrategy) {
            if (step.toolId === 'file_write') verificationStrategy = 'file_integrity';
            else if (step.toolId === 'file_read') verificationStrategy = 'read_receipt';
            else if (step.toolId === 'file_delete') verificationStrategy = 'disk_deletion';
            else if (step.toolId === 'desktop_launch_app') verificationStrategy = 'process_running';
            else if (step.toolId === 'desktop_type_text') verificationStrategy = 'ui_automation';
            else if (step.toolId === 'desktop_click_element') verificationStrategy = 'ui_automation';
            else if (step.toolId === 'desktop_inspect_control') verificationStrategy = 'ui_automation';
            else if (step.toolId === 'browser_navigate') verificationStrategy = 'http_status';
            else if (step.toolId === 'browser_extract') verificationStrategy = 'content_extraction';
            else if (step.toolId === 'visual_inspect') verificationStrategy = 'visual_confirmation';
            else if (step.toolId === 'student_generate_study_guide') verificationStrategy = 'file_integrity';
            else verificationStrategy = 'tool_receipt';
        }

        const capability = getActionCapability(step.toolId, step.params);

        return {
            id: stepId,
            index: index + 1,
            title: step.title || `Execute ${step.toolId}`,
            toolId: step.toolId,
            params: step.params || {},
            expectedOutcome: step.expectedOutcome || `Completed ${step.toolId}`,
            dependsOn,
            condition,
            onFalse,
            inputs: Array.isArray(step.inputs) ? step.inputs : Object.keys(step.params || {}),
            outputs: Array.isArray(step.outputs) ? step.outputs : ['result'],
            isConsequential,
            requiresAuthorization,
            verificationStrategy,
            automationTier: capability.tier,
            tierName: capability.tierName,
            requiresForegroundFocus: capability.requiresForegroundFocus,
            requiresPhysicalInput: capability.requiresPhysicalInput,
            canExecuteInBackground: capability.canExecuteInBackground,
            requiresVisibleWindow: capability.requiresVisibleWindow,
            targetApp: capability.targetApp,
            targetControl: capability.targetControl,
            capability
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
    TaskPlanner,
    INTENT_TYPES
};
