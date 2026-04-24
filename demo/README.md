# LD + NR PCG demo

Two Fastify services emitting the same LD-enriched telemetry via different
instrumentation paths, plus a traffic simulator and a PCG config that forks
data to New Relic (full fidelity) and LaunchDarkly (filtered).

```
simulator ──► nr-agent-service ──[NR agent protocol]──► PCG ──► NR (all)
          └─► otel-service     ──[OTLP]──────────────► PCG ──► LD (filtered)
```

## What we're validating

The LD `TracingHook` from `@launchdarkly/node-server-sdk-otel` adds a
`feature_flag` span **event** to the active OTel span on every flag evaluation.

- **otel-service** uses the OTel SDK directly → OTLP → PCG. Known-good path.
- **nr-agent-service** uses the NR APM agent, which
  [supports the OTel API including events on spans for Node.js](https://docs.newrelic.com/docs/apm/agents/manage-apm-agents/opentelemetry-api-support/).
  The hook calls `@opentelemetry/api` → NR agent's OTel bridge → NR agent
  wire protocol → PCG's `newrelic` receiver → OTLP internally.

The open question: **do span events survive the NR-agent-protocol → PCG → OTLP
round-trip in a shape that LD's OTTL filter still matches?** If yes, the PCG
config needs no special handling for NR-agent origins — one filter chain
works for both services.

## Prerequisites

- Docker + docker-compose
- `kind`, `kubectl`, `helm` (for PCG — see [pcg/INSTALL.md](./pcg/INSTALL.md))
- LaunchDarkly server-side SDK key
- New Relic ingest license key
- A host that can run the PCG container natively. The PCG image is AMD64-only
  — Apple Silicon / Graviton dev machines work for the OTel SDK leg of the
  demo, but the NR-agent leg fails under QEMU emulation (see
  [`../PCG_FINDINGS.md`](../PCG_FINDINGS.md) #7). For that leg, use a native
  amd64 host — see [DEPLOY_EC2.md](./DEPLOY_EC2.md).

## Setup

1. Install PCG into a local kind cluster and port-forward its receivers — follow
   [pcg/INSTALL.md](./pcg/INSTALL.md). Leave the port-forward running.

2. Configure env vars:

   ```bash
   cp .env.example .env
   # edit .env and fill in LD_SDK_KEY, NEW_RELIC_LICENSE_KEY
   ```

3. In LaunchDarkly, create a boolean or string flag with key `demo-rollout`
   (or override `LD_FLAG_KEY` in `.env`). Put it into an active guarded
   rollout — `inExperiment=true` on eval results is what survives the LD
   filter in PCG. Flags without an active guarded rollout will be evaluated
   by the services but filtered out before reaching LD.

4. Start services + simulator:

   ```bash
   docker compose up --build
   ```

## Watching it work

- **Simulator logs**: each tick prints which service + endpoint was hit and
  the status code.
- **Service logs**: Fastify request logs + LD SDK init log.
- **PCG logs**: `kubectl -n newrelic logs -f -l app.kubernetes.io/name=newrelic-pipeline-control-gateway`
- **New Relic**: both service names (`ld-nr-demo-agent-service`,
  `ld-nr-demo-otel-service`) should appear in APM, with `feature_flag.*`
  span attributes queryable via NRQL.
- **LaunchDarkly**: traces for `demo-rollout` should arrive under the flag's
  Guarded Rollout metrics.

## Structure

```
demo/
├── README.md                 ← this file
├── .env.example
├── docker-compose.yaml
├── simulator/                ← loops requests against both services
├── services/
│   ├── nr_agent_service/     ← NR APM agent + OTel API bridge + LD TracingHook
│   └── otel_service/         ← OTel SDK + LD TracingHook
└── pcg/
    ├── values-newrelic-gateway.yaml
    └── INSTALL.md
```

## Tearing down

```bash
docker compose down
# and then teardown kind per pcg/INSTALL.md
```
