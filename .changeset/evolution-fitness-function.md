---
"@cycgraph/orchestrator": minor
---

**Evolution: deterministic fitness via `fitnessFunction` callback + cost-tracking fixes for multi-agent executors.**

- New `GraphRunnerOptions.fitnessFunction?: FitnessFunction` callback. When provided, the `evolution` node uses it to score each candidate deterministically instead of routing through the LLM-as-judge `evaluator_agent_id`. Useful for tasks with verifiable answers (regex, SQL, code, math) where the LLM judge's variance is larger than the discrimination required. `evaluator_agent_id` on `EvolutionConfigSchema` is now optional; one of the two must be configured or the executor throws `NodeConfigError`.
- New `FitnessFunction` and `FitnessResult` types exported from the package barrel.
- Evolution now propagates `parent.reasoning` to subsequent generations via the `_evolution_parent_reasoning` memory key. Previously the candidate could see the parent regex and its fitness score but not *which* tests caused the score — meaningful refinement required guessing. With reasoning propagated, candidates can make targeted edits.
- `EvolutionConfigSchema.fitness_threshold` upper bound (`max(1)`) removed. Setting the threshold above `1.0` (e.g. `1.5`) now disables early-fitness-exit so the loop runs all `max_generations` regardless of how good any single candidate is. Useful for instrumentation, baselining, and proof-of-iteration runs.
- New `examples/evolution-regex/` — evolves a regex that matches HTTP 4xx status codes excluding 401, 403, and 404, with deterministic fitness scoring. Documented honestly: modern LLMs (Haiku 4.5+) one-shot well-specified regex tasks, so the example sets `fitness_threshold` above 1.0 to force all generations to execute as proof of engine mechanics. Genuine fitness climbing emerges naturally on harder domain-specific tasks the candidate model can't one-shot.

**Bug fixes**:

- `evolution`, `voting`, and `map` executors now surface `inputTokens` / `outputTokens` in the returned action's `metadata.token_usage`, not just `totalTokens`. The runner's cost-tracking path requires the split to call `calculateCost(model, inputTokens, outputTokens)` — without it, cost silently stayed at `$0.00` for these node types even after substantial spend.
- `evolution`, `voting`, and `map` executors now also propagate `model` to the returned action's metadata (captured from the first successful inner agent action). Without it, the pricing lookup defaulted to an empty model string and produced `$0.00` even when the token split was present.
- `examples/evolution/` now correctly extracts `candidate_output` from the winner's updates blob instead of stringifying the object as `[object Object]`.
