/**
 * Supervisor Node Executor
 *
 * Delegates to the supervisor executor which uses an LLM to decide
 * which managed node to route work to next.
 *
 * @module runner/node-executors/supervisor
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { createLogger } from '../../utils/logger.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.supervisor');

/**
 * Execute a supervisor node (LLM-powered dynamic routing).
 *
 * @param node - Supervisor node with `supervisor_config`.
 * @param stateView - Filtered state view for the supervisor LLM.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns Action containing the routing decision.
 */
export async function executeSupervisorNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  logger.info('supervisor_routing', { node_id: node.id, supervisor_config: node.supervisor_config });

  return ctx.deps.executeSupervisor(
    node,
    stateView,
    ctx.state.supervisor_history,
    attempt,
    { abortSignal: ctx.abortSignal },
  );
}
