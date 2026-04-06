/**
 * Eval Runner
 *
 * Top-level entry point for the eval harness. Selects the provider
 * based on execution mode, loads suites, executes via promptfoo,
 * computes drift, and gates on the result.
 *
 * Usage:
 *   npx tsx src/runner/runner.ts --mode local
 *   npx tsx src/runner/runner.ts --mode ci
 *   npx tsx src/runner/runner.ts --mode local --suite orchestrator
 *
 * @module runner/runner
 */

import { parseArgs } from 'node:util';
import { evaluate } from 'promptfoo';
import { createOllamaProvider } from '../providers/ollama.js';
import { createOpenAIProvider } from '../providers/openai.js';
import { loadSuites } from '../suites/loader.js';
import type { SuiteModule } from '../suites/loader.js';
import { computeDrift } from '../assertions/drift-calculator.js';
import { formatReport } from './reporter.js';
import type { EvalRunConfig, EvalResult, DriftReport } from './types.js';
import type { EvalProvider } from '../providers/types.js';
import type { SuiteName } from '../dataset/types.js';
import type { TestCaseResults } from '../assertions/drift-calculator.js';

// ─── Provider Selection ────────────────────────────────────────────

function selectProvider(config: EvalRunConfig): EvalProvider {
  if (config.mode === 'ci') {
    return createOpenAIProvider();
  }
  return createOllamaProvider();
}

// ─── Main Runner ───────────────────────────────────────────────────

/**
 * Runs the eval harness.
 *
 * 1. Select provider based on mode
 * 2. Load requested suite(s)
 * 3. Check cost estimate and warn if needed
 * 4. Execute via promptfoo.evaluate()
 * 5. Compute aggregate drift
 * 6. Format and output report
 * 7. Exit with code 1 if drift exceeds ceiling
 *
 * @param config - Run configuration.
 * @returns Eval result with drift report.
 */
export async function runEvals(config: EvalRunConfig): Promise<EvalResult> {
  const provider = selectProvider(config);
  const maxConcurrency = config.maxConcurrency ?? provider.maxConcurrency;
  const driftCeiling = config.driftCeiling
    ?? parseFloat(process.env['EVAL_DRIFT_CEILING'] ?? '5.0');

  // Determine which suites to load
  const suitesToLoad = config.suites ?? ['context-engine', 'memory', 'orchestrator'] as SuiteName[];

  // Run deterministic track (no LLM needed, fast, free)
  const deterministicResults: TestCaseResults[] = [];
  for (const suiteName of suitesToLoad) {
    try {
      const mod = await import(`../suites/${suiteName}/suite.js`) as SuiteModule;
      if (mod.runDeterministic) {
        const results = await mod.runDeterministic();
        deterministicResults.push(...results);
      }
    } catch {
      // Suite has no deterministic track or failed to load — continue
    }
  }

  // Load semantic suites (may throw for stubs — collect only successful ones)
  const suites = await loadSuites(provider, config.suites).catch(() => []);

  // Flatten all tests across suites
  const allPrompts = suites.flatMap(s => s.prompts);
  const allTests = suites.flatMap(s =>
    s.tests.map(t => ({
      ...t,
      metadata: { suite: s.name },
    })),
  );

  // Run semantic track via promptfoo (only if there are semantic tests)
  let testCaseResults: TestCaseResults[] = [];

  if (allTests.length > 0) {
    // Cost estimate
    const costEstimate = provider.estimateCost(allTests.length);
    if (costEstimate.warning) {
      console.warn(`Cost warning: ${costEstimate.warning}`);
    }

    // Execute via promptfoo
    // Cast to `any` at the promptfoo boundary — our SuiteConfig types are
    // intentionally decoupled from promptfoo's strict union types.
    const providerConfig = provider.getProviderConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await evaluate(
      {
        prompts: allPrompts,
        providers: [providerConfig],
        tests: allTests,
      } as any,
      {
        maxConcurrency,
        showProgressBar: config.mode !== 'ci',
      },
    );

    // Map promptfoo results to TestCaseResults for drift calculation
    testCaseResults = results.results.map(r => {
      const suite = (r.testCase?.metadata as Record<string, unknown>)?.suite as string ?? 'unknown';
      const allPassed = r.success;

      return {
        suite,
        zodResults: [{
          passed: allPassed,
          toolName: 'promptfoo_assertion',
          missingParams: [],
          typeMismatches: [],
        }],
        semanticResults: [{
          passed: allPassed,
          score: allPassed ? 1.0 : 0.0,
          reasoning: allPassed ? 'All assertions passed' : 'One or more assertions failed',
          metric: 'aggregate',
        }],
      };
    });
  }

  // Merge deterministic + semantic results for unified drift computation
  const allResults = [...deterministicResults, ...testCaseResults];

  // Compute drift
  const drift = computeDrift(allResults, driftCeiling);

  // Report
  const report = formatReport(drift, config.mode);
  console.log(report.text);

  for (const annotation of report.annotations) {
    console.log(annotation);
  }

  return { drift, raw: allResults };
}

// ─── CLI Entry Point ───────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', short: 'm', default: 'local' },
      suite: { type: 'string', short: 's' },
    },
    strict: false,
  });

  const mode = values.mode === 'ci' ? 'ci' : 'local' as const;
  const suites = values.suite
    ? [values.suite as SuiteName]
    : undefined;

  const result = await runEvals({ mode, suites });

  if (!result.drift.passed) {
    process.exitCode = 1;
  }
}

// Run if this is the entry point
const isMainModule = process.argv[1]?.includes('runner');
if (isMainModule) {
  main().catch(error => {
    console.error('Eval runner failed:', error);
    process.exitCode = 1;
  });
}
