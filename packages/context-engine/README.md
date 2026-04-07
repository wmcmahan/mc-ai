# @mcai/context-engine

Framework-agnostic context optimization engine. Composable compression pipeline that makes every token count — especially for small and local models.

Built as a standalone package with zero orchestrator dependencies. Works with any LLM framework (Vercel AI SDK, LangChain, raw API calls) or as the context management layer inside `@mcai/orchestrator`.

## Install

```bash
npm install @mcai/context-engine
```

Requires Node.js 22+. Only runtime dependency is `zod`.

See [STRATEGY.md](./STRATEGY.md) for the research foundation and architectural design decisions behind each compression technique.

## Architecture

```
Input Segments (system, memory, tools, history, user)
  ↓  Cache-Aware Prefix Locking     (pre-pipeline)
  ↓  Hierarchy / Graph Formatting   (memory payloads)
  ↓  Model-Aware Format Selection   (per-model optimization)
  ↓  Format Compression             (JSON → compact format)
  ↓  Exact Deduplication            (hash-based)
  ↓  Fuzzy Deduplication            (trigram similarity)
  ↓  Semantic Deduplication         (embedding-based)
  ↓  CoT Distillation               (reasoning trace eviction)
  ↓  Self-Information Pruning        (perplexity-based)
  ↓  Heuristic Pruning              (rule-based)
  ↓  Budget Allocation              (priority-weighted)
Output Segments (compressed, within token budget)
```

Each stage is independent and composable. Use the full pipeline, a single stage, or the optimizer presets.

### Capability Tiers

| Tier | Requirements | Expected Reduction |
|------|-------------|-------------------|
| 0 | Zero dependencies (pure TypeScript) | 15-45% depending on data shape |
| 1 | Token counter (e.g., tiktoken) | +5-10% efficiency from exact budgeting |
| 2 | Embedding provider | +10-20% from semantic dedup |
| 3 | Small local model (GPT-2, Phi-2) | +30-50% from perplexity pruning |

All tiers are implemented. Higher tiers add capabilities via provider interfaces.

## Quick Start

### Pipeline Optimizer (recommended)

The simplest way to use the engine — pick a preset:

```typescript
import { createOptimizedPipeline } from '@mcai/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const result = pipeline.compress({
  segments: [
    { id: 'system', content: 'You are a helpful assistant.', role: 'system', priority: 10, locked: true },
    { id: 'memory', content: JSON.stringify(memoryData, null, 2), role: 'memory', priority: 5 },
  ],
  budget: { maxTokens: 4096, outputReserve: 512 },
  model: 'claude-sonnet-4-20250514',
});
```

Presets:

| Preset | Stages | Latency | Use case |
|--------|--------|---------|----------|
| `fast` | Format + exact dedup + allocator | ~2-5ms | Real-time chat |
| `balanced` | Fast + fuzzy dedup + heuristic pruning + CoT distillation | ~10-20ms | Standard agent workflows |
| `maximum` | Balanced + hierarchy/graph formatters + format selector | ~50-200ms | Batch processing, cost-critical |

Auto-select from latency budget: `createOptimizedPipeline({ maxLatencyMs: 20 })`.

### Incremental Pipeline

For multi-turn conversations, the incremental pipeline caches unchanged segments across turns:

```typescript
import { createIncrementalPipeline } from '@mcai/context-engine';

const pipeline = createIncrementalPipeline({
  stages: [createFormatStage(), createExactDedupStage()],
  enableCaching: true,
});

// Turn 1 — all segments compressed
const turn1 = pipeline.compress({ segments, budget });

// Turn 2 — only changed segments re-compressed
const turn2 = pipeline.compress({ segments: updatedSegments, budget }, turn1.state);
console.log(`Cached: ${turn2.cachedSegmentCount}, Fresh: ${turn2.freshSegmentCount}`);
```

