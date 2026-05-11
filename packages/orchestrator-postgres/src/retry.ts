/**
 * Retry helpers for transient Postgres failures.
 *
 * The version increment used by `saveWorkflowState` and `saveWorkflowSnapshot`
 * is the classic `MAX(version) + 1` pattern, guarded by the
 * `uq_workflow_states_run_version` unique constraint. Under concurrent saves
 * for the same run (e.g. two GraphRunner instances racing on the same run_id,
 * or a foreground save colliding with a checkpoint write), all-but-one
 * transactions hit the unique violation and fail.
 *
 * This module retries those transient violations with exponential backoff +
 * jitter so the transient race becomes invisible to callers. Non-violation
 * errors propagate immediately.
 *
 * @module retry
 */

/** Postgres SQLSTATE for `unique_violation`. */
export const POSTGRES_UNIQUE_VIOLATION = '23505';

/** Default retry tuning. Operators rarely need to tune this. */
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 10;
const DEFAULT_MAX_DELAY_MS = 500;

export interface RetryOptions {
  /** Maximum retry attempts after the initial try. @default 5 */
  max_retries?: number;
  /** Base delay before the first retry (ms). @default 10 */
  base_delay_ms?: number;
  /** Cap on backoff delay (ms). @default 500 */
  max_delay_ms?: number;
  /**
   * Predicate identifying transient errors worth retrying. Defaults to the
   * Postgres `unique_violation` SQLSTATE check. Override to broaden (e.g. to
   * `serialization_failure` 40001 if you adopt SERIALIZABLE isolation).
   */
  is_transient?: (err: unknown) => boolean;
  /** Called on each retry with the attempt count and the swallowed error. */
  on_retry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/**
 * Detects the Postgres `unique_violation` SQLSTATE on common error shapes
 * (`node-postgres` exposes it as `err.code`).
 */
export function isPostgresUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === POSTGRES_UNIQUE_VIOLATION;
}

/**
 * Run `fn` with retry on transient errors (default: Postgres unique violation).
 *
 * Backoff is exponential with full jitter, capped at `max_delay_ms`. Returns
 * the resolved value of `fn`. Throws the last error if every retry is
 * exhausted, or the original error immediately when `is_transient` returns
 * false.
 *
 * `fn` is invoked once per attempt — make sure it is idempotent (re-reading
 * version, re-running the transaction). Do not pass a function that has
 * already mutated state outside the transaction.
 */
export async function retryOnTransient<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.max_retries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.base_delay_ms ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = options?.max_delay_ms ?? DEFAULT_MAX_DELAY_MS;
  const isTransient = options?.is_transient ?? isPostgresUniqueViolation;
  const onRetry = options?.on_retry;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !isTransient(err)) {
        throw err;
      }
      // Exponential backoff with full jitter (AWS-style):
      //   delay = random(0, min(maxDelay, baseDelay * 2^attempt))
      const exponent = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      const delay = Math.floor(Math.random() * exponent);
      onRetry?.(attempt + 1, err, delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw lastError;
}
