# LaunchDarkly + New Relic Integration

Research exploration for enriching New Relic spans with LaunchDarkly feature flag data and routing telemetry to LD for Guarded Rollouts.

## Documents

| File | Description |
|------|-------------|
| [EXPLORATION.md](./EXPLORATION.md) | Full technical exploration — approaches, options, tradeoffs, and phased recommendation |
| [DIAGRAMS.md](./DIAGRAMS.md) | Architecture diagrams (Mermaid) for each option |

## TL;DR

Two goals:
1. **Enrich NR spans with flag data** — so customers can query flag impact in New Relic dashboards
2. **Route telemetry to LD** — so Guarded Rollouts can detect regressions and auto-rollback

Four options for getting data to LD, depending on customer setup:

| Option | Best for | Latency | LD effort |
|--------|----------|---------|-----------|
| **A: OTel Collector dual-export** | OTel customers | Sub-second | None (reuse Dynatrace pattern) |
| **B: NR Streaming Export** | NR-agent + Data Plus customers | ~1 min | Docs |
| **C: NerdGraph polling** | PoC / small scale | ~1 min+ | Reference impl |
| **D: LD NR Ingest Service** | All NR customers (long-term) | Varies | Significant |

**Recommended start:** Option A (identical to Dynatrace Collector pattern, just swap the exporter). Then evaluate Option D as a first-party integration.

## Comparison with Dynatrace Exploration

The core pattern is the same: **OTel SDK + LD TracingHook + Collector dual-export**. Key differences:

- New Relic's OTLP support is more mature than Dynatrace's — simpler Collector config
- No equivalent to Dynatrace OneAgent SDK hooks needed (NR agent APIs are simpler)
- New Relic Streaming Export is a viable alternative path that Dynatrace didn't offer
- Biggest opportunity: building a first-party LD ingest service for NR (like the existing Datadog integration)
