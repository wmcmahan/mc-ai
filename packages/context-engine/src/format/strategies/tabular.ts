/**
 * Tabular Serialization Strategy
 *
 * TOON-inspired header + rows format for uniform object arrays.
 * Produces a compact representation with column headers on the first
 * line and values on subsequent lines.
 *
 * @module format/strategies/tabular
 */

/**
 * Serialize a uniform array of objects into tabular format.
 *
 * @example
 * ```ts
 * serializeTabular([
 *   { name: 'Alice', role: 'researcher', score: 92 },
 *   { name: 'Bob', role: 'writer', score: 87 },
 * ]);
 * // => "@name @role @score\nAlice researcher 92\nBob writer 87"
 * ```
 */
export function serializeTabular(data: Record<string, unknown>[]): string {
  if (data.length === 0) return '';

  const keys = Object.keys(data[0]);
  const header = keys.map(k => `@${k}`).join(' ');

  const rows = data.map(row =>
    keys.map(k => formatCellValue(row[k])).join(' '),
  );

  return [header, ...rows].join('\n');
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '_';

  if (Array.isArray(value)) {
    return value.map(v => formatPrimitive(v)).join(';');
  }

  if (typeof value === 'object') {
    // Nested object: key=value pairs
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${formatPrimitive(v)}`)
      .join(',');
  }

  return formatPrimitive(value);
}

function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) return '_';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
