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

## Summary for the NR team

1. **Should-fix (blocker)**: TLS mismatch between NR Node agent v11+ and
   the chart's `nrproprietaryreceiver`. The chart ships plain HTTP only;
   the agent forces TLS. Customers can't actually point recent NR agents
   at PCG as deployed by the chart.
2. **Should-fix (major)**: NR Node.js OTel bridge's `trace.getActiveSpan()`
   returns a context-only stub without mutation methods for
   auto-instrumented spans. Docs' "Events on spans: ✓" for Node.js does
   not apply to the common case; third-party OTel-aware hooks silently
   fail. See #6.
3. **Should-fix**: `otlp/receiver` should bind to `0.0.0.0`, not
   `${env:MY_POD_IP}`. Fixes port-forward and matches `nrproprietaryreceiver`.
4. **Should-document-or-broaden**: The processor allowlist (no `batch`, no
   `groupbytrace`, etc.) needs to be visible in docs, and ideally include
   `batch` + `groupbytrace` so LD's published Collector config runs unchanged.
5. **Nice-to-fix**: Wire `CLUSTER_NAME` into the deployment env so the
   built-in prometheus scrape labels work.
6. **Nice-to-fix**: Make the `feature_flag.opentelemetry_bridge → opentelemetry_bridge.enabled` config migration more obvious — either alias it, or surface the "ignored" message more visibly.

Happy to provide the repo, kind commands, and values file if useful — all
committed at `ld_new_relic/demo/` in this repo.
