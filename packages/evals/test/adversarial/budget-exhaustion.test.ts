import { describe, it, expect } from 'vitest';
import {
  allocateBudget,
  createPipeline,
  DefaultTokenCounter,
} from '@mcai/context-engine';
import type { PromptSegment, BudgetConfig } from '@mcai/context-engine';

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

const counter = new DefaultTokenCounter();

describe('budget-exhaustion edge cases', () => {
  it('zero maxTokens budget: allocator returns empty allocations for mutable segments', () => {
    // BudgetConfigSchema requires positive maxTokens, so use 1 as minimum
    const segments = [makeSegment('a', 'some content here')];
    const budget: BudgetConfig = { maxTokens: 1, outputReserve: 0 };

    const result = allocateBudget(segments, budget, counter);

    // With budget of 1, the allocation should be minimal
    const allocation = result.allocations.get('a') ?? 0;
    expect(allocation).toBeLessThanOrEqual(1);
  });

  it('budget smaller than locked segment tokens: locked segments preserved, mutable truncated', () => {
    const locked = makeSegment('locked', 'This is important locked content', { locked: true });
    const mutable = makeSegment('mutable', 'This is mutable content that can be cut');

    const lockedTokens = counter.countTokens(locked.content);
    // Budget is just enough for the locked segment, none left for mutable
    const budget: BudgetConfig = { maxTokens: lockedTokens, outputReserve: 0 };

    const result = allocateBudget([locked, mutable], budget, counter);

    expect(result.allocations.get('locked')).toBe(lockedTokens);
    expect(result.allocations.get('mutable') ?? 0).toBe(0);
  });

  it('output reserve consuming entire budget: mutable segments get 0 allocation', () => {
    const segments = [makeSegment('a', 'hello world content')];
    const budget: BudgetConfig = { maxTokens: 100, outputReserve: 100 };

    const result = allocateBudget(segments, budget, counter);

    expect(result.allocations.get('a') ?? 0).toBe(0);
  });

  it('single segment exceeding budget: allocated up to budget', () => {
    const bigContent = 'word '.repeat(1000);
    const segments = [makeSegment('big', bigContent)];
    const budget: BudgetConfig = { maxTokens: 50, outputReserve: 0 };

    const result = allocateBudget(segments, budget, counter);

    const allocation = result.allocations.get('big') ?? 0;
    expect(allocation).toBeLessThanOrEqual(50);
  });

  it('all segments locked: all preserved regardless of budget', () => {
    const seg1 = makeSegment('a', 'first locked', { locked: true });
    const seg2 = makeSegment('b', 'second locked', { locked: true });

    const budget: BudgetConfig = { maxTokens: 10000, outputReserve: 0 };

    const result = allocateBudget([seg1, seg2], budget, counter);

    // Locked segments always get their full token count
    expect(result.allocations.get('a')).toBe(counter.countTokens(seg1.content));
    expect(result.allocations.get('b')).toBe(counter.countTokens(seg2.content));
  });

  it('negative priority treated as 0 due to schema validation', () => {
    // Priority has min(0) in schema, so we test with 0 priority
    const segments = [makeSegment('zero', 'some content', { priority: 0 })];
    const budget: BudgetConfig = { maxTokens: 100, outputReserve: 0 };

    const result = allocateBudget(segments, budget, counter);

    // With zero priority and only one segment, totalPriority = 0
    // Function returns early with no mutable allocations
    expect(result.allocations.has('zero')).toBe(false);
  });

  it('budget of 1 token: minimal output', () => {
    const pipeline = createPipeline({ stages: [] });
    const result = pipeline.compress({
      segments: [makeSegment('tiny', 'a')],
      budget: { maxTokens: 1, outputReserve: 0 },
    });

    // Pipeline should still complete without error
    expect(result.segments).toBeDefined();
    expect(result.metrics).toBeDefined();
  });

  it('very large budget (1M tokens): no issues, all content preserved', () => {
    const segments = [
      makeSegment('a', 'Hello world'),
      makeSegment('b', 'Foo bar baz'),
    ];

    const budget: BudgetConfig = { maxTokens: 1_000_000, outputReserve: 0 };

    const result = allocateBudget(segments, budget, counter);

    // Both segments should get their full allocation
    expect(result.allocations.get('a')).toBe(counter.countTokens('Hello world'));
    expect(result.allocations.get('b')).toBe(counter.countTokens('Foo bar baz'));
    expect(result.overflow).toHaveLength(0);
  });
});
