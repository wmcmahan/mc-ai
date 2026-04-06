/**
 * Built-in Calibration Data
 *
 * Pre-scored examples for calibrating LLM-as-judge metrics.
 * Each set contains 3 examples spanning the score range (low, medium, high)
 * to detect systematic judge bias.
 *
 * @module assertions/calibration-data
 */

import type { CalibrationExample } from './semantic-judge.js';

// ─── Answer Relevancy ─────────────────────────────────────────────

export const ANSWER_RELEVANCY_CALIBRATION: CalibrationExample[] = [
  {
    input: 'What is the capital of France?',
    expectedOutput: 'Paris is the capital of France.',
    actualOutput: 'The capital of France is Paris, a major European city situated on the River Seine.',
    groundTruthScore: 0.95,
  },
  {
    input: 'Explain the difference between TCP and UDP.',
    expectedOutput: 'TCP is connection-oriented and reliable; UDP is connectionless and faster but unreliable.',
    actualOutput: 'TCP provides ordered, error-checked delivery over a connection. UDP sends datagrams without establishing a connection, offering lower latency at the cost of reliability.',
    groundTruthScore: 0.90,
  },
  {
    input: 'What is the capital of France?',
    expectedOutput: 'Paris is the capital of France.',
    actualOutput: 'France is a country in Western Europe known for its wine and cheese.',
    groundTruthScore: 0.15,
  },
];

// ─── Faithfulness ─────────────────────────────────────────────────

export const FAITHFULNESS_CALIBRATION: CalibrationExample[] = [
  {
    input: 'Who founded Microsoft?',
    expectedOutput: 'Bill Gates and Paul Allen co-founded Microsoft in 1975.',
    actualOutput: 'Microsoft was co-founded by Bill Gates and Paul Allen in Albuquerque, New Mexico in 1975.',
    groundTruthScore: 0.95,
  },
  {
    input: 'What year did World War II end?',
    expectedOutput: 'World War II ended in 1945.',
    actualOutput: 'The Second World War concluded in 1945 with the surrender of Japan.',
    groundTruthScore: 0.90,
  },
  {
    input: 'Who founded Microsoft?',
    expectedOutput: 'Bill Gates and Paul Allen co-founded Microsoft in 1975.',
    actualOutput: 'Microsoft was founded by Steve Jobs in 1976 in Silicon Valley.',
    groundTruthScore: 0.05,
  },
];

// ─── Logical Coherence ────────────────────────────────────────────

export const LOGICAL_COHERENCE_CALIBRATION: CalibrationExample[] = [
  {
    input: 'Should we use a SQL or NoSQL database for our user profiles?',
    expectedOutput: 'SQL is better for structured user profile data with relationships.',
    actualOutput: 'For user profiles with well-defined schemas and relationships between users, a SQL database provides strong consistency guarantees and efficient joins. If the profile schema varies significantly per user, NoSQL offers more flexibility. Given that user profiles typically have a stable schema, SQL is the better choice.',
    groundTruthScore: 0.95,
  },
  {
    input: 'Is it better to use recursion or iteration for this problem?',
    expectedOutput: 'Iteration is generally more efficient for simple loops.',
    actualOutput: 'Recursion makes the code more elegant. However, iteration uses less memory. Therefore, recursion is always better because it is elegant. But iteration is faster. So we should use recursion for performance.',
    groundTruthScore: 0.20,
  },
  {
    input: 'Explain why caching improves performance.',
    expectedOutput: 'Caching stores frequently accessed data closer to the consumer, reducing latency.',
    actualOutput: 'Caching improves performance by storing results of expensive computations or frequently accessed data in a faster storage layer. Subsequent requests for the same data are served from cache instead of recomputing or fetching from the slower source, reducing latency and backend load.',
    groundTruthScore: 0.92,
  },
];

/** All built-in calibration sets indexed by metric name. */
const CALIBRATION_SETS: Record<string, CalibrationExample[]> = {
  answer_relevancy: ANSWER_RELEVANCY_CALIBRATION,
  faithfulness: FAITHFULNESS_CALIBRATION,
  logical_coherence: LOGICAL_COHERENCE_CALIBRATION,
};

/**
 * Get the calibration set for a built-in metric by name.
 * Returns an empty array for unknown metric names.
 */
export function getCalibrationSet(metricName: string): CalibrationExample[] {
  return CALIBRATION_SETS[metricName] ?? [];
}
