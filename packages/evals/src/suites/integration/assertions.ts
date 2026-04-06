/**
 * Integration Suite — Assertion Helpers
 *
 * Integration-specific assertion helpers for cross-package flow testing.
 *
 * @module suites/integration/assertions
 */

/**
 * Asserts that a compressed string preserves all given entity names.
 *
 * @param compressed - The compressed output string.
 * @param entityNames - Entity names that should appear in the output.
 * @returns True if all entity names are found.
 */
export function assertFactPreservation(compressed: string, entityNames: string[]): boolean {
  return entityNames.every(name => compressed.includes(name));
}
