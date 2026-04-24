# LaunchDarkly + New Relic Integration Exploration

## Goals

1. **Span Enrichment**: Enrich spans in New Relic with LaunchDarkly feature flag evaluation data, so joint customers can analyse flag impact directly in their NR dashboards.
2. **Telemetry Routing to LD**: Send the relevant subset of those traces to LaunchDarkly so Guarded Rollouts can detect regressions and trigger automated rollback.

---

## Design Principles: What a Good Joint Customer Experience Looks Like

These principles guide the option-ranking throughout this doc.

1. **Prefer existing customer infrastructure over new deployments.** Editing a Collector config a customer already runs beats asking them to stand up a new piece of infrastructure.
2. **Prefer one-time configuration over ongoing operational burden.** One hook install per language beats scattered code changes; one `values.yaml` edit beats a Lambda they have to maintain.
3. **Sub-second latency for Guarded Rollouts.** Regression detection needs near-real-time data. Anything with minute-level latency (polling, batched exports) is acceptable for dashboards but less useful for automated rollback.
4. **Graceful degradation.** Goal 1 (flag data in NR dashboards) should work even when Goal 2 (routing to LD) isn't configured yet. A customer exploring the integration should get immediate value in NR with one step.
5. **Be kind to NR tiers the customer already has.** Don't require Data Plus, NR Control, or any specific add-on if a path exists that doesn't.

---

## The Most Ergonomic End-State: Native New Relic Support for Forking to LD

