---
"@cycgraph/orchestrator": patch
---

Upgrade OpenTelemetry to the current line and drop the `protobufjs` override (resolves a moderate advisory).

The OTLP-HTTP and Prometheus exporters were on `0.217.0` and pulled `protobufjs@8.0.x` transitively (via `@opentelemetry/otlp-transformer`). A repo-wide `protobufjs: ">=8.0.1"` override pinned it to `8.0.3` — which is inside the vulnerable range of GHSA-jggg-4jg4-v7c6 (DoS via recursive JSON descriptor expansion, `>=8.0.0 <8.2.0`).

`@opentelemetry/otlp-transformer@0.219.0` no longer depends on `protobufjs` at all, so bumping the exporters removes that dependency edge. The only remaining `protobufjs` is `7.6.3` via `@grpc/proto-loader` (the gRPC log exporter bundled in `sdk-node`), which is outside the advisory range. With the override removed, `npm audit --omit=dev` reports 0 vulnerabilities.

Bumped: `@opentelemetry/exporter-prometheus`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-node` `^0.217.0` → `^0.219.0`; `@opentelemetry/resources`, `@opentelemetry/sdk-metrics` `^2.7.1` → `^2.8.0`. Removed the `protobufjs` entry from the root `overrides`.
