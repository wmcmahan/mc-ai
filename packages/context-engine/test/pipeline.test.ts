import { describe, it, expect } from 'vitest';
import { createPipeline } from '../src/pipeline/pipeline.js';
import type { CompressionStage, PromptSegment, StageContext, BudgetConfig } from '../src/pipeline/types.js';
import { computeStageMetrics, aggregateMetrics, formatMetricsSummary } from '../src/pipeline/metrics.js';

// --- Test helpers ---

function makeSegment(overrides: Partial<PromptSegment> & { id: string; content: string }): PromptSegment {
  return {
    role: 'memory',
    priority: 1,
    locked: false,
    ...overrides,
  };
}

function makeBudget(overrides?: Partial<BudgetConfig>): BudgetConfig {
  return {
    maxTokens: 4096,
    outputReserve: 0,
    ...overrides,
  };
}

/** Stage that removes all whitespace from content (simple compressor). */
function createWhitespaceRemover(): CompressionStage {
  return {
    name: 'whitespace-remover',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({
          ...s,
          content: s.content.replace(/\s+/g, ' ').trim(),
        })),
      };
    },
  };
}

/** Stage that uppercases content (for ordering verification). */
function createUppercaser(): CompressionStage {
  return {
    name: 'uppercaser',
    execute(segments: PromptSegment[]) {
      return {
        segments: segments.map(s => ({ ...s, content: s.content.toUpperCase() })),
      };
    },
  };
}

/** Stage that always throws. */
function createFailingStage(): CompressionStage {
  return {
    name: 'failing-stage',
    execute() {
      throw new Error('Stage failed');
    },
  };
}

// --- Tests ---

describe('createPipeline', () => {
  it('passes segments through unchanged with no stages', () => {
    const pipeline = createPipeline({ stages: [] });
    const segments = [makeSegment({ id: 'a', content: 'hello world' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content).toBe('hello world');
    expect(result.metrics.reductionPercent).toBe(0);
  });

  it('applies a single stage', () => {
    const pipeline = createPipeline({ stages: [createWhitespaceRemover()] });
    const segments = [makeSegment({ id: 'a', content: 'hello    world    foo' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments[0].content).toBe('hello world foo');
  });

  it('applies multiple stages in order', () => {
    const pipeline = createPipeline({
      stages: [createWhitespaceRemover(), createUppercaser()],
    });
    const segments = [makeSegment({ id: 'a', content: 'hello    world' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    // Whitespace removed first, then uppercased
    expect(result.segments[0].content).toBe('HELLO WORLD');
    expect(result.metrics.stages).toHaveLength(2);
    expect(result.metrics.stages[0].name).toBe('whitespace-remover');
    expect(result.metrics.stages[1].name).toBe('uppercaser');
  });

  it('skips locked segments during compression', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [
      makeSegment({ id: 'sys', content: 'system prompt', locked: true }),
      makeSegment({ id: 'mem', content: 'memory data' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments[0].content).toBe('system prompt'); // unchanged
    expect(result.segments[1].content).toBe('MEMORY DATA'); // compressed
  });

  it('preserves original segment order after recombination', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [
      makeSegment({ id: 'a', content: 'first', locked: true }),
      makeSegment({ id: 'b', content: 'second' }),
      makeSegment({ id: 'c', content: 'third', locked: true }),
      makeSegment({ id: 'd', content: 'fourth' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.segments.map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.segments[0].content).toBe('first');   // locked
    expect(result.segments[1].content).toBe('SECOND');  // compressed
    expect(result.segments[2].content).toBe('third');   // locked
    expect(result.segments[3].content).toBe('FOURTH');  // compressed
  });

  it('handles graceful degradation when a stage throws', () => {
    const pipeline = createPipeline({
      stages: [createFailingStage(), createUppercaser()],
    });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    // Failing stage passed through, uppercaser still ran
    expect(result.segments[0].content).toBe('HELLO');
    expect(result.metrics.stages[0].error).toBe(true);
    expect(result.metrics.stages[0].tokensIn).toBe(result.metrics.stages[0].tokensOut);
    expect(result.metrics.stages[1].error).toBeUndefined();
  });

  it('builds source map in debug mode', () => {
    const pipeline = createPipeline({
      stages: [createUppercaser()],
      debug: true,
    });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.sourceMap).toBeDefined();
    expect(result.sourceMap).toHaveLength(1);
    expect(result.sourceMap![0].segmentId).toBe('a');
    expect(result.sourceMap![0].original).toBe('hello');
    expect(result.sourceMap![0].compressed).toBe('HELLO');
  });

  it('does not build source map when debug is off', () => {
    const pipeline = createPipeline({ stages: [createUppercaser()] });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.sourceMap).toBeUndefined();
  });

  it('excludes locked segments from debug source map', () => {
    const pipeline = createPipeline({
      stages: [createUppercaser()],
      debug: true,
    });
    const segments = [
      makeSegment({ id: 'sys', content: 'locked', locked: true }),
      makeSegment({ id: 'mem', content: 'mutable' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.sourceMap).toHaveLength(1);
    expect(result.sourceMap![0].segmentId).toBe('mem');
  });

  it('validates budget config with zod', () => {
    const pipeline = createPipeline({ stages: [] });
    const segments = [makeSegment({ id: 'a', content: 'hello' })];

    expect(() =>
      pipeline.compress({
        segments,
        budget: { maxTokens: -1, outputReserve: 0 } as BudgetConfig,
      }),
    ).toThrow();
  });

  it('reports correct overall metrics', () => {
    const pipeline = createPipeline({ stages: [createWhitespaceRemover()] });
    const segments = [
      makeSegment({ id: 'a', content: 'hello     world     foo     bar' }),
    ];
    const result = pipeline.compress({ segments, budget: makeBudget() });

    expect(result.metrics.totalTokensIn).toBeGreaterThan(0);
    expect(result.metrics.totalTokensOut).toBeLessThanOrEqual(result.metrics.totalTokensIn);
    expect(result.metrics.reductionPercent).toBeGreaterThanOrEqual(0);
    expect(result.metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('computeStageMetrics', () => {
  it('computes ratio correctly', () => {
    const m = computeStageMetrics('test', 100, 60, 5.0);
    expect(m.ratio).toBe(0.6);
    expect(m.name).toBe('test');
    expect(m.durationMs).toBe(5.0);
  });

  it('handles zero input tokens', () => {
    const m = computeStageMetrics('test', 0, 0, 1.0);
    expect(m.ratio).toBe(1.0);
  });
});

describe('aggregateMetrics', () => {
  it('aggregates multiple stages', () => {
    const stages = [
      computeStageMetrics('a', 100, 80, 2.0),
      computeStageMetrics('b', 80, 50, 3.0),
    ];
    const agg = aggregateMetrics(stages);

    expect(agg.totalTokensIn).toBe(100);
    expect(agg.totalTokensOut).toBe(50);
    expect(agg.reductionPercent).toBe(50);
    expect(agg.totalDurationMs).toBe(5.0);
    expect(agg.stages).toHaveLength(2);
  });
});

describe('formatMetricsSummary', () => {
  it('produces readable output', () => {
    const agg = aggregateMetrics([
      computeStageMetrics('format', 1000, 700, 2.5),
      computeStageMetrics('dedup', 700, 600, 1.2),
    ]);
    const summary = formatMetricsSummary(agg);

    expect(summary).toContain('1000');
    expect(summary).toContain('600');
    expect(summary).toContain('format');
    expect(summary).toContain('dedup');
  });
});
