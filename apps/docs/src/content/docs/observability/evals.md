---
title: Evaluations
description: Verify agent behavior with automated eval suites.
---

Unit tests check *code* (does the function crash?). Evals check *behavior* (did the agent solve the user's problem?).

## Unit tests (deterministic)

- **Scope**: Reducers, graph routing logic, tool inputs/outputs
- **Tool**: Vitest
- **Example**: "Given State X + Action Y, does the reducer produce State Z?"

## Evals (probabilistic)

MC-AI includes an eval framework for running assertions against workflow outputs.

### Dataset

A trusted set of inputs and expected outcomes:
- **Input**: "Create a React Button component."
- **Expected criteria**: ["Has TypeScript interfaces", "Uses proper props", "No syntax errors"]

### The evaluator loop

1. **Run**: The system processes the input → output artifact
2. **Evaluate**: A separate "Judge Agent" reads the output and criteria
3. **Score**: The judge returns pass/fail and reasoning

### Running evals

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evals/linear-completion.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evals/supervisor-routing.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evals/hitl-approval.ts
```

See the [evals examples](https://github.com/wmcmahan/mc-ai/tree/main/packages/orchestrator/examples/evals) for complete eval suite implementations.

## Cost tracking

Every workflow run tracks token usage and cost:

- `total_tokens_used` — cumulative tokens across all nodes
- `total_cost_usd` — estimated cost based on model pricing
- `budget_usd` — optional per-agent budget cap

Budget enforcement throws `BudgetExceededError` immediately if costs exceed the configured limit.

## Next steps

- [Tracing](/observability/tracing/) — see workflow execution in real-time
- [Security](/security/) — economic guardrails and denial-of-wallet prevention