Stages with `scope: 'cross-segment'` (e.g., fuzzy dedup) are re-run only when
per-segment stage outputs actually change — not just when inputs change. If a
segment's input changes but its per-segment output is identical to the previous
turn, cross-segment stages are skipped. Per-segment stages (the default) cache
independently.

### Manual Pipeline

Full control over which stages run and in what order:

```typescript
import {
  createPipeline,
  createFormatStage,
  createExactDedupStage,
  createFuzzyDedupStage,
  createCotDistillationStage,
  createHeuristicPruningStage,
  createAllocatorStage,
  applyCachePolicy,
} from '@mcai/context-engine';

const segments = applyCachePolicy(rawSegments, { lockSystem: true, lockTools: true });

const pipeline = createPipeline({
  stages: [
    createFormatStage(),
    createExactDedupStage(),
    createFuzzyDedupStage(),
    createCotDistillationStage(),
    createHeuristicPruningStage(),
    createAllocatorStage(),
  ],
  logger: { warn: (msg) => console.warn(msg) },  // optional structured logging
  timeoutMs: 500,  // optional pipeline-level timeout; remaining stages skipped if exceeded
});

const result = pipeline.compress({ segments, budget: { maxTokens: 4096, outputReserve: 512 } });
```

### Vercel AI SDK Integration

Slots into `prepareStep` for automatic per-call compression:

```typescript
import { streamText } from 'ai';
import { createOptimizedPipeline } from '@mcai/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'fast' });

const result = await streamText({
  model,
  messages,
  prepareStep: ({ messages }) => {
    const compressed = pipeline.compress({
      segments: [{ id: 'msgs', content: JSON.stringify(messages), role: 'history', priority: 1 }],
      budget: { maxTokens: 4096, outputReserve: 512 },
    });
    return { messages: JSON.parse(compressed.segments[0].content) };
  },
});
```

### MC-AI Orchestrator Integration

Optional context compression for all agent and supervisor prompts:

```typescript
import { GraphRunner } from '@mcai/orchestrator';
import type { ContextCompressor } from '@mcai/orchestrator';
import { createOptimizedPipeline, serialize } from '@mcai/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const contextCompressor: ContextCompressor = (sanitizedMemory, options) => {
  const result = pipeline.compress({
    segments: [{ id: 'memory', content: serialize(sanitizedMemory), role: 'memory', priority: 1 }],
    budget: { maxTokens: options?.maxTokens ?? 8192, outputReserve: 0 },
    model: options?.model,
  });
  return { compressed: result.segments[0].content, metrics: result.metrics };
};

const runner = new GraphRunner(graph, state, { contextCompressor });
runner.on('context:compressed', (e) => {
  console.log(`Memory: ${e.reduction_percent.toFixed(1)}% reduction`);
});
```

## Pipeline

### Segments

Prompts are broken into typed segments with priority weighting:

```typescript
const segment: PromptSegment = {
  id: 'memory',
  content: '...',
  role: 'memory',       // 'system' | 'memory' | 'tools' | 'history' | 'user' | 'custom'
  priority: 5,          // higher = more budget allocation
  locked: false,        // true = bypass all compression (cache-friendly)
  metadata: {           // optional, used by specialized formatters
    contentType: 'hierarchy',  // triggers hierarchy formatter
  },
};
```

Locked segments bypass all compression stages. Use for system prompts and tool schemas to preserve API prompt cache hits.

### Metrics

Every pipeline run reports per-stage metrics:

```typescript
import { formatMetricsSummary } from '@mcai/context-engine';

console.log(formatMetricsSummary(result.metrics));
// Total: 1200 → 420 tokens (65.0% reduction, 12.3ms)
//   format-compression: 1200 → 850 (29.2% saved, 1.0ms)
//   exact-dedup: 850 → 800 (5.9% saved, 0.3ms)
//   fuzzy-dedup: 800 → 750 (6.3% saved, 1.5ms)
//   cot-distillation: 750 → 550 (26.7% saved, 0.5ms)
//   heuristic-pruning: 550 → 450 (18.2% saved, 2.0ms)
//   budget-allocator: 450 → 420 (6.7% saved, 0.8ms)
```

