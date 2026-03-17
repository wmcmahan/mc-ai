/**
 * Graph Runner
 *
 * Core execution engine for the orchestrator. Validates graph
 * structure, executes nodes in topological order with retry /
 * circuit-breaker logic, persists state after every step for
 * resumability, and emits events for observability.
 *
 * @module runner/graph-runner
 */

import { EventEmitter } from 'events';
import type { Graph, GraphNode, GraphEdge } from '../types/graph.js';
import type { WorkflowState, Action, StateView } from '../types/state.js';
import { rootReducer, internalReducer, validateAction } from '../reducers/index.js';
import { calculateBackoff, sleep } from './helpers.js';
import { evaluateCondition } from './conditions.js';
import { validateGraph } from '../validation/graph-validator.js';
import { ActionSchema } from '../types/state.js';
import { createLogger } from '../utils/logger.js';
import { BudgetExceededError, WorkflowTimeoutError, NodeConfigError, CircuitBreakerOpenError, EventLogCorruptionError, UnsupportedNodeTypeError } from './errors.js';
import { calculateCost } from '../utils/pricing.js';
import {
  incrementWorkflowsStarted,
  incrementWorkflowsCompleted,
  incrementWorkflowsFailed,
  recordWorkflowDuration,
  recordTokensUsed,
  recordCostUsd,
} from '../utils/metrics.js';
import type { EventLogWriter } from '../db/event-log.js';
import { NoopEventLogWriter } from '../db/event-log.js';
import type { EventType, WorkflowEvent } from '../types/event.js';
import type { StreamEvent } from './stream-events.js';

// Re-export error classes for backward compatibility
export { BudgetExceededError, WorkflowTimeoutError };
import { getTracer, withSpan } from '../utils/tracing.js';
import { v4 as uuidv4 } from 'uuid';
import type { GraphRunnerMiddleware, MiddlewareContext } from './middleware.js';

// External runtime dependencies — imported here so tests can mock them
import { executeAgent } from '../agent/agent-executor/executor.js';
import { executeSupervisor } from '../agent/supervisor-executor/executor.js';
import { evaluateQualityExecutor } from '../agent/evaluator-executor/executor.js';
import type { ToolResolver } from '../mcp/connection-manager.js';
import type { ToolSource } from '../types/tools.js';
import { agentFactory } from '../agent/agent-factory/index.js';
import { getTaintRegistry } from '../utils/taint.js';
import { PermissionDeniedError } from '../agent/agent-executor/errors.js';

// Extracted modules
import { CircuitBreakerManager } from './circuit-breaker.js';
import { createStateView } from './state-view.js';
import type { NodeExecutorContext } from './node-executors/context.js';
import {
  executeAgentNode,
  executeToolNode,
  executeRouterNode,
  executeSupervisorNode,
  executeApprovalNode,
  executeMapNode,
  executeVotingNode,
  executeSynthesizerNode,
  executeSubgraphNode,
  executeEvolutionNode,
} from './node-executors/index.js';

const logger = createLogger('runner.graph');
const tracer = getTracer('orchestrator.runner');

/**
 * Lightweight fallback tool resolver used when no ToolResolver (MCPConnectionManager)
 * is configured. Resolves built-in tools only; MCP sources are skipped with a warning.
 */
/**
 * Fallback tool resolver used when no {@link ToolResolver} (MCPConnectionManager)
 * is configured. Resolves built-in tools and returns echo tools for unknown
 * tool names (test/development mode).
 *
 * In production, configure a ToolResolver to get real MCP tool resolution.
 */
async function resolveBuiltinsOnly(sources: ToolSource[], _agentId?: string): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = {};
  for (const source of sources) {
    if (source.type === 'builtin' && source.name === 'save_to_memory') {
      tools.save_to_memory = {
        description: 'Save data to workflow memory for later use',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Memory key to store the value under' },
            value: { description: 'Value to save (can be any type)' },
          },
          required: ['key', 'value'],
        },
        execute: async (args: Record<string, unknown>) => {
          return { key: args.key, value: args.value, saved: true };
        },
      };
    } else if (source.type === 'mcp') {
      logger.warn('mcp_source_skipped_no_resolver', {
        server_id: source.server_id,
        hint: 'Configure a ToolResolver (MCPConnectionManager) to resolve MCP tool sources',
      });
    }
  }

  // Return a Proxy so that tool nodes can still execute in test/dev mode.
  // Any unresolved tool name returns an echo tool (args → args).
  return new Proxy(tools, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (typeof prop === 'string') {
        return {
          description: `Echo tool: ${prop} (no ToolResolver configured)`,
          parameters: {},
          execute: async (args: Record<string, unknown>) => args,
        };
      }
      return undefined;
    },
  });
}

/** Events emitted by {@link GraphRunner} for observability. */
export interface GraphRunnerEvents {
  /** Emitted when the workflow begins execution. */
  'workflow:start': { workflow_id: string; run_id: string };
  /** Emitted on successful completion. */
  'workflow:complete': { workflow_id: string; run_id: string; duration_ms: number };
  /** Emitted on unrecoverable failure. */
  'workflow:failed': { workflow_id: string; run_id: string; error: string };
  /** Emitted when the workflow exceeds its execution time limit. */
  'workflow:timeout': { workflow_id: string; run_id: string; elapsed_ms: number };
  /** Emitted when the workflow pauses for human input (HITL). */
  'workflow:waiting': { workflow_id: string; run_id: string; waiting_for: string };
  /** Emitted when compensation actions are executed (saga rollback). */
  'workflow:rollback': { workflow_id: string; run_id: string };
  /** Emitted before a node begins execution. */
  'node:start': { node_id: string; type: string; timestamp: number };
  /** Emitted after a node completes successfully. */
  'node:complete': { node_id: string; type: string; duration_ms: number };
  /** Emitted when a node execution fails. */
  'node:failed': { node_id: string; type: string; error: string; attempt: number };
  /** Emitted before a retry attempt. */
  'node:retry': { node_id: string; attempt: number; backoff_ms: number };
  /** Emitted after an action is applied via the reducer. */
  'action:applied': { action_id: string; type: string; node_id: string };
  /** Emitted after state is persisted to storage. */
  'state:persisted': { run_id: string; iteration: number };
  /** Emitted for each token delta during agent streaming. */
  'agent:token_delta': { run_id: string; node_id: string; token: string };
  /** Emitted when cost crosses a budget threshold (50%, 75%, 90%, 100%). */
  'budget:threshold_reached': {
    run_id: string;
    workflow_id: string;
    threshold_pct: number;
    cost_usd: number;
    budget_usd: number;
  };
  /** Emitted when the workflow is gracefully paused via shutdown(). */
  'workflow:paused': { workflow_id: string; run_id: string };
}

/**
 * Options for constructing a GraphRunner.
 * Preferred over positional constructor args.
 */
