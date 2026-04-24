# LaunchDarkly + New Relic Integration Exploration

## Goals

1. **Span Enrichment**: Enrich New Relic-originated spans with feature flag evaluation attributes from the LaunchDarkly SDK
2. **Telemetry Routing to LD**: Filter and send relevant traces back to LaunchDarkly to power regression detection and autoremediation via Guarded Rollouts

---

## Background: What Worked for Dynatrace

The Dynatrace exploration established a two-layer pattern:

- **Hooks** handle in-process span enrichment (LD SDK hooks add `feature_flag.*` attributes to OTel spans)
- **OTel Collector** handles infrastructure-level routing (dual-export pipeline: all spans to APM vendor, filtered flag-enriched spans to LD)

Three approaches were explored for Dynatrace, but the cleanest path was always: **OTel SDK + LD TracingHook + Collector dual-export**. The same pattern applies here, with New Relic-specific considerations.

---

## Goal 1: Span Enrichment

### How New Relic Customers Instrument Today

New Relic customers fall into two camps:

| Camp | Instrumentation | Prevalence |
|------|----------------|------------|
| **A: New Relic APM Agent** | Proprietary agents (Java, .NET, Node, Python, Ruby, Go, PHP) with auto-instrumentation | Majority of existing customers |
| **B: OpenTelemetry** | OTel SDK exporting to New Relic's OTLP endpoint | Growing, NR actively encourages this path |

New Relic has been investing heavily in OTel — their OTLP endpoint is first-class, and they position themselves as an "OTel-native" backend.

### Approach 1: OTel SDK + LD TracingHook (Recommended)

**For customers already on OTel (or willing to adopt it).**

```
App
├── OTel SDK (traces)
├── LD Server SDK
│   └── TracingHook (@launchdarkly/node-server-sdk-otel)
│       └── Adds feature_flag.* span events to active OTel span
└── OTLP Exporter → New Relic OTLP endpoint
```

**How it works:**
1. App uses OTel SDK for tracing, configured to export to New Relic's OTLP endpoint
2. LD SDK is initialized with the existing `TracingHook`
3. On every flag evaluation, the hook adds span events with:
   - `feature_flag.key`
   - `feature_flag.context.key`
   - `feature_flag.provider_name` = "LaunchDarkly"
   - `feature_flag.result.variationIndex`
4. These attributes flow into New Relic as custom span attributes, queryable via NRQL:
   ```sql
   FROM Span SELECT * WHERE feature_flag.key IS NOT NULL
   ```

**Pros:**
- Zero new LD code needed — existing TracingHook works as-is
- Follows OTel semantic conventions for feature flags
- New Relic's OTLP support is mature and first-class
- Custom attributes are queryable, alertable, and dashboardable in New Relic

**Cons:**
- Requires customer to be on OTel SDK (not NR proprietary agent)

**Verdict: This is the primary path. Most effort should go here.**

### Approach 2: New Relic APM Agent + Custom Attributes Hook

**For customers on New Relic's proprietary APM agents who won't adopt OTel.**

Each NR agent has its own API for adding custom attributes to spans:

| Language | API |
|----------|-----|
| Python | `newrelic.agent.add_custom_span_attribute(key, value)` |
| Java | `NewRelic.getAgent().getTracedMethod().addCustomAttribute(key, value)` |
| .NET | `transaction.AddCustomAttribute(key, value)` (agent v8.25+) |
| Node.js | `newrelic.addCustomSpanAttribute(key, value)` |

A custom LD hook would call these APIs in `afterEvaluation`:

```typescript
// Conceptual — NewRelicAgentHook
class NewRelicAgentHook {
  afterEvaluation(hookContext, data, detail) {
    const newrelic = require('newrelic');
    newrelic.addCustomSpanAttribute('feature_flag.key', hookContext.flagKey);
    newrelic.addCustomSpanAttribute('feature_flag.context.key', hookContext.context.key);
    newrelic.addCustomSpanAttribute('feature_flag.variation_index', detail.variationIndex);
    return data;
  }
}
```

**Pros:**
- Works for existing NR agent customers without OTel migration
- NR agents handle span lifecycle automatically

**Cons:**
- Vendor-specific: need per-language hook implementations using NR-specific APIs
- Smaller surface area than OTel (not all agents support custom span attributes equally)
- PHP and Ruby agent support for custom span attributes is limited
- Maintenance burden of tracking NR agent API changes

**Verdict: Nice-to-have for customers who resist OTel. Lower priority than Approach 1.**

### Approach 3: Hybrid — NR Agent + OTel SDK Side-by-Side

