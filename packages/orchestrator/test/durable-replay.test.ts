/**
 * durable-replay.test.ts
 *
 * Tests for event sourcing (write path) and deterministic replay (recovery path).
 * Verifies that the event log captures all significant state transitions and
 * that GraphRunner.recover() can reconstruct pre-crash state from events alone.
 */
import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks (must be before any imports that use them) ───────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
  tool: vi.fn((def: unknown) => def),
  jsonSchema: vi.fn((s: unknown) => s),
  Output: { object: vi.fn((o: unknown) => o) },
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

/**
 * Agent executor mock: returns update_memory actions based on agent_id.
 * Default behavior: writes { [agentId]_result: 'done' }.
 */
vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: `${agentId}:mock:${attempt}`,
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'done' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor/executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/evaluator-executor/executor', () => ({
  evaluateQualityExecutor: vi.fn(),
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

vi.mock('../src/utils/taint', () => ({
  getTaintRegistry: vi.fn().mockReturnValue({}),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import { GraphRunner } from '../src/runner/graph-runner.js';
import { InMemoryEventLogWriter } from '../src/db/event-log.js';
import type { Graph, GraphNode, GraphEdge } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeNode(id: string, type: GraphNode['type'] = 'agent'): GraphNode {
  return {
    id,
    type,
    agent_id: id,
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 10, max_backoff_ms: 10 },
  };
}

function makeEdge(source: string, target: string): GraphEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    condition: { type: 'always' as const },
  };
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    status: 'pending' as const,
    goal: 'test goal',
    constraints: [],
    memory: {},
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    total_tokens_used: 0,
    visited_nodes: [],
    max_iterations: 50,
    max_execution_time_ms: 3600000,
    compensation_stack: [],
    supervisor_history: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Durable Execution — Event Sourcing', () => {

  describe('Event Logging (Write Path)', () => {
    test('should append events during a normal 2-node run', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'simple',
        nodes: [makeNode('start'), makeNode('end')],
        edges: [makeEdge('start', 'end')],
        start_node: 'start',
        end_nodes: ['end'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      const result = await runner.run();
      expect(result.status).toBe('completed');

      const events = eventLog.getEventsForRun(state.run_id);

      // Should have multiple events for a 2-node run
      expect(events.length).toBeGreaterThan(5);

      // Verify core event types present
      const types = events.map(e => e.event_type);
      expect(types).toContain('workflow_started');
      expect(types).toContain('node_started');
      expect(types).toContain('action_dispatched');
      expect(types).toContain('internal_dispatched');

      // Verify action_dispatched events contain full Actions
      const actionEvents = events.filter(e => e.event_type === 'action_dispatched');
      expect(actionEvents).toHaveLength(2);
      expect(actionEvents[0].action?.type).toBe('update_memory');
      expect(actionEvents[1].action?.type).toBe('update_memory');

      // Sequence IDs are monotonically increasing
      for (let i = 1; i < events.length; i++) {
        expect(events[i].sequence_id).toBeGreaterThan(events[i - 1].sequence_id);
      }
    });

    test('should preserve event ordering across nodes', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'three-node',
        nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
        start_node: 'a',
        end_nodes: ['c'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      // node_started events should be in execution order
      const nodeStartEvents = eventLog
        .getEventsForRun(state.run_id)
        .filter(e => e.event_type === 'node_started');

      expect(nodeStartEvents.map(e => e.node_id)).toEqual(['a', 'b', 'c']);
    });

    test('should capture internal dispatch events', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'single',
        nodes: [makeNode('only')],
        edges: [],
        start_node: 'only',
        end_nodes: ['only'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      const internalEvents = eventLog
        .getEventsForRun(state.run_id)
        .filter(e => e.event_type === 'internal_dispatched');

      const internalTypes = internalEvents.map(e => e.internal_type);
      expect(internalTypes).toContain('_init');
      expect(internalTypes).toContain('_complete');
      expect(internalTypes).toContain('_increment_iteration');
    });
  });

  describe('Recovery (Replay Path)', () => {
    test('should recover completed workflow state from event log', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'recoverable',
        nodes: [makeNode('start'), makeNode('end')],
        edges: [makeEdge('start', 'end')],
        start_node: 'start',
        end_nodes: ['end'],
      };
      const state = makeState({ workflow_id: graph.id });

      // Run to completion, capturing events
      const runner1 = new GraphRunner(graph, state, { eventLog });
      const result1 = await runner1.run();
      expect(result1.status).toBe('completed');

      // Recover from events only — no state snapshot
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);

      // Recovered state should match completed state
      const recovered = runner2['state'] as WorkflowState;
      expect(recovered.status).toBe('completed');
      expect(recovered.visited_nodes).toEqual(result1.visited_nodes);
      expect(recovered.iteration_count).toBe(result1.iteration_count);
      // Memory should contain the agent outputs
      expect(recovered.memory).toEqual(result1.memory);
    });

    test('should recover 3-node workflow with correct memory accumulation', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'three-step',
        nodes: [makeNode('step1'), makeNode('step2'), makeNode('step3')],
        edges: [makeEdge('step1', 'step2'), makeEdge('step2', 'step3')],
        start_node: 'step1',
        end_nodes: ['step3'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner1 = new GraphRunner(graph, state, { eventLog });
      const result1 = await runner1.run();
      expect(result1.status).toBe('completed');

      // Each node writes {agentId_result: 'done'}, so memory should have 3 keys
      expect(result1.memory).toEqual({
        step1_result: 'done',
        step2_result: 'done',
        step3_result: 'done',
      });

      // Recover and verify identical state
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);
      const recovered = runner2['state'] as WorkflowState;
      expect(recovered.memory).toEqual(result1.memory);
      expect(recovered.visited_nodes).toEqual(['step1', 'step2', 'step3']);
    });

    test('should throw on empty event log', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'empty',
        nodes: [makeNode('start')],
        edges: [],
        start_node: 'start',
        end_nodes: ['start'],
      };

      await expect(
        GraphRunner.recover(graph, 'nonexistent-run', eventLog)
      ).rejects.toThrow(/corrupted or incomplete/);
    });

    test('should continue sequence_id after recovery', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'seq-check',
        nodes: [makeNode('only')],
        edges: [],
        start_node: 'only',
        end_nodes: ['only'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner1 = new GraphRunner(graph, state, { eventLog });
      await runner1.run();

      const eventsBefore = eventLog.getEventsForRun(state.run_id);
      const maxSeqBefore = Math.max(...eventsBefore.map(e => e.sequence_id));

      // Recover — sequenceId should be set past all replayed events
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);
      // The recovered runner's sequenceId is internal, but we can verify by
      // checking that calling getEventLog() works
      expect(runner2.getEventLog()).toBe(eventLog);
      expect(runner2['sequenceId']).toBe(maxSeqBefore + 1);
    });
  });

  describe('InMemoryEventLogWriter', () => {
    test('should store and retrieve events in sequence_id order', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const runId = uuidv4();

      await eventLog.append({ run_id: runId, sequence_id: 2, event_type: 'node_started', node_id: 'b' });
      await eventLog.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' });
      await eventLog.append({ run_id: runId, sequence_id: 1, event_type: 'node_started', node_id: 'a' });

      const events = await eventLog.loadEvents(runId);
      expect(events.map(e => e.sequence_id)).toEqual([0, 1, 2]);
    });

    test('should return -1 for latest sequence_id of unknown run', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const seq = await eventLog.getLatestSequenceId('unknown');
      expect(seq).toBe(-1);
    });

    test('should isolate events by run_id', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const run1 = uuidv4();
      const run2 = uuidv4();

      await eventLog.append({ run_id: run1, sequence_id: 0, event_type: 'workflow_started' });
      await eventLog.append({ run_id: run2, sequence_id: 0, event_type: 'workflow_started' });
      await eventLog.append({ run_id: run1, sequence_id: 1, event_type: 'node_started', node_id: 'a' });

      expect((await eventLog.loadEvents(run1)).length).toBe(2);
      expect((await eventLog.loadEvents(run2)).length).toBe(1);
    });

    test('should clear all events', async () => {
      const eventLog = new InMemoryEventLogWriter();
      await eventLog.append({ run_id: uuidv4(), sequence_id: 0, event_type: 'workflow_started' });
      eventLog.clear();
      expect((await eventLog.loadEvents('any')).length).toBe(0);
    });
  });

  describe('Compaction', () => {
    test('should compact events after workflow completion', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'compactable',
        nodes: [makeNode('start'), makeNode('end')],
        edges: [makeEdge('start', 'end')],
        start_node: 'start',
        end_nodes: ['end'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      const eventsBefore = eventLog.getEventsForRun(state.run_id);
      expect(eventsBefore.length).toBeGreaterThan(5);

      // Compact all events
      const deleted = await runner.compactEvents();
      expect(deleted).toBe(eventsBefore.length);

      // Events should be gone
      const eventsAfter = eventLog.getEventsForRun(state.run_id);
      expect(eventsAfter.length).toBe(0);

      // Checkpoint should exist
      const checkpoint = await eventLog.loadCheckpoint(state.run_id);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.state.status).toBe('completed');
    });

    test('should recover from checkpoint after compaction', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'compact-recover',
        nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
        start_node: 'a',
        end_nodes: ['c'],
      };
      const state = makeState({ workflow_id: graph.id });

      // Run to completion
      const runner1 = new GraphRunner(graph, state, { eventLog });
      const result1 = await runner1.run();

      // Compact all events
      await runner1.compactEvents();

      // Recover — should use checkpoint, not events
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);
      const recovered = runner2['state'] as WorkflowState;

      expect(recovered.status).toBe('completed');
      expect(recovered.memory).toEqual(result1.memory);
      expect(recovered.visited_nodes).toEqual(result1.visited_nodes);
    });

    test('should compact and load only events after checkpoint', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const runId = uuidv4();

      // Simulate a 6-event log
      for (let i = 0; i < 6; i++) {
        await eventLog.append({
          run_id: runId,
          sequence_id: i,
          event_type: 'node_started',
          node_id: `node-${i}`,
        });
      }

      // Checkpoint at sequence 3
      const mockState = makeState({ run_id: runId });
      await eventLog.checkpoint(runId, 3, mockState);

      // Compact events <= 3
      const deleted = await eventLog.compact(runId, 3);
      expect(deleted).toBe(4); // events 0,1,2,3

      // Only events 4,5 remain
      const remaining = eventLog.getEventsForRun(runId);
      expect(remaining.length).toBe(2);
      expect(remaining.map(e => e.sequence_id)).toEqual([4, 5]);

      // loadEventsAfter should also return only 4,5
      const after = await eventLog.loadEventsAfter(runId, 3);
      expect(after.map(e => e.sequence_id)).toEqual([4, 5]);
    });

    test('compactEvents() on fresh runner (no events) returns 0', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'empty',
        nodes: [makeNode('start')],
        edges: [],
        start_node: 'start',
        end_nodes: ['start'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      const deleted = await runner.compactEvents();
      expect(deleted).toBe(0);
    });
  });
});
