---
title: Swarm
description: Parallel fan-out with synthesis — divide work across multiple agents and merge the results.
---

The Swarm pattern divides a task across multiple agents running in parallel, then synthesizes their outputs into a single coherent result. This is useful when a task is too large for a single context window, or when multiple independent perspectives improve quality.

## How it works

```
Orchestrator → [Worker A, Worker B, Worker C] (parallel) → Synthesizer → Output
```

1. An orchestrator agent (or static config) determines the subtasks
2. Worker agents run in parallel, each tackling a different slice
3. A Synthesizer agent reads all outputs and merges them intelligently

## Graph definition

```typescript
const swarmGraph: Graph = {
  id: 'market-research-v1',
  nodes: [
    {
      id: 'orchestrator',
      type: 'agent',
      agent_id: 'planner-agent',
      read_keys: ['topic'],
      write_keys: ['subtask_a', 'subtask_b', 'subtask_c'],
      failure_policy: { max_retries: 2 },
    },
    {
      id: 'researcher_a',
      type: 'agent',
      agent_id: 'research-agent',
      read_keys: ['subtask_a'],
      write_keys: ['result_a'],
      failure_policy: { max_retries: 3 },
    },
    {
      id: 'researcher_b',
      type: 'agent',
      agent_id: 'research-agent',
      read_keys: ['subtask_b'],
      write_keys: ['result_b'],
      failure_policy: { max_retries: 3 },
    },
    {
      id: 'researcher_c',
      type: 'agent',
      agent_id: 'research-agent',
      read_keys: ['subtask_c'],
      write_keys: ['result_c'],
      failure_policy: { max_retries: 3 },
    },
    {
      id: 'synthesizer',
      type: 'synthesizer',
      agent_id: 'merge-agent',
      read_keys: ['result_a', 'result_b', 'result_c'],
      write_keys: ['final_report'],
      failure_policy: { max_retries: 1 },
    },
  ],
  edges: [
    // Orchestrator fans out to all workers in parallel
    { id: 'e1', source: 'orchestrator', target: 'researcher_a', condition: { type: 'always' } },
    { id: 'e2', source: 'orchestrator', target: 'researcher_b', condition: { type: 'always' } },
    { id: 'e3', source: 'orchestrator', target: 'researcher_c', condition: { type: 'always' } },
    // Workers converge on synthesizer (synthesizer waits for all)
    { id: 'e4', source: 'researcher_a', target: 'synthesizer', condition: { type: 'always' } },
    { id: 'e5', source: 'researcher_b', target: 'synthesizer', condition: { type: 'always' } },
    { id: 'e6', source: 'researcher_c', target: 'synthesizer', condition: { type: 'always' } },
  ],
  start_node: 'orchestrator',
  end_nodes: ['synthesizer'],
};
```

## The synthesizer

The synthesizer node reads all parallel outputs and produces a unified result. Unlike a simple concatenation, an LLM-powered synthesizer can:
- Deduplicate overlapping findings
- Resolve conflicting information
- Weight sources by credibility
- Produce a coherent narrative from fragments

```json
{
  "id": "merge-agent",
  "model": "claude-sonnet-4-20250514",
  "temperature": 0.3,
  "system": "You are an expert analyst. Given multiple research reports on different aspects of a topic, synthesize them into a single comprehensive report. Identify themes, resolve contradictions, and produce a coherent narrative."
}
```

## Peer delegation

In a Swarm, worker agents can delegate to peers via `_peer_delegation` in their output. This allows dynamic task redistribution without a central orchestrator:

```typescript
// A worker agent's output can include:
{
  type: 'set_memory',
  payload: {
    result_a: 'My findings...',
    _peer_delegation: {
      target: 'researcher_b',
      instruction: 'Also look into the regulatory landscape — I found a relevant angle.',
    },
  },
}
```

## Static vs. dynamic fan-out

The example above uses a **static** fan-out — three fixed workers. For a **dynamic** fan-out based on input, use a Supervisor that decides how many workers to spawn and what each should work on.

## When to use this pattern

Use Swarm when:
- A task can be meaningfully divided into independent subtasks
- Parallel execution would significantly reduce wall-clock time
- Multiple perspectives or sources are needed (e.g., researching competitors, analyzing different documents)
- A single agent's context window isn't large enough for the full task

Use a linear pipeline when tasks are sequential and each depends on the previous output.
