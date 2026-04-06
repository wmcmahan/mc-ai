/**
 * Memory Hierarchy Input Types
 *
 * Lightweight interfaces for formatting pre-built memory payloads.
 * These mirror `@mcai/memory` shapes but contain only the fields
 * needed for formatting — no embedding, provenance, or store logic.
 *
 * Context-engine does NOT import @mcai/memory. Users map from
 * memory's types to these when passing data to formatters.
 *
 * @module memory/hierarchy/types
 */

// ─── Hierarchy Types (xMemory Levels) ─────────────────────────────

/** Theme — Level 3 of xMemory hierarchy (highest abstraction). */
export interface HierarchyTheme {
  id: string;
  label: string;
  description: string;
  fact_ids: string[];
}

/** Semantic fact — Level 2 of xMemory hierarchy. */
export interface HierarchyFact {
  id: string;
  content: string;
  source_episode_ids: string[];
  entity_ids: string[];
  theme_id?: string;
  valid_from: Date;
  valid_until?: Date;
}

/** Episode — Level 1 of xMemory hierarchy. */
export interface HierarchyEpisode {
  id: string;
  topic: string;
  messages: Array<{ role: string; content: string; timestamp: Date }>;
  started_at: Date;
  ended_at: Date;
  fact_ids: string[];
}

// ─── Graph Types ──────────────────────────────────────────────────

/** Entity — knowledge graph node. */
export interface GraphEntity {
  id: string;
  name: string;
  entity_type: string;
  attributes: Record<string, unknown>;
  invalidated_at?: Date;
}

/** Relationship — knowledge graph edge with temporal validity. */
export interface GraphRelationship {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
  attributes: Record<string, unknown>;
  valid_from: Date;
  valid_until?: Date;
}

// ─── Composite Types ──────────────────────────────────────────────

/**
 * Top-level input for memory formatters.
 * All arrays are optional — pass only what you have.
 */
export interface MemoryPayload {
  themes?: HierarchyTheme[];
  facts?: HierarchyFact[];
  episodes?: HierarchyEpisode[];
  entities?: GraphEntity[];
  relationships?: GraphRelationship[];
}

/** Pre-clustered community summary (from GraphRAG/Leiden). */
export interface CommunitySummary {
  id: string;
  label: string;
  summary: string;
  entity_ids: string[];
  level: number;
  weight?: number;
}
