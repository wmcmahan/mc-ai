/**
 * Relationship Schema — Knowledge Graph Edges
 *
 * Directed, weighted edges between entities with temporal validity.
 * Facts have validity windows — old facts are invalidated, not deleted.
 * Implements the Zep temporal knowledge graph pattern.
 *
 * @module schemas/relationship
 */

import { z } from 'zod';
import { ProvenanceSchema } from './provenance.js';

export const RelationshipSchema = z.object({
  /** Unique relationship identifier. */
  id: z.string().uuid(),
  /** Source entity ID (edge origin). */
  source_id: z.string().uuid(),
  /** Target entity ID (edge destination). */
  target_id: z.string().uuid(),
  /** Relationship type (e.g. `"works_at"`, `"authored"`, `"depends_on"`). */
  relation_type: z.string().min(1),
  /** Edge weight (0–1, default 1). */
  weight: z.number().min(0).max(1).default(1),
  /** Open-ended attributes. */
  attributes: z.record(z.string(), z.unknown()).default({}),
  /** When this relationship became valid. */
  valid_from: z.coerce.date(),
  /** When this relationship ceased to be valid (`undefined` = still valid). */
  valid_until: z.coerce.date().optional(),
  /** Origin metadata. */
  provenance: ProvenanceSchema,
  /** ID of the relationship that invalidated this one. */
  invalidated_by: z.string().uuid().optional(),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

/** Input shape for creating a relationship (no `id` required). */
export type RelationshipInput = Omit<Relationship, 'id'> & { id?: string };
