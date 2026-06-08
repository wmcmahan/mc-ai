/**
 * Compile-time + light runtime tests for the SUT-driven suite contract.
 *
 * The contract is mostly types — these tests confirm the types are
 * exported, importable, and structurally usable. Suite migrations land
 * in subsequent commits and will exercise the contract end-to-end.
 */

import { describe, it, expect } from 'vitest';
import type {
  MetricSpec,
  SutSuiteTestCase,
  SutSuiteConfig,
  SutSuiteModule,
} from '../../src/suites/sut-contract.js';
import {
  ANSWER_RELEVANCY,
  FAITHFULNESS,
  LOGICAL_COHERENCE,
} from '../../src/assertions/semantic-judge.js';

describe('SUT-driven suite contract', () => {
  it('accepts a metric spec with default threshold', () => {
    const spec: MetricSpec = { metric: ANSWER_RELEVANCY };
    expect(spec.metric.name).toBe('answer_relevancy');
    expect(spec.threshold).toBeUndefined();
  });

  it('accepts a metric spec with explicit threshold', () => {
    const spec: MetricSpec = { metric: FAITHFULNESS, threshold: 0.9 };
    expect(spec.threshold).toBe(0.9);
  });

  it('accepts a test case with multiple metrics', () => {
    const test: SutSuiteTestCase = {
      trajectoryId: '00000000-0000-0000-0000-000000000001',
      metrics: [
        { metric: ANSWER_RELEVANCY },
        { metric: FAITHFULNESS, threshold: 0.85 },
        { metric: LOGICAL_COHERENCE },
      ],
    };
    expect(test.metrics).toHaveLength(3);
  });

  it('accepts a test case with structuralAssertions disabled', () => {
    const test: SutSuiteTestCase = {
      trajectoryId: '00000000-0000-0000-0000-000000000001',
      metrics: [],
      structuralAssertions: false,
    };
    expect(test.structuralAssertions).toBe(false);
  });

  it('accepts a test case with semantic disabled (empty metrics)', () => {
    const test: SutSuiteTestCase = {
      trajectoryId: '00000000-0000-0000-0000-000000000001',
      metrics: [],
    };
    expect(test.metrics).toEqual([]);
  });

  it('accepts a full suite config', () => {
    const config: SutSuiteConfig = {
      name: 'memory',
      tests: [
        {
          trajectoryId: 't-1',
          description: 'Segmentation: 2-episode split',
          metrics: [{ metric: ANSWER_RELEVANCY }],
        },
      ],
    };
    expect(config.name).toBe('memory');
    expect(config.tests).toHaveLength(1);
  });

  it('SutSuiteModule shape compiles', () => {
    const mod: SutSuiteModule = {
      async buildSutSuite() {
        return { name: 'memory', tests: [] };
      },
    };
    expect(typeof mod.buildSutSuite).toBe('function');
  });
});
