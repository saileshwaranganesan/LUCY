'use strict';

/**
 * L.U.C.Y. — Pet Interactions & Affection System
 * Defines varied affectionate dialogue, fairy tricks, and rotation mechanics.
 */

const AFFECTION_PHRASES = Object.freeze([
    "Aww, that tickles! ✨",
    "You're the sweetest! 💖",
    "Hehe, I love spending time with you! 🌟",
    "Yay! More cuddles, please! 🥰",
    "That makes me so happy! ✨",
    "Purr! Sparkling warm flutter! 💖",
    "Aww, thank you! You're my favorite human! 🌸",
    "Hehe, that gives me warm fairy tingles! ✨",
    "Sparkle sparkle! You always brighten my day! 💫",
    "Giggle! My wings are fluttering with joy! 🦋"
]);

const TRICK_DEFINITIONS = Object.freeze({
    spin: {
        id: 'spin',
        name: 'Twirl & Spin',
        label: '💫 Spin',
        message: 'Twirl! 💫 Spinning through the stars!',
        animation: 'trick_spin',
        duration: 1.6
    },
    jump: {
        id: 'jump',
        name: 'Fairy Leap',
        label: '🦘 Jump',
        message: 'Boing! 🦘 High fairy leap!',
        animation: 'trick_jump',
        duration: 1.3
    },
    fly: {
        id: 'fly',
        name: 'Celestial Flight',
        label: '🦋 Fly',
        message: 'Swoosh! 🦋 Gliding on celestial wings!',
        animation: 'trick_fly',
        duration: 2.0
    },
    bounce: {
        id: 'bounce',
        name: 'Happy Flutter Bounce',
        label: '✨ Bounce',
        message: 'Sparkle! ✨ Happy flutter bounce!',
        animation: 'trick_bounce',
        duration: 1.2
    },
    somersault: {
        id: 'somersault',
        name: 'Aerial Somersault',
        label: '🤸 Somersault',
        message: 'Wheee! 🤸 Full aerial loop-de-loop!',
        animation: 'trick_somersault',
        duration: 1.8
    },
    dance: {
        id: 'dance',
        name: 'Starlight Dance',
        label: '💃 Dance',
        message: 'La la la! 💃 Dancing to the starlight melody!',
        animation: 'trick_dance',
        duration: 2.2
    }
});

class PetInteractionManager {
    constructor() {
        this.lastAffectionIndex = -1;
        this.affectionHistory = [];
        this.lastPetTime = 0;
        this.petCooldownMs = 350; // Prevent spam clicks from breaking state
    }

    /**
     * Get a non-repeating varied affection phrase.
     * @returns {string}
     */
    getNextAffectionPhrase() {
        let index;
        const total = AFFECTION_PHRASES.length;
        if (total <= 1) return AFFECTION_PHRASES[0];

        // Ensure we don't pick the same phrase as the immediate previous one
        do {
            index = Math.floor(Math.random() * total);
        } while (index === this.lastAffectionIndex);

        this.lastAffectionIndex = index;
        const phrase = AFFECTION_PHRASES[index];
        this.affectionHistory.push({ phrase, timestamp: Date.now() });
        if (this.affectionHistory.length > 20) this.affectionHistory.shift();

        return phrase;
    }

    /**
     * Check if a pet action can be triggered (rate-limiting).
     * @returns {boolean}
     */
    canTriggerPet() {
        const now = Date.now();
        if (now - this.lastPetTime < this.petCooldownMs) {
            return false;
        }
        this.lastPetTime = now;
        return true;
    }

    /**
     * Get trick definition by name or alias.
     * @param {string} trickName
     * @returns {object|null}
     */
    getTrick(trickName) {
        if (!trickName) return null;
        const key = String(trickName).toLowerCase().trim();
        const aliases = {
            twirl: 'spin',
            leap: 'jump',
            flight: 'fly',
            glide: 'fly',
            flutter: 'bounce',
            flip: 'somersault',
            loop: 'somersault',
            groove: 'dance'
        };
        const resolved = aliases[key] || key;
        return TRICK_DEFINITIONS[resolved] || null;
    }

    /**
     * List all available trick definitions.
     * @returns {Array<object>}
     */
    listTricks() {
        return Object.values(TRICK_DEFINITIONS);
    }
}

// Support both Node.js (CommonJS) and browser environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        AFFECTION_PHRASES,
        TRICK_DEFINITIONS,
        PetInteractionManager
    };
}

if (typeof window !== 'undefined') {
    window.AFFECTION_PHRASES = AFFECTION_PHRASES;
    window.TRICK_DEFINITIONS = TRICK_DEFINITIONS;
    window.PetInteractionManager = PetInteractionManager;
}
