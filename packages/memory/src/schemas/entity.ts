/**
 * Entity Schema — Knowledge Graph Nodes
 *
 * Represents a discrete concept, person, organization, or object
 * in the agent's world model. Entities are the nodes of the
 * knowledge graph; relationships are the edges.
 *
 * @module schemas/entity
 */

import { z } from 'zod';
import { ProvenanceSchema } from './provenance.js';

export const EntitySchema = z.object({
  /** Unique entity identifier. */
  id: z.string().uuid(),
  /** Human-readable entity name. */
  name: z.string().min(1),
  /** Categorical type (e.g. `"person"`, `"organization"`, `"concept"`). */
  entity_type: z.string().min(1),
  /** Open-ended attributes. */
  attributes: z.record(z.string(), z.unknown()).default({}),
  /** Optional embedding vector (dimension-agnostic). */
  embedding: z.array(z.number()).optional(),
  /** Origin metadata. */
  provenance: ProvenanceSchema,
  /** When this entity was first recorded. */
  created_at: z.coerce.date(),
  /** When this entity was last modified. */
  updated_at: z.coerce.date(),
  /** When this entity was invalidated (soft delete). */
  invalidated_at: z.coerce.date().optional(),
  /** ID of the entity that supersedes this one. */
  superseded_by: z.string().uuid().optional(),
});

export type Entity = z.infer<typeof EntitySchema>;

/** Input shape for creating an entity (no `id` required — auto-generated). */
export type EntityInput = Omit<Entity, 'id'> & { id?: string };
