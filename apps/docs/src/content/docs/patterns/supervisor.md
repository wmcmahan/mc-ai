---
title: Supervisor
description: LLM-powered dynamic routing — a supervisor delegates tasks to managed nodes iteratively.
---

The **Supervisor pattern** uses an LLM to dynamically route tasks to specialized agents. Unlike static routing, the supervisor makes iterative decisions — delegating, reviewing results, and re-delegating until the goal is complete.

## How it works

1. **Input**: User gives a goal ("Write a research report on AI agents")
2. **Supervisor**: Decides "I need research first". Routes to `researcher`
3. **Researcher**: Does work, saves results to memory. Returns to supervisor
4. **Supervisor**: Sees research. Decides "Now I can write". Routes to `writer`
5. **Writer**: Writes a draft. Returns to supervisor
6. **Supervisor**: Reviews the draft. "Goal complete." Routes to `__done__`

```
Goal → Supervisor → Research Agent → Supervisor → Writer Agent → Supervisor → __done__
```

## Graph definition

```typescript
const supervisorGraph: Graph = {
  id: 'supervisor-example',
  name: 'Supervised Research & Write',
  version: '1.0.0',
  nodes: [
    {
      id: 'manager',
      type: 'supervisor',
      supervisor_config: {
        agent_id: 'router-agent',               // The LLM brain
        managed_nodes: ['researcher', 'writer'], // Workers it can delegate to
        max_iterations: 10,                      // Safety limit
      },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 3 },
    },
    {
      id: 'researcher',
      type: 'agent',
      agent_id: 'researcher-agent',
      read_keys: ['goal'],
      write_keys: ['notes'],
      failure_policy: { max_retries: 2 },
    },
    {
      id: 'writer',
      type: 'agent',
      agent_id: 'writer-agent',
      read_keys: ['goal', 'notes'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 1 },
    },
  ],

  // Bidirectional edges: supervisor ↔ workers
  edges: [
    { id: 'e1', source: 'manager', target: 'researcher', condition: { type: 'always' } },
    { id: 'e2', source: 'manager', target: 'writer',     condition: { type: 'always' } },
    { id: 'e3', source: 'researcher', target: 'manager', condition: { type: 'always' } },
    { id: 'e4', source: 'writer',     target: 'manager', condition: { type: 'always' } },
  ],

  start_node: 'manager',
  end_nodes: [],  // Supervisor decides when to end (routes to __done__)
  created_at: new Date(),
  updated_at: new Date(),
};
```

## Key properties

| Property | Description |
|----------|-------------|
| `supervisor_config.agent_id` | The LLM that makes routing decisions (via `generateObject`) |
| `supervisor_config.managed_nodes` | Allowlist of nodes the supervisor can delegate to |
| `supervisor_config.max_iterations` | Safety limit to prevent infinite loops |
| `supervisor_history` | Full audit trail on `WorkflowState` — supervisor ID, target, reasoning, timestamp |

## Nested supervisors

A supervisor can manage another supervisor. This enables hierarchical delegation — a "Director" supervises "Managers" who each supervise their own team of specialists.

## When to use

Use the Supervisor pattern when:
- The number of steps to complete a task isn't known in advance
- Different specialists need to be called in a data-dependent order
- You want an LLM to make routing decisions based on the current state

For static, predetermined routing, use a `router` node with conditional edges instead.

## Next steps

- [Supervisor routing example](https://gitlab.com/wmcmahan/mc-ai/tree/main/packages/orchestrator/examples/supervisor-routing) — complete runnable example
- [Evolution (DGM)](/patterns/evolution/) — population-based selection pattern
- [Map-Reduce](/patterns/map-reduce/) — parallel fan-out pattern
