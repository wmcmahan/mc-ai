# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets), the tool that handles versioning and publishing for cycgraph's monorepo.

## Adding a changeset

When you make a change that affects a published package (`@cycgraph/orchestrator`, `@cycgraph/orchestrator-postgres`, `@cycgraph/memory`, `@cycgraph/context-engine`), add a changeset:

```bash
npx changeset
```

You will be prompted for:

1. **Which packages** are changed (use space to select).
2. **What kind of bump** each gets — `major`, `minor`, or `patch`.
3. **A summary** of the change. This becomes the CHANGELOG entry, so write it like a release note: imperative voice, user-facing, no internal jargon.

A markdown file will be written to `.changeset/`. Commit it with the rest of your PR.

## What does NOT need a changeset

- Test-only changes
- Internal refactors that don't change public API or behavior
- Documentation, CI, or tooling changes
- Changes only to `@cycgraph/evals` (private — never published)

If a PR has no user-facing change, run `npx changeset --empty` to record that explicitly.

## What happens after merge

When a PR with changesets lands on `main`, the release workflow opens (or updates) a **"Version Packages"** PR that:

- Bumps each affected package's version per its changesets
- Writes/updates `CHANGELOG.md` in each package
- Updates the root lockfile

When a maintainer merges the Version Packages PR, the workflow runs again and publishes the bumped packages to npm with provenance.

## Why this exists

Manual version bumping in a 5-package workspace is error-prone. Changesets gives every PR an explicit changelog entry and lets the release happen as a single atomic merge, reviewed like any other PR.

See the [Changesets documentation](https://github.com/changesets/changesets) for more.
