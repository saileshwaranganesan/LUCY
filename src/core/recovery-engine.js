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
    TRANSIENT: 'transient',
    INVALID_INPUT: 'invalid_input',
    UNAVAILABLE_CAPABILITY: 'unavailable_capability',
    PERMISSION_DENIED: 'permission_denied',
    CANCELLED: 'cancelled',
    VERIFICATION_FAILED: 'verification_failed',
    FATAL: 'fatal'
};

const RECOVERY_STRATEGIES = {
    RETRY_WITH_BACKOFF: 'retry_with_backoff',
    CORRECT_INPUT: 'correct_input',
    FALLBACK_PROVIDER: 'fallback_provider',
    REPLAN: 'replan',
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
                reason: 'Unknown failure with no error object',
                recoverable: false,
                suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        const rawMessage = (errorOrResult && typeof errorOrResult === 'object')
            ? (errorOrResult.message || errorOrResult.error || errorOrResult.status || JSON.stringify(errorOrResult))
            : String(errorOrResult);

        const msgLower = rawMessage.toLowerCase();
        const code = errorOrResult.code || '';

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
                reason: rawMessage,
                recoverable: false,
                suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        // 2. Permission Denied / Security Violation (fail-closed, strictly non-retryable)
        if (
            errorOrResult.status === 'permission_denied' ||
            errorOrResult.permissionDenied === true ||
            msgLower.includes('permission denied') ||
            msgLower.includes('authorization required') ||
            msgLower.includes('boundary violation') ||
            msgLower.includes('escape workspace') ||
            msgLower.includes('access denied') ||
            msgLower.includes('eacces') ||
            msgLower.includes('eperm')
        ) {
            return {
                type: FAILURE_TYPES.PERMISSION_DENIED,
                reason: rawMessage,
                recoverable: false,
                suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        // 3. Transient Failures (network timeouts, busy resource, connection resets)
        const isTransientCode = ['ETIMEDOUT', 'ECONNRESET', 'EADDRINUSE', 'EBUSY', 'EAGAIN'].includes(code);
        const isTransientText = (
            msgLower.includes('timeout') ||
            msgLower.includes('timed out') ||
            msgLower.includes('busy') ||
            msgLower.includes('connection reset') ||
            msgLower.includes('network error') ||
            msgLower.includes('socket hang up') ||
            msgLower.includes('navigation timeout') ||
            msgLower.includes('page crash')
        );

        if (isTransientCode || isTransientText) {
            return {
                type: FAILURE_TYPES.TRANSIENT,
                reason: rawMessage,
                recoverable: true,
                suggestedStrategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF
            };
        }

        // 4. Verification Failures
        if (
            errorOrResult.status === 'verification_failed' ||
            errorOrResult.verified === false ||
            msgLower.includes('verification failed') ||
            msgLower.includes('not verified') ||
            msgLower.includes('content discrepancy') ||
            msgLower.includes('target not found')
        ) {
            return {
                type: FAILURE_TYPES.VERIFICATION_FAILED,
                reason: rawMessage,
                recoverable: true, // Verification failures may be retried (e.g. app slow to launch or browser DOM settling)
                suggestedStrategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF
            };
        }

        // 5. Invalid Input / Schema Validation
        if (
            errorOrResult.status === 'validation_failed' ||
            msgLower.includes('validation error') ||
            msgLower.includes('invalid argument') ||
            msgLower.includes('schema validation') ||
            msgLower.includes('missing required parameter') ||
            msgLower.includes('must be a string') ||
            msgLower.includes('must be an object')
        ) {
            return {
                type: FAILURE_TYPES.INVALID_INPUT,
                reason: rawMessage,
                recoverable: false, // Invalid arguments cannot succeed on identical repeat
                suggestedStrategy: RECOVERY_STRATEGIES.FAIL_CLOSED
            };
        }

        // 6. Unavailable Capability
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
                reason: rawMessage,
                recoverable: false,
                suggestedStrategy: RECOVERY_STRATEGIES.FALLBACK_PROVIDER
            };
        }

        // 7. General Fatal / Non-recoverable
        return {
            type: FAILURE_TYPES.FATAL,
            reason: rawMessage,
            recoverable: false,
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

        // Certain sensitive or non-idempotent operations should only retry if transient
        if (step && step.isConsequential && classification.type !== FAILURE_TYPES.TRANSIENT) {
            return false;
        }

        return true;
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
        return {
            stepId: params.stepId || 'unknown_step',
            failureType: params.failureType || FAILURE_TYPES.FATAL,
            reason: params.reason || '',
            attempts: params.attempts || 0,
            maxAttempts: this.maxRetries,
            strategy: params.strategy || RECOVERY_STRATEGIES.FAIL_CLOSED,
            recovered: Boolean(params.recovered),
            finalStatus: params.finalStatus || 'failed',
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = {
    TaskRecoveryEngine,
    FAILURE_TYPES,
    RECOVERY_STRATEGIES
};
