/**
 * Runner Error Types
 *
 * Domain-specific errors thrown by the {@link GraphRunner} when
 * resource limits are exceeded.
 *
 * @module runner/errors
 */

/**
 * Thrown when a workflow exceeds its configured token budget.
 */
export class BudgetExceededError extends Error {
  constructor(
    /** Tokens consumed at the time of breach. */
    public readonly tokensUsed: number,
    /** The configured budget limit. */
    public readonly budget: number,
  ) {
    super(`Token budget exceeded: ${tokensUsed} tokens used, budget was ${budget}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Thrown when a workflow exceeds its configured execution time.
 */
export class WorkflowTimeoutError extends Error {
  constructor(
    /** The workflow definition ID. */
    public readonly workflowId: string,
    /** The specific run ID that timed out. */
    public readonly runId: string,
    /** Elapsed wall-clock time in milliseconds. */
    public readonly elapsedMs: number,
  ) {
    super(`Workflow ${workflowId} (run ${runId}) timed out after ${elapsedMs}ms`);
    this.name = 'WorkflowTimeoutError';
  }
}

/**
 * Thrown when a node is missing required configuration for its type.
 */
export class NodeConfigError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly missingField: string,
  ) {
    super(`${nodeType} node "${nodeId}" is missing ${missingField}`);
    this.name = 'NodeConfigError';
  }
}

/**
 * Thrown when a circuit breaker is open and the timeout has not elapsed.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly nodeId: string,
  ) {
    super(`Circuit breaker open for node ${nodeId}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Thrown when event log recovery fails due to missing or corrupt events.
 */
export class EventLogCorruptionError extends Error {
  constructor(
    public readonly runId: string,
  ) {
    super(`Event log corrupted or incomplete for run ${runId}`);
    this.name = 'EventLogCorruptionError';
  }
}

/**
 * Thrown when a node type is not recognized by the graph runner.
 */
export class UnsupportedNodeTypeError extends Error {
  constructor(
    public readonly nodeType: string,
  ) {
    super(`Unsupported node type: ${nodeType}`);
    this.name = 'UnsupportedNodeTypeError';
  }
}
