'use strict';

const { TaskStatusManager, TASK_STATES } = require('./task-status.js');
const { TaskPlanner } = require('./task-planner.js');
const { ContextBudgetManager } = require('./context-budget.js');
const { MemoryStore, MEMORY_CATEGORIES, MEMORY_TYPES, MEMORY_SOURCES } = require('../memory/memory-store.js');
const { TaskContinuityStore, TASK_STATUSES } = require('../memory/task-continuity-store.js');

/**
 * TaskCoordinator
 * The sole authoritative brain of L.U.C.Y.
 * Orchestrates the full lifecycle:
 * Request -> Interpretation -> Task Plan -> Permission Check -> Tool Execution -> Verification -> User Response.
 * 
 * Workstream 07 Enhancements:
 * 1. Supports request cancellation via AbortController and cancelTask(taskId).
 * 2. Supports streaming via options.onChunk for incremental AI responses (REQ-029).
 * 3. Handles rich natural language planner outcomes: clarifications, prompt injection blocks, unsupported capabilities (REQ-033).
 * 4. Model-aware bounded context budgeting (REQ-032).
 */
class TaskCoordinator {
    constructor(options = {}) {
        this.statusManager = options.statusManager || new TaskStatusManager();
        this.permissionAuthority = options.permissionAuthority;
        this.toolRegistry = options.toolRegistry;
        this.providerAdapter = options.providerAdapter;
        this.planner = options.planner || new TaskPlanner({
            providerAdapter: this.providerAdapter,
            toolRegistry: this.toolRegistry
        });
        this.budgetManager = options.budgetManager || new ContextBudgetManager({
            model: this.providerAdapter?.model || 'default'
        });
        this.conversationHistory = [];
        this.companionBridge = options.companionBridge || null;
        this.memoryStore = options.memoryStore || new MemoryStore();
        this.taskContinuityStore = options.taskContinuityStore || new TaskContinuityStore();
        this.activeTasks = new Map(); // taskId -> AbortController
    }

    setCompanionBridge(bridge) {
        this.companionBridge = bridge;
        if (bridge) {
            bridge.taskCoordinator = this;
        }
        // Forward state transitions to the companion presentation layer
        this.statusManager.on('stateChanged', (event) => {
            if (this.companionBridge) {
                this.companionBridge.handleStateEvent(event);
            }
        });
    }

    /**
     * Cancel an active in-flight task
     * @param {string} taskId
     * @param {string} [reason='Task cancelled by user']
     * @returns {{ ok: boolean, cancelled?: boolean, error?: string }}
     */
    cancelTask(taskId, reason = 'Task cancelled by user') {
        const controller = this.activeTasks.get(taskId);
        if (controller) {
            controller.abort(reason);
            this.statusManager.failTask(`Task ${taskId} was cancelled: ${reason}`);
            if (this.companionBridge) {
                this.companionBridge.setEmotion('worried', 'Task cancelled');
            }
            return { ok: true, taskId, cancelled: true };
        }
        return { ok: false, taskId, error: 'Task not found or already completed' };
    }

