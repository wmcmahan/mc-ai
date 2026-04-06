/**
 * Memory Retriever
 *
 * Optional function injected via GraphRunnerOptions to retrieve
 * relevant memory facts for prompt construction. Follows the same
 * adapter pattern as ContextCompressor — the orchestrator defines
 * the type, the user provides the implementation.
 *
 * @module agent/memory-retriever
 */

/** Result of a memory retrieval call. */
export interface MemoryRetrievalResult {
  /** Relevant facts with their validity timestamps. */
  facts: Array<{ content: string; validFrom: Date }>;
  /** Entities referenced by the facts. */
  entities: Array<{ name: string; type: string }>;
  /** High-level themes the facts belong to. */
  themes: Array<{ label: string }>;
}

/**
 * Retrieves relevant memory for injection into agent prompts.
 *
 * @param query - What to retrieve: text for semantic search, entityIds for graph lookup.
 * @param options - Optional constraints.
 * @returns Retrieved memory, or null to skip injection.
 */
export type MemoryRetriever = (
  query: { text?: string; entityIds?: string[] },
  options?: { maxFacts?: number; model?: string },
) => Promise<MemoryRetrievalResult | null>;
