# Installing PCG into a local kind cluster

This PoC runs the services + simulator in docker-compose and PCG in a local
[kind](https://kind.sigs.k8s.io/) cluster. docker-compose containers talk to PCG
via `host.docker.internal` + `kubectl port-forward`.

## Prerequisites

```bash
brew install kind kubectl helm
```

## 1. Create the cluster

```bash
kind create cluster --name ld-nr-demo
kubectl cluster-info --context kind-ld-nr-demo
```

## 2. Install PCG

```bash
export NEW_RELIC_LICENSE_KEY=<your NR ingest license key>

helm repo add newrelic https://helm-charts.newrelic.com
helm repo update

helm upgrade --install pipeline-control-gateway \
  newrelic/pipeline-control-gateway \
  --namespace newrelic --create-namespace \
  --values values-newrelic-gateway.yaml \
  --set licenseKey=$NEW_RELIC_LICENSE_KEY \
  --set cluster=ld-nr-demo
```

Expected pods:

```bash
kubectl -n newrelic get pods
# pipeline-control-gateway-xxxx   1/1   Running
```

## 3. Port-forward PCG's receivers to the host

docker-compose services connect via `host.docker.internal`, so forward the
relevant receiver ports:

```bash
kubectl -n newrelic port-forward svc/pipeline-control-gateway \
  4317:4317 4318:4318 80:80
```

Leave this running. Mapping:

- OTel service → `http://host.docker.internal:4318` (OTLP/HTTP)
- NR-agent service → `host.docker.internal:80` (NR agent protocol, aka
  `nrproprietaryreceiver`)

> Port 80 on the host may require sudo or already be in use — if so, pick
> another local port and update `NEW_RELIC_HOST` in `.env` to
> `host.docker.internal:<port>`. The NR Node agent respects host:port.

## 4. Verify the pipeline

Tail PCG logs:

```bash
kubectl -n newrelic logs -f -l app.kubernetes.io/name=pipeline-control-gateway
```

Once the simulator is running, PCG should forward to:

- `otlp.nr-data.net` (full fidelity via `traces/nr` and `traces/otlp`)
- `otel.observability.app.launchdarkly.com:4318` (filtered via
  `traces/launchdarkly`)

## Teardown

```bash
helm -n newrelic uninstall pipeline-control-gateway
kind delete cluster --name ld-nr-demo
```
