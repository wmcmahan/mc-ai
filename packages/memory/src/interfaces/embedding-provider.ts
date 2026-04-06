/**
 * Embedding Provider Interface
 *
 * Consumers inject their own embedding implementation (OpenAI, Anthropic,
 * local models, etc.). This package never couples to a specific provider.
 *
 * @module interfaces/embedding-provider
 */

export interface EmbeddingProvider {
  /** Embed a single text string. */
  embed(text: string): Promise<number[]>;

  /** Embed multiple texts in a single batch call. */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** The dimensionality of produced embeddings. */
  readonly dimensions: number;
}
