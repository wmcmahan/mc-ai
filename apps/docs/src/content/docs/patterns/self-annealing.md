---
title: Self-Annealing
description: Iterative refinement — a single output improves through a generate → evaluate → refine loop.
---

The Self-Annealing (Evaluator-Optimizer) pattern runs a single agent through a loop of generation and evaluation until the output meets a quality threshold. Unlike [Evolution](/patterns/evolution/), there's no population — just one candidate that gets refined iteration by iteration.

## How it works

```
Generator → Draft → Evaluator → Score < threshold → Generator (with feedback)
                               Score ≥ threshold → Done
```

1. The Generator agent produces a draft
2. The Evaluator agent scores it and provides feedback
3. If the score is below the threshold, the feedback is fed back to the Generator
4. The Generator refines the draft
5. Repeat until threshold met or max iterations reached

## Graph definition

```typescript
const selfAnnealingGraph: Graph = {
  id: 'refine-content-v1',
  nodes: [
    {
      id: 'generator',
      type: 'agent',
      agent_id: 'writer-agent',
      read_keys: ['topic', 'evaluation_feedback'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 2 },
    },
    {
      id: 'evaluator',
      type: 'agent',
      agent_id: 'critic-agent',
      read_keys: ['draft', 'evaluation_criteria'],
      write_keys: ['quality_score', 'evaluation_feedback'],
      failure_policy: { max_retries: 1 },
    },
  ],
  edges: [
    // Generator → Evaluator (always)
    {
      id: 'e1',
      source: 'generator',
      target: 'evaluator',
      condition: { type: 'always' },
    },
    // Evaluator → Generator (if score below threshold)
    {
      id: 'e2',
      source: 'evaluator',
      target: 'generator',
      condition: {
        type: 'expression',
        expression: 'state.memory.quality_score < 0.85',
      },
    },
    // Evaluator → Done (if score meets threshold)
    {
      id: 'e3',
      source: 'evaluator',
      target: 'done',
      condition: {
        type: 'expression',
        expression: 'state.memory.quality_score >= 0.85',
      },
    },
  ],
  start_node: 'generator',
  end_nodes: ['done'],
  max_iterations: 8,   // Safety limit on the graph level
};
```

## The evaluator agent

The evaluator agent scores the draft and writes structured feedback:

```json
{
  "id": "critic-agent",
  "model": "claude-sonnet-4-20250514",
  "temperature": 0.1,
  "system": "You are a quality evaluator. Assess the given draft and output a JSON object with: score (0.0-1.0), feedback (string explaining what to improve). Be specific and actionable. Only give a score above 0.85 if the draft is genuinely ready for publication."
}
```

The agent writes to `quality_score` and `evaluation_feedback`. The edge condition checks `quality_score` to decide whether to loop back.

## The generator agent

The generator should incorporate feedback from previous iterations:

```json
{
  "id": "writer-agent",
  "model": "claude-sonnet-4-20250514",
  "temperature": 0.7,
  "system": "You are an expert content writer. Write a blog post on the given topic. If evaluation_feedback is provided, this is a revision — incorporate all the feedback to improve the draft."
}
```

## Iteration tracking

The `iteration_count` in `WorkflowState` increments on every node execution. Combined with `max_iterations` on the graph, this is your safety limit against infinite loops.

You can also check `visited_nodes` to see how many times the generator was invoked:

```typescript
const generatorRuns = finalState.visited_nodes.filter(n => n === 'generator').length;
```

## When to use this pattern

Self-Annealing is best for:
- **Content refinement** — writing, editing, translation
- **Code review loops** — write, review, fix, review again
- **Data validation** — extract, validate, re-extract if invalid
- **Any task where one output needs to meet a quality bar**

If you need to explore multiple approaches simultaneously, use [Evolution](/patterns/evolution/) instead.
