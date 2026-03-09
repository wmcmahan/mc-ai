/**
 * Workflow State Types
 *
 * Core state machine types for workflow execution. Defines the complete
 * workflow status lifecycle, working memory, token/cost tracking,
 * compensation (saga) pattern, and the Action schema used by reducers.
 *
 * @module types/state
 */

import { z } from 'zod';

// ─── Status & Waiting ───────────────────────────────────────────────

/**
 * Complete workflow status state machine.
 *
 * Follows industry standards from Temporal, Airflow, etc.
 *
 * ```
 * pending → scheduled → running → completed
 *                     ↓        ↗ ↓
 *                   waiting   retrying → failed
 *                                      ↓
 *                                   cancelled / timeout
 * ```
 */
export const WorkflowStatusSchema = z.enum([
  // Initial states
  'pending',        // Created but not started
  'scheduled',      // Waiting for scheduled start time

  // Active states
  'running',        // Currently executing
  'waiting',        // Paused for human-in-the-loop or external event
  'retrying',       // Failed step, attempting retry

  // Terminal states (cannot transition out)
  'completed',      // Successfully finished
  'failed',         // Unrecoverable error
  'cancelled',      // User/system cancelled
  'timeout',        // Exceeded max execution time
]);

export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

/**
 * Reasons a workflow may be in the `waiting` status.
 */
export const WaitingReasonSchema = z.enum([
  'human_approval',  // Human-in-the-loop review
  'external_event',  // Waiting for webhook/callback
  'scheduled_time',  // Cron/scheduled execution
  'rate_limit',      // API rate limiting
  'resource_limit',  // System resource constraints
]);

export type WaitingReason = z.infer<typeof WaitingReasonSchema>;

// ─── Workflow State ─────────────────────────────────────────────────

/**
 * Complete workflow state.
 *
 * This is the single source of truth for a running workflow. It is
 * persisted after every reducer dispatch and used for crash recovery.
 */
