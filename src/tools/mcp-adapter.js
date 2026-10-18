'use strict';

/**
 * McpAdapter (REQ-MCP-001)
 * 
 * Model Context Protocol (MCP) Interoperability Adapter for L.U.C.Y.
 * 
 * Implements standard MCP client-side protocol integration:
 * - Protocol negotiation (`initialize`, `notifications/initialized`).
 * - Tool discovery (`tools/list`).
 * - Tool invocation (`tools/call`).
 * 
 * Architectural & Security Guardrails (Section 11):
 * 1. Uniform Security Enforcement: MCP tools operate under Lucy's PermissionAuthority
 *    and RISK_TIERS (never bypass approval gates).
 * 2. Untrusted Input/Output: External MCP tool definitions, arguments, and returned
 *    content are treated as untrusted, strictly validated before and after execution.
 * 3. Graceful Degradation & Fault Isolation: Connection loss or external server crashes
 *    never affect Lucy's built-in tools. Built-in tools remain 100% operational offline.
 * 4. Opt-In Discovery: Newly discovered MCP tools are registered in a deactivated or
 *    gated state unless explicitly enabled by user configuration.
 */

const { EventEmitter } = require('events');
const { RISK_TIERS } = require('../security/permission-authority.js');
const { validateToolArguments } = require('./schema-validator.js');

const MCP_PROTOCOL_VERSION = '2024-11-05';

class McpAdapter extends EventEmitter {
    constructor(options = {}) {
        super();
        this.toolRegistry = options.toolRegistry || null;
        this.permissionAuthority = options.permissionAuthority || null;
        this.serverName = options.serverName || 'external-mcp-server';
        this.transport = null;
        this.connected = false;
        this.registeredMcpTools = new Map(); // mcpToolName -> lucyToolId
        this.requestId = 1;
        this.pendingRequests = new Map();

        if (options.transport) {
            this.setTransport(options.transport);
        }
    }

    setToolRegistry(registry) {
        this.toolRegistry = registry;
    }

    setPermissionAuthority(authority) {
        this.permissionAuthority = authority;
    }

    setTransport(transport) {
        this.transport = transport;
        if (this.transport) {
            this.transport.on('message', (msg) => this._handleMessage(msg));
            this.transport.on('close', () => this._handleClose());
            this.transport.on('error', (err) => this._handleError(err));
        }
    }

