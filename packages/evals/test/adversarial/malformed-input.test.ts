import { describe, it, expect } from 'vitest';
import {
  createPipeline,
  detectShape,
  dedup,
  DefaultTokenCounter,
} from '@mcai/context-engine';
import type { PromptSegment, BudgetConfig } from '@mcai/context-engine';
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  SimpleEpisodeSegmenter,
  EntitySchema,
  SemanticFactSchema,
} from '@mcai/memory';

// ─── Helpers ───────────────────────────────────────────────────────

function makeSegment(id: string, content: string, overrides?: Partial<PromptSegment>): PromptSegment {
  return {
    id,
    content,
    role: 'memory',
    priority: 1,
    locked: false,
    ...overrides,
  };
}

const defaultBudget: BudgetConfig = {
  maxTokens: 4096,
  outputReserve: 0,
};

// ─── Context-Engine Malformed Input Tests ──────────────────────────

describe('context-engine malformed inputs', () => {
  it('handles empty string segment content', () => {
    const pipeline = createPipeline({ stages: [] });
    const result = pipeline.compress({
      segments: [makeSegment('empty', '')],
      budget: defaultBudget,
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content).toBe('');
  });

  it('handles segment with null bytes', () => {
    const content = 'hello\x00world\x00test';
    const pipeline = createPipeline({ stages: [] });
    const result = pipeline.compress({
      segments: [makeSegment('nullbytes', content)],
      budget: defaultBudget,
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content).toBe(content);
  });

  it('handles extremely long string (100KB)', () => {
    const longContent = 'A'.repeat(100 * 1024);
    const pipeline = createPipeline({ stages: [] });
    const result = pipeline.compress({
      segments: [makeSegment('long', longContent)],
      budget: { maxTokens: 1_000_000, outputReserve: 0 },
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content.length).toBe(100 * 1024);
  });

  it('handles nested JSON 50 levels deep in format detection', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 50; i++) {
      nested = { [`level_${i}`]: nested };
    }

    const shape = detectShape(nested);
    expect(shape).toBe('nested');
  });

  it('handles segment with only whitespace', () => {
    const pipeline = createPipeline({ stages: [] });
    const result = pipeline.compress({
      segments: [makeSegment('whitespace', '   \n\t  \n  ')],
      budget: defaultBudget,
    });

    expect(result.segments).toHaveLength(1);
  });

  it('handles unicode edge cases (emoji, RTL, zero-width)', () => {
    const unicodeContent = '👨‍👩‍👧‍👦 مرحبا \u200B\u200C\u200D 🏴󠁧󠁢󠁳󠁣󠁴󠁿 test';
    const pipeline = createPipeline({ stages: [] });
    const result = pipeline.compress({
      segments: [makeSegment('unicode', unicodeContent)],
      budget: defaultBudget,
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content).toBe(unicodeContent);
  });

  it('handles array of 1000 identical objects in dedup', () => {
    const items = Array.from({ length: 1000 }, () => 'duplicate content');
    const result = dedup(items);

    expect(result.unique).toHaveLength(1);
    expect(result.removed).toBe(999);
  });
});

// ─── Memory Malformed Input Tests ──────────────────────────────────

describe('memory malformed inputs', () => {
  it('entity schema rejects empty name', () => {
    const result = EntitySchema.safeParse({
      id: '00000000-0000-0000-0000-000000000001',
      name: '',
      entity_type: 'person',
      attributes: {},
      provenance: { source: 'system', created_at: new Date() },
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(result.success).toBe(false);
  });

  it('fact schema rejects empty content', () => {
    const result = SemanticFactSchema.safeParse({
      id: '00000000-0000-0000-0000-000000000001',
      content: '',
      provenance: { source: 'system', created_at: new Date() },
      valid_from: new Date(),
    });

    expect(result.success).toBe(false);
  });

  it('index search with empty embedding returns empty results', async () => {
    const index = new InMemoryMemoryIndex();

    const results = await index.searchEntities([]);

    expect(results).toEqual([]);
  });

  it('segmenter handles episode with 0 messages', async () => {
    const segmenter = new SimpleEpisodeSegmenter();
    const episodes = await segmenter.segment([]);

    expect(episodes).toEqual([]);
  });

  it('store handles entity with very long attribute values', async () => {
    const store = new InMemoryMemoryStore();
    const longValue = 'x'.repeat(100_000);
    const entity = {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'test-entity',
      entity_type: 'concept',
      attributes: { description: longValue },
      provenance: { source: 'system' as const, created_at: new Date() },
      created_at: new Date(),
      updated_at: new Date(),
    };

    await store.putEntity(entity);
    const retrieved = await store.getEntity(entity.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.attributes.description).toBe(longValue);
  });
});