New Relic agents can coexist with OTel SDK in some languages. The NR agent handles auto-instrumentation while OTel SDK provides the span context for the LD TracingHook.

**This is fragile and not recommended.** Dual-instrumentation causes span duplication and context propagation conflicts.

---

## Goal 2: Sending Enriched Traces to LaunchDarkly

This is the harder and more interesting problem. LaunchDarkly's Guarded Rollouts need telemetry data (latency, error rates) correlated with flag evaluations.

### What LaunchDarkly Needs

LD exposes an **OTLP-compatible endpoint** that accepts traces:
- **gRPC:** `otel.observability.app.launchdarkly.com:4317`
- **HTTP:** `otel.observability.app.launchdarkly.com:4318`

**Authentication:** Via resource attribute `launchdarkly.project_id` set to the SDK key. **You have to set this yourself** — the `TracingHook` in `@launchdarkly/node-server-sdk-otel` (v1.1.x, verified by reading source) adds `feature_flag` span events but does **not** modify the OTel resource. Set `launchdarkly.project_id` either on the app's OTel `Resource` at SDK init, or via a Collector resource processor. Without it, LD silently drops ingested data — the endpoint accepts the request (exporter reports success), but nothing shows up in the UI.

LD extracts from ingested traces:
- **Span events** named `feature_flag` where `feature_flag.result.reason.inExperiment == true` (i.e., flags in an active guarded rollout — not all flag evaluations)
- **Exception span events** (for error rate detection)
- **HTTP route spans** (`http.route` attribute) for latency/error correlation

LD generates route-specific and global events from these, feeding into Guarded Rollouts for regression detection and automated rollback.

> **Key insight:** LD does NOT need all flag evaluation spans — only those where `inExperiment == true`. This dramatically reduces the data volume compared to a naive "send everything with a flag attribute" approach.

### Option A: OTel Collector Dual-Export (Same as Dynatrace Pattern)

```
App (OTel SDK + LD TracingHook)
  │ OTLP export
  ▼
OTel Collector
  ├─ Pipeline 1: ALL spans → New Relic (full fidelity)
  └─ Pipeline 2: FILTERED spans → LaunchDarkly
      ├─ filter/launchdarkly-spanevents: keep only inExperiment flag evals + exceptions
      ├─ filter/launchdarkly-spans: keep only spans with http.route OR surviving events
      ├─ groupbytrace: ensure complete traces arrive together
      └─ otlphttp exporter → otel.observability.app.launchdarkly.com
```

**This is the proven pattern from the Dynatrace exploration.** It works identically here because:
- The app exports OTLP to the Collector regardless of backend
- The Collector routes to both New Relic and LD independently
- Very aggressive data reduction: LD only gets spans relevant to active guarded rollouts

**Collector config for NR + LD dual-export:**

Based on [LD's official Collector docs](https://launchdarkly.com/docs/sdk/features/opentelemetry-server-side#expand-configuring-the-collector):

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  # Set launchdarkly.project_id. Required — TracingHook does NOT set this on
  # the OTel resource, so either do it here or on the app's OTel Resource
  # at SDK init (the app-side approach is cleaner and is what the demo uses).
  resource:
    attributes:
      - key: launchdarkly.project_id
        value: YOUR_SDK_KEY
        action: upsert

  # Stage 1: Drop span EVENTS that aren't relevant to guarded rollouts.
  # Keeps only: (a) feature_flag events where inExperiment=true, and (b) exception events.
  # This means LD only receives data for flags in an active guarded rollout, not all evals.
  filter/launchdarkly-spanevents:
    error_mode: ignore
    traces:
      spanevent:
        - 'not ((name == "feature_flag" and attributes["feature_flag.result.reason.inExperiment"] == true) or name == "exception")'

  # Stage 2: Drop SPANS that have no http.route AND no surviving span events.
  # After the spanevent filter, spans with no remaining events AND no HTTP route are useless.
  filter/launchdarkly-spans:
    error_mode: ignore
    traces:
      span:
        - 'not (attributes["http.route"] != nil or Len(events) > 0)'

  # Group all spans from the same trace together.
  # Required so LD receives complete traces (parent + child spans) in a single request.
  groupbytrace:
    wait_duration: 10s

  batch:

exporters:
  # New Relic — all spans, full fidelity
  otlphttp/newrelic:
    endpoint: "https://otlp.nr-data.net"
    headers:
      api-key: "${NEW_RELIC_LICENSE_KEY}"

  # LaunchDarkly — filtered spans for guarded rollouts
  otlphttp/launchdarkly:
    endpoint: "https://otel.observability.app.launchdarkly.com:4318"

extensions:
  health_check:

service:
  extensions: [health_check]
  pipelines:
    # Everything goes to New Relic
    traces/newrelic:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/newrelic]

    # Only guarded-rollout-relevant data goes to LaunchDarkly
    traces/launchdarkly:
      receivers: [otlp]
      processors:
        [
          filter/launchdarkly-spanevents,
          filter/launchdarkly-spans,
          groupbytrace,
          batch,
        ]
      exporters: [otlphttp/launchdarkly]
