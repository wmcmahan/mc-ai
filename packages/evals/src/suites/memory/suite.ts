/**
 * Memory Eval Suite
 *
 * Two-track evaluation for @mcai/memory:
 * - Deterministic track: temporal filtering, subgraph extraction,
 *   segmentation determinism, retrieval correctness
 * - Semantic track: LLM-as-judge for memory-assisted Q&A quality
 *
 * @module suites/memory/suite
 */

import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  SimpleEpisodeSegmenter,
  SimpleSemanticExtractor,
  SimpleThemeClusterer,
  extractSubgraph,
  filterValid,
  isValidAt,
} from '@mcai/memory';
import type {
  Entity,
  Relationship,
  SemanticFact,
  Message,
  MemoryQuery,
} from '@mcai/memory';
import { retrieveMemory } from '@mcai/memory';
import {
  assertGreaterThanOrEqual,
  assertEqual,
  assertSetEquals,
  assertStable,
} from '../../assertions/deterministic.js';
import type { TestCaseResults } from '../../assertions/drift-calculator.js';
import type { EvalProvider } from '../../providers/types.js';
import type { SuiteConfig } from '../loader.js';
import { buildAssertions } from './assertions.js';
import { MEMORY_QA_PROMPT, TEMPORAL_REASONING_PROMPT } from './prompts.js';

// ─── Test Fixtures ────────────────────────────────────────────────

const NOW = new Date('2026-04-06T12:00:00Z');
const PAST = new Date('2025-01-01T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');

function makeEntity(id: string, name: string, type: string): Entity {
  return {
    id,
    name,
    entity_type: type,
    attributes: {},
    provenance: { source: 'system', created_at: NOW },
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  relType: string,
  validFrom: Date,
  validUntil?: Date,
): Relationship {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    relation_type: relType,
    weight: 1.0,
    attributes: {},
    valid_from: validFrom,
    valid_until: validUntil,
    provenance: { source: 'system', created_at: NOW },
  };
}

function makeFact(
  id: string,
  content: string,
  validFrom: Date,
  validUntil?: Date,
  invalidatedBy?: string,
): SemanticFact {
  return {
    id,
    content,
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'system', created_at: NOW },
    valid_from: validFrom,
    valid_until: validUntil,
    invalidated_by: invalidatedBy,
  };
}

/** Seed a store with a test graph: A → B → C, A → D */
async function seedTestGraph(store: InMemoryMemoryStore) {
  const entities = [
    makeEntity('e-alice', 'Alice', 'person'),
    makeEntity('e-bob', 'Bob', 'person'),
    makeEntity('e-acme', 'Acme Corp', 'organization'),
    makeEntity('e-widget', 'Widget Project', 'project'),
  ];
  for (const e of entities) await store.putEntity(e);

  const relationships = [
    makeRelationship('r-1', 'e-alice', 'e-acme', 'works_at', PAST),            // current
    makeRelationship('r-2', 'e-bob', 'e-acme', 'works_at', PAST),              // current
    makeRelationship('r-3', 'e-acme', 'e-widget', 'owns', PAST),               // current
    makeRelationship('r-4', 'e-alice', 'e-bob', 'manages', PAST, PAST),        // expired
  ];
  for (const r of relationships) await store.putRelationship(r);

  const facts: SemanticFact[] = [
    makeFact('f-1', 'Alice works at Acme Corp as lead engineer', PAST),               // current
    makeFact('f-2', 'Bob was hired in 2024', PAST, PAST),                              // expired
    makeFact('f-3', 'Acme Corp develops the Widget Project', PAST),                    // current
    makeFact('f-4', 'Alice previously worked at BigTech', PAST, undefined, 'f-new'),   // invalidated
  ];
  for (const f of facts) await store.putFact(f);

  return { entities, relationships, facts };
}

// ─── Deterministic Track ──────────────────────────────────────────

