/**
 * Gate Validation Simulator
 *
 * Measures the retention gate's *realized* operating characteristics —
 * how often it promotes, evicts, or holds lessons of known true effect
 * under a given policy, run volume, and noise level. The statistical
 * machinery in the gate makes claims; this module is how you check them
 * against YOUR configuration before trusting it.
 *
 * The simulator drives the real production code path — an actual
 * `InMemoryMemoryStore`, `InMemoryOutcomeLedger`, `retrieveGatedLessons`
 * and `evaluateRetention` — with synthetic outcomes:
 *
 *   score(run) = clamp01( base + Σ true_effect(injected lessons) + N(0, noise_sd) )
 *
 * No LLM, no network: a full operating-characteristics grid runs in
 * seconds and is fully deterministic given a seed.
 *
 * @module validation/gate-simulator
 */

import { InMemoryMemoryStore } from '../store/in-memory-store.js';
import {
  InMemoryOutcomeLedger,
} from '../consolidation/outcome-ledger.js';
import {
  evaluateRetention,
  type RetentionPolicy,
  type RetentionReport,
  type EvictionReason,
} from '../consolidation/retention-gate.js';
import { retrieveGatedLessons } from '../retrieval/gated-lesson-retriever.js';
import { mulberry32, gaussian } from '../utils/statistics.js';
import type { SemanticFact } from '../schemas/semantic.js';

/** Fixed epoch so simulated `valid_from` ordering is deterministic. */
const SIM_EPOCH_MS = Date.UTC(2026, 0, 1);
const SIM_TAG = 'gate-sim';

export interface SimulatedLesson {
  id: string;
  /** True causal effect on the run score when this lesson is injected. */
  true_effect: number;
  /** First run (1-based) at which the lesson exists as a candidate. */
  arrives_at_run: number;
}

export interface GateSimulationConfig {
  lessons: SimulatedLesson[];
  /** Total runs to simulate. */
  runs: number;
  /** Score of a lesson-free run before noise (default 0.6). */
  base_score?: number;
  /** Run-score noise SD — judge noise + run variability (default 0.1). */
  noise_sd?: number;
  /** PRNG seed — same seed, same config → byte-identical results. */
  seed: number;
  /** Passed through to `retrieveGatedLessons`. */
  retrieval?: {
    max_facts?: number;
    candidate_slots?: number;
    rest_after_trials?: number;
  };
  /** Passed through to `evaluateRetention`. */
  policy?: Partial<RetentionPolicy>;
  /** Gate cadence in runs (default 1 = gate after every run). */
  gate_every?: number;
  /**
   * Record runs that injected zero lessons (default true). Simulated
   * empty runs are exchangeable with lesson-free reality, so they make
   * clean baselines; live workflows may prefer to skip cold-start runs.
   */
  record_empty_runs?: boolean;
}

export interface SimulatedLessonOutcome {
  id: string;
  true_effect: number;
  outcome: 'promoted' | 'evicted' | 'held';
  reason?: EvictionReason;
  /** Run after which the gate decided (undefined while held). */
  decided_at_run?: number;
}

export interface GateSimulationResult {
  lessons: SimulatedLessonOutcome[];
  run_scores: number[];
  gate_reports: Array<{ after_run: number; report: RetentionReport }>;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function makeSimFact(lesson: SimulatedLesson, candidateTag: string): SemanticFact {
  return {
    id: lesson.id,
    content: `Simulated lesson ${lesson.id} (true effect ${lesson.true_effect})`,
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'system', created_at: new Date(SIM_EPOCH_MS) },
    valid_from: new Date(SIM_EPOCH_MS + lesson.arrives_at_run * 1000),
    tags: ['lesson', SIM_TAG, candidateTag],
  };
}

/**
 * Simulate `runs` workflow runs against the real store/ledger/retriever/
 * gate pipeline with synthetic outcomes. Fully deterministic per seed.
 */
export async function simulateGate(config: GateSimulationConfig): Promise<GateSimulationResult> {
  const base = config.base_score ?? 0.6;
  const noiseSd = config.noise_sd ?? 0.1;
  const gateEvery = config.gate_every ?? 1;
  const recordEmpty = config.record_empty_runs ?? true;
  const candidateTag = config.policy?.candidate_tag ?? 'candidate';

  const store = new InMemoryMemoryStore();
  const ledger = new InMemoryOutcomeLedger();
  const rng = mulberry32(config.seed);

  const effects = new Map(config.lessons.map((l) => [l.id, l.true_effect]));
  const decided = new Map<string, { outcome: 'promoted' | 'evicted'; reason?: EvictionReason; run: number }>();

  const runScores: number[] = [];
  const gateReports: GateSimulationResult['gate_reports'] = [];

  for (let run = 1; run <= config.runs; run++) {
    // Lessons arriving this run enter the candidate pool.
    for (const lesson of config.lessons) {
      if (lesson.arrives_at_run === run) {
        await store.putFact(makeSimFact(lesson, candidateTag));
      }
    }

    const injected = await retrieveGatedLessons(store, {
      tags: [SIM_TAG],
      ledger,
      ...(config.retrieval ?? {}),
    });

    const liftSum = injected.reduce((s, f) => s + (effects.get(f.id) ?? 0), 0);
    const score = clamp01(base + liftSum + gaussian(rng) * noiseSd);
    runScores.push(score);

    if (injected.length > 0 || recordEmpty) {
      await ledger.recordOutcome({
        run_id: `sim-run-${run}`,
        score,
        fact_ids: injected.map((f) => f.id),
      });
    }

    if (run % gateEvery === 0) {
      const report = await evaluateRetention(store, ledger, config.policy ?? {});
      gateReports.push({ after_run: run, report });
      for (const p of report.promoted) {
        if (effects.has(p.fact_id) && !decided.has(p.fact_id)) {
          decided.set(p.fact_id, { outcome: 'promoted', run });
        }
      }
      for (const e of report.evicted) {
        if (effects.has(e.fact_id) && !decided.has(e.fact_id)) {
          decided.set(e.fact_id, { outcome: 'evicted', reason: e.reason, run });
        }
      }
    }
  }

  const lessons: SimulatedLessonOutcome[] = config.lessons.map((l) => {
    const d = decided.get(l.id);
    if (!d) return { id: l.id, true_effect: l.true_effect, outcome: 'held' };
    return {
      id: l.id,
      true_effect: l.true_effect,
      outcome: d.outcome,
      ...(d.reason ? { reason: d.reason } : {}),
      decided_at_run: d.run,
    };
  });

  return { lessons, run_scores: runScores, gate_reports: gateReports };
}

