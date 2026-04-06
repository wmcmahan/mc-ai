/**
 * Deterministic Assertions
 *
 * Pure-function assertion helpers for numeric and structural checks.
 * These run without an LLM provider — fast, free, and deterministic.
 * Used by context-engine and memory suites for regression gating.
 *
 * @module assertions/deterministic
 */

/** Result of a single deterministic assertion. */
export interface DeterministicResult {
  /** Whether the assertion passed. */
  passed: boolean;
  /** Metric name (e.g., "compression_ratio", "budget_compliance"). */
  metric: string;
  /** The threshold or target value. */
  expected: number;
  /** The measured value. */
  actual: number;
  /** Human-readable description. */
  description: string;
}

/**
 * Assert that a measured value is greater than or equal to a threshold.
 * Used for: compression ratio checks, minimum coverage.
 */
export function assertGreaterThanOrEqual(
  metric: string,
  actual: number,
  threshold: number,
  description: string,
): DeterministicResult {
  return {
    passed: actual >= threshold,
    metric,
    expected: threshold,
    actual,
    description,
  };
}

/**
 * Assert that a measured value is less than or equal to a ceiling.
 * Used for: budget compliance, latency limits.
 */
export function assertLessThanOrEqual(
  metric: string,
  actual: number,
  ceiling: number,
  description: string,
): DeterministicResult {
  return {
    passed: actual <= ceiling,
    metric,
    expected: ceiling,
    actual,
    description,
  };
}

/**
 * Assert that a string output contains all specified keys.
 * Used for: information preservation after compression.
 */
export function assertContainsAllKeys(
  metric: string,
  output: string,
  keys: string[],
  description: string,
): DeterministicResult {
  const missing = keys.filter(k => !output.includes(k));
  return {
    passed: missing.length === 0,
    metric,
    expected: keys.length,
    actual: keys.length - missing.length,
    description: missing.length > 0
      ? `${description} — missing: ${missing.join(', ')}`
      : description,
  };
}

/**
 * Assert that two sets are equal.
 * Used for: retrieval precision, subgraph correctness.
 */
export function assertSetEquals(
  metric: string,
  actual: Set<string>,
  expected: Set<string>,
  description: string,
): DeterministicResult {
  const missing = [...expected].filter(x => !actual.has(x));
  const extra = [...actual].filter(x => !expected.has(x));
  const isEqual = missing.length === 0 && extra.length === 0;

  return {
    passed: isEqual,
    metric,
    expected: expected.size,
    actual: actual.size,
    description: isEqual
      ? description
      : `${description} — missing: [${missing.join(', ')}], extra: [${extra.join(', ')}]`,
  };
}

/**
 * Assert that multiple runs produce identical results (determinism check).
 * Used for: segmentation stability, format idempotency.
 */
export function assertStable(
  metric: string,
  results: unknown[],
  description: string,
): DeterministicResult {
  if (results.length < 2) {
    return {
      passed: true,
      metric,
      expected: 1,
      actual: 1,
      description,
    };
  }

  const serialized = results.map(r => JSON.stringify(r));
  const allEqual = serialized.every(s => s === serialized[0]);

  return {
    passed: allEqual,
    metric,
    expected: 1,
    actual: allEqual ? 1 : new Set(serialized).size,
    description: allEqual
      ? description
      : `${description} — ${new Set(serialized).size} distinct results across ${results.length} runs`,
  };
}

/**
 * Assert exact numeric equality.
 * Used for: dedup count verification, exact retrieval counts.
 */
export function assertEqual(
  metric: string,
  actual: number,
  expected: number,
  description: string,
): DeterministicResult {
  return {
    passed: actual === expected,
    metric,
    expected,
    actual,
    description,
  };
}
