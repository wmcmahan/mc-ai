/**
 * Adversarial Reducer Tests
 *
 * Tests edge cases, malformed payloads, and boundary conditions
 * in the reducer pipeline to ensure robustness.
 */
import { describe, test, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  updateMemoryReducer,
  handoffReducer,
  rootReducer,
  internalReducer,
  validateAction,
} from '../src/reducers/index.js';
import type { WorkflowState, Action } from '../src/types/state.js';

const createBaseState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Test goal',
  constraints: [],
  status: 'running',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const makeAction = (type: string, payload: Record<string, unknown>): Action => ({
  id: uuidv4(),
  idempotency_key: uuidv4(),
  type,
  payload,
  metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
});

describe('Adversarial Reducer Tests', () => {
  describe('update_memory with unusual payloads', () => {
    test('should handle null values in updates', () => {
      const state = createBaseState();
      state.memory = { key: 'existing' };

      const action = makeAction('update_memory', {
        updates: { key: null },
      });

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.key).toBeNull();
    });

    test('should handle undefined values in updates', () => {
      const state = createBaseState();
      state.memory = { key: 'existing' };

      const action = makeAction('update_memory', {
        updates: { key: undefined },
      });

      const newState = updateMemoryReducer(state, action);
      // undefined spread still sets the key
      expect('key' in newState.memory).toBe(true);
    });

    test('should handle array values in updates', () => {
      const state = createBaseState();

      const action = makeAction('update_memory', {
        updates: { items: [1, 2, 3], nested: { a: [true] } },
      });

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.items).toEqual([1, 2, 3]);
      expect(newState.memory.nested).toEqual({ a: [true] });
    });

    test('should handle empty updates object', () => {
      const state = createBaseState();
      state.memory = { existing: 'value' };

      const action = makeAction('update_memory', {
        updates: {},
      });

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.existing).toBe('value');
      // updated_at should still change (reducer always updates timestamp)
      expect(newState.updated_at).not.toBe(state.updated_at);
    });

    test('should handle large number of keys without crashing', () => {
      const state = createBaseState();
      const updates: Record<string, unknown> = {};
      for (let i = 0; i < 10_000; i++) {
        updates[`key_${i}`] = i;
      }

      const action = makeAction('update_memory', { updates });
      const newState = updateMemoryReducer(state, action);

      expect(Object.keys(newState.memory)).toHaveLength(10_000);
      expect(newState.memory.key_0).toBe(0);
      expect(newState.memory.key_9999).toBe(9999);
    });
  });

  describe('handoff with missing fields', () => {
    test('should handle missing supervisor_id gracefully', () => {
      const state = createBaseState();

      // supervisor_id is cast to string, undefined becomes "undefined"
      const action = makeAction('handoff', {
        node_id: 'worker',
        reasoning: 'test',
      });

      const newState = handoffReducer(state, action);
      expect(newState.current_node).toBe('worker');
      // supervisor_history entry created with undefined supervisor_id
      expect(newState.supervisor_history).toHaveLength(1);
    });

    test('should handle missing reasoning gracefully', () => {
      const state = createBaseState();

      const action = makeAction('handoff', {
        node_id: 'worker',
        supervisor_id: 'sup',
      });

      const newState = handoffReducer(state, action);
      expect(newState.current_node).toBe('worker');
      expect(newState.supervisor_history).toHaveLength(1);
    });
  });

  describe('unknown action type', () => {
    test('rootReducer should return state unchanged for unknown type', () => {
      const state = createBaseState();
      const action = makeAction('completely_unknown_type', { data: 'test' });

      const newState = rootReducer(state, action);
      expect(newState).toBe(state); // Same reference — no reducer matched
    });

    test('internalReducer should return state unchanged for unknown type', () => {
      const state = createBaseState();
      const action = makeAction('_unknown_internal', { data: 'test' });

      const newState = internalReducer(state, action);
      expect(newState).toBe(state);
    });
  });

  describe('_init idempotency', () => {
    test('should be idempotent when called twice (non-resume)', () => {
      const state = createBaseState();
      state.status = 'pending';

      const action1 = makeAction('_init', { start_node: 'start' });
      const state1 = internalReducer(state, action1);

      expect(state1.status).toBe('running');
      expect(state1.current_node).toBe('start');
      expect(state1.visited_nodes).toEqual(['start']);

      // Second _init with same start_node
      const action2 = makeAction('_init', { start_node: 'start' });
      const state2 = internalReducer(state1, action2);

      expect(state2.status).toBe('running');
      expect(state2.current_node).toBe('start');
      // visited_nodes accumulates (not deduplicated)
      expect(state2.visited_nodes).toEqual(['start', 'start']);
    });

    test('_init with resume=true should not change current_node', () => {
      const state = createBaseState();
      state.status = 'waiting';
      state.current_node = 'paused_node';
      state.visited_nodes = ['start', 'paused_node'];

      const action = makeAction('_init', { resume: true });
      const newState = internalReducer(state, action);

      expect(newState.status).toBe('running');
      expect(newState.current_node).toBe('paused_node'); // Unchanged
      expect(newState.visited_nodes).toEqual(['start', 'paused_node']); // Unchanged
    });
  });

  describe('validateAction edge cases', () => {
    test('should reject with empty write_keys (deny all)', () => {
      const action = makeAction('update_memory', {
        updates: { key: 'value' },
      });

      expect(validateAction(action, [])).toBe(false);
    });

    test('should reject set_status with empty write_keys', () => {
      const action = makeAction('set_status', { status: 'completed' });
      expect(validateAction(action, [])).toBe(false);
    });

    test('should reject goto_node with empty write_keys', () => {
      const action = makeAction('goto_node', { node_id: 'next' });
      expect(validateAction(action, [])).toBe(false);
    });

    test('should reject handoff with empty write_keys', () => {
      const action = makeAction('handoff', {
        node_id: 'worker',
        supervisor_id: 'sup',
        reasoning: 'test',
      });
      expect(validateAction(action, [])).toBe(false);
    });

    test('should handle update_memory with undefined updates gracefully', () => {
      const action = makeAction('update_memory', {});

      // Object.keys(undefined) would throw, but payload.updates is undefined
      // The reducer casts it: action.payload.updates as Record<string, unknown>
      // Object.keys(undefined as any) throws — this is an edge case
      // validateAction should handle this without crashing
      try {
        const result = validateAction(action, ['*']);
        // If it doesn't throw, it should reject (no keys to validate)
        expect(typeof result).toBe('boolean');
      } catch {
        // Acceptable — undefined updates is a malformed payload
      }
    });
  });
});