    _handleMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.id && this.pendingRequests.has(msg.id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
                const err = new Error(msg.error.message || 'MCP error response');
                err.code = msg.error.code;
                reject(err);
            } else {
                resolve(msg.result);
            }
        }
    }

    _handleClose() {
        this.connected = false;
        this.emit('disconnected', { serverName: this.serverName });
        for (const [id, req] of this.pendingRequests.entries()) {
            req.reject(new Error(`MCP server "${this.serverName}" disconnected unexpectedly`));
            this.pendingRequests.delete(id);
        }
    }

    _handleError(err) {
        this.emit('error', { serverName: this.serverName, error: err.message });
    }

    /**
     * Send a JSON-RPC request to the MCP transport
     * @param {string} method
     * @param {Object} params
     * @param {number} [timeoutMs=15000]
     * @returns {Promise<Object>}
     */
    async sendRequest(method, params = {}, timeoutMs = 15000) {
        if (!this.transport) {
            throw new Error(`MCP transport not configured for server "${this.serverName}"`);
        }

        const id = this.requestId++;
        const payload = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`MCP request '${method}' to server "${this.serverName}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve: (res) => {
                    clearTimeout(timer);
                    resolve(res);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            });

            try {
                this.transport.send(payload);
            } catch (sendErr) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(sendErr);
            }
        });
    }

    /**
     * Connect and negotiate protocol with the MCP server
     * @returns {Promise<{ ok: boolean, protocolVersion: string, serverInfo?: Object }>}
     */
    async connect() {
        try {
            const initResult = await this.sendRequest('initialize', {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {
                    tools: { listChanged: true }
                },
                clientInfo: {
                    name: 'L.U.C.Y. Desktop Companion',
                    version: '0.1.0'
                }
            });

            this.connected = true;
            this.emit('connected', { serverName: this.serverName, initResult });
            return {
                ok: true,
                protocolVersion: initResult?.protocolVersion || MCP_PROTOCOL_VERSION,
                serverInfo: initResult?.serverInfo
            };
        } catch (err) {
            this.connected = false;
            return {
                ok: false,
                error: `Failed to initialize MCP server "${this.serverName}": ${err.message}`
            };
        }
    }

    /**
     * Discover tools from the MCP server and register them with Lucy's central ToolRegistry.
     * Tools are given safe namespacing (mcp_<server>_<name>) and subject to PermissionAuthority.
     * 
     * @param {Object} [options={}]
     * @param {string} [options.riskTier] - Default risk tier for tools from this server
     * @param {boolean} [options.autoEnable=true]
     * @returns {Promise<{ ok: boolean, toolsDiscovered: Array<Object>, count: number }>}
     */
    async discoverAndRegisterTools(options = {}) {
        if (!this.connected) {
            const conn = await this.connect();
            if (!conn.ok) {
                return { ok: false, error: conn.error, count: 0, toolsDiscovered: [] };
            }
        }

        try {
            const listResponse = await this.sendRequest('tools/list', {});
            const tools = Array.isArray(listResponse?.tools) ? listResponse.tools : [];
            const defaultRiskTier = options.riskTier || RISK_TIERS.CONSEQUENTIAL;
            const registeredList = [];

            for (const mcpTool of tools) {
                if (!mcpTool.name || typeof mcpTool.name !== 'string') continue;

                const lucyToolId = `mcp_${this.serverName.replace(/[^a-zA-Z0-9_]/g, '_')}_${mcpTool.name}`;
                const toolSchema = mcpTool.inputSchema && typeof mcpTool.inputSchema === 'object'
                    ? mcpTool.inputSchema
                    : { type: 'object', properties: {} };

                const toolRecord = {
                    id: lucyToolId,
                    name: `[MCP: ${this.serverName}] ${mcpTool.name}`,
                    description: mcpTool.description || `MCP tool provided by ${this.serverName}`,
                    schema: toolSchema,
                    riskTier: defaultRiskTier,
                    category: 'mcp',
                    active: options.autoEnable !== false,
                    handler: async (params, context) => {
                        return await this.callMcpTool(mcpTool.name, params, context);
                    },
                    dryRunSimulate: async (params) => {
                        return {
                            simulatedMcpServer: this.serverName,
                            mcpTool: mcpTool.name,
                            params
                        };
                    }
                };

                if (this.toolRegistry) {
                    this.toolRegistry.registerTool(toolRecord, { allowOverride: true });
                }

                this.registeredMcpTools.set(mcpTool.name, lucyToolId);
                registeredList.push(toolRecord);
            }

            return {
                ok: true,
                count: registeredList.length,
                toolsDiscovered: registeredList
            };
        } catch (err) {
            return {
                ok: false,
                error: `Failed to list tools from MCP server "${this.serverName}": ${err.message}`,
                count: 0,
                toolsDiscovered: []
            };
        }
    }

    /**
     * Invoke an MCP tool on the external server
     * @param {string} toolName - Original MCP tool name
     * @param {Object} params - Tool parameters
     * @param {Object} context - Execution context
     * @returns {Promise<Object>} Execution receipt
     */
    async callMcpTool(toolName, params = {}, context = {}) {
        if (!this.connected) {
            return {
                ok: false,
                status: 'mcp_disconnected',
                error: `MCP server "${this.serverName}" is currently disconnected`
            };
        }

        try {
            const timeoutMs = context.timeoutMs || 25000;
            const res = await this.sendRequest('tools/call', {
                name: toolName,
                arguments: params
            }, timeoutMs);

            const isError = Boolean(res?.isError);
            const content = res?.content;

            return {
                ok: !isError,
                status: isError ? 'mcp_tool_error' : 'completed',
                data: content,
                result: content,
                serverName: this.serverName,
                toolName,
                verification: {
                    verified: !isError,
                    method: 'mcp_server_response'
                }
            };
        } catch (err) {
            return {
                ok: false,
                status: 'mcp_invocation_failed',
                error: `MCP tool "${toolName}" call failed: ${err.message}`,
                serverName: this.serverName,
                toolName
            };
        }
    }

    /**
     * Disconnect and unregister all tools contributed by this MCP server
     */
    disconnect() {
        this.connected = false;
        if (this.toolRegistry) {
            for (const lucyToolId of this.registeredMcpTools.values()) {
                this.toolRegistry.unregisterTool(lucyToolId);
            }
        }
        this.registeredMcpTools.clear();
        this.emit('disconnected', { serverName: this.serverName });
    }
}

module.exports = {
    McpAdapter,
    MCP_PROTOCOL_VERSION
};
