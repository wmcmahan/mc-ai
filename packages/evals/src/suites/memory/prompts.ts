/**
 * Memory Suite — Prompt Templates
 *
 * Frozen prompt templates for the semantic eval track.
 * Used as LLM-as-judge rubrics to evaluate whether retrieved
 * memory helps produce correct answers.
 *
 * @module suites/memory/prompts
 */

/**
 * Tests whether retrieved memory enables correct factual Q&A.
 */
export const MEMORY_QA_PROMPT = `You are an AI assistant with access to a knowledge graph. Use the following retrieved memory to answer the question.

Retrieved Memory:
{{memory_context}}

Question: {{question}}

Answer based only on the retrieved memory. Be concise and specific.`;

/**
 * Tests whether the LLM can reason about temporal validity windows.
 */
export const TEMPORAL_REASONING_PROMPT = `Given the following facts with temporal validity, answer the question as of the specified date.

Facts:
{{temporal_facts}}

As of date: {{as_of_date}}
Question: {{question}}

Consider which facts are currently valid and answer accordingly.`;
