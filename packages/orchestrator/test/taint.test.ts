/**
 * taint.test.ts
 *
 * Tests for the taint tracking system:
 * - Taint utility functions (mark, check, get, propagate)
 * - MCP tool adapter tainting external results
 * - Tool node propagation through GraphRunner
 * - Supervisor prompt taint warnings
 * - Agent executor derived taint propagation
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ──────────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn().mockReturnValue(() => false),
  tool: vi.fn((def: any) => def),
  jsonSchema: vi.fn((schema: any) => schema),
  Output: { object: vi.fn().mockReturnValue({}) },
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

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

// Mock gateway-client for tool adapter tests (vi.importActual below will use this)
const mockExecuteTool = vi.fn();
vi.mock('../src/mcp/gateway-client', () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
    executeTool: (...args: any[]) => mockExecuteTool(...args),
  },
  MCPGatewayClient: vi.fn(),
  createMCPClient: vi.fn(),
}));

vi.mock('../src/architect/tools', () => ({
  architectToolDefinitions: {},
  executeArchitectTool: vi.fn().mockResolvedValue({ drafted: true }),
}));

// Mock agent-executor and supervisor for GraphRunner tests
vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _sv: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: `${agentId}:${attempt}`,
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'done' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

// Mock the full tool-adapter for GraphRunner tests (returns TaintedToolResult for MCP tools)
vi.mock('../src/mcp/tool-adapter', () => ({
  loadAgentTools: vi.fn().mockResolvedValue({}),
  executeToolCall: vi.fn(async (toolName: string, _args: any, agentId?: string) => {
    if (toolName !== 'save_to_memory' && !toolName.startsWith('architect_')) {
      return {
        result: { data: `${toolName} output` },
        taint: {
          source: 'mcp_tool' as const,
          tool_name: toolName,
          agent_id: agentId,
          created_at: new Date().toISOString(),
        },
      };
    }
    return { result: 'plain' };
  }),
}));

// Supervisor-executor is NOT mocked — we test the real buildSupervisorPrompt logic
// (it uses the mocked 'ai' generateObject above)

vi.mock('../src/agent/agent-factory/index', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-sonnet-4-20250514', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/runner/helpers', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

// ─── Imports ────────────────────────────────────────────────────────────

import {
  markTainted,
  isTainted,
  getTaintRegistry,
  getTaintInfo,
  propagateDerivedTaint,
} from '../src/utils/taint.js';
import type { TaintMetadata, TaintRegistry } from '../src/types/state.js';
import { GraphRunner } from '../src/runner/graph-runner.js';
import { executeSupervisor } from '../src/agent/supervisor-executor/executor.js';
import { generateText } from 'ai';
import type { Graph, GraphNode } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Test Helpers ───────────────────────────────────────────────────────

const makeNode = (overrides: Partial<GraphNode> & { id: string; type: GraphNode['type'] }): GraphNode => ({
  read_keys: ['*'],
  write_keys: ['*'],
  failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
  requires_compensation: false,
  ...overrides,
});

const createState = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Taint test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 30000,
  supervisor_history: [],
  total_tokens_used: 0,
  ...overrides,
});

// ─── Utility Tests ──────────────────────────────────────────────────────

describe('Taint Utilities', () => {
  test('markTainted stores metadata in _taint_registry', () => {
    const memory: Record<string, unknown> = { search_result: 'hello' };

    markTainted(memory, 'search_result', {
      source: 'mcp_tool',
      tool_name: 'web_search',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const registry = memory['_taint_registry'] as TaintRegistry;
    expect(registry).toBeDefined();
    expect(registry['search_result']).toEqual({
      source: 'mcp_tool',
      tool_name: 'web_search',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  test('isTainted returns true for tainted keys, false for clean ones', () => {
    const memory: Record<string, unknown> = {
      clean: 'safe data',
      dirty: 'external data',
      _taint_registry: {
        dirty: { source: 'mcp_tool', tool_name: 'web_search', created_at: '2024-01-01T00:00:00.000Z' },
      },
    };

    expect(isTainted(memory, 'dirty')).toBe(true);
    expect(isTainted(memory, 'clean')).toBe(false);
    expect(isTainted(memory, 'nonexistent')).toBe(false);
  });

  test('getTaintRegistry returns empty object when no registry exists', () => {
    const memory: Record<string, unknown> = { foo: 'bar' };
    expect(getTaintRegistry(memory)).toEqual({});
  });

  test('getTaintRegistry returns existing registry', () => {
    const registry: TaintRegistry = {
      key1: { source: 'mcp_tool', tool_name: 'web_search', created_at: '2024-01-01T00:00:00.000Z' },
    };
    const memory: Record<string, unknown> = { _taint_registry: registry };

    expect(getTaintRegistry(memory)).toEqual(registry);
  });

  test('getTaintInfo returns metadata for tainted key', () => {
    const meta: TaintMetadata = {
      source: 'mcp_tool',
      tool_name: 'browser',
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const memory: Record<string, unknown> = {
      _taint_registry: { page_content: meta },
    };

    expect(getTaintInfo(memory, 'page_content')).toEqual(meta);
    expect(getTaintInfo(memory, 'clean_key')).toBeUndefined();
  });

  test('propagateDerivedTaint marks outputs when inputs are tainted', () => {
    const memory: Record<string, unknown> = {
      search_result: 'external data',
      _taint_registry: {
        search_result: { source: 'mcp_tool', tool_name: 'web_search', created_at: '2024-01-01T00:00:00.000Z' },
      },
    };

    const result = propagateDerivedTaint(memory, ['summary', 'analysis'], 'researcher');

    expect(result['summary']).toEqual(
      expect.objectContaining({ source: 'derived', agent_id: 'researcher' }),
    );
    expect(result['analysis']).toEqual(
      expect.objectContaining({ source: 'derived', agent_id: 'researcher' }),
    );
  });

  test('propagateDerivedTaint returns empty when no inputs are tainted', () => {
    const memory: Record<string, unknown> = {
      clean_data: 'safe',
    };

    const result = propagateDerivedTaint(memory, ['output'], 'agent-1');
    expect(result).toEqual({});
  });

  test('propagateDerivedTaint does not taint _taint_registry itself', () => {
    const memory: Record<string, unknown> = {
      dirty: 'external',
      _taint_registry: {
        dirty: { source: 'mcp_tool', tool_name: 'x', created_at: '2024-01-01T00:00:00.000Z' },
      },
    };

    const result = propagateDerivedTaint(memory, ['_taint_registry', 'output'], 'agent-1');
    expect(result['_taint_registry']).toBeUndefined();
    expect(result['output']).toBeDefined();
  });
});

// ─── Tool Adapter Taint Tests ───────────────────────────────────────────
// Use vi.importActual to get the REAL tool-adapter (since the module is mocked
// for GraphRunner tests above). The real tool-adapter's dependencies (gateway-client,
// architect-tools) are still mocked, which is what we want.

describe('Tool Adapter — Taint Marking', () => {
  let realExecuteToolCall: typeof import('../src/mcp/tool-adapter')['executeToolCall'];

  beforeEach(async () => {
    mockExecuteTool.mockReset();
    const actual = await vi.importActual<typeof import('../src/mcp/tool-adapter')>('../src/mcp/tool-adapter');
    realExecuteToolCall = actual.executeToolCall;
  });

  test('MCP tool calls return TaintedToolResult', async () => {
    mockExecuteTool.mockResolvedValue({ data: 'search results' });

    const result = await realExecuteToolCall('web_search', { query: 'test' }, 'agent-1');

    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('taint');

    const tainted = result as any;
    expect(tainted.result).toEqual({ data: 'search results' });
    expect(tainted.taint.source).toBe('mcp_tool');
    expect(tainted.taint.tool_name).toBe('web_search');
    expect(tainted.taint.agent_id).toBe('agent-1');
    expect(tainted.taint.created_at).toBeDefined();
  });

  test('save_to_memory does NOT return tainted result', async () => {
    const result = await realExecuteToolCall('save_to_memory', { key: 'foo', value: 'bar' });

    expect(result).toEqual({ key: 'foo', value: 'bar', saved: true });
    expect(result).not.toHaveProperty('taint');
  });

  test('architect tools do NOT return tainted result', async () => {
    const result = await realExecuteToolCall('architect_draft_workflow', { prompt: 'test' });

    expect(result).toEqual({ drafted: true });
    expect(result).not.toHaveProperty('taint');
  });
});

// ─── GraphRunner Tool Node Taint Propagation ────────────────────────────

describe('GraphRunner — Tool Node Taint Propagation', () => {
  test('tool node stores taint registry in memory after MCP execution', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Taint Tool', description: '', version: '1.0.0',
      created_at: new Date(), updated_at: new Date(),
      nodes: [
        makeNode({ id: 'search-tool', type: 'tool', tool_id: 'web_search', agent_id: 'agent-1' }),
      ],
      edges: [],
      start_node: 'search-tool',
      end_nodes: ['search-tool'],
    };

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(graph, createState(), persistSpy);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.memory['search-tool_result']).toEqual({ data: 'web_search output' });

    const registry = final.memory['_taint_registry'] as TaintRegistry;
    expect(registry).toBeDefined();
    expect(registry['search-tool_result']).toEqual(
      expect.objectContaining({
        source: 'mcp_tool',
        tool_name: 'web_search',
      }),
    );
  });
});

// ─── Supervisor Prompt Taint Warning ────────────────────────────────────

describe('Supervisor — Taint Warnings', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
  });

  test('supervisor prompt includes taint warning when memory has tainted keys', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: '__done__', reasoning: 'all done' },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const stateView = {
      workflow_id: uuidv4(),
      run_id: uuidv4(),
      goal: 'Test taint warning',
      constraints: [],
      memory: {
        search_result: 'some external data',
        _taint_registry: {
          search_result: {
            source: 'mcp_tool',
            tool_name: 'web_search',
            created_at: '2024-01-01T00:00:00.000Z',
          },
        },
      },
    };

    const node = makeNode({
      id: 'supervisor-1',
      type: 'supervisor',
      supervisor_config: {
        agent_id: 'router-agent',
        managed_nodes: ['worker-1', 'worker-2'],
        max_iterations: 10,
      },
    });

    await executeSupervisor(node, stateView, [], 1);

    expect(vi.mocked(generateText)).toHaveBeenCalledOnce();
    const systemPrompt = vi.mocked(generateText).mock.calls[0][0].system as string;
    expect(systemPrompt).toContain('[TAINTED]');
    expect(systemPrompt).toContain('search_result');
  });

  test('supervisor prompt has no taint warning when memory is clean', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: '__done__', reasoning: 'all done' },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const stateView = {
      workflow_id: uuidv4(),
      run_id: uuidv4(),
      goal: 'Test clean memory',
      constraints: [],
      memory: {
        clean_data: 'safe internal data',
      },
    };

    const node = makeNode({
      id: 'supervisor-2',
      type: 'supervisor',
      supervisor_config: {
        agent_id: 'router-agent',
        managed_nodes: ['worker-1'],
        max_iterations: 10,
      },
    });

    await executeSupervisor(node, stateView, [], 1);

    const systemPrompt = vi.mocked(generateText).mock.calls[0][0].system as string;
    expect(systemPrompt).not.toContain('[TAINTED]');
  });
});
