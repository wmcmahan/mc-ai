/**
 * Ambient type declarations for the `jsonpath` package.
 *
 * The `jsonpath` npm package does not ship its own TypeScript types.
 * This declaration provides type safety for the subset of the API
 * used by the orchestrator (condition evaluation and value extraction).
 *
 * @see https://www.npmjs.com/package/jsonpath
 */
declare module 'jsonpath' {
  /** Execute a JSONPath query and return all matching values. */
  function query(obj: unknown, pathExpression: string): unknown[];
  /** Execute a JSONPath query and return the first matching value. */
  function value(obj: unknown, pathExpression: string): unknown;
  /** Return an array of paths (as string arrays) matching the expression. */
  function paths(obj: unknown, pathExpression: string): string[][];
  /** Convert a paths array back to a JSONPath string. */
  function stringify(paths: string[]): string;
  export default { query, value, paths, stringify };
}
