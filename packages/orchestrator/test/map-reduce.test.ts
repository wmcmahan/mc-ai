import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', () => ({ generateObject: vi.fn(), streamText: vi.fn() }));
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_n: string, _o: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, stateView: any, _t: any, attempt: number) => {
    const item = stateView.memory._map_item;
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { [`${agentId}_result`]: `processed: ${JSON.stringify(item)}` } },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 30 },
      },
    };
  }),
}));

vi.mock('../src/agent/supervisor-executor', () => ({ executeSupervisor: vi.fn() }));
vi.mock('../src/agent/evaluator', () => ({ evaluateQuality: vi.fn() }));
vi.mock('../src/mcp/tool-adapter', () => ({
  loadAgentTools: vi.fn().mockResolvedValue({}),
  resolveTools: vi.fn().mockResolvedValue({}),
  executeToolCall: vi.fn(async (toolId: string, args: any) => ({
    result: `tool-${toolId}: ${JSON.stringify(args._map_item || args)}`,
  })),
}));
vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test', name: 'Test', model: 'gpt-4', provider: 'openai',
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
  withSpan: (_t: any, _n: string, fn: (s: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/runner/graph-runner.js';
import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

const createState = (memory: Record<string, unknown> = {}): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Map-reduce test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory,
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const createMapGraph = (config: any = {}): Graph => ({
  id: 'map-graph',
  name: 'Map-Reduce Test',
  description: 'Test map-reduce',
  version: '1.0.0',
  nodes: [
    {
      id: 'mapper',
      type: 'map',
      map_reduce_config: {
        worker_node_id: 'worker',
        max_concurrency: 3,
        error_strategy: 'best_effort',
        ...config,
      },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'worker',
      type: 'agent',
      agent_id: 'worker-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'synth',
      type: 'synthesizer',
      agent_id: 'synthesizer-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'mapper', target: 'synth', condition: { type: 'always' } },
  ],
  start_node: 'mapper',
  end_nodes: ['synth'],
  created_at: new Date(),
  updated_at: new Date(),
});

// ─── Tests ────────────────────────────────────────────────────────

describe('Map-Reduce', () => {
  test('should fan out static items to parallel workers', async () => {
    const graph = createMapGraph({ static_items: ['a', 'b', 'c'] });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.mapper_results).toBeDefined();
    expect((finalState.memory.mapper_results as any[]).length).toBe(3);
    expect(finalState.memory.mapper_count).toBe(3);
  });

  test('should resolve items from JSONPath', async () => {
    const graph = createMapGraph({ items_path: '$.memory.items' });
    const state = createState({ items: ['x', 'y'] });

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.mapper_count).toBe(2);
  });

  test('should inject _map_item, _map_index, _map_total into worker stateView', async () => {
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');

    // Track all calls to capture stateViews
    const capturedViews: any[] = [];
    (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number, _opts?: any) => {
      if (stateView.memory._map_item !== undefined) {
        capturedViews.push(stateView);
      }
      const item = stateView.memory._map_item;
      return {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { [`${agentId}_result`]: `processed: ${JSON.stringify(item)}` } },
        metadata: {
          node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
          token_usage: { totalTokens: 30 },
        },
      };
    });

    const graph = createMapGraph({ static_items: ['alpha', 'beta'] });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await runner.run();

    // Worker should be called for each item
    expect(capturedViews.length).toBe(2);

    // Check stateView for first call
    const sv0 = capturedViews[0];
    expect(sv0.memory._map_item).toBe('alpha');
    expect(sv0.memory._map_index).toBe(0);
    expect(sv0.memory._map_total).toBe(2);
  });

  test('should handle empty items list', async () => {
    const graph = createMapGraph({ static_items: [] });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.mapper_results).toEqual([]);
    expect(finalState.memory.mapper_count).toBe(0);
  });

  test('should collect errors in best_effort mode', async () => {
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
    (executeAgent as any).mockImplementation(async (agentId: string, sv: any, _t: any, attempt: number, _opts?: any) => {
      if (sv.memory._map_index === 1) throw new Error('Worker failed');
      return {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { result: 'ok' } },
        metadata: { node_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 10 } },
      };
    });

    const graph = createMapGraph({ static_items: ['a', 'b', 'c'], error_strategy: 'best_effort' });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.memory.mapper_count).toBe(2); // 2 succeeded
    expect(finalState.memory.mapper_error_count).toBe(1);
    expect((finalState.memory.mapper_errors as any[]).length).toBe(1);

    // Reset mock to original behavior
    (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number, _opts?: any) => {
      const item = stateView.memory._map_item;
      return {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { [`${agentId}_result`]: `processed: ${JSON.stringify(item)}` } },
        metadata: {
          node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
          token_usage: { totalTokens: 30 },
        },
      };
    });
  });

  test('should error when neither static_items nor items_path provided', async () => {
    const graph = createMapGraph({}); // No items source
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await expect(runner.run()).rejects.toThrow('static_items or items_path');
  });

  test('should error when worker node not found', async () => {
    const graph = createMapGraph({ static_items: ['a'], worker_node_id: 'nonexistent' });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await expect(runner.run()).rejects.toThrow('worker node');
  });

  test('synthesizer node should merge results', async () => {
    const graph = createMapGraph({ static_items: ['a', 'b'] });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // Synthesizer runs after mapper
    expect(finalState.status).toBe('completed');
    // Memory should contain both mapper results and synthesizer output
    expect(finalState.memory.mapper_results).toBeDefined();
  });

  test('synthesizer without agent_id should do simple merge', async () => {
    const graph: Graph = {
      ...createMapGraph({ static_items: ['a'] }),
      nodes: [
        createMapGraph({ static_items: ['a'] }).nodes[0],
        createMapGraph({ static_items: ['a'] }).nodes[1],
        {
          id: 'synth',
          type: 'synthesizer',
          // No agent_id → simple merge
          read_keys: ['*'],
          write_keys: ['*'],
          failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
          requires_compensation: false,
        },
      ],
    };

    const state = createState();
    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.memory.synth_synthesis).toBeDefined();
  });

  test('should track total tokens from parallel workers', async () => {
    // Ensure the mock returns token_usage
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
    (executeAgent as any).mockImplementation(async (agentId: string, stateView: any, _t: any, attempt: number, _opts?: any) => {
      const item = stateView.memory._map_item;
      return {
        id: uuidv4(),
        idempotency_key: uuidv4(),
        type: 'update_memory',
        payload: { updates: { [`${agentId}_result`]: `processed: ${JSON.stringify(item)}` } },
        metadata: {
          node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
          token_usage: { totalTokens: 30 },
        },
      };
    });

    const graph = createMapGraph({ static_items: ['a', 'b', 'c'] });
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // 3 workers × 30 tokens = 90 from merge_parallel_results, plus synthesizer tokens
    expect(finalState.total_tokens_used).toBeGreaterThanOrEqual(90);
  });
});
