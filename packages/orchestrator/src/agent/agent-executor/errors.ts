/**
 * Custom error classes for the agent executor subsystem.
 *
 * Each class sets `this.name` to its own class name so error handlers can
 * reliably `switch` on `error.name` without `instanceof` checks across
 * module boundaries.
 *
 * @module agent-executor/errors
 */

/**
 * Thrown when an agent attempts to write to a memory key it does not
 * have permission for, as defined by the agent's `write_keys` config.
 *
 * @example
 * ```ts
 * throw new PermissionDeniedError(
 *   'Agent attempted to write to unauthorized keys: secret_key'
 * );
 * ```
 */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Thrown when an agent's LLM call exceeds its configured timeout.
 *
 * The executor wraps the `streamText` call with an `AbortController`
 * and converts the resulting `AbortError` into this typed error.
 *
 * @example
 * ```ts
 * throw new AgentTimeoutError('agent-123', 120_000);
 * // → "Agent agent-123 timed out after 120000ms"
 * ```
 */
export class AgentTimeoutError extends Error {
  constructor(agent_id: string, timeout_ms: number) {
    super(`Agent ${agent_id} timed out after ${timeout_ms}ms`);
    this.name = 'AgentTimeoutError';
  }
}

/**
 * Thrown when an agent's LLM call fails for any non-timeout reason
 * (API errors, rate limits, network failures, etc.).
 *
 * The original error is preserved via the native ES2022 `cause` property.
 *
 * @example
 * ```ts
 * throw new AgentExecutionError('agent-456', originalError);
 * // → "Agent agent-456 execution failed: API rate limited"
 * // access original via error.cause
 * ```
 */
export class AgentExecutionError extends Error {
  constructor(agent_id: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Agent ${agent_id} execution failed: ${message}`, { cause });
    this.name = 'AgentExecutionError';
  }
}
