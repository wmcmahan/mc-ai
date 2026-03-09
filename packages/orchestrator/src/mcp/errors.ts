/**
 * MCP Error Classes
 *
 * Typed errors for the MCP gateway client and tool execution subsystem.
 * These are caught by the tool adapter for graceful degradation when the
 * MCP gateway is unavailable or a tool execution fails.
 *
 * @module mcp/errors
 */

/**
 * Thrown when the MCP gateway is unreachable or returns an HTTP error.
 *
 * This error is thrown after all retry attempts are exhausted for transient
 * failures (ECONNREFUSED, timeouts, etc.), or immediately for non-transient
 * errors (HTTP 4xx). The tool adapter catches this and falls back to
 * built-in tools only.
 *
 * @example
 * ```ts
 * throw new MCPGatewayError('listTools failed: HTTP 503 - Service Unavailable');
 * ```
 */
export class MCPGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPGatewayError';
  }
}

/**
 * Thrown when an MCP tool execution fails.
 *
 * This occurs when the gateway successfully receives the request but the
 * tool itself reports an error (returned in the response body's `error` field).
 * The `toolName` property is available for programmatic error handling.
 *
 * @example
 * ```ts
 * throw new MCPToolExecutionError('calculator', 'Division by zero');
 * ```
 */
export class MCPToolExecutionError extends Error {
  constructor(
    /** Name of the tool that failed (immutable for reliable error handling). */
    public readonly toolName: string,
    message: string,
  ) {
    super(`Tool execution failed (${toolName}): ${message}`);
    this.name = 'MCPToolExecutionError';
  }
}
