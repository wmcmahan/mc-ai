# Reducers — Technical Reference

> **Scope**: This document covers the state mutation system in `@mcai/orchestrator`. It is intended for contributors modifying state transitions, adding new action types, or working with the permission validation system.

---

## Overview

The reducer system implements the **Redux pattern** for workflow state management. All state mutations flow through pure functions: `(WorkflowState, Action) => WorkflowState`. No component in the system mutates state directly — agents emit actions, and reducers apply them.

There are two reducer pipelines:

| Reducer | Purpose | Caller |
|---------|---------|--------|
| **`rootReducer`** | Applies node actions (agent output, supervisor handoffs, HITL) | `GraphRunner` after node execution |
| **`internalReducer`** | Lifecycle transitions (init, advance, complete, fail, timeout) | `GraphRunner.dispatchInternal()` |

---

## Root Reducer Pipeline

`rootReducer` composes 7 sub-reducers applied in sequence. Each reducer checks `action.type` and returns the state unchanged if it doesn't match.

### Action Types

| Action Type | Reducer | Emitted By | Effect |
|-------------|---------|------------|--------|
| `update_memory` | `updateMemoryReducer` | Agent executor | Merges `payload.updates` into `state.memory` |
| `set_status` | `setStatusReducer` | Supervisor (completion) | Sets `state.status` to `payload.status` |
| `goto_node` | `gotoNodeReducer` | Router nodes | Sets `current_node`, appends to `visited_nodes` |
| `handoff` | `handoffReducer` | Supervisor executor | Sets `current_node`, appends to `visited_nodes` and `supervisor_history` |
| `request_human_input` | `requestHumanInputReducer` | Approval node | Sets status to `waiting`, stores `_pending_approval` in memory |
| `resume_from_human` | `resumeFromHumanReducer` | HITL resume | Sets status to `running`, merges human response into memory, removes `_pending_approval` |
| `merge_parallel_results` | `mergeParallelResultsReducer` | Map/voting nodes | Merges parallel results into memory, adds token usage |

### Composition

```typescript
export const rootReducer: Reducer = (state, action) => {
  let newState = state;
  newState = updateMemoryReducer(newState, action);
  newState = setStatusReducer(newState, action);
  newState = gotoNodeReducer(newState, action);
  newState = handoffReducer(newState, action);
  newState = requestHumanInputReducer(newState, action);
  newState = resumeFromHumanReducer(newState, action);
  newState = mergeParallelResultsReducer(newState, action);
  return newState;
};
```

Each reducer is a no-op for non-matching action types, so the full pipeline is safe for any action.

---

## Internal Reducer

`internalReducer` handles runner-controlled lifecycle transitions. These bypass permission checks since they are trusted internal operations.

| Action Type | Effect |
|-------------|--------|
| `_init` | Sets status to `running`, sets `current_node` to `start_node`, records `started_at`. On resume (`payload.resume === true`), only sets status |
| `_fail` | Sets status to `failed`, stores `last_error` |
| `_complete` | Sets status to `completed` |
| `_advance` | Sets `current_node` to next node, appends to `visited_nodes` |
| `_timeout` | Sets status to `timeout` |
| `_cancel` | Sets status to `cancelled` |
| `_track_tokens` | Adds `payload.tokens` to `total_tokens_used` |
| `_budget_exceeded` | Sets status to `failed`, stores budget error in `last_error` |
| `_push_compensation` | Pushes a compensation entry onto `compensation_stack` |
| `_increment_iteration` | Increments `iteration_count` |
| `_pop_compensation` | Pops the last entry from `compensation_stack` |

---

## Permission Validation

### `validateAction(action, allowedKeys): boolean`

Checks that an action only writes to keys the node is authorized to modify.

| Action Type | Permission Requirement |
|-------------|----------------------|
| `update_memory` | Each key in `payload.updates` must be in `allowedKeys` |
| `set_status` | Requires `'status'` in `allowedKeys` |
| `goto_node` | Requires `'control_flow'` in `allowedKeys` |
| `handoff` | Requires `'control_flow'` in `allowedKeys` |
| `request_human_input` | Requires `'control_flow'` in `allowedKeys` |
| `resume_from_human` | Requires `'control_flow'` in `allowedKeys` |
| `merge_parallel_results` | Each key in `payload.updates` must be in `allowedKeys` |
| Unknown types | Rejected by default |

The wildcard `'*'` in `allowedKeys` grants all permissions.

---

## Design Principles

- **Immutability**: Every reducer returns a new state object via spread (`{ ...state }`). Never mutates the input.
- **Determinism**: Reducers are pure functions with no side effects. Given the same state and action, they always produce the same result.
- **Single Responsibility**: Each sub-reducer handles exactly one action type.
- **Safe Composition**: Unknown action types pass through unchanged. The pipeline is additive — adding a new reducer cannot break existing ones.

---

## Exports

```typescript
// Reducer type
export type Reducer = (state: WorkflowState, action: Action) => WorkflowState;

// Individual reducers
export const updateMemoryReducer: Reducer;
export const setStatusReducer: Reducer;
export const gotoNodeReducer: Reducer;
export const handoffReducer: Reducer;
export const requestHumanInputReducer: Reducer;
export const resumeFromHumanReducer: Reducer;
export const mergeParallelResultsReducer: Reducer;

// Composite reducers
export const rootReducer: Reducer;
export const internalReducer: Reducer;

// Permission validation
export function validateAction(action: Action, allowedKeys: string[]): boolean;
```
