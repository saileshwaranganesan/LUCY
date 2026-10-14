'use strict';

/**
 * Validates tool call parameters against a tool's JSON schema.
 * Rejects:
 * - Missing required parameters
 * - Type mismatches (string, number, boolean, array, object, union types)
 * - Disallowed enum values
 * - Non-object parameters
 * 
 * @param {Object} schema - JSON schema definition
 * @param {Object} params - Proposed tool arguments
 * @returns {{ valid: boolean, error?: string, missingParameter?: string }}
 */
function checkType(val, typeDef) {
    if (Array.isArray(typeDef)) {
        return typeDef.some((t) => checkType(val, t));
    }
    switch (typeDef) {
        case 'string':
            return typeof val === 'string';
        case 'number':
        case 'integer':
            return typeof val === 'number' && !Number.isNaN(val);
        case 'boolean':
            return typeof val === 'boolean';
        case 'array':
            return Array.isArray(val);
        case 'object':
            return typeof val === 'object' && val !== null && !Array.isArray(val);
        default:
            return true;
    }
}

function validateToolArguments(schema, params) {
    if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
        return { valid: true };
    }

    if (params === undefined || params === null || typeof params !== 'object' || Array.isArray(params)) {
        return { valid: false, error: 'Parameters must be a non-null object' };
    }

    // 1. Check required properties
    if (Array.isArray(schema.required)) {
        for (const reqProp of schema.required) {
            const val = params[reqProp];
            if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
                return {
                    valid: false,
                    error: `Missing required parameter: '${reqProp}'`,
                    missingParameter: reqProp
                };
            }
        }
    }

    // 2. Check property types and enums
    if (schema.properties && typeof schema.properties === 'object') {
        for (const [propName, propDef] of Object.entries(schema.properties)) {
            const val = params[propName];
            if (val === undefined || val === null) {
                continue; // Non-required properties can be absent
            }

            if (propDef.type && !checkType(val, propDef.type)) {
                const expected = Array.isArray(propDef.type) ? propDef.type.join(' or ') : propDef.type;
                return {
                    valid: false,
                    error: `Parameter '${propName}' must be a ${expected}, received ${typeof val}`
                };
            }

            if (Array.isArray(propDef.enum) && !propDef.enum.includes(val)) {
                return {
                    valid: false,
                    error: `Parameter '${propName}' must be one of [${propDef.enum.join(', ')}], received '${val}'`
                };
            }
        }
    }

    return { valid: true };
}

module.exports = {
    checkType,
    validateToolArguments
};