### Debug Mode

Source maps trace compressed output back to originals (zero overhead when disabled):

```typescript
const pipeline = createPipeline({ stages: [...], debug: true });
const result = pipeline.compress({ segments, budget });
for (const entry of result.sourceMap!) {
  console.log(`${entry.segmentId}: ${entry.original.length} → ${entry.compressed.length} chars`);
}
```

## Compression Stages

### Format Compression

Auto-detects data shape and serializes to token-efficient format:

| Data Shape | Format | Reduction vs JSON |
|------------|--------|-------------------|
| Tabular (uniform arrays) | TOON-style `@header` rows | 30-45% |
| Nested objects | YAML-like indentation | 10-20% |
| Flat objects | `key: value` lines | 15-25% |

```typescript
import { serialize, createFormatStage } from '@mcai/context-engine';

serialize([{ name: 'Alice', score: 92 }, { name: 'Bob', score: 87 }]);
// @name @score
// Alice 92
// Bob 87
```

### Deduplication (Exact + Fuzzy + Semantic)

Three levels of duplicate detection:

```typescript
import { createExactDedupStage, createFuzzyDedupStage, createSemanticDedupStage } from '@mcai/context-engine';

createExactDedupStage()                           // O(n) hash-based, identical content
createFuzzyDedupStage({ threshold: 0.85 })        // trigram Jaccard, MinHash LSH pre-filter for >200 items
createSemanticDedupStage({ provider, precomputed }) // embedding cosine, SimHash LSH pre-filter for >200 items
```

Semantic dedup requires pre-computed embeddings (async, before pipeline):

```typescript
import { precomputeEmbeddings } from '@mcai/context-engine';

const embeddings = await precomputeEmbeddings(segments, embeddingProvider);
const stage = createSemanticDedupStage({ provider: embeddingProvider, precomputed: embeddings });
```

### Heuristic Pruning

Rule-based token importance scoring (no ML required). Six weighted rules: stop word penalty, filler phrase detection, position boost, frequency penalty, named entity boost, structural marker boost.

```typescript
import { createHeuristicPruningStage } from '@mcai/context-engine';

createHeuristicPruningStage()  // default weights
createHeuristicPruningStage({ stopWordWeight: 0.3, entityWeight: 0.2 })  // custom
```

Preserves named entities, numbers, and structural markers while removing filler words and redundant phrasing.

#### Query-Contrastive Scoring

```typescript
import { createHeuristicPruningStage } from '@mcai/context-engine';

const stage = createHeuristicPruningStage({
  queryWeight: 0.20, // boost tokens relevant to the query
});

// When ScorerContext includes a query string, tokens near query terms
// score higher. Without a query, behavior is unchanged.
```

### CoT Distillation

Detects and evicts reasoning traces (`<think>`, `<reasoning>`, `<scratchpad>`, etc.) from System-2 model outputs. Extracts conclusions, removes verbose reasoning.

```typescript
import { distillCoT, createCotDistillationStage } from '@mcai/context-engine';

// Standalone
const result = distillCoT(content);
// result.distilled  — content with traces replaced by conclusions
// result.tracesRemoved — number of blocks evicted
// result.tokensEvicted — estimated tokens saved

// Pipeline stage — auto-detects model family from context.model
createCotDistillationStage()
```

Ships with delimiters for DeepSeek, Anthropic, OpenAI, and generic formats. Configurable via custom delimiter registry.

### N-Gram Surprisal Scorer

Local self-information scoring without an external provider:

```typescript
import { createNGramScorer } from '@mcai/context-engine';

// Local self-information scoring — no external provider needed
const scorer = createNGramScorer({ n: 3, granularity: 'sentence' });
// Uses character trigram frequency to identify surprising (important) tokens
// Falls back automatically when no CompressionProvider is available
```