// ─── Operating characteristics ──────────────────────────────────────

export interface OperatingCharacteristicsConfig {
  /** True effect sizes to test (negative = harmful lesson). */
  effects: number[];
  /** Run-volume levels. */
  runCounts: number[];
  /** Noise levels (default [0.1]). */
  noiseSds?: number[];
  /** Seeded replicates per grid cell (default 20). */
  replicates?: number;
  /** Base seed (default 1). */
  seed?: number;
  base_score?: number;
  retrieval?: GateSimulationConfig['retrieval'];
  policy?: Partial<RetentionPolicy>;
  gate_every?: number;
}

export interface OperatingCharacteristicsRow {
  effect: number;
  runs: number;
  noise_sd: number;
  replicates: number;
  /** Fraction of replicates where the lesson ended promoted. */
  promote_rate: number;
  /** Fraction ended evicted (any reason). */
  evict_rate: number;
  /** Fraction evicted as harmful — the "detected as harmful" rate. */
  harmful_evict_rate: number;
  /** Fraction retired as no-lift (max_trials / max_baseline_runs). */
  no_lift_rate: number;
  /** Fraction still held at the end. */
  held_rate: number;
  /** Promotions of a lesson with effect ≤ 0 (false discovery). */
  false_promote_rate: number;
  /** Harmful-evictions of a lesson with effect ≥ 0 (false alarm). */
  false_evict_rate: number;
  /** Mean run at which decided replicates reached their verdict. */
  mean_decision_run: number | null;
}

/**
 * Sweep the gate over a grid of (effect × run volume × noise) cells,
 * one lesson per replicate, and report decision rates per cell.
 *
 * This is the chart that tells you where to trust your policy: a
 * detection-rate curve by run count per effect size, and the
 * false-positive floor at effect 0.
 */
export async function gateOperatingCharacteristics(
  config: OperatingCharacteristicsConfig,
): Promise<OperatingCharacteristicsRow[]> {
  const noiseSds = config.noiseSds ?? [0.1];
  const replicates = config.replicates ?? 20;
  const baseSeed = config.seed ?? 1;

  const rows: OperatingCharacteristicsRow[] = [];
  let cell = 0;

  for (const noise_sd of noiseSds) {
    for (const effect of config.effects) {
      for (const runs of config.runCounts) {
        cell++;
        let promoted = 0;
        let evicted = 0;
        let harmfulEvicted = 0;
        const decisionRuns: number[] = [];

        for (let rep = 0; rep < replicates; rep++) {
          const result = await simulateGate({
            lessons: [{ id: 'lesson-under-test', true_effect: effect, arrives_at_run: 1 }],
            runs,
            noise_sd,
            base_score: config.base_score,
            seed: baseSeed * 1_000_000 + cell * 1_000 + rep,
            retrieval: config.retrieval,
            policy: config.policy,
            gate_every: config.gate_every,
          });
          const lesson = result.lessons[0];
          if (lesson.outcome === 'promoted') promoted++;
          if (lesson.outcome === 'evicted') {
            evicted++;
            if (lesson.reason === 'eval-gate:harmful') harmfulEvicted++;
          }
          if (lesson.decided_at_run !== undefined) decisionRuns.push(lesson.decided_at_run);
        }

        rows.push({
          effect,
          runs,
          noise_sd,
          replicates,
          promote_rate: promoted / replicates,
          evict_rate: evicted / replicates,
          harmful_evict_rate: harmfulEvicted / replicates,
          no_lift_rate: (evicted - harmfulEvicted) / replicates,
          held_rate: (replicates - promoted - evicted) / replicates,
          false_promote_rate: effect <= 0 ? promoted / replicates : 0,
          false_evict_rate: effect >= 0 ? harmfulEvicted / replicates : 0,
          mean_decision_run:
            decisionRuns.length === 0
              ? null
              : decisionRuns.reduce((s, v) => s + v, 0) / decisionRuns.length,
        });
      }
    }
  }

  return rows;
}
