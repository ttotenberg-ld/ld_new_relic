'use strict';

// OTel SDK bootstrap — loaded via --require so it runs before index.js.
// Exports traces via OTLP/HTTP to PCG (OTEL_EXPORTER_OTLP_ENDPOINT).

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const serviceName = process.env.OTEL_SERVICE_NAME || 'ld-nr-demo-otel-service';

const resourceAttrs = {
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: '0.1.0',
};
// LD OTLP endpoint uses the SDK key as a resource attribute for routing.
// The TracingHook itself does NOT set this — it has to be on the OTel resource.
if (process.env.LD_SDK_KEY) {
  resourceAttrs['launchdarkly.project_id'] = process.env.LD_SDK_KEY;
}

const sdk = new NodeSDK({
  resource: new Resource(resourceAttrs),
  traceExporter: new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
