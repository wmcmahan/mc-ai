/**
 * Evolution (DGM) — Runnable Example
 *
 * Population-based Darwinian selection: generate N candidate solutions in
 * parallel, score them with a fitness evaluator, select the best, and breed
 * the next generation using the winner as parent context.
 *
 * Demonstrates: evolution node, parallel candidate generation, fitness
 * evaluation, selection strategies, temperature annealing across generations,
 * stagnation detection, and early exit on fitness threshold.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evolution/evolution.ts
 */

import {
  GraphRunner,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createGraph,
  createWorkflowState,
  createLogger,
} from '@mcai/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evolution/evolution.ts');
  process.exit(1);
}

const logger = createLogger('example.evolution');

// ─── 1. Register agents ──────────────────────────────────────────────────
// Evolution requires two agents: a candidate generator and a fitness evaluator.

const registry = new InMemoryAgentRegistry();

// Candidate agent — generates tagline variations
const CANDIDATE_ID = registry.register({
  name: 'Tagline Generator',
  description: 'Generates creative marketing tagline candidates',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a creative copywriter generating marketing taglines.',
    'Generate ONE concise, memorable tagline for the given product/topic.',
    'If a parent tagline is provided (from a previous winning generation),',
    'use it as inspiration but create something distinct and improved.',
    'The tagline should be under 15 words, catchy, and memorable.',
    'Save your tagline using save_to_memory with key "candidate_output".',
  ].join(' '),
  temperature: 0.9, // High creativity (overridden by evolution temperature annealing)
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['*'],
    write_keys: ['candidate_output'],
  },
});

// Evaluator agent — scores tagline quality (LLM-as-Judge)
const EVALUATOR_ID = registry.register({
  name: 'Tagline Evaluator',
  description: 'Scores tagline quality on a 0-1 scale',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a marketing expert evaluating tagline quality.',
    'Score the tagline on a scale of 0.0 to 1.0 based on:',
    '  - Memorability (is it catchy?)',
    '  - Clarity (does it convey the product value?)',
    '  - Brevity (is it concise?)',
    '  - Emotional appeal (does it resonate?)',
    'Return ONLY a JSON object: { "score": <number>, "reasoning": "<brief explanation>" }',
  ].join(' '),
  temperature: 0.2, // Low temperature for consistent evaluation
  max_steps: 1,
  tools: [],
  permissions: {
    read_keys: ['*'],
    write_keys: ['*'],
  },
});

configureAgentFactory(registry);
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ────────────────────────────────────────────────
// A single evolution node handles the full generational loop internally.

const graph = createGraph({
  name: 'Tagline Evolution',
  description: 'Evolve marketing taglines through population-based selection',

  nodes: [
    {
      id: 'evolve',
      type: 'evolution',
      agent_id: CANDIDATE_ID, // Used for candidate generation
      read_keys: ['*'],
      write_keys: ['*'],
      evolution_config: {
        candidate_agent_id: CANDIDATE_ID,
        evaluator_agent_id: EVALUATOR_ID,

        // Population settings
        population_size: 4,       // 4 candidates per generation
        max_generations: 5,       // Up to 5 generations
        elite_count: 1,           // Preserve the top candidate each generation

        // Stopping criteria
        fitness_threshold: 0.85,  // Stop early if a tagline scores >= 0.85
        stagnation_generations: 3, // Stop if no improvement for 3 generations

        // Selection
        selection_strategy: 'rank', // Rank-based selection (best = highest fitness)

        // Temperature annealing: starts creative, becomes more focused
        initial_temperature: 1.0,
        final_temperature: 0.3,

        // Parallelism
        max_concurrency: 4,
        error_strategy: 'best_effort',

        // Per-task timeout (guards against hung LLM calls)
        task_timeout_ms: 30_000,
      },
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
  ],

  edges: [],
  start_node: 'evolve',
  end_nodes: ['evolve'],
});

// ─── 3. Run ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting evolution example — evolving marketing taglines...\n');

  const state = createWorkflowState({
    workflow_id: graph.id,
    goal: 'Create the best marketing tagline for an AI-powered code assistant that helps developers write better code faster',
    constraints: ['Tagline must be under 15 words', 'Should appeal to professional software developers'],
    max_execution_time_ms: 300_000,
  });

  const runner = new GraphRunner(graph, state);

  try {
    const finalState = await runner.run();

    console.log('\n═══ Evolution Results ═══');
    console.log('Status:', finalState.status);

    // Evolution outputs are stored with the node ID prefix
    const winner = finalState.memory['evolve_winner'];
    const winnerFitness = finalState.memory['evolve_winner_fitness'];
    const fitnessHistory = finalState.memory['evolve_fitness_history'] as number[] | undefined;

    console.log('\nWinning Tagline:');
    console.log(`  "${winner}"`);
    console.log(`  Fitness: ${winnerFitness}`);

    if (fitnessHistory) {
      console.log('\nFitness History (best per generation):');
      fitnessHistory.forEach((score, gen) => {
        const bar = '█'.repeat(Math.round(score * 40));
        console.log(`  Gen ${gen + 1}: ${score.toFixed(3)} ${bar}`);
      });
    }

    console.log(`\nTokens used: ${finalState.total_tokens_used}`);
    console.log(`Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
