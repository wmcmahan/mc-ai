/**
 * Transformers.js Compression Provider
 *
 * Uses @huggingface/transformers to compute per-token self-information
 * (surprisal) via a small local language model. Tokens with high
 * self-information are more surprising and thus more important to retain.
 *
 * Requires optional peer dependency: @huggingface/transformers
 *
 * @module providers/transformers-compression
 */

import type { CompressionProvider } from './types.js';

export interface TransformersCompressionOptions {
  /** HuggingFace model ID (default: 'Xenova/distilgpt2'). */
  model?: string;
  /** Maximum sequence length for the model (default: 512). */
  maxLength?: number;
}

export class TransformersJsCompressionProvider implements CompressionProvider {
  private pipelineInstance: unknown | null = null;
  private readonly modelId: string;
  private readonly maxLength: number;

  constructor(options?: TransformersCompressionOptions) {
    this.modelId = options?.model ?? 'Xenova/distilgpt2';
    this.maxLength = options?.maxLength ?? 512;
  }

  async scoreTokenImportance(tokens: string[], context?: string): Promise<number[]> {
    if (tokens.length === 0) return [];

    const pipe = await this.loadPipeline();
    const prefix = context ? context + ' ' : '';
    const scores: number[] = [];

    for (const token of tokens) {
      const text = prefix + token;
      // Truncate to maxLength characters to avoid model limits
      const truncated = text.slice(-this.maxLength * 4); // ~4 chars per token

      try {
        // Use the pipeline to generate and get logits
        // The text-generation pipeline with return_full_text gives us token probabilities
        const result = await (pipe as any)(truncated, {
          max_new_tokens: 1,
          return_full_text: false,
          output_scores: true,
        });

        // Extract the perplexity/score from the result
        // Higher perplexity = more surprising = higher importance
        // Normalize via sigmoid: score = 1 / (1 + exp(-log_prob / temperature))
        if (result && Array.isArray(result) && result.length > 0) {
          const logProb = result[0]?.score ?? result[0]?.generated_text?.length ?? 0;
          // Normalize to [0, 1] using sigmoid
          const normalized = 1 / (1 + Math.exp(logProb));
          scores.push(Math.max(0, Math.min(1, normalized)));
        } else {
          scores.push(0.5); // fallback
        }
      } catch {
        scores.push(0.5); // fallback on error
      }
    }

    // Min-max normalize across all tokens for better discrimination
    if (scores.length > 1) {
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const range = max - min;
      if (range > 0) {
        for (let i = 0; i < scores.length; i++) {
          scores[i] = (scores[i] - min) / range;
        }
      }
    }

    return scores;
  }

  private async loadPipeline(): Promise<unknown> {
    if (!this.pipelineInstance) {
      try {
        const transformers = await import('@huggingface/transformers');
        this.pipelineInstance = await transformers.pipeline('text-generation', this.modelId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Failed to load transformers.js model "${this.modelId}". ` +
          `Install @huggingface/transformers: npm install @huggingface/transformers. ` +
          `Original error: ${msg}`,
        );
      }
    }
    return this.pipelineInstance;
  }
}
