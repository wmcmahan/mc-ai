/**
 * Golden Dataset Schemas
 *
 * Zod schemas defining the structure of golden trajectories, tool calls,
 * and the dataset manifest. These schemas are the source of truth for
 * all data flowing through the eval harness.
 *
 * @module dataset/schema
 */

import { z } from 'zod';

// ─── Tool Call Schema ──────────────────────────────────────────────

/**
 * Schema for an expected tool call within a golden trajectory.
 *
 * `args` is validated structurally (correct keys and types), NOT by
 * exact string value. `expectedArgSchema` is a JSON Schema object
 * representation (not a Zod runtime object) since it must be
 * serializable to SQLite. Convert to Zod at assertion time.
 */
export const ToolCallSchema = z.object({
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  expectedArgSchema: z.record(z.string(), z.unknown()).optional(),
});

// ─── Golden Trajectory Schema ──────────────────────────────────────

/** Supported eval suite names. */
export const SuiteNameSchema = z.enum(['context-engine', 'memory', 'orchestrator', 'integration']);

/** Provenance of a golden trajectory. */
export const TrajectorySourceSchema = z.enum(['webarena', 'internal']);

/**
 * Schema for a single golden trajectory — the atomic unit of evaluation.
 *
 * Each trajectory captures an input, expected output, and optional tool
 * call expectations for one eval test case.
 *
 * `expectedToolCalls` semantics:
 * - `undefined` — skip tool call assertions entirely
 * - `[]` (empty array) — assert that no tool calls were made
 */
export const GoldenTrajectorySchema = z.object({
  id: z.string().uuid(),
  suite: SuiteNameSchema,
  description: z.string(),
  input: z.string(),
  expectedOutput: z.union([z.string(), z.record(z.string(), z.unknown())]),
  expectedToolCalls: z.array(ToolCallSchema).optional(),
  tags: z.array(z.string()).optional(),
  source: TrajectorySourceSchema,
  createdAt: z.string().datetime(),
});

// ─── Manifest Schemas ──────────────────────────────────────────────

/**
 * Schema for a single dataset entry in the manifest.
 * Maps a trajectory set to its compressed SQLite file.
 */
export const ManifestEntrySchema = z.object({
  name: z.string(),
  file: z.string(),
  sha256: z.string(),
  trajectoryCount: z.number().int().nonnegative(),
  schemaVersion: z.string(),
  lastUpdated: z.string().datetime(),
});

/**
 * Schema for the golden dataset manifest (`golden/manifest.json`).
 * Registry of all trajectory sets, their versions, and checksums.
 */
export const ManifestSchema = z.object({
  version: z.string(),
  datasets: z.array(ManifestEntrySchema),
});
