/**
 * OpenAI Provider
 *
 * GPT-4o judge provider for CI frontier verification. Wraps OpenAI as
 * an {@link EvalProvider} so the SUT-driven semantic track can call it
 * via `callJudge`.
 *
 * @module providers/openai
 */

import type { EvalProvider, CostEstimate, CallJudgeOptions } from './types.js';

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;
const OPENAI_API_BASE = 'https://api.openai.com/v1';

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

    async callJudge(prompt: string, callOptions: CallJudgeOptions = {}): Promise<string> {
      const timeoutMs = callOptions.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            // Judge prompts ask for a short JSON object; cap output to
            // keep cost predictable even when the model rambles.
            max_tokens: 512,
            temperature: 0,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // Surface the response body when available; it contains the
          // actionable error from OpenAI (rate limit, auth, model name).
          const detail = await response.text().catch(() => '');
          throw new Error(
            `OpenAI callJudge failed: HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
          );
        }

        const body = await response.json() as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error(
            `OpenAI callJudge: unexpected response shape (missing string \`choices[0].message.content\`)`,
          );
        }
        return content;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`OpenAI callJudge timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
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
