import { describe, it, expect, vi } from 'vitest';
import { LLMExtractor } from '../src/hierarchy/llm-extractor.js';
import type { LLMProvider } from '../src/hierarchy/llm-extractor.js';
import type { Episode } from '../src/schemas/episode.js';

function makeEpisode(content: string): Episode {
  const now = new Date('2024-01-01T10:00:00Z');
  return {
    id: crypto.randomUUID(),
    topic: 'test topic',
    messages: [{
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: now,
      metadata: {},
    }],
    started_at: now,
    ended_at: now,
    fact_ids: [],
    provenance: { source: 'system', created_at: now },
  };
}

function mockProvider(response: string): LLMProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function throwingProvider(error: Error): LLMProvider {
  return { complete: vi.fn().mockRejectedValue(error) };
}

describe('LLMExtractor', () => {
  it('extracts facts from valid JSON response', async () => {
    const provider = mockProvider(JSON.stringify([
      {
        content: 'Alice works at Acme',
        entities: [
          { name: 'Alice', type: 'person' },
          { name: 'Acme', type: 'organization' },
        ],
        relationships: [{ source: 'Alice', target: 'Acme', type: 'works_at' }],
      },
    ]));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice works at Acme');
    const facts = await extractor.extract(ep);

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Alice works at Acme');
    expect(facts[0].entity_ids).toHaveLength(2);
    expect(facts[0].source_episode_ids).toEqual([ep.id]);
    expect(facts[0].provenance.source).toBe('derived');
  });

  it('parses JSON inside markdown code blocks', async () => {
    const json = JSON.stringify([{ content: 'Fact one', entities: [], relationships: [] }]);
    const provider = mockProvider('```json\n' + json + '\n```');
    const extractor = new LLMExtractor({ provider });
    const facts = await extractor.extract(makeEpisode('some text'));

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Fact one');
  });

  it('falls back to RuleBasedExtractor on malformed JSON', async () => {
    const provider = mockProvider('this is not json at all');
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');
    const facts = await extractor.extract(ep);

    // Should still get facts from the rule-based fallback
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to RuleBasedExtractor when provider throws', async () => {
    const provider = throwingProvider(new Error('API timeout'));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');
    const facts = await extractor.extract(ep);

    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty facts for empty array response', async () => {
    const provider = mockProvider('[]');
    const extractor = new LLMExtractor({ provider });
    const facts = await extractor.extract(makeEpisode('some text'));

    expect(facts).toHaveLength(0);
  });

  it('respects maxFactsPerEpisode', async () => {
    const manyFacts = Array.from({ length: 30 }, (_, i) => ({
      content: `Fact number ${i}`,
      entities: [],
      relationships: [],
    }));
    const provider = mockProvider(JSON.stringify(manyFacts));
    const extractor = new LLMExtractor({ provider, maxFactsPerEpisode: 20 });
    const facts = await extractor.extract(makeEpisode('lots of text'));

    expect(facts).toHaveLength(20);
  });

  it('handles object response (not array) by falling back', async () => {
    const provider = mockProvider(JSON.stringify({ content: 'not an array' }));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does important work at the company.');
    const facts = await extractor.extract(ep);

    // Falls back to rule-based
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  it('maps entity types correctly from LLM response', async () => {
    const provider = mockProvider(JSON.stringify([
      {
        content: 'Acme Corp is in New York',
        entities: [
          { name: 'Acme Corp', type: 'organization' },
          { name: 'New York', type: 'location' },
        ],
        relationships: [],
      },
    ]));
    const extractor = new LLMExtractor({ provider });
    const facts = await extractor.extract(makeEpisode('text'));

    expect(facts).toHaveLength(1);
    expect(facts[0].entity_ids).toHaveLength(2);
    // Entity IDs are unique UUIDs for each entity
    expect(facts[0].entity_ids[0]).not.toBe(facts[0].entity_ids[1]);
  });

  it('skips facts with missing content field', async () => {
    const provider = mockProvider(JSON.stringify([
      { content: 'Valid fact', entities: [] },
      { entities: [{ name: 'X' }] }, // no content
      { content: '', entities: [] }, // empty content
    ]));
    const extractor = new LLMExtractor({ provider });
    const facts = await extractor.extract(makeEpisode('text'));

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Valid fact');
  });

  it('handles entities without name gracefully', async () => {
    const provider = mockProvider(JSON.stringify([
      {
        content: 'Some fact',
        entities: [{ type: 'person' }, { name: 'Valid', type: 'person' }],
        relationships: [],
      },
    ]));
    const extractor = new LLMExtractor({ provider });
    const facts = await extractor.extract(makeEpisode('text'));

    expect(facts).toHaveLength(1);
    // Only the valid entity should have an ID
    expect(facts[0].entity_ids).toHaveLength(1);
  });

  it('deduplicates entity IDs by name', async () => {
    const provider = mockProvider(JSON.stringify([
      {
        content: 'Alice works with Alice',
        entities: [
          { name: 'Alice', type: 'person' },
          { name: 'Alice', type: 'person' },
        ],
        relationships: [],
      },
    ]));
    const extractor = new LLMExtractor({ provider });
    const facts = await extractor.extract(makeEpisode('text'));

    expect(facts).toHaveLength(1);
    // Same entity name should reuse the same ID
    expect(facts[0].entity_ids[0]).toBe(facts[0].entity_ids[1]);
  });

  it('sends prompt to provider with episode messages', async () => {
    const provider = mockProvider('[]');
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Test message content');
    await extractor.extract(ep);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    const prompt = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('Test message content');
    expect(prompt).toContain('[user]');
  });

  it('parses JSON with extra whitespace in code block', async () => {
    const provider = mockProvider('```\n  [{"content": "fact", "entities": []}]  \n```');
    const extractor = new LLMExtractor({ provider });
    const facts = await extractor.extract(makeEpisode('text'));
    expect(facts).toHaveLength(1);
  });

  it('sets valid_from to episode started_at', async () => {
    const provider = mockProvider(JSON.stringify([{ content: 'A fact', entities: [] }]));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('text');
    const facts = await extractor.extract(ep);
    expect(facts[0].valid_from).toEqual(ep.started_at);
  });
});
