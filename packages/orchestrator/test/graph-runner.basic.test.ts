import { describe, test, expect, vi, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { GraphRunner } from '../src/runner/graph-runner';

// ─── Mocks (must come before importing GraphRunner) ─────────────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
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

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/mcp/tool-adapter', () => ({
  loadAgentTools: vi.fn().mockResolvedValue({}),
  resolveTools: vi.fn().mockResolvedValue({}),
  executeToolCall: vi.fn(async (toolName: string) => ({ result: `Mock tool output from ${toolName}` })),
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

import type { Graph } from '../src/types/graph';
import type { WorkflowState } from '../src/types/state';

// ─── Deferred import to avoid top-level await crashing the worker ────────
// eslint-disable-next-line prefer-const
// let GraphRunner: Awaited<typeof import('../src/runner/graph-runner')>['GraphRunner'];

// beforeAll(async () => {
//   ({ GraphRunner } = await import('../src/runner/graph-runner'));
// });

// ─── Shared helpers ─────────────────────────────────────────────────────

const createInitialState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Test workflow',
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
  supervisor_history: [],
  total_tokens_used: 0,
});

const createLinearGraph = (): Graph => ({
  id: uuidv4(),
  name: 'Linear Test Graph',
  description: 'Simple linear graph for testing',
  version: '1.0.0',
  nodes: [
    {
      id: 'start', type: 'agent', agent_id: 'agent-1',
      read_keys: ['*'], write_keys: ['*'],
      failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 100, max_backoff_ms: 1000 },
      requires_compensation: false,
    },
    {
      id: 'end', type: 'agent', agent_id: 'agent-2',
      read_keys: ['result'], write_keys: ['*'],
      failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 100, max_backoff_ms: 1000 },
      requires_compensation: false,
    },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } }],
  start_node: 'start',
  end_nodes: ['end'],
  created_at: new Date(),
  updated_at: new Date(),
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('GraphRunner — Basic Execution', () => {
  test('should execute a simple linear graph', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.visited_nodes).toContain('start');
    expect(finalState.visited_nodes).toContain('end');
    expect(finalState.iteration_count).toBeGreaterThan(0);
  });

  test('should start with pending status', async () => {
    const initialState = createInitialState();
    expect(initialState.status).toBe('pending');
    const runner = new GraphRunner(createLinearGraph(), initialState);
    await runner.run();
  });

  test('should track visited nodes', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const finalState = await runner.run();

    expect(finalState.visited_nodes.length).toBeGreaterThan(0);
    expect(finalState.visited_nodes[0]).toBe('start');
  });
});

describe('GraphRunner — Event Emission', () => {
  test('should emit workflow:start event', async () => {
    const initialState = createInitialState();
    const runner = new GraphRunner(createLinearGraph(), initialState);

    const startSpy = vi.fn();
    runner.on('workflow:start', startSpy);
    await runner.run();

    expect(startSpy).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledWith({
      workflow_id: initialState.workflow_id,
      run_id: initialState.run_id,
    });
  });

  test('should emit workflow:complete event', async () => {
    const initialState = createInitialState();
    const runner = new GraphRunner(createLinearGraph(), initialState);

    const completeSpy = vi.fn();
    runner.on('workflow:complete', completeSpy);
    await runner.run();

    expect(completeSpy).toHaveBeenCalledOnce();
    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: initialState.workflow_id,
        run_id: initialState.run_id,
        duration_ms: expect.any(Number),
      })
    );
  });

  test('should emit node:start events', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const nodeStartSpy = vi.fn();
    runner.on('node:start', nodeStartSpy);
    await runner.run();

    expect(nodeStartSpy).toHaveBeenCalled();
    expect(nodeStartSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: expect.any(String), type: expect.any(String), timestamp: expect.any(Number) })
    );
  });

  test('should emit node:complete events', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const nodeCompleteSpy = vi.fn();
    runner.on('node:complete', nodeCompleteSpy);
    await runner.run();

    expect(nodeCompleteSpy).toHaveBeenCalled();
    expect(nodeCompleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: expect.any(String), type: expect.any(String), duration_ms: expect.any(Number) })
    );
  });

  test('should emit action:applied events', async () => {
    const runner = new GraphRunner(createLinearGraph(), createInitialState());
    const actionSpy = vi.fn();
    runner.on('action:applied', actionSpy);
    await runner.run();

    expect(actionSpy).toHaveBeenCalled();
    expect(actionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action_id: expect.any(String), type: expect.any(String), node_id: expect.any(String) })
    );
  });
});

describe('GraphRunner — State Persistence', () => {
  test('should call persistState function', async () => {
    const initialState = createInitialState();
    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(createLinearGraph(), initialState, persistSpy);
    await runner.run();

    expect(persistSpy).toHaveBeenCalled();
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflow_id: initialState.workflow_id, run_id: initialState.run_id })
    );
  });

  test('should emit state:persisted events', async () => {
    const initialState = createInitialState();
    const runner = new GraphRunner(createLinearGraph(), initialState, vi.fn().mockResolvedValue(undefined));
    const persistedSpy = vi.fn();
    runner.on('state:persisted', persistedSpy);
    await runner.run();

    expect(persistedSpy).toHaveBeenCalled();
    expect(persistedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: initialState.run_id, iteration: expect.any(Number) })
    );
  });
});
