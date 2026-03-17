/**
 * DrizzlePersistenceProvider Tests
 *
 * Integration tests against a real Postgres instance.
 * Validates Week 1 fix 1.1 (sort by version) and general CRUD.
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { createWorkflowState, createGraph } from '@mcai/orchestrator';
import type { WorkflowState } from '@mcai/orchestrator';

describe.skipIf(!isDatabaseAvailable())('DrizzlePersistenceProvider', () => {
  setupDatabaseTests();

  const provider = new DrizzlePersistenceProvider();

  function makeGraph(id?: string) {
    return createGraph({
      id,
      name: 'Test Graph',
      description: 'A test graph',
      nodes: [
        {
          id: 'start',
          type: 'agent',
          agent_id: 'agent-1',
          read_keys: ['*'],
          write_keys: ['*'],
        },
      ],
      edges: [],
      start_node: 'start',
      end_nodes: ['start'],
    });
  }

  function makeState(graphId: string, overrides: Partial<WorkflowState> = {}): WorkflowState {
    return createWorkflowState({
      workflow_id: graphId,
      goal: 'Test goal',
      ...overrides,
    });
  }

  // ── Graph Operations ──

  describe('saveGraph / loadGraph', () => {
    test('should save and load a graph', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);

      const loaded = await provider.loadGraph(graph.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('Test Graph');
      expect(loaded!.start_node).toBe('start');
    });

    test('should return null for non-existent graph', async () => {
      const loaded = await provider.loadGraph('00000000-0000-0000-0000-000000000000');
      expect(loaded).toBeNull();
    });

    test('should upsert on duplicate graph ID', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);

      const updated = { ...graph, name: 'Updated Graph' };
      await provider.saveGraph(updated);

      const loaded = await provider.loadGraph(graph.id);
      expect(loaded!.name).toBe('Updated Graph');
    });
  });

  describe('listGraphs', () => {
    test('should list graphs ordered by updated_at descending', async () => {
      const g1 = makeGraph();
      const g2 = makeGraph();
      await provider.saveGraph(g1);
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));
      await provider.saveGraph(g2);

      const list = await provider.listGraphs({ limit: 10 });
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list[0].id).toBe(g2.id); // Most recent first
    });
  });

  // ── Workflow Run Operations ──

  describe('saveWorkflowRun / loadWorkflowRun', () => {
    test('should save and load a workflow run', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);

      await provider.saveWorkflowRun(state);
      const loaded = await provider.loadWorkflowRun(state.run_id);

      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe('pending');
      expect(loaded!.graph_id).toBe(graph.id);
    });

    test('should return null for non-existent run', async () => {
      const loaded = await provider.loadWorkflowRun('00000000-0000-0000-0000-000000000000');
      expect(loaded).toBeNull();
    });
  });

  // ── Workflow State Operations ──

  describe('saveWorkflowState / loadLatestWorkflowState', () => {
    test('should save and load latest state', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      await provider.saveWorkflowState(state);
      const loaded = await provider.loadLatestWorkflowState(state.run_id);

      expect(loaded).not.toBeNull();
      expect(loaded!.workflow_id).toBe(graph.id);
      expect(loaded!.goal).toBe('Test goal');
    });

    test('should return null for non-existent run', async () => {
      const loaded = await provider.loadLatestWorkflowState('00000000-0000-0000-0000-000000000000');
      expect(loaded).toBeNull();
    });

    /**
     * Validates fix 1.1: loadLatestWorkflowState sorts by version, not created_at.
     * Two states saved in the same millisecond should return the higher version.
     */
    test('should return highest version regardless of created_at ordering', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state1 = makeState(graph.id);
      await provider.saveWorkflowRun(state1);

      // Save first state (version 1)
      await provider.saveWorkflowState(state1);

      // Save second state (version 2) with different memory
      const state2 = { ...state1, memory: { step: 'second' } };
      await provider.saveWorkflowState(state2);

      const loaded = await provider.loadLatestWorkflowState(state1.run_id);
      expect(loaded).not.toBeNull();
      // The latest version should have step: 'second'
      expect(loaded!.memory?.step).toBe('second');
    });
  });

  describe('loadWorkflowStateHistory', () => {
    test('should return state versions in order', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      await provider.saveWorkflowState(state);
      await provider.saveWorkflowState({ ...state, status: 'running' as const });
      await provider.saveWorkflowState({ ...state, status: 'completed' as const });

      const history = await provider.loadWorkflowStateHistory(state.run_id);
      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(1);
      expect(history[2].version).toBe(3);
    });
  });

  describe('loadWorkflowStateAtVersion', () => {
    test('should return the specific version', async () => {
      const graph = makeGraph();
      await provider.saveGraph(graph);
      const state = makeState(graph.id);
      await provider.saveWorkflowRun(state);

      await provider.saveWorkflowState(state);
      await provider.saveWorkflowState({ ...state, memory: { version: 'two' } });

      const v1 = await provider.loadWorkflowStateAtVersion(state.run_id, 1);
      expect(v1).not.toBeNull();

      const v2 = await provider.loadWorkflowStateAtVersion(state.run_id, 2);
      expect(v2).not.toBeNull();
      expect(v2!.memory?.version).toBe('two');
    });

    test('should return null for non-existent version', async () => {
      const result = await provider.loadWorkflowStateAtVersion('00000000-0000-0000-0000-000000000000', 999);
      expect(result).toBeNull();
    });
  });
});
