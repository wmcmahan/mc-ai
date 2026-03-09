/**
 * Agent Node Executor
 *
 * Executes an agent node by delegating to the appropriate specialised
 * executor (annealing, swarm) or falling through to a standard LLM call.
 *
 * @module runner/node-executors/agent
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { executeAnnealingLoop } from './annealing.js';
import { executeSwarmAgentNode } from './swarm.js';

const logger = createLogger('runner.node.agent');

/**
 * Execute an agent node.
 *
 * Routing priority:
 * 1. If `annealing_config` is set → self-annealing loop
 * 2. If `swarm_config` is set    → swarm peer delegation
 * 3. Otherwise                   → standard single-shot LLM call
 *
 * @param node - Graph node to execute (must have `agent_id`).
 * @param stateView - Filtered state view for the agent.
 * @param attempt - Retry attempt number (1-based).
 * @param ctx - Executor context with injected dependencies.
 * @returns Action produced by the agent.
 * @throws If `agent_id` is missing.
 */
export async function executeAgentNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const agent_id = node.agent_id;
  if (!agent_id) {
    throw new NodeConfigError(node.id, 'agent', 'agent_id');
  }

  if (node.annealing_config) {
    return executeAnnealingLoop(node, stateView, attempt, ctx);
  }

  if (node.swarm_config) {
    return executeSwarmAgentNode(node, stateView, attempt, ctx);
  }

  logger.info('agent_node_executing', { agent_id, node_id: node.id });

  const agentConfig = await ctx.deps.loadAgent(agent_id);
  const tools = await ctx.deps.loadAgentTools(agentConfig.tools);
  const onToken = ctx.onToken ? (t: string) => ctx.onToken!(t, node.id) : undefined;

  return ctx.deps.executeAgent(agent_id, stateView, tools, attempt, {
    node_id: node.id,
    abortSignal: ctx.abortSignal,
    onToken,
    executeToolCall: ctx.deps.executeToolCall,
  });
}
