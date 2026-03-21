/**
 * Observer Middleware Tests
 *
 * Tests the deterministic health checks: token burn, iteration budget,
 * and stall detection.
 */

import { describe, test, expect, vi } from 'vitest';
import { createObserverMiddleware, type ObserverFinding } from '../src/runner/observer-middleware.js';
import type { Action, WorkflowState } from '../src/types/state.js';
import type { MiddlewareContext } from '../src/runner/middleware.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<Action> & { metadata?: Partial<Action['metadata']> }): Action {
  return {
    id: crypto.randomUUID(),
    type: 'update_memory',
    payload: { updates: {} },
    idempotency_key: `idem-${Date.now()}`,
    metadata: {
      node_id: 'test-node',
      timestamp: new Date(),
      attempt: 1,
      ...overrides.metadata,
    },
    ...overrides,
    // Re-apply metadata after spread to merge properly
    metadata: {
      node_id: 'test-node',
      timestamp: new Date(),
      attempt: 1,
      ...overrides.metadata,
    },
  } as Action;
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: crypto.randomUUID(),
    run_id: crypto.randomUUID(),
    goal: 'test',
    status: 'running',
    current_node: 'test-node',
    visited_nodes: [],
    iteration_count: 0,
    max_iterations: 50,
    total_tokens_used: 0,
    memory: {},
    constraints: [],
    compensation_stack: [],
    supervisor_history: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as WorkflowState;
}

function makeCtx(): MiddlewareContext {
  return {
    node: { id: 'test-node', type: 'agent', read_keys: ['*'], write_keys: ['*'], requires_compensation: false },
    state: makeState(),
    graph: { id: crypto.randomUUID(), name: 'test', description: '', nodes: [], edges: [], start_node: 'test', end_nodes: [] },
    iteration: 0,
  };
}

// ─── Token Burn ─────────────────────────────────────────────────────────

describe('token burn detection', () => {
  test('fires when agent uses >threshold tokens with no memory updates', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      tokenBurnThreshold: 5_000,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({
      type: 'update_memory',
      payload: { updates: { _taint_registry: {} } }, // Only internal keys
      metadata: {
        node_id: 'discovery',
        agent_id: 'agent-1',
        timestamp: new Date(),
        token_usage: { totalTokens: 8_000 },
      },
    });

    await mw.afterReduce!(makeCtx(), action, makeState());

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].category).toBe('token_burn');
    expect(findings[0].context.node_id).toBe('discovery');
    expect(findings[0].context.total_tokens).toBe(8_000);
  });

  test('does not fire when agent saves meaningful memory updates', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      tokenBurnThreshold: 5_000,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({
      type: 'update_memory',
      payload: { updates: { frameworks: [{ name: 'LangGraph' }] } },
      metadata: {
        node_id: 'discovery',
        timestamp: new Date(),
        token_usage: { totalTokens: 8_000 },
      },
    });

    await mw.afterReduce!(makeCtx(), action, makeState());

    expect(findings).toHaveLength(0);
  });

  test('does not fire when tokens are below threshold', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      tokenBurnThreshold: 10_000,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({
      type: 'update_memory',
      payload: { updates: {} },
      metadata: {
        node_id: 'discovery',
        timestamp: new Date(),
        token_usage: { totalTokens: 3_000 },
      },
    });

    await mw.afterReduce!(makeCtx(), action, makeState());

    expect(findings).toHaveLength(0);
  });

  test('ignores non-update_memory actions', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      tokenBurnThreshold: 1,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({
      type: 'handoff',
      payload: { target_node: 'next' },
      metadata: {
        node_id: 'supervisor',
        timestamp: new Date(),
        token_usage: { totalTokens: 50_000 },
      },
    });

    await mw.afterReduce!(makeCtx(), action, makeState());

    expect(findings).toHaveLength(0);
  });
});

// ─── Iteration Budget ───────────────────────────────────────────────────

