'use strict';

// NR agent config. Env vars drive host/port/TLS:
//   NEW_RELIC_HOST            -- collector hostname (default: NR cloud)
//   NEW_RELIC_APP_NAME        -- service name as shown in NR UI
//   NEW_RELIC_LICENSE_KEY     -- ingest license key
//
// The OpenTelemetry bridge is required for the LD TracingHook's span events to
// flow through the NR agent. As of agent v12 the bridge graduated out of the
// feature-flag system, so the stable config is `opentelemetry_bridge.enabled`
// (env: NEW_RELIC_OPENTELEMETRY_BRIDGE_ENABLED=true). The old
// `feature_flag.opentelemetry_bridge` is a no-op.
// Ref: https://docs.newrelic.com/docs/apm/agents/manage-apm-agents/opentelemetry-api-support/
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'ld-nr-demo-agent-service'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  host: process.env.NEW_RELIC_HOST || 'collector.newrelic.com',
  logging: {
    level: process.env.NEW_RELIC_LOG_LEVEL || 'info',
  },
  allow_all_headers: true,
  distributed_tracing: {
    enabled: true,
  },
  opentelemetry_bridge: {
    enabled: true,
    traces: { enabled: true },
    logs: { enabled: false },
    metrics: { enabled: false },
  },
};
