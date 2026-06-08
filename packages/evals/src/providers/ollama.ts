/**
 * Ollama Provider
 *
 * Local LLM judge provider for no-cost dev evaluation runs. Wraps an
 * Ollama endpoint as an {@link EvalProvider} so the SUT-driven semantic
 * track can call it via `callJudge`.
 *
 * @module providers/ollama
 */

import type { EvalProvider, CostEstimate, CallJudgeOptions } from './types.js';

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/** Options for creating the Ollama provider. */
export interface OllamaProviderOptions {
  /** Ollama server base URL (default: OLLAMA_BASE_URL env or http://localhost:11434). */
  baseUrl?: string;

  /** Model to use (default: OLLAMA_MODEL env or llama3:8b-instruct-q4_K_M). */
  model?: string;

  /** Max concurrent evaluations (default: 2). */
  maxConcurrency?: number;
}

/**
 * Creates an Ollama eval provider for local development.
 */
export function createOllamaProvider(options: OllamaProviderOptions = {}): EvalProvider {
  const baseUrl = options.baseUrl
    ?? process.env['OLLAMA_BASE_URL']
    ?? 'http://localhost:11434';
  const model = options.model
    ?? process.env['OLLAMA_MODEL']
    ?? 'llama3:8b-instruct-q4_K_M';
  const maxConcurrency = options.maxConcurrency ?? 2;

  return {
    name: `ollama-${model}`,
    mode: 'local',
    maxConcurrency,

    async callJudge(prompt: string, options: CallJudgeOptions = {}): Promise<string> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `Ollama callJudge failed: HTTP ${response.status} ${response.statusText}`,
          );
        }

        const body = await response.json() as { response?: unknown };
        if (typeof body.response !== 'string') {
          throw new Error(
            `Ollama callJudge: unexpected response shape (missing string \`response\` field)`,
          );
        }
        return body.response;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Ollama callJudge timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },

    estimateCost(): CostEstimate {
      return { estimatedUsd: 0 };
    },
  };
}
