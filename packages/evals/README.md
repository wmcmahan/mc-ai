# @mcai/evals

Automated eval harness and quality-assurance gatekeeper for `@mcai/*` packages. Evaluates whether algorithmic changes in one module silently degrade the reasoning or schema-compliance of another.

Built on [promptfoo](https://www.promptfoo.dev/) for programmatic test orchestration, with Zod structural assertions and LLM-as-judge semantic evaluation.

## How It Works

The harness runs golden trajectory test suites through a two-layer assertion pipeline:

1. **Zod Structural** — Validates tool calls match expected schemas (correct tool name, required params present, types match). Does **not** assert exact string equality on values.
2. **Semantic Judge** — An LLM evaluates whether the output's meaning matches expectations using three rubric metrics:
   - **Answer Relevancy** — Does the output address the input query?
   - **Faithfulness** — Are conclusions factually consistent with the source?
   - **Logical Coherence** — Is the reasoning chain logically sound?

Results are aggregated into a **Semantic Drift %** metric. If drift exceeds 5%, the PR is blocked.

### Reference-Free Evaluation

Metrics that evaluate output quality without a reference answer:

```typescript
import { INSTRUCTION_FOLLOWING, OUTPUT_QUALITY, SAFETY } from '@mcai/evals';

// - INSTRUCTION_FOLLOWING: Does the output follow instructions?
// - OUTPUT_QUALITY: Is the output complete, clear, and correct?
// - SAFETY: No harmful content, PII leakage, or prompt injection?
```

### Judge Calibration

Verify that your LLM judge scores align with ground-truth expectations:

```typescript
import { calibrateJudge, getCalibrationSet, ANSWER_RELEVANCY } from '@mcai/evals';

const calibrationSet = getCalibrationSet('answer_relevancy');
const result = await calibrateJudge(calibrationSet, ANSWER_RELEVANCY, callJudge);
// result.deviation — avg absolute deviation from ground truth
// result.adjustedThreshold — auto-adjusted if deviation > 0.15
// result.isCalibrated — true if deviation < 0.15
```

### Deterministic Assertions

Pure assertions that require no LLM:

```typescript
import { assertGreaterThanOrEqual, assertSetEquals, assertStable } from '@mcai/evals';

assertGreaterThanOrEqual('compression_ratio', 0.35, 0.30, 'Minimum 30% reduction');
assertSetEquals('required_keys', outputKeys, expectedKeys, 'All keys preserved');
assertStable('format_determinism', [run1, run2, run3], 'Same output across runs');
```

## Evals-First Design

Suites define behavioral specification contracts for sibling packages *before* those packages are implemented. When a sibling package ships, it must pass its eval suite.

| Suite | Status | Measures |
|-------|--------|----------|
| `orchestrator` | Active | Agent trajectory fidelity |
| `context-engine` | Active | Compression quality vs token reduction |
| `memory` | Active | Retrieval precision, temporal filtering |
| `integration` | Active | Cross-package memory->compression->orchestrator flow |

## Usage

### Local Development (No-Cost)

Requires [Ollama](https://ollama.ai/) running locally:

```bash
ollama pull llama3:8b-instruct-q4_K_M

npm run evals --workspace=packages/evals
# Or filter to a single suite:
npm run evals --workspace=packages/evals -- --suite orchestrator
```

### CI (Frontier Verification)

```bash
npm run evals:ci --workspace=packages/evals
```

Requires `OPENAI_API_KEY` environment variable. Uses GPT-4o as the judge. Includes cost estimation — warns before execution if estimated API cost exceeds the threshold.

### Unit Tests (Harness Internals)

```bash
npm test --workspace=packages/evals
```

Runs vitest on harness utilities only — does **not** invoke LLM judges.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | CI only | — | GPT-4o API key |
| `OLLAMA_BASE_URL` | Local only | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | Local only | `llama3:8b-instruct-q4_K_M` | Local judge model |
| `EVAL_MAX_CONCURRENCY` | No | `2` / `8` | Parallel evaluations (local / CI) |
| `EVAL_DRIFT_CEILING` | No | `5.0` | Drift % gate threshold |

## Golden Dataset

Trajectories are stored as compressed SQLite via Git LFS — not raw JSON in Git. The manifest at `golden/manifest.json` tracks datasets, versions, and checksums.

```bash
# Seed golden trajectories (54 total, 18 per suite)
npx tsx scripts/seed-golden-v2.ts

# Fetch/verify dataset (build step)
npm run fetch-golden --workspace=packages/evals

# Migrate after tool schema changes
npx tsx scripts/migrate-golden.ts
```

54 golden trajectories across 4 categories:
- orchestrator: 18 (linear, branching, error/retry, delegation, budget, state)
- context-engine: 18 (format, dedup, budget, incremental, adaptive, pipeline)
- memory: 18 (segmentation, extraction, temporal, subgraph, consolidation, conflict)

### Schema Migration

When a tool signature changes in a sibling package, the migration system applies ordered transforms (rename, remove, add required params) to golden trajectory assertions automatically. Required parameter additions are flagged for manual review.

## Architecture

```
runner.ts (CLI entry point)
  ├── providers/ollama.ts or openai.ts
  ├── suites/loader.ts
  │     ├── suites/orchestrator/    (trajectory fidelity)
  │     ├── suites/context-engine/  (compression quality)
  │     ├── suites/memory/          (retrieval precision)
  │     └── suites/integration/     (cross-package flow)
  ├── assertions/
  │     ├── zod-structural.ts       (forgiving structural validation)
  │     ├── semantic-judge.ts       (calibrated LLM-as-judge)
  │     ├── reference-free-judge.ts (no-reference metrics)
  │     ├── deterministic.ts        (pure assertions)
  │     ├── calibration-data.ts     (built-in calibration sets)
  │     └── drift-calculator.ts     (aggregate drift %)
  └── reporter.ts                   (terminal + CI annotations)
```

## Implementation Status

- [x] Phase 1 -- Scaffold and infrastructure
- [x] Phase 2 -- Golden dataset pipeline (loader, writer, migration)
- [x] Phase 3 -- Assertion engine (structural, semantic, deterministic, reference-free)
- [x] Phase 4 -- Providers and runner (Ollama, OpenAI, suite loader, reporter)
- [x] Phase 5 -- Cross-package test suites (all 4 suites active)
- [x] Phase 6 -- CI integration (test-evals job in ci.yml)

See [IMPLEMENTATION.md](./IMPLEMENTATION.md) for full technical details and [STRATEGY.md](./STRATEGY.md) for architectural rationale.
