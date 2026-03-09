/**
 * Node Executor Context
 *
 * Shared types for all node executor functions. Defines the dependency
 * injection interface ({@link ExecutorDependencies}) and the context
 * bag ({@link NodeExecutorContext}) passed to every executor.
 *
 * This module decouples node executors from the `GraphRunner` import
 * tree, enabling clean unit testing via mock dependencies.
 *
 * @module runner/node-executors/context
 */

import type { GraphNode } from '../../types/graph.js';
import type { Graph } from '../../types/graph.js';
import type { WorkflowState, Action, StateView } from '../../types/state.js';

/**
 * Raw tool definition — mirrors the shape from tool-adapter.
 */
export interface RawToolDefinition {
  /** Human-readable tool description. */
  description: string;
  /** JSON Schema or Zod schema for the tool's input parameters. */
  parameters: unknown;
}

/**
 * Tainted tool result shape from tool-adapter.
 */
export interface TaintedToolResultShape {
  /** The actual tool return value. */
  result: unknown;
  /** Taint metadata to merge into the taint registry. */
  taint: Record<string, unknown>;
}

/**
 * Agent config shape (subset needed by executors).
 */
export interface AgentConfigShape {
  /** Tool names available to the agent. */
  tools: string[];
  [key: string]: unknown;
}

/**
 * Injected dependencies for node executors.
 *
 * All external runtime functions are provided here so that tests
 * can mock them at the GraphRunner level without node executors
 * needing their own imports.
 */
export interface ExecutorDependencies {
  /** Execute an agent LLM call and return the resulting action. */
  executeAgent: (
    agent_id: string,
    stateView: StateView,
    tools: Record<string, RawToolDefinition>,
    attempt: number,
    options?: {
      temperature_override?: number;
      node_id?: string;
      abortSignal?: AbortSignal;
      onToken?: (token: string) => void;
      executeToolCall?: (toolName: string, args: Record<string, unknown>, agentId?: string) => Promise<unknown>;
    },
  ) => Promise<Action>;

  /** Execute a supervisor routing decision. */
  executeSupervisor: (
    node: GraphNode,
    stateView: StateView,
    supervisorHistory: Array<{
      supervisor_id: string;
      delegated_to: string;
      reasoning: string;
      iteration: number;
      timestamp: Date;
    }>,
    attempt: number,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<Action>;

  /** Evaluate output quality via an LLM-as-judge. */
  evaluateQualityExecutor: (
    evaluatorAgentId: string,
    goal: string,
    data: unknown,
    instruction?: string,
  ) => Promise<{ score: number; reasoning: string; tokens_used: number }>;

  /** Load tool definitions by name. */
  loadAgentTools: (toolNames: string[]) => Promise<Record<string, RawToolDefinition>>;

  /** Execute a single tool call. */
  executeToolCall: (
    toolId: string,
    args: Record<string, unknown>,
    agentId?: string,
  ) => Promise<unknown>;

  /** Load an agent's configuration. */
  loadAgent: (agentId: string) => Promise<AgentConfigShape>;

  /** Get the taint registry from workflow memory. */
  getTaintRegistry: (memory: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Context bag passed to every node executor function.
 *
 * Provides read access to runner state and injected dependencies,
 * without coupling executors to GraphRunner's import tree.
 */
export interface NodeExecutorContext {
  /** Current workflow state (read-only snapshot for idempotency keys, etc.). */
  state: WorkflowState;
  /** The graph being executed. */
  graph: Graph;
  /** Load a graph by ID (needed by the subgraph executor). */
  loadGraphFn?: (graphId: string) => Promise<Graph | null>;
  /** Create a filtered state view for a node. */
  createStateView: (node: GraphNode) => StateView;
  /** Injected runtime dependencies. */
  deps: ExecutorDependencies;
  /** Abort signal for workflow cancellation — propagated to LLM calls. */
  abortSignal?: AbortSignal;
  /** Token streaming callback — fires for each text delta with the originating node ID. */
  onToken?: (token: string, nodeId: string) => void;
}
