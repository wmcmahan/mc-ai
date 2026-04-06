/**
 * Temporal Filter Utilities
 *
 * Filter records by temporal validity windows. Works on any record
 * with `valid_from` and optional `valid_until` fields (Relationship,
 * SemanticFact).
 *
 * @module retrieval/temporal-filter
 */

/** A record with temporal validity fields. */
export interface TemporalRecord {
  valid_from: Date;
  valid_until?: Date;
  invalidated_by?: string;
}

/** Filter options for temporal queries. */
export interface TemporalFilterOptions {
  valid_at?: Date;
  changed_since?: Date;
  include_invalidated?: boolean;
}

/**
 * Check if a record is valid at a specific point in time.
 *
 * A record is valid when `valid_from <= date` and either
 * `valid_until` is not set or `valid_until > date`.
 */
export function isValidAt(record: TemporalRecord, date: Date): boolean {
  if (record.valid_from > date) return false;
  if (record.valid_until && record.valid_until <= date) return false;
  return true;
}

/**
 * Check if a record changed after a specific point in time.
 *
 * A record "changed" if it became valid after the date or
 * was invalidated after the date.
 */
export function isChangedSince(record: TemporalRecord, date: Date): boolean {
  if (record.valid_from > date) return true;
  if (record.valid_until && record.valid_until > date) return true;
  return false;
}

/**
 * Filter a list of temporal records by validity and recency.
 */
export function filterValid<T extends TemporalRecord>(
  records: T[],
  opts: TemporalFilterOptions = {},
): T[] {
  const { valid_at, changed_since, include_invalidated = false } = opts;

  return records.filter((record) => {
    if (!include_invalidated && record.invalidated_by) return false;
    if (valid_at && !isValidAt(record, valid_at)) return false;
    if (changed_since && !isChangedSince(record, changed_since)) return false;
    return true;
  });
}
