/**
 * Tool Node Executor
 *
 * Executes a standalone tool (MCP or built-in) and writes the result
 * to workflow memory. If the tool returns tainted data (external MCP),
 * the taint registry is updated accordingly.
 *
 * @module runner/node-executors/tool
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import type { TaintedToolResultShape } from './context.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.tool');

/**
 * Execute a tool node.
 *
 * Writes the result to `memory[<node_id>_result]`. If the tool
 * returns a {@link TaintedToolResultShape}, the taint registry
 * is updated to track the external data provenance.
 *
 * @param node - Tool node with `tool_id`.
 * @param stateView - Filtered state view (memory passed as tool args).
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns `update_memory` action with the tool result.
 * @throws If `tool_id` is missing.
 */
export async function executeToolNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const tool_id = node.tool_id;
  if (!tool_id) {
    throw new NodeConfigError(node.id, 'tool', 'tool_id');
  }

  logger.info('tool_node_executing', { tool_id, node_id: node.id });

  const raw = await ctx.deps.executeToolCall(tool_id, stateView.memory, node.agent_id);

  // Check if result carries taint metadata (external MCP tool)
  const isTaintedResult = raw && typeof raw === 'object' && 'taint' in raw && 'result' in raw;
  const resultValue = isTaintedResult ? (raw as TaintedToolResultShape).result : raw;
  const resultKey = `${node.id}_result`;

  const updates: Record<string, unknown> = { [resultKey]: resultValue };
  if (isTaintedResult) {
    const registry = ctx.deps.getTaintRegistry(ctx.state.memory);
    registry[resultKey] = (raw as TaintedToolResultShape).taint;
    updates['_taint_registry'] = registry;
  }

  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'update_memory',
    payload: { updates },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
    },
  };
}
