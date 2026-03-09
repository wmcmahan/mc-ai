---
title: Evolution (DGM)
description: Population-based selection — run N candidates in parallel, score them, and breed the next generation.
---

The Evolution pattern runs multiple candidate solutions in parallel, scores each with a fitness evaluator, selects the best, and breeds the next generation using the winner's output as context. This continues until a fitness threshold is met or a stopping condition is reached.

Inspired by **Darwin Godel Machines** — the LLM acts as the mutation operator. Give it the winning parent as context plus a temperature, and its stochastic creativity produces variation.

## How it works

```
Generation 0: [A, B, C, D, E] → Evaluate → Winner: C (0.72)
Generation 1: [A', B', C', D', E'] (with C as parent) → Evaluate → Winner: C' (0.85)
Generation 2: [A'', B'', C'', D'', E''] (with C' as parent) → Evaluate → Winner: D'' (0.91) ✓
```

Each generation:
1. N candidates run in parallel (fan-out)
2. Each candidate receives the previous generation's winner as `_evolution_parent`
3. The fitness evaluator scores each candidate 0–1
4. The best candidate becomes the parent for the next generation
5. Temperature decreases linearly (exploration → exploitation)
6. Stops when fitness threshold is met, stagnation is detected, or max generations reached

## Configuration

```typescript
{
  id: 'evolve',
  type: 'evolution',
  evolution_config: {
    candidate_agent_id: 'writer-agent',     // Generates candidate solutions
    evaluator_agent_id: 'critic-agent',     // Scores each candidate 0–1
    population_size: 5,                     // Candidates per generation
    max_generations: 10,                    // Hard stop
    fitness_threshold: 0.9,                 // Early exit when score >= this
    stagnation_generations: 3,              // Stop if no improvement for N gens
    selection_strategy: 'rank',             // 'rank' | 'tournament' | 'roulette'
    elite_count: 1,                         // Top N preserved unchanged
    initial_temperature: 1.0,              // Diversity at start
    final_temperature: 0.3,                // Focus at end
    evaluation_criteria: 'Score based on accuracy, clarity, and citation quality.',
  },
  read_keys: ['*'],
  write_keys: ['*'],
  failure_policy: { max_retries: 1 },
  error_strategy: 'best_effort',           // Continue if some candidates fail
}
```

## Selection strategies

| Strategy | Behavior |
|----------|---------|
| `rank` | Best candidate becomes the parent. Simple, effective. |
| `tournament` | Random subset compete; the winner becomes the parent. Maintains diversity. |
| `roulette` | Probabilistic selection weighted by fitness. Good for exploring fitness landscape. |

## Context injected into candidates

Each candidate receives these keys automatically in its state view:

| Key | Value |
|-----|-------|
| `_evolution_generation` | Current generation number (0-indexed) |
| `_evolution_candidate_index` | This candidate's index within the generation |
| `_evolution_population_size` | Total candidates per generation |
| `_evolution_parent` | Winning output from the previous generation (from gen 1+) |
| `_evolution_parent_fitness` | Parent's fitness score (from gen 1+) |

The candidate agent's system prompt should reference these:

```
You are a content writer. Write a blog post on the given topic.

If _evolution_parent is provided, use it as a starting point and improve on it.
The parent scored {_evolution_parent_fitness} — aim to do better.
Current generation: {_evolution_generation} of 10.
```

## Reading results

```typescript
const finalState = await runner.run();

// The best candidate's output
console.log(finalState.memory['evolve_winner']);

// Its fitness score (0–1)
console.log(finalState.memory['evolve_winner_fitness']);

// Evaluator's reasoning
console.log(finalState.memory['evolve_winner_reasoning']);

// Generations completed
console.log(finalState.memory['evolve_generation']);

// Score progression across generations
console.log(finalState.memory['evolve_fitness_history']);
// → [0.72, 0.85, 0.91]
```

## Evolution vs. Self-Annealing

| | Evolution | Self-Annealing |
|-|-----------|----------------|
| **Candidates per iteration** | N (population) | 1 |
| **Parallelism** | Yes — fan-out | No — sequential |
| **Best for** | Creative tasks, multi-approach problems, prompt optimization | Iterative refinement of a single output |
| **Cost** | Higher (N agents + N evaluations per gen) | Lower (1 agent + 1 evaluation per iter) |

Use Evolution when there are many valid approaches and you want to explore them. Use [Self-Annealing](/patterns/self-annealing/) when you have a single output that needs iterative improvement.

## Cost considerations

With `population_size: 5` and `max_generations: 10`, you could run up to 50 candidate executions plus 50 evaluations. Set `fitness_threshold` conservatively so the loop exits early when a good solution is found.

Use `error_strategy: 'best_effort'` to continue if some candidates fail — useful when external API rate limits cause occasional failures.