### Self-Information Pruning (ML-Powered)

Perplexity-based token scoring via `CompressionProvider`. Tokens with high surprisal (domain terms, numbers, novel concepts) are preserved. Predictable tokens (articles, filler) are pruned.

```typescript
import { precomputeImportanceScores, createSelfInformationStage } from '@mcai/context-engine';

const scores = await precomputeImportanceScores(segments, compressionProvider, {
  granularity: 'sentence',  // 'token' | 'phrase' | 'sentence'
  query: 'What are the costs?',  // optional contrastive scoring
});

const stage = createSelfInformationStage({ precomputed: scores });
```

### Adaptive Memory Compression

Prioritizes memory facts by theme size and recency:

```typescript
import { createAdaptiveMemoryStage } from '@mcai/context-engine';

const stage = createAdaptiveMemoryStage({
  recencyBoostDays: 7,
  recencyMultiplier: 2.0,
  maxFactsPerTheme: 10,
});

// Operates on segments with role='memory' containing JSON memory payloads.
// Prioritizes facts from larger themes and recent facts.
// Non-memory segments pass through unchanged.
```

## Memory Formatting

Format pre-built memory hierarchy payloads from `@mcai/memory` (or any compatible source) into token-efficient prompt blocks. Context-engine defines its own input interfaces — no dependency on `@mcai/memory`.

### Hierarchy Formatter

Formats themes → facts → episodes in top-down structure:

```typescript
import { formatHierarchy, createHierarchyFormatterStage } from '@mcai/context-engine';
import type { MemoryPayload } from '@mcai/context-engine';

const payload: MemoryPayload = { themes, facts, episodes };
const formatted = formatHierarchy(payload);
// Themes:
//   - System Architecture
//     Facts:
//       - Uses graph-based workflow engine (2026-01-15)
//       - API gateway uses rate limiting (2026-02-01)
// Recent Episodes:
//   - Architecture review (2026-01-15 10:00 – 10:03, 4 msgs, 2 facts)
```

Pipeline stage detects segments with `metadata.contentType === 'hierarchy'`.

### Graph Serializer

Formats entity-relationship subgraphs. Auto-detects tabular vs adjacency format:

```typescript
import { serializeGraph, createGraphSerializerStage } from '@mcai/context-engine';

serializeGraph(entities, relationships);
// Entities (person):
// @name @role @department
// Alice engineer platform
// Bob manager infrastructure
//
// Relationships:
// @source @relation @target @weight
// Alice works_on Platform 1.0
```

### Community Formatter

Formats pre-clustered community summaries from GraphRAG/Leiden:

```typescript
import { formatCommunities } from '@mcai/context-engine';

formatCommunities(communities, { sortByRelevance: true, maxLevel: 2 });
```

## Model-Aware Routing

Selects compression format based on target model capabilities. Small models get compact JSON; capable models get TOON/nested formats.

```typescript
import { selectFormat, resolveModelProfile, createFormatSelectorStage } from '@mcai/context-engine';

resolveModelProfile('gemma-2-9b');   // → { prefersJson: true, supportsTabular: false, ... }
resolveModelProfile('claude-sonnet'); // → { prefersJson: false, supportsTabular: true, ... }

// Pipeline stage — auto-selects format from context.model
createFormatSelectorStage()
```

Ships with profiles for GPT-4o, Claude, Llama, DeepSeek, Qwen, Gemini, Mistral, Gemma, Phi.

## Cache-Aware Prefix Locking

Pre-processor that locks qualifying segments to preserve API prompt cache hits:

```typescript
import { applyCachePolicy, computePrefixHashes, measureCacheHitRate } from '@mcai/context-engine';

const locked = applyCachePolicy(segments, { lockSystem: true, lockTools: true });

// Measure cross-turn cache stability
const currentHashes = computePrefixHashes(locked.filter(s => s.locked));
const hitRate = measureCacheHitRate(currentHashes, previousHashes);
```

