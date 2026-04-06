# @mcai/memory

Temporal and hierarchical memory service for LLM agents. Provides a knowledge graph with temporal validity, xMemory-inspired hierarchical organization (messages → episodes → facts → themes), and efficient top-down retrieval.

Built as a standalone package with zero orchestrator dependencies. Ships with working in-memory implementations; production backends (Postgres/pgvector) implement the same interfaces.

## Install

```bash
npm install @mcai/memory
```

Requires Node.js 22+.

## Architecture

```
Messages
  ↓  EpisodeSegmenter
Episodes (topic-coherent message groups)
  ↓  SemanticExtractor
SemanticFacts (atomic knowledge units)
  ↓  ThemeClusterer
Themes (high-level clusters)
```

Parallel to the hierarchy, a **knowledge graph** stores entities (nodes) and relationships (edges) with temporal validity windows. Retrieval combines both: top-down hierarchical search and BFS subgraph extraction.

### Memory Hierarchy (xMemory)

| Level | Type | Description |
|-------|------|-------------|
| 0 | Messages | Raw conversation turns |
| 1 | Episodes | Groups of messages about one topic |
| 2 | SemanticFacts | Atomic facts distilled from episodes |
| 3 | Themes | Clusters of related facts |

Queries start at the theme level and drill down only as needed, reducing token usage by up to 50% compared to flat retrieval.

### Knowledge Graph

Entities and relationships form a directed graph with temporal awareness:

- **Entities** — people, organizations, concepts, objects
- **Relationships** — directed, weighted edges with `valid_from` / `valid_until` windows
- **Temporal invalidation** — old facts are invalidated, not deleted (Zep pattern)
- **Provenance tracking** — every record knows its origin (agent, tool, human, system, derived)

## Quick Start

```typescript
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  SimpleEpisodeSegmenter,
  SimpleSemanticExtractor,
  SimpleThemeClusterer,
  retrieveMemory,
} from '@mcai/memory';
import type { Message, MemoryQuery } from '@mcai/memory';

const store = new InMemoryMemoryStore();
const index = new InMemoryMemoryIndex();
const segmenter = new SimpleEpisodeSegmenter();
const extractor = new SimpleSemanticExtractor();
const clusterer = new SimpleThemeClusterer();

// 1. Ingest messages
const messages: Message[] = [
  { id: crypto.randomUUID(), role: 'user', content: 'Tell me about the project', timestamp: new Date('2024-01-01T10:00:00Z'), metadata: {} },
  { id: crypto.randomUUID(), role: 'assistant', content: 'It uses a graph-based workflow engine', timestamp: new Date('2024-01-01T10:01:00Z'), metadata: {} },
];

// 2. Segment into episodes
const episodes = await segmenter.segment(messages);
for (const ep of episodes) {
  await store.putEpisode(ep);
}

// 3. Extract facts
for (const ep of episodes) {
  const facts = await extractor.extract(ep);
  for (const fact of facts) {
    await store.putFact(fact);
  }
}

// 4. Cluster into themes
const allFacts = await store.findFacts();
const themes = await clusterer.cluster(allFacts);
for (const theme of themes) {
  await store.putTheme(theme);
}

// 5. Rebuild search index
await index.rebuild(store);

// 6. Query
const query: MemoryQuery = {
  embedding: [1, 0, 0],    // from your embedding provider
  limit: 20,
  min_similarity: 0.5,
  include_invalidated: false,
  max_hops: 2,
};

const result = await retrieveMemory(store, index, query);
// result.themes, result.facts, result.episodes, result.entities, result.relationships
```

## Knowledge Graph

### Entities

```typescript
import { InMemoryMemoryStore } from '@mcai/memory';
import type { Entity } from '@mcai/memory';

const store = new InMemoryMemoryStore();

const entity: Entity = {
  id: crypto.randomUUID(),
  name: 'Alice',
  entity_type: 'person',
  attributes: { role: 'engineer' },
  provenance: { source: 'agent', agent_id: 'extractor-01', created_at: new Date() },
  created_at: new Date(),
  updated_at: new Date(),
};

await store.putEntity(entity);

// Find by type
const people = await store.findEntities({ entity_type: 'person' });

// Soft-delete (invalidate)
await store.putEntity({ ...entity, invalidated_at: new Date(), superseded_by: newEntityId });

// Query excludes invalidated by default
const active = await store.findEntities(); // excludes invalidated
const all = await store.findEntities({ include_invalidated: true });
```

