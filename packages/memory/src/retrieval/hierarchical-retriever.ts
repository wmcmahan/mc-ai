/**
 * Hierarchical Retriever
 *
 * Implements xMemory top-down retrieval: themes → facts → episodes.
 * Queries start at the highest abstraction level and drill down
 * only as needed, producing compact, relevant context.
 *
 * Also supports entity-based subgraph retrieval for graph queries.
 *
 * @module retrieval/hierarchical-retriever
 */

import type { MemoryQuery, MemoryResult } from '../schemas/query.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Entity } from '../schemas/entity.js';
import type { Theme } from '../schemas/theme.js';
import type { Episode } from '../schemas/episode.js';
import type { Relationship } from '../schemas/relationship.js';
import type { MemoryStore } from '../interfaces/memory-store.js';
import type { MemoryIndex } from '../interfaces/memory-index.js';
import { extractSubgraph } from './subgraph-extractor.js';
import { filterValid } from './temporal-filter.js';

/**
 * Retrieve memory using hierarchical top-down search.
 *
 * Strategy:
 * - If query has `entity_ids`: use subgraph extraction, then attach related facts/themes
 * - If query has `embedding`: search themes by similarity, expand to facts → episodes
 * - Both paths apply temporal filtering and respect limits
 */
export async function retrieveMemory(
  store: MemoryStore,
  index: MemoryIndex,
  query: MemoryQuery,
): Promise<MemoryResult> {
  // Entity-based path: subgraph extraction
  if (query.entity_ids && query.entity_ids.length > 0) {
    return retrieveByEntities(store, index, query);
  }

  // Embedding-based path: top-down hierarchical
  if (query.embedding) {
    return retrieveByEmbedding(store, index, query);
  }

  // No embedding and no entity_ids: return empty result
  return { themes: [], facts: [], episodes: [], entities: [], relationships: [] };
}

async function retrieveByEmbedding(
  store: MemoryStore,
  index: MemoryIndex,
  query: MemoryQuery,
): Promise<MemoryResult> {
  const embedding = query.embedding!;
  const { limit, min_similarity, include_invalidated } = query;

  // Step 1: Search themes by similarity
  const scoredThemes = await index.searchThemes(embedding, { limit, min_similarity });
  const themes: Theme[] = scoredThemes.map((s) => s.item);

  // Step 2: Expand themes to facts via fact_ids
  const factIds = new Set<string>();
  for (const theme of themes) {
    for (const factId of theme.fact_ids) {
      factIds.add(factId);
    }
  }

  // Also search facts directly by embedding for coverage
  const scoredFacts = await index.searchFacts(embedding, { limit, min_similarity });
  for (const sf of scoredFacts) {
    factIds.add(sf.item.id);
  }

  const factsMap = await store.getFacts([...factIds]);
  const allFacts: SemanticFact[] = [...factsMap.values()];

  // Apply temporal filters
  const filteredFacts = filterValid(allFacts, {
    valid_at: query.valid_at,
    changed_since: query.changed_since,
    include_invalidated,
  }).slice(0, limit);

  // Step 3: Expand facts to episodes
  const episodeIds = new Set<string>();
  for (const fact of filteredFacts) {
    for (const epId of fact.source_episode_ids) {
      episodeIds.add(epId);
    }
  }

  const episodesMap = await store.getEpisodes([...episodeIds]);
  const episodes: Episode[] = [...episodesMap.values()];

  // Step 4: Collect entities from facts
  const entityIds = new Set<string>();
  for (const fact of filteredFacts) {
    for (const eId of fact.entity_ids) {
      entityIds.add(eId);
    }
  }

  const entitiesMap = await store.getEntities([...entityIds]);
  const entities: Entity[] = [...entitiesMap.values()];

  // Step 5: Get relationships between collected entities
  const relationships = await getRelationshipsBetween(store, entityIds, {
    valid_at: query.valid_at,
    include_invalidated,
  });

  return {
    themes,
    facts: filteredFacts,
    episodes: episodes.slice(0, limit),
    entities: entities.slice(0, limit),
    relationships: relationships.slice(0, limit),
  };
}

async function retrieveByEntities(
  store: MemoryStore,
  _index: MemoryIndex,
  query: MemoryQuery,
): Promise<MemoryResult> {
  const { entity_ids, max_hops, valid_at, include_invalidated, limit } = query;

  // Subgraph extraction via BFS
  const subgraph = await extractSubgraph(store, entity_ids!, {
    max_hops,
    valid_at,
    include_invalidated,
  });

  // Find facts referencing these entities
  const entityIdSet = new Set(subgraph.entities.map((e) => e.id));
  const allFacts: SemanticFact[] = [];
  const seenFactIds = new Set<string>();
  for (const entityId of entityIdSet) {
    const facts = await store.findFacts({ entity_id: entityId, include_invalidated });
    for (const fact of facts) {
      if (!seenFactIds.has(fact.id)) {
        seenFactIds.add(fact.id);
        allFacts.push(fact);
      }
    }
  }

  const filteredFacts = filterValid(allFacts, {
    valid_at,
    changed_since: query.changed_since,
    include_invalidated,
  }).slice(0, limit);

  // Collect themes from facts
  const themeIds = new Set<string>();
  for (const fact of filteredFacts) {
    if (fact.theme_id) themeIds.add(fact.theme_id);
  }

  const themesMap = await store.getThemes([...themeIds]);
  const themes: Theme[] = [...themesMap.values()];

  // Collect episodes from facts
  const episodeIds = new Set<string>();
  for (const fact of filteredFacts) {
    for (const epId of fact.source_episode_ids) {
      episodeIds.add(epId);
    }
  }

  const episodesMap = await store.getEpisodes([...episodeIds]);
  const episodes: Episode[] = [...episodesMap.values()];

  return {
    themes: themes.slice(0, limit),
    facts: filteredFacts,
    episodes: episodes.slice(0, limit),
    entities: subgraph.entities.slice(0, limit),
    relationships: subgraph.relationships.slice(0, limit),
  };
}

async function getRelationshipsBetween(
  store: MemoryStore,
  entityIds: Set<string>,
  opts: { valid_at?: Date; include_invalidated?: boolean },
): Promise<Relationship[]> {
  const seen = new Set<string>();
  const result: Relationship[] = [];

  for (const entityId of entityIds) {
    const rels = await store.getRelationshipsForEntity(entityId, {
      direction: 'both',
      include_invalidated: opts.include_invalidated,
    });
    for (const rel of rels) {
      if (seen.has(rel.id)) continue;
      // Only include relationships where both endpoints are in our set
      if (!entityIds.has(rel.source_id) || !entityIds.has(rel.target_id)) continue;
      seen.add(rel.id);
      result.push(rel);
    }
  }

  return result;
}