### Cache Diagnostics

Measure segment stability across turns:

```typescript
import { diagnoseCacheStability, computeSegmentHashMap } from '@mcai/context-engine';

const previousHashes = computeSegmentHashMap(previousSegments);
const diagnostics = diagnoseCacheStability(currentSegments, previousHashes);
// diagnostics.hitRate — fraction of stable segments
// diagnostics.unstableSegments — segments that changed
// diagnostics.recommendations — actionable suggestions
```

## Latency Management

### Circuit Breaker

Wraps any stage and bypasses it when the latency cost exceeds token savings:

```typescript
import { createCircuitBreaker, createLatencyTracker } from '@mcai/context-engine';

const tracker = createLatencyTracker();
const safeMlStage = createCircuitBreaker(mlStage, tracker, {
  minEfficiency: 1.0,   // tokens saved per millisecond
  warmupSamples: 5,     // always run first N calls
  cooldownMs: 30_000,   // retry after bypass
});
```

### Latency Tracker

Rolling average per-stage latency and efficiency:

```typescript
tracker.record('self-information-pruning', 45, 200);  // 45ms, 200 tokens saved
tracker.getEfficiency('self-information-pruning');      // → 4.4 tokens/ms
tracker.getAverage('self-information-pruning');         // → { avgDurationMs, avgTokensSaved, samplesCount }
```

## Provider Interfaces

The engine scales with available providers but always works without them:

| Interface | Built-in Default | Purpose |
|-----------|-----------------|---------|
| `TokenCounter` | Model-family ratio estimator | Token counting for budget allocation |
| `CompressionProvider` | Noop (uniform scores) | Token importance scoring (self-information) |
| `EmbeddingProvider` | Throws (feature disabled) | Semantic dedup |
| `SummarizationProvider` | Throws (feature disabled) | Text summarization |

### Custom Compression Provider (Inference Server)

For production, implement `CompressionProvider` against your inference server (Ollama, vLLM, TGI, or any API that returns per-token log-probabilities):

```typescript
import type { CompressionProvider } from '@mcai/context-engine';
import { precomputeImportanceScores } from '@mcai/context-engine';

// Example: Ollama running locally on port 11434
const ollamaProvider: CompressionProvider = {
  async scoreTokenImportance(tokens: string[], context?: string): Promise<number[]> {
    const text = (context ? context + ' ' : '') + tokens.join(' ');
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'distilgpt2', prompt: text, raw: true }),
    });
    const data = await response.json();
    // Extract per-token log-probs and normalize to [0,1]
    // Higher surprisal = more important to keep
    return tokens.map(() => Math.random()); // replace with actual log-prob extraction
  },
};

const scores = await precomputeImportanceScores(segments, ollamaProvider);
```

### Tiktoken Adapter

Optional exact token counting via `gpt-tokenizer`:

```typescript
import { encode } from 'gpt-tokenizer';
import { createTiktokenCounter } from '@mcai/context-engine';

const counter = createTiktokenCounter(encode);
```

## Development

```bash
npm install
npm run build --workspace=packages/context-engine
npm run test --workspace=packages/context-engine
npm run lint --workspace=packages/context-engine
```

398 tests across 31 test files. All tests run in under 450ms.

## Research Foundation

| Technique | Source | Contribution |
|-----------|--------|-------------|
| Selective Context | Li et al., EMNLP 2023 | Self-information token scoring |
| LLMLingua | Jiang et al., EMNLP 2023 | Iterative token-level compression |
| LLMLingua-2 | Pan et al., ACL 2024 | BERT-level token classifier |
| TOON | Tensorlake, 2025 | Token-efficient data serialization |
| Dynamic Context Pruning | NeurIPS 2023 | Attention-based importance scoring |
| xMemory | King's College London, 2025 | Hierarchical memory formatting |
| Microsoft GraphRAG | Microsoft Research, 2024 | Community-based graph summarization |

## License

Apache-2.0
