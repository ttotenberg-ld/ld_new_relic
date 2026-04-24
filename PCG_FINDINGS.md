# Pipeline Control Gateway — findings from local PoC

Notes from standing up `newrelic/pipeline-control-gateway` in a local
[kind](https://kind.sigs.k8s.io/) cluster and adding a second exporter to it.
Shareable with the New Relic team.

**Environment**

- Chart: `newrelic/pipeline-control-gateway` `2.0.2` (appVersion `2.0.1`)
- Installed via `helm upgrade --install` with a custom `values-newrelic-gateway.yaml`
  that adds an additional OTLP exporter + two `filter` processors + a new
  `traces/*` pipeline under `generated:`
- Kubernetes: kind (local, single node), kubectl `port-forward` for access
  from containers running outside the cluster
- PCG role: fork telemetry to NR *and* to a secondary OTLP endpoint
  (LaunchDarkly) using OTTL-based filtering — the pattern described in
  LaunchDarkly's OTel docs

**Repo context**: `ld_new_relic/demo/` in this repo. Values file at
[`demo/pcg/values-newrelic-gateway.yaml`](./demo/pcg/values-newrelic-gateway.yaml).

---

## 1. `otlp/receiver` default binds to the pod IP, not `0.0.0.0` — breaks `kubectl port-forward`

**Chart default** (from `values.yaml`, `generated.receivers`):

```yaml
otlp/receiver:
  protocols:
    http:
      endpoint: "${env:MY_POD_IP}:4318"
    grpc:
      endpoint: "${env:MY_POD_IP}:4317"
```

Meanwhile the sibling `nrproprietaryreceiver` binds to `0.0.0.0:80`. The
binding choices are inconsistent between the two receivers.

**Impact**

`kubectl port-forward` connects to `127.0.0.1:<port>` *inside the target pod's
network namespace*. Binding the receiver to `MY_POD_IP` means only the pod's
cluster IP accepts connections — loopback is refused, so port-forward fails
immediately on the first incoming request:

```
E0424 10:10:23.210631 portforward.go:522] "Unhandled Error"
err="an error occurred forwarding 4318 -> 4318: error forwarding port 4318
to pod ...: failed to connect to localhost:4318 inside namespace ...:
dial tcp4 127.0.0.1:4318: connect: connection refused
IPv6 dial tcp6 [::1]:4318: connect: connection refused"
error: lost connection to pod
```

Any `kubectl exec <pod> -- curl localhost:4318` or `kubectl port-forward`
workflow breaks.

**Reproduction**

```bash
kind create cluster --name ld-nr-demo
helm upgrade --install pipeline-control-gateway \
  newrelic/pipeline-control-gateway \
  --namespace newrelic --create-namespace \
  --set licenseKey=$NEW_RELIC_LICENSE_KEY --set cluster=ld-nr-demo
kubectl -n newrelic port-forward svc/pipeline-control-gateway 4318:4318
# Send any OTLP/HTTP trace to localhost:4318 → "lost connection to pod"
```

**Workaround**

Override the receiver binding in values:

```yaml
generated:
  receivers:
    otlp/receiver:
      protocols:
        http:
          endpoint: "0.0.0.0:4318"
        grpc:
          endpoint: "0.0.0.0:4317"
```

**Suggested fix**

Change the chart default for `otlp/receiver` to bind to `0.0.0.0` (matching
`nrproprietaryreceiver`). There's no observable downside — the Kubernetes
`Service` selector still routes external traffic to the pod IP, and
intra-pod loopback traffic starts working.

---

## 2. `batch` and `groupbytrace` processors are rejected — the LD docs' OTTL example won't run as-is

**Runtime error** on startup when `batch` or `groupbytrace` appears in the
processors list:

```
Error: failed to get config: cannot unmarshal the configuration:
decoding failed due to the following error(s):

'processors' unknown type: "batch" for id: "batch/launchdarkly"
(valid values: [memory_limiter cumulativetodelta filter
telemetrybytesprocessor transform probabilistic_sampler])
```

**Impact**

The PCG build is a restricted OTel Collector — its processor allowlist is:

- `memory_limiter`
- `cumulativetodelta`
- `filter`
- `telemetrybytesprocessor`
- `transform`
- `probabilistic_sampler`

Notably absent:

- `batch` — standard component, recommended by essentially every OTel
  exporter guide for coalescing exports
- `groupbytrace` — required to assemble all spans from a trace before a
  batch export, which is the pattern documented in
  [LaunchDarkly's own OTel Collector config](https://launchdarkly.com/docs/sdk/features/opentelemetry-server-side#expand-configuring-the-collector)
  that PCG's dual-export story is supposed to enable

**Why this matters for the LD integration**

LaunchDarkly's OTel Collector docs publish a specific filter+export chain
for forwarding span-event-carrying traces to
`otel.observability.app.launchdarkly.com:4318`. The canonical chain is:

```
filter/launchdarkly-spanevents → filter/launchdarkly-spans
  → groupbytrace → batch → otlphttp/launchdarkly
```

On PCG, the last two stages silently can't be added. Consequences:

- Spans from the same trace may arrive at LD's OTLP endpoint in separate
  requests. LD's backend reassembles by `trace_id`, so correctness is
  preserved, but throughput and network efficiency suffer without `batch`.
- Any downstream Collector-side logic that relies on seeing a full trace
  before export (e.g. tail-sampling filters) cannot be expressed in PCG.

**Suggested fixes (pick one)**

1. Add `batch` and `groupbytrace` to the processor allowlist — these are
   standard, non-dangerous, and widely used.
2. If the restriction is intentional (e.g. to prevent misconfiguration that
   could drop NR data), document the allowlist prominently in the PCG
   "Configure" docs with guidance on what to use instead, and update the
   LaunchDarkly/PCG integration docs to reflect the real supported shape.
3. If you'd like, publish a PCG-compatible reference OTTL config for the LD
   use case (since the current LD docs' config doesn't work as-is on PCG).

---

## 3. Prometheus scrape config references `${env:CLUSTER_NAME}` but the env var isn't set by the chart

**Warning on startup**

```
warn envprovider@v1.45.0/provider.go:61
Configuration references unset environment variable
{"name": "CLUSTER_NAME"}
```

**Source** (chart default `values.yaml`, in
`generated.receivers.prometheus/monitoring.config.scrape_configs[...].static_configs[...].labels`):

```yaml
clusterName: "${env:CLUSTER_NAME}"
```

The deployment template (`templates/deployment.yaml`) sets `NEW_RELIC_HOST`,
`KUBE_NODE_NAME`, `MY_POD_IP`, `MY_POD_NAME`, `MY_POD_NAMESPACE`,
`GOMEMLIMIT`, and `NEW_RELIC_LICENSE_KEY` — but not `CLUSTER_NAME`, despite
`cluster:` being a top-level chart value set via `--set cluster=...`.

**Impact**

Low. The internal prometheus scrape still runs; scraped metrics just carry
`clusterName=""`. Annoying warning, and any NR-side monitoring that groups
by `clusterName` will lose the grouping.

**Suggested fix**

Add `CLUSTER_NAME` to the deployment env block, sourced from `.Values.cluster`
(or `global.cluster`), next to the existing `NEW_RELIC_HOST` env var.

---

## 4. NR Node agent v11+ cannot talk to the `nrproprietaryreceiver` as the chart ships it

**Symptoms** (from `newrelic_agent.log` on a service pointed at PCG):

```
"SSL config key can no longer be disabled, not updating."
"Unexpected error communicating with New Relic backend"
  errno:-71  code:"EPROTO"
  "Error: write EPROTO ... SSL routines:ssl3_get_record:wrong version number"
```

And intermittently:

```
"ECONNREFUSED" address:"192.168.65.254" port:80
```

**What's happening**

The Node.js NR APM agent (observed on `newrelic` npm v12.25.1) forces TLS on
all collector traffic. The `ssl: false` config option is still accepted but
the agent logs a warning and ignores it — it will always do a TLS handshake,
regardless of port. Relevant docs in the agent release notes describe this
as intentional deprecation.

Meanwhile, the chart's NR-agent-protocol receiver (`nrproprietaryreceiver`)
is exposed as plain HTTP on port 80:

- `values.yaml`: `ports.nrHttp: 80`
- `service.yaml`: port name `nr-http` (not `nr-https`)
- `values.yaml` default `nrproprietaryreceiver.server.endpoint: "0.0.0.0:80"`
- No TLS / cert / ingress options anywhere in the chart

Net effect: customers running recent NR Node agents cannot point them at
PCG. Agent opens a TCP connection, writes a TLS ClientHello, PCG returns
HTTP bytes, handshake fails, no data flows.

**Impact**

This blocks the primary value proposition of PCG for the LD integration:
forwarding NR-agent-originated traces to a secondary OTLP endpoint
(LaunchDarkly). Customers using the OTel SDK can export to PCG's
`otlp/receiver` normally, but customers still on NR APM agents (the more
common case) cannot.

**Reproduction**

```bash
# Install PCG per docs, port-forward nr-http:80 to the host
kubectl -n newrelic port-forward svc/pipeline-control-gateway 80:80

# In a separate shell, start any Node.js app that `require('newrelic')` with:
#   host: 'host.docker.internal'
#   port: 80
#   ssl: false            (ignored by agent)
# Then tail the agent's log:
tail -f newrelic_agent.log
# → SSL config key can no longer be disabled, not updating.
# → write EPROTO ... SSL routines:ssl3_get_record:wrong version number
```

**Workaround on our side**

For the PoC we point the NR agent directly at `collector.newrelic.com`
(bypassing PCG). The NR-agent → PCG → LD leg we wanted to validate is not
exercised. OTel-SDK → PCG → NR + LD still works.

**Suggested fixes (pick one)**

1. **Add TLS config to `nrproprietaryreceiver` in the chart**, with
   cert-manager integration or support for mounting an existing secret. Most
   scalable fix; this is the standard OTel receiver pattern.
2. **Provide a sidecar/init pattern in the chart** that handles TLS
   termination (e.g. an envoy/nginx sidecar) and forwards plain HTTP to the
   receiver on localhost. Documented in the chart.
3. **Ship a reference Ingress manifest** (NGINX, Contour, etc.) showing how
   to put TLS in front of PCG for customers who already have an ingress
   controller.
4. **Document `helm template`-friendly overrides** for customers who want
   to run their own TLS proxy (stunnel, Caddy, etc.) without modifying the
   chart.

Without one of these, the customer-facing story ("point your NR agent at
PCG to fork telemetry") doesn't work for current-generation Node agents,
and presumably the same is true for any other NR agent that has deprecated
`ssl: false`.

---

## 5. Node.js NR agent config key `feature_flag.opentelemetry_bridge` is a no-op in v12

**Symptoms** (from `newrelic_agent.log`):

```
"Feature flag opentelemetry_bridge has been released"
"`opentelemetry_bridge` is not enabled, skipping setup of opentelemetry-bridge"
```

**What's happening**

In older agent versions the OTel API bridge was gated behind
`feature_flag.opentelemetry_bridge: true` (the pattern documented in some
blog posts and older docs). In v12 the bridge graduated to a stable feature
and moved to a top-level `opentelemetry_bridge:` config section:

```js
exports.config = {
  opentelemetry_bridge: {
    enabled: true,
    traces:  { enabled: true },
    metrics: { enabled: false },
    logs:    { enabled: false },
  },
};
```

Or via env var: `NEW_RELIC_OPENTELEMETRY_BRIDGE_ENABLED=true`.

Setting the old `feature_flag.opentelemetry_bridge` silently does nothing,
and the agent logs the "has been released" message — but the user has to
know to look in `newrelic_agent.log` (which by default is a file, not
stdout) to see it.

**Impact**

Low per-customer (once they find the right key it's fine), but it's a gotcha
that depends entirely on which doc page a customer landed on first. The
official NR page
<https://docs.newrelic.com/docs/apm/agents/manage-apm-agents/opentelemetry-api-support/>
does use the correct stable form, so this is mostly a "older blog posts and
Stack Overflow answers mislead users" problem.

**Suggested fix**

- In `newrelic_agent.log`, promote the "feature flag released" message from
  `level 40` (warn) to something more visible at startup, or surface it via
  `logger.info` with a clear "config has been ignored — set
  opentelemetry_bridge.enabled=true instead" pointer.
- Alternatively, keep `feature_flag.opentelemetry_bridge` as a recognized
  alias that still enables the bridge (with a deprecation warning), so
  users don't end up with silent no-op config.

---

## 6. NR Node.js OTel bridge: `trace.getActiveSpan()` returns a context-only stub with no Span API — "Events on spans: ✓" in the docs is misleading

**Symptoms**

After enabling the OTel bridge (`opentelemetry_bridge.enabled: true`) and
calling `@opentelemetry/api`'s `trace.getActiveSpan()` inside a route handler
that the NR agent has auto-instrumented, the returned object looks like an
OTel `Span` but is missing all the mutation methods. When the LaunchDarkly
TracingHook from `@launchdarkly/node-server-sdk-otel` calls
`span.addEvent('feature_flag', {...})`, it throws:

```
TypeError: currentTrace.addEvent is not a function
```

The LD SDK catches this silently, so nothing surfaces except in the SDK's
own log channel.

**Evidence** (from an in-process diagnostic hook):

```
[diag] after flag=demo-flag spanImpl=FakeSpan addEvent=type=undefined
       methods=[constructor, spanContext, segmentId, traceId]
       nrSpanId=c0039eb8d2c12a9b inExperiment=undefined
```

The "span" has exactly four methods — enough for distributed-tracing
context propagation (so trace IDs flow through OTel propagators), but no
`addEvent`, no `setAttribute`, no `setStatus`, no `end`. Agent version:
`newrelic` v12.25.1. Config:

```js
opentelemetry_bridge: {
  enabled: true,
  traces: { enabled: true },
}
```

**What's actually going on**

The OTel bridge appears to install a full OTel-compatible `Span` wrapper
only when spans are created **via the OTel API** (i.e. the user code calls
`tracer.startSpan()`). Spans created by NR's native auto-instrumentation
(the common case: Fastify/Express/HTTP request spans that show up in NR's
Distributed Tracing UI) are NR-native, and the bridge exposes just enough
of them through `trace.getActiveSpan()` for context ID access. Calls like
`addEvent` on that stub throw.

**Why this matters**

The NR docs
(<https://docs.newrelic.com/docs/apm/agents/manage-apm-agents/opentelemetry-api-support/>)
show Node.js with "Events on spans: ✓" next to .NET and Java. Customers
reasonably interpret this to mean "I can take any OTel-aware library (like
a LaunchDarkly, OpenFeature, or Sentry hook) that calls
`trace.getActiveSpan().addEvent(...)`, drop in the NR agent, and have the
enrichment work." In practice this common pattern silently doesn't work
for auto-instrumented spans. It only works if the user explicitly wraps
their own logic in `tracer.startActiveSpan()`.

This materially affects the LaunchDarkly integration story:

- **Goal 1** (flag attributes visible in NR dashboards): needs a custom
  hook using `newrelic.addCustomSpanAttribute()` instead of the
  general-purpose OTel TracingHook.
- **Goal 2** (NR-agent-originated traces forwarded through PCG to LD):
  even once the TLS blocker (#4) is solved, the data shape won't match
  LD's published OTTL filter — LD looks for span *events* named
  `feature_flag`; NR-native attribute enrichment produces span *attributes*
  instead. PCG would need a second, attribute-shaped filter pipeline for
  NR-agent-origin traffic.

**Reproduction**

Any Node.js app with the NR agent loaded (via `-r newrelic`) and
`opentelemetry_bridge.enabled: true`. Inside any framework route handler:

```js
const { trace } = require('@opentelemetry/api');
app.get('/x', () => {
  const span = trace.getActiveSpan();
  console.log(typeof span.addEvent); // → "undefined"
});
```

Or install the LaunchDarkly TracingHook on the LD SDK and watch for the
`afterEvaluation` error in your LD SDK logs.

**Suggested fixes (pick one)**

1. **Wrap NR-native spans with a full OTel `Span` shim**. When
   `trace.getActiveSpan()` is called and there's an active NR transaction,
   return a wrapper whose `addEvent` maps to
   `newrelic.recordCustomEvent()` or appends attributes to the current NR
   segment; `setAttribute` maps to `addCustomSpanAttribute`; `end` / others
   are no-ops. This makes the docs' "Events on spans: ✓" claim true for
   the natural use case.
2. **If (1) is infeasible for architectural reasons, revise the docs.**
   The current matrix row should explicitly say something like:
   "Events-on-spans work for user-created OTel spans, not for spans
   produced by NR's auto-instrumentation. Use
   `newrelic.addCustomSpanAttribute()` to enrich auto-instrumented spans."
3. **Log a clear error at the source.** When a user calls `.addEvent()`
   on the returned stub, surface an informative error via the agent's
   logger pointing to the documented alternative, instead of silently
   throwing `TypeError`.

---

## 6b. Empirical confirmation: attribute-shaped NR-agent data silently fails at LD's ingest

Once the TLS and arm64 blockers are worked around (TLS terminator in front of
PCG on a native-AMD64 host), end-to-end validation confirms what #6 predicts:

Measured pipeline throughput with 3 minutes of simulator traffic:

| Stage | Count |
|---|---|
| `nrproprietaryreceiver` accepted (NR-agent origin) | 398 |
| `otlp/receiver` accepted (OTel SDK origin) | 6,434 |
| `otlphttp/launchdarkly` successfully sent | 6,306 |
| `otlphttp/launchdarkly` failed | 0 |
| `filter/launchdarkly-spanevents` events dropped | **0** |

The `filter/launchdarkly-spanevents` counter sits at 0 specifically because
the NR-agent-origin spans carry **no** span events at all — the native-API
hook we had to fall back on for NR-agent customers (see #6) produces
`feature_flag.*` data as span attributes, not events. The spans survive the
filter chain on the strength of their `http.route` attribute, arrive at
LaunchDarkly's OTLP endpoint with an HTTP 200, and are silently dropped by
LD's ingest because LD looks for span *events* named `feature_flag` with
`inExperiment=true`.

So the architectural story for NR-agent customers routing through PCG is:
bytes flow, but no useful signal reaches LD's Guarded Rollouts engine.
Closing this gap requires either

- a PCG-side `transform` processor that synthesises span events from
  attribute-shaped data (this is feasible — `transform` is in PCG's
  allowlist — but writing the OTTL is non-trivial and would need to live in
  LD's published docs), or
- LD-side ingest support for attribute-shaped flag data (preferred; removes
  the shape-mismatch burden from every customer and aligns with an eventual
  LD-built NR Ingest Service, EXPLORATION.md Option D).

---

## 7. PCG image is AMD64-only — crypto fails under QEMU emulation on Apple Silicon

**Symptoms**

On a local Apple Silicon (arm64) machine running kind, after configuring a
TLS terminator in front of PCG so the NR Node agent can reach
`nrproprietaryreceiver`, the agent's `preconnect` handshake fails. PCG's
log:

```
{"level":"error","msg":"Failed to process request",
 "error":"Post \"https://collector.newrelic.com/agent_listener/invoke_raw_method?
          ...method=preconnect...\": local error: tls: bad record MAC",
 "status_code":500,
 "pcg_request_path":"agent_listener/invoke_raw_method",
 "user_agent":"NewRelic-NodeAgent/12.25.1 (nodejs 20.20.2 linux-arm64)"}
```

The `nrproprietaryreceiver` acts as a **proxy** during the NR-agent
handshake — when the agent sends `preconnect`, PCG forwards that request to
`collector.newrelic.com` to discover the real collector host. On arm64
macOS via Docker Desktop, this outbound TLS call fails intermittently with
`bad record MAC`.

**Diagnosis**

```bash
kubectl describe node  # kubernetes.io/arch=arm64
kubectl exec <pcg-pod> -- uname -m  # → x86_64
docker manifest inspect newrelic/pipeline-control-gateway:2.0.1
# Single-arch manifest — no arm64 variant published.
```

The PCG image is AMD64-only, so Docker Desktop on Apple Silicon pulls it and
runs it under QEMU user-mode emulation. QEMU's emulated crypto is well
known to produce subtle issues on long-lived or complex TLS handshakes.
OTLP export from PCG to `otlp.nr-data.net` works (short, simple HTTPS
calls), but the NR-agent preconnect round-trip trips.

**Impact**

- Any developer on Apple Silicon (fairly common) cannot validate the
  NR-agent → PCG leg locally in kind / minikube / Docker Desktop.
- Customers running K8s on arm64 nodes (AWS Graviton, Ampere, etc.)
  cannot deploy PCG at all.

**Workarounds**

- Run the validation on an AMD64 machine / CI runner.
- Use an arm64 remote dev environment.
- Wait for NR to publish a multi-arch image.

**Suggested fix**

Build and publish `newrelic/pipeline-control-gateway` as a multi-arch image
(AMD64 + arm64). Go cross-compiles cleanly, and most of the runtime
dependencies (OTel Collector, Go crypto) already support arm64 upstream.

---

## 8. `nrproprietaryreceiver` drops the NR agent's `app_name` — NR-origin spans arrive with no `service.name` resource attribute

**Symptoms**

With a dedicated `traces/launchdarkly-nr` pipeline and a `debug` exporter
attached, an NR-agent-origin ResourceSpans batch looks like this:

```
ResourceSpans #0
Resource SchemaURL:
Resource attributes:
     -> nr.reservoirSize: Int(2000)
     -> nr.eventsSeen: Int(44)
     -> launchdarkly.project_id: Str(sdk-...)   # stamped by our OTTL transform
ScopeSpans #0
InstrumentationScope
Span #0
    Name           : Nodejs/Middleware/Fastify/<anonymous>//search
    ...
```

Compared to the same exporter's output for an OTel-SDK-origin batch, which
has ~15 resource attributes including `service.name`, `service.version`,
`telemetry.sdk.*`, `process.*`, `host.name`, etc. No `service.name`. No
`app.name`. No `newrelic.app.name`. No `entity.guid`. Nothing that
identifies the originating application.

Meanwhile the NR agent **has** an `app_name` — confirmed directly from the
live agent process:

```bash
docker exec nr-agent-service node -e \
  'const nr=require("newrelic");console.log(nr.agent.config.app_name)'
# → app_name: [ 'ld-nr-demo-agent-service' ]
```

So the information is present on the agent side and sent over the
proprietary protocol, but it's discarded during the proprietary→OTel
translation inside PCG.

**Impact**

- Any downstream OTel consumer (LaunchDarkly, Tempo, Datadog, Honeycomb,
  a second NR account via OTLP) that filters or groups traces by
  `service.name` sees a single anonymous bucket for all NR-agent-origin
  traces. UI filtering and correlation break.
- The loss is silent. The spans arrive fine, and the `nrcollectorexporter`
  path still forwards them to NR cloud using the original proprietary
  payload (which embeds `app_name` separately, outside the OTel resource
  schema). So NR's own UI looks correct and the problem is invisible
  unless you're inspecting the OTel output path.

**Reproduction**

Stand up PCG with a `debug` exporter on any pipeline that includes
`nrproprietaryreceiver`. Point a NR Node agent at PCG (via a TLS
terminator, per #4). Grep the debug output for NR-origin batches — they
have `nr.reservoirSize` / `nr.eventsSeen` but no `service.name`.

**Workaround**

Conditional OTTL `set` in a `transform` processor on the NR pipeline —
harmless for OTel-SDK-origin spans (they already set `service.name` at SDK
init), stamps a literal on NR-origin:

```yaml
transform/launchdarkly-project-id:
  trace_statements:
    - context: resource
      statements:
        - set(attributes["launchdarkly.project_id"], "${env:LD_SDK_KEY}")
        - set(attributes["service.name"], "ld-nr-demo-agent-service") where attributes["service.name"] == nil
```

This only holds up when one PCG serves one NR-agent-instrumented service.
With multiple apps behind the same PCG the literal isn't viable — you'd
need the receiver to preserve `app_name` per-request.

**Suggested fix**

In `nrproprietaryreceiver`, map the NR agent's `app_name` onto
`service.name` on the Resource of every translated span, alongside any
other proprietary-to-OTel mappings the receiver already does. If
`app_name` is an array (NR supports rollup app names), take the first
element or join with `;`.

---

## 9. `nrproprietaryreceiver` emits NR-origin spans with `1970-01-01 00:00:00` timestamps — wall-clock time is lost in translation

**Symptoms**

An NR-agent-origin span coming out of PCG's `debug` exporter:

```
Span #0
    Trace ID       : 3918ddc39333681158ab105d158feb1d
    Parent ID      : 2f61f22fbacbcece
    ID             : 168bf81b98069c83
    Name           : Nodejs/Middleware/Fastify/<anonymous>//search
    Kind           : Unspecified
    Start time     : 1970-01-01 00:00:00 +0000 UTC
    End time       : 1970-01-01 00:00:00.002096322 +0000 UTC
    Status code    : Unset
    Status message :
Attributes:
     -> nr_exclusive_duration_millis: Double(2.096323)
```

Duration is preserved (≈ 2.096 ms) and stored in a custom attribute. But
both absolute timestamps are effectively zero — `end - start` equals the
duration, yet both are anchored at the Unix epoch rather than at the
span's actual wall-clock start.

**What's happening**

The NR proprietary protocol represents span timing as relative offsets
from a transaction's start time, not as absolute timestamps. PCG's
`nrproprietaryreceiver` appears to populate the OTel
`start_time_unix_nano` / `end_time_unix_nano` fields from those relative
offsets directly, without anchoring to the transaction's wall-clock
start. Result: every NR-origin span ends up at the Unix epoch.

**Impact (observed, narrower than initially hypothesised)**

End-to-end testing shows LaunchDarkly's OTel ingest *does* place these
spans at correct wall-clock time in the UI, despite what the debug
exporter prints. So either (a) the `debug` exporter's text formatter
renders a zero/unset field as `1970-01-01` for NR-origin spans even when
the on-the-wire OTLP protobuf carries valid timestamps, or (b) LD's
backend reconstructs timestamps from send-time metadata. Either way, LD
ingest isn't the blocker we feared.

Still a real concern for any OTel consumer that doesn't do that
reconstruction — a self-hosted Tempo/Jaeger or a plain OTLP collector
logging this output will show every NR-origin span at the Unix epoch.
And the internal `debug` exporter's logs are now misleading for anyone
debugging an NR-agent-origin pipeline: timestamps look catastrophically
broken when they're not.

The `nrcollectorexporter` path is unaffected — proprietary-to-NR-cloud
forwarding carries the original payload intact, so NR Distributed
Tracing still works.

**Suggested fix / investigation**

Confirm whether the zero timestamps are (a) a debug-exporter rendering
bug specific to the shape of resources that `nrproprietaryreceiver`
produces or (b) real zeros in the OTLP output that LD is smoothing over
at ingest. If (b), `nrproprietaryreceiver` should still populate
`start_time_unix_nano` / `end_time_unix_nano` properly from the agent's
transaction timestamps so that non-LD OTLP consumers work without
relying on LD-specific reconstruction.

---

## 10. Default `otlphttp` exporter constructs a malformed metrics URL (`.../v1/traces/v1/metrics`)

**Symptoms**

On every metrics harvest, PCG logs:

```
error internal/queue_sender.go:49 Exporting failed. Dropping data.
  {"otelcol.component.id": "otlphttp",
   "otelcol.component.kind": "exporter",
   "otelcol.signal": "metrics",
   "error": "not retryable error: Permanent error:
             rpc error: code = Unimplemented desc =
             error exporting items, request to
             https://otlp.nr-data.net/v1/traces/v1/metrics
             responded with HTTP Status Code 404",
   "dropped_items": 233}
```

Note the doubled path: `v1/traces/v1/metrics`.

**What's happening**

The chart's default `otlphttp` exporter (in `generated.exporters.otlphttp`)
sets its `endpoint` (or `traces_endpoint`) to
`https://otlp.nr-data.net/v1/traces` and then derives the metrics endpoint
by appending `v1/metrics` without stripping the traces path first. Looks
like a small config bug in the chart defaults.

**Impact**

- Every NR-cloud metrics harvest routed through this exporter fails with
  404. On our PoC, `dropped_items` was 233 per batch.
- Noisy logs (one error per harvest interval, by default every 60 s).
- The NR-agent → `nrcollectorexporter` path isn't affected, so APM
  metrics still flow via the proprietary payload. But anything routed
  through the OTel `metrics/*` pipeline is silently dropped.

**Suggested fix**

Use distinct endpoint keys in the chart default:

```yaml
otlphttp:
  traces_endpoint:  https://otlp.nr-data.net/v1/traces
  metrics_endpoint: https://otlp.nr-data.net/v1/metrics
  logs_endpoint:    https://otlp.nr-data.net/v1/logs
```

or set a single base `endpoint: https://otlp.nr-data.net` and let the
exporter derive paths. The current chart default concatenates incorrectly.

---

## Summary for the NR team

1. **Should-fix (blocker)**: TLS mismatch between NR Node agent v11+ and
   the chart's `nrproprietaryreceiver`. The chart ships plain HTTP only;
   the agent forces TLS. Customers can't actually point recent NR agents
   at PCG as deployed by the chart. See #4.
2. **Should-fix (blocker for arm64)**: PCG image is single-arch (AMD64
   only). On arm64 nodes — Apple Silicon, Graviton — the image runs under
   emulation and outbound TLS handshakes corrupt. See #7.
3. **Investigate**: `nrproprietaryreceiver` appears to emit NR-origin
   spans with zero / epoch timestamps as seen by the `debug` exporter.
   LD ingest places the spans correctly regardless (not a blocker there),
   but either the debug output is misrendering valid timestamps or LD is
   doing backend reconstruction that other OTLP consumers won't. See #9.
4. **Should-fix (major for OTel forking)**: `nrproprietaryreceiver`
   doesn't map the NR agent's `app_name` onto `service.name` on
   translated resources. Every NR-agent trace looks unattributed in the
   OTel output. See #8.
5. **Should-fix (major)**: NR Node.js OTel bridge's
   `trace.getActiveSpan()` returns a context-only stub without mutation
   methods for auto-instrumented spans. Docs' "Events on spans: ✓" for
   Node.js does not apply to the common case; third-party OTel-aware
   hooks silently fail. See #6.
6. **Should-fix**: `otlp/receiver` should bind to `0.0.0.0`, not
   `${env:MY_POD_IP}`. Fixes port-forward and matches
   `nrproprietaryreceiver`. See #1.
7. **Should-fix**: Default `otlphttp` exporter posts metrics to a
   double-pathed URL (`.../v1/traces/v1/metrics`) and 404s on every
   harvest. See #10.
8. **Should-document-or-broaden**: The processor allowlist (no `batch`,
   no `groupbytrace`, etc.) needs to be visible in docs, and ideally
   include `batch` + `groupbytrace` so LD's published Collector config
   runs unchanged. See #2.
9. **Nice-to-fix**: Wire `CLUSTER_NAME` into the deployment env so the
   built-in prometheus scrape labels work. See #3.
10. **Nice-to-fix**: Make the
    `feature_flag.opentelemetry_bridge → opentelemetry_bridge.enabled`
    config migration more obvious — either alias it, or surface the
    "ignored" message more visibly. See #5.

Happy to provide the repo, kind commands, and values file if useful — all
committed at `ld_new_relic/demo/` in this repo.