export async function runDeterministic(): Promise<TestCaseResults[]> {
  const results: TestCaseResults[] = [];

  // Test 1: Temporal — expired facts filtered
  results.push(await runTemporalExpiredTest());

  // Test 2: Temporal — current facts kept
  results.push(await runTemporalCurrentTest());

  // Test 3: Temporal — invalidated excluded
  results.push(await runTemporalInvalidatedTest());

  // Test 4: Subgraph — 1-hop
  results.push(await runSubgraph1HopTest());

  // Test 5: Subgraph — 2-hop
  results.push(await runSubgraph2HopTest());

  // Test 6: Segmentation determinism
  results.push(await runSegmentationDeterminismTest());

  // Test 7: Entity-based retrieval
  results.push(await runEntityRetrievalTest());

  // Test 8: Theme→fact linkage
  results.push(await runThemeFactLinkageTest());

  return results;
}

async function runTemporalExpiredTest(): Promise<TestCaseResults> {
  const facts = [
    makeFact('f-a', 'Current fact', PAST),
    makeFact('f-b', 'Expired fact', PAST, PAST),
  ];
  const filtered = filterValid(facts, { valid_at: NOW });

  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('temporal_expired_filtered', filtered.length, 1, 'Expired facts should be filtered out'),
    ],
  };
}

async function runTemporalCurrentTest(): Promise<TestCaseResults> {
  const facts = [
    makeFact('f-a', 'Current fact', PAST),
    makeFact('f-b', 'Future fact', FUTURE),
    makeFact('f-c', 'Another current', PAST, FUTURE),
  ];
  const filtered = filterValid(facts, { valid_at: NOW });

  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('temporal_current_kept', filtered.length, 2, 'Current facts should be kept (f-a, f-c)'),
    ],
  };
}

async function runTemporalInvalidatedTest(): Promise<TestCaseResults> {
  const facts = [
    makeFact('f-a', 'Valid fact', PAST),
    makeFact('f-b', 'Invalidated fact', PAST, undefined, 'f-replacement'),
  ];
  const without = filterValid(facts, { include_invalidated: false });
  const withInv = filterValid(facts, { include_invalidated: true });

  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('invalidated_excluded', without.length, 1, 'Invalidated facts excluded by default'),
      assertEqual('invalidated_included', withInv.length, 2, 'Invalidated facts included when requested'),
    ],
  };
}

async function runSubgraph1HopTest(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  await seedTestGraph(store);

  const subgraph = await extractSubgraph(store, ['e-alice'], { max_hops: 1, valid_at: NOW });
  const entityIds = new Set(subgraph.entities.map(e => e.id));

  // Alice → (works_at) → Acme, Alice → (manages, expired) → Bob (filtered by valid_at)
  // So 1-hop from Alice with valid_at=NOW: Alice + Acme
  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertSetEquals(
        'subgraph_1hop_entities',
        entityIds,
        new Set(['e-alice', 'e-acme']),
        '1-hop from Alice (valid_at=NOW) should include Alice and Acme (manages→Bob is expired)',
      ),
    ],
  };
}

async function runSubgraph2HopTest(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  await seedTestGraph(store);

  const subgraph = await extractSubgraph(store, ['e-alice'], { max_hops: 2, valid_at: NOW });
  const entityIds = new Set(subgraph.entities.map(e => e.id));

  // 2-hop: Alice → Acme → Bob, Acme → Widget
  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertSetEquals(
        'subgraph_2hop_entities',
        entityIds,
        new Set(['e-alice', 'e-acme', 'e-bob', 'e-widget']),
        '2-hop from Alice should include all 4 entities via valid relationships',
      ),
    ],
  };
}