### Relationships

Directed edges with temporal validity windows:

```typescript
import type { Relationship } from '@mcai/memory';

const rel: Relationship = {
  id: crypto.randomUUID(),
  source_id: aliceId,
  target_id: acmeId,
  relation_type: 'works_at',
  weight: 1.0,
  attributes: { department: 'engineering' },
  valid_from: new Date('2024-01-01'),
  valid_until: undefined, // still valid
  provenance: { source: 'agent', created_at: new Date() },
};

await store.putRelationship(rel);

// Query by entity
const outgoing = await store.getRelationshipsForEntity(aliceId, { direction: 'outgoing' });
const workRels = await store.getRelationshipsForEntity(aliceId, { relation_type: 'works_at' });
```

### Subgraph Extraction

BFS traversal from seed entities:

```typescript
import { extractSubgraph } from '@mcai/memory';

const subgraph = await extractSubgraph(store, [aliceId], {
  max_hops: 2,
  valid_at: new Date(),        // only currently-valid relationships
  include_invalidated: false,
});

// subgraph.entities — all entities within 2 hops
// subgraph.relationships — edges connecting them
```

## Retrieval

### Hierarchical Retrieval (Embedding-Based)

Top-down search following the xMemory pattern:

1. Match themes by embedding similarity
2. Expand to facts via `fact_ids`
3. Apply temporal filters
4. Expand to source episodes
5. Collect referenced entities
6. Get relationships between entities

```typescript
import { retrieveMemory } from '@mcai/memory';

const result = await retrieveMemory(store, index, {
  embedding: queryVector,
  limit: 20,
  min_similarity: 0.5,
  valid_at: new Date(),          // only currently-valid facts
  changed_since: lastQueryTime,  // only recent changes
  include_invalidated: false,
  max_hops: 2,
});
```

### Entity-Based Retrieval

When you have specific entity IDs, retrieval uses subgraph extraction instead of theme matching:

```typescript
const result = await retrieveMemory(store, index, {
  entity_ids: [aliceId, bobId],
  max_hops: 2,
  limit: 20,
  min_similarity: 0.5,
  include_invalidated: false,
});

// Returns subgraph + related facts, themes, and episodes
```

### Temporal Filtering

Filter records by validity windows:

```typescript
import { isValidAt, isChangedSince, filterValid } from '@mcai/memory';

// Check individual records
isValidAt(relationship, new Date());        // within [valid_from, valid_until)?
isChangedSince(fact, lastCheckTime);        // created or invalidated after date?

// Batch filter
const validFacts = filterValid(allFacts, {
  valid_at: new Date(),
  changed_since: lastSync,
  include_invalidated: false,
});
```

## Similarity Search

The `MemoryIndex` provides embedding-based search over all record types:

```typescript
import { InMemoryMemoryIndex } from '@mcai/memory';

const index = new InMemoryMemoryIndex();
await index.rebuild(store); // build from store contents

const similar = await index.searchEntities(queryEmbedding, {
  limit: 10,
  min_similarity: 0.7,
});
// [{ item: Entity, score: number }, ...]

await index.searchFacts(queryEmbedding, { limit: 5 });
await index.searchThemes(queryEmbedding, { limit: 3 });
await index.searchEpisodes(queryEmbedding, { limit: 5 });
```

The in-memory index uses brute-force cosine similarity. Production backends implement the same `MemoryIndex` interface with pgvector HNSW.

## Hierarchy Pipeline

### Episode Segmenter

Groups messages into topic-coherent episodes based on time gaps:

```typescript
import { SimpleEpisodeSegmenter } from '@mcai/memory';

const segmenter = new SimpleEpisodeSegmenter({
  gap_threshold_ms: 5 * 60 * 1000, // 5 minute gap = new episode
  max_topic_length: 100,
});

const episodes = await segmenter.segment(messages);
```

