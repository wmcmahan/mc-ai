---
title: Installation
description: Install MC-AI and its dependencies.
---

## Prerequisites

- **Node.js v22+** (ES Modules)
- An LLM API key: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

## Install the package

```bash
npm install @mcai/orchestrator zod uuid
```

**Peer dependencies**: `ai` (v6+), `zod`, and at least one provider adapter (`@ai-sdk/anthropic`, `@ai-sdk/openai`, or any Vercel AI SDK-compatible provider).

## Clone the repo (for examples)

```bash
git clone https://gitlab.com/wmcmahan/mc-ai.git
cd mc-ai
npm install
```

## Optional: Postgres persistence

If you need durable state, event logs, or vector search, install the Postgres adapter:

```bash
npm install @mcai/orchestrator-postgres
```

This requires a running Postgres instance. The easiest way is Docker Compose:

```bash
docker-compose up -d    # Start Postgres
cp .env.example .env    # Configure connection
npm run db:migrate      # Run migrations
```

## Next steps

- [Quick Start](/getting-started/quick-start/) — run your first workflow
