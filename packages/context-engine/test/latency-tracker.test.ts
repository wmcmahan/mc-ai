import { describe, it, expect } from 'vitest';
import { createLatencyTracker } from '../src/budget/latency-tracker.js';

describe('createLatencyTracker', () => {
  it('returns zero stats for unknown stage', () => {
    const tracker = createLatencyTracker();
    const stats = tracker.getAverage('unknown');
    expect(stats.avgDurationMs).toBe(0);
    expect(stats.avgTokensSaved).toBe(0);
    expect(stats.samplesCount).toBe(0);
  });

  it('computes correct rolling average', () => {
    const tracker = createLatencyTracker();
    tracker.record('format', 10, 100);
    tracker.record('format', 20, 200);

    const stats = tracker.getAverage('format');
    expect(stats.avgDurationMs).toBe(15);
    expect(stats.avgTokensSaved).toBe(150);
    expect(stats.samplesCount).toBe(2);
  });

  it('computes efficiency as tokens per millisecond', () => {
    const tracker = createLatencyTracker();
    tracker.record('dedup', 5, 50);
    tracker.record('dedup', 5, 50);

    expect(tracker.getEfficiency('dedup')).toBe(10); // 50 tokens / 5 ms
  });

  it('returns Infinity efficiency for zero-duration stage', () => {
    const tracker = createLatencyTracker();
    expect(tracker.getEfficiency('fast')).toBe(Infinity);
  });

  it('respects rolling window size', () => {
    const tracker = createLatencyTracker(3);
    tracker.record('stage', 10, 100);
    tracker.record('stage', 20, 200);
    tracker.record('stage', 30, 300);
    tracker.record('stage', 40, 400); // pushes out first sample

    const stats = tracker.getAverage('stage');
    expect(stats.samplesCount).toBe(3);
    expect(stats.avgDurationMs).toBe(30); // (20+30+40)/3
    expect(stats.avgTokensSaved).toBe(300); // (200+300+400)/3
  });

  it('tracks multiple stages independently', () => {
    const tracker = createLatencyTracker();
    tracker.record('fast', 2, 10);
    tracker.record('slow', 100, 500);

    expect(tracker.getAverage('fast').avgDurationMs).toBe(2);
    expect(tracker.getAverage('slow').avgDurationMs).toBe(100);
  });

  it('resets all data', () => {
    const tracker = createLatencyTracker();
    tracker.record('stage', 10, 100);

    tracker.reset();

    expect(tracker.getAverage('stage').samplesCount).toBe(0);
  });

  it('handles negative token savings (stage made things worse)', () => {
    const tracker = createLatencyTracker();
    tracker.record('bad-stage', 10, -5);

    expect(tracker.getEfficiency('bad-stage')).toBe(-0.5);
  });
});
