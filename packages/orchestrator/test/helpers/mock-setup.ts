/**
 * Shared Test Setup — canonical mock configurations for orchestrator tests.
 *
 * Usage:
 *   import { setupCoreMocks, setupAgentMocks, createTestState, createSimpleGraph } from './helpers/mock-setup';
 *   setupCoreMocks();
 *   setupAgentMocks();
 *
 * Must be called before any dynamic imports that resolve the mocked modules.
 */

import { vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { Graph } from '../../src/types/graph.js';
import type { WorkflowState } from '../../src/types/state.js';

// ─── Core Mocks ──────────────────────────────────────────────────────

/**
 * Set up canonical mocks for core infrastructure:
 * `@ai-sdk/openai`, `@ai-sdk/anthropic`, `ai`, `@opentelemetry/api`,
 * logger, and tracing.
 */
export function setupCoreMocks() {
  vi.mock('@ai-sdk/openai', () => ({
    openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
  }));

  vi.mock('@ai-sdk/anthropic', () => ({
    anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
  }));

  vi.mock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
      ...actual,
      generateText: vi.fn(),
      streamText: vi.fn(),
    };
  });

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

  vi.mock('../../src/utils/logger.js', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }));

  vi.mock('../../src/utils/tracing.js', () => ({
    getTracer: () => ({}),
    withSpan: (_tracer: any, _name: string, fn: (span: any) => any) =>
      fn({ setAttribute: vi.fn() }),
  }));
}

// ─── Agent Mocks ─────────────────────────────────────────────────────

/**
 * Set up canonical mocks for agent runtime modules:
 * agent-executor, supervisor-executor, tool-adapter, agent-factory.
 *
 * Returns mock references for customization.
 */
export function setupAgentMocks() {
  const mockExecuteAgent = vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt, token_usage: { totalTokens: 25 } },
  }));

  vi.mock('../../src/agent/agent-executor/executor.js', () => ({
    executeAgent: (...args: any[]) => mockExecuteAgent(...args),
  }));

  vi.mock('../../src/agent/supervisor-executor/executor.js', () => ({
    executeSupervisor: vi.fn(),
  }));

  vi.mock('../../src/agent/evaluator-executor/executor.js', () => ({
    evaluateQualityExecutor: vi.fn(),
  }));

  // tool-adapter.ts has been removed — tool resolution now goes through MCPConnectionManager

  vi.mock('../../src/agent/agent-factory', () => ({
    agentFactory: {
      loadAgent: vi.fn().mockResolvedValue({
        id: 'test-agent', name: 'Test', model: 'claude-sonnet-4-20250514', provider: 'anthropic',
        system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
        read_keys: ['*'], write_keys: ['*'],
      }),
      getModel: vi.fn().mockReturnValue({}),
    },
  }));

  return { mockExecuteAgent };
}

// ─── Test Factories ──────────────────────────────────────────────────

/**
 * Create a test WorkflowState with sensible defaults.
 */
export function createTestState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
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
    ...overrides,
  };
}

/**
 * Create a simple single-node agent graph for testing.
 */
export function createSimpleGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    id: uuidv4(),
    name: 'Test Graph',
    description: 'Simple test graph',
    version: '1.0.0',
    nodes: [{
      id: 'agent-node',
      type: 'agent',
      agent_id: 'test-agent',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    }],
    edges: [],
    start_node: 'agent-node',
    end_nodes: ['agent-node'],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}
