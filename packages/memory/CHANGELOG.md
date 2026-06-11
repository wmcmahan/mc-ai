# @cycgraph/memory

## 0.1.0-beta.5

### Minor Changes

- 8f211cc: Eval-gated learning ("verified lessons"): lessons are now retained only if runs that used them verifiably score better.

  **@cycgraph/orchestrator — lesson provenance.** Retrieved memory facts can carry an `id` (`MemoryRetrievalResult.facts[].id`, optional and non-breaking). When present, the runner records which facts were injected into each node's prompt in an append-only `memory._lesson_provenance` registry (same replay-safe pattern as the taint registry; invisible to node StateViews). Voting and evolution forward provenance from every sub-agent — losing candidates count as trials too. New exports: `getInjectedFactIds(state)`, `getLessonProvenance(state)`, `getLessonProvenanceRegistry(memory)`, plus the `LessonProvenanceEntry` / `LessonProvenanceRegistry` types. Known v1 limitation: supervisor-node retrieval is not provenance-tracked.

  **@cycgraph/memory — outcome ledger, retention gate, gated retrieval.** New `OutcomeLedger` interface + `InMemoryOutcomeLedger` (`recordOutcome({ run_id, score, fact_ids })`, per-fact trial stats, leave-one-out baselines). New `evaluateRetention(store, ledger, policy)` promotes `candidate`-tagged lessons that lift outcomes past `promote_margin` (tag rewritten to `verified`), soft-evicts harmful ones (`invalidated_by: 'eval-gate:harmful'`), and retires no-lift candidates at `max_trials` — including ones deadlocked on an empty leave-one-out baseline. New `retrieveGatedLessons(store, options)` fills the prompt budget verified-first with candidate exploration slots, selected in-progress-first via the ledger, with a `rest_after_trials` bench phase so fully-trialled candidates create the absence runs their baseline needs.

  Runnable adversarial demo at `packages/evals/examples/eval-gated-learning/`: three deliberately poisoned lessons crater a run and the gate evicts all three on outcome evidence alone, two runs after injection.

## 0.1.0-beta.4

### Minor Changes

