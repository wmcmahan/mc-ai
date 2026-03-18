/**
 * Parallel Executor
 *
 * Executes multiple graph node tasks concurrently with configurable
 * concurrency limits and error handling strategies.
 *
 * Uses `AbortController` for timeout-based cancellation so that
 * timed-out tasks are properly aborted rather than left running
 * in the background consuming resources.
 *
 * @module runner/parallel-executor
 */

import type { GraphNode } from '../types/graph.js';
import type { StateView, Action } from '../types/state.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.parallel');

/** A single unit of work for parallel execution. */
export interface ParallelTask {
  /** The node to execute. */
  node: GraphNode;
  /** Pre-built state view for this task. */
  stateView: StateView;
  /** Optional input item (used by map-reduce fan-out). */
  input_item?: unknown;
  /** Optional index of the input item. */
  item_index?: number;
}

/** Result of a single parallel task execution. */
export interface ParallelResult {
  /** Index of this task in the original task array. */
  task_index: number;
  /** ID of the node that was executed. */
  node_id: string;
  /** The action produced (undefined on failure). */
  action?: Action;
  /** Whether the task succeeded. */
  success: boolean;
  /** Error message on failure. */
  error?: string;
  /** Tokens consumed by this task. */
  tokens_used?: number;
}

/** Configuration for parallel execution. */
export interface ParallelExecutionConfig {
  /** Maximum number of concurrent tasks per batch. */
  max_concurrency: number;
  /** How to handle task failures. */
  error_strategy: 'fail_fast' | 'best_effort';
  /** Per-task timeout in milliseconds. If a task exceeds this, it is aborted. */
  task_timeout_ms?: number;
}

/**
 * Execute tasks in parallel with concurrency control.
 *
 * Tasks are chunked into batches of `max_concurrency`. Within each
 * batch, all tasks run concurrently. Under `fail_fast`, the first
 * failure aborts the batch. Under `best_effort`, all results
 * (including failures) are collected.
 *
 * When `task_timeout_ms` is set, each task gets an `AbortController`
 * whose signal is aborted on timeout. The `executeFn` receives an
 * `AbortSignal` that it should propagate to LLM calls.
 *
 * @param tasks - The tasks to execute.
 * @param executeFn - Executor function called for each task. Receives an optional AbortSignal for cancellation.
 * @param config - Concurrency and error strategy configuration.
 * @returns Results for all executed tasks.
 */
export async function executeParallel(
  tasks: ParallelTask[],
  executeFn: (task: ParallelTask, signal?: AbortSignal) => Promise<Action>,
  config: ParallelExecutionConfig,
): Promise<ParallelResult[]> {
  const results: ParallelResult[] = [];

  // Chunk tasks into batches of max_concurrency
  const batches: ParallelTask[][] = [];
  for (let i = 0; i < tasks.length; i += config.max_concurrency) {
    batches.push(tasks.slice(i, i + config.max_concurrency));
  }

  logger.info('parallel_execution_start', {
    total_tasks: tasks.length,
    batches: batches.length,
    max_concurrency: config.max_concurrency,
    error_strategy: config.error_strategy,
  });

  for (let batchStart = 0; batchStart < tasks.length; batchStart += config.max_concurrency) {
    const batch = batches[batchStart / config.max_concurrency];

    const batchPromises = batch.map(async (task, batchIndex): Promise<ParallelResult> => {
      const taskIndex = batchStart + batchIndex;

      try {
        let action: Action;

        if (config.task_timeout_ms) {
          // Create an AbortController for cooperative cancellation.
          // The signal is passed to executeFn so LLM calls can be aborted.
          // Promise.race ensures the timeout rejects immediately even if
          // executeFn doesn't check the signal (resource leak prevention).
          const abortController = new AbortController();
          const timeoutMs = config.task_timeout_ms;

          action = await Promise.race([
            executeFn(task, abortController.signal),
            new Promise<never>((_, reject) => {
              const timeoutId = setTimeout(() => {
                abortController.abort(new Error(`Task ${taskIndex} (${task.node.id}) timed out after ${timeoutMs}ms`));
                reject(new Error(`Task ${taskIndex} (${task.node.id}) timed out after ${timeoutMs}ms`));
              }, timeoutMs);
              // Clean up timer if the task completes or the signal is aborted first
              abortController.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });
            }),
          ]);

          // Task completed before timeout — abort to clean up the timer
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
        } else {
          action = await executeFn(task);
        }

        const extMetadata = action.metadata as Record<string, unknown>;
        const tokenUsage = extMetadata?.token_usage as { totalTokens?: number } | undefined;

        return {
          task_index: taskIndex,
          node_id: task.node.id,
          action,
          success: true,
          tokens_used: tokenUsage?.totalTokens,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn('parallel_task_failed', { task_index: taskIndex, node_id: task.node.id, error: errorMsg });

        return {
          task_index: taskIndex,
          node_id: task.node.id,
          success: false,
          error: errorMsg,
        };
      }
    });

    if (config.error_strategy === 'fail_fast') {
      try {
        const batchResults = await Promise.all(
          batchPromises.map(async (p) => {
            const result = await p;
            if (!result.success) {
              throw new Error(`Task ${result.task_index} (${result.node_id}) failed: ${result.error}`);
            }
            return result;
          }),
        );
        results.push(...batchResults);
      } catch (error) {
        const settled = await Promise.allSettled(batchPromises);
        for (const s of settled) {
          if (s.status === 'fulfilled') results.push(s.value);
        }
        throw error;
      }
    } else {
      const settled = await Promise.allSettled(batchPromises);
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          results.push(s.value);
        }
      }
    }
  }

  logger.info('parallel_execution_complete', {
    total: results.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  });

  return results;
}
