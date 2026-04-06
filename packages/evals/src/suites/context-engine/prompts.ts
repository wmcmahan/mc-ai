/**
 * Context Engine Suite — Prompt Templates
 *
 * Frozen prompt templates for the semantic eval track.
 * These are used as LLM-as-judge rubrics to evaluate whether
 * compressed context produces semantically equivalent responses.
 *
 * @module suites/context-engine/prompts
 */

/**
 * Tests whether an LLM can extract the same answer from compressed
 * context as from the original uncompressed version.
 */
export const COMPRESSION_EQUIVALENCE_PROMPT = `You are an AI assistant. Answer the following question using ONLY the provided context.

Context:
{{compressed_context}}

Question: {{question}}

Answer concisely and accurately based only on the context provided.`;

/**
 * Tests whether an LLM can extract specific data points from
 * format-compressed data (YAML-like, tabular, key-value).
 */
export const INFORMATION_EXTRACTION_PROMPT = `You are an AI assistant. Given the following data, answer the question precisely.

Data:
{{compressed_data}}

Question: {{question}}

Answer with specific values from the data.`;
