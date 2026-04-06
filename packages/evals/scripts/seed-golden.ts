/**
 * Seed Golden Dataset
 *
 * Generates initial golden trajectories for each suite and writes
 * them to compressed SQLite files in golden/data/.
 *
 * Usage:
 *   npx tsx scripts/seed-golden.ts
 *
 * This is a one-time setup script. After seeding, trajectories are
 * maintained via the migration system.
 */

import { randomUUID } from 'node:crypto';
import { writeGoldenDataset } from '../src/dataset/writer.js';
import type { GoldenTrajectory } from '../src/dataset/types.js';

const now = new Date().toISOString();

// ─── Orchestrator Suite Trajectories ───────────────────────────────

const orchestratorTrajectories: GoldenTrajectory[] = [
  {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Supervisor routes research task to the research agent',
    input: 'Research the latest developments in quantum computing and summarize your findings.',
    expectedOutput: 'A structured summary of quantum computing developments.',
    expectedToolCalls: [
      {
        toolName: 'delegate_to_agent',
        args: {
          agent: 'research',
          task: 'Research quantum computing developments',
        },
      },
    ],
    tags: ['supervisor', 'routing'],
    source: 'internal',
    createdAt: now,
  },
  {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Agent selects web_search tool for information gathering',
    input: 'Find the current CEO of Anthropic.',
    expectedOutput: 'Dario Amodei is the CEO of Anthropic.',
    expectedToolCalls: [
      {
        toolName: 'web_search',
        args: {
          query: 'current CEO of Anthropic',
        },
      },
    ],
    tags: ['tool-selection', 'web-search'],
    source: 'internal',
    createdAt: now,
  },
  {
    id: randomUUID(),
    suite: 'orchestrator',
    description: 'Multi-turn agent completes without tool calls when answer is known',
    input: 'What is 2 + 2?',
    expectedOutput: '4',
    expectedToolCalls: [],
    tags: ['no-tools', 'direct-answer'],
    source: 'internal',
    createdAt: now,
  },
];

// ─── Context Engine Suite Trajectories (Behavioral Spec) ───────────

const contextEngineTrajectories: GoldenTrajectory[] = [
  {
    id: randomUUID(),
    suite: 'context-engine',
    description: 'JSON-to-TOON format compression preserves tabular data',
    input: JSON.stringify([
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
    ]),
    expectedOutput: '@name @role @score\nAlice researcher 92\nBob writer 87',
    tags: ['format-compression', 'toon', 'tabular'],
    source: 'internal',
    createdAt: now,
  },
  {
    id: randomUUID(),
    suite: 'context-engine',
    description: 'CoT distillation evicts reasoning trace but preserves conclusion',
    input: '<think>Let me analyze this step by step. First, I need to consider X. Then Y leads to Z.</think>The answer is 42.',
    expectedOutput: 'The answer is 42.',
    tags: ['cot-distillation', 'think-eviction'],
    source: 'internal',
    createdAt: now,
  },
];

// ─── Memory Suite Trajectories (Behavioral Spec) ───────────────────

const memoryTrajectories: GoldenTrajectory[] = [
  {
    id: randomUUID(),
    suite: 'memory',
    description: 'Subgraph extraction returns only relevant entities within 2 hops',
    input: 'What do we know about Project Alpha?',
    expectedOutput: {
      entities: ['Project Alpha', 'Alice', 'Q1 Deadline'],
      relationships: ['leads', 'has_deadline'],
    },
    tags: ['subgraph', 'extraction'],
    source: 'internal',
    createdAt: now,
  },
  {
    id: randomUUID(),
    suite: 'memory',
    description: 'Temporal filtering excludes invalidated facts',
    input: 'Who is the team lead?',
    expectedOutput: {
      currentFact: 'Bob is the team lead (as of 2026-03)',
      invalidatedFact: 'Alice was the team lead (invalidated 2026-02)',
    },
    tags: ['temporal', 'filtering'],
    source: 'internal',
    createdAt: now,
  },
];

// ─── Write All Datasets ────────────────────────────────────────────

console.log('Seeding golden datasets...\n');

writeGoldenDataset('orchestrator', orchestratorTrajectories, '1.0.0');
console.log(`  orchestrator: ${orchestratorTrajectories.length} trajectories`);

writeGoldenDataset('context-engine', contextEngineTrajectories, '1.0.0');
console.log(`  context-engine: ${contextEngineTrajectories.length} trajectories`);

writeGoldenDataset('memory', memoryTrajectories, '1.0.0');
console.log(`  memory: ${memoryTrajectories.length} trajectories`);

console.log('\nDone. Golden datasets written to golden/data/');