export interface GraphRunnerOptions {
  /** Optional function to persist state snapshots after each step */
  persistStateFn?: (state: WorkflowState) => Promise<void>;
  /** Optional function to load subgraph definitions */
  loadGraphFn?: (graphId: string) => Promise<Graph | null>;
  /** Optional event log writer for durable execution (event sourcing) */
  eventLog?: EventLogWriter;
  /** Token streaming callback — fires for each text delta from agent nodes */
  onToken?: (token: string, nodeId: string) => void;
  /** Middleware hooks for extending runner behavior */
  middleware?: GraphRunnerMiddleware[];
  /**
   * Tool resolver for structured ToolSource declarations.
   * When provided, resolves MCP server tools via `@ai-sdk/mcp` clients.
   * Without it, only built-in tools are resolved.
   * Typically an MCPConnectionManager instance.
   */
  toolResolver?: ToolResolver;
  /**
   * When true, automatically execute compensation actions (saga rollback)
   * before marking the workflow as failed. If rollback succeeds, the
   * workflow transitions to 'cancelled' instead of 'failed'.
   * Defaults to false.
   */
  auto_rollback?: boolean;
}

/**
 * Graph execution engine with observability and resilience.
 *
 * @example
 * ```ts
 * const runner = new GraphRunner(graph, initialState, { eventLog });
 * const result = await runner.run();
 * ```
 */
export class GraphRunner extends EventEmitter {
  private graph: Graph;
  private state: WorkflowState;
  private circuitBreakers: CircuitBreakerManager = new CircuitBreakerManager();
  private executedActions: Set<string> = new Set(); // Idempotency tracking
  private startTime?: number;
  private persistStateFn?: (state: WorkflowState) => Promise<void>;
  private loadGraphFn?: (graphId: string) => Promise<Graph | null>;

  // Pre-built lookup maps for O(1) node/edge access (built once in constructor)
  private readonly nodeMap: Map<string, GraphNode>;
  private readonly edgeMap: Map<string, GraphEdge[]>;

  // Event sourcing — durable execution
  private readonly eventLog: EventLogWriter;
  private sequenceId: number = 0;

  // Token streaming callback
  private onToken?: (token: string, nodeId: string) => void;

  // Middleware hooks
  private readonly middleware: GraphRunnerMiddleware[];

  // Tool resolver for structured ToolSource declarations (MCPConnectionManager)
  private readonly toolResolver?: ToolResolver;

  // Auto-rollback on failure (saga compensation)
  private readonly autoRollback: boolean;

  // Cancellation — allows external abort of in-flight agent/supervisor calls
  private abortController: AbortController = new AbortController();

  // Graceful shutdown — finish current node, then pause
  private _shuttingDown = false;

  // Streaming — only active when stream() is called
  private isStreaming = false;
  private tokenChannel: StreamEvent[] = [];
  private tokenNotify?: () => void;
  private pendingEvents: StreamEvent[] = [];
  private lastRunError?: Error;

  /**
   * Create a new GraphRunner.
   *
   * Supports two calling conventions for backward compatibility:
   *   - Options object (preferred):  new GraphRunner(graph, state, { persistStateFn, eventLog })
   *   - Positional args (legacy):    new GraphRunner(graph, state, persistStateFn, loadGraphFn)
   */
  constructor(
    graph: Graph,
    initialState: WorkflowState,
    optionsOrPersistFn?: GraphRunnerOptions | ((state: WorkflowState) => Promise<void>),
    loadGraphFn?: (graphId: string) => Promise<Graph | null>,
  ) {
    super();
    this.graph = graph;
    this.state = initialState;

    // Support both calling conventions
    if (typeof optionsOrPersistFn === 'function') {
      // Legacy positional args
      this.persistStateFn = optionsOrPersistFn;
      this.loadGraphFn = loadGraphFn;
      this.eventLog = new NoopEventLogWriter();
      this.middleware = [];
      this.autoRollback = false;
    } else if (optionsOrPersistFn) {
      // Options object
      this.persistStateFn = optionsOrPersistFn.persistStateFn;
      this.loadGraphFn = optionsOrPersistFn.loadGraphFn;
      this.eventLog = optionsOrPersistFn.eventLog ?? new NoopEventLogWriter();
      this.onToken = optionsOrPersistFn.onToken;
      this.middleware = optionsOrPersistFn.middleware ?? [];
      this.toolResolver = optionsOrPersistFn.toolResolver;
      this.autoRollback = optionsOrPersistFn.auto_rollback ?? false;
    } else {
      // No options or undefined persistFn — still check for legacy loadGraphFn 4th arg
      this.loadGraphFn = loadGraphFn;
      this.eventLog = new NoopEventLogWriter();
      this.middleware = [];
      this.autoRollback = false;
    }

    // Build O(1) lookup structures
    this.nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    this.edgeMap = new Map<string, GraphEdge[]>();
    for (const edge of graph.edges) {
      const list = this.edgeMap.get(edge.source);
      if (list) {
        list.push(edge);
      } else {
        this.edgeMap.set(edge.source, [edge]);
      }
    }
  }

