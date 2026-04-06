/**
 * Ollama Provider
 *
 * Local LLM provider for no-cost dev evaluation runs.
 * Wraps an Ollama endpoint as a promptfoo-compatible provider.
 *
 * @module providers/ollama
 */

import type { EvalProvider, CostEstimate } from './types.js';

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

    getProviderConfig() {
      return {
        id: `ollama:chat:${model}`,
        config: {
          apiBaseUrl: `${baseUrl}/api`,
        },
      };
    },

    estimateCost(): CostEstimate {
      return { estimatedUsd: 0 };
    },
  };
}