### Semantic Extractor

Distills episodes into atomic facts:

```typescript
import { SimpleSemanticExtractor } from '@mcai/memory';

const extractor = new SimpleSemanticExtractor();
const facts = await extractor.extract(episode);
// Simple impl: one fact per episode (content = topic)
```

### Advanced Extractors

#### RuleBasedExtractor

Extracts 3-10 facts per episode with entity and relationship detection:

```typescript
import { RuleBasedExtractor } from '@mcai/memory';

const extractor = new RuleBasedExtractor({
  minSentenceLength: 20,  // skip short sentences
});

const facts = await extractor.extract(episode);
// Produces multiple facts per episode with entity_ids populated
// Detects: capitalized names, @handles, camelCase, ACRONYMS
// Extracts relationships: works_at, manages, depends_on, etc.

// Entity extraction is available standalone:
const entities = extractor.extractEntities('Alice Smith works at Acme Corp');
// [{ name: 'Alice Smith', type: 'person' }, { name: 'Acme Corp', type: 'organization' }]
```

#### LLMExtractor

LLM-backed extraction with rule-based fallback:

```typescript
import { LLMExtractor } from '@mcai/memory';
import type { LLMProvider } from '@mcai/memory';

const provider: LLMProvider = {
  complete: async (prompt) => { /* call your LLM */ return jsonResponse; },
};

const extractor = new LLMExtractor({ provider, maxFactsPerEpisode: 20 });
const facts = await extractor.extract(episode);
// Falls back to RuleBasedExtractor on LLM failure
```

### Theme Clusterer

Groups facts into thematic clusters using embedding similarity:

```typescript
import { SimpleThemeClusterer } from '@mcai/memory';

const clusterer = new SimpleThemeClusterer({
  similarity_threshold: 0.7, // min similarity to join existing theme
});

const themes = await clusterer.cluster(facts);
// Reuse existing themes on subsequent calls:
const updated = await clusterer.cluster(newFacts, existingThemes);
```

Facts without embeddings are assigned to a "General" fallback theme.

### Consolidating Theme Clusterer

Two-pass clustering that merges near-duplicate themes after assignment:

```typescript
import { ConsolidatingThemeClusterer } from '@mcai/memory';

const clusterer = new ConsolidatingThemeClusterer({
  assignmentThreshold: 0.7,  // min similarity to join theme
  mergeThreshold: 0.85,      // merge themes above this
  maxThemes: 50,             // soft cap
});

const themes = await clusterer.cluster(facts, existingThemes);
// Pass 1: greedy assignment (same as SimpleThemeClusterer)
// Pass 2: merges near-duplicate themes, recomputes centroids
```

## Memory Consolidation

### MemoryConsolidator

Deduplicates, decays, and prunes memory records to stay within budget:

```typescript
import { MemoryConsolidator } from '@mcai/memory';

const consolidator = new MemoryConsolidator(store, index, {
  maxFacts: 1000,
  maxEpisodes: 100,
  decayHalfLifeDays: 30,
  dedupThreshold: 0.9,
  deleteMode: 'soft',
});

const report = await consolidator.consolidate();
// report.factsDeduped, report.factsDecayed, report.episodesPruned
// report.themesCleanedUp, report.themesRemoved, report.totalReclaimed
```

### ConflictDetector

Detects and auto-resolves contradictory facts:

```typescript
import { ConflictDetector } from '@mcai/memory';

const detector = new ConflictDetector(store, index, {
  autoResolveSupersession: true,
  embeddingThreshold: 0.8,
  policy: 'negation-invalidates-positive',
});

const conflicts = await detector.detectConflicts();
// Three types: 'negation', 'supersession', 'semantic_contradiction'

// Auto-resolve with policy
const resolution = await detector.autoResolveAll(conflicts);
// resolution.resolved, resolution.skipped, resolution.details
```

## Interfaces

All components are interface-driven. Implement these for custom backends:

