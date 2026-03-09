/**
 * Supervisor Routing Eval Suite
 *
 * Validates that a router-based graph correctly dispatches to a
 * worker node and then completes. Uses a router node to simulate
 * supervisor routing behavior without requiring real LLM calls.
 *
 * @module evals/supervisor-routing
 */

import { v4 as uuidv4 } from 'uuid';
import type { EvalSuite, Graph } from '@mcai/orchestrator';

const supervisorGraph: Graph = {
  id: uuidv4(),
  name: 'Supervisor Routing Eval',
  description: 'Router dispatches to tool node then completes',
  version: '1.0.0',
  nodes: [
    {
      id: 'router',
      type: 'router',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
    {
      id: 'worker',
      type: 'tool',
      tool_id: 'mock_worker',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
    {
      id: 'done',
      type: 'tool',
      tool_id: 'mock_done',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'router', target: 'worker', condition: { type: 'always' } },
    { id: 'e2', source: 'worker', target: 'done', condition: { type: 'always' } },
  ],
  start_node: 'router',
  end_nodes: ['done'],
  created_at: new Date(),
  updated_at: new Date(),
};

/** Eval suite asserting the router dispatches to a worker and completes. */
export const suite: EvalSuite = {
  name: 'Supervisor Routing',
  cases: [
    {
      name: 'Router dispatches to worker then completes',
      graph: supervisorGraph,
      input: { goal: 'Route work to a tool node' },
      assertions: [
        { type: 'status_equals', expected: 'completed' },
        { type: 'node_visited', node_id: 'router' },
        { type: 'node_visited', node_id: 'worker' },
        { type: 'node_visited', node_id: 'done' },
        { type: 'memory_contains', key: 'worker_result' },
      ],
    },
  ],
};

export default suite;
