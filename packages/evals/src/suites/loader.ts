/**
 * Suite Loader
 *
 * Resolves a suite name string to its test suite configuration
 * by dynamically importing from src/suites/<name>/suite.ts.
 *
 * @module suites/loader
 */

import type { EvalProvider } from '../providers/types.js';
import type { SuiteName } from '../dataset/types.js';
import type { TestCaseResults } from '../assertions/drift-calculator.js';

/**
 * The shape that each suite module must export.
 *
 * `buildSuite` is the semantic track (LLM-as-judge via promptfoo).
 * `runDeterministic` is the optional deterministic track (no LLM needed).
 * Suites can implement one or both tracks.
 */
export interface SuiteModule {
  buildSuite(provider: EvalProvider): Promise<SuiteConfig>;
  runDeterministic?(): Promise<TestCaseResults[]>;
}

/**
 * Minimal suite configuration returned by suite builders.
 * Intentionally decoupled from promptfoo's internal types —
 * the runner maps this to promptfoo's TestSuiteConfig.
 */
export interface SuiteConfig {
  /** Suite name. */
  name: string;

  /** Prompt templates for this suite. */
  prompts: string[];

  /** Test cases with variables and assertions. */
  tests: SuiteTestCase[];
}

/** A single test case within a suite. */
export interface SuiteTestCase {
  /** Human-readable description. */
  description: string;

  /** Variables injected into the prompt template. */
  vars: Record<string, string>;

  /** Assertion definitions for promptfoo. */
  assert?: Array<{
    type: string;
    value?: string;
    threshold?: number;
    provider?: string;
  }>;
}

/** All valid suite names. */
const VALID_SUITES: readonly SuiteName[] = ['context-engine', 'memory', 'orchestrator', 'integration'];

/**
 * Loads a single suite by name.
 *
 * Dynamically imports from `./suites/<name>/suite.ts` and calls
 * the exported `buildSuite` function with the active provider.
 *
 * @param name - The suite name to load.
 * @param provider - The active eval provider.
 * @returns The suite configuration.
 * @throws If the suite name is invalid or the module fails to load.
 */
export async function loadSuite(
  name: SuiteName,
  provider: EvalProvider,
): Promise<SuiteConfig> {
  if (!VALID_SUITES.includes(name)) {
    throw new Error(
      `Unknown suite "${name}". Valid suites: ${VALID_SUITES.join(', ')}`,
    );
  }

  try {
    const module = await import(`./${name}/suite.js`) as SuiteModule;
    return module.buildSuite(provider);
  } catch (error) {
    throw new Error(
      `Failed to load suite "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Loads multiple suites. If no names are specified, loads all available suites.
 *
 * @param names - Suite names to load. If omitted, loads all suites.
 * @param provider - The active eval provider.
 * @returns Array of suite configurations.
 */
export async function loadSuites(
  provider: EvalProvider,
  names?: SuiteName[],
): Promise<SuiteConfig[]> {
  const suitesToLoad = names ?? [...VALID_SUITES];
  return Promise.all(suitesToLoad.map(name => loadSuite(name, provider)));
}
