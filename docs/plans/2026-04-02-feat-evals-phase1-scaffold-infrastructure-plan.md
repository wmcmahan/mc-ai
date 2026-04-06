---
title: "feat: Scaffold @mcai/evals Phase 1 Infrastructure"
type: feat
status: active
date: 2026-04-02
---

# feat: Scaffold @mcai/evals Phase 1 Infrastructure

## Overview

Initialize the `@mcai/evals` package with all configuration files, directory structure, Zod schemas, type definitions, and barrel export. This is Phase 1 from `packages/evals/IMPLEMENTATION.md` -- a pure types-and-scaffold phase with no runtime behavior.

## Pre-Implementation Corrections

Research revealed discrepancies between IMPLEMENTATION.md and the actual codebase that must be resolved during implementation:

| Issue | IMPLEMENTATION.md Says | Codebase Reality | Resolution |
|-------|----------------------|------------------|------------|
| Zod version | `^3.x.x` | `^4.3.6` (orchestrator) | Use `^4.3.6` to match monorepo |
| package.json fields | Missing `main`, `types`, `exports` | Orchestrator has all three | Add them for workspace import resolution |
| `expectedArgSchema` | "the zod schema to validate against" | Zod schemas cannot be serialized to SQLite | Use JSON Schema object representation |

## Proposed Solution

Seven deliverables, built in dependency order:

1. **Package scaffold** -- `package.json`, `tsconfig.json`, `vitest.config.ts`
2. **Directory structure** -- all directories per IMPLEMENTATION.md section 2
3. **Dataset schemas** -- `src/dataset/schema.ts` with `GoldenTrajectorySchema`, `ToolCallSchema`, `ManifestSchema`
4. **Dataset types** -- `src/dataset/types.ts` exporting inferred types
5. **Runner types** -- `src/runner/types.ts` with `EvalRunConfig`, `EvalResult`, `DriftReport`
6. **Assertion types** -- `src/assertions/types.ts` with `ZodStructuralResult`, `SemanticJudgeResult` (added per spec flow analysis -- downstream phases need these)
7. **Provider types** -- `src/providers/types.ts` with provider interface contract
8. **Barrel export** -- `src/index.ts`

## Technical Approach

### Phase 1.1: Package Configuration

#### `packages/evals/package.json`

Follow the orchestrator's pattern exactly:

