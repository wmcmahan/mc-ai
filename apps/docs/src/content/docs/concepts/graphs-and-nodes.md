---
title: Graphs & Nodes
description: How to define workflow graphs with nodes, edges, and conditional routing.
---

A **Graph** defines the structure of a workflow — which nodes exist, how they connect, and the conditions under which edges are traversed.

## Graph definition

```typescript
import type { Graph } from '@mcai/orchestrator';

const graph: Graph = {
  id: 'content-pipeline',
  name: 'Research & Write',
  description: 'Simple linear workflow',
  version: '1.0.0',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agent_id: 'research-agent',
      read_keys: ['topic'],
      write_keys: ['notes'],
      failure_policy: {
        max_retries: 3,
        backoff_strategy: 'exponential',
        initial_backoff_ms: 1000,
        max_backoff_ms: 60000,
      },
      requires_compensation: false,
    },
    {
      id: 'writer',
      type: 'agent',
      agent_id: 'writer-agent',
      read_keys: ['topic', 'notes'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 1 },
      requires_compensation: false,
    },
  ],

  edges: [
    {
      id: 'e1',
      source: 'research',
      target: 'writer',
      condition: { type: 'always' },
    },
  ],

  start_node: 'research',
  end_nodes: ['writer'],
  created_at: new Date(),
  updated_at: new Date(),
};
```

## Node types

| Type | Description |
|------|-------------|
| `agent` | Runs an LLM with tools via `streamText`. The workhorse of the system. |
| `tool` | Executes a specific MCP tool directly, without an LLM. |
| `router` | Evaluates a state expression and routes to the matching target node. |
| `supervisor` | LLM-powered dynamic routing — delegates to managed nodes iteratively. |
| `approval` | Pauses the workflow for human review. Resumes when approved or rejected. |
| `map` | Fans out work to parallel workers (one per item). |
| `synthesizer` | Merges parallel outputs into a single result using an LLM agent. |
| `voting` | Multiple agents vote on a decision to reach consensus. |
| `subgraph` | Delegates to a nested graph with isolated state. Input/output mapping between parent and child. |
| `evolution` | Population-based selection — runs N candidates, scores fitness, breeds next generation. |

## Edges and conditions

Edges define how nodes connect. Every edge has a `condition` that determines when it's traversed:

```typescript
edges: [
  // Always traverse
  { id: 'e1', source: 'a', target: 'b', condition: { type: 'always' } },

  // Conditional: evaluate a filtrex expression against state
  {
    id: 'e2',
    source: 'reviewer',
    target: 'writer',
    condition: {
      type: 'expression',
      expression: 'score < 0.8',
    },
  },
  {
    id: 'e3',
    source: 'reviewer',
    target: 'done',
    condition: {
      type: 'expression',
      expression: 'score >= 0.8',
    },
  },
]
```

Expressions are evaluated using [filtrex](https://github.com/joewalnes/filtrex) against the current workflow state memory.

## Failure policies

Every node can define a `failure_policy` that controls retry behavior:

```typescript
failure_policy: {
  max_retries: 3,
  backoff_strategy: 'exponential', // 'fixed' | 'linear' | 'exponential'
  initial_backoff_ms: 1000,
  max_backoff_ms: 60000,
}
```

## State slicing

Nodes declare which state keys they can read and write:

- `read_keys: ['goal', 'notes']` — the node sees only these keys from the blackboard
- `write_keys: ['draft']` — the node can only write to these keys
- `read_keys: ['*']` / `write_keys: ['*']` — wildcard access (use sparingly)

This enforces the **principle of least privilege** — a writer agent can't read database credentials, and a researcher can't overwrite the final draft.

## Subgraphs

Subgraphs allow you to compose graphs within graphs:

- The parent node acts as a "black box" — it exposes inputs and outputs
- The child graph has its own isolated state
- Inputs and outputs are explicitly mapped between parent and child state
- Internal loop counters and temporary data are discarded on completion
- Cycle detection prevents infinite nesting

## Compensation (Saga pattern)

Nodes can opt into compensation for rollback support:

```typescript
{
  id: 'book-flight',
  type: 'tool',
  requires_compensation: true,
  // If a later node fails, the compensation stack is unwound
}
```

If the workflow fails after a compensatable node completes, the orchestrator executes the `compensation_stack` in reverse order.

## Next steps

- [Workflow State](/concepts/workflow-state/) — the shared blackboard
- [Agents](/concepts/agents/) — how agent nodes work
- [Reducers](/concepts/reducers/) — how state changes are applied
