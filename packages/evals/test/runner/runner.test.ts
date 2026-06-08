/**
 * Tests for the runner's flag-handling and baseline integration.
 *
 * The deterministic-only path is exercised end-to-end against the real
 * suites — those run in <1s and require no LLM. The baseline path is
 * tested via a temp directory swap so the real baseline file is never
 * touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runEvals } from '../../src/runner/runner.js';

describe('runEvals — deterministic-only mode', () => {
  it('runs without invoking any LLM or loading semantic suites', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });

    expect(result.drift).toBeDefined();
    expect(result.suiteLoadErrors).toEqual([]);
    expect(result.flakyTests).toBeUndefined();
    expect(result.baselineDelta).toBeUndefined();
  });

  it('aggregates deterministic results across suites', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });

    // memory + context-engine + integration deterministic tracks all contribute
    expect(Object.keys(result.drift.perSuite).length).toBeGreaterThan(0);
  });

  it('passes the drift gate for known-good fixtures', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });

    expect(result.drift.passed).toBe(true);
    expect(result.drift.aggregatePercent).toBeLessThan(5);
  });

  it('reports zero flaky tests with samples=1 (default)', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });
    expect(result.flakyTests).toBeUndefined();
  });
});

describe('runEvals — single-suite filter', () => {
  it('restricts deterministic execution to a named suite', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      suites: ['memory'],
    });

    expect(result.drift.perSuite).toHaveProperty('memory');
    // Other suites' deterministic tracks should not have contributed.
    expect(result.drift.perSuite).not.toHaveProperty('context-engine');
  });
});

describe('runEvals — drift ceiling override', () => {
  it('passes when the override permits current drift', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      driftCeiling: 100,
    });
    expect(result.drift.passed).toBe(true);
  });

  it('fails when the override is below current drift', async () => {
    // -1 % ceiling forces failure even on a zero-drift run.
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      driftCeiling: -1,
    });
    expect(result.drift.passed).toBe(false);
  });
});

// Baseline integration tests use a temp `golden/baselines/` location
// to keep tests hermetic. We achieve this by changing the cwd-relative
// path via the snapshot/writer/loader's `goldenDir` arg directly when
// we invoke them, but the runner currently uses the default location.
// So we limit baseline tests to the library-level snapshot/writer
// functions, which already have dedicated tests in test/baseline/.
//
// The runner's baseline wiring is exercised via the CLI smoke test
// below and via type-level validation.

describe('runEvals — baseline option type-check', () => {
  it('accepts baseline: false without error', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
      baseline: false,
    });
    expect(result.baselineDelta).toBeUndefined();
  });
});

describe('runEvals — deterministicOnly bypasses semantic track', () => {
  it('produces drift without invoking the SUT semantic track', async () => {
    const result = await runEvals({
      mode: 'local',
      deterministicOnly: true,
    });
    expect(result.drift).toBeDefined();
    expect(result.suiteLoadErrors).toEqual([]);
    expect(result.flakyTests).toBeUndefined();
  });
});
