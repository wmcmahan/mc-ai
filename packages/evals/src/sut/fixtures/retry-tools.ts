/**
 * Retry Tool Fixtures
 *
 * Factories that produce stateful tool-response functions for the
 * mock resolver. Each factory closes over a counter so successive calls
 * within one trajectory recording return different results (failures,
 * then a success). The closures are not safe for concurrent re-use —
 * build a fresh fixture per trajectory.
 *
 * @module sut/fixtures/retry-tools
 */

import type { ToolResponseFn } from '../types.js';

/** Options for the flaky-fetch fixture. */
export interface FlakyFetchOptions {
  /** Number of failed attempts before the tool succeeds (default: 2). */
  failuresBeforeSuccess?: number;

  /**
   * Ordered list of error messages to return on failed attempts. If shorter
   * than `failuresBeforeSuccess`, the last message is repeated. Defaults
   * to a timeout + a 503.
   */
  failureMessages?: string[];

  /** Body returned on the successful attempt. */
  successResult?: Record<string, unknown>;
}

/**
 * Build a `flaky_fetch` tool response that fails the first N calls then
 * returns a stable success. The returned function is a closure — call
 * `createFlakyFetch(...)` once per trajectory recording.
 */
export function createFlakyFetch(opts: FlakyFetchOptions = {}): ToolResponseFn {
  const failuresBeforeSuccess = opts.failuresBeforeSuccess ?? 2;
  const failureMessages = opts.failureMessages ?? [
    'timeout after 5000ms',
    '503 Service Unavailable',
  ];
  const successResult = opts.successResult ?? {
    status: 200,
    body: 'OK: data fetched successfully',
  };

  let attempt = 0;
  return (_args) => {
    const current = attempt++;
    if (current < failuresBeforeSuccess) {
      const message =
        failureMessages[Math.min(current, failureMessages.length - 1)];
      return { error: message, attempt: current + 1, status: 'failed' };
    }
    return { ...successResult, attempt: current + 1, status: 'ok' };
  };
}

/**
 * Build a `rate_limited_call` tool response that pauses (returns a
 * rate-limit indicator) every Nth call. Used for rate-limit retry
 * trajectories where the model is expected to back off and continue.
 */
export interface RateLimitedOptions {
  /** Total number of successful responses to deliver before stopping (default: 5). */
  totalCalls?: number;

  /** Insert a rate-limit response every Nth call (default: 3). */
  rateLimitEvery?: number;
}

export function createRateLimitedCall(opts: RateLimitedOptions = {}): ToolResponseFn {
  const totalCalls = opts.totalCalls ?? 5;
  const rateLimitEvery = opts.rateLimitEvery ?? 3;

  let successCount = 0;
  let attempt = 0;
  return (_args) => {
    attempt++;
    if (attempt % rateLimitEvery === 0 && successCount < totalCalls) {
      return {
        status: 429,
        error: 'rate limit exceeded; retry after 1s',
        attempt,
      };
    }
    if (successCount >= totalCalls) {
      return { status: 'done', message: `Completed ${successCount} calls`, attempt };
    }
    successCount++;
    return { status: 200, attempt, completed: successCount, total: totalCalls };
  };
}