The ideal experience for joint customers is **zero customer-side infrastructure**: the NR agent (or NR's Collector distribution) natively recognises LaunchDarkly as a destination and mirrors the relevant flag-enriched telemetry to LD's OTLP endpoint. The customer would only need to provide their LD project ID; everything else would be built in.

Two shapes this could take:

- **NR APM agent side**: A secondary export rule in the agent that mirrors spans matching a filter (e.g. "contains `feature_flag.key`") to a configured OTLP destination. This would cover the majority of current NR customers without asking them to adopt any additional infrastructure.
- **NR Collector / Pipeline Control Gateway side**: A first-class "LaunchDarkly" destination preset in PCG — one checkbox, paste SDK key, filters and exporter auto-configured. Covers the segment of customers who've adopted NR Control.

Neither exists today. Building either would require collaboration between the NR and LD product teams. Until one of them does, the rest of this document enumerates the options that work with NR's platform as it ships today.

---

## Customer Instrumentation Landscape

NR customers fall into two camps, and the integration story differs meaningfully between them:

| Camp | Instrumentation | Prevalence |
|------|----------------|------------|
| **A: New Relic APM Agent** | Proprietary agents (Java, .NET, Node, Python, Ruby, Go, PHP) with auto-instrumentation | Majority of existing customers |
| **B: OpenTelemetry** | OTel SDK exporting to NR's OTLP endpoint | Growing — NR actively promotes this path |

NR's OTLP support is first-class; they've positioned themselves as an "OTel-native" backend. That's a tailwind for the OTel path but doesn't change the fact that the NR APM agent remains the installed base.

---

## Goal 1: Span Enrichment

### For OTel SDK Customers: the LaunchDarkly OTel TracingHook

```
App
├── OTel SDK (traces)
├── LD Server SDK
│   └── TracingHook (@launchdarkly/node-server-sdk-otel et al.)
│       └── Adds feature_flag.* span events to the active OTel span
└── OTLP Exporter → New Relic OTLP endpoint
```

How it works:
1. App uses an OTel SDK, configured to export to NR's OTLP endpoint
2. LD SDK is initialised with the standard `TracingHook`
3. On every evaluation, the hook adds a `feature_flag` span event to the active span with attributes like `feature_flag.key`, `feature_flag.context.id`, `feature_flag.result.variationIndex`, `feature_flag.result.reason.inExperiment`
4. NR indexes these as span-event attributes, queryable via NRQL

**Pros:**
- No custom LD code — the TracingHook already exists
- Follows OTel semantic conventions for feature flags
- Works uniformly across languages with OTel SDK support

**Cons:**
- Customer must be on OTel SDK (or willing to adopt it)

**Verdict: the primary path. This is where the OTel SDK's investment pays off for joint customers.**

### For NR APM Agent Customers: a Custom LD Hook Using the Agent's Native API

Each NR APM agent has a native API for enriching the current auto-instrumented span:

| Language | API |
|----------|-----|
| Python | `newrelic.agent.add_custom_span_attribute(key, value)` |
| Java | `NewRelic.getAgent().getTracedMethod().addCustomAttribute(key, value)` |
| .NET | `transaction.AddCustomAttribute(key, value)` (agent v8.25+) |
| Node.js | `newrelic.addCustomSpanAttribute(key, value)` |

A small LD hook package (per language) calls these from `afterEvaluation`. The result: `feature_flag.*` attributes land directly on the NR auto-instrumented span, queryable via NRQL the same way `http.route`, `service.name`, etc. are.

```javascript
// Node.js example used in the PoC (demo/services/nr_agent_service/)
const newrelic = require('newrelic');

class NewRelicNativeHook {
  getMetadata() { return { name: 'newrelic-native-hook' }; }
  afterEvaluation(hookContext, data, detail) {
    newrelic.addCustomSpanAttribute('feature_flag.key', hookContext.flagKey);
    newrelic.addCustomSpanAttribute('feature_flag.context.id', hookContext.context?.key);
    if (typeof detail?.variationIndex === 'number') {
      newrelic.addCustomSpanAttribute('feature_flag.result.variationIndex', detail.variationIndex);
    }
    if (detail?.reason?.inExperiment) {
      newrelic.addCustomSpanAttribute('feature_flag.result.reason.inExperiment', true);
    }
    return data;
  }
}
```

Attribute names follow OTel feature-flag semantic conventions so a future NRQL query or PCG filter can use the same vocabulary regardless of whether a span came from an OTel SDK (event shape) or an NR agent (attribute shape).

#### Why Not Use the NR OTel Bridge + Standard LD TracingHook Here?

This was our first design instinct — point the LD TracingHook at the NR agent's OTel bridge and get uniform OTel-shaped telemetry everywhere. It doesn't work as of NR Node.js agent v12.25.1:

- `trace.getActiveSpan()` inside a handler that the NR agent auto-instrumented returns a context-only stub — valid `spanContext()`, but no `addEvent`, no `setAttribute`, no `setStatus`.
- `span.addEvent('feature_flag', {...})` throws `TypeError: addEvent is not a function`.
- The LD SDK's hook wrapper catches the error silently, so no span enrichment happens and nothing surfaces in the UI.

Details and reproduction in [`PCG_FINDINGS.md`](./PCG_FINDINGS.md) finding #6. Until NR's OTel bridge returns full OTel-compatible Span wrappers for auto-instrumented spans, the NR-native-API hook is the reliable choice.

**Pros (native-API hook):**
- Works today for any NR-agent customer, no NR-side changes required
- Enrichment lands directly on the NR auto-instrumented span — no duplication
- One small LD package per NR-supported language

**Cons:**
- Per-language implementation and maintenance burden on LD
- Smaller API surface than OTel (some NR agents support custom span attributes more completely than others — PHP and Ruby are weaker)
- Data shape is span attributes, not span events, which means the existing LD OTTL filter (written for span events) doesn't apply directly to NR-agent-origin data when it's being forwarded to LD (relevant for Goal 2)

**Verdict: this is the path for NR-agent customers and should be productised as a set of LD-maintained packages, one per NR-supported language.**

### Hybrid (NR Agent + OTel SDK in the Same Process)

Not recommended. Dual-instrumentation causes span duplication and context-propagation conflicts. Pick one instrumentation stack per service.

---

## Goal 2: Routing Enriched Traces to LaunchDarkly

LaunchDarkly's Guarded Rollouts need telemetry (latency, error rates) correlated with flag evaluations to detect regressions and auto-rollback.

### What LaunchDarkly's OTLP Endpoint Expects

- **Endpoint**: `otel.observability.app.launchdarkly.com:4317` (gRPC) / `:4318` (HTTP)
- **Authentication**: resource attribute `launchdarkly.project_id` set to the server-side SDK key. **You have to set this yourself** — the `TracingHook` adds `feature_flag` span events but does **not** modify the OTel resource. Set it on the app's OTel `Resource` at SDK init, or via a Collector resource processor. If it's missing, LD's endpoint accepts the request with a success status and silently drops the data.
- **What LD extracts**:
  - **Span events** named `feature_flag` where `feature_flag.result.reason.inExperiment == true` (i.e. flags currently in an active guarded rollout — not every evaluation)
  - **Exception span events** (for error-rate detection)
  - **Spans with `http.route`** (for latency/error correlation)
- **Data reduction**: LD wants only traces that touch active guarded-rollout evaluations, not every flag eval. This dramatically reduces volume compared to a naive "send everything with a `feature_flag.*` attribute" approach.

### Options Ranked by Customer Ergonomics

Ordered from "least new infrastructure for the customer" to "most new infrastructure."

#### Option A: Customer's Existing OTel Collector (for OTel customers)

If the customer already runs an OTel Collector in their pipeline, enabling the LD integration is an edit to their existing config: add an exporter, add a filter, add a second pipeline. No new component to deploy.

```
App (OTel SDK + LD TracingHook)
  │ OTLP export
  ▼
OTel Collector (customer's existing)
  ├─ Pipeline 1: ALL spans → New Relic (full fidelity)
  └─ Pipeline 2: FILTERED spans → LaunchDarkly
      ├─ filter/launchdarkly-spanevents: keep only inExperiment flag evals + exceptions
      ├─ filter/launchdarkly-spans: keep only spans with http.route OR surviving events
      ├─ groupbytrace: ensure complete traces arrive together
      └─ otlphttp exporter → otel.observability.app.launchdarkly.com
```

Full config from [LD's Collector docs](https://launchdarkly.com/docs/sdk/features/opentelemetry-server-side#expand-configuring-the-collector):

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  # Required — TracingHook does not set launchdarkly.project_id on the OTel
  # resource. Either set it here or on the app's OTel Resource at SDK init.
  resource:
    attributes:
      - key: launchdarkly.project_id
        value: YOUR_SDK_KEY
        action: upsert

  # Stage 1: drop span events that aren't relevant to guarded rollouts.
  # Keeps only feature_flag events where inExperiment=true, plus exception events.
  filter/launchdarkly-spanevents:
    error_mode: ignore
    traces:
      spanevent:
        - 'not ((name == "feature_flag" and attributes["feature_flag.result.reason.inExperiment"] == true) or name == "exception")'

  # Stage 2: drop spans with no http.route and no surviving span events.
  filter/launchdarkly-spans:
    error_mode: ignore
    traces:
      span:
        - 'not (attributes["http.route"] != nil or Len(events) > 0)'

  # Ensure complete traces arrive together.
  groupbytrace:
    wait_duration: 10s

  batch:

exporters:
  otlphttp/newrelic:
    endpoint: "https://otlp.nr-data.net"
    headers:
      api-key: "${NEW_RELIC_LICENSE_KEY}"

  otlphttp/launchdarkly:
    endpoint: "https://otel.observability.app.launchdarkly.com:4318"

service:
  pipelines:
    traces/newrelic:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/newrelic]

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

The two-stage filter is the interesting bit: stage 1 drops irrelevant events, stage 2 keeps spans either because they still have events or because they carry `http.route`. Combined with `groupbytrace`, LD receives complete traces that anchor flag evaluations to HTTP route performance.

**Pros:**
- No new customer infrastructure if they already run a Collector
- Sub-second latency
- Aggressive data reduction — LD only sees guarded-rollout-relevant traces
- Identical OTTL config to LD's published docs — copy-paste

**Cons:**
- Requires the customer to run an OTel Collector (true for most OTel-based shops but not NR-agent-only shops)
- Data is span-event-shaped, which is fine for OTel SDK customers but doesn't help NR-agent customers whose enrichment is attribute-shaped

**Verdict: this is the best option available today for OTel SDK customers.** It's also what an LD-published "how to wire up NR + LD" doc should lead with.

#### Option D: LD-Built New Relic Ingest Service

For NR customers (agent or OTel), LD could build a first-party integration that pulls flag-enriched data from NR directly. Configuration happens in the LD UI; the customer provides NR credentials and LD does the rest. No customer-side infrastructure.

```
App (NR Agent or OTel SDK)
  │ traces
  ▼
New Relic
  ▲
  │ NerdGraph API / Streaming Export
  │
LaunchDarkly (New Relic Ingest Service)
  └─ Correlates flag evaluations with NR telemetry, feeds Guarded Rollouts
```

Two sub-options:
- **D1 (pull-based)**: LD periodically queries NerdGraph for spans with `feature_flag.*` attributes or events. Simple to build; limited by NerdGraph rate limits and latency.
- **D2 (push-based)**: Customer configures NR Streaming Export to push to an LD-managed endpoint. Better latency and scale, but requires customer to have NR Data Plus.

**Pros:**
- Best customer UX: configure once in the LD dashboard, no customer-side infrastructure
- Works for every NR customer segment (agent + OTel, any tier)
- LD controls the reliability and quality of the integration
- Fits the model customers already expect from LD integrations in other observability ecosystems

**Cons:**
- Significant LD engineering investment
- NerdGraph latency and rate-limit ceilings for D1
- Streaming Export requires customer Data Plus for D2

**Verdict: highest long-term value for joint customers.** The right ordering is: ship Option A first (it costs almost nothing in LD engineering), then invest in D1 as a no-new-infrastructure alternative for NR-agent customers, then D2 for scale.

#### Option E: Pipeline Control Gateway (for NR Control Customers)

NR's [Pipeline Control Gateway](https://docs.newrelic.com/docs/new-relic-control/pipeline-control/overview/) is an OpenTelemetry Collector distribution that NR packages, Helm-charts, and supports. Customers already on NR Control have PCG deployed, which means they have a Collector-compatible forking point in their stack — and uniquely, PCG ships with a native receiver for the NR agent wire protocol, so NR APM agents can be pointed at PCG without migrating to OTel SDK.

On paper this is a great fit: same OTTL filter as Option A, same sub-second latency, and it works for both NR-agent and OTel customers who already have PCG.

```
NR APM Agent ─┐
              │
              ├──► PCG (OTel Collector in customer's K8s)
OTel SDK     ─┤          │
              │          ├──► NR Cloud (full fidelity)
              │          │
              │          └──► LaunchDarkly OTLP (filtered)
```

In practice, working through a local PoC uncovered several rough edges in PCG as it ships today. They're reproducible, we've filed them in [`PCG_FINDINGS.md`](./PCG_FINDINGS.md) to share back with the NR team, and they're in different categories of severity. The short version:

- The default OTLP receiver binding breaks `kubectl port-forward` (easy fix, documented workaround)
- The NR APM agent forces TLS on all collector traffic, but PCG's NR-agent-protocol receiver ships plain HTTP only — the chart has no TLS-termination story (blocker for most Node-agent customers; workaround requires a TLS sidecar)
- The processor allowlist excludes `batch` and `groupbytrace`, which means LD's published OTTL pipeline (which uses both) can't be copy-pasted unchanged
- The PCG image is AMD64-only — customers on arm64 (Apple Silicon, Graviton) can't run it
- The NR Node.js OTel bridge's `getActiveSpan()` returns a stub without mutation methods for auto-instrumented spans (this one is an agent issue, not PCG — but it blocks the "OTel-TracingHook through NR agent to PCG" story for Node.js)

None of these are insurmountable. If NR addresses them and/or ships a first-class "LaunchDarkly destination" preset in PCG (see "Ideal end-state" at the top of this doc), Option E becomes the most ergonomic path for NR Control customers. Today, recommend it cautiously with pointers to the workarounds.

**Pros:**
- One forking mechanism for both NR-agent and OTel customers (when it works)
- LD filter config is nearly identical to Option A (copy-paste with minor tweaks for PCG's processor allowlist)
- Sub-second latency
- NR owns the chart and runtime for PCG itself
- No NR Data Plus required

**Cons:**
- Requires NR Control tier
- Current PCG gaps (see `PCG_FINDINGS.md`) make the NR-agent leg non-trivial to validate end-to-end
- NR agents must be reconfigured to point at PCG rather than the cloud collector

**Verdict: promising for NR Control customers, and the concept is exactly right — but practical adoption benefits from NR closing the gaps listed in the findings doc.**

#### Option B: New Relic Streaming Data Export → LD

For NR-agent customers who have NR Data Plus, NR's Streaming Data Export can push matching spans to a cloud message bus, where a customer-managed transform function forwards them to LD's OTLP endpoint.

```
App → NR → Streaming Export (NRQL WHERE feature_flag.key IS NOT NULL)
          → Kinesis / Event Hub / Pub/Sub
          → Transform Lambda / Function (NR JSON → OTLP)
          → LaunchDarkly OTLP endpoint
```

**Pros:**
- Works for NR-agent-only customers (no OTel Collector required)
- Filter runs inside NR (no wasted egress)
- NR handles reliability of the export hop

**Cons:**
- Requires NR Data Plus
- ~1-minute latency — fine for dashboards, borderline for Guarded Rollout auto-rollback
- Customer has to build and operate a transform function to convert NR's export JSON to OTLP
- More moving parts than any other option

**Verdict: workable for NR-agent + Data Plus customers, but the operational tax is high. Option D (if built) supersedes this.**

#### Option C: NerdGraph Polling → LD

A scheduled job periodically queries NR's NerdGraph API for recent flag-enriched spans and forwards them to LD.

**Pros:**
- No Data Plus required
- Simple to prototype
- Works for any NR customer

**Cons:**
- ~1-minute practical polling floor
- NerdGraph rate limits
- Deduplication and pagination burden on the caller
- Doesn't scale to high span volumes

**Verdict: useful as a reference implementation or for low-volume environments. Not production-grade at scale.**

---

## Option Comparison Matrix

Ordered by customer ergonomics, most ergonomic first:

| | OTel Collector (A) | LD Ingest Service (D) | Pipeline Control Gateway (E) | NR Streaming Export (B) | NerdGraph Polling (C) |
|---|---|---|---|---|---|
| **Works for OTel customers** | Yes | Yes | Yes (today) | Yes | Yes |
| **Works for NR-agent customers** | No (needs a Collector) | Yes | Yes (once current gaps are closed) | Yes | Yes |
| **Latency** | Sub-second | Varies (sub-second for D2) | Sub-second | ~1 min | ~1 min+ |
| **New customer infrastructure** | None (if Collector already deployed) | None | PCG (Helm-installed, if not already) | Cloud function | Cron job |
| **NR tier required** | Any | Any (D1) / Data Plus (D2) | Control | Data Plus | Any |
| **LD engineering effort** | None (existing) | Significant | Docs + fix-forward coordination with NR | Docs | Docs |
| **Data reduction** | Very high (only active guarded rollout spans) | Server-side | Very high (same OTTL as A) | NRQL WHERE filter | NRQL WHERE filter |
| **Production readiness today** | High | High (once built) | Medium — see `PCG_FINDINGS.md` | Medium | Low |

---

## Recommended Path Forward

### Ship Today: What Works Right Now

- **OTel SDK customers → Option A.** Publish a clear "how to add LaunchDarkly to your existing Collector" doc. Highlight the `launchdarkly.project_id` resource-attribute requirement prominently so customers don't hit the silent-drop failure mode.
- **NR APM agent customers → Goal 1 via native-API hooks** (one LD package per language). Gives immediate value in NR dashboards. For Goal 2, those customers wait for Option D or fall back to B/C.

### Next Investment: Close the Gap for NR-Agent Customers

- **Build Option D (LD-side NR Ingest Service).** Start with D1 (pull-based / NerdGraph) because it works for any NR tier. Graduate to D2 (push-based / Streaming Export) once adoption justifies the additional plumbing. This gives NR-agent customers the same "configure once in the LD UI" experience that joint customers get from LD's other first-class integrations.

### Engage NR: Make the Integration Native

The most ergonomic long-term experience is native NR support for forking to LD — see "The Most Ergonomic End-State" at the top of this doc. Concretely:

- Partner with NR to add a **"LaunchDarkly destination" preset in Pipeline Control Gateway**: one option in PCG's UI / values file that wires up the LD OTLP exporter, the OTTL filters, and the `launchdarkly.project_id` resource attribute automatically. LD provides the config; NR provides the ergonomics.
- Longer term, partner on **native forking in the NR APM agent** — a configuration option that mirrors spans matching a pattern to a second OTLP destination. This is the only path that reaches NR's entire customer base without asking them to adopt any new infrastructure.

Meanwhile, the findings in [`PCG_FINDINGS.md`](./PCG_FINDINGS.md) are framed to be shareable with the NR team — each includes reproduction, impact, and a suggested fix. Closing those is a prerequisite to recommending Option E broadly.

---

## New Relic-Specific Considerations

### Billing Impact

- Custom span attributes (from flag enrichment via either the OTel path or the NR-native-API hook) increase "GB Ingested" in NR — billable. Worth noting to joint customers up front.
- Streaming Data Export carries its own cost on top of Data Plus.
- Routing LD-bound data via Option A or E bypasses NR billing for that subset entirely (since the LD pipeline in the Collector filters before export to NR).

### OTLP Endpoint Details (for Goal 1 OTel-SDK customers)

- **Endpoint**: `https://otlp.nr-data.net` (US) / `https://otlp.eu01.nr-data.net` (EU)
- **Auth**: `api-key: <NEW_RELIC_LICENSE_KEY>` header
- **Protocol**: HTTP/protobuf preferred over gRPC
- TLS 1.2 required

### NRQL Queryability

After Goal 1 is wired up, joint customers can query flag data in NR. The exact query differs by instrumentation shape:

**OTel SDK path** (flag data stored as span events — `feature_flag.*` on the event):

```sql
-- Flag-evaluation events
FROM SpanEvent SELECT *
  WHERE name = 'feature_flag' AND feature_flag.key = 'new-checkout-flow'

-- Latency by variation
FROM SpanEvent SELECT average(duration)
  WHERE feature_flag.key = 'new-checkout-flow'
  FACET feature_flag.result.variationIndex
```

**NR APM agent path** (flag data stored as span attributes on the enclosing span):

```sql
-- All spans for a specific flag
FROM Span SELECT * WHERE feature_flag.key = 'new-checkout-flow'

-- Compare latency across flag variations
FROM Span SELECT average(duration)
  WHERE feature_flag.key = 'new-checkout-flow'
  FACET feature_flag.result.variationIndex

-- Error rate by flag variation
FROM Span SELECT percentage(count(*), WHERE error IS true)
  WHERE feature_flag.key = 'new-checkout-flow'
  FACET feature_flag.result.variationIndex

-- Dashboard: active flag evaluations
FROM Span SELECT uniqueCount(feature_flag.key) AS 'Active Flags',
  count(*) AS 'Total Evaluations'
  WHERE feature_flag.key IS NOT NULL TIMESERIES
```

Attribute names follow OTel feature-flag semantic conventions in both shapes, so queries that work for one can be translated to the other with only a `FROM Span` ↔ `FROM SpanEvent` swap.

---

## Demo

A working PoC — simulator + two Node.js services (one on the NR APM agent, one on the OTel SDK) + PCG config — is in [`demo/`](./demo/). The OTel SDK → PCG → NR + LD leg is validated end-to-end. The NR-agent → PCG leg is blocked on the PCG gaps captured in `PCG_FINDINGS.md`; the NR-agent → NR-cloud direct path works and proves Goal 1 via the native-API hook.
