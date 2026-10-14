'use strict';

const os = require('os');
const { RISK_TIERS } = require('../security/permission-authority.js');

/**
 * Register safe system inspection tools with the ToolRegistry
 */
function registerSystemTools(registry) {
    registry.registerTool({
        id: 'system_info',
        name: 'System Inspector',
        description: 'Get verified host system status, OS information, memory, and uptime',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {}
        },
        handler: async () => {
            const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
            const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
            const uptimeHours = (os.uptime() / 3600).toFixed(1);

            return {
                ok: true,
                status: 'completed',
                platform: os.platform(),
                arch: os.arch(),
                release: os.release(),
                hostname: os.hostname(),
                memory: {
                    totalMb: totalMemMb,
                    freeMb: freeMemMb,
                    usedPercent: Math.round(((totalMemMb - freeMemMb) / totalMemMb) * 100)
                },
                uptimeHours,
                nodeVersion: process.version,
                verification: { verified: true, method: 'os_system_query' }
            };
        },
        dryRunSimulate: async () => {
            return {
                simulatedAction: 'query_os_status',
                target: 'host_system'
            };
        }
    });
}

module.exports = {
    registerSystemTools
};
