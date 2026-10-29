'use strict';

const { EventEmitter } = require('events');
const { TASK_STATES } = require('../core/task-status.js');

/**
 * CompanionBridge
 * Decoupled presentation bridge for L.U.C.Y.'s fantasy-creature companion.
 * 
 * ARCHITECTURAL MANDATE:
 * The companion has ZERO autonomous brain, agent loop, or independent tools.
 * It is purely a visual and interactive manifestation reacting to the Task Coordinator.
 */
class CompanionBridge extends EventEmitter {
    constructor(options = {}) {
        super();
        this.name = 'Lucy Familiar';
        this.theme = 'celestial_spirit'; // Cute feminine fantasy spirit/creature
        this.currentEmotion = 'happy';
        this.speechBubble = '';
        this.speechTimeout = null;
        this.taskCoordinator = options.taskCoordinator || null;
    }

    /**
     * Handle state transitions from the Task Coordinator
     * @param {Object} event
     */
    handleStateEvent(event) {
        const { to, description, currentTool, error, result } = event;

        switch (to) {
            case TASK_STATES.IDLE:
                this.setEmotion('idle', 'At your service!');
                break;
            case TASK_STATES.INTERPRETING:
                this.setEmotion('thinking', description || 'Listening carefully...');
                break;
            case TASK_STATES.PLANNING:
                this.setEmotion('focused', 'Formulating the best action plan...');
                break;
            case TASK_STATES.WAITING_PERMISSION:
            case TASK_STATES.AWAITING_AUTHORIZATION:
                this.setEmotion('curious', description || 'Awaiting your approval to proceed.');
                break;
            case TASK_STATES.READY:
                this.setEmotion('focused', 'Ready to execute.');
                break;
            case TASK_STATES.RUNNING:
            case TASK_STATES.EXECUTING_TOOL:
                this.setEmotion('working', description || `Working: executing ${currentTool || 'action'}...`);
                break;
            case TASK_STATES.VERIFYING:
                this.setEmotion('focused', 'Verifying outcomes for accuracy...');
                break;
            case TASK_STATES.RECOVERING:
                this.setEmotion('thinking', description || 'Recovering from error...');
                break;
            case TASK_STATES.AWAITING_RECONCILIATION:
                this.setEmotion('curious', description || 'Awaiting guidance to reconcile task state.');
                break;
            case TASK_STATES.COMPLETED:
                this.setEmotion('happy', result?.summary || 'Task completed successfully!');
                break;
            case TASK_STATES.PARTIALLY_COMPLETED:
                this.setEmotion('focused', result?.summary || 'Task partially completed.');
                break;
            case TASK_STATES.FAILED:
                this.setEmotion('worried', error || 'Encountered an obstacle.');
                break;
            case TASK_STATES.CANCELLED:
                this.setEmotion('idle', 'Task cancelled.');
                break;
            case TASK_STATES.INTERRUPTED:
                this.setEmotion('worried', description || 'Task execution interrupted.');
                break;
            default:
                this.setEmotion('idle');
                break;
        }
    }

    /**
     * Update visual emotion and dialogue bubble
     * @param {string} emotion - 'idle'|'happy'|'thinking'|'focused'|'curious'|'worried'|'working'
     * @param {string} [bubbleText='']
     */
    setEmotion(emotion, bubbleText = '') {
        this.currentEmotion = emotion;
        if (bubbleText) {
            this.speechBubble = bubbleText;
            if (this.speechTimeout) clearTimeout(this.speechTimeout);
            this.speechTimeout = setTimeout(() => {
                this.speechBubble = '';
                this.emit('visualUpdate', this.getVisualState());
            }, 7000);
        }

        const state = this.getVisualState();
        this.emit('visualUpdate', state);
        return state;
    }

    getVisualState() {
        return {
            name: this.name,
            theme: this.theme,
            emotion: this.currentEmotion,
            speechBubble: this.speechBubble,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Handle user physical interactions on the desktop companion
     * @param {string} interactionType - 'click'|'hover'|'pet'|'submit_request'
     * @param {Object} [payload={}]
     */
    handleUserInteraction(interactionType, payload = {}) {
        if (interactionType === 'click' || interactionType === 'pet') {
            this.setEmotion('happy', 'Sparkle! ✨ How can I help?');
            return { acknowledged: true, reaction: 'sparkle_flutter' };
        }

        if (interactionType === 'magic') {
            this.setEmotion('happy', 'Twirl! 🌟 Magical stardust burst!');
            return { acknowledged: true, reaction: 'magic_burst' };
        }

        if (interactionType === 'submit_request' && payload.text) {
            if (this.taskCoordinator) {
                // Forward strictly to the sole authoritative task coordinator!
                return this.taskCoordinator.executeRequest(payload.text, payload.options);
            }
        }

        return { acknowledged: true };
    }
}

module.exports = {
    CompanionBridge
};
