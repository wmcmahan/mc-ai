/**
 * Semantic Fact Schema
 *
 * Level 2 of the xMemory hierarchy. Atomic facts distilled from
 * episodes — each fact is a single, self-contained piece of knowledge.
 * Facts have temporal validity and can be invalidated without deletion.
 *
 * @module schemas/semantic
 */

import { z } from 'zod';
import { ProvenanceSchema } from './provenance.js';

export const SemanticFactSchema = z.object({
  /** Unique fact identifier. */
  id: z.string().uuid(),
  /** Natural language atomic fact (e.g. "Alice works at Acme Corp"). */
  content: z.string().min(1),
  /** Episode IDs this fact was extracted from. */
  source_episode_ids: z.array(z.string().uuid()).default([]),
  /** Entity IDs referenced by this fact. */
  entity_ids: z.array(z.string().uuid()).default([]),
  /** Theme this fact belongs to (assigned during clustering). */
  theme_id: z.string().uuid().optional(),
  /** Optional embedding vector. */
  embedding: z.array(z.number()).optional(),
  /** Origin metadata. */
  provenance: ProvenanceSchema,
  /** When this fact became valid. */
  valid_from: z.coerce.date(),
  /** When this fact ceased to be valid (`undefined` = still valid). */
  valid_until: z.coerce.date().optional(),
  /** ID of the fact that invalidated this one, or a descriptive reason. */
  invalidated_by: z.string().optional(),
  /** Number of times this fact has been accessed. */
  access_count: z.number().int().nonnegative().default(0).optional(),
  /** When this fact was last accessed. */
  last_accessed_at: z.coerce.date().optional(),
});

export type SemanticFact = z.infer<typeof SemanticFactSchema>;

/** Input shape for creating a fact (no `id` required). */
export type SemanticFactInput = Omit<SemanticFact, 'id'> & { id?: string };
