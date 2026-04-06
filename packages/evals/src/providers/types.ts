/**
 * Provider Type Definitions
 *
 * Interface contract for eval providers. Providers wrap a specific
 * LLM backend (Ollama for local, GPT-4o for CI) and expose a
 * promptfoo-compatible configuration along with cost estimation.
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

/**
 * Provider interface for the eval harness.
 *
 * Each provider adapter (Ollama, OpenAI) implements this interface.
 * The runner selects the appropriate provider based on execution mode.
 *
 * `getProviderConfig()` returns the promptfoo-compatible provider
 * configuration. Typed as `unknown` until promptfoo is added as a
 * dependency in Phase 4 — at that point it will return `ApiProvider`
 * or `ProviderOptions`.
 */
export interface EvalProvider {
  /** Human-readable provider name (e.g., "ollama-llama3", "openai-gpt4o"). */
  readonly name: string;

  /** Execution mode this provider is designed for. */
  readonly mode: EvalMode;

  /** Maximum concurrent evaluations this provider supports. */
  readonly maxConcurrency: number;

  /** Returns the promptfoo-compatible provider configuration. */
  getProviderConfig(): unknown;

  /**
   * Estimates the API cost for running a given number of test cases.
   * Local providers should return { estimatedUsd: 0 }.
   */
  estimateCost(testCount: number): CostEstimate;
}
