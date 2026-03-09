/**
 * Persistence Interfaces
 *
 * Defines the contracts for all storage backends used by the orchestrator.
 * The orchestrator depends only on these interfaces — concrete implementations
 * (Drizzle/Postgres, in-memory, etc.) are injected at startup.
 *
 * Design principle: "Batteries included, but swappable."
 *
 * @module persistence/interfaces
 */

import type { Graph } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';

// ─── JSON-safe types (DB-agnostic) ──────────────────────────────────────

/**
 * JSON-safe shape for graph definitions.
 *
 * Kept deliberately loose (index signature) to avoid coupling to any ORM.
 */
export interface GraphDefinitionJson {
  /** Unique graph identifier. */
  id: string;
  /** Human-readable graph name. */
  name: string;
  /** Serialized node definitions. */
  nodes: unknown[];
  /** Serialized edge definitions. */
  edges: unknown[];
  /** ID of the first node to execute. */
  start_node: string;
  /** Terminal node IDs (empty for supervisor-driven graphs). */
  end_nodes: string[];
  /** Additional properties for forward-compatibility. */
  [key: string]: unknown;
}

/**
 * JSON-safe shape for workflow state snapshots.
 *
 * Stored as a versioned record for crash recovery and state history.
 */
export interface WorkflowStateJson {
  /** Graph that this run belongs to. */
  workflow_id: string;
  /** Unique run identifier. */
  run_id: string;
  /** Current workflow status. */
  status: string;
  /** Node currently being executed (`undefined` before first step). */
  current_node?: string;
  /** Key-value memory shared between nodes. */
  memory: Record<string, unknown>;
  /** Additional properties for forward-compatibility. */
  [key: string]: unknown;
}

/**
 * Row shape returned by workflow run queries.
 */
export interface WorkflowRunRow {
  /** Unique run identifier. */
  id: string;
  /** Logical workflow ID (nullable for ad-hoc runs). */
  workflow_id: string | null;
  /** Graph that this run executes. */
  graph_id: string;
  /** Current run status (e.g. `"running"`, `"completed"`, `"failed"`). */
  status: string;
  /** When the run was created. */
  created_at: Date;
  /** Parent run ID for sub-workflow runs. */
  parent_run_id: string | null;
  /** When the run reached a terminal status (`null` if still running). */
  completed_at: Date | null;
  /** When the run was archived by the retention service (`null` if hot). */
  archived_at: Date | null;
}

/**
 * Row shape returned by workflow event queries.
 */
export interface WorkflowEventRow {
  /** Unique event identifier. */
  id: string;
  /** Run this event belongs to. */
  run_id: string;
  /** Monotonically increasing sequence within the run. */
  sequence_id: number;
  /** Event category (e.g. `"node_started"`, `"node_completed"`). */
  event_type: string;
  /** Node that produced this event (`null` for run-level events). */
  node_id: string | null;
  /** Serialized action payload. */
  action: unknown;
  /** Internal event type for the graph runner (e.g. `"dispatch"`). */
  internal_type: string | null;
  /** Internal payload for the graph runner. */
  internal_payload: unknown;
  /** When the event was recorded. */
  created_at: Date;
}

/**
 * Row shape for graph records.
 */
export interface GraphRow {
  /** Unique graph identifier. */
  id: string;
  /** Human-readable graph name. */
  name: string;
  /** Optional description. */
  description: string | null;
  /** Full graph definition as JSON. */
  definition: GraphDefinitionJson;
  /** Semantic version string. */
  version: string | null;
  /** When the graph was first created. */
  created_at: Date;
  /** When the graph was last modified. */
  updated_at: Date;
}

// ─── PersistenceProvider ────────────────────────────────────────────────

/**
 * Primary persistence interface for workflow state management.
 *
 * Covers graphs, workflow runs, and workflow state snapshots.
 * All methods are async to support both in-memory and database backends.
 */
export interface PersistenceProvider {
  // ── Graph Operations ──

  /** Save or upsert a graph definition. */
  saveGraph(graph: Graph): Promise<void>;

  /** Load a graph by ID. Returns `null` if not found. */
  loadGraph(graph_id: string): Promise<Graph | null>;

  /** List graphs ordered by `updated_at` descending. */
  listGraphs(opts?: { limit?: number; offset?: number }): Promise<GraphRow[]>;

  // ── Workflow Run Operations ──

