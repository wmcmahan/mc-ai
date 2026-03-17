/**
 * Workflow State Reducers
 *
 * Pure functions that produce new state from `(State, Action)` pairs.
 * The {@link GraphRunner} dispatches actions through these reducers to
 * advance workflow execution.
 *
 * Two categories:
 *
 * 1. **Public reducers** — applied via {@link rootReducer} for agent-generated
 *    actions. Subject to permission checks via {@link validateAction}.
 * 2. **Internal reducer** — {@link internalReducer} handles runner-controlled
 *    lifecycle transitions (init, complete, fail, etc.). These bypass
 *    permission checks since they are trusted internal operations.
 *
 * All reducers are pure: they never mutate the input state.
 *
 * @module reducers
 */

import type { WorkflowState, Action, WaitingReason, InternalActionType } from '../types/state.js';
import {
  UpdateMemoryPayloadSchema,
  SetStatusPayloadSchema,
  GotoNodePayloadSchema,
  HandoffPayloadSchema,
  RequestHumanInputPayloadSchema,
  ResumeFromHumanPayloadSchema,
  MergeParallelResultsPayloadSchema,
} from '../types/state.js';

/**
 * Reducer function signature.
 *
 * Pure function: `(State, Action) → NewState`.
 * Must return the original state unchanged for unrecognised action types.
 */
export type Reducer = (state: WorkflowState, action: Action) => WorkflowState;

export const MAX_SUPERVISOR_HISTORY = 100;
export const MAX_VISITED_NODES = 1000;

/** Append a node ID to visited_nodes, keeping only the last MAX_VISITED_NODES entries. */
function appendVisited(visited: string[], nodeId: string): string[] {
  const next = [...visited, nodeId];
  return next.length > MAX_VISITED_NODES ? next.slice(-MAX_VISITED_NODES) : next;
}

// ─── Public Reducers ────────────────────────────────────────────────

/**
 * Merge key-value updates into workflow memory.
 *
 * Action type: `update_memory`
 * Payload: `{ updates: Record<string, unknown> }`
 */
export const updateMemoryReducer: Reducer = (state, action) => {
  if (action.type !== 'update_memory') return state;

  const { updates } = UpdateMemoryPayloadSchema.parse(action.payload);

  return {
    ...state,
    memory: {
      ...state.memory,
      ...updates,
    },
    updated_at: new Date(),
  };
};

/**
 * Set the workflow status.
 *
 * Action type: `set_status`
 * Payload: `{ status: WorkflowState['status'] }`
 */
export const setStatusReducer: Reducer = (state, action) => {
  if (action.type !== 'set_status') return state;

  const { status } = SetStatusPayloadSchema.parse(action.payload);

  return {
    ...state,
    status,
    updated_at: new Date(),
  };
};

/**
 * Navigate to the next node in the graph.
 *
 * Action type: `goto_node`
 * Payload: `{ node_id: string }`
 */
export const gotoNodeReducer: Reducer = (state, action) => {
  if (action.type !== 'goto_node') return state;

  const { node_id } = GotoNodePayloadSchema.parse(action.payload);

  return {
    ...state,
    current_node: node_id,
    visited_nodes: appendVisited(state.visited_nodes, node_id),
    updated_at: new Date(),
  };
};

/**
 * Supervisor handoff — route execution to a managed node.
 *
 * Action type: `handoff`
 * Payload: `{ node_id: string, supervisor_id: string, reasoning: string }`
 */
export const handoffReducer: Reducer = (state, action) => {
  if (action.type !== 'handoff') return state;

  const { node_id, supervisor_id, reasoning } = HandoffPayloadSchema.parse(action.payload);

  const newHistory = [
    ...state.supervisor_history,
    {
      supervisor_id,
      delegated_to: node_id,
      reasoning,
      iteration: state.iteration_count,
      timestamp: new Date(),
    },
  ];

  return {
    ...state,
    current_node: node_id,
    visited_nodes: appendVisited(state.visited_nodes, node_id),
    supervisor_history: newHistory.length > MAX_SUPERVISOR_HISTORY
      ? newHistory.slice(-MAX_SUPERVISOR_HISTORY)
      : newHistory,
    updated_at: new Date(),
  };
};

