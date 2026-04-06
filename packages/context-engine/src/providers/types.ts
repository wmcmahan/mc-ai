/**
 * Provider Interfaces
 *
 * Defines the injection points for optional capabilities. The engine
 * works without any providers (Tier 0) but gains power as providers
 * are supplied. All interfaces are synchronous where possible; async
 * only when the operation genuinely requires I/O.
 *
 * @module providers/types
 */

/**
 * Counts tokens in a text string. The engine uses this for budget
 * allocation and per-stage metrics.
 *
 * Built-in: model-family ratio estimator (no dependencies).
 * Optional: tiktoken, gpt-tokenizer, or model-specific tokenizer.
 */
export interface TokenCounter {
  countTokens(text: string, model?: string): number;
}

/**
 * Scores token importance for pruning. Higher scores = more important.
 *
 * Built-in: noop (uniform scores — no pruning).
 * Optional: perplexity scoring via small local model, LLMLingua-2 adapter.
 */
export interface CompressionProvider {
  scoreTokenImportance(tokens: string[], context?: string): Promise<number[]>;
}

/**
 * Generates embedding vectors for semantic operations (dedup, similarity).
 *
 * No built-in default — semantic features are disabled without this.
 * Optional: local embedding model, OpenAI, Anthropic, etc.
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/**
 * Summarizes text to fit a token budget.
 *
 * No built-in default — summarization features are disabled without this.
 * Optional: any LLM endpoint.
 */
export interface SummarizationProvider {
  summarize(text: string, maxTokens: number): Promise<string>;
}
