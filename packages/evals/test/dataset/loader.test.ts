import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadManifest, loadGoldenTrajectories, listAvailableSuites } from '../../src/dataset/loader.js';
import { writeGoldenDataset } from '../../src/dataset/writer.js';
import type { GoldenTrajectory } from '../../src/dataset/types.js';

const TEST_GOLDEN_DIR = resolve(import.meta.dirname, '../.test-golden');

const sampleTrajectories: GoldenTrajectory[] = [
  {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Test trajectory 1',
    input: 'Test input 1',
    expectedOutput: 'Test output 1',
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
  },
  {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Test trajectory 2',
    input: 'Test input 2',
    expectedOutput: { key: 'structured output' },
    expectedToolCalls: [{ toolName: 'web_search', args: { query: 'test' } }],
    tags: ['test'],
    source: 'internal',
    createdAt: '2026-04-01T00:00:00Z',
  },
];

beforeAll(() => {
  mkdirSync(resolve(TEST_GOLDEN_DIR, 'data'), { recursive: true });
  writeGoldenDataset('orchestrator', sampleTrajectories, '1.0.0', TEST_GOLDEN_DIR);
});

afterAll(() => {
  rmSync(TEST_GOLDEN_DIR, { recursive: true, force: true });
});

describe('loadManifest', () => {
  it('loads and validates the manifest', () => {
    const manifest = loadManifest(TEST_GOLDEN_DIR);

    expect(manifest.version).toBe('1');
    expect(manifest.datasets).toHaveLength(1);
    expect(manifest.datasets[0].name).toBe('orchestrator');
    expect(manifest.datasets[0].trajectoryCount).toBe(2);
  });

  it('throws on missing manifest', () => {
    expect(() => loadManifest('/nonexistent/path')).toThrow();
  });
});

describe('loadGoldenTrajectories', () => {
  it('loads and validates trajectories from compressed SQLite', () => {
    const trajectories = loadGoldenTrajectories('orchestrator', TEST_GOLDEN_DIR);

    expect(trajectories).toHaveLength(2);
    expect(trajectories[0].suite).toBe('orchestrator');
    expect(trajectories[0].description).toBe('Test trajectory 1');
    expect(trajectories[1].expectedOutput).toEqual({ key: 'structured output' });
    expect(trajectories[1].expectedToolCalls).toHaveLength(1);
  });

  it('throws for a suite not in the manifest', () => {
    expect(() => loadGoldenTrajectories('memory', TEST_GOLDEN_DIR)).toThrow(
      /Suite "memory" not found in manifest/,
    );
  });
});

describe('listAvailableSuites', () => {
  it('returns suite names from the manifest', () => {
    const suites = listAvailableSuites(TEST_GOLDEN_DIR);

    expect(suites).toEqual(['orchestrator']);
  });
});
