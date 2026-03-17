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
import type { ToolSource } from '../../types/tools.js';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';
import { executeAnnealingLoop } from './annealing.js';
import { executeSwarmAgentNode } from './swarm.js';

const SAVE_TO_MEMORY_SOURCE: ToolSource = { type: 'builtin', name: 'save_to_memory' };

const logger = createLogger('runner.node.agent');

/**
 * Ensure `save_to_memory` is present in tool sources when the agent has write_keys.
 *
 * `save_to_memory` is the only mechanism for agents to write to the state
 * blackboard. It's already gated by `write_keys` permissions, so requiring
 * explicit declaration adds no security value — just boilerplate that's easy
 * to forget.
 */
export function ensureSaveToMemory(sources: ToolSource[], writeKeys?: string[]): ToolSource[] {
  if (!writeKeys || writeKeys.length === 0) return sources;
  const already = sources.some((s) => s.type === 'builtin' && s.name === 'save_to_memory');
  return already ? sources : [...sources, SAVE_TO_MEMORY_SOURCE];
}

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
  const onToken = ctx.onToken ? (t: string) => ctx.onToken!(t, node.id) : undefined;

  // Node-level tools override agent config tools
  const toolSources = ensureSaveToMemory(node.tools ?? agentConfig.tools, agentConfig.write_keys);
  const tools = await ctx.deps.resolveTools(toolSources, agent_id);
  return ctx.deps.executeAgent(agent_id, stateView, tools, attempt, {
    node_id: node.id,
    abortSignal: ctx.abortSignal,
    onToken,
  });
}
