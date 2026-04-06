/**
 * Pipeline Metrics
 *
 * Utility functions for computing and aggregating per-stage
 * compression metrics.
 *
 * @module pipeline/metrics
 */

import type { StageMetrics, PipelineMetrics } from './types.js';

/**
 * Compute metrics for a single compression stage.
 */
export function computeStageMetrics(
  name: string,
  tokensIn: number,
  tokensOut: number,
  durationMs: number,
  error?: boolean,
): StageMetrics {
  return {
    name,
    tokensIn,
    tokensOut,
    ratio: tokensIn > 0 ? tokensOut / tokensIn : 1.0,
    durationMs,
    error,
  };
}

/**
 * Aggregate per-stage metrics into a pipeline-level summary.
 */
export function aggregateMetrics(stages: StageMetrics[]): PipelineMetrics {
  const totalTokensIn = stages.length > 0 ? stages[0].tokensIn : 0;
  const totalTokensOut = stages.length > 0 ? stages[stages.length - 1].tokensOut : 0;
  const totalDurationMs = stages.reduce((sum, s) => sum + s.durationMs, 0);

  return {
    totalTokensIn,
    totalTokensOut,
    overallRatio: totalTokensIn > 0 ? totalTokensOut / totalTokensIn : 1.0,
    reductionPercent: totalTokensIn > 0
      ? ((totalTokensIn - totalTokensOut) / totalTokensIn) * 100
      : 0,
    totalDurationMs,
    stages,
  };
}

/**
 * Format a metrics summary as a human-readable string.
 */
export function formatMetricsSummary(metrics: PipelineMetrics): string {
  const lines = [
    `Total: ${metrics.totalTokensIn} → ${metrics.totalTokensOut} tokens (${metrics.reductionPercent.toFixed(1)}% reduction, ${metrics.totalDurationMs.toFixed(1)}ms)`,
  ];

  for (const stage of metrics.stages) {
    const flag = stage.error ? ' [error: passthrough]' : '';
    lines.push(
      `  ${stage.name}: ${stage.tokensIn} → ${stage.tokensOut} (${((1 - stage.ratio) * 100).toFixed(1)}% saved, ${stage.durationMs.toFixed(1)}ms)${flag}`,
    );
  }

  return lines.join('\n');
}
