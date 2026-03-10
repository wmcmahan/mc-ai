import type { GraphNode } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import { executeParallel, type ParallelTask } from '../parallel-executor.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.voting');

/**
 * Produce a canonical JSON string for any value.
 * Object keys are recursively sorted to ensure `{a:1,b:2}` and
 * `{b:2,a:1}` produce identical strings.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => canonicalStringify(v)).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/**
 * Execute voting node: parallel voters + consensus.
 * 
 * Description:
 * This function implements a voting node that executes multiple voters in parallel
 * and aggregates their results based on a specified strategy (majority vote, weighted vote, or LLM judge).
 * It supports configurable quorum, weights, and judge agent.
 * 
 * @param node - The node to execute.
 * @param stateView - The state view for the node.
 * @param attempt - The attempt number.
 * @param ctx - The node executor context.
 * @returns The action result.
 */
export async function executeVotingNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.voting_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'voting', 'voting_config');
  }

  logger.info('voting_node_executing', {
    node_id: node.id,
    voter_count: config.voter_agent_ids.length,
    strategy: config.strategy,
  });

  // Create synthetic agent nodes for each voter
  const tasks: ParallelTask[] = config.voter_agent_ids.map((agent_id, idx) => ({
    node: {
      id: `${node.id}_voter_${idx}`,
      type: 'agent' as const,
      agent_id,
      read_keys: node.read_keys,
      write_keys: [config.vote_key],
      failure_policy: node.failure_policy,
      requires_compensation: false,
    },
    stateView: {
      ...stateView,
      memory: {
        ...stateView.memory,
        _vote_key: config.vote_key,
        _voter_index: idx,
        _voter_count: config.voter_agent_ids.length,
      },
    },
  }));

  // Execute all voters in parallel
  const results = await executeParallel(
    tasks,
    async (task) => {
      const agentConfig = await ctx.deps.loadAgent(task.node.agent_id!);
      const tools = await ctx.deps.resolveTools(agentConfig.tools, task.node.agent_id!);
      const onToken = ctx.onToken ? (t: string) => ctx.onToken!(t, task.node.id) : undefined;
      return ctx.deps.executeAgent(task.node.agent_id!, task.stateView, tools, attempt, { node_id: task.node.id, abortSignal: ctx.abortSignal, onToken });
    },
    { max_concurrency: config.voter_agent_ids.length, error_strategy: 'best_effort' },
  );

  // Extract votes from action payloads
  const votes: Array<{ agent_id: string; vote: unknown }> = [];
  for (const result of results) {
    if (!result.success || !result.action) continue;
    const updates = result.action.payload.updates as Record<string, unknown>;
    const vote = updates[config.vote_key] ?? updates['agent_response'];
    const agentIdx = result.task_index;
    votes.push({
      agent_id: config.voter_agent_ids[agentIdx],
      vote,
    });
  }

  // Check quorum
  if (config.quorum && votes.length < config.quorum) {
    throw new NodeConfigError(node.id, 'voting', `quorum (got ${votes.length}, need ${config.quorum})`);
  }

  // Aggregate votes by strategy
  let consensus: unknown;
  const totalTokens = results.reduce((sum, r) => sum + (r.tokens_used || 0), 0);
  let extraTokens = 0;

  switch (config.strategy) {
    case 'majority_vote': {
      const tally = new Map<string, number>();
      const originals = new Map<string, unknown>();
      for (const v of votes) {
        const key = canonicalStringify(v.vote);
        tally.set(key, (tally.get(key) || 0) + 1);
        if (!originals.has(key)) originals.set(key, v.vote);
      }
      let maxCount = 0;
      let winnerKey = '';
      for (const [key, count] of tally) {
        if (count > maxCount) {
          maxCount = count;
          winnerKey = key;
        }
      }
      if (!winnerKey) {
        throw new NodeConfigError(node.id, 'voting', 'votes (no votes received for majority_vote)');
      }
      consensus = originals.get(winnerKey);
      break;
    }

    case 'weighted_vote': {
      const weights = config.weights || {};
      const tally = new Map<string, number>();
      const originals = new Map<string, unknown>();
      for (const v of votes) {
        const key = canonicalStringify(v.vote);
        const weight = weights[v.agent_id] ?? 1;
        tally.set(key, (tally.get(key) || 0) + weight);
        if (!originals.has(key)) originals.set(key, v.vote);
      }
      let maxWeight = 0;
      let winnerKey = '';
      for (const [key, weight] of tally) {
        if (weight > maxWeight) {
          maxWeight = weight;
          winnerKey = key;
        }
      }
      if (!winnerKey) {
        throw new NodeConfigError(node.id, 'voting', 'votes (no votes received for weighted_vote)');
      }
      consensus = originals.get(winnerKey);
      break;
    }

    case 'llm_judge': {
      if (!config.judge_agent_id) {
        throw new NodeConfigError(node.id, 'voting', 'judge_agent_id');
      }
      const evalResult = await ctx.deps.evaluateQualityExecutor(
        config.judge_agent_id,
        stateView.goal,
        votes,
        'Select the best vote and explain why.',
      );
      consensus = evalResult.reasoning;
      extraTokens = evalResult.tokens_used;
      break;
    }
  }

  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'merge_parallel_results',
    payload: {
      updates: {
        [`${node.id}_consensus`]: consensus,
        [`${node.id}_votes`]: votes,
      },
      total_tokens: totalTokens + extraTokens,
    },
    metadata: { node_id: node.id, timestamp: new Date(), attempt },
  };
}
