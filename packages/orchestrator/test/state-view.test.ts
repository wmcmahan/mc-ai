import { describe, test, expect } from 'vitest';
import { createStateView } from '../src/runner/state-view.js';
import type { WorkflowState } from '../src/types/state.js';
import type { GraphNode } from '../src/types/graph.js';

function makeState(memory: Record<string, unknown> = {}): WorkflowState {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    status: 'running',
    current_node: 'node-1',
    goal: 'test goal',
    constraints: ['no external calls'],
    memory,
    node_results: {},
    node_history: [],
  } as WorkflowState;
}

function makeNode(read_keys: string[]): GraphNode {
  return {
    id: 'node-1',
    type: 'agent',
    read_keys,
    write_keys: [],
    failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
    requires_compensation: false,
  } as GraphNode;
}

describe('createStateView', () => {
  describe('wildcard access', () => {
    test('should return full memory when read_keys includes *', () => {
      const state = makeState({
        public_data: 'visible',
        secret_data: 'also visible',
        nested: { deep: true },
      });

      const view = createStateView(state, makeNode(['*']));

      expect(view.memory).toEqual({
        public_data: 'visible',
        secret_data: 'also visible',
        nested: { deep: true },
      });
    });

    test('should include workflow metadata with wildcard', () => {
      const view = createStateView(makeState(), makeNode(['*']));

      expect(view.workflow_id).toBe('wf-1');
      expect(view.run_id).toBe('run-1');
      expect(view.goal).toBe('test goal');
      expect(view.constraints).toEqual(['no external calls']);
    });
  });

  describe('filtered access', () => {
    test('should only include specified keys', () => {
      const state = makeState({
        public_data: 'visible',
        secret_data: 'hidden',
        another_secret: 'also hidden',
      });

      const view = createStateView(state, makeNode(['public_data']));

      expect(view.memory).toEqual({ public_data: 'visible' });
      expect(view.memory).not.toHaveProperty('secret_data');
      expect(view.memory).not.toHaveProperty('another_secret');
    });

    test('should include multiple allowed keys', () => {
      const state = makeState({
        key_a: 'a',
        key_b: 'b',
        key_c: 'c',
      });

      const view = createStateView(state, makeNode(['key_a', 'key_c']));

      expect(view.memory).toEqual({ key_a: 'a', key_c: 'c' });
    });

    test('should silently omit keys not present in memory', () => {
      const state = makeState({ existing: 'value' });

      const view = createStateView(state, makeNode(['existing', 'nonexistent']));

      expect(view.memory).toEqual({ existing: 'value' });
      expect(Object.keys(view.memory)).toEqual(['existing']);
    });
  });

  describe('empty read_keys', () => {
    test('should return empty memory when read_keys is empty', () => {
      const state = makeState({
        data: 'should not be visible',
      });

      const view = createStateView(state, makeNode([]));

      expect(view.memory).toEqual({});
    });

    test('should still include workflow metadata', () => {
      const view = createStateView(makeState(), makeNode([]));

      expect(view.workflow_id).toBe('wf-1');
      expect(view.run_id).toBe('run-1');
      expect(view.goal).toBe('test goal');
    });
  });

  describe('internal key filtering', () => {
    test('should strip _taint_registry from wildcard access', () => {
      const state = makeState({
        findings: 'visible',
        _taint_registry: { findings: { source: 'web_search' } },
      });

      const view = createStateView(state, makeNode(['*']));

      expect(view.memory).toHaveProperty('findings');
      expect(view.memory).not.toHaveProperty('_taint_registry');
    });

    test('should strip all _-prefixed keys from wildcard access', () => {
      const state = makeState({
        data: 'visible',
        _taint_registry: {},
        _internal_counter: 42,
        _evolution_generation: 3,
      });

      const view = createStateView(state, makeNode(['*']));

      expect(view.memory).toEqual({ data: 'visible' });
    });

    test('should not filter _-prefixed keys when explicitly requested', () => {
      const state = makeState({
        data: 'visible',
        _taint_registry: { some: 'metadata' },
      });

      const view = createStateView(state, makeNode(['data', '_taint_registry']));

      expect(view.memory).toHaveProperty('_taint_registry');
      expect(view.memory).toHaveProperty('data');
    });
  });

  describe('edge cases', () => {
    test('should handle empty memory', () => {
      const view = createStateView(makeState({}), makeNode(['anything']));
      expect(view.memory).toEqual({});
    });

    test('should pass through complex nested values', () => {
      const state = makeState({
        nested: { deep: { array: [1, 2, 3], obj: { flag: true } } },
      });

      const view = createStateView(state, makeNode(['nested']));
      expect(view.memory.nested).toEqual({
        deep: { array: [1, 2, 3], obj: { flag: true } },
      });
    });

    test('should not mutate original state', () => {
      const state = makeState({ data: 'original' });
      const view = createStateView(state, makeNode(['data']));

      // View returns same reference (not a deep clone — that's fine for read-only)
      expect(view.memory.data).toBe('original');
      expect(state.memory.data).toBe('original');
    });
  });
});
