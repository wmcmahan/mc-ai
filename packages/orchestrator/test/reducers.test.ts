import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  updateMemoryReducer,
  setStatusReducer,
  gotoNodeReducer,
  handoffReducer,
  internalReducer,
  rootReducer,
  validateAction,
  MAX_VISITED_NODES,
} from '../src/reducers/index.js';
import type { WorkflowState, Action } from '../src/types/state.js';

describe('Reducers', () => {
  // Helper to create base state
  const createBaseState = (): WorkflowState => ({
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'Test goal',
    constraints: [],
    status: 'pending',
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

  describe('updateMemoryReducer', () => {
    test('should update memory with new values', () => {
      const state = createBaseState();
      state.memory = { count: 1, name: 'test' };

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: {
          updates: { count: 2, color: 'blue' },
        },
        metadata: {
          node_id: 'test-node',
          timestamp: new Date(),
          attempt: 1,
        },
      };

      const newState = updateMemoryReducer(state, action);

      expect(newState.memory.count).toBe(2);
      expect(newState.memory.color).toBe('blue');
      expect(newState.memory.name).toBe('test'); // Preserved
      expect(newState.updated_at).not.toBe(state.updated_at);
    });

    test('should not mutate original state', () => {
      const state = createBaseState();
      state.memory = { count: 1 };

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { count: 2 } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);

      expect(newState).not.toBe(state);
      expect(newState.memory).not.toBe(state.memory);
      expect(state.memory.count).toBe(1); // Original unchanged
    });

    test('should ignore non-update_memory actions', () => {
      const state = createBaseState();
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);

      expect(newState).toBe(state); // Same reference
    });
  });

  describe('setStatusReducer', () => {
    test('should update workflow status', () => {
      const state = createBaseState();
      state.status = 'pending';

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = setStatusReducer(state, action);

      expect(newState.status).toBe('running');
      expect(newState.updated_at).not.toBe(state.updated_at);
    });

    test('should handle all valid statuses', () => {
      const statuses = [
        'pending',
        'scheduled',
        'running',
        'waiting',
        'retrying',
        'completed',
        'failed',
        'cancelled',
        'timeout',
      ] as const;

      for (const status of statuses) {
        const state = createBaseState();
        const action: Action = {
          id: uuidv4(),
          idempotency_key: uuidv4(),
          type: 'set_status',
          payload: { status },
          metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
        };

        const newState = setStatusReducer(state, action);
        expect(newState.status).toBe(status);
      }
    });

    test('should ignore non-set_status actions', () => {
      const state = createBaseState();
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: {} },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = setStatusReducer(state, action);
      expect(newState).toBe(state);
    });
  });

  describe('gotoNodeReducer', () => {
    test('should update current_node and track visited nodes', () => {
      const state = createBaseState();
      state.current_node = 'node1';
      state.visited_nodes = ['node1'];
      state.iteration_count = 1;

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'node2' },
        metadata: { node_id: 'node1', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);

      expect(newState.current_node).toBe('node2');
      expect(newState.visited_nodes).toEqual(['node1', 'node2']);
      expect(newState.iteration_count).toBe(1); // goto_node no longer increments; runner loop does
    });

    test('should increment iteration count', () => {
      const state = createBaseState();
      state.iteration_count = 5;

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'next' },
        metadata: { node_id: 'current', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);
      expect(newState.iteration_count).toBe(5); // goto_node no longer increments; runner loop does
    });

    test('should ignore non-goto_node actions', () => {
      const state = createBaseState();
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: {} },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);
      expect(newState).toBe(state);
    });
  });

  describe('rootReducer', () => {
    test('should apply all reducers in sequence', () => {
      const state = createBaseState();
      state.status = 'pending';
      state.memory = {};

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'success' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = rootReducer(state, action);

      expect(newState.memory.result).toBe('success');
    });

    test('should be composable', () => {
      let state = createBaseState();

      // Apply multiple actions
      state = rootReducer(state, {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { step: 1 } },
        metadata: { node_id: 'n1', timestamp: new Date(), attempt: 1 },
      });

      state = rootReducer(state, {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'n2' },
        metadata: { node_id: 'n1', timestamp: new Date(), attempt: 1 },
      });

      state = rootReducer(state, {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'n2', timestamp: new Date(), attempt: 1 },
      });

      expect(state.memory.step).toBe(1);
      expect(state.current_node).toBe('n2');
      expect(state.status).toBe('running');
      expect(state.iteration_count).toBe(0); // goto_node no longer increments; runner loop does
    });
  });

  describe('bounded visited_nodes', () => {
    test('should cap visited_nodes at MAX_VISITED_NODES via gotoNodeReducer', () => {
      const state = createBaseState();
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'overflow' },
        metadata: { node_id: 'current', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1'); // n0 was dropped
    });

    test('should cap visited_nodes at MAX_VISITED_NODES via handoffReducer', () => {
      const state = createBaseState();
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'handoff',
        payload: { node_id: 'overflow', supervisor_id: 'sup', reasoning: 'test' },
        metadata: { node_id: 'current', timestamp: new Date(), attempt: 1 },
      };

      const newState = handoffReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1');
    });

    test('should cap visited_nodes via _advance internal action', () => {
      const state = createBaseState();
      state.status = 'running';
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: '_advance',
        payload: { node_id: 'overflow' },
        metadata: { node_id: 'runner', timestamp: new Date(), attempt: 1 },
      };

      const newState = internalReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1');
    });

    test('should cap visited_nodes via _init internal action', () => {
      const state = createBaseState();
      state.visited_nodes = Array.from({ length: MAX_VISITED_NODES }, (_, i) => `n${i}`);

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: '_init',
        payload: { start_node: 'overflow' },
        metadata: { node_id: 'runner', timestamp: new Date(), attempt: 1 },
      };

      const newState = internalReducer(state, action);

      expect(newState.visited_nodes).toHaveLength(MAX_VISITED_NODES);
      expect(newState.visited_nodes.at(-1)).toBe('overflow');
      expect(newState.visited_nodes[0]).toBe('n1');
    });

    test('should not truncate when under the cap', () => {
      const state = createBaseState();
      state.visited_nodes = ['a', 'b'];

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'c' },
        metadata: { node_id: 'b', timestamp: new Date(), attempt: 1 },
      };

      const newState = gotoNodeReducer(state, action);

      expect(newState.visited_nodes).toEqual(['a', 'b', 'c']);
    });
  });

  describe('validateAction', () => {
    test('should allow wildcard permissions', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { secret: 'data' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['*']);
      expect(isValid).toBe(true);
    });

    test('should allow writes to permitted keys', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'ok', count: 5 } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['result', 'count']);
      expect(isValid).toBe(true);
    });

    test('should block writes to unpermitted keys', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { secret: 'data' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['result', 'count']);
      expect(isValid).toBe(false);
    });

    test('should block partial unauthorized writes', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'ok', secret: 'bad' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['result']);
      expect(isValid).toBe(false); // 'secret' not allowed
    });

    test('should block non-update_memory actions without explicit permission', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      // set_status requires 'status' in write_keys
      const isValid = validateAction(action, []);
      expect(isValid).toBe(false);
    });

    test('should allow set_status with status permission', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'set_status',
        payload: { status: 'running' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['status']);
      expect(isValid).toBe(true);
    });

    test('should allow goto_node with control_flow permission', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'goto_node',
        payload: { node_id: 'next' },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['control_flow']);
      expect(isValid).toBe(true);
    });

    test('should block unknown action types even with wildcard', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'unknown_type',
        payload: {},
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const isValid = validateAction(action, ['*']);
      expect(isValid).toBe(false); // Unknown types are always rejected (deny-by-default)
    });

    test('should skip _-prefixed system keys during validation (executor handles agent blocking)', () => {
      // _-prefixed keys like _taint_registry are injected by the executor as
      // trusted system metadata. validateAction skips them — the agent-level
      // check in validateMemoryUpdatePermissions blocks agents from writing
      // _-prefixed keys directly.
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { _taint_registry: { source: 'mcp_tool' } } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      // Only system keys — no user keys to validate, so passes
      expect(validateAction(action, ['*'])).toBe(true);
      expect(validateAction(action, ['some_key'])).toBe(true);
    });

    test('should allow wildcard write to normal keys via update_memory', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'ok', count: 5 } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      expect(validateAction(action, ['*'])).toBe(true);
    });

    test('should skip _-prefixed keys in merge_parallel_results', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: { updates: { result: 'ok', _internal: 'system' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      // _internal is skipped, result is allowed by wildcard
      expect(validateAction(action, ['*'])).toBe(true);
    });

    test('should allow merge_parallel_results with normal keys and wildcard', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: { updates: { result: 'ok' }, total_tokens: 100 },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      expect(validateAction(action, ['*'])).toBe(true);
    });

    test('should validate user keys alongside _-prefixed system keys', () => {
      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { _taint_registry: {}, normal: 'ok' } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      // _taint_registry skipped; 'normal' checked against allowedKeys
      expect(validateAction(action, ['normal'])).toBe(true);
      expect(validateAction(action, ['other_key'])).toBe(false);
    });
  });

  describe('Memory value size validation', () => {
    test('drops oversized memory values in updateMemoryReducer', () => {
      const state = createBaseState();
      // Create a value larger than MAX_MEMORY_VALUE_BYTES (1MB)
      const oversizedValue = 'x'.repeat(1024 * 1024 + 1);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: {
          updates: {
            normal_key: 'normal_value',
            oversized_key: oversizedValue,
          },
        },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.normal_key).toBe('normal_value');
      expect(newState.memory.oversized_key).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropping oversized memory key "oversized_key"'),
      );

      consoleSpy.mockRestore();
    });

    test('drops oversized values in mergeParallelResultsReducer', () => {
      const state = createBaseState();
      const oversizedValue = 'y'.repeat(1024 * 1024 + 1);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'merge_parallel_results',
        payload: {
          updates: {
            good: 'ok',
            big: oversizedValue,
          },
          total_tokens: 100,
        },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = rootReducer(state, action);
      expect(newState.memory.good).toBe('ok');
      expect(newState.memory.big).toBeUndefined();

      consoleSpy.mockRestore();
    });

    test('allows values within the size limit', () => {
      const state = createBaseState();
      const normalValue = 'x'.repeat(1000); // well within 1MB

      const action: Action = {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { key: normalValue } },
        metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
      };

      const newState = updateMemoryReducer(state, action);
      expect(newState.memory.key).toBe(normalValue);
    });
  });
});
