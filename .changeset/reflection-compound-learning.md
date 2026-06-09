---
"@cycgraph/orchestrator": minor
"@cycgraph/memory": minor
"@cycgraph/orchestrator-postgres": patch
---

Compound learning: `reflection` node type + `MemoryWriter` + tag-based retrieval.

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
