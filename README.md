# LaunchDarkly + New Relic Integration

Research exploration for enriching New Relic spans with LaunchDarkly feature-flag data and routing relevant telemetry to LaunchDarkly for Guarded Rollouts.

## Documents

| File | Description |
|------|-------------|
| [EXPLORATION.md](./EXPLORATION.md) | Full technical exploration — approaches, options, tradeoffs, and phased recommendation |
| [DIAGRAMS.md](./DIAGRAMS.md) | Architecture diagrams (Mermaid) for each option |
| [PCG_FINDINGS.md](./PCG_FINDINGS.md) | Issues surfaced in NR's Pipeline Control Gateway while building the PoC — written to be shareable with the NR team |
| [demo/README.md](./demo/README.md) | Run instructions for the working PoC |

## TL;DR

Two goals for joint LD + NR customers:

1. **Enrich NR spans with flag data** — so customers can query flag impact directly in their NR dashboards
2. **Route telemetry to LD** — so Guarded Rollouts can detect regressions and auto-rollback

### What a Good Customer Experience Looks Like

The most ergonomic outcome for joint customers is **zero new customer infrastructure**: the NR APM agent (or NR's Collector distribution) natively recognises LaunchDarkly as a destination. Neither exists today; both are things to engage NR on. See the "Most Ergonomic End-State" section in [EXPLORATION.md](./EXPLORATION.md).

Until then, five options exist depending on the customer's NR setup:

| Option | Best for | Latency | LD effort | Customer infrastructure |
|--------|----------|---------|-----------|------------------------|
| **A: OTel Collector dual-export** | OTel SDK customers | Sub-second | None (existing config) | None new (if already running a Collector) |
| **D: LD-built NR Ingest Service** | All NR customers (long-term) | Sub-second / ~1 min | Significant | None |
| **E: Pipeline Control Gateway** | NR Control customers | Sub-second | Docs + coordination with NR | PCG (often already deployed) |
| **B: NR Streaming Export** | NR-agent + Data Plus customers | ~1 min | Docs | Cloud function |
| **C: NerdGraph polling** | PoC / small scale | ~1 min+ | Reference impl | Cron job |

### Recommended Ordering

1. **Ship Option A today** — it's the lowest-cost win for OTel SDK customers. Zero new LD code; the existing `@launchdarkly/*-otel` TracingHook + LD's published Collector config already work.
2. **Publish a native-API hook per NR agent language** (Goal 1 for NR-agent customers) — one small LD package per language, using the agent's `addCustomSpanAttribute` API. Gives those customers immediate value in NR dashboards even before Goal 2 is in place.
3. **Invest in Option D** — an LD-managed NR Ingest Service gives NR-agent customers the same "configure once in the LD UI" experience joint customers expect. This is the most ergonomic no-new-infrastructure path.
4. **Engage NR on native integration** — either as a "LaunchDarkly destination" preset in PCG, or as a native filter/fork option in the NR APM agent itself. Either would substantially simplify the joint customer story.

### Key Gotchas (Captured While Building the PoC)

- The LD `TracingHook` adds span events but **does not** set `launchdarkly.project_id` on the OTel resource. Without that attribute, LD's OTLP endpoint silently drops the data. Set it on the app's OTel Resource at SDK init (or via a Collector resource processor).
- For NR APM agent customers on Node.js, the agent's OTel bridge does not currently support `addEvent` on auto-instrumented spans — the standard LD TracingHook fails silently. Use a native-API hook instead (example in `demo/services/nr_agent_service/`).
- PCG has several rough edges that affect the NR-agent leg today — reproducible issues with reproductions, impact, and suggested fixes in [PCG_FINDINGS.md](./PCG_FINDINGS.md).

## Demo

A working PoC is in [`demo/`](./demo/) — simulator + NR APM agent service + OTel SDK service + PCG Helm values. The OTel SDK → PCG → NR + LD leg is validated end-to-end. See [demo/README.md](./demo/README.md) for run instructions.