export const WorkflowStateSchema = z.object({
  // ── Core metadata ──
  /** Graph definition ID. */
  workflow_id: z.string().uuid(),
  /** Unique run identifier. */
  run_id: z.string().uuid(),
  /** When this run was created. */
  created_at: z.date(),
  /** Last state mutation timestamp. */
  updated_at: z.date(),

  // ── User input ──
  /** High-level objective for this workflow run. */
  goal: z.string(),
  /** Optional constraints the workflow must respect. */
  constraints: z.array(z.string()).default([]),

  // ── Control flow ──
  /** Current lifecycle status. */
  status: WorkflowStatusSchema,
  /** Node currently being executed. */
  current_node: z.string().optional(),
  /** Number of reducer dispatches (loop guard). */
  iteration_count: z.number().default(0),

  // ── Retry management ──
  /** Number of retries on the current node. */
  retry_count: z.number().default(0),
  /** Maximum retries before the node fails. */
  max_retries: z.number().default(3),
  /** Error message from the most recent failure. */
  last_error: z.string().optional(),

  // ── Waiting state ──
  /** Why the workflow is paused (set when status is `waiting`). */
  waiting_for: WaitingReasonSchema.optional(),
  /** When the workflow entered the `waiting` state. */
  waiting_since: z.date().optional(),
  /** Deadline after which the wait times out. */
  waiting_timeout_at: z.date().optional(),

  // ── Execution timeouts ──
  /** When `run()` was first invoked. */
  started_at: z.date().optional(),
  /** Wall-clock timeout for the entire run (default: 1 hour). */
  max_execution_time_ms: z.number().default(3_600_000),

  // ── Working memory ──
  /** Dynamic key-value store shared between nodes. */
  memory: z.record(z.unknown()).default({}),

  // ── Token budget ──
  /** Cumulative tokens consumed across all LLM calls. */
  total_tokens_used: z.number().default(0),
  /** If set, workflow fails when token usage exceeds this limit. */
  max_token_budget: z.number().optional(),

  // ── Cost tracking (USD) ──
  /** Cumulative estimated cost in USD. */
  total_cost_usd: z.number().default(0),
  /** Per-run cost budget (fail when exceeded). */
  budget_usd: z.number().optional(),
  /** Threshold percentages already fired (prevents duplicate alerts). */
  _cost_alert_thresholds_fired: z.array(z.number()).default([]),

  // ── Execution tracking ──
  /** Node IDs visited in execution order. */
  visited_nodes: z.array(z.string()).default([]),
  /** Maximum iterations before the run is forcefully terminated. */
  max_iterations: z.number().default(50),

  // ── Compensation (saga pattern) ──
  /** Stack of compensating actions for rollback on failure. */
  compensation_stack: z.array(z.object({
    action_id: z.string(),
    compensation_action: z.unknown(),
  })).default([]),

  // ── Supervisor history ──
  /** Routing decisions made by supervisor nodes (for debugging). */
  supervisor_history: z.array(z.object({
    supervisor_id: z.string(),
    delegated_to: z.string(),
    reasoning: z.string(),
    iteration: z.number(),
    timestamp: z.date(),
  })).default([]),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

// ─── State View ─────────────────────────────────────────────────────

/**
 * Read-only view of workflow state exposed to agents.
 *
 * Acts as a security boundary — the `memory` field only contains keys
 * from the agent's `read_keys` permission list.
 */
export interface StateView {
  /** Graph definition ID. */
  workflow_id: string;
  /** Unique run identifier. */
  run_id: string;
  /** High-level objective. */
  goal: string;
  /** Constraints the workflow must respect. */
  constraints: string[];
  /** Filtered memory (only keys in the agent's `read_keys`). */
  memory: Record<string, unknown>;
}

// ─── Action Schema ──────────────────────────────────────────────────

/**
 * Action returned by agents and nodes.
 *
 * Dispatched through reducers to produce new workflow state. Includes
 * idempotency keys (for replay safety) and optional compensation
 * actions (for the saga rollback pattern).
 */
export const ActionSchema = z.object({
  // ── Identification ──
  /** Unique action identifier. */
  id: z.string().uuid(),
  /** Action type (e.g. `"update_memory"`, `"set_status"`, `"goto_node"`). */
  type: z.string(),
  /** Action payload — shape depends on `type`. */
  payload: z.record(z.unknown()),

  // ── Idempotency ──
  /** Deduplication key — prevents re-execution on retry/resume. */
  idempotency_key: z.string(),

  // ── Saga pattern ──
  /** Compensating action for rollback on downstream failure. */
  compensation: z.object({
    type: z.string(),
    payload: z.record(z.unknown()),
  }).optional(),

  // ── Metadata ──
  /** Execution metadata for observability and debugging. */
  metadata: z.object({
    /** Node that produced this action. */
    node_id: z.string(),
    /** Agent that produced this action (if agent node). */
    agent_id: z.string().optional(),
    /** When the action was created. */
    timestamp: z.date(),
    /** Retry attempt number (1-based). */
    attempt: z.number().default(1),
    /** Node execution duration in milliseconds. */
    duration_ms: z.number().optional(),
    /** LLM model used for this action (for cost calculation). */
    model: z.string().optional(),
    /** LLM token usage breakdown. */
    token_usage: z.object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number(),
    }).optional(),
    /** Tool calls made during execution. */
    tool_executions: z.array(z.object({
      tool: z.string(),
      args: z.unknown(),
      result: z.unknown(),
    })).optional(),
  }),
});

export type Action = z.infer<typeof ActionSchema>;

// ─── Taint Tracking ─────────────────────────────────────────────────

/**
 * Provenance metadata for a single memory key.
 *
 * Tracked in `memory._taint_registry` to record where each piece of
 * data originated (MCP tool, agent response, derived computation, etc.).
 */
export interface TaintMetadata {
  /** Origin of the data. */
  source: 'mcp_tool' | 'tool_node' | 'agent_response' | 'derived';
  /** Tool that produced the data (if `source` is tool-related). */
  tool_name?: string;
  /** Agent that produced the data (if `source` is `"agent_response"`). */
  agent_id?: string;
  /** ISO 8601 timestamp (string for JSON serialization). */
  created_at: string;
}

/** Taint registry stored at `memory._taint_registry`. */
export type TaintRegistry = Record<string, TaintMetadata>;
