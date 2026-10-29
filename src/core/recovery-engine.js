'use strict';

/**
 * TaskRecoveryEngine (Workstream 4)
 * Bounded failure classification, intelligent recovery, and recovery receipts.
 * 
 * Capabilities:
 * 1. Deterministic classification of failures into:
 *    - TRANSIENT (network/browser timeouts, resource contention)
 *    - INVALID_INPUT (schema or parameter mismatch)
 *    - UNAVAILABLE_CAPABILITY (missing tool/model/provider)
 *    - PERMISSION_DENIED (fail-closed, strictly unrecoverable)
 *    - CANCELLED (user or signal abort, strictly unrecoverable)
 *    - VERIFICATION_FAILED (tool reported success but verifier found discrepancy)
 *    - FATAL (unhandled or non-recoverable error)
 * 2. Strict attempt budget enforcement (default max 2 retries).
 * 3. Stable task ID continuity across recovery attempts.
 * 4. Comprehensive recovery receipts documenting attempt counts, strategies, and final outcomes.
 */

const FAILURE_TYPES = {
    // Existing base types preserved
    TRANSIENT: 'transient',
    INVALID_INPUT: 'invalid_input',
    UNAVAILABLE_CAPABILITY: 'unavailable_capability',
    PERMISSION_DENIED: 'permission_denied',
    CANCELLED: 'cancelled',
    VERIFICATION_FAILED: 'verification_failed',
    FATAL: 'fatal',

    // Granular failure classification types
    TOOL_UNAVAILABLE: 'tool_unavailable',
    PROVIDER_OUTAGE: 'provider_outage',
    TIMEOUT_CONFIRMED: 'timeout_confirmed',
    TIMEOUT_UNCERTAIN: 'timeout_uncertain',
    INCOMPATIBLE_PARAMS: 'incompatible_params',
    OUTPUT_INVALID: 'output_invalid',
    PERMANENT_UNRECOVERABLE: 'permanent_unrecoverable'
};

const RECOVERY_STRATEGIES = {
    RETRY_WITH_BACKOFF: 'retry_with_backoff',
    REOBSERVE_AND_RETRY: 'reobserve_and_retry',
    CORRECT_INPUT: 'correct_input',
    FALLBACK_PROVIDER: 'fallback_provider',
    FALLBACK_TOOL: 'fallback_tool',
    REPLAN: 'replan',
    AWAIT_RECONCILIATION: 'await_reconciliation',
    FAIL_CLOSED: 'fail_closed'
};

class TaskRecoveryEngine {
    constructor(options = {}) {
        this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 2;
        this.baseBackoffMs = Number.isInteger(options.baseBackoffMs) ? options.baseBackoffMs : 150;
        this.logger = options.logger || null;
    }