```

> **Note on filtering semantics:** The two-stage filter is much smarter than a naive
> "keep spans with feature_flag.key". Stage 1 strips span events that aren't for active
> guarded rollouts. Stage 2 then drops spans that lost all their events AND have no
> HTTP route. This means LD still gets HTTP-route spans (for latency/error metrics) even
> if they don't directly contain flag events — as long as they're in the same trace as
> a guarded-rollout flag evaluation (ensured by `groupbytrace`).

**Pros:**
- Proven pattern, vendor-agnostic
- Customer already has Collector if they're on OTel
- Clean separation of concerns
- Cost-optimized: only flag-relevant spans go to LD

**Cons:**
- Requires OTel Collector in the pipeline (most OTel customers have this already)
- Does not directly help NR-agent-only customers unless they adopt an OTel Collector. NR's own Pipeline Control Gateway — covered in Option E — fills this gap by exposing a Collector-compatible forking point that natively accepts the NR agent protocol.

**Verdict: Primary recommendation for OTel customers. Same as Dynatrace.**

### Option B: New Relic Streaming Data Export → LD

**Use New Relic's own data export to stream flag-enriched spans to LD.**

```
App (NR Agent or OTel SDK)
  │ traces
  ▼
New Relic (ingests + stores)
  │ Streaming Data Export (NRQL rule)
  ▼
AWS Kinesis Firehose / Azure Event Hub / GCP Pub/Sub
  │
  ▼
Transform Lambda / Function
  │ Convert NR span format → OTLP
  ▼
LaunchDarkly OTLP endpoint
```

**How it works:**
1. Create a Streaming Export rule via NerdGraph:
   ```sql
   SELECT * FROM Span WHERE feature_flag.key IS NOT NULL
   ```
2. This streams matching spans to a cloud message bus (Kinesis, Event Hub, Pub/Sub)
3. A serverless function transforms NR's span format to OTLP and forwards to LD

**Key details:**
- **Latency:** ~1 minute cadence for span data (not sub-second)
- **Requires Data Plus:** Streaming Export is a premium NR feature
- **Format:** NR exports in their internal JSON format, not OTLP — needs transformation
- **Filter at source:** The NRQL `WHERE` clause filters server-side, reducing egress

**Pros:**
- Works for NR-agent-only customers (no OTel Collector needed)
- Filter happens inside New Relic (no wasted egress)
- NR handles reliability/retry of the export pipeline

**Cons:**
- Requires NR Data Plus ($$$)
- ~1 min latency for spans (acceptable for Guarded Rollouts, not for real-time)
- Requires a transformation layer (Lambda/Cloud Function) to convert NR JSON → OTLP
- More moving parts: NR → message bus → transform function → LD
- Vendor lock-in to NR's streaming export infrastructure

**Verdict: Good option for NR-agent-only customers. Higher complexity but unlocks the non-OTel customer segment.**

### Option C: NerdGraph Polling → LD

**Poll New Relic's GraphQL API for recent flag-enriched spans and forward to LD.**

```
Scheduled Job (cron / Lambda)
  │ NerdGraph query every N seconds
  │ FROM Span SELECT * WHERE feature_flag.key IS NOT NULL SINCE 1 minute ago
  ▼
Transform + deduplicate
  ▼
LaunchDarkly OTLP endpoint
```

**Pros:**
- No Data Plus required
- Simple to implement
- Works for any NR customer

**Cons:**
- Polling latency (minimum ~1 min practical interval)
- Rate limits on NerdGraph API
- Need to handle deduplication and pagination
- Doesn't scale well at high span volumes

**Verdict: Useful as a low-cost proof-of-concept or for small-scale deployments. Not production-grade for high-volume customers.**

### Option D: Build a New Relic Ingest Service in LaunchDarkly

**LD builds a first-party integration that pulls data from New Relic directly.**

```
App (NR Agent)
  │ traces
  ▼
New Relic
  ▲
  │ NerdGraph API / Streaming Export
  │
