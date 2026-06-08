/**
 * Provider Type Definitions
 *
 * Interface contract for eval providers. Providers wrap a specific LLM
 * backend (Ollama for local, GPT-4o for CI) and expose a `callJudge`
 * method plus cost estimation. The SUT-driven semantic track invokes
 * `callJudge` through `evaluateMetricMultiSample`.
 *
 * @module providers/types
 */

import type { EvalMode } from '../runner/types.js';

/** Cost estimate returned by a provider before execution. */
export interface CostEstimate {
  /** Estimated cost in USD for the given number of tests. */
  estimatedUsd: number;

  /** Optional warning message if cost exceeds a threshold. */
  warning?: string;
}

/** Options passed to {@link EvalProvider.callJudge}. */
export interface CallJudgeOptions {
  /** Wall-clock timeout in milliseconds (default: 60 000). */
  timeoutMs?: number;
}

/**
 * Provider interface for the eval harness.
 *
 * Each provider adapter (Ollama, OpenAI) implements this interface. The
 * runner selects the appropriate provider based on execution mode and
 * uses `callJudge` to send prompts to the LLM and `estimateCost` to
 * project total spend before launching.
 */
export interface EvalProvider {
  /** Human-readable provider name (e.g., "ollama-llama3", "openai-gpt4o"). */
  readonly name: string;

  /** Execution mode this provider is designed for. */
  readonly mode: EvalMode;

  /** Maximum concurrent evaluations this provider supports. */
  readonly maxConcurrency: number;

  /**
   * Send a prompt to the judge LLM and return the raw text response.
   *
   * The caller (typically {@link evaluateMetricMultiSample}) parses the
   * JSON-shaped scoring response. Providers should NOT post-process the
   * model's output — return it verbatim so parsing semantics are
   * controlled by one place.
   *
   * @throws If the request fails, times out, or the response shape is
   *         unexpected. Errors are wrapped with the provider name and
   *         HTTP status code where applicable.
   */
  callJudge(prompt: string, options?: CallJudgeOptions): Promise<string>;

  /**
   * Estimates the API cost for running a given number of test cases.
   * Local providers should return { estimatedUsd: 0 }.
   */
  estimateCost(testCount: number): CostEstimate;
}