    /**
     * Classify an error or tool failure result
     * @param {Error|Object|string} errorOrResult
     * @param {Object} [stepContext={}]
     * @returns {Object} Structured classification
     */
    classifyFailure(errorOrResult, stepContext = {}) {
        if (!errorOrResult) {
            return {
                type: FAILURE_TYPES.FATAL,
                category: FAILURE_TYPES.PERMANENT_UNRECOVERABLE,
                reason: 'Unknown failure with no error object',
                recoverable: false,
                replanEligible: false,
                suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        const rawMessage = (errorOrResult && typeof errorOrResult === 'object')
            ? (errorOrResult.message || errorOrResult.error || errorOrResult.status || JSON.stringify(errorOrResult))
            : String(errorOrResult);

        const msgLower = rawMessage.toLowerCase();
        const code = errorOrResult.code || '';
        const step = stepContext.step || stepContext;
        const isNonIdempotent = Boolean(step && (step.isConsequential || step.idempotent === false));

        // 1. Cancellation (strictly non-retryable)
        if (
            errorOrResult.name === 'AbortError' ||
            errorOrResult.cancelled === true ||
            msgLower.includes('cancelled') ||
            msgLower.includes('abort') ||
            msgLower.includes('interrupted')
        ) {
            return {
                type: FAILURE_TYPES.CANCELLED,
                category: FAILURE_TYPES.CANCELLED,
                reason: rawMessage,
                recoverable: false,
                replanEligible: false,
                suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        // 2. Permission Denied / Security Violation (fail-closed, strictly non-retryable, NO fallback bypass)
        if (
            errorOrResult.status === 'permission_denied' ||
            errorOrResult.permissionDenied === true ||
            code === 'UNAUTHORIZED_DISCARD_ACTION' ||
            code === 'TARGET_AUTHORIZATION_MISMATCH' ||
            code === 'SAFETY_VIOLATION' ||
            msgLower.includes('permission denied') ||
            msgLower.includes('authorization required') ||
            msgLower.includes('unauthorized_discard_action') ||
            msgLower.includes('target_authorization_mismatch') ||
            msgLower.includes('cannot discard unsaved changes') ||
            msgLower.includes('boundary violation') ||
            msgLower.includes('escape workspace') ||
            msgLower.includes('access denied') ||
            msgLower.includes('eacces') ||
            msgLower.includes('eperm')
        ) {
            return {
                type: FAILURE_TYPES.PERMISSION_DENIED,
                category: FAILURE_TYPES.PERMISSION_DENIED,
                reason: rawMessage,
                recoverable: false,
                replanEligible: false, // Security boundary: never bypass authorization via fallback
                suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        // 3. Tool Unavailable or Not Registered
        if (
            errorOrResult.status === 'unavailable' ||
            errorOrResult.status === 'tool_not_found' ||
            msgLower.includes('tool not found') ||
            msgLower.includes('is not registered') ||
            msgLower.includes('not registered') ||
            msgLower.includes('currently deactivated') ||
            msgLower.includes('tool unavailable') ||
            msgLower.includes('no tool with id')
        ) {
            return {
                type: FAILURE_TYPES.TOOL_UNAVAILABLE,
                category: FAILURE_TYPES.TOOL_UNAVAILABLE,
                reason: rawMessage,
                recoverable: false, // Cannot succeed on direct retry of the missing tool
                replanEligible: true, // Safe candidate for adaptive replanning with fallback
                suggestedStrategy: RECOVERY_STRATEGIES.FALLBACK_TOOL
            };
        }

        // 4. Timeouts: Confirmed vs Uncertain
        const isTimeoutCode = code === 'TIMEOUT' || code === 'ETIMEDOUT';
        const isTimeoutText = (
            errorOrResult.timedOut === true ||
            msgLower.includes('timeout') ||
            msgLower.includes('timed out')
        );

        if (isTimeoutCode || isTimeoutText) {
            const isUncertainOutcome = Boolean(
                stepContext.uncertain === true ||
                errorOrResult.uncertain === true ||
                (isNonIdempotent && stepContext.confirmed !== true && errorOrResult.confirmed !== true)
            );

            if (isUncertainOutcome) {
                return {
                    type: FAILURE_TYPES.TIMEOUT_UNCERTAIN,
                    category: FAILURE_TYPES.TIMEOUT_UNCERTAIN,
                    reason: rawMessage,
                    timedOut: true,
                    uncertain: true,
                    recoverable: false, // Must NOT retry or fallback until reconciled
                    replanEligible: false,
                    suggestedStrategy: RECOVERY_STRATEGIES.AWAIT_RECONCILIATION
                };
            }

            // Confirmed timeout (idempotent / read-only or explicit confirmed termination)
            const isExplicitConfirmed = stepContext.confirmed === true || errorOrResult.confirmed === true || stepContext.granular === true;
            return {
                type: isExplicitConfirmed ? FAILURE_TYPES.TIMEOUT_CONFIRMED : FAILURE_TYPES.TRANSIENT,
                subtype: FAILURE_TYPES.TIMEOUT_CONFIRMED,
                category: FAILURE_TYPES.TIMEOUT_CONFIRMED,
                reason: rawMessage,
                timedOut: true,
                uncertain: false,
                recoverable: true,
                replanEligible: true,
                suggestedStrategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF
            };
        }

        // 5. Temporary Provider / Service Outage
        const isProviderOutageText = (
            msgLower.includes('provider outage') ||
            msgLower.includes('service unavailable') ||
            msgLower.includes('rate limit') ||
            msgLower.includes('overloaded') ||
            msgLower.includes('503') ||
            msgLower.includes('502') ||
            msgLower.includes('504')
        );
        const isTransientCode = ['ECONNRESET', 'EADDRINUSE', 'EBUSY', 'EAGAIN'].includes(code);
        const isTransientText = (
            msgLower.includes('busy') ||
            msgLower.includes('connection reset') ||
            msgLower.includes('socket reset') ||
            msgLower.includes('econnreset') ||
            msgLower.includes('network error') ||
            msgLower.includes('socket hang up') ||
            msgLower.includes('page crash')
        );

        if (isProviderOutageText) {
            return {
                type: FAILURE_TYPES.PROVIDER_OUTAGE,
                category: FAILURE_TYPES.PROVIDER_OUTAGE,
                reason: rawMessage,
                recoverable: true,
                replanEligible: true,
                suggestedStrategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF
            };
        }

        const isReadinessDelay = (
            msgLower.includes('not ready') ||
            msgLower.includes('not responsive') ||
            msgLower.includes('window not found') ||
            msgLower.includes('control not found') ||
            msgLower.includes('element not found') ||
            msgLower.includes('still loading') ||
            msgLower.includes('temporarily unavailable') ||
            msgLower.includes('element temporarily unavailable') ||
            msgLower.includes('delayed ready') ||
            msgLower.includes('reobserve')
        );

        if (isReadinessDelay && !isNonIdempotent) {
            return {
                type: FAILURE_TYPES.TRANSIENT,
                category: FAILURE_TYPES.TRANSIENT,
                reason: rawMessage,
                recoverable: true,
                replanEligible: true,
                suggestedStrategy: RECOVERY_STRATEGIES.REOBSERVE_AND_RETRY
            };
        }

        if (isTransientCode || isTransientText) {
            return {
                type: FAILURE_TYPES.TRANSIENT,
                category: FAILURE_TYPES.PROVIDER_OUTAGE,
                reason: rawMessage,
                recoverable: true,
                replanEligible: true,
                suggestedStrategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF
            };
        }

        // 5b. Inconclusive Verification / Uncertain Outcome
        const isInconclusive = (
            code === 'AMBIGUOUS_CONFIRMATION_DIALOG' ||
            msgLower.includes('ambiguous_confirmation_dialog') ||
            msgLower.includes('ambiguous confirmation dialog') ||
            errorOrResult.status === 'inconclusive' ||
            errorOrResult.status === 'uncertain' ||
            (typeof errorOrResult.status === 'string' && errorOrResult.status.includes('uncertain')) ||
            errorOrResult.postconditionStatus === 'UNVERIFIABLE' ||
            errorOrResult.uncertain === true ||
            stepContext.uncertain === true ||
            msgLower.includes('uncertain') ||
            msgLower.includes('inconclusive') ||
            msgLower.includes('unverifiable') ||
            msgLower.includes('could not be independently verified') ||
            msgLower.includes('state transition could not be verified')
        );

        if (isInconclusive) {
            if (isNonIdempotent) {
                return {
                    type: FAILURE_TYPES.TIMEOUT_UNCERTAIN,
                    category: FAILURE_TYPES.TIMEOUT_UNCERTAIN,
                    reason: rawMessage,
                    uncertain: true,
                    recoverable: false,
                    replanEligible: false,
                    suggestedStrategy: RECOVERY_STRATEGIES.AWAIT_RECONCILIATION
                };
            }
            return {
                type: FAILURE_TYPES.VERIFICATION_FAILED,
                category: FAILURE_TYPES.OUTPUT_INVALID,
                reason: rawMessage,
                uncertain: false,
                recoverable: false,
                replanEligible: true,
                suggestedStrategy: RECOVERY_STRATEGIES.FALLBACK_TOOL
            };
        }

        // 6. Verification Failures & Invalid Tool Output
        if (
            errorOrResult.status === 'verification_failed' ||
            errorOrResult.status === 'output_invalid' ||
            errorOrResult.verified === false ||
            msgLower.includes('verification failed') ||
            msgLower.includes('not verified') ||
            msgLower.includes('content discrepancy') ||
            msgLower.includes('target not found') ||
            msgLower.includes('output schema') ||
            msgLower.includes('invalid tool output')
        ) {
            const isOutputInvalid = msgLower.includes('invalid tool output') || msgLower.includes('output schema');
            return {
                type: isOutputInvalid ? FAILURE_TYPES.OUTPUT_INVALID : FAILURE_TYPES.VERIFICATION_FAILED,
                category: FAILURE_TYPES.OUTPUT_INVALID,
                reason: rawMessage,
                recoverable: true,
                replanEligible: true,
                suggestedStrategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF
            };
        }

        // 7. Invalid Input / Incompatible Tool Parameters
        if (
            errorOrResult.status === 'invalid_parameters' ||
            errorOrResult.status === 'validation_failed' ||
            errorOrResult.status === 'incompatible_params' ||
            msgLower.includes('incompatible parameter') ||
            msgLower.includes('incompatible tool parameter') ||
            msgLower.includes('validation error') ||
            msgLower.includes('invalid argument') ||
            msgLower.includes('schema validation') ||
            msgLower.includes('missing required parameter') ||
            msgLower.includes('must be a string') ||
            msgLower.includes('must be an object')
        ) {
            const isIncompatible = msgLower.includes('incompatible parameter') || msgLower.includes('incompatible tool parameter');
            return {
                type: isIncompatible ? FAILURE_TYPES.INCOMPATIBLE_PARAMS : FAILURE_TYPES.INVALID_INPUT,
                category: FAILURE_TYPES.INCOMPATIBLE_PARAMS,
                reason: rawMessage,
                recoverable: false, // Cannot succeed on identical retry without parameter fix
                replanEligible: true, // Candidate for parameter adaptation or fallback tool
                suggestedStrategy: isIncompatible ? RECOVERY_STRATEGIES.CORRECT_INPUT : RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        // 8. Unavailable Capability
        if (
            msgLower.includes('unsupported') ||
            msgLower.includes('not implemented') ||
            msgLower.includes('capability not available') ||
            msgLower.includes('no provider available') ||
            msgLower.includes('vision model not configured') ||
            code === 'ENOENT_BINARY'
        ) {
            return {
                type: FAILURE_TYPES.UNAVAILABLE_CAPABILITY,
                category: FAILURE_TYPES.TOOL_UNAVAILABLE,
                reason: rawMessage,
                recoverable: false,
                replanEligible: true,
                suggestedStrategy: RECOVERY_STRATEGIES.FALLBACK_PROVIDER
            };
        }

        // 9. Permanent Failure with No Safe Fallback / General Fatal
        const isPermanent = msgLower.includes('permanent') || msgLower.includes('unrecoverable');
        return {
            type: isPermanent ? FAILURE_TYPES.PERMANENT_UNRECOVERABLE : FAILURE_TYPES.FATAL,
            category: FAILURE_TYPES.PERMANENT_UNRECOVERABLE,
            reason: rawMessage,
            recoverable: false,
            replanEligible: false,
            suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
        };
    }

    /**
     * Determine if a step is eligible for another recovery attempt
     * @param {Object} step
     * @param {Object} classification
     * @param {number} currentAttempts
     * @returns {boolean}
     */
    canRecover(step, classification, currentAttempts) {
        if (!classification || !classification.recoverable) {
            return false;
        }

        if (currentAttempts >= this.maxRetries) {
            return false;
        }

        // Safety boundary: Uncertain outcomes must NEVER be retried automatically
        if (
            classification.type === FAILURE_TYPES.TIMEOUT_UNCERTAIN ||
            classification.uncertain === true
        ) {
            return false;
        }

        // Safety boundary: Cancellations and Permission Denials are strictly non-recoverable
        if (
            classification.type === FAILURE_TYPES.CANCELLED ||
            classification.type === FAILURE_TYPES.PERMISSION_DENIED
        ) {
            return false;
        }

        // Safety boundary: Permanent unrecoverable errors cannot be retried
        if (
            classification.type === FAILURE_TYPES.PERMANENT_UNRECOVERABLE ||
            classification.type === FAILURE_TYPES.FATAL
        ) {
            return false;
        }

        // Safety boundary: Tool unavailable or incompatible params cannot succeed on direct retry
        if (
            classification.type === FAILURE_TYPES.TOOL_UNAVAILABLE ||
            classification.type === FAILURE_TYPES.INCOMPATIBLE_PARAMS ||
            classification.type === FAILURE_TYPES.INVALID_INPUT ||
            classification.type === FAILURE_TYPES.UNAVAILABLE_CAPABILITY
        ) {
            return false;
        }

        // Non-idempotent or consequential actions that time out have an uncertain outcome:
        // side effects may have already been dispatched or executed on the external resource.
        // Retrying blindly risks duplicate side effects (e.g. double purchases, duplicate mutations).
        const isTimeout = Boolean(
            classification.timedOut ||
            classification.type === FAILURE_TYPES.TIMEOUT_CONFIRMED ||
            classification.type === FAILURE_TYPES.TIMEOUT_UNCERTAIN ||
            (classification.reason && /timed out/i.test(classification.reason))
        );
        const isNonIdempotent = Boolean(step && (step.isConsequential || step.idempotent === false));
        if (isNonIdempotent && isTimeout && classification.confirmed !== true) {
            return false;
        }

        // Certain sensitive or non-idempotent operations should only retry if transient
        if (
            step &&
            step.isConsequential &&
            classification.type !== FAILURE_TYPES.TRANSIENT &&
            classification.type !== FAILURE_TYPES.PROVIDER_OUTAGE
        ) {
            return false;
        }

        return true;
    }

    /**
     * Determine if a failed step is eligible for adaptive replanning / fallback tool routing.
     * @param {Object} step
     * @param {Object} classification
     * @returns {boolean}
     */
    isEligibleForReplanning(step, classification) {
        if (!classification) return false;

        // Safety boundary: Never replan / fallback an unresolved uncertain consequential action!
        if (classification.type === FAILURE_TYPES.TIMEOUT_UNCERTAIN || classification.uncertain === true) {
            return false;
        }

        // Safety boundary: Never replan / fallback an authorization failure to bypass security!
        if (classification.type === FAILURE_TYPES.PERMISSION_DENIED) {
            return false;
        }

        // Safety boundary: Cancellation halts immediately
        if (classification.type === FAILURE_TYPES.CANCELLED) {
            return false;
        }

        // Safety boundary: Permanent unrecoverable failure with no safe fallback
        if (classification.type === FAILURE_TYPES.PERMANENT_UNRECOVERABLE) {
            return false;
        }

        // If step was consequential and timed out, outcome is uncertain unless confirmed
        const isTimeout = Boolean(
            classification.timedOut ||
            (classification.reason && /timed out/i.test(classification.reason))
        );
        const isNonIdempotent = Boolean(step && (step.isConsequential || step.idempotent === false));
        if (isNonIdempotent && isTimeout && classification.confirmed !== true) {
            return false;
        }

        return Boolean(classification.replanEligible !== false);
    }

    /**
     * Compute backoff delay for retry attempt
     * @param {number} attemptIndex (0-based)
     * @returns {number} Delay in milliseconds
     */
    getBackoffDelay(attemptIndex) {
        // Exponential backoff: base * (2 ^ attemptIndex)
        return this.baseBackoffMs * Math.pow(2, Math.max(0, attemptIndex));
    }

    /**
     * Create a structured recovery receipt
     * @param {Object} params
     * @returns {Object}
     */
    createRecoveryReceipt(params = {}) {
        const count = params.attempts || params.attempt || 0;
        return {
            stepId: params.stepId || 'unknown_step',
            failureType: params.failureType || FAILURE_TYPES.FATAL,
            reason: params.reason || '',
            attempts: count,
            attempt: count,
            maxAttempts: this.maxRetries,
            strategy: params.strategy || RECOVERY_STRATEGIES.FAIL_CLOSED,
            reobserved: Boolean(params.reobserved),
            reobservation: params.reobservation || null,
            recovered: Boolean(params.recovered),
            finalStatus: params.finalStatus || 'failed',
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Create a structured audit receipt for a replanning or fallback routing event
     * @param {Object} params
     * @returns {Object}
     */
    createReplanReceipt(params = {}) {
        return {
            stepId: params.stepId || 'unknown_step',
            failedToolId: params.failedToolId || 'unknown_tool',
            failureType: params.failureType || FAILURE_TYPES.FATAL,
            failureReason: params.failureReason || '',
            outcomeState: params.outcomeState || 'confirmed_failure',
            candidatesConsidered: Array.isArray(params.candidatesConsidered) ? params.candidatesConsidered : [],
            rejectedCandidates: Array.isArray(params.rejectedCandidates) ? params.rejectedCandidates : [],
            selectedFallback: params.selectedFallback || null,
            replanAttempt: params.replanAttempt || 1,
            budgetRemaining: params.budgetRemaining !== undefined ? params.budgetRemaining : 0,
            userConfirmationRequired: Boolean(params.userConfirmationRequired),
            userConfirmed: params.userConfirmed !== undefined ? params.userConfirmed : null,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = {
    TaskRecoveryEngine,
    FAILURE_TYPES,
    RECOVERY_STRATEGIES
};
