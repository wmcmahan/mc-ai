/**
 * Swarm Agent Node Executor
 *
 * Executes an agent with peer delegation capability. The agent
 * can request handoff to a peer node by writing `_peer_delegation`
 * to its output, which is converted into a `handoff` action.
 *
 * @module runner/node-executors/swarm
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.swarm');

/**
 * Execute a swarm agent node.
 *
 * After the agent executes, checks for a `_peer_delegation` key in
 * the output. If present and valid, converts it to a `handoff` action.
 * If the handoff limit is reached, strips the delegation and returns
 * the agent's original action.
 *
 * @param node - Agent node with `swarm_config`.
 * @param stateView - Filtered state view.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns Agent action or handoff action.
 * @throws If the agent attempts handoff to a non-peer node.
 */
export async function executeSwarmAgentNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.swarm_config!;
  const agent_id = node.agent_id!;

  logger.info('swarm_agent_executing', {
    node_id: node.id,
    agent_id,
    peer_nodes: config.peer_nodes,
  });

  const handoffCount = (stateView.memory._swarm_handoff_count as number) || 0;

  const swarmView: StateView = {
    ...stateView,
    memory: {
      ...stateView.memory,
      _swarm_config: {
        peer_nodes: config.peer_nodes,
        max_handoffs: config.max_handoffs,
        handoff_count: handoffCount,
      },
    },
  };

  const agentConfig = await ctx.deps.loadAgent(agent_id);
  const tools = await ctx.deps.resolveTools(agentConfig.tools, agent_id) as Record<string, import('./context.js').RawToolDefinition>;
  const onToken = ctx.onToken ? (t: string) => ctx.onToken!(t, node.id) : undefined;
  const action = await ctx.deps.executeAgent(agent_id, swarmView, tools, attempt, {
    node_id: node.id,
    abortSignal: ctx.abortSignal,
    onToken,
    executeToolCall: ctx.deps.executeToolCall,
  });

  const updates = action.payload.updates as Record<string, unknown>;
  const delegation = updates._peer_delegation as
    | { peer_node_id: string; reason: string; context?: unknown }
    | undefined;

  if (delegation) {
    if (!config.peer_nodes.includes(delegation.peer_node_id)) {
      throw new NodeConfigError(node.id, 'swarm', `valid peer (attempted handoff to "${delegation.peer_node_id}")`);
    }

    if (handoffCount >= config.max_handoffs) {
      logger.warn('swarm_max_handoffs', { node_id: node.id, count: handoffCount, max: config.max_handoffs });
      delete updates._peer_delegation;
      return action;
    }

    return {
      id: uuidv4(),
      idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
      type: 'handoff',
      payload: {
        node_id: delegation.peer_node_id,
        supervisor_id: node.id,
        reasoning: delegation.reason,
        memory_updates: {
          ...updates,
          _swarm_handoff_count: handoffCount + 1,
          _peer_delegation: undefined,
        },
      },
      metadata: {
        node_id: node.id,
        agent_id,
        timestamp: new Date(),
        attempt,
      },
    };
  }

  return action;
}