/**
 * Pause the workflow to request human input.
 *
 * Action type: `request_human_input`
 * Payload: `{ waiting_for?: WaitingReason, timeout_ms?: number, pending_approval: unknown }`
 *
 * Default timeout: 24 hours.
 */
export const requestHumanInputReducer: Reducer = (state, action) => {
  if (action.type !== 'request_human_input') return state;

  const parsed = RequestHumanInputPayloadSchema.parse(action.payload);
  const now = new Date();
  const timeout_ms = parsed.timeout_ms || 86_400_000;

  return {
    ...state,
    status: 'waiting' as const,
    waiting_for: (parsed.waiting_for as WaitingReason) || 'human_approval',
    waiting_since: now,
    waiting_timeout_at: new Date(now.getTime() + timeout_ms),
    memory: {
      ...state.memory,
      _pending_approval: parsed.pending_approval,
    },
    updated_at: now,
  };
};

/**
 * Resume the workflow after human input is received.
 *
 * Clears waiting state and merges the human's response, decision,
 * and any additional memory updates. Removes `_pending_approval`.
 *
 * Action type: `resume_from_human`
 * Payload: `{ response: unknown, decision: unknown, memory_updates?: Record<string, unknown> }`
 */
export const resumeFromHumanReducer: Reducer = (state, action) => {
  if (action.type !== 'resume_from_human') return state;

  const parsed = ResumeFromHumanPayloadSchema.parse(action.payload);

  const memoryUpdates: Record<string, unknown> = {
    human_response: parsed.response,
    human_decision: parsed.decision,
  };

  if (parsed.memory_updates && typeof parsed.memory_updates === 'object') {
    Object.assign(memoryUpdates, parsed.memory_updates);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit
  const { _pending_approval, ...restMemory } = state.memory;

  return {
    ...state,
    status: 'running' as const,
    waiting_for: undefined,
    waiting_since: undefined,
    waiting_timeout_at: undefined,
    memory: {
      ...restMemory,
      ...memoryUpdates,
    },
    updated_at: new Date(),
  };
};

/**
 * Merge parallel execution results into memory and accumulate token usage.
 *
 * Action type: `merge_parallel_results`
 * Payload: `{ updates: Record<string, unknown>, total_tokens?: number }`
 */
export const mergeParallelResultsReducer: Reducer = (state, action) => {
  if (action.type !== 'merge_parallel_results') return state;

  const { updates, total_tokens } = MergeParallelResultsPayloadSchema.parse(action.payload);
  const totalTokens = total_tokens || 0;

  return {
    ...state,
    memory: {
      ...state.memory,
      ...updates,
    },
    total_tokens_used: (state.total_tokens_used || 0) + totalTokens,
    updated_at: new Date(),
  };
};

// ─── Root Reducer ───────────────────────────────────────────────────

/** All public reducers, applied in sequence by {@link rootReducer}. */
const PUBLIC_REDUCERS: readonly Reducer[] = [
  updateMemoryReducer,
  setStatusReducer,
  gotoNodeReducer,
  handoffReducer,
  requestHumanInputReducer,
  resumeFromHumanReducer,
  mergeParallelResultsReducer,
];

/**
 * Composite reducer — applies all public reducers in sequence.
 *
 * Each reducer checks the action type and returns state unchanged if
 * it doesn't match, so exactly one reducer will handle each action.
 */
export const rootReducer: Reducer = (state, action) => {
  return PUBLIC_REDUCERS.reduce<WorkflowState>((s, reducer) => reducer(s, action), state);
};

// ─── Internal Reducer ───────────────────────────────────────────────

/**
 * Internal reducer for runner-controlled lifecycle transitions.
 *
 * Handles status changes, node advancement, token/cost tracking,
 * and compensation stack management. These actions are prefixed with
 * `_` and bypass permission checks since they are trusted operations
 * dispatched only by the {@link GraphRunner}.
 */
export const internalReducer: Reducer = (state, action) => {
  // Internal actions have `_`-prefixed types that are not in ActionTypeSchema.
  // They are constructed via dispatchInternal() with a type cast and bypass
  // ActionSchema validation. We use InternalActionType for the switch.
  switch (action.type as InternalActionType) {
    case '_init': {
      const now = new Date();
      if (action.payload.resume === true) {
        return { ...state, status: 'running' as const, updated_at: now };
      }
      const startNode = action.payload.start_node as string;
      return {
        ...state,
        status: 'running' as const,
        current_node: startNode,
        visited_nodes: appendVisited(state.visited_nodes, startNode),
        started_at: now,
        updated_at: now,
      };
    }

    case '_fail':
      return {
        ...state,
        status: 'failed' as const,
        last_error: action.payload.last_error as string,
        updated_at: new Date(),
      };

    case '_complete':
      return { ...state, status: 'completed' as const, updated_at: new Date() };

    case '_advance': {
      const nodeId = action.payload.node_id as string;
      return {
        ...state,
        current_node: nodeId,
        visited_nodes: appendVisited(state.visited_nodes, nodeId),
        updated_at: new Date(),
      };
    }

    case '_timeout':
      return { ...state, status: 'timeout' as const, updated_at: new Date() };

    case '_cancel':
      return { ...state, status: 'cancelled' as const, updated_at: new Date() };

    case '_track_tokens': {
      const tokens = action.payload.tokens as number;
      return {
        ...state,
        total_tokens_used: (state.total_tokens_used || 0) + tokens,
        updated_at: new Date(),
      };
    }

    case '_track_cost': {
      const costUsd = action.payload.cost_usd as number;
      return {
        ...state,
        total_cost_usd: (state.total_cost_usd ?? 0) + costUsd,
        updated_at: new Date(),
      };
    }

    case '_fire_cost_threshold': {
      const threshold = action.payload.threshold as number;
      return {
        ...state,
        _cost_alert_thresholds_fired: [...(state._cost_alert_thresholds_fired ?? []), threshold],
        updated_at: new Date(),
      };
    }

    case '_budget_exceeded':
      return {
        ...state,
        status: 'failed' as const,
        last_error: action.payload.last_error as string,
        updated_at: new Date(),
      };

    case '_push_compensation':
      return {
        ...state,
        compensation_stack: [
          ...state.compensation_stack,
          {
            action_id: action.payload.action_id as string,
            compensation_action: action.payload.compensation_action as unknown,
          },
        ],
        updated_at: new Date(),
      };

    case '_increment_iteration':
      return {
        ...state,
        iteration_count: state.iteration_count + 1,
        updated_at: new Date(),
      };

    case '_pop_compensation': {
      const stack = [...state.compensation_stack];
      stack.pop();
      return {
        ...state,
        compensation_stack: stack,
        updated_at: new Date(),
      };
    }

    default:
      return state;
  }
};

// ─── Permission Validation ──────────────────────────────────────────

/**
 * Validate that an agent has permission to dispatch a given action.
 *
 * Checks the action's required keys against the agent's `write_keys`
 * permissions. The wildcard `'*'` grants all permissions.
 *
 * @param action - The action to validate.
 * @param allowedKeys - The agent's allowed write keys.
 * @returns `true` if the action is permitted, `false` otherwise.
 */
export function validateAction(
  action: Action,
  allowedKeys: string[]
): boolean {
  switch (action.type) {
    case 'update_memory': {
      const { updates } = UpdateMemoryPayloadSchema.parse(action.payload);
      const keys = Object.keys(updates);
      // Block writes to internal keys (e.g., _taint_registry) — even with wildcard
      if (keys.some(k => k.startsWith('_'))) return false;
      return allowedKeys.includes('*') || keys.every(k => allowedKeys.includes(k));
    }

    case 'set_status':
      return allowedKeys.includes('*') || allowedKeys.includes('status');

    case 'goto_node':
    case 'handoff':
    case 'request_human_input':
    case 'resume_from_human':
      return allowedKeys.includes('*') || allowedKeys.includes('control_flow');

    case 'merge_parallel_results': {
      const { updates: parallelUpdates } = MergeParallelResultsPayloadSchema.parse(action.payload);
      const parallelKeys = Object.keys(parallelUpdates);
      // Block writes to internal keys (e.g., _taint_registry) — even with wildcard
      if (parallelKeys.some(k => k.startsWith('_'))) return false;
      return allowedKeys.includes('*') || parallelKeys.every(k => allowedKeys.includes(k));
    }

    default:
      // Unknown action types are rejected for safety (deny-by-default)
      return false;
  }
}
