# TLS terminator (Caddy) for the NR-agent → PCG leg

## Why this exists

The New Relic Node.js APM agent v11+ forces TLS on all collector traffic
(the agent logs "SSL config key can no longer be disabled"). The PCG Helm
chart ships `nrproprietaryreceiver` as plain HTTP on port 80 with no TLS
option. See `../../../PCG_FINDINGS.md` finding #4.

This directory configures a tiny Caddy sidecar that accepts TLS on :443
with a self-signed cert and forwards plain HTTP to PCG's `:80`. The NR
agent trusts the cert via `NODE_EXTRA_CA_CERTS`.

PoC-only. Don't reuse this pattern in production.

## One-time setup

```bash
bash gen.sh
```

Generates `cert.pem` + `key.pem` (CN=`pcg-tls`, valid 365 days). Both are
gitignored.

## Wiring

- `docker-compose.yaml` has a `pcg-tls` service that mounts this directory
  at `/certs` inside the Caddy container.
- The `nr-agent-service` is pointed at `pcg-tls:443` with the cert mounted
  and `NODE_EXTRA_CA_CERTS=/certs/cert.pem` set.
- `kubectl port-forward svc/pipeline-control-gateway 80:80` still needs to
  be running on the host — Caddy forwards to `host.docker.internal:80`.