LaunchDarkly (New Relic Ingest Service)
  └─ Correlates flag evaluations with NR telemetry
```

**How it would work:**
1. Customer configures NR account credentials in LD (API key, account ID)
2. LD's ingest service queries NerdGraph for spans with `feature_flag.*` attributes
3. Or: customer sets up Streaming Export with LD as the destination (via a managed transform)
4. LD correlates the data internally for Guarded Rollouts

**This is analogous to the existing Datadog Agent integration**, where LD has a dedicated ingestion path for Datadog telemetry.

**Two sub-options:**

**D1: Pull-based (NerdGraph polling)**
- LD periodically queries NR for flag-enriched spans
- Customer provides read-only NR API key
- Simple but limited by NerdGraph rate limits and latency

**D2: Push-based (Streaming Export → LD-managed endpoint)**
- Customer configures NR Streaming Export to push to an LD-managed webhook/endpoint
- LD provides an ingest endpoint that accepts NR's export format
- Transforms NR JSON to internal LD metrics format
- Better latency, scales with NR's export infrastructure
- Requires customer to have Data Plus

**Pros:**
- Best UX: customer configures once in LD dashboard
- No customer-side infrastructure (no Collector, no Lambda)
- LD controls the integration quality and reliability
- Similar to existing Datadog integration — proven pattern within LD

**Cons:**
- Significant LD engineering investment
- Need to maintain NR API compatibility as NR evolves
- Pull-based approach has scale limitations
- Push-based approach requires customer to have NR Data Plus

**Verdict: Highest long-term value. This is the "do it right" option. Start with D1 (polling) as MVP, graduate to D2 (streaming) for scale.**

### Option E: Pipeline Control Gateway (PCG)

**For NR customers on the Control tier — works for both NR-agent and OTel customers.**

[Pipeline Control Gateway](https://docs.newrelic.com/docs/new-relic-control/pipeline-control/overview/) is an OpenTelemetry Collector (upstream v0.131.0) that NR packages, Helm-charts, and supports. It runs in the customer's own Kubernetes cluster and sits between their apps and NR cloud. Unlike a plain OTel Collector, PCG ships with a native receiver for the NR agent protocol — so NR APM agents can be pointed at PCG and their telemetry forked from there.

```
NR APM Agent ─┐
              │
              ├──► Pipeline Control Gateway (OTel Collector in customer's K8s)
OTel SDK     ─┤          │
              │          ├──► NR Cloud (full fidelity)
              │          │
              │          └──► LaunchDarkly OTLP (filtered: guarded-rollout data only)
```

**How it works:**
1. Customer deploys PCG via NR's Helm chart and edits `values-newrelic-gateway.yaml`
2. NR agents are reconfigured (`host` / `NEW_RELIC_HOST`) to export to PCG instead of `collector.newrelic.com`
3. OTel SDK apps export OTLP directly to PCG
4. Add a second exporter (LD OTLP) and the LD OTTL filter chain (identical to Option A) to PCG config
5. PCG forks: everything to NR, guarded-rollout data to LD. Internally, PCG converts NR agent data to OTLP before routing through processors.

**Key difference from Option A:** PCG's `newrelic` receiver means NR-agent customers don't need to migrate to OTel SDK or run a separate Collector — they already have one (PCG), they just need to edit its config.

**Pros:**
- Works for both NR-agent and OTel customers — single forking mechanism
- LD filter config is identical to the LD docs (copy-paste OTTL)
- Sub-second latency (same as Option A)
- No Data Plus required
- NR owns the Helm chart and operational burden of PCG itself

**Cons:**
- Requires NR Control tier — not all NR customers have PCG deployed
- NR's support posture on custom exporters added by customers is a gray area (officially customer-editable, but adding non-NR destinations may fall outside supported configs)
- NR agents must be reconfigured to point at PCG (small config change per host)
- PCG adoption is currently low, though growing as NR promotes Control
- Round-trip fidelity of span events through the NR-agent protocol → PCG → OTLP path needs empirical validation (PoC target)

**Verdict: Best option for NR-agent customers who have Control. Matches Option A's properties without requiring migration to OTel SDK. The open question — does span-event data added via the NR agent's OTel API survive the NR-agent-protocol → PCG → OTLP round-trip in a shape that the LD OTTL filter matches? — is the key thing to validate in a PoC.**

---

## Option Comparison Matrix

| | OTel Collector (A) | NR Streaming Export (B) | NerdGraph Polling (C) | LD Ingest Service (D) | Pipeline Control Gateway (E) |
|---|---|---|---|---|---|
| **Works for OTel customers** | Yes | Yes | Yes | Yes | Yes |
| **Works for NR-agent-only** | No | Yes | Yes | Yes | Yes |
| **Latency** | Sub-second | ~1 min | ~1 min+ | Depends on sub-option | Sub-second |
| **Customer infra required** | OTel Collector | Cloud function | Cron job | None | PCG (Helm-installed) |
| **NR tier required** | Any | Data Plus | Any | Any (D1) / Data Plus (D2) | Control |
| **LD engineering effort** | None (existing) | Docs only | Docs only | Significant | Docs only |
| **Data reduction** | Very high (only active guarded rollout spans) | NRQL WHERE filter | NRQL WHERE filter | Server-side | Very high (same OTTL as A) |
| **Production readiness** | High | Medium | Low | High (once built) | High (needs fidelity validation) |

---

## Recommended Path Forward

### Phase 1: OTel Collector Dual-Export (Option A)
- **Effort:** Low (reuse Dynatrace Collector config, swap exporter)
- **Target:** NR customers already on OTel
- **Deliverable:** Collector config + docs showing NR + LD dual-export
- This is the same pattern as Dynatrace. Validate it works with NR's OTLP endpoint.

### Phase 2: Pipeline Control Gateway PoC (Option E)
- **Effort:** Low-Medium (PCG handles the infrastructure; customer-side is config-only)
- **Target:** NR-agent customers on Control, and OTel customers who already deploy PCG
- **Deliverable:** `values-newrelic-gateway.yaml` with LD dual-export + docs
- Validates that NR-agent span events round-trip cleanly through PCG to LD's OTTL filter. If yes, this supersedes most of the NR-agent-hook workstream for Control customers.

### Phase 3: NR Agent Hook (Approach 2 from Goal 1)
- **Effort:** Medium (per-language hook implementations)
- **Target:** NR-agent customers without Control (no PCG) who want flag enrichment in NR dashboards
- **Deliverable:** `@launchdarkly/newrelic-agent-hook` package(s)
- Narrower target market now that PCG exists, but still relevant for non-Control customers.

### Phase 4: NerdGraph Polling PoC (Option C)
- **Effort:** Low-Medium
- **Target:** Prove out LD ingest from NR for non-OTel, non-PCG customers
- **Deliverable:** Reference implementation / internal tool

### Phase 5: LD New Relic Ingest Service (Option D)
- **Effort:** High
- **Target:** All NR customers, seamless UX
- **Deliverable:** First-party integration in LD dashboard (like Datadog Agent integration)
- PCG reduces the urgency of D for Control customers, but D remains the cleanest UX for the long tail of customers who don't have PCG and don't want to run their own infrastructure.

---

## New Relic-Specific Considerations

### Billing Impact
- Custom span attributes (from flag enrichment) increase GB Ingested in NR — billable
- Streaming Data Export has its own cost on top of Data Plus
- Collector dual-export means LD-bound data doesn't go through NR billing at all (preferred)

### OTLP Endpoint Details
- **Endpoint:** `https://otlp.nr-data.net` (US) or `https://otlp.eu01.nr-data.net` (EU)
- **Auth header:** `api-key: <NEW_RELIC_LICENSE_KEY>`
- **Protocol:** HTTP/protobuf preferred over gRPC
- **TLS 1.2 required**

### NRQL Queryability
Once flag attributes are on spans, NR customers can:
```sql
-- Find all spans for a specific flag
FROM Span SELECT * WHERE feature_flag.key = 'new-checkout-flow'

-- Compare latency across flag variations
FROM Span SELECT average(duration)
  WHERE feature_flag.key = 'new-checkout-flow'
  FACET feature_flag.result.variationIndex

-- Error rate by flag variation
FROM Span SELECT percentage(count(*), WHERE error IS true)
  WHERE feature_flag.key = 'new-checkout-flow'
  FACET feature_flag.result.variationIndex

-- Dashboard: all active flag evaluations
FROM Span SELECT uniqueCount(feature_flag.key) AS 'Active Flags',
  count(*) AS 'Total Evaluations'
  WHERE feature_flag.key IS NOT NULL TIMESERIES
```

### Comparison with Existing LD Integrations
- **Datadog:** LD has a dedicated Datadog Agent integration (push-based, agent-level)
- **Dynatrace:** Explored via OTel Collector dual-export + OneAgent hooks
- **New Relic:** No existing integration — this would be new territory
- **Sentry, Segment, Highlight.io:** Existing integrations for Guarded Rollouts telemetry

New Relic is a significant gap given their market share. Building this would expand Guarded Rollouts reach substantially.
