/**
 * Graph Serializer
 *
 * Formats entity-relationship subgraphs into compact prompt format.
 * Auto-detects between tabular (uniform entity types) and adjacency
 * list (mixed types) representations.
 *
 * @module memory/graph/serializer
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';
import type { GraphEntity, GraphRelationship } from '../hierarchy/types.js';

export interface GraphSerializerOptions {
  /** Force a specific serialization mode. */
  mode?: 'tabular' | 'adjacency';
  /** Include invalidated entities (default: false). */
  includeInvalidated?: boolean;
  /** Include expired relationships (default: false). */
  includeExpired?: boolean;
  /** Maximum entities per type to include (default: 50). */
  maxEntitiesPerType?: number;
  /** Maximum relationships to include (default: 100). */
  maxRelationships?: number;
}

/**
 * Serialize entities and relationships into a compact prompt format.
 */
export function serializeGraph(
  entities: GraphEntity[],
  relationships: GraphRelationship[],
  options?: GraphSerializerOptions,
): string {
  const includeInvalidated = options?.includeInvalidated ?? false;
  const includeExpired = options?.includeExpired ?? false;
  const maxPerType = options?.maxEntitiesPerType ?? 50;
  const maxRels = options?.maxRelationships ?? 100;

  // Filter
  const activeEntities = includeInvalidated
    ? entities
    : entities.filter(e => !e.invalidated_at);

  const now = new Date();
  const activeRels = includeExpired
    ? relationships
    : relationships.filter(r => !r.valid_until || r.valid_until > now);

  // Build ID→name map
  const nameMap = new Map<string, string>();
  for (const e of activeEntities) {
    nameMap.set(e.id, e.name);
  }

  const mode = options?.mode ?? detectMode(activeEntities);

  if (mode === 'tabular') {
    return serializeTabularGraph(activeEntities, activeRels, nameMap, maxPerType, maxRels);
  }
  return serializeAdjacencyGraph(activeEntities, activeRels, nameMap, maxPerType, maxRels);
}

/**
 * Create a pipeline stage that serializes graph data.
 * Detects segments with `metadata.contentType === 'graph'`.
 */
export function createGraphSerializerStage(options?: GraphSerializerOptions): CompressionStage {
  return {
    name: 'graph-serializer',
    execute(segments: PromptSegment[], _context: StageContext) {
      return {
        segments: segments.map(seg => {
          if (seg.metadata?.contentType !== 'graph') return seg;

          try {
            const parsed = JSON.parse(seg.content) as { entities?: GraphEntity[]; relationships?: GraphRelationship[] };
            const formatted = serializeGraph(
              parsed.entities ?? [],
              parsed.relationships ?? [],
              options,
            );
            return { ...seg, content: formatted };
          } catch {
            return seg;
          }
        }),
      };
    },
  };
}

// ─── Mode Detection ───────────────────────────────────────────────

function detectMode(entities: GraphEntity[]): 'tabular' | 'adjacency' {
  // Group by type
  const byType = new Map<string, GraphEntity[]>();
  for (const e of entities) {
    const list = byType.get(e.entity_type) ?? [];
    list.push(e);
    byType.set(e.entity_type, list);
  }

  // Tabular if at least one type group has uniform attribute keys
  for (const [, group] of byType) {
    if (group.length < 2) continue;
    const refKeys = Object.keys(group[0].attributes).sort().join(',');
    const uniform = group.every(e => Object.keys(e.attributes).sort().join(',') === refKeys);
    if (uniform && refKeys.length > 0) return 'tabular';
  }

  return 'adjacency';
}

// ─── Tabular Serialization ────────────────────────────────────────

function serializeTabularGraph(
  entities: GraphEntity[],
  relationships: GraphRelationship[],
  nameMap: Map<string, string>,
  maxPerType: number,
  maxRels: number,
): string {
  const lines: string[] = [];

  // Group entities by type
  const byType = new Map<string, GraphEntity[]>();
  for (const e of entities) {
    const list = byType.get(e.entity_type) ?? [];
    list.push(e);
    byType.set(e.entity_type, list);
  }

  for (const [type, group] of byType) {
    const limited = group.slice(0, maxPerType);
    const attrKeys = Object.keys(limited[0].attributes);

    lines.push(`Entities (${type}):`);
    lines.push(`@name ${attrKeys.map(k => `@${k}`).join(' ')}`);

    for (const e of limited) {
      const values = attrKeys.map(k => formatValue(e.attributes[k]));
      lines.push(`${e.name} ${values.join(' ')}`);
    }
    lines.push('');
  }

  // Relationships
  if (relationships.length > 0) {
    const limited = relationships.slice(0, maxRels);
    lines.push('Relationships:');
    lines.push('@source @relation @target @weight');
    for (const r of limited) {
      const source = nameMap.get(r.source_id) ?? r.source_id;
      const target = nameMap.get(r.target_id) ?? r.target_id;
      lines.push(`${source} ${r.relation_type} ${target} ${r.weight}`);
    }
  }

  return lines.join('\n').trim();
}

// ─── Adjacency Serialization ──────────────────────────────────────

function serializeAdjacencyGraph(
  entities: GraphEntity[],
  relationships: GraphRelationship[],
  nameMap: Map<string, string>,
  maxPerType: number,
  maxRels: number,
): string {
  // Build adjacency from relationships
  const outgoing = new Map<string, Array<{ target: string; relation: string; weight: number }>>();
  const limited = relationships.slice(0, maxRels);

  for (const r of limited) {
    const list = outgoing.get(r.source_id) ?? [];
    list.push({
      target: nameMap.get(r.target_id) ?? r.target_id,
      relation: r.relation_type,
      weight: r.weight,
    });
    outgoing.set(r.source_id, list);
  }

  const lines: string[] = [];
  let count = 0;

  for (const e of entities) {
    if (count >= maxPerType * 10) break; // global cap
    count++;

    const edges = outgoing.get(e.id) ?? [];
    const attrs = Object.entries(e.attributes)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(', ');

    const edgeStr = edges.length > 0
      ? edges.map(ed => `${ed.relation} -> ${ed.target} [${ed.weight}]`).join(', ')
      : '';

    const parts = [`${e.name} (${e.entity_type})`];
    if (edgeStr) parts.push(edgeStr);
    if (attrs) parts.push(attrs);

    lines.push(parts.join(': '));
  }

  return lines.join('\n');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '_';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
