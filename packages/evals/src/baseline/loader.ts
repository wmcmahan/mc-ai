/**
 * Baseline Loader
 *
 * Reads the most-recent baseline snapshot, if one exists. Returns `null`
 * (not throws) on missing-file so callers can distinguish "first run, no
 * baseline yet" from genuine corruption.
 *
 * Schema-version mismatches and JSON parse errors do throw — those
 * indicate either drift in the snapshot format or a hand-edited file
 * that won't round-trip cleanly.
 *
 * @module baseline/loader
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_SCHEMA_VERSION,
  type BaselineSnapshot,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN_DIR = resolve(__dirname, '../../golden');

/**
 * Load the most-recent baseline from `golden/baselines/main-latest.json`.
 *
 * @param goldenDir - Optional override for the golden directory root.
 * @returns The parsed snapshot, or `null` if no baseline file exists.
 * @throws If the file exists but fails to parse or has an unknown schema version.
 */
export function loadBaseline(
  goldenDir: string = DEFAULT_GOLDEN_DIR,
): BaselineSnapshot | null {
  const path = resolve(goldenDir, 'baselines', 'main-latest.json');
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as BaselineSnapshot;

  if (parsed.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Baseline schema version mismatch at ${path}: expected ${BASELINE_SCHEMA_VERSION}, got ${parsed.schemaVersion}`,
    );
  }

  return parsed;
}
