/**
 * MCP Gateway Client
 *
 * HTTP client for communicating with the MCP gateway service.
 * Handles tool listing, execution, and health checks with built-in
 * retry logic and structured logging.
 *
 * Hardened with:
 * - Per-request `AbortController` timeouts (default 30 s)
 * - Linear-backoff retries for transient failures
 * - Structured logging on every retry and final failure
 * - URL-encoded tool names to prevent path injection
 *
 * @module mcp/gateway-client
 */

import { createLogger } from '../utils/logger.js';
import { MCPGatewayError, MCPToolExecutionError } from './errors.js';

const logger = createLogger('mcp.gateway');

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Tool definition returned by the MCP gateway.
 *
 * Contains the tool's identity, description, and JSON Schema for
 * parameter validation.
 */
export interface MCPTool {
  /** Unique tool identifier (e.g., `"web_search"`, `"file_read"`). */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema defining the tool's expected input parameters. */
  inputSchema: JSONSchema;
}

/**
 * Subset of JSON Schema used by MCP tool input definitions.
 *
 * Supports the common types needed for tool parameter validation.
 * Unknown schema types fall back to `z.any()` during Zod conversion.
 */
export interface JSONSchema {
  /** Schema type: `"object"`, `"string"`, `"number"`, `"integer"`, `"boolean"`, `"array"`. */
  type: string;
  /** Property schemas for `object` types. */
  properties?: Record<string, JSONSchema>;
  /** Item schema for `array` types. */
  items?: JSONSchema;
  /** Required property names for `object` types. */
  required?: string[];
  /** Human-readable description of the schema. */
  description?: string;
  /** Allowed values for enum constraints. */
  enum?: unknown[];
}

/** Request body sent to the MCP gateway's tool execution endpoint. */
export interface ToolExecuteRequest {
  /** Tool input parameters. */
  parameters: Record<string, unknown>;
  /** ID of the agent making the call (for audit logging). */
  agent_id: string;
}

/** Response body from the MCP gateway's tool execution endpoint. */
export interface ToolExecuteResponse {
  /** Tool execution result (`undefined` if error). */
  result: unknown;
  /** Error message if execution failed. */
  error?: string;
}

/** Configuration for the MCP gateway client. */
export interface MCPClientConfig {
  /** Base URL for the MCP gateway (default: `MCP_GATEWAY_URL` env var or `http://localhost:3001`). */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
  /** Max retry attempts for transient failures (default: 2). */
  retries?: number;
  /** Base delay between retries in ms, multiplied by attempt number (default: 1 000). */
  retryDelayMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Dedicated health-check timeout (shorter than default). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

// ─── Client ─────────────────────────────────────────────────────────

/**
 * HTTP client for communicating with the MCP gateway service.
 *
 * Provides methods to list available tools, execute tool calls, and
 * probe gateway health. All network calls are instrumented with
 * timeouts, retries, and structured logging.
 */
export class MCPGatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(config?: MCPClientConfig) {
    this.baseUrl = config?.baseUrl || process.env.MCP_GATEWAY_URL || 'http://localhost:3001';
    this.timeoutMs = config?.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retries = config?.retries ?? DEFAULT_RETRIES;
    this.retryDelayMs = config?.retryDelayMs || DEFAULT_RETRY_DELAY_MS;
  }

  /**
   * List all available tools from the MCP gateway.
   *
   * Fetches the complete tool catalog via `GET /tools`. Results include
   * each tool's name, description, and JSON Schema input specification.
   *
   * @returns Array of available MCP tool definitions.
   * @throws {MCPGatewayError} If the gateway is unreachable after all retries.
   */
  async listTools(): Promise<MCPTool[]> {
    return this.fetchWithRetry<MCPTool[]>('GET', '/tools', undefined, 'listTools');
  }

