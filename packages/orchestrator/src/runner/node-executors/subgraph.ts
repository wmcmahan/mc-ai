/**
 * Subgraph Node Executor
 *
 * Executes a nested workflow (subgraph) as a single node. Memory is
 * mapped between parent and child scopes via `input_mapping` and
 * `output_mapping`. Includes cycle detection to prevent infinite
 * subgraph recursion.
 *
 * @module runner/node-executors/subgraph
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, WorkflowState, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.subgraph');

/**
 * Execute a subgraph node (nested workflow composition).
 *
 * Builds an isolated child state, runs a new {@link GraphRunner}
 * instance, and maps the child's output memory back to the parent.
 *
 * @param node - Subgraph node with `subgraph_config`.
 * @param stateView - Filtered state view from the parent workflow.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context (must include `loadGraphFn`).
 * @returns `update_memory` action with mapped child outputs.
 * @throws If `subgraph_config` is missing, `loadGraphFn` is not provided,
 *         the subgraph is not found, or a subgraph cycle is detected.
 */
export async function executeSubgraphNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.subgraph_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'subgraph', 'subgraph_config');
  }

  if (!ctx.loadGraphFn) {
    throw new NodeConfigError(node.id, 'subgraph', 'loadGraphFn');
  }

  logger.info('subgraph_executing', { node_id: node.id, subgraph_id: config.subgraph_id });

  // Cycle detection: prevent A → B → A recursion.
  const subgraphStack = (ctx.state.memory._subgraph_stack as string[]) ?? [];
  if (subgraphStack.includes(config.subgraph_id)) {
    throw new NodeConfigError(node.id, 'subgraph', `non-cyclic graph (cycle: ${[...subgraphStack, config.subgraph_id].join(' -> ')})`);
  }

  const childGraph = await ctx.loadGraphFn(config.subgraph_id);
  if (!childGraph) {
    throw new NodeConfigError(node.id, 'subgraph', `graph "${config.subgraph_id}"`);
  }

  // Build isolated child memory with mapped inputs
  const childMemory: Record<string, unknown> = {
    _subgraph_stack: [...subgraphStack, ctx.graph.id],
  };
  for (const [parentKey, childKey] of Object.entries(config.input_mapping)) {
    if (parentKey in stateView.memory) {
      childMemory[childKey] = stateView.memory[parentKey];
    }
  }

  const remainingBudget = ctx.state.max_token_budget
    ? ctx.state.max_token_budget - ctx.state.total_tokens_used
    : undefined;

  const childState: WorkflowState = {
    workflow_id: config.subgraph_id,
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: stateView.goal,
    constraints: stateView.constraints,
    status: 'pending',
    current_node: undefined,
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    last_error: undefined,
    waiting_for: undefined,
    waiting_since: undefined,
    waiting_timeout_at: undefined,
    started_at: undefined,
    max_execution_time_ms: 3_600_000,
    memory: childMemory,
    total_tokens_used: 0,
    total_cost_usd: 0,
    max_token_budget: remainingBudget,
    visited_nodes: [],
    max_iterations: config.max_iterations,
    compensation_stack: [],
    supervisor_history: [],
    _cost_alert_thresholds_fired: [],
  };

  // Lazy import to avoid circular dependency (GraphRunner → subgraph → GraphRunner)
  const { GraphRunner } = await import('../graph-runner.js');

  const childRunner = new GraphRunner(childGraph, childState, {
    loadGraphFn: ctx.loadGraphFn,
    onToken: ctx.onToken,
  });
  const finalChildState = await childRunner.run();

  // Map child outputs back to parent memory
  const outputUpdates: Record<string, unknown> = {};
  for (const [childKey, parentKey] of Object.entries(config.output_mapping)) {
    if (childKey in finalChildState.memory) {
      outputUpdates[parentKey] = finalChildState.memory[childKey];
    }
  }

  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'update_memory',
    payload: { updates: outputUpdates },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      token_usage: { totalTokens: finalChildState.total_tokens_used },
    },
  };
}
