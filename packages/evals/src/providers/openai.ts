/**
 * OpenAI Provider
 *
 * GPT-4o provider for CI frontier verification.
 * Wraps OpenAI as a promptfoo-compatible provider.
 *
 * @module providers/openai
 */

import type { EvalProvider, CostEstimate } from './types.js';

/** Approximate cost per 1K tokens for GPT-4o (input + output average). */
const GPT4O_COST_PER_1K_TOKENS = 0.005;

/** Estimated tokens per eval test case (prompt + judge response). */
const ESTIMATED_TOKENS_PER_TEST = 2000;

/** Options for creating the OpenAI provider. */
export interface OpenAIProviderOptions {
  /** OpenAI API key (default: OPENAI_API_KEY env). */
  apiKey?: string;

  /** Model to use (default: gpt-4o). */
  model?: string;

  /** Max concurrent evaluations (default: 8). */
  maxConcurrency?: number;

  /** Cost warning threshold in USD (default: 5.0). */
  costWarningThreshold?: number;
}

/**
 * Creates an OpenAI eval provider for CI frontier verification.
 *
 * @throws If OPENAI_API_KEY is not set and no apiKey is provided.
 */
export function createOpenAIProvider(options: OpenAIProviderOptions = {}): EvalProvider {
  const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
  const model = options.model ?? 'gpt-4o';
  const maxConcurrency = options.maxConcurrency ?? 8;
  const costWarningThreshold = options.costWarningThreshold ?? 5.0;

  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY environment variable is required for CI evaluation mode.',
    );
  }

  return {
    name: `openai-${model}`,
    mode: 'ci',
    maxConcurrency,

    getProviderConfig() {
      return {
        id: `openai:${model}`,
        config: {
          apiKey,
        },
      };
    },

    estimateCost(testCount: number): CostEstimate {
      const estimatedTokens = testCount * ESTIMATED_TOKENS_PER_TEST;
      const estimatedUsd = (estimatedTokens / 1000) * GPT4O_COST_PER_1K_TOKENS;

      const warning = estimatedUsd > costWarningThreshold
        ? `Estimated cost $${estimatedUsd.toFixed(2)} exceeds warning threshold of $${costWarningThreshold.toFixed(2)}`
        : undefined;

      return { estimatedUsd, warning };
    },
  };
}
