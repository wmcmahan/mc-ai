/**
 * Theme Schema
 *
 * Level 3 of the xMemory hierarchy. Themes are clusters of related
 * semantic facts — the highest level of abstraction. Top-down
 * retrieval starts here and drills down only as needed.
 *
 * @module schemas/theme
 */

import { z } from 'zod';
import { ProvenanceSchema } from './provenance.js';

export const ThemeSchema = z.object({
  /** Unique theme identifier. */
  id: z.string().uuid(),
  /** Short label (e.g. "Project Architecture", "Team Members"). */
  label: z.string().min(1),
  /** Longer description of what this theme covers. */
  description: z.string().default(''),
  /** IDs of semantic facts in this theme. */
  fact_ids: z.array(z.string().uuid()).default([]),
  /** Optional embedding vector (centroid of member facts). */
  embedding: z.array(z.number()).optional(),
  /** Origin metadata. */
  provenance: ProvenanceSchema,
});

export type Theme = z.infer<typeof ThemeSchema>;

/** Input shape for creating a theme (no `id` required). */
export type ThemeInput = Omit<Theme, 'id'> & { id?: string };