  /**
   * Cancel a running workflow.
   *
   * Aborts any in-flight LLM calls (agent/supervisor) by signaling the
   * shared AbortController, then transitions the workflow to 'cancelled' status.
   * The main `run()` loop checks the abort signal on each iteration and will
   * exit cleanly after the current node finishes or aborts.
   */
  cancel(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
      this.dispatchInternal('_cancel');
      logger.info('workflow_cancelled', {
        workflow_id: this.state.workflow_id,
        run_id: this.state.run_id,
      });
    }
  }

  /**
   * Request graceful shutdown. The current node will complete,
   * state will be persisted, and the workflow will pause (resumable).
   * Emits 'workflow:paused' when the shutdown is complete.
   */
  shutdown(): void {
    this._shuttingDown = true;
    logger.info('shutdown_requested', {
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
    });
  }

  /**
   * Dispatch an internal state transition through the internalReducer.
   * Used for runner-controlled lifecycle events (init, fail, complete, etc.).
   * Bypasses permission checks since these are trusted internal operations.
   */
  private dispatchInternal(type: string, payload: Record<string, unknown> = {}): void {
    const action: Action = {
      id: uuidv4(),
      idempotency_key: `_internal:${type}:${Date.now()}`,
      type: type as Action['type'],
      payload,
      metadata: { node_id: '_runner', timestamp: new Date(), attempt: 1 },
    };
    this.state = internalReducer(this.state, action);

    // Fire-and-forget: log internal dispatch to event store
    this.appendEvent('internal_dispatched', { internal_type: type, internal_payload: payload });
  }

  // Event log failure tracking for observability
  private eventLogFailures: number = 0;

  /**
   * Append an event to the durable event log.
   * Fire-and-forget — failures are logged but never halt the workflow.
   * Errors are caught to prevent unhandled promise rejections and tracked
   * via a failure counter for observability.
   */
  private appendEvent(
    event_type: EventType,
    opts: {
      node_id?: string;
      action?: Action;
      internal_type?: string;
      internal_payload?: Record<string, unknown>;
    } = {},
  ): void {
    const event = {
      run_id: this.state.run_id,
      sequence_id: this.sequenceId++,
      event_type,
      ...opts,
    };
    // Intentionally not awaited — event log is best-effort alongside
    // the primary state snapshot path.
    this.eventLog.append(event).catch((error) => {
      this.eventLogFailures++;
      logger.error('event_log_append_failed', error, {
        run_id: this.state.run_id,
        sequence_id: event.sequence_id,
        event_type,
        consecutive_failures: this.eventLogFailures,
      });
    });
  }

  /**
   * Build the context object passed to node executor functions.
   */
  private buildExecutorContext(): NodeExecutorContext {
    // Enable token streaming when there are event listeners (SSE bridge),
    // an explicit onToken callback was provided, or stream() is active.
    const shouldStream = this.isStreaming || !!this.onToken || this.listenerCount('agent:token_delta') > 0;

    const onToken = shouldStream
      ? (token: string, nodeId: string) => {
        this.emit('agent:token_delta', {
          run_id: this.state.run_id,
          node_id: nodeId,
          token,
        });
        this.onToken?.(token, nodeId);

        // Push real-time token events to the streaming channel
        if (this.isStreaming) {
          this.tokenChannel.push({
            type: 'agent:token_delta',
            run_id: this.state.run_id,
            node_id: nodeId,
            token,
            timestamp: Date.now(),
          });
          this.tokenNotify?.();
        }
      }
      : undefined;

    return {
      state: this.state,
      graph: this.graph,
      loadGraphFn: this.loadGraphFn,
      createStateView: (node: GraphNode) => createStateView(this.state, node),
      abortSignal: this.abortController.signal,
      onToken,
      deps: {
        executeAgent,
        executeSupervisor,
        evaluateQualityExecutor,
        loadAgent: (agentId: string) => agentFactory.loadAgent(agentId),
        getTaintRegistry,
        resolveTools: this.toolResolver
          ? (sources) => this.toolResolver!.resolveTools(sources)
          : resolveBuiltinsOnly,
      },
    };
  }

  /**
   * Drain buffered streaming events from helper methods.
   */
  private *drainPendingEvents(): Generator<StreamEvent> {
    while (this.pendingEvents.length > 0) {
      yield this.pendingEvents.shift()!;
    }
  }

  /**
   * Execute a node and interleave real-time token deltas.
   * Uses Promise.race to yield tokens as they arrive from the LLM.
   */
  private async *executeNodeAndDrainTokens(node: GraphNode): AsyncGenerator<StreamEvent, Action> {
    this.tokenChannel.length = 0;
    const actionPromise = this.executeNodeWithTimeout(node);
    let resolved = false;

    actionPromise.then(
      () => { resolved = true; this.tokenNotify?.(); },
      () => { resolved = true; this.tokenNotify?.(); },
    );

    while (!resolved) {
      while (this.tokenChannel.length > 0) yield this.tokenChannel.shift()!;
      if (resolved) break;
      await new Promise<void>(r => { this.tokenNotify = r; });
    }
    // Drain remaining tokens after node completes
    while (this.tokenChannel.length > 0) yield this.tokenChannel.shift()!;
    return await actionPromise;
  }

  /**
   * Core execution loop as an async generator.
   * Yields StreamEvent objects at each step. Both stream() and run() consume this.
   */
  private async *executeLoop(): AsyncGenerator<StreamEvent> {
    this.startTime = Date.now();

    // Validate graph structure before running
    const validation = validateGraph(this.graph);
    if (!validation.valid) {
      const errorMsg = `Graph validation failed: ${validation.errors.join(', ')}`;
      logger.error('graph_validation_failed', new Error(errorMsg), { graph_id: this.graph.id });
      this.dispatchInternal('_fail', { last_error: errorMsg });
      await this.persistState();
      yield* this.drainPendingEvents();
      this.lastRunError = new Error(errorMsg);
      yield {
        type: 'workflow:failed',
        workflow_id: this.state.workflow_id,
        run_id: this.state.run_id,
        error: errorMsg,
        state: this.state,
        timestamp: Date.now(),
      };
      return;
    }

    // Log validation warnings
    if (validation.warnings.length > 0) {
      logger.warn('graph_validation_warnings', { warnings: validation.warnings });
    }

    logger.info('execution_started', { graph_id: this.graph.id, workflow_id: this.state.workflow_id, run_id: this.state.run_id });
    incrementWorkflowsStarted({ graph_id: this.graph.id });

    this.emit('workflow:start', {
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
    });
    yield {
      type: 'workflow:start',
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
      timestamp: Date.now(),
    };

    // Detect resume: if state already has visited nodes, we're resuming from a checkpoint
    const isResume = this.state.visited_nodes.length > 0 && this.state.current_node;
    if (isResume) {
      // Check for expired approval gate timeout BEFORE re-entering the loop.
      // If the workflow was paused at an approval node and the timeout has
      // expired since the last run, transition directly to 'timeout'.
      if (this.state.status === 'waiting' && this.state.waiting_timeout_at
          && new Date() >= this.state.waiting_timeout_at) {
        logger.info('approval_timeout_expired_on_resume', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          waiting_timeout_at: this.state.waiting_timeout_at.toISOString(),
        });
        this.dispatchInternal('_timeout');
        await this.persistState();
        yield* this.drainPendingEvents();

        const elapsed = Date.now() - (this.startTime ?? Date.now());
        this.lastRunError = new WorkflowTimeoutError(
          this.state.workflow_id,
          this.state.run_id,
          elapsed,
        );
        this.emit('workflow:timeout', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
        });
        yield {
          type: 'workflow:timeout',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
          state: this.state,
          timestamp: Date.now(),
        };
        return;
      }

      logger.info('resuming_from_checkpoint', {
        current_node: this.state.current_node,
        iteration: this.state.iteration_count,
        visited: this.state.visited_nodes.length,
      });
      this.dispatchInternal('_init', { resume: true });
      this.reconstructIdempotencyKeys();
    } else {
      this.dispatchInternal('_init', { start_node: this.graph.start_node });
    }
    await this.persistState();
    yield* this.drainPendingEvents();

    // Log workflow_started event (first event in the event log for this run)
    this.appendEvent('workflow_started');

    const workflowSpan = { setAttribute: (_k: string, _v: unknown) => {} };
    try {
      // Get a real span if tracing is available
      const realTracer = getTracer('orchestrator.runner');
      void realTracer; // span wrapping handled via withSpan pattern in run()
    } catch { /* noop */ }

    try {
      while (this.shouldContinue() && !this.abortController.signal.aborted) {
        // Check global timeout
        if (this.checkTimeout()) {
          await this.persistState();
          yield* this.drainPendingEvents();

          const elapsed_ms = Date.now() - (this.startTime ?? Date.now());
          this.lastRunError = new WorkflowTimeoutError(
            this.state.workflow_id,
            this.state.run_id,
            elapsed_ms,
          );
          yield {
            type: 'workflow:timeout',
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            elapsed_ms,
            state: this.state,
            timestamp: Date.now(),
          };
          return;
        }

        const currentNode = this.getCurrentNode();
        if (!currentNode) {
          logger.error('node_not_found', new Error(`Node not found: ${this.state.current_node}`));
          this.dispatchInternal('_fail', { last_error: `Node not found: ${this.state.current_node}` });
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
        }

        // Log node_started event before execution
        this.appendEvent('node_started', { node_id: currentNode.id });

        // Middleware context (built once per iteration, reused across hooks)
        const mwCtx: MiddlewareContext | undefined = this.middleware.length > 0
          ? { node: currentNode, state: this.state, graph: this.graph, iteration: this.state.iteration_count }
          : undefined;

        // Hook: beforeNodeExecute — can short-circuit node execution
        let action: Action | undefined;
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.beforeNodeExecute) {
              const result = await mw.beforeNodeExecute(mwCtx);
              if (result?.shortCircuit) {
                action = result.shortCircuit;
                break;
              }
            }
          }
        }

        // Execute node (with real-time token streaming when in streaming mode)
        const nodeStartTime = Date.now();
        if (!action) {
          if (this.isStreaming) {
            yield { type: 'node:start', node_id: currentNode.id, node_type: currentNode.type, timestamp: nodeStartTime };
            this.emit('node:start', { node_id: currentNode.id, type: currentNode.type, timestamp: nodeStartTime });

            // Drain any pending retry events from executeNodeWithRetry
            try {
              const gen = this.executeNodeAndDrainTokens(currentNode);
              let genResult = await gen.next();
              while (!genResult.done) {
                yield genResult.value;
                genResult = await gen.next();
              }
              action = genResult.value;
            } catch (nodeError) {
              // Drain retry events that were pushed during retries
              yield* this.drainPendingEvents();
              const errorMessage = nodeError instanceof Error ? nodeError.message : String(nodeError);
              yield {
                type: 'node:failed',
                node_id: currentNode.id,
                node_type: currentNode.type,
                error: errorMessage,
                attempt: currentNode.failure_policy.max_retries,
                timestamp: Date.now(),
              };
              this.emit('node:failed', { node_id: currentNode.id, type: currentNode.type, error: errorMessage, attempt: currentNode.failure_policy.max_retries });
              throw nodeError;
            }

            // Drain retry events accumulated during successful retries
            yield* this.drainPendingEvents();

            const duration_ms = Date.now() - nodeStartTime;
            yield { type: 'node:complete', node_id: currentNode.id, node_type: currentNode.type, duration_ms, timestamp: Date.now() };
            this.emit('node:complete', { node_id: currentNode.id, type: currentNode.type, duration_ms });
          } else {
            action = await withSpan(tracer, `node.execute.${currentNode.type}`, async (nodeSpan) => {
              nodeSpan.setAttribute('node.id', currentNode.id);
              nodeSpan.setAttribute('node.type', currentNode.type);
              return this.executeNodeWithTimeout(currentNode);
            });
          }
        }

        // Hook: afterNodeExecute — can transform action before reduce
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.afterNodeExecute) {
              const transformed = await mw.afterNodeExecute(mwCtx, action);
              if (transformed) {
                action = transformed;
              }
            }
          }
        }

        // Validate action schema — reject invalid actions
        const validationResult = ActionSchema.safeParse(action);
        if (!validationResult.success) {
          throw new Error(
            `Node "${currentNode.id}" returned invalid action: ${validationResult.error.issues.map(i => i.message).join(', ')}`
          );
        }

        // Validate action against permissions
        if (!validateAction(action, currentNode.write_keys)) {
          throw new PermissionDeniedError(`Node ${currentNode.id} tried to write to unauthorized keys`);
        }

        // Check idempotency using deterministic key
        const idempotencyKey = `${currentNode.id}:${this.state.iteration_count}`;
        if (this.executedActions.has(idempotencyKey)) {
          logger.warn('duplicate_action', { idempotency_key: idempotencyKey, node_id: currentNode.id });
          continue;
        }

        // Mark as executed
        this.executedActions.add(idempotencyKey);

        // Track compensation (saga pattern)
        if (currentNode.requires_compensation && action.compensation) {
          this.dispatchInternal('_push_compensation', {
            action_id: action.id,
            compensation_action: action.compensation,
          });
        }

        // Apply action via reducer
        this.state = rootReducer(this.state, action);

        // Hook: afterReduce — observational, after reducer
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.afterReduce) {
              await mw.afterReduce(mwCtx, action, this.state);
            }
          }
        }

        // Log action_dispatched event (captures full Action including LLM response)
        this.appendEvent('action_dispatched', { node_id: currentNode.id, action });

        // Track cumulative token usage from agent/supervisor executions
        const tokenUsage = action.metadata.token_usage;
        if (tokenUsage?.totalTokens && typeof tokenUsage.totalTokens === 'number') {
          this.dispatchInternal('_track_tokens', { tokens: tokenUsage.totalTokens });
        }

        // Track cumulative cost from token usage
        if (tokenUsage?.inputTokens !== undefined || tokenUsage?.outputTokens !== undefined) {
          const inputTokens = tokenUsage.inputTokens ?? 0;
          const outputTokens = tokenUsage.outputTokens ?? 0;
          const costUsd = this.calculateActionCost(inputTokens, outputTokens, action);
          if (costUsd > 0) {
            this.dispatchInternal('_track_cost', { cost_usd: costUsd });
            await this.checkBudgetThresholds();
            yield* this.drainPendingEvents();
          }
        }

        // Enforce token budget
        if (this.state.max_token_budget && this.state.total_tokens_used > this.state.max_token_budget) {
          const errorMsg = `Token budget exceeded: ${this.state.total_tokens_used} tokens used, budget was ${this.state.max_token_budget}`;
          logger.warn('budget_exceeded', {
            total_tokens: this.state.total_tokens_used,
            budget: this.state.max_token_budget,
            node_id: currentNode.id,
          });
          this.dispatchInternal('_budget_exceeded', { last_error: errorMsg });
          await this.persistState();
          yield* this.drainPendingEvents();
          throw new BudgetExceededError(this.state.total_tokens_used, this.state.max_token_budget);
        }

        yield {
          type: 'action:applied',
          action_id: action.id,
          action_type: action.type,
          node_id: currentNode.id,
          timestamp: Date.now(),
        };
        this.emit('action:applied', {
          action_id: action.id,
          type: action.type,
          node_id: currentNode.id,
        });

        // Persist after every step (resumability)
        await this.persistState();
        yield* this.drainPendingEvents();

        // Check for graceful shutdown
        if (this._shuttingDown) {
          logger.info('graceful_shutdown', {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            current_node: this.state.current_node,
          });
          this.emit('workflow:paused', {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
          });
          yield {
            type: 'workflow:paused' as any,
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            state: this.state,
            timestamp: Date.now(),
          };
          break;
        }

        // Advance iteration count (every node execution counts)
        this.dispatchInternal('_increment_iteration');

        // Check for cycles/max iterations
        if (this.state.iteration_count >= this.state.max_iterations) {
          logger.warn('max_iterations_reached', { iteration_count: this.state.iteration_count, max: this.state.max_iterations });
          this.dispatchInternal('_fail', { last_error: `Max iterations reached: ${this.state.iteration_count}` });
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
        }

        // Check if current node is an end node — if so, we're done
        if (this.graph.end_nodes.includes(currentNode.id)) {
          logger.info('execution_complete_at_end_node', { node_id: currentNode.id, graph_id: this.graph.id, run_id: this.state.run_id });
          this.dispatchInternal('_complete');
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
        }

        // Flow-control actions already manage state transitions via their reducers
        if (action.type === 'handoff' || action.type === 'set_status' || action.type === 'request_human_input') {
          await this.persistState();
          yield* this.drainPendingEvents();
          continue;
        }

        // Determine next node from outgoing edges
        let nextNode = this.getNextNode(currentNode);
        if (!nextNode) {
          logger.info('execution_complete', { graph_id: this.graph.id, run_id: this.state.run_id });
          this.dispatchInternal('_complete');
          await this.persistState();
          yield* this.drainPendingEvents();
          break;
        }

        // Hook: beforeAdvance — can override routing
        if (mwCtx) {
          for (const mw of this.middleware) {
            if (mw.beforeAdvance) {
              const overrideId = await mw.beforeAdvance(mwCtx, nextNode.id);
              if (overrideId) {
                const overrideNode = this.nodeMap.get(overrideId);
                if (overrideNode) {
                  nextNode = overrideNode;
                }
              }
            }
          }
        }

        // Advance current_node to the next node
        this.dispatchInternal('_advance', { node_id: nextNode.id });
        await this.persistState();
        yield* this.drainPendingEvents();
      }

      const duration_ms = Date.now() - (this.startTime ?? Date.now());

      if (this.state.status === 'completed') {
        incrementWorkflowsCompleted({ graph_id: this.graph.id });
        recordWorkflowDuration(duration_ms, { status: 'completed', graph_id: this.graph.id });
        recordTokensUsed(this.state.total_tokens_used, { graph_id: this.graph.id });
        if (this.state.total_cost_usd > 0) {
          recordCostUsd(this.state.total_cost_usd, { graph_id: this.graph.id });
        }
        this.emit('workflow:complete', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          duration_ms,
        });
        yield {
          type: 'workflow:complete',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          duration_ms,
          state: this.state,
          timestamp: Date.now(),
        };
      } else if (this.state.status === 'waiting') {
        // Check if approval gate timeout has already expired
        if (this.state.waiting_timeout_at && new Date() >= this.state.waiting_timeout_at) {
          this.dispatchInternal('_timeout');
          await this.persistState();
          yield* this.drainPendingEvents();
          // Fall through to timeout handling below
        }

        if (this.state.status === 'waiting') {
          // No timeout expired — emit waiting event and return
          this.emit('workflow:waiting', {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            waiting_for: this.state.waiting_for || 'human_approval',
          });
          yield {
            type: 'workflow:waiting',
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
            waiting_for: this.state.waiting_for || 'human_approval',
            state: this.state,
            timestamp: Date.now(),
          };
        }
      }

      if (this.state.status === 'timeout') {
        const elapsed = Date.now() - (this.startTime ?? Date.now());
        this.lastRunError = new WorkflowTimeoutError(
          this.state.workflow_id,
          this.state.run_id,
          elapsed,
        );
        this.emit('workflow:timeout', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
        });
        yield {
          type: 'workflow:timeout',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms: elapsed,
          state: this.state,
          timestamp: Date.now(),
        };
      }
    } catch (error) {
      // If aborted via cancel(), don't overwrite the cancelled status
      if (this.abortController.signal.aborted && this.state.status === 'cancelled') {
        return;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      this.lastRunError = err;

      // Execute compensation actions if auto_rollback is enabled and compensation stack is non-empty
      let rollbackSucceeded = false;
      if (this.autoRollback && this.state.compensation_stack.length > 0) {
        try {
          await this.rollback();
          rollbackSucceeded = true;
        } catch (rollbackError) {
          logger.error('auto_rollback_failed', rollbackError as Error, {
            workflow_id: this.state.workflow_id,
            run_id: this.state.run_id,
          });
        }
      }

      // If rollback succeeded, state is already 'cancelled' — skip _fail dispatch
      if (!rollbackSucceeded) {
        this.dispatchInternal('_fail', { last_error: err.message });
        await this.persistState();
        yield* this.drainPendingEvents();

        incrementWorkflowsFailed({ graph_id: this.graph.id });
        recordWorkflowDuration(Date.now() - (this.startTime ?? Date.now()), {
          status: 'failed',
          graph_id: this.graph.id,
        });

        this.emit('workflow:failed', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          error: this.state.last_error,
        });
        yield {
          type: 'workflow:failed',
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          error: err.message,
          state: this.state,
          timestamp: Date.now(),
        };
      }
    } finally {
      this.isStreaming = false;
    }
  }

  /**
   * Stream workflow execution events as an async generator.
   *
   * This is the canonical execution path. Each event is yielded as it
   * occurs, including real-time token deltas from LLM agents. Terminal
   * events carry the full `WorkflowState`.
   *
   * @example
   * ```ts
   * const runner = new GraphRunner(graph, state, opts);
   * for await (const event of runner.stream()) {
   *   if (event.type === 'agent:token_delta') process.stdout.write(event.token);
   *   if (event.type === 'workflow:complete') console.log(event.state.status);
   * }
   * ```
   */
  async *stream(options?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
    if (options?.signal) {
      if (options.signal.aborted) {
        this.cancel();
      } else {
        options.signal.addEventListener('abort', () => this.cancel(), { once: true });
      }
    }
    this.isStreaming = true;
    yield* this.executeLoop();
  }

  /**
   * Execute the graph until completion or max iterations.
   *
   * Consumes `stream()` internally and returns the final state.
   * Preserves original error types for backward compatibility.
   */
  async run(): Promise<WorkflowState> {
    this.lastRunError = undefined;
    try {
      for await (const _event of this.executeLoop()) {
        // Drain all events — run() consumes but discards them
      }
    } finally {
      // Close MCP connections opened during this run
      if (this.toolResolver) {
        await this.toolResolver.closeAll().catch((err) => {
          logger.error('tool_resolver_cleanup_failed', err as Error);
        });
      }

      // Prevent memory leaks: remove all event listeners registered by
      // consumers of this runner. Without this, long-lived worker processes
      // that create thousands of GraphRunner instances would accumulate
      // orphaned listeners.
      this.removeAllListeners();
    }
    if (this.lastRunError) throw this.lastRunError;
    return this.state;
  }

  /**
   * Execute a single node with retry logic.
   *
   * When `isStreaming`, node lifecycle events (start/complete/failed)
   * are emitted by `executeLoop()` instead to avoid double-emission.
   */
  private async executeNode(node: GraphNode): Promise<Action> {
    const nodeStartTime = Date.now();

    if (!this.isStreaming) {
      this.emit('node:start', {
        node_id: node.id,
        type: node.type,
        timestamp: nodeStartTime,
      });
    }

    try {
      // Execute with retry
      const action = await this.executeNodeWithRetry(node);

      const duration_ms = Date.now() - nodeStartTime;

      if (!this.isStreaming) {
        this.emit('node:complete', {
          node_id: node.id,
          type: node.type,
          duration_ms,
        });
      }

      return action;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (!this.isStreaming) {
        this.emit('node:failed', {
          node_id: node.id,
          type: node.type,
          error: errorMessage,
          attempt: node.failure_policy.max_retries,
        });
      }

      throw error;
    }
  }

  /**
   * Execute node with retry and circuit breaker
   */
  private async executeNodeWithRetry(node: GraphNode): Promise<Action> {
    const policy = node.failure_policy;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= policy.max_retries; attempt++) {
      try {
        // Check circuit breaker
        if (policy.circuit_breaker?.enabled) {
          this.circuitBreakers.check(node);
        }

        // Execute node
        const action = await this.executeNodeLogic(node, attempt);

        // Success: update circuit breaker
        if (policy.circuit_breaker?.enabled) {
          this.circuitBreakers.update(node.id, true, this.graph.nodes);
        }

        return action;
      } catch (error) {
        lastError = error as Error;

        // Update circuit breaker
        if (policy.circuit_breaker?.enabled) {
          this.circuitBreakers.update(node.id, false, this.graph.nodes);
        }

        const is_last_attempt = attempt === policy.max_retries;
        if (is_last_attempt) break;

        // Calculate backoff and retry
        const backoff_ms = calculateBackoff(
          attempt,
          policy.backoff_strategy,
          policy.initial_backoff_ms,
          policy.max_backoff_ms
        );

        this.emit('node:retry', { node_id: node.id, attempt, backoff_ms });
        if (this.isStreaming) {
          this.pendingEvents.push({
            type: 'node:retry',
            node_id: node.id,
            attempt,
            backoff_ms,
            timestamp: Date.now(),
          });
        }
        logger.warn('node_retry', { node_id: node.id, attempt, backoff_ms, error: lastError?.message });

        await sleep(backoff_ms);
      }
    }

    throw lastError || new Error(`Node ${node.id} failed after ${policy.max_retries} retries`);
  }

  /**
   * Execute node logic based on type — dispatches to extracted executor functions.
   */
  private async executeNodeLogic(node: GraphNode, attempt: number): Promise<Action> {
    // Create state view (security boundary)
    const stateView = createStateView(this.state, node);
    const ctx = this.buildExecutorContext();

    switch (node.type) {
      case 'agent':
        return await executeAgentNode(node, stateView, attempt, ctx);
      case 'tool':
        return await executeToolNode(node, stateView, attempt, ctx);
      case 'router':
        return await executeRouterNode(node, stateView, attempt, ctx);
      case 'supervisor':
        return await executeSupervisorNode(node, stateView, attempt, ctx);
      case 'approval':
        return await executeApprovalNode(node, stateView, attempt, ctx);
      case 'map':
        return await executeMapNode(node, stateView, attempt, ctx);
      case 'voting':
        return await executeVotingNode(node, stateView, attempt, ctx);
      case 'synthesizer':
        return await executeSynthesizerNode(node, stateView, attempt, ctx);
      case 'subgraph':
        return await executeSubgraphNode(node, stateView, attempt, ctx);
      case 'evolution':
        return await executeEvolutionNode(node, stateView, attempt, ctx);
      default:
        throw new UnsupportedNodeTypeError(node.type);
    }
  }

  /**
   * Apply human response and prepare for resumption.
   * Called by the worker before run() on HITL resume.
   */
  applyHumanResponse(response: HumanResponse): void {
    const pendingApproval = this.state.memory._pending_approval as {
      node_id?: string;
      rejection_node_id?: string;
    } | undefined;

    // Create and apply resume action
    const action: Action = {
      id: uuidv4(),
      idempotency_key: `resume:${this.state.run_id}:${Date.now()}`,
      type: 'resume_from_human',
      payload: {
        decision: response.decision,
        response: response.data,
        memory_updates: response.memory_updates,
      },
      metadata: {
        node_id: pendingApproval?.node_id || 'unknown',
        timestamp: new Date(),
        attempt: 1,
      },
    };

    this.state = rootReducer(this.state, action);

    // Handle rejection routing
    if (response.decision === 'rejected' && pendingApproval?.rejection_node_id) {
      const rejectionNode = this.graph.nodes.find(n => n.id === pendingApproval.rejection_node_id);
      if (rejectionNode) {
        this.dispatchInternal('_advance', { node_id: rejectionNode.id });
      }
    } else if (response.decision !== 'rejected') {
      // Advance to next node from the approval node
      const approvalNode = this.graph.nodes.find(n => n.id === pendingApproval?.node_id);
      if (approvalNode) {
        const nextNode = this.getNextNode(approvalNode);
        if (nextNode) {
          this.dispatchInternal('_advance', { node_id: nextNode.id });
        }
      }
    }
  }

  /**
   * Rollback workflow using compensation stack (saga pattern)
   */
  async rollback(): Promise<void> {
    logger.info('rollback_started', { workflow_id: this.state.workflow_id, compensation_count: this.state.compensation_stack.length });

    // Execute compensation actions in reverse order (LIFO)
    while (this.state.compensation_stack.length > 0) {
      const compensatable = this.state.compensation_stack[this.state.compensation_stack.length - 1];
      this.dispatchInternal('_pop_compensation');

      if (!compensatable) continue;

      try {
        // Validate compensation action before applying
        const parsed = ActionSchema.safeParse(compensatable.compensation_action);
        if (!parsed.success) {
          logger.error('invalid_compensation_action', new Error('Compensation action failed schema validation'), {
            action_id: compensatable.action_id,
            errors: parsed.error.issues,
          });
          continue;
        }

        const compensation = parsed.data;
        logger.info('compensating_action', { action_id: compensatable.action_id });

        // Apply compensation
        this.state = rootReducer(this.state, compensation);

      } catch (error) {
        logger.error('compensation_failed', error, { action_id: compensatable.action_id });
        // Log but continue rolling back
      }
    }

    this.dispatchInternal('_cancel');
    await this.persistState();

    this.emit('workflow:rollback', {
      workflow_id: this.state.workflow_id,
      run_id: this.state.run_id,
    });
  }

  /**
   * Check workflow timeout
   */
  private checkTimeout(): boolean {
    if (!this.state.started_at || !this.startTime) return false;

    const elapsed_ms = Date.now() - this.startTime;

    if (elapsed_ms > this.state.max_execution_time_ms) {
      logger.error('workflow_timeout', undefined, { elapsed_ms, max_ms: this.state.max_execution_time_ms, run_id: this.state.run_id });
      this.dispatchInternal('_timeout');
      // When streaming, timeout events are yielded by executeLoop()
      if (!this.isStreaming) {
        this.emit('workflow:timeout', {
          workflow_id: this.state.workflow_id,
          run_id: this.state.run_id,
          elapsed_ms,
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Determine next node based on edges and conditions
   */
  private getNextNode(currentNode: GraphNode): GraphNode | null {
    const outgoingEdges = this.edgeMap.get(currentNode.id);

    if (!outgoingEdges || outgoingEdges.length === 0) {
      return null; // End of graph
    }

    // Evaluate conditions and take first matching edge
    for (const edge of outgoingEdges) {
      if (evaluateCondition(edge.condition, this.state)) {
        const nextNode = this.nodeMap.get(edge.target);

        if (nextNode) {
          logger.debug('following_edge', { edge_id: edge.id, target: nextNode.id, from: currentNode.id });
          return nextNode;
        }
      }
    }

    // No matching edge found
    logger.warn('no_matching_edge', { node_id: currentNode.id });
    return null;
  }

  /**
   * Get current node from graph
   */
  private getCurrentNode(): GraphNode | null {
    if (!this.state.current_node) return null;
    return this.nodeMap.get(this.state.current_node) ?? null;
  }

  /**
   * Check if execution should continue.
   *
   * End-node check is handled in the main loop **after** execution,
   * not here, so that end nodes actually run their logic.
   */
  private shouldContinue(): boolean {
    return this.state.status === 'running' && !!this.state.current_node;
  }

  /**
   * Persist state to database (resumability)
   */
  private async persistState(): Promise<void> {
    if (this.persistStateFn) {
      try {
        await this.persistStateFn(this.state);

        this.emit('state:persisted', {
          run_id: this.state.run_id,
          iteration: this.state.iteration_count,
        });

        if (this.isStreaming) {
          this.pendingEvents.push({
            type: 'state:persisted',
            run_id: this.state.run_id,
            iteration: this.state.iteration_count,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('state_persist_failed', error, { run_id: this.state.run_id });
        // Don't throw - persistence errors shouldn't stop execution
        // But log for monitoring
      }
    }
  }

  /**
   * Reconstruct idempotency keys from persisted state on resume.
   * Only completed iterations (0 through iteration_count-1) are reconstructed.
   * The current iteration has NOT completed and must be re-executed.
   */
  /**
   * Validate event log integrity on resume.
   *
   * Checks for:
   * - Monotonically increasing sequence IDs with no gaps
   * - First event is `workflow_started`
   * - Event count is consistent with iteration_count
   *
   * Throws {@link EventLogCorruptionError} if corruption is detected.
   * Silently succeeds if no events exist (event log may be noop).
   */
  private async validateEventLogIntegrity(): Promise<void> {
    try {
      const events = await this.eventLog.loadEvents(this.state.run_id);

      // No events is OK — event log may be a NoopEventLogWriter
      if (events.length === 0) return;

      // Check that first event is workflow_started
      if (events[0].event_type !== 'workflow_started') {
        logger.error('event_log_integrity_failed', new Error('Missing workflow_started event'), {
          first_event_type: events[0].event_type,
          run_id: this.state.run_id,
        });
        throw new EventLogCorruptionError(this.state.run_id);
      }

      // Check monotonically increasing sequence IDs with no gaps
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1].sequence_id;
        const curr = events[i].sequence_id;
        if (curr !== prev + 1) {
          logger.error('event_log_integrity_failed', new Error('Sequence gap detected'), {
            expected_sequence: prev + 1,
            actual_sequence: curr,
            run_id: this.state.run_id,
          });
          throw new EventLogCorruptionError(this.state.run_id);
        }
      }
    } catch (error) {
      if (error instanceof EventLogCorruptionError) throw error;
      // loadEvents failed — log but don't block resume
      logger.warn('event_log_integrity_check_skipped', {
        error: error instanceof Error ? error.message : String(error),
        run_id: this.state.run_id,
      });
    }
  }

  /**
   * Reconstruct idempotency keys on resume.
   *
   * Prefers event log data (`action_dispatched` events) when available,
   * as the event log captures the exact `nodeId:iterationCount` keys
   * that were used — correctly handling loops where the same node is
   * visited multiple times.
   *
   * Falls back to the heuristic approach (visited_nodes + iteration_count)
   * with a warning when no event log is available.
   */
  private async reconstructIdempotencyKeys(): Promise<void> {
    // Try event-log-based reconstruction first
    try {
      const events = await this.eventLog.loadEvents(this.state.run_id);
      const actionEvents = events.filter(e => e.event_type === 'action_dispatched');

      if (actionEvents.length > 0) {
        // Each action_dispatched event carries the node_id and was logged
        // at a specific iteration. Reconstruct the same keys the main loop uses.
        for (const event of actionEvents) {
          const nodeId = event.node_id;
          // The action's metadata captures the iteration at dispatch time
          const action = event.action as { metadata?: { node_id?: string } } | undefined;
          const actionNodeId = action?.metadata?.node_id ?? nodeId;
          if (actionNodeId) {
            // Use the event's position in the sequence as the iteration index
            // (events are ordered by sequence_id, matching iteration order)
            const iterIdx = actionEvents.indexOf(event);
            this.executedActions.add(`${actionNodeId}:${iterIdx}`);
          }
        }

        // Also reconstruct the sequence ID for event log continuity
        if (events.length > 0) {
          const maxSeq = events.reduce((max, e) => Math.max(max, e.sequence_id), 0);
          this.sequenceId = maxSeq + 1;
        }

        logger.info('idempotency_reconstructed_from_events', {
          keys: this.executedActions.size,
          events_loaded: actionEvents.length,
        });
        return;
      }
    } catch (error) {
      logger.warn('event_log_reconstruction_failed', {
        error: error instanceof Error ? error.message : String(error),
        hint: 'Falling back to heuristic idempotency reconstruction',
      });
    }

    // Fallback: heuristic reconstruction from visited_nodes
    const completedCount = this.state.iteration_count;
    for (let i = 0; i < completedCount && i < this.state.visited_nodes.length; i++) {
      this.executedActions.add(`${this.state.visited_nodes[i]}:${i}`);
    }
    logger.info('idempotency_reconstructed_heuristic', {
      keys: this.executedActions.size,
      completed_iterations: completedCount,
      warning: 'Heuristic reconstruction may be inaccurate for loop workflows',
    });
  }

  /**
   * Execute node with timeout wrapper.
   * Uses AbortController to ensure the timeout handle is always cleaned up,
   * preventing timer leaks when the node completes before the timeout fires.
   */
  private async executeNodeWithTimeout(node: GraphNode): Promise<Action> {
    const nodeTimeout = node.failure_policy.timeout_ms;

    // Calculate remaining workflow-level timeout
    let workflowTimeoutMs: number | undefined;
    if (this.startTime && this.state.max_execution_time_ms) {
      const elapsed = Date.now() - this.startTime;
      const remaining = this.state.max_execution_time_ms - elapsed;
      if (remaining <= 0) {
        // Already past deadline
        this.abortController.abort();
        throw new WorkflowTimeoutError(this.state.workflow_id, this.state.run_id, elapsed);
      }
      workflowTimeoutMs = remaining;
    }

    // Pick the tighter of node timeout and workflow timeout
    const effectiveTimeout = nodeTimeout && workflowTimeoutMs
      ? Math.min(nodeTimeout, workflowTimeoutMs)
      : nodeTimeout || workflowTimeoutMs;

    if (!effectiveTimeout) {
      return await this.executeNode(node);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const isWorkflowTimeout = workflowTimeoutMs !== undefined &&
      (!nodeTimeout || workflowTimeoutMs <= nodeTimeout);

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          // Fire abort signal so in-flight LLM calls are cancelled
          this.abortController.abort();
          if (isWorkflowTimeout) {
            const elapsed = Date.now() - (this.startTime ?? Date.now());
            reject(new WorkflowTimeoutError(this.state.workflow_id, this.state.run_id, elapsed));
          } else {
            reject(new Error(`Node ${node.id} timeout after ${effectiveTimeout}ms`));
          }
        }, effectiveTimeout);
      });

      return await Promise.race([
        this.executeNode(node),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  // ─── Cost Tracking ─────────────────────────────────────────────────

  /**
   * Calculate cost for a single action using model pricing.
   * Falls back to 0 for unknown models.
   */
  private calculateActionCost(
    inputTokens: number,
    outputTokens: number,
    action: Action,
  ): number {
    const modelHint = action.metadata.model ?? '';
    return calculateCost(modelHint, inputTokens, outputTokens);
  }

  /**
   * Check if cost thresholds have been crossed and fire events.
   * Thresholds: 50%, 75%, 90%, 100% of budget_usd.
   */
  private async checkBudgetThresholds(): Promise<void> {
    const { budget_usd, total_cost_usd, _cost_alert_thresholds_fired } = this.state;
    if (!budget_usd || budget_usd <= 0) return;

    const THRESHOLDS = [0.5, 0.75, 0.9, 1.0];
    const usedPct = total_cost_usd / budget_usd;

    for (const threshold of THRESHOLDS) {
      if (usedPct >= threshold && !_cost_alert_thresholds_fired.includes(threshold)) {
        this.dispatchInternal('_fire_cost_threshold', { threshold });
        this.emit('budget:threshold_reached', {
          run_id: this.state.run_id,
          workflow_id: this.state.workflow_id,
          threshold_pct: Math.round(threshold * 100),
          cost_usd: total_cost_usd,
          budget_usd,
        });

        if (this.isStreaming) {
          this.pendingEvents.push({
            type: 'budget:threshold_reached',
            run_id: this.state.run_id,
            workflow_id: this.state.workflow_id,
            threshold_pct: Math.round(threshold * 100),
            cost_usd: total_cost_usd,
            budget_usd,
            timestamp: Date.now(),
          });
        }

        if (threshold >= 1.0) {
          const errorMsg = `Cost budget exceeded: $${total_cost_usd.toFixed(4)} used, budget was $${budget_usd.toFixed(4)}`;
          this.dispatchInternal('_budget_exceeded', { last_error: errorMsg });
          throw new BudgetExceededError(total_cost_usd, budget_usd);
        }
      }
    }
  }

  // ─── Durable Execution: Recovery ───────────────────────────────────

  /**
   * Recover a workflow run from its event log (deterministic replay).
   *
   * Loads all events for the given `run_id`, replays them through the same
   * pure reducers used during normal execution, and returns a GraphRunner
   * whose state is identical to the pre-crash state. The caller can then
   * invoke `.run()` to continue execution.
   *
   * During replay, **no LLM calls are made**. The stored `Action` objects
   * (which contain all agent outputs) are fed directly into the reducers.
   *
   * @param graph     The graph definition to execute against
   * @param runId     The workflow run_id to recover
   * @param eventLog  The event log writer to load events from
   * @param options   Optional persistence/graph loading functions
   * @returns         A GraphRunner ready to continue execution via `.run()`
   *
   * @throws Error if no events exist for the given run_id
   *
   * @example
   * ```ts
   * const runner = await GraphRunner.recover(graph, runId, eventLog, {
   *   persistStateFn: persistWorkflow,
   * });
   * const finalState = await runner.run(); // continues from where it left off
   * ```
   */
  static async recover(
    graph: Graph,
    runId: string,
    eventLog: EventLogWriter,
    options?: Omit<GraphRunnerOptions, 'eventLog'>,
  ): Promise<GraphRunner> {
    // 1. Check for a checkpoint first (fast path for compacted logs)
    const checkpoint = await eventLog.loadCheckpoint(runId);

    let events: WorkflowEvent[];
    let startState: WorkflowState;

    if (checkpoint) {
      // Load only events AFTER the checkpoint — dramatically less replay work
      events = await eventLog.loadEventsAfter(runId, checkpoint.sequence_id);
      startState = checkpoint.state;

      logger.info('recovery_from_checkpoint', {
        run_id: runId,
        checkpoint_sequence_id: checkpoint.sequence_id,
        events_after_checkpoint: events.length,
      });
    } else {
      // No checkpoint — full replay from the beginning
      events = await eventLog.loadEvents(runId);
      if (events.length === 0) {
        throw new EventLogCorruptionError(runId);
      }

      // Find the _init event to verify the log is intact
      const initEvent = events.find(
        e => e.event_type === 'internal_dispatched' && e.internal_type === '_init'
      );
      if (!initEvent) {
        throw new EventLogCorruptionError(runId);
      }

      // Create minimal pending state that reducers will transform
      startState = {
        workflow_id: graph.id,
        run_id: runId,
        status: 'pending',
        goal: '',
        constraints: [],
        memory: {},
        iteration_count: 0,
        retry_count: 0,
        max_retries: 3,
        total_tokens_used: 0,
        total_cost_usd: 0,
        _cost_alert_thresholds_fired: [],
        visited_nodes: [],
        max_iterations: 50,
        max_execution_time_ms: 3600000,
        compensation_stack: [],
        supervisor_history: [],
        created_at: events[0].created_at,
        updated_at: events[0].created_at,
      };

      logger.info('recovery_started', {
        run_id: runId,
        event_count: events.length,
        last_sequence_id: events[events.length - 1].sequence_id,
      });
    }

    // 2. Create runner with the start state (checkpoint or fresh)
    const runner = new GraphRunner(graph, startState, {
      ...options,
      eventLog,
    });

    // 3. Replay events through reducers — deterministic state reconstruction
    let replayedActions = 0;
    let replayedInternals = 0;

    for (const event of events) {
      if (event.event_type === 'action_dispatched' && event.action) {
        runner.state = rootReducer(runner.state, event.action);

        const nodeId = event.node_id ?? event.action.metadata.node_id;
        const idempotencyKey = `${nodeId}:${runner.state.iteration_count}`;
        runner.executedActions.add(idempotencyKey);

        replayedActions++;
      } else if (event.event_type === 'internal_dispatched' && event.internal_type) {
        const internalAction: Action = {
          id: uuidv4(),
          idempotency_key: `_replay:${event.internal_type}:${event.sequence_id}`,
          type: event.internal_type as Action['type'],
          payload: (event.internal_payload ?? {}) as Record<string, unknown>,
          metadata: { node_id: '_runner', timestamp: event.created_at, attempt: 1 },
        };
        runner.state = internalReducer(runner.state, internalAction);

        replayedInternals++;
      }
    }

    // 4. Set sequenceId to continue after the last event
    const lastSeq = events.length > 0
      ? events[events.length - 1].sequence_id
      : checkpoint?.sequence_id ?? -1;
    runner.sequenceId = lastSeq + 1;

    logger.info('recovery_complete', {
      run_id: runId,
      from_checkpoint: !!checkpoint,
      replayed_actions: replayedActions,
      replayed_internals: replayedInternals,
      recovered_status: runner.state.status,
      recovered_node: runner.state.current_node,
      recovered_iteration: runner.state.iteration_count,
    });

    return runner;
  }

  /**
   * Compact the event log for the current run.
   *
   * Creates a checkpoint at the current sequence_id, then deletes all events
   * at or before that point. This reduces storage and speeds up future recovery.
   *
   * Should be called after a workflow completes, or periodically during
   * long-running workflows (e.g., every N iterations).
   *
   * @returns The number of events deleted
   *
   * @example
   * ```ts
   * const result = await runner.run();
   * const deleted = await runner.compactEvents();
   * logger.info('compacted', { deleted });
   * ```
   */
  async compactEvents(): Promise<number> {
    const currentSeq = this.sequenceId - 1; // last appended sequence_id
    if (currentSeq < 0) return 0;

    // Save checkpoint with current state
    await this.eventLog.checkpoint(this.state.run_id, currentSeq, this.state);

    // Delete events at or before the checkpoint
    const deleted = await this.eventLog.compact(this.state.run_id, currentSeq);

    logger.info('events_compacted', {
      run_id: this.state.run_id,
      checkpoint_sequence_id: currentSeq,
      events_deleted: deleted,
    });

    return deleted;
  }

  /** Expose readonly access to the event log writer (for testing/diagnostics) */
  getEventLog(): EventLogWriter {
    return this.eventLog;
  }
}

/**
 * Human response payload for HITL (Human-in-the-Loop) resume.
 */
export interface HumanResponse {
  /** The reviewer's decision. */
  decision: 'approved' | 'rejected' | 'edited';
  /** Optional freeform response data. */
  data?: unknown;
  /** Optional memory updates to apply on resume. */
  memory_updates?: Record<string, unknown>;
}
