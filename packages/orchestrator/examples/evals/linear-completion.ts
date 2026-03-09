/**
 * Linear Completion Eval Suite
 *
 * Validates that a simple 2-node tool pipeline (fetch → transform)
 * runs to completion with both nodes visited and results in memory.
 *
 * @module evals/linear-completion
 */

import { v4 as uuidv4 } from 'uuid';
import type { EvalSuite, Graph } from '@mcai/orchestrator';

const linearGraph: Graph = {
  id: uuidv4(),
  name: 'Linear Completion Eval',
  description: 'Two tool nodes in sequence',
  version: '1.0.0',
  nodes: [
    {
      id: 'fetch',
      type: 'tool',
      tool_id: 'mock_fetch',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
    {
      id: 'transform',
      type: 'tool',
      tool_id: 'mock_transform',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'fetch', target: 'transform', condition: { type: 'always' } },
  ],
  start_node: 'fetch',
  end_nodes: ['transform'],
  created_at: new Date(),
  updated_at: new Date(),
};

/** Eval suite asserting a linear tool pipeline completes successfully. */
export const suite: EvalSuite = {
  name: 'Linear Completion',
  cases: [
    {
      name: 'Two tool nodes complete successfully',
      graph: linearGraph,
      input: { goal: 'Fetch and transform data' },
      assertions: [
        { type: 'status_equals', expected: 'completed' },
        { type: 'node_visited', node_id: 'fetch' },
        { type: 'node_visited', node_id: 'transform' },
        { type: 'memory_contains', key: 'fetch_result' },
        { type: 'memory_contains', key: 'transform_result' },
      ],
    },
  ],
};

export default suite;
