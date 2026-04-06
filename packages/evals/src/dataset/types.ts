/**
 * Golden Dataset Types
 *
 * TypeScript types inferred from the Zod schemas in `schema.ts`.
 * Always import types from here, not from the schema module directly.
 *
 * @module dataset/types
 */

import type { z } from 'zod';
import type {
  ToolCallSchema,
  GoldenTrajectorySchema,
  SuiteNameSchema,
  TrajectorySourceSchema,
  ManifestEntrySchema,
  ManifestSchema,
} from './schema.js';

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type GoldenTrajectory = z.infer<typeof GoldenTrajectorySchema>;
export type SuiteName = z.infer<typeof SuiteNameSchema>;
export type TrajectorySource = z.infer<typeof TrajectorySourceSchema>;
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