async function runSegmentationDeterminismTest(): Promise<TestCaseResults> {
  const messages: Message[] = [
    { id: 'm-1', role: 'user', content: 'Tell me about the project', timestamp: new Date('2026-01-01T10:00:00Z'), metadata: {} },
    { id: 'm-2', role: 'assistant', content: 'The project uses a graph engine', timestamp: new Date('2026-01-01T10:01:00Z'), metadata: {} },
    { id: 'm-3', role: 'user', content: 'What about the budget?', timestamp: new Date('2026-01-01T11:00:00Z'), metadata: {} },
    { id: 'm-4', role: 'assistant', content: 'The budget is 100k', timestamp: new Date('2026-01-01T11:01:00Z'), metadata: {} },
  ];

  const segmenter = new SimpleEpisodeSegmenter({ gap_threshold_ms: 30 * 60 * 1000 });
  const run1 = await segmenter.segment(messages);
  const run2 = await segmenter.segment(messages);
  const run3 = await segmenter.segment(messages);

  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertStable(
        'segmentation_determinism',
        [run1.length, run2.length, run3.length],
        'Episode segmenter should produce same count across runs',
      ),
      assertGreaterThanOrEqual(
        'segmentation_splits',
        run1.length,
        2,
        'Messages with 1-hour gap should segment into >= 2 episodes',
      ),
    ],
  };
}

async function runEntityRetrievalTest(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  await seedTestGraph(store);
  await index.rebuild(store);

  const result = await retrieveMemory(store, index, {
    entity_ids: ['e-alice'],
    max_hops: 1,
    limit: 20,
    min_similarity: 0,
    include_invalidated: false,
  });

  const entityIds = new Set(result.entities.map(e => e.id));

  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'entity_retrieval_count',
        result.entities.length,
        1,
        'Entity-based retrieval should return at least the seed entity',
      ),
    ],
  };
}

async function runThemeFactLinkageTest(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();

  // Create facts
  const facts = [
    makeFact('f-1', 'Alice works at Acme', PAST),
    makeFact('f-2', 'Bob works at Acme', PAST),
  ];
  for (const f of facts) await store.putFact(f);

  // Cluster into themes
  const clusterer = new SimpleThemeClusterer();
  const themes = await clusterer.cluster(facts);

  // Verify theme→fact linkage
  const allFactIds = new Set(themes.flatMap(t => t.fact_ids));
  const expectedFactIds = new Set(facts.map(f => f.id));

  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual('theme_count', themes.length, 1, 'Should produce at least 1 theme'),
      assertSetEquals(
        'theme_fact_linkage',
        allFactIds,
        expectedFactIds,
        'Theme fact_ids should reference all input facts',
      ),
    ],
  };
}

// ─── Semantic Track ───────────────────────────────────────────────

export async function buildSuite(_provider: EvalProvider): Promise<SuiteConfig> {
  const tests: SuiteConfig['tests'] = [
    {
      description: 'Entity-based memory retrieval helps answer factual question',
      vars: {
        memory_context: 'Entities: Alice (person, lead engineer), Acme Corp (organization)\nRelationships: Alice works_at Acme Corp\nFacts: Alice works at Acme Corp as lead engineer. Acme Corp develops the Widget Project.',
        question: 'Where does Alice work and what is her role?',
        expected_answer: 'Alice works at Acme Corp as a lead engineer.',
      },
      assert: buildAssertions('memory-qa'),
    },
    {
      description: 'Temporal reasoning with validity windows',
      vars: {
        temporal_facts: 'Fact: "Bob works at Acme Corp" (valid from 2024-01-01, valid until 2025-06-01)\nFact: "Bob works at NewCo" (valid from 2025-06-01)',
        as_of_date: '2026-01-01',
        question: 'Where does Bob currently work?',
        expected_answer: 'Bob works at NewCo (as of 2026, his Acme position expired in June 2025).',
      },
      assert: buildAssertions('temporal-reasoning'),
    },
  ];

  return {
    name: 'memory',
    prompts: [MEMORY_QA_PROMPT, TEMPORAL_REASONING_PROMPT],
    tests,
  };
}