| Interface | Purpose | Implementations |
|-----------|---------|----------------|
| `MemoryStore` | CRUD for all record types | `InMemoryMemoryStore`, `DrizzleMemoryStore` (postgres) |
| `MemoryIndex` | Embedding similarity search | `InMemoryMemoryIndex`, `DrizzleMemoryIndex` (pgvector) |
| `EpisodeSegmenter` | Messages --> Episodes | `SimpleEpisodeSegmenter` |
| `SemanticExtractor` | Episode --> SemanticFacts | `SimpleSemanticExtractor`, `RuleBasedExtractor`, `LLMExtractor` |
| `ThemeClusterer` | Facts --> Themes | `SimpleThemeClusterer`, `ConsolidatingThemeClusterer` |
| `EmbeddingProvider` | Text --> vector embedding | (consumer-provided) |

### Batch Operations

`MemoryStore` includes batch retrieval methods for efficient bulk lookups:

```typescript
// Batch retrieval (single round-trip in production backends)
const entities = await store.getEntities(['id1', 'id2', 'id3']);
// Returns Map<string, Entity> — missing IDs silently absent

const facts = await store.getFacts(factIds);
const episodes = await store.getEpisodes(episodeIds);
const themes = await store.getThemes(themeIds);
```

### EmbeddingProvider

This package is embedding-agnostic. Provide your own implementation:

```typescript
import type { EmbeddingProvider } from '@mcai/memory';

const openaiEmbeddings: EmbeddingProvider = {
  dimensions: 1536,
  async embed(text) {
    // call OpenAI embeddings API
    return vector;
  },
  async embedBatch(texts) {
    // batch call
    return vectors;
  },
};
```

## Schemas

All record types have Zod schemas for validation:

```typescript
import { EntitySchema, RelationshipSchema, MemoryQuerySchema } from '@mcai/memory';

const entity = EntitySchema.parse(untrustedInput);
const query = MemoryQuerySchema.parse(requestBody); // applies defaults
```

| Schema | Key Fields |
|--------|------------|
| `ProvenanceSchema` | `source`, `agent_id`, `tool_name`, `run_id`, `confidence`, `created_at` |
| `EntitySchema` | `name`, `entity_type`, `attributes`, `embedding`, `invalidated_at`, `superseded_by` |
| `RelationshipSchema` | `source_id`, `target_id`, `relation_type`, `weight`, `valid_from`, `valid_until` |
| `MessageSchema` | `role`, `content`, `timestamp`, `metadata` |
| `EpisodeSchema` | `topic`, `messages`, `started_at`, `ended_at`, `fact_ids` |
| `SemanticFactSchema` | `content`, `source_episode_ids`, `entity_ids`, `theme_id`, `valid_from`, `valid_until` |
| `ThemeSchema` | `label`, `description`, `fact_ids`, `embedding` |
| `MemoryQuerySchema` | `text`, `embedding`, `entity_ids`, `max_hops`, `valid_at`, `changed_since`, `limit` |
| `MemoryResultSchema` | `themes`, `facts`, `episodes`, `entities`, `relationships` |

## Production Backend

Production deployments use `@mcai/orchestrator-postgres` which provides `DrizzleMemoryStore` and `DrizzleMemoryIndex` backed by Postgres + pgvector HNSW.

See the [@mcai/orchestrator-postgres README](../orchestrator-postgres/README.md) for setup.

## Development

```bash
npm install
npm run build --workspace=packages/memory
npm run test --workspace=packages/memory
npm run lint --workspace=packages/memory
```

## Research Foundation

| Technique | Source | Contribution |
|-----------|--------|-------------|
| xMemory | King's College London / Turing Institute, 2025 | 4-level hierarchy, top-down retrieval |
| Microsoft GraphRAG | Microsoft Research, 2024 | Graph-structured retrieval, community summarization |
| Zep (Temporal KG) | Rasmussen et al., 2025 | Temporal validity windows, fact invalidation |
| Graphiti | Zep/Neo4j, 2025 | Real-time incremental KG updates |
| MAGMA | arxiv, 2025 | Multi-graph agentic memory architecture |

## License

Apache-2.0
