/**
 * Custom error class for the workflow architect subsystem.
 *
 * Thrown when graph generation fails after exhausting all retry attempts.
 *
 * @module architect/errors
 */

/**
 * Thrown when the architect fails to produce a valid workflow graph
 * after the configured number of self-correction attempts.
 *
 * @example
 * ```ts
 * throw new ArchitectError('Failed to generate a valid workflow after 3 attempts.');
 * ```
 */
export class ArchitectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchitectError';
  }
}
