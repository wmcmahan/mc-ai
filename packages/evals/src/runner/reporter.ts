/**
 * Eval Reporter
 *
 * Formats drift reports for terminal output and CI annotations.
 *
 * @module runner/reporter
 */

import type { DriftReport, SuiteDriftSummary } from './types.js';
import type { EvalMode } from './types.js';

/** Reporter output format. */
export interface ReportOutput {
  /** Human-readable text output. */
  text: string;

  /** GitHub Actions annotation commands (CI mode only). */
  annotations: string[];
}

/**
 * Formats a drift report for display.
 *
 * In local mode, produces a colored terminal-friendly summary.
 * In CI mode, additionally produces GitHub Actions annotation commands.
 *
 * @param report - The drift report to format.
 * @param mode - Execution mode (affects annotation output).
 * @returns Formatted report text and optional CI annotations.
 */
export function formatReport(report: DriftReport, mode: EvalMode): ReportOutput {
  const lines: string[] = [];
  const annotations: string[] = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════');
  lines.push('  EVAL HARNESS — DRIFT REPORT');
  lines.push('═══════════════════════════════════════════════');
  lines.push('');

  // Per-suite breakdown
  const suiteNames = Object.keys(report.perSuite).sort();

  for (const name of suiteNames) {
    const suite = report.perSuite[name];
    lines.push(formatSuiteSummary(suite));
  }

  if (suiteNames.length > 0) {
    lines.push('');
  }

  // Aggregate
  lines.push('───────────────────────────────────────────────');
  const icon = report.passed ? 'PASS' : 'FAIL';
  lines.push(`  ${icon}  Aggregate Drift: ${report.aggregatePercent.toFixed(1)}%`);
  lines.push('───────────────────────────────────────────────');
  lines.push('');

  // CI annotations
  if (mode === 'ci') {
    if (!report.passed) {
      annotations.push(
        `::error title=Eval Drift Gate Failed::Semantic drift ${report.aggregatePercent.toFixed(1)}% exceeds ceiling. PR blocked.`,
      );
    }

    for (const name of suiteNames) {
      const suite = report.perSuite[name];
      if (suite.zodFailures > 0) {
        annotations.push(
          `::warning title=${name} Zod Failures::${suite.zodFailures} structural assertion(s) failed`,
        );
      }
      if (suite.semanticFailures > 0) {
        annotations.push(
          `::warning title=${name} Semantic Failures::${suite.semanticFailures} semantic assertion(s) failed`,
        );
      }
      if (suite.deterministicFailures > 0) {
        annotations.push(
          `::warning title=${name} Deterministic Failures::${suite.deterministicFailures} deterministic assertion(s) failed`,
        );
      }
    }
  }

  return { text: lines.join('\n'), annotations };
}

/**
 * Formats a single suite's drift summary as a text line.
 */
function formatSuiteSummary(suite: SuiteDriftSummary): string {
  const status = suite.driftPercent === 0 ? 'PASS' : 'DRIFT';
  const parts = [
    `  ${status}  ${suite.suiteName}`,
    `${suite.totalTests} tests`,
    `drift ${suite.driftPercent.toFixed(1)}%`,
  ];

  const failures: string[] = [];
  if (suite.zodFailures > 0) failures.push(`${suite.zodFailures} zod`);
  if (suite.semanticFailures > 0) failures.push(`${suite.semanticFailures} semantic`);
  if (suite.deterministicFailures > 0) failures.push(`${suite.deterministicFailures} deterministic`);

  if (failures.length > 0) {
    parts.push(`(${failures.join(', ')})`);
  }

  return parts.join(' — ');
}
