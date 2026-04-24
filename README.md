# LaunchDarkly + New Relic Integration

Research exploration for enriching New Relic spans with LaunchDarkly feature flag data and routing telemetry to LD for Guarded Rollouts.

## Documents

| File | Description |
|------|-------------|
| [EXPLORATION.md](./EXPLORATION.md) | Full technical exploration — approaches, options, tradeoffs, and phased recommendation |
| [DIAGRAMS.md](./DIAGRAMS.md) | Architecture diagrams (Mermaid) for each option |
| [PCG_FINDINGS.md](./PCG_FINDINGS.md) | Issues found in the New Relic PCG Helm chart while building the PoC — shareable with the NR team |

## TL;DR

Two goals:
1. **Enrich NR spans with flag data** — so customers can query flag impact in New Relic dashboards
2. **Route telemetry to LD** — so Guarded Rollouts can detect regressions and auto-rollback

Five options for getting data to LD, depending on customer setup:

| Option | Best for | Latency | LD effort |
|--------|----------|---------|-----------|
| **A: OTel Collector dual-export** | OTel customers | Sub-second | None (reuse Dynatrace pattern) |
| **B: NR Streaming Export** | NR-agent + Data Plus customers | ~1 min | Docs |
| **C: NerdGraph polling** | PoC / small scale | ~1 min+ | Reference impl |
| **D: LD NR Ingest Service** | All NR customers (long-term) | Varies | Significant |
| **E: Pipeline Control Gateway** | NR Control customers (NR-agent or OTel) | Sub-second | Docs |

**Recommended start:** Option A for OTel customers; Option E for NR-agent customers who have NR Control. Both use the same LD OTTL filter. Evaluate Option D as a first-party integration once PCG adoption is better understood.

## Comparison with Dynatrace Exploration

The core pattern is the same: **OTel SDK + LD TracingHook + Collector dual-export**. Key differences:

- New Relic's OTLP support is more mature than Dynatrace's — simpler Collector config
- No equivalent to Dynatrace OneAgent SDK hooks needed (NR agent APIs are simpler)
- New Relic Streaming Export is a viable alternative path that Dynatrace didn't offer
- **Pipeline Control Gateway** (NR Control) is effectively an NR-packaged OTel Collector with a native NR-agent-protocol receiver, giving NR-agent customers the same forking capability as Option A without migrating off their agents
- Biggest opportunity: building a first-party LD ingest service for NR (like the existing Datadog integration)

## Demo

A working PoC lives in [`demo/`](./demo/) — simulator + NR-agent service + OTel service + PCG Helm values, all wired together. See [demo/README.md](./demo/README.md) for run instructions.
