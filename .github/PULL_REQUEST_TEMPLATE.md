## Summary

Brief description of what this PR does and why.

## Changes

-
-
-

## Test plan

- [ ] All existing tests pass (`npm test`)
- [ ] New tests added for new functionality (unit + integration as appropriate)
- [ ] Tested manually (describe how — link a runnable example if you wrote one)

## Quality checklist

- [ ] Code follows the [coding standards](.claude/CLAUDE.md)
- [ ] Zod schemas added for any new input/output boundary
- [ ] No direct state mutation — all changes flow through reducers
- [ ] ES module imports use the `.js` extension
- [ ] Cross-workspace imports use `@cycgraph/*` package names, not relative paths
- [ ] No secrets, API keys, or `.env` contents in code or tests
- [ ] No new `console.warn` / `console.error` for things that should be observable — emit a stream event or use `createLogger`

## Database & data integrity

_Skip this block if the PR doesn't touch `packages/orchestrator-postgres` or the memory schemas._

- [ ] If you added a column, generated a migration: `npx drizzle-kit generate --config=packages/orchestrator-postgres/drizzle.config.ts`
- [ ] Migration is forward-only and reversible by a follow-up migration (no destructive `ALTER COLUMN ... SET DATA TYPE` without `USING`)
- [ ] If you renamed an enum or column, you wrote a backfill — old rows are still loadable
- [ ] Cascade behavior on new FKs is intentional (`cascade` vs `restrict` vs `set null`)
- [ ] Indexes added for any new hot-path query

## Security

_Skip this block if the PR doesn't touch agent permissions, MCP, taint, or budgets._

- [ ] Permissions narrow (`read_keys` / `write_keys`) — no new `'*'` grants without justification
- [ ] External MCP tool output flows through taint propagation
- [ ] No new code paths bypass `validateAction()`
- [ ] Budgets and `max_iterations` ceilings still apply along any new execution path

## Changeset

- [ ] Ran `npx changeset` and selected the right semver bump (`patch` / `minor` / `major`)
- [ ] Or: explicitly marked this PR as docs / tests / evals-only (no changeset needed — see `.changeset/README.md`)

## Related issues

Closes #