- 131e3d3: Performance & scale (Phase 5): cut the cost of the hot paths and add the knobs to keep a long/large run bounded.

  **Tag-filtered fact retrieval is now an index lookup, not a table scan.** `FactFilter` gained a `tags` field; the hierarchical retriever pushes the reflection-loop's tag filter into the store instead of paging the whole table and filtering client-side. The Postgres store resolves it via `tags ?| array[...]` backed by a new GIN index on `memory_facts.tags` (migration `0015`) and now applies a deterministic `ORDER BY valid_from DESC, id` so `LIMIT/OFFSET` pagination is stable. The in-memory store honors the same `tags` filter (insertion-ordered, already stable). **Run `0015_add_memory_facts_tags_gin` before relying on tag retrieval at scale** — on a large live table prefer `CREATE INDEX CONCURRENTLY` out-of-band.

  **Evolution scores candidates in parallel** (bounded by the existing `max_concurrency`) instead of one evaluator call at a time — a generation now takes ~one evaluation's wall-clock, not N. It also stores per-candidate fitness **summaries** in `${node}_population` (index/fitness/reasoning) rather than every candidate's full output (the winner's full output already lives in `${node}_winner`), shrinking state and every checkpoint.

  **Memory retrieval is bounded and batched.** `extractSubgraph` gained a `max_entities` cap (default `DEFAULT_MAX_SUBGRAPH_ENTITIES = 500`) so a dense graph can't expand the BFS frontier near-exponentially, and it batch-fetches visited entities (`getEntities`) instead of one round-trip each.

  **Sanitize-after-truncate in prompt building.** Injection-sanitization is now the **last** transformation before memory/retrieved-memory is embedded — applied to exactly the bytes that reach the prompt (and to compressor output, which is now also byte-capped). Closes the window where truncating after sanitizing could leave a partial boundary artifact, and stops wasting sanitization on bytes that get dropped.

  **Delta tracker no longer loses patches on a failed persist.** `computeDelta` advances its baseline optimistically but stashes the prior baseline; the persistence coordinator calls the new `rollback()` if the write throws, so the next delta diffs against the last _durably persisted_ state (no lost changes, no skipped version numbers).

  **Auto-compaction is on by default.** `GraphRunnerOptions.compaction_interval` now defaults to `DEFAULT_COMPACTION_INTERVAL = 1000` (was `0`/disabled) when an `eventLog` is wired, so a long run can't grow the event log without bound. Compaction is recovery-safe (checkpoint + `loadEventsAfter`). Set `compaction_interval: 0` to retain full history and compact manually. The snapshot-resume idempotency rebuild is now checkpoint-aware — it loads only the tail after the latest checkpoint instead of the entire event history.

  **New `RateLimiter` port.** Inject `GraphRunnerOptions.rateLimiter` to pace LLM calls inside a provider's budget — awaited before every agent/supervisor/evaluator call at a single chokepoint (the implementation may delay to throttle or throw to reject; abortable; propagated into subgraphs). New exports: `RateLimiter`, `RateLimitRequest`, `RateLimitCallKind`.

  **Per-server MCP concurrency limit.** `MCPConnectionManager` accepts `default_max_concurrent_calls`, and `MCPServerEntry` gained `max_concurrent_calls`, bounding in-flight tool calls per server (via a FIFO semaphore) so a wide fan-out can't overwhelm one MCP server. Defaults to unlimited for compatibility.

## 0.1.0-beta.3

### Minor Changes

- d3641f2: Compound learning: `reflection` node type + `MemoryWriter` + tag-based retrieval.

  **@cycgraph/orchestrator**

  - New `reflection` node type that distills `source_keys` from workflow memory into atomic facts and persists them via an injected `MemoryWriter`. Two extractor variants:
    - `rule_based` — deterministic sentence-level extraction, no LLM call
    - `llm` — uses the new `extractFactsExecutor` primitive via a structured-output agent
  - New `MemoryWriter` adapter type on `GraphRunnerOptions` (mirrors `MemoryRetriever`).
  - New `extractFactsExecutor` primitive (sibling to `evaluateQualityExecutor`) for LLM-based fact distillation.
  - New `memory_query` directive on `GraphNode` — declares per-node retrieval (text / entity_ids / tags / max_facts). When set, the runner calls `memoryRetriever` before agent / supervisor prompt construction and renders results into a `## Relevant Memory` section ahead of the workflow-state `<data>` block. Voting and evolution nodes propagate `memory_query` to synthetic sub-nodes automatically.
  - `MemoryRetriever` query type gained `tags?: string[]`.
  - New errors: `MemoryWriterMissingError` (barrel-exported).
  - New types barrel-exported: `MemoryWriter`, `MemoryWriterFact`, `MemoryWriterResult`, `FactExtractionResult`, `ReflectionConfig`, `MemoryQuery`.

  **@cycgraph/memory**

  - `SemanticFact.tags` and `MemoryQuery.tags` fields (both default `[]`).
  - New tag-only retrieval path in `retrieveMemory()` — list facts by tag, intersect tags, apply temporal validity, expand to themes and episodes. No embedding provider required.
  - Existing embedding and entity-based paths now also intersect with the `tags` filter.

  **@cycgraph/orchestrator-postgres**

  - New `memory_facts.tags` `jsonb` column (migration `0013_add_fact_tags`).
  - `DrizzleMemoryStore` and `DrizzleMemoryIndex` row mappers updated to read/write `tags`.

## 0.1.0-beta.2

### Patch Changes

- 2967433: Runner modularization, memory/persistence hardening, and dependency bumps.

  **@cycgraph/orchestrator**

  - Break up the monolithic `graph-runner.ts` into focused modules: `budget-monitor`, `executor-context-builder`, `fallback-tool-resolver`, `idempotency-tracker`, `memory-differ`, `persistence-coordinator`, `recover`, `router`, and `stream-channel`. Public API unchanged.
  - Add MCP `tool-circuit-breaker` and typed MCP error classes.
  - Add `runtime-config` module and expanded reducer + validation coverage.
  - Bump `@ai-sdk/anthropic` and OpenTelemetry packages.

  **@cycgraph/orchestrator-postgres**

  - Add retry helper around Drizzle persistence and event-log writes with covering tests.
  - Tighten event-log and persistence error handling.

  **@cycgraph/memory**

  - Improve `InMemoryMemoryIndex` (filtering, scoring) and adaptive memory compression with new test coverage.