  /** Save or upsert a workflow run record from the current state. */
  saveWorkflowRun(state: WorkflowState): Promise<void>;

  /** Load a workflow run by ID. Returns `null` if not found. */
  loadWorkflowRun(run_id: string): Promise<WorkflowRunRow | null>;

  /** List workflow runs ordered by `created_at` descending. */
  listWorkflowRuns(opts?: { limit?: number; offset?: number }): Promise<WorkflowRunRow[]>;

  /** Update only the status of a run. Returns rows affected (`0` or `1`). */
  updateRunStatus(runId: string, status: string): Promise<number>;

  // ── Workflow State Operations ──

  /** Save a state snapshot with auto-incremented version. */
  saveWorkflowState(state: WorkflowState): Promise<void>;

  /** Load the latest state snapshot for crash recovery. */
  loadLatestWorkflowState(run_id: string): Promise<WorkflowState | null>;

  /** Load state version history (lightweight summary per version). */
  loadWorkflowStateHistory(
    run_id: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{
    version: number;
    status: string;
    current_node: string | null;
    created_at: Date;
    total_tokens_used: number | null;
  }[]>;

  /** Load full state JSON at a specific version. */
  loadWorkflowStateAtVersion(run_id: string, version: number): Promise<WorkflowStateJson | null>;

  // ── Event Queries ──

  /** Load raw event rows for a run (for API endpoints). */
  loadEvents(run_id: string): Promise<WorkflowEventRow[]>;
}

// ─── AgentRegistry ──────────────────────────────────────────────────────

/**
 * Entry returned by the agent registry.
 *
 * Represents a single agent's full configuration as stored in the database.
 */
export interface AgentRegistryEntry {
  /** Unique agent identifier. */
  id: string;
  /** Human-readable agent name. */
  name: string;
  /** Optional description of the agent's purpose. */
  description: string | null;
  /** LLM model identifier (e.g. `"claude-sonnet-4-20250514"`). */
  model: string;
  /** LLM provider (`"openai"` | `"anthropic"` | `null` for auto-detect). */
  provider: string | null;
  /** System prompt that defines the agent's behaviour. */
  system_prompt: string;
  /** Sampling temperature (0–1). */
  temperature: number;
  /** Maximum tool-call steps. */
  max_steps: number;
  /** Tool IDs this agent may invoke. */
  tools: string[];
  /** Zero-trust permissions (deny-all when `null`). */
  permissions: {
    /** Whether the agent runs in a sandboxed environment. */
    sandbox?: boolean;
    /** Memory keys the agent may read. */
    read_keys: string[];
    /** Memory keys the agent may write. */
    write_keys: string[];
    /** Per-run cost budget in USD. */
    budget_usd?: number;
  } | null;
}

/**
 * Registry for loading agent configurations.
 *
 * Decouples the agent factory from any specific database or config store.
 */
export interface AgentRegistry {
  /** Load an agent by ID. Returns `null` if not found. */
  loadAgent(id: string): Promise<AgentRegistryEntry | null>;
}

// ─── UsageRecorder ──────────────────────────────────────────────────────

/**
 * Record shape for per-run cost and token usage tracking.
 */
export interface UsageRecord {
  /** Run that incurred the usage. */
  run_id: string;
  /** API key used for the request (if applicable). */
  api_key_id?: string;
  /** Graph that was executed. */
  graph_id: string;
  /** Number of prompt tokens consumed. */
  input_tokens: number;
  /** Number of completion tokens consumed. */
  output_tokens: number;
  /** Estimated cost in USD. */
  cost_usd: number;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
}

/**
 * Records per-run cost and token usage for billing and observability.
 */
export interface UsageRecorder {
  /** Persist a usage record. */
  saveUsageRecord(record: UsageRecord): Promise<void>;
}

// ─── RetentionService ───────────────────────────────────────────────────

/**
 * Manages workflow data lifecycle across Hot → Warm → Cold tiers.
 *
 * Hot: active or recently completed runs.
 * Warm: archived runs kept for debugging/auditing.
 * Cold: deleted or moved to long-term storage.
 */
export interface RetentionService {
  /** Archive completed workflows older than the configured cutoff. */
  archiveCompletedWorkflows(): Promise<number>;

  /** Delete warm data older than the retention period. */
  deleteWarmData(): Promise<number>;

  /** Get per-tier run counts. */
  getStorageStats(): Promise<{
    hot_runs: number;
    warm_runs: number;
    cold_runs: number;
  }>;
}