  /**
   * Execute a tool via the MCP gateway.
   *
   * Sends a `POST /tools/{toolName}/execute` request. If the response
   * contains an `error` field, throws {@link MCPToolExecutionError}.
   *
   * @param toolName - The name of the tool to execute.
   * @param parameters - Tool input parameters.
   * @param agentId - Optional agent ID for audit logging.
   * @returns The tool execution result.
   * @throws {MCPToolExecutionError} If the tool reports an execution error.
   * @throws {MCPGatewayError} If the gateway is unreachable after all retries.
   */
  async executeTool(toolName: string, parameters: Record<string, unknown>, agentId?: string): Promise<unknown> {
    const data = await this.fetchWithRetry<ToolExecuteResponse>(
      'POST',
      `/tools/${encodeURIComponent(toolName)}/execute`,
      { parameters, agent_id: agentId },
      'executeTool'
    );

    if (data.error) {
      throw new MCPToolExecutionError(toolName, data.error);
    }

    return data.result;
  }

  /**
   * Lightweight health probe for the MCP gateway.
   *
   * Sends `GET /health` with a short timeout. Returns `true` if the
   * gateway responds with HTTP 2xx, `false` on any error. Never throws.
   *
   * @returns `true` if gateway is healthy, `false` otherwise.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Return the configured gateway base URL.
   *
   * Primarily useful in tests and diagnostics.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Fetch with timeout and retry.
   *
   * Wraps each attempt with an `AbortController` timeout and retries
   * on transient errors (network failures, timeouts). Non-transient
   * errors (HTTP 4xx, non-network errors) fail immediately.
   *
   * @param method - HTTP method.
   * @param path - URL path appended to `baseUrl`.
   * @param body - Request body (JSON-serialized).
   * @param operation - Operation name for logging context.
   * @returns Parsed JSON response.
   * @throws {MCPGatewayError} On persistent connection or HTTP errors.
   */
  private async fetchWithRetry<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    operation: string
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new MCPGatewayError(
            `${operation} failed: HTTP ${response.status} - ${errorText}`
          );
        }

        return await response.json() as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const isAbort = lastError.name === 'AbortError';
        const isRetryable = isAbort || this.isTransientError(lastError);

        if (isAbort) {
          lastError = new MCPGatewayError(
            `${operation} timed out after ${this.timeoutMs}ms`
          );
        }

        if (!isRetryable || attempt > this.retries) {
          logger.error(operation, lastError, {
            attempt,
            path,
            retryable: isRetryable,
          });
          break;
        }

        const delay = this.retryDelayMs * attempt;
        logger.warn(`${operation}.retry`, {
          attempt,
          delay_ms: delay,
          error: lastError.message,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (lastError instanceof MCPGatewayError || lastError instanceof MCPToolExecutionError) {
      throw lastError;
    }
    throw new MCPGatewayError(
      `Failed to connect to MCP gateway at ${this.baseUrl}: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Determine if an error is transient and retryable.
   *
   * Matches against known transient error patterns: ECONNREFUSED,
   * ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failures, and socket errors.
   */
  private isTransientError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return TRANSIENT_PATTERNS.some(p => msg.includes(p));
  }
}

/** Lowercase patterns that indicate a transient network error. */
const TRANSIENT_PATTERNS = [
  'econnrefused', 'econnreset', 'etimedout', 'enotfound',
  'fetch failed', 'network', 'socket hang up',
];

// ─── Factory & Singleton ────────────────────────────────────────────

/**
 * Create a new MCP gateway client instance.
 *
 * Preferred over the singleton {@link mcpClient} for testability —
 * pass a custom config to point at a test server or adjust timeouts.
 *
 * @param config - Optional client configuration.
 * @returns A new {@link MCPGatewayClient} instance.
 */
export function createMCPClient(config?: MCPClientConfig): MCPGatewayClient {
  return new MCPGatewayClient(config);
}

/** Default singleton instance using environment-based configuration. */
export const mcpClient = new MCPGatewayClient();
