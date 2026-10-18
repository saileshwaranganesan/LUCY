'use strict';

/**
 * CelestialFamiliarRenderer
 * Canonical companion module entry point.
 * Exports the unified feminine fantasy fairy rendering engine.
 */
if (typeof require !== 'undefined') {
    const { CelestialFamiliarRenderer } = require('../ui/companion-renderer.js');
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { CelestialFamiliarRenderer };
    }
}
