/**
 * Adaptive Memory Compressor — Unit Tests
 *
 * Validates the adaptive memory compression stage: prioritization,
 * recency boost, truncation, and pass-through behavior.
 */

import { describe, it, expect } from 'vitest';
import { createAdaptiveMemoryStage } from '../src/memory/adaptive-compressor.js';
import type { PromptSegment, StageContext, BudgetConfig } from '../src/pipeline/types.js';
import type { TokenCounter } from '../src/providers/types.js';

/** Minimal token counter for tests. */
const stubTokenCounter: TokenCounter = {
  count: (text: string) => text.split(/\s+/).length,
  modelFamily: 'test',
};

/** Minimal stage context for tests. */
function makeContext(): StageContext {
  const budget: BudgetConfig = { maxTokens: 4096, outputReserve: 0 };
  return { tokenCounter: stubTokenCounter, budget };
}

/** Helper to build a PromptSegment. */
function seg(
  id: string,
  content: string,
  role: 'memory' | 'system' | 'user' | 'tools' | 'history' | 'custom' = 'memory',
  opts?: Partial<PromptSegment>,
): PromptSegment {
  return { id, content, role, priority: 1, locked: false, ...opts };
}

/** Build a memory payload JSON string. */
function memoryJson(payload: {
  themes?: Array<{ id: string; label: string; description: string; fact_ids: string[] }>;
  facts?: Array<{ id: string; content: string; valid_from: string; theme_id?: string; [k: string]: unknown }>;
  entities?: unknown[];
  relationships?: unknown[];
}): string {
  return JSON.stringify(payload);
}

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('createAdaptiveMemoryStage', () => {
  it('has stage name "adaptive-memory"', () => {
    const stage = createAdaptiveMemoryStage();
    expect(stage.name).toBe('adaptive-memory');
  });

  it('non-memory segments pass through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const segments = [
      seg('s1', 'You are an assistant', 'system'),
      seg('u1', 'Hello', 'user'),
    ];
    const result = stage.execute(segments, makeContext());
    expect(result.segments).toEqual(segments);
  });

  it('memory segment with themes/facts: facts are reordered by priority', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 }); // disable recency
    const content = memoryJson({
      themes: [
        { id: 't1', label: 'Big', description: 'big theme', fact_ids: ['f1', 'f2', 'f3'] },
        { id: 't2', label: 'Small', description: 'small theme', fact_ids: ['f4'] },
      ],
      facts: [
        { id: 'f4', content: 'small theme fact', valid_from: daysAgo(100), theme_id: 't2' },
        { id: 'f1', content: 'big theme fact 1', valid_from: daysAgo(100), theme_id: 't1' },
        { id: 'f2', content: 'big theme fact 2', valid_from: daysAgo(100), theme_id: 't1' },
        { id: 'f3', content: 'big theme fact 3', valid_from: daysAgo(100), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const parsed = JSON.parse(result.segments[0].content);

    // Big theme facts (priority 3) should come before small theme fact (priority 1)
    expect(parsed.facts[0].id).toBe('f1');
    expect(parsed.facts[1].id).toBe('f2');
    expect(parsed.facts[2].id).toBe('f3');
    expect(parsed.facts[3].id).toBe('f4');
  });

  it('recency boost: recent facts get higher priority than old facts', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 7, recencyMultiplier: 10 });
    const content = memoryJson({
      themes: [
        { id: 't1', label: 'Theme', description: 'theme', fact_ids: ['f-old', 'f-new'] },
      ],
      facts: [
        { id: 'f-old', content: 'old fact', valid_from: daysAgo(30), theme_id: 't1' },
        { id: 'f-new', content: 'new fact', valid_from: daysAgo(1), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const parsed = JSON.parse(result.segments[0].content);

    // Recent fact should be first due to recency multiplier
    expect(parsed.facts[0].id).toBe('f-new');
    expect(parsed.facts[1].id).toBe('f-old');
  });

  it('maxFactsPerTheme: excess facts are truncated', () => {
    const stage = createAdaptiveMemoryStage({ maxFactsPerTheme: 2, recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [
        { id: 't1', label: 'Theme', description: 'theme', fact_ids: ['f1', 'f2', 'f3', 'f4'] },
      ],
      facts: [
        { id: 'f1', content: 'fact 1', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f2', content: 'fact 2', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f3', content: 'fact 3', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f4', content: 'fact 4', valid_from: daysAgo(10), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const parsed = JSON.parse(result.segments[0].content);

    expect(parsed.facts).toHaveLength(2);
  });

  it('invalid JSON content passes through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const content = 'this is not valid JSON {{{';
    const segments = [seg('m1', content)];
    const result = stage.execute(segments, makeContext());
    expect(result.segments[0].content).toBe(content);
  });

  it('content without themes/facts structure passes through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const content = JSON.stringify({ someOtherData: [1, 2, 3] });
    const segments = [seg('m1', content)];
    const result = stage.execute(segments, makeContext());
    expect(result.segments[0].content).toBe(content);
  });

  it('empty facts array: segment passes through', () => {
    const stage = createAdaptiveMemoryStage();
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: [] }],
      facts: [],
    });
    const segments = [seg('m1', content)];
    const result = stage.execute(segments, makeContext());
    // Content should still be valid JSON, just unchanged in structure
    const parsed = JSON.parse(result.segments[0].content);
    expect(parsed.facts).toHaveLength(0);
  });

  it('mixed segments (memory + non-memory): only memory processed', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 });
    const memContent = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1', 'f2'] }],
      facts: [
        { id: 'f2', content: 'b', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f1', content: 'a', valid_from: daysAgo(10), theme_id: 't1' },
      ],
    });

    const segments = [
      seg('s1', 'system prompt', 'system'),
      seg('m1', memContent, 'memory'),
      seg('u1', 'user msg', 'user'),
    ];

    const result = stage.execute(segments, makeContext());

    // system and user unchanged
    expect(result.segments[0].content).toBe('system prompt');
    expect(result.segments[2].content).toBe('user msg');

    // memory was processed (compact JSON)
    expect(result.segments[1].content).not.toContain('\n');
    const parsed = JSON.parse(result.segments[1].content);
    expect(parsed.facts).toHaveLength(2);
  });

  it('large themes get higher fact priority than small themes', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [
        { id: 'big', label: 'Big', description: 'big', fact_ids: ['f1', 'f2', 'f3', 'f4', 'f5'] },
        { id: 'small', label: 'Small', description: 'small', fact_ids: ['f6'] },
      ],
      facts: [
        { id: 'f6', content: 'small', valid_from: daysAgo(10), theme_id: 'small' },
        { id: 'f1', content: 'big1', valid_from: daysAgo(10), theme_id: 'big' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const parsed = JSON.parse(result.segments[0].content);

    // Big theme fact (priority 5) should come before small theme fact (priority 1)
    expect(parsed.facts[0].id).toBe('f1');
    expect(parsed.facts[1].id).toBe('f6');
  });

  it('recencyMultiplier affects ordering', () => {
    // With high multiplier, recent small-theme fact beats old big-theme fact
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 7, recencyMultiplier: 100 });
    const content = memoryJson({
      themes: [
        { id: 'big', label: 'Big', description: 'big', fact_ids: ['f1', 'f2', 'f3'] },
        { id: 'small', label: 'Small', description: 'small', fact_ids: ['f4'] },
      ],
      facts: [
        { id: 'f1', content: 'old big', valid_from: daysAgo(30), theme_id: 'big' },
        { id: 'f4', content: 'new small', valid_from: daysAgo(1), theme_id: 'small' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const parsed = JSON.parse(result.segments[0].content);

    // small theme fact with recency 100x multiplier (1 * 100 = 100) > big theme (3)
    expect(parsed.facts[0].id).toBe('f4');
    expect(parsed.facts[1].id).toBe('f1');
  });

  it('default options work', () => {
    const stage = createAdaptiveMemoryStage(); // no options
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1'] }],
      facts: [{ id: 'f1', content: 'fact', valid_from: daysAgo(1) }],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const parsed = JSON.parse(result.segments[0].content);
    expect(parsed.facts).toHaveLength(1);
  });

  it('segment metadata is preserved', () => {
    const stage = createAdaptiveMemoryStage();
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1'] }],
      facts: [{ id: 'f1', content: 'fact', valid_from: daysAgo(1) }],
    });

    const segments = [seg('m1', content, 'memory', { metadata: { source: 'test', version: 2 } })];
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].metadata).toEqual({ source: 'test', version: 2 });
    expect(result.segments[0].id).toBe('m1');
    expect(result.segments[0].role).toBe('memory');
  });

  it('output is compact JSON (no pretty-printing)', () => {
    const stage = createAdaptiveMemoryStage();
    const content = memoryJson({
      themes: [{ id: 't1', label: 'Theme', description: 'desc', fact_ids: ['f1'] }],
      facts: [{ id: 'f1', content: 'fact content', valid_from: daysAgo(1) }],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const output = result.segments[0].content;

    // Compact JSON should not contain newlines or multi-space indentation
    expect(output).not.toContain('\n');
    expect(output).not.toMatch(/  /); // no double spaces (from indent)
  });

  it('all original facts preserved when under maxFactsPerTheme', () => {
    const stage = createAdaptiveMemoryStage({ maxFactsPerTheme: 10, recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1', 'f2', 'f3'] }],
      facts: [
        { id: 'f1', content: 'a', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f2', content: 'b', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f3', content: 'c', valid_from: daysAgo(10), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());
    const parsed = JSON.parse(result.segments[0].content);

    expect(parsed.facts).toHaveLength(3);
    const ids = parsed.facts.map((f: { id: string }) => f.id).sort();
    expect(ids).toEqual(['f1', 'f2', 'f3']);
  });
});