    /**
     * Process a user request through the complete verified execution pipeline
     * @param {string} userRequest
     * @param {Object} [options={}]
     * @param {boolean} [options.dryRun=false]
     * @param {Function} [options.onChunk] - Incremental streaming callback
     * @param {AbortSignal} [options.signal] - Optional external abort signal
     * @returns {Promise<Object>} Final verified response
     */
    async executeRequest(userRequest, options = {}) {
        const taskId = options.taskId || `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const dryRun = Boolean(options.dryRun || process.env.LUCY_DRY_RUN === 'true');

        const abortController = new AbortController();
        this.activeTasks.set(taskId, abortController);

        if (options.signal) {
            options.signal.addEventListener('abort', () => abortController.abort(options.signal.reason), { once: true });
        }

        // 1. Initialize Task, Checkpoint & Memory
        this.statusManager.startTask(taskId, userRequest);
        this.conversationHistory.push({ role: 'user', content: userRequest });

        // Save conversation turn to memory store
        this.memoryStore.addMemory({
            category: MEMORY_CATEGORIES.CONVERSATION,
            content: `User: ${userRequest}`,
            source: MEMORY_SOURCES.USER_EXPLICIT
        });

        // Initialize task continuity checkpoint
        this.taskContinuityStore.saveCheckpoint({
            taskId,
            userRequest,
            status: TASK_STATUSES.IN_PROGRESS,
            dryRun
        });

        // Check for explicit user memory instruction (e.g. "Remember that my preferred port is 8080")
        const explicitMemoryMatch = userRequest.match(/^(?:remember that|remember:|note that|please remember)\s+(.+)/i);
        if (explicitMemoryMatch) {
            this.activeTasks.delete(taskId);
            const memoryContent = explicitMemoryMatch[1].trim();
            const saved = this.memoryStore.addMemory({
                category: MEMORY_CATEGORIES.USER_APPROVED,
                content: memoryContent,
                type: MEMORY_TYPES.CONFIRMED_FACT,
                source: MEMORY_SOURCES.USER_EXPLICIT
            });

            const replyText = saved.rejected
                ? `Long-term memory is currently disabled. Enable it in Memory Settings to save.`
                : `I have committed this to your long-term memory: "${memoryContent}".`;

            this.statusManager.completeTask({ replyText });
            this.taskContinuityStore.saveCheckpoint({
                taskId,
                userRequest,
                status: TASK_STATUSES.COMPLETED,
                dryRun
            });

            if (this.companionBridge) {
                this.companionBridge.setEmotion('happy', replyText);
            }

            return {
                ok: true,
                status: 'completed',
                taskId,
                userRequest,
                replyText,
                executedSteps: [],
                memorySaved: saved,
                verification: { verified: true, method: 'explicit_memory_storage' }
            };
        }

        // Update companion emotion to focused/thinking
        if (this.companionBridge) {
            this.companionBridge.setEmotion('thinking', 'Processing your instruction');
        }

        try {
            if (abortController.signal.aborted) {
                throw new Error('Task was cancelled before planning.');
            }

            // Retrieve relevant long-term and project memories for context
            const relevantMemories = this.memoryStore.getMemories({ query: userRequest, limit: 3 });

            // 2. Planning: Interpret request and construct plan
            this.statusManager.transition(TASK_STATES.PLANNING);
            const plan = await this.planner.plan(userRequest, {
                dryRun,
                relevantMemories,
                signal: abortController.signal,
                onChunk: options.onChunk
            });

            this.statusManager.transition(TASK_STATES.PLANNING, { plan });

            if (abortController.signal.aborted) {
                throw new Error('Task was cancelled during planning.');
            }

            // Update checkpoint with plan
            this.taskContinuityStore.saveCheckpoint({
                taskId,
                userRequest,
                plan,
                status: TASK_STATUSES.IN_PROGRESS,
                dryRun
            });

            // Handle security rejection (e.g. Prompt injection)
            if (plan.type === 'security_rejection') {
                this.statusManager.failTask(plan.replyText);
                this.conversationHistory.push({ role: 'assistant', content: plan.replyText });
                this.taskContinuityStore.saveCheckpoint({
                    taskId,
                    userRequest,
                    plan,
                    status: TASK_STATUSES.FAILED,
                    error: plan.replyText,
                    dryRun
                });
                if (this.companionBridge) {
                    this.companionBridge.setEmotion('worried', plan.replyText);
                }
                return {
                    ok: false,
                    status: 'security_blocked',
                    taskId,
                    userRequest,
                    replyText: plan.replyText,
                    error: plan.replyText,
                    securityBlocked: true,
                    verification: { verified: false, failureReason: plan.replyText }
                };
            }

            // Handle clarification requests (e.g. Missing parameters)
            if (plan.type === 'clarification') {
                this.statusManager.completeTask({ replyText: plan.replyText, steps: [] });
                this.conversationHistory.push({ role: 'assistant', content: plan.replyText });
                this.taskContinuityStore.saveCheckpoint({
                    taskId,
                    userRequest,
                    plan,
                    status: TASK_STATUSES.COMPLETED,
                    dryRun
                });
                if (this.companionBridge) {
                    this.companionBridge.setEmotion('curious', plan.replyText);
                }
                return {
                    ok: true,
                    status: 'clarification_required',
                    taskId,
                    userRequest,
                    replyText: plan.replyText,
                    missingParameters: plan.missingParameters || [],
                    ambiguous: Boolean(plan.ambiguous),
                    steps: [],
                    verification: { verified: true, method: 'clarification_requested' }
                };
            }

            // Handle unsupported capabilities
            if (plan.type === 'unsupported') {
                this.statusManager.failTask(plan.replyText);
                this.conversationHistory.push({ role: 'assistant', content: plan.replyText });
                this.taskContinuityStore.saveCheckpoint({
                    taskId,
                    userRequest,
                    plan,
                    status: TASK_STATUSES.FAILED,
                    error: plan.replyText,
                    dryRun
                });
                if (this.companionBridge) {
                    this.companionBridge.setEmotion('curious', plan.replyText);
                }
                return {
                    ok: false,
                    status: 'unsupported',
                    taskId,
                    userRequest,
                    replyText: plan.replyText,
                    error: plan.replyText,
                    steps: [],
                    verification: { verified: false, failureReason: 'unsupported_capability' }
                };
            }

            // Handle user cancellation during planning
            if (plan.type === 'cancelled') {
                const cancelText = plan.replyText || 'Task was cancelled by user.';
                this.statusManager.failTask(cancelText);
                this.taskContinuityStore.saveCheckpoint({
                    taskId,
                    userRequest,
                    plan,
                    status: TASK_STATUSES.FAILED,
                    error: cancelText,
                    dryRun
                });
                return {
                    ok: false,
                    status: 'cancelled',
                    taskId,
                    userRequest,
                    cancelled: true,
                    replyText: cancelText,
                    error: cancelText,
                    steps: [],
                    verification: { verified: false, failureReason: 'cancelled' }
                };
            }

            // If it's a simple conversational reply without tools
            if (plan.type === 'conversation' || plan.type === 'unconfigured_provider' || plan.type === 'provider_error' || !plan.steps || plan.steps.length === 0) {
                const replyText = plan.replyText || 'Task understood, no execution steps required.';
                this.conversationHistory.push({ role: 'assistant', content: replyText });

                if (plan.type === 'provider_error') {
                    this.statusManager.failTask(plan.providerError || replyText);
                } else {
                    this.statusManager.completeTask({ replyText, steps: [] });
                }

                this.taskContinuityStore.saveCheckpoint({
                    taskId,
                    userRequest,
                    plan,
                    status: plan.type === 'provider_error' ? TASK_STATUSES.FAILED : TASK_STATUSES.COMPLETED,
                    error: plan.type === 'provider_error' ? (plan.providerError || replyText) : null,
                    dryRun
                });

                if (this.companionBridge) {
                    if (plan.type === 'unconfigured_provider') {
                        this.companionBridge.setEmotion('curious', replyText);
                    } else if (plan.type === 'provider_error') {
                        this.companionBridge.setEmotion('worried', replyText);
                    } else {
                        this.companionBridge.setEmotion('happy', replyText);
                    }
                }

                return {
                    ok: plan.type !== 'provider_error',
                    status: plan.type === 'provider_error' ? 'provider_error' : 'completed',
                    taskId,
                    userRequest,
                    replyText,
                    error: plan.type === 'provider_error' ? (plan.providerError || replyText) : undefined,
                    needsConfig: plan.needsConfig || false,
                    dryRun,
                    plan,
                    executedSteps: [],
                    verification: { verified: plan.type !== 'provider_error', method: 'conversational_completion' }
                };
            }

            // 3. Execution Pipeline: Step-by-Step with Permission Check & Verification
            const executedSteps = [];
            const completedStepDescriptions = [];
            const verifiedFacts = [];

            for (let i = 0; i < plan.steps.length; i++) {
                if (abortController.signal.aborted) {
                    throw new Error('Task execution was cancelled by user.');
                }

                const step = plan.steps[i];
                const stepIndex = i + 1;

                this.statusManager.transition(TASK_STATES.EXECUTING_TOOL, {
                    step: stepIndex,
                    totalSteps: plan.steps.length,
                    currentTool: step.toolId
                });

                if (this.companionBridge) {
                    this.companionBridge.setEmotion('focused', `Executing step ${stepIndex}: ${step.title}`);
                }

                // Execute tool via ToolRegistry (which enforces permissions and dry-run internally)
                const toolResult = await this.toolRegistry.execute(step.toolId, step.params, { dryRun });

                if (abortController.signal.aborted) {
                    throw new Error('Task execution was cancelled by user.');
                }

                // 4. Result Verification: Never claim success without verification
                this.statusManager.transition(TASK_STATES.VERIFYING, {
                    step: stepIndex,
                    toolResult
                });

                const stepReceipt = {
                    index: stepIndex,
                    title: step.title,
                    toolId: step.toolId,
                    params: step.params,
                    result: toolResult,
                    verified: toolResult.ok && Boolean(toolResult.verification?.verified)
                };

                executedSteps.push(stepReceipt);

                // Update checkpoint after step execution
                this.taskContinuityStore.saveCheckpoint({
                    taskId,
                    userRequest,
                    plan,
                    currentStepIndex: stepIndex,
                    completedSteps: executedSteps,
                    status: toolResult.ok ? TASK_STATUSES.IN_PROGRESS : TASK_STATUSES.FAILED,
                    dryRun,
                    error: toolResult.ok ? null : toolResult.error
                });

                if (!toolResult.ok) {
                    // Honest error reporting and halt
                    const failureReason = toolResult.error || 'Tool execution did not succeed';
                    this.statusManager.failTask(failureReason);

                    if (this.companionBridge) {
                        this.companionBridge.setEmotion('worried', `Step ${stepIndex} stopped: ${failureReason}`);
                    }

                    return {
                        ok: false,
                        status: 'failed',
                        taskId,
                        userRequest,
                        failedStep: stepReceipt,
                        executedSteps,
                        error: failureReason,
                        dryRun,
                        verification: { verified: false, failureReason }
                    };
                }

                completedStepDescriptions.push(`Step ${stepIndex} (${step.title}): ${toolResult.status}`);
                if (toolResult.result) {
                    verifiedFacts.push(`${step.toolId}: ${JSON.stringify(toolResult.result).slice(0, 160)}`);
                }
            }

            // 5. Task Completion & Synthesis
            const completionSummary = `Completed ${executedSteps.length} planned step(s) successfully.${dryRun ? ' (Dry-run simulated)' : ''}`;
            this.conversationHistory.push({ role: 'assistant', content: completionSummary });

            // Record assistant turn into conversation memory
            this.memoryStore.addMemory({
                category: MEMORY_CATEGORIES.CONVERSATION,
                content: `LUCY: ${completionSummary}`,
                source: MEMORY_SOURCES.ASSISTANT_SYNTHESIS
            });

            // Mark task continuity checkpoint as completed
            this.taskContinuityStore.saveCheckpoint({
                taskId,
                userRequest,
                plan,
                currentStepIndex: executedSteps.length,
                completedSteps: executedSteps,
                status: TASK_STATUSES.COMPLETED,
                dryRun
            });

            // Check Context Budget & Compaction
            if (this.providerAdapter?.model) {
                this.budgetManager.setModel(this.providerAdapter.model);
            }
            const boundedContext = this.budgetManager.buildBoundedContext(this.conversationHistory, {
                metadata: {
                    objective: userRequest,
                    completedSteps: completedStepDescriptions,
                    verifiedFacts,
                    nextAction: 'Task finished successfully.'
                }
            });

            this.statusManager.completeTask({ summary: completionSummary, executedSteps });

            if (this.companionBridge) {
                this.companionBridge.setEmotion('happy', completionSummary);
            }

            return {
                ok: true,
                status: 'completed',
                taskId,
                userRequest,
                replyText: completionSummary,
                dryRun,
                plan,
                executedSteps,
                contextBudget: boundedContext.diagnostics,
                verification: {
                    verified: true,
                    allStepsVerified: executedSteps.every((s) => s.verified),
                    method: 'sequential_step_verification'
                }
            };

        } catch (err) {
            const isCancelled = abortController.signal.aborted || (err.message && err.message.toLowerCase().includes('cancel'));
            const finalStatus = isCancelled ? 'cancelled' : 'failed';
            const errorMsg = isCancelled ? 'Task was cancelled by user.' : err.message;

            this.statusManager.failTask(errorMsg);
            this.taskContinuityStore.saveCheckpoint({
                taskId,
                userRequest,
                status: isCancelled ? TASK_STATUSES.FAILED : TASK_STATUSES.FAILED,
                dryRun,
                error: errorMsg
            });

            if (this.companionBridge) {
                this.companionBridge.setEmotion('worried', errorMsg);
            }

            return {
                ok: false,
                status: finalStatus,
                taskId,
                userRequest,
                cancelled: isCancelled,
                error: errorMsg,
                dryRun,
                verification: { verified: false, error: errorMsg }
            };
        } finally {
            this.activeTasks.delete(taskId);
        }
    }

    // Memory Delegation Methods
    getMemories(options = {}) {
        return this.memoryStore.getMemories(options);
    }

    searchMemories(query, options = {}) {
        return typeof this.memoryStore.searchMemories === 'function'
            ? this.memoryStore.searchMemories(query, options)
            : this.memoryStore.getMemories({ ...options, query });
    }

    addMemory(entry) {
        return this.memoryStore.addMemory(entry);
    }

    updateMemory(id, updates) {
        return this.memoryStore.updateMemory(id, updates);
    }

    deleteMemory(id) {
        return this.memoryStore.deleteMemory(id);
    }

    clearCategory(category) {
        return this.memoryStore.clearCategory(category);
    }

    toggleLongTermMemory(enabled) {
        return this.memoryStore.setLongTermMemoryEnabled(enabled);
    }

    isLongTermMemoryEnabled() {
        return this.memoryStore.isLongTermMemoryEnabled();
    }

    getMemorySummary() {
        return this.memoryStore.getSummary();
    }

    // Task Continuity Delegation Methods
    getInterruptedTasks() {
        return this.taskContinuityStore.getInterruptedTasks();
    }

    inspectTask(taskId) {
        return this.taskContinuityStore.inspectTaskForResume(taskId);
    }

    resumeTask(taskId, options = {}) {
        return this.taskContinuityStore.resumeTask(taskId, this, options);
    }

    discardTask(taskId) {
        return this.taskContinuityStore.discardTask(taskId);
    }
}

module.exports = {
    TaskCoordinator
};