describe('iteration budget detection', () => {
  test('fires warning at 70% and critical at 90%', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      iterationWarnRatio: 0.7,
      iterationAlertRatio: 0.9,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({});

    // At 70% — warning
    await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 35, max_iterations: 50 }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].category).toBe('iteration_budget');

    // At 80% — no new finding (warning already fired)
    await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 40, max_iterations: 50 }));
    expect(findings).toHaveLength(1);

    // At 90% — critical
    await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 45, max_iterations: 50 }));
    expect(findings).toHaveLength(2);
    expect(findings[1].severity).toBe('critical');
    expect(findings[1].category).toBe('iteration_budget');
  });

  test('does not fire below threshold', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({ onFinding: (f) => findings.push(f) });

    const action = makeAction({});
    await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 5, max_iterations: 50 }));

    expect(findings).toHaveLength(0);
  });

  test('handles zero or undefined max_iterations', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({ onFinding: (f) => findings.push(f) });

    const action = makeAction({});
    await mw.afterReduce!(makeCtx(), action, makeState({ iteration_count: 100, max_iterations: 0 }));

    expect(findings).toHaveLength(0);
  });
});

// ─── Stall Detection ────────────────────────────────────────────────────

describe('stall detection', () => {
  test('fires when supervisor delegates to same node N times consecutively', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      stallThreshold: 3,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({});
    const state = makeState({
      supervisor_history: [
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'first', iteration: 1, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'retry', iteration: 2, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'retry again', iteration: 3, timestamp: new Date() },
      ],
    });

    await mw.afterReduce!(makeCtx(), action, state);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].category).toBe('stall_detected');
    expect(findings[0].context.delegated_to).toBe('discovery');
    expect(findings[0].context.consecutive_count).toBe(3);
  });

  test('does not fire with mixed delegations', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      stallThreshold: 3,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({});
    const state = makeState({
      supervisor_history: [
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'a', iteration: 1, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'mapper', reasoning: 'b', iteration: 2, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'c', iteration: 3, timestamp: new Date() },
      ],
    });

    await mw.afterReduce!(makeCtx(), action, state);

    expect(findings).toHaveLength(0);
  });

  test('does not fire when history is shorter than threshold', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      stallThreshold: 3,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({});
    const state = makeState({
      supervisor_history: [
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'first', iteration: 1, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'retry', iteration: 2, timestamp: new Date() },
      ],
    });

    await mw.afterReduce!(makeCtx(), action, state);

    expect(findings).toHaveLength(0);
  });

  test('only checks the tail of history', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      stallThreshold: 3,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({});
    const state = makeState({
      supervisor_history: [
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'a', iteration: 1, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'b', iteration: 2, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'c', iteration: 3, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'mapper', reasoning: 'd', iteration: 4, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'synthesizer', reasoning: 'e', iteration: 5, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'evaluator', reasoning: 'f', iteration: 6, timestamp: new Date() },
      ],
    });

    // Tail is mapper → synthesizer → evaluator — no stall
    await mw.afterReduce!(makeCtx(), action, state);

    expect(findings).toHaveLength(0);
  });
});

// ─── Integration ────────────────────────────────────────────────────────

describe('combined checks', () => {
  test('multiple findings from a single afterReduce call', async () => {
    const findings: ObserverFinding[] = [];
    const mw = createObserverMiddleware({
      tokenBurnThreshold: 5_000,
      iterationWarnRatio: 0.7,
      stallThreshold: 2,
      onFinding: (f) => findings.push(f),
    });

    const action = makeAction({
      type: 'update_memory',
      payload: { updates: {} },
      metadata: {
        node_id: 'discovery',
        timestamp: new Date(),
        token_usage: { totalTokens: 20_000 },
      },
    });

    const state = makeState({
      iteration_count: 40,
      max_iterations: 50,
      supervisor_history: [
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'a', iteration: 1, timestamp: new Date() },
        { supervisor_id: 'sup', delegated_to: 'discovery', reasoning: 'b', iteration: 2, timestamp: new Date() },
      ],
    });

    await mw.afterReduce!(makeCtx(), action, state);

    expect(findings).toHaveLength(3);
    expect(findings.map(f => f.category).sort()).toEqual([
      'iteration_budget',
      'stall_detected',
      'token_burn',
    ]);
  });

  test('default options produce a working middleware', () => {
    const mw = createObserverMiddleware();
    expect(mw.afterReduce).toBeDefined();
    expect(mw.beforeNodeExecute).toBeUndefined();
    expect(mw.afterNodeExecute).toBeUndefined();
    expect(mw.beforeAdvance).toBeUndefined();
  });
});
