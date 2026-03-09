import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { executeParallel, type ParallelTask } from '../src/runner/parallel-executor.js';
import type { Action } from '../src/types/state.js';

const makeTask = (nodeId: string): ParallelTask => ({
  node: {
    id: nodeId,
    type: 'agent',
    agent_id: `agent-${nodeId}`,
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
    requires_compensation: false,
  },
  stateView: {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    goal: 'test',
    constraints: [],
    memory: {},
  },
});

const makeAction = (nodeId: string): Action => ({
  id: uuidv4(),
  idempotency_key: uuidv4(),
  type: 'update_memory',
  payload: { updates: { [`${nodeId}_result`]: 'done' } },
  metadata: {
    node_id: nodeId,
    timestamp: new Date(),
    attempt: 1,
    token_usage: { totalTokens: 100 },
  } as any,
});

describe('Parallel Executor', () => {
  test('should execute all tasks and collect results', async () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const executeFn = vi.fn(async (task: ParallelTask) => makeAction(task.node.id));

    const results = await executeParallel(tasks, executeFn, {
      max_concurrency: 10,
      error_strategy: 'best_effort',
    });

    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(3);
  });

  test('should respect max_concurrency batching', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => makeTask(`t${i}`));
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const executeFn = vi.fn(async (task: ParallelTask) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(r => setTimeout(r, 10));
      currentConcurrent--;
      return makeAction(task.node.id);
    });

    await executeParallel(tasks, executeFn, {
      max_concurrency: 2,
      error_strategy: 'best_effort',
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test('should collect errors in best_effort mode', async () => {
    const tasks = [makeTask('good'), makeTask('bad'), makeTask('good2')];
    const executeFn = vi.fn(async (task: ParallelTask) => {
      if (task.node.id === 'bad') throw new Error('Task failed');
      return makeAction(task.node.id);
    });

    const results = await executeParallel(tasks, executeFn, {
      max_concurrency: 10,
      error_strategy: 'best_effort',
    });

    expect(results).toHaveLength(3);
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);
    expect(successes).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe('Task failed');
  });

  test('should throw on first failure in fail_fast mode', async () => {
    const tasks = [makeTask('a'), makeTask('fail'), makeTask('c')];
    const executeFn = vi.fn(async (task: ParallelTask) => {
      if (task.node.id === 'fail') throw new Error('Fast fail');
      return makeAction(task.node.id);
    });

    await expect(
      executeParallel(tasks, executeFn, {
        max_concurrency: 10,
        error_strategy: 'fail_fast',
      })
    ).rejects.toThrow('Fast fail');
  });

  test('should track token usage per result', async () => {
    const tasks = [makeTask('a')];
    const executeFn = vi.fn(async () => makeAction('a'));

    const results = await executeParallel(tasks, executeFn, {
      max_concurrency: 1,
      error_strategy: 'best_effort',
    });

    expect(results[0].tokens_used).toBe(100);
  });

  test('should handle empty task list', async () => {
    const executeFn = vi.fn();
    const results = await executeParallel([], executeFn, {
      max_concurrency: 5,
      error_strategy: 'best_effort',
    });

    expect(results).toHaveLength(0);
    expect(executeFn).not.toHaveBeenCalled();
  });

  test('should assign correct task_index to results', async () => {
    const tasks = [makeTask('x'), makeTask('y'), makeTask('z')];
    const executeFn = vi.fn(async (task: ParallelTask) => makeAction(task.node.id));

    const results = await executeParallel(tasks, executeFn, {
      max_concurrency: 10,
      error_strategy: 'best_effort',
    });

    expect(results.map(r => r.task_index).sort()).toEqual([0, 1, 2]);
    expect(results.map(r => r.node_id).sort()).toEqual(['x', 'y', 'z']);
  });

  test('should carry per-item stateView correctly', async () => {
    const task: ParallelTask = {
      ...makeTask('worker'),
      input_item: { text: 'hello' },
      item_index: 0,
    };

    const executeFn = vi.fn(async (t: ParallelTask) => {
      expect(t.input_item).toEqual({ text: 'hello' });
      expect(t.item_index).toBe(0);
      return makeAction(t.node.id);
    });

    await executeParallel([task], executeFn, {
      max_concurrency: 1,
      error_strategy: 'best_effort',
    });

    expect(executeFn).toHaveBeenCalledTimes(1);
  });
});