```jsonc
{
  "name": "@mcai/evals",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "engines": { "node": ">=22.0.0" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "lint": "tsc --noEmit",
    "fetch-golden": "tsx scripts/fetch-golden.ts",
    "evals": "tsx src/runner/runner.ts --mode local",
    "evals:ci": "tsx src/runner/runner.ts --mode ci"
  },
  "dependencies": {
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^25.3.5",
    "tsx": "^4.19.4",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

**Note**: `promptfoo` is listed in IMPLEMENTATION.md as a dependency but is not needed until Phase 4 (runner implementation). Add it then, not now. Phase 1 is types-only.

#### `packages/evals/tsconfig.json`

Mirror the orchestrator config:

```json
{
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

#### `packages/evals/vitest.config.ts`

Copy from orchestrator:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

### Phase 1.2: Directory Structure

Create all directories and placeholder files per IMPLEMENTATION.md section 2. Empty directories need a `.gitkeep` or a real file. Since we are defining types in each directory, most will have real files.

Directories to create:
- `src/runner/`
- `src/providers/`
- `src/assertions/`
- `src/dataset/`
- `src/suites/` (and subdirectories: `context-engine/`, `memory/`, `orchestrator/`)
- `golden/` (with `.gitattributes` for LFS)
- `scripts/`
- `test/assertions/`
- `test/dataset/`
- `test/runner/`

### Phase 1.3: Dataset Schemas (`src/dataset/schema.ts`)

Key schemas to define:

**`ToolCallSchema`**:
- `toolName`: `z.string()` -- exact match required
- `args`: `z.record(z.string(), z.unknown())` -- structural match only
- `expectedArgSchema`: `z.record(z.string(), z.unknown()).optional()` -- **JSON Schema representation**, not a Zod runtime object. Converted to Zod at assertion time.

**`GoldenTrajectorySchema`**:
- `id`: `z.string().uuid()`
- `suite`: `z.enum(['context-engine', 'memory', 'orchestrator'])`
- `description`: `z.string()`
- `input`: `z.string()` -- raw input fed to the module
- `expectedOutput`: `z.union([z.string(), z.record(z.string(), z.unknown())])` -- string for text outputs, object for structured outputs (map-reduce aggregation, etc.)
- `expectedToolCalls`: `z.array(ToolCallSchema).optional()` -- `undefined` = skip tool call assertions; empty `[]` = assert no tool calls were made
- `tags`: `z.array(z.string()).optional()`
- `source`: `z.enum(['webarena', 'internal'])`
- `createdAt`: `z.string().datetime()`

**`ManifestEntrySchema`** (added -- needed by Phase 2 loader):
- `name`: `z.string()`
- `file`: `z.string()` -- relative path to compressed SQLite
- `sha256`: `z.string()`
- `trajectoryCount`: `z.number().int().nonneg()`
- `schemaVersion`: `z.string()`
- `lastUpdated`: `z.string().datetime()`

**`ManifestSchema`**:
- `version`: `z.string()`
- `datasets`: `z.array(ManifestEntrySchema)`

### Phase 1.4: Dataset Types (`src/dataset/types.ts`)

Export inferred types from schemas using `z.infer<>`:
- `ToolCall`
- `GoldenTrajectory`
- `ManifestEntry`
- `Manifest`

### Phase 1.5: Runner Types (`src/runner/types.ts`)

**`EvalRunConfig`**:
- `mode`: `'local' | 'ci'`
- `suites`: optional array of suite names to run (default: all)
- `maxConcurrency`: optional number override
- `driftCeiling`: optional number override (default: 5.0)

**`DriftReport`**:
- `aggregatePercent`: number (the gate metric)
- `perSuite`: record mapping suite name to per-suite breakdown (`suiteName`, `totalTests`, `zodFailures`, `semanticFailures`, `driftPercent`)
- `passed`: boolean

**`EvalResult`**:
- `drift`: `DriftReport`
- `raw`: promptfoo's `EvaluateSummary` (use `unknown` for now -- typed when promptfoo is added in Phase 4)

### Phase 1.6: Assertion Types (`src/assertions/types.ts`)

Added based on spec flow analysis. Phase 3 (assertion engine) and Phase 4 (reporter) both consume these types.

**`ZodStructuralResult`**:
- `passed`: boolean
- `toolName`: string
- `missingParams`: `string[]`
- `typeMismatches`: array of `{ param: string; expected: string; received: string }`

**`SemanticJudgeResult`**:
- `passed`: boolean
- `score`: number (0.0-1.0)
- `reasoning`: string
- `metric`: string (e.g., `"answer_relevancy"`, `"faithfulness"`, `"logical_coherence"`)

### Phase 1.7: Provider Types (`src/providers/types.ts`)

Define the provider interface contract with enough specificity for Phase 4 implementers:

**`EvalProvider`** interface:
- `name`: string (e.g., `"ollama"`, `"openai-gpt4o"`)
- `mode`: `'local' | 'ci'`
- `maxConcurrency`: number
- `getProviderConfig()`: returns the promptfoo-compatible provider configuration (typed as `unknown` until promptfoo is added)
- `estimateCost(testCount: number)`: returns `{ estimatedUsd: number; warning?: string }` -- enables the cost guardrail in the runner

### Phase 1.8: Barrel Export (`src/index.ts`)

Export all public types and schemas. Follow orchestrator pattern with section dividers:
- Dataset schemas and types
- Runner types
- Assertion types
- Provider types

### Phase 1.9: Golden Directory Setup

**`golden/.gitattributes`**:
```
*.sqlite filter=lfs diff=lfs merge=lfs -text
*.gz filter=lfs diff=lfs merge=lfs -text
```

**`golden/manifest.json`**:
```json
{
  "version": "1",
  "datasets": []
}
```

### Phase 1.10: Root Build Script Update

Update root `package.json` build script to include evals:
```
"build": "npm run build --workspace=packages/orchestrator && npm run build --workspace=packages/orchestrator-postgres && npm run build --workspace=packages/evals"
```

## Acceptance Criteria

- [ ] `npm run build --workspace=packages/evals` succeeds with zero errors
- [ ] `npm run lint --workspace=packages/evals` succeeds (tsc --noEmit)
- [ ] `npm run test --workspace=packages/evals` succeeds (no tests yet, vitest should pass with no test files)
- [ ] All Zod schemas parse valid sample data and reject invalid data
- [ ] All types are importable via `import { ... } from '@mcai/evals'` from sibling packages
- [ ] `golden/.gitattributes` tracks `*.sqlite` and `*.gz` via LFS
- [ ] `golden/manifest.json` exists with empty datasets array
- [ ] No runtime dependencies beyond `zod` (promptfoo added in Phase 4)
- [ ] Directory structure matches IMPLEMENTATION.md section 2 exactly

## File Manifest

Files to create (in order):

| File | Purpose |
|------|---------|
| `packages/evals/package.json` | Package configuration |
| `packages/evals/tsconfig.json` | TypeScript configuration |
| `packages/evals/vitest.config.ts` | Vitest configuration |
| `packages/evals/golden/.gitattributes` | LFS tracking rules |
| `packages/evals/golden/manifest.json` | Empty dataset manifest |
| `packages/evals/src/dataset/schema.ts` | Zod schemas: GoldenTrajectory, ToolCall, Manifest |
| `packages/evals/src/dataset/types.ts` | Inferred TypeScript types |
| `packages/evals/src/runner/types.ts` | EvalRunConfig, EvalResult, DriftReport |
| `packages/evals/src/assertions/types.ts` | ZodStructuralResult, SemanticJudgeResult |
| `packages/evals/src/providers/types.ts` | EvalProvider interface |
| `packages/evals/src/index.ts` | Barrel export |

Directories to create (empty, with `.gitkeep`):

| Directory | Purpose |
|-----------|---------|
| `packages/evals/src/suites/context-engine/` | Context engine spec suite (Phase 5) |
| `packages/evals/src/suites/memory/` | Memory spec suite (Phase 5) |
| `packages/evals/src/suites/orchestrator/` | Orchestrator regression suite (Phase 5) |
| `packages/evals/scripts/` | Golden dataset scripts (Phase 2) |
| `packages/evals/test/assertions/` | Assertion unit tests (Phase 3) |
| `packages/evals/test/dataset/` | Dataset unit tests (Phase 2) |
| `packages/evals/test/runner/` | Runner unit tests (Phase 4) |

## IMPLEMENTATION.md Updates Required

Before coding, update `packages/evals/IMPLEMENTATION.md` to reflect findings:

1. Change `"zod": "^3.x.x"` to `"zod": "^4.3.6"` and update the Zod version note
2. Add `main`, `types`, and `exports` fields to the package.json template
3. Add `src/assertions/types.ts` to the directory structure and Phase 1 deliverables
4. Clarify `expectedArgSchema` uses JSON Schema representation, not Zod runtime objects
5. Document `expectedToolCalls: []` vs `undefined` semantic distinction
6. Add `ManifestSchema` to the Phase 1 schema deliverables
7. Note that `promptfoo` dependency is deferred to Phase 4

## References

### Internal
- `packages/orchestrator/package.json` -- package.json template
- `packages/orchestrator/tsconfig.json` -- tsconfig template
- `packages/orchestrator/vitest.config.ts` -- vitest config template
- `packages/orchestrator/src/types/state.ts` -- Zod schema pattern reference
- `packages/evals/IMPLEMENTATION.md` -- source specification
- `packages/evals/STRATEGY.md` -- strategic context
