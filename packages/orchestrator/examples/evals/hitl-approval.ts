/**
 * HITL Approval Eval Suite
 *
 * Validates that an approval gate pauses the workflow. The graph
 * has a tool → approval → tool pipeline. Since no human input is
 * provided during the eval, the workflow must end in `waiting` status.
 *
 * @module evals/hitl-approval
 */

import { createGraph, type EvalSuite } from '@mcai/orchestrator';

const hitlGraph = createGraph({
  name: 'HITL Approval Eval',
  description: 'Approval gate pauses for human review',
  nodes: [
    {
      id: 'prepare',
      type: 'tool',
      tool_id: 'mock_prepare',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
    {
      id: 'review',
      type: 'approval',
      approval_config: {
        approval_type: 'human_review',
        prompt_message: 'Please review the prepared data.',
        review_keys: ['*'],
        timeout_ms: 86_400_000,
      },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
    {
      id: 'finalize',
      type: 'tool',
      tool_id: 'mock_finalize',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 0, max_backoff_ms: 0 },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'prepare', target: 'review', condition: { type: 'always' } },
    { id: 'e2', source: 'review', target: 'finalize', condition: { type: 'always' } },
  ],
  start_node: 'prepare',
  end_nodes: ['finalize'],
});

/** Eval suite asserting the approval gate pauses the workflow. */
export const suite: EvalSuite = {
  name: 'HITL Approval',
  cases: [
    {
      name: 'Workflow pauses at approval gate',
      graph: hitlGraph,
      input: { goal: 'Process data with human review' },
      assertions: [
        { type: 'status_equals', expected: 'waiting' },
        { type: 'node_visited', node_id: 'prepare' },
        { type: 'node_visited', node_id: 'review' },
        { type: 'memory_contains', key: 'prepare_result' },
      ],
    },
  ],
};

export default suite;
