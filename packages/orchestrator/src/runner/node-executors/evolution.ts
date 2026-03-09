/**
 * Evolution (DGM) Node Executor
 *
 * Population-based Darwinian selection: generates N candidates per
 * generation, scores them via a fitness evaluator, selects the best,
 * and breeds the next generation using the winner as parent context.
 * Temperature controls diversity vs exploitation.
 *
 * @module runner/node-executors/evolution
 */

import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { executeParallel, type ParallelTask } from '../parallel-executor.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.evolution');

/**
 * Select a parent candidate using the configured strategy.
 *
 * - **rank**: pick the top candidate (index 0 after sort).
 * - **tournament**: pick `tournamentSize` random candidates, select the best.
 * - **roulette**: fitness-proportional probability selection.
 *
 * @param candidates - Sorted descending by fitness.
 * @param strategy - Selection strategy name.
 * @param tournamentSize - Tournament group size (only for 'tournament').
 * @returns The selected candidate.
 */
function selectWinner(
  candidates: ScoredCandidate[],
  strategy: 'rank' | 'tournament' | 'roulette',
  tournamentSize: number = 3,
): ScoredCandidate {
  if (candidates.length === 1) return candidates[0];

  switch (strategy) {
    case 'rank':
      return candidates[0];

    case 'tournament': {
      const size = Math.min(tournamentSize, candidates.length);
      // Fisher-Yates partial shuffle to pick `size` random candidates
      const indices = candidates.map((_, i) => i);
      for (let i = 0; i < size; i++) {
        const j = i + Math.floor(Math.random() * (indices.length - i));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const group = indices.slice(0, size).map(i => candidates[i]);
      // Best in group (candidates already sorted, but group may not be in order)
      return group.reduce((best, c) => c.fitness > best.fitness ? c : best, group[0]);
    }

    case 'roulette': {
      const totalFitness = candidates.reduce((sum, c) => sum + c.fitness, 0);
      // Fallback to rank if all fitness values are zero
      if (totalFitness === 0) return candidates[0];
      const spin = Math.random() * totalFitness;
      let cumulative = 0;
      for (const candidate of candidates) {
        cumulative += candidate.fitness;
        if (cumulative >= spin) return candidate;
      }
      // Floating point guard
      return candidates[candidates.length - 1];
    }

    default:
      return candidates[0];
  }
}

/** A scored candidate from a single generation. */
interface ScoredCandidate {
  /** Index within the generation's parallel batch. */
  index: number;
  /** Raw agent output. */
  output: unknown;
  /** Fitness score (0–1). */
  fitness: number;
  /** Evaluator's reasoning. */
  reasoning: string;
  /** Total tokens consumed (generation + evaluation). */
  tokens_used: number;
}

/**
 * Execute an evolution (DGM) node.
 *
 * Runs multiple generations of parallel candidate agents, each scored
 * by a fitness evaluator. Terminates early when the fitness threshold
 * is met or stagnation is detected.
 *
 * @param node - Evolution node with `evolution_config`.
 * @param stateView - Filtered state view.
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context.
 * @returns `merge_parallel_results` action with winner and fitness history.
 * @throws If `evolution_config` is missing or all candidates fail under `fail_fast`.
 */
export async function executeEvolutionNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.evolution_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'evolution', 'evolution_config');
  }

  logger.info('evolution_node_start', {
    node_id: node.id,
    population_size: config.population_size,
    max_generations: config.max_generations,
    fitness_threshold: config.fitness_threshold,
    selection_strategy: config.selection_strategy,
  });

  let bestCandidate: ScoredCandidate | null = null;
  let parentForNextGen: ScoredCandidate | null = null;
  let totalTokens = 0;
  let stagnationCount = 0;
  const fitnessHistory: number[] = [];
  let finalPopulation: ScoredCandidate[] = [];
  let generationsRun = 0;

  for (let gen = 0; gen < config.max_generations; gen++) {
    generationsRun = gen + 1;

    if (ctx.abortSignal?.aborted) break;

    // Linear temperature interpolation: initial → final
    const progress = config.max_generations > 1 ? gen / (config.max_generations - 1) : 1;
    const temperature = config.initial_temperature +
      (config.final_temperature - config.initial_temperature) * progress;

    // Create parallel tasks for candidate generation
    const tasks: ParallelTask[] = Array.from({ length: config.population_size }, (_, idx) => ({
      node: {
        id: `${node.id}_gen${gen}_candidate${idx}`,
        type: 'agent' as const,
        agent_id: config.candidate_agent_id,
        read_keys: node.read_keys,
        write_keys: ['*'],
        failure_policy: node.failure_policy,
        requires_compensation: false,
      },
      stateView: {
        ...stateView,
        memory: {
          ...stateView.memory,
          _evolution_generation: gen,
          _evolution_candidate_index: idx,
          _evolution_population_size: config.population_size,
          _evolution_best_fitness: bestCandidate?.fitness ?? null,
          ...(gen > 0 && parentForNextGen ? {
            _evolution_parent: parentForNextGen.output,
            _evolution_parent_fitness: parentForNextGen.fitness,
          } : {}),
        },
      },
    }));

    const results = await executeParallel(
      tasks,
      async (task) => {
        const agentConfig = await ctx.deps.loadAgent(task.node.agent_id!);
        const tools = await ctx.deps.loadAgentTools(agentConfig.tools);
        const onToken = ctx.onToken ? (t: string) => ctx.onToken!(t, task.node.id) : undefined;
        return ctx.deps.executeAgent(
          task.node.agent_id!,
          task.stateView,
          tools,
          attempt,
          { temperature_override: temperature, node_id: task.node.id, abortSignal: ctx.abortSignal, onToken, executeToolCall: ctx.deps.executeToolCall },
        );
      },
      { max_concurrency: config.max_concurrency, error_strategy: config.error_strategy },
    );

    // Score each successful candidate
    const candidates: ScoredCandidate[] = [];
    for (const result of results) {
      if (!result.success || !result.action) continue;

      const candidateOutput = result.action.payload.updates;
      const actionTokens = result.action.metadata.token_usage?.totalTokens ?? 0;
      totalTokens += actionTokens;

      const evalResult = await ctx.deps.evaluateQualityExecutor(
        config.evaluator_agent_id,
        stateView.goal,
        candidateOutput,
        config.evaluation_criteria,
      );
      totalTokens += evalResult.tokens_used;

      candidates.push({
        index: result.task_index,
        output: candidateOutput,
        fitness: evalResult.score,
        reasoning: evalResult.reasoning,
        tokens_used: actionTokens + evalResult.tokens_used,
      });
    }

    // Handle all-failed generation
    if (candidates.length === 0) {
      if (config.error_strategy === 'fail_fast') {
        throw new NodeConfigError(node.id, 'evolution', `candidates (all failed in generation ${gen})`);
      }
      fitnessHistory.push(bestCandidate?.fitness ?? 0);
      stagnationCount++;
      if (stagnationCount >= config.stagnation_generations) {
        logger.info('evolution_stagnation', { node_id: node.id, gen, stagnation_count: stagnationCount });
        break;
      }
      continue;
    }

    // Sort by fitness descending
    candidates.sort((a, b) => b.fitness - a.fitness);
    finalPopulation = candidates;

    const genBestFitness = candidates[0].fitness;
    fitnessHistory.push(genBestFitness);

    // Select parent for next generation using configured strategy
    const selectedParent = selectWinner(
      candidates,
      config.selection_strategy,
      config.tournament_size,
    );

    logger.info('evolution_generation_complete', {
      node_id: node.id,
      generation: gen,
      best_fitness: genBestFitness,
      overall_best: bestCandidate?.fitness ?? -1,
      selected_parent_fitness: selectedParent.fitness,
      candidates_scored: candidates.length,
      temperature,
    });

    // Track absolute best (always rank-based, regardless of selection strategy)
    if (!bestCandidate || genBestFitness > bestCandidate.fitness) {
      bestCandidate = candidates[0];
      stagnationCount = 0;
    } else {
      stagnationCount++;
    }

    // Use selected parent (not necessarily the absolute best) for breeding
    parentForNextGen = selectedParent;

    // Early exit checks
    if (bestCandidate.fitness >= config.fitness_threshold) {
      logger.info('evolution_fitness_threshold_met', {
        node_id: node.id,
        fitness: bestCandidate.fitness,
        threshold: config.fitness_threshold,
        generation: gen,
      });
      break;
    }

    if (stagnationCount >= config.stagnation_generations) {
      logger.info('evolution_stagnation', { node_id: node.id, gen, stagnation_count: stagnationCount });
      break;
    }
  }

  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'merge_parallel_results',
    payload: {
      updates: {
        [`${node.id}_winner`]: bestCandidate?.output ?? null,
        [`${node.id}_winner_fitness`]: bestCandidate?.fitness ?? 0,
        [`${node.id}_winner_reasoning`]: bestCandidate?.reasoning ?? '',
        [`${node.id}_generation`]: generationsRun,
        [`${node.id}_fitness_history`]: fitnessHistory,
        [`${node.id}_population`]: finalPopulation,
      },
      total_tokens: totalTokens,
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      token_usage: { totalTokens },
    },
  };
}
