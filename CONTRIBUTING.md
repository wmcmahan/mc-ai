# Contributing to MC-AI

Thank you for your interest in contributing to MC-AI! This guide will help you get started.

## Licensing

MC-AI is licensed under the [Apache License, Version 2.0](LICENSE).

By submitting a contribution, you agree that your work will be licensed under the same terms. You retain copyright of your contributions.

## Getting Started

### Prerequisites

- Node.js v22+
- Git
- Docker (optional — only for `orchestrator-postgres` development)

### Setup

```bash
# Clone the repository
git clone https://gitlab.com/wmcmahan/mc-ai.git
cd mc-ai
npm install

# Optional: start Postgres + Jaeger for orchestrator-postgres work
docker-compose up -d
cp .env.example .env
npm run db:migrate
```

### Running Tests

```bash
# All tests
npm test

# By workspace
cd packages/orchestrator && npx vitest run
cd packages/orchestrator-postgres && npx vitest run
```

All tests must pass before submitting a PR.

## Development Workflow

1. **Fork the repository** and create a feature branch from `main`
2. **Read the relevant README** for the package you're working on
3. **Make your changes** following the coding standards below
4. **Write tests** for any new functionality
5. **Run the test suite** to ensure nothing is broken
6. **Submit a pull request** against `main`

## Coding Standards

These are mandatory. PRs that violate them will be requested to change.

### Agents Are Data, Not Classes

Agents are JSON configuration objects, not class instances. Use `AgentConfig` objects hydrated by `AgentFactory`.

### State Mutation via Reducers Only

Never mutate workflow state directly. Agents emit actions; reducers produce new state.

### Schema First (Zod)

Every input/output boundary must have a Zod schema. No unvalidated external data.

### ES Modules

All packages use `"type": "module"`. Use `.js` extensions in relative imports.

### Workspace Imports

Use package names (`@mcai/orchestrator-postgres`, `@mcai/orchestrator`) for cross-workspace imports. Never use relative paths across package boundaries.

For the full coding standards, see [`.claude/CLAUDE.md`](.claude/CLAUDE.md).

## Project Structure

```
packages/orchestrator/            Core graph execution engine (@mcai/orchestrator)
packages/orchestrator-postgres/   Database layer with Drizzle ORM (@mcai/orchestrator-postgres)
```

## What to Work On

- Check [open issues](https://gitlab.com/wmcmahan/mc-ai/issues) for bugs and feature requests
- Issues labeled `good first issue` are a great starting point
- If you want to work on something larger, open an issue first to discuss the approach

## Pull Request Guidelines

- Keep PRs focused. One concern per PR.
- Write a clear description of what changed and why
- Include test coverage for new code
- Ensure CI passes (lint, build, all test suites)
- Reference any related issues in the PR description

## Commit Messages

Use clear, descriptive commit messages:

```
Add supervisor retry logic for failed handoffs

The supervisor now retries up to 3 times when a managed node fails,
with exponential backoff. This prevents transient LLM errors from
failing entire workflows.
```

- Use imperative mood ("Add", "Fix", "Update" not "Added", "Fixed", "Updated")
- First line under 72 characters
- Add detail in the body when the "why" isn't obvious

## Reporting Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include:

- Steps to reproduce
- Expected vs actual behavior
- Node.js version, OS, and relevant environment details
- Error logs or stack traces

## Security Vulnerabilities

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold these standards.
