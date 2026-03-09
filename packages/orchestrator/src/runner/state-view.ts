/**
 * State View Factory
 *
 * Creates a filtered view of workflow state for a node. This is the
 * security boundary that enforces read-key permissions — nodes only
 * see the memory keys listed in their `read_keys` array.
 *
 * @module runner/state-view
 */

import type { GraphNode } from '../types/graph.js';
import type { WorkflowState, StateView } from '../types/state.js';

/**
 * Create a filtered state view for a node.
 *
 * If the node's `read_keys` includes `'*'`, full memory access is
 * granted. Otherwise, only the listed keys are visible.
 *
 * @param state - The full workflow state.
 * @param node - The node requesting the view.
 * @returns A state view containing only the permitted memory keys.
 */
export function createStateView(state: WorkflowState, node: GraphNode): StateView {
  const allowedKeys = node.read_keys;

  const memory = allowedKeys.includes('*')
    ? filterInternalKeys(state.memory)
    : filterMemory(state.memory, allowedKeys);

  return {
    workflow_id: state.workflow_id,
    run_id: state.run_id,
    goal: state.goal,
    constraints: state.constraints,
    memory,
  };
}

/**
 * Strip internal (`_`-prefixed) keys from memory for wildcard access.
 *
 * Internal keys like `_taint_registry` are system bookkeeping and
 * should never be exposed to agent prompts.
 */
function filterInternalKeys(
  memory: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(memory)) {
    if (!key.startsWith('_')) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Build a memory object containing only the specified keys.
 */
function filterMemory(
  memory: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in memory) {
      filtered[key] = memory[key];
    }
  }
  return filtered;
}
