/**
 * MCP Error Classes
 *
 * Typed errors for the MCP connection manager and tool resolution subsystem.
 *
 * @module mcp/errors
 */

/**
 * Thrown when a tool source references an MCP server ID not found in the registry.
 *
 * @example
 * ```ts
 * throw new MCPServerNotFoundError('my-server');
 * ```
 */
export class MCPServerNotFoundError extends Error {
  constructor(
    /** The server ID that was not found. */
    public readonly serverId: string,
  ) {
    super(`MCP server not found in registry: "${serverId}"`);
    this.name = 'MCPServerNotFoundError';
  }
}

/**
 * Thrown when an agent is not authorized to use an MCP server.
 *
 * @example
 * ```ts
 * throw new MCPAccessDeniedError('agent-123', 'web-search');
 * ```
 */
export class MCPAccessDeniedError extends Error {
  constructor(
    /** The agent ID that was denied access. */
    public readonly agentId: string,
    /** The server ID the agent tried to access. */
    public readonly serverId: string,
  ) {
    super(`Agent "${agentId}" is not authorized to use MCP server "${serverId}"`);
    this.name = 'MCPAccessDeniedError';
  }
}
