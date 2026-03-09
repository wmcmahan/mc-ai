import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  incrementWorkflowsStarted,
  incrementWorkflowsCompleted,
  incrementWorkflowsFailed,
  recordWorkflowDuration,
  recordTokensUsed,
  recordCostUsd,
  recordAgentDuration,
  setQueueDepthProvider,
  collectMetrics,
} from '../src/utils/metrics.js';

describe('Metrics (disabled / no-op mode)', () => {
  // When METRICS_ENABLED is not 'true', all recording functions are no-ops

  it('incrementWorkflowsStarted does not throw when metrics disabled', () => {
    expect(() => incrementWorkflowsStarted({ graph_id: 'test' })).not.toThrow();
  });

  it('incrementWorkflowsCompleted does not throw when metrics disabled', () => {
    expect(() => incrementWorkflowsCompleted()).not.toThrow();
  });

  it('incrementWorkflowsFailed does not throw when metrics disabled', () => {
    expect(() => incrementWorkflowsFailed()).not.toThrow();
  });

  it('recordWorkflowDuration does not throw when metrics disabled', () => {
    expect(() => recordWorkflowDuration(1234)).not.toThrow();
  });

  it('recordTokensUsed does not throw when metrics disabled', () => {
    expect(() => recordTokensUsed(500)).not.toThrow();
  });

  it('recordCostUsd does not throw when metrics disabled', () => {
    expect(() => recordCostUsd(0.05)).not.toThrow();
  });

  it('recordAgentDuration does not throw when metrics disabled', () => {
    expect(() => recordAgentDuration(100)).not.toThrow();
  });

  it('setQueueDepthProvider accepts a callback without error', () => {
    expect(() => setQueueDepthProvider(async () => 5)).not.toThrow();
  });

  it('collectMetrics returns null when metrics disabled', async () => {
    const result = await collectMetrics();
    expect(result).toBeNull();
  });

  it('recording functions accept optional labels', () => {
    expect(() => incrementWorkflowsStarted({ graph_id: 'g1' })).not.toThrow();
    expect(() => recordWorkflowDuration(500, { graph_id: 'g1' })).not.toThrow();
    expect(() => recordTokensUsed(100, { model: 'gpt-4o' })).not.toThrow();
  });
});
