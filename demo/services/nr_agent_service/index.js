'use strict';

// The `newrelic` module must be the first require (done via `node -r newrelic`
// in package.json start script). From there the agent hooks into Node's
// instrumentation and registers the OTel API bridge.

const newrelic = require('newrelic');
const Fastify = require('fastify');
const { init } = require('@launchdarkly/node-server-sdk');

// NewRelicNativeHook — enrich the currently-active NR span with feature-flag
// attributes using the agent's native API. We use this instead of the OTel
// TracingHook from @launchdarkly/node-server-sdk-otel because the NR Node
// agent's OTel bridge (v12.25.1) does not expose a functional Span API on
// auto-instrumented spans; `trace.getActiveSpan().addEvent()` throws. See
// PCG_FINDINGS.md finding #6.
//
// Attribute names follow OTel feature-flag semantic conventions so that
// downstream tooling (NRQL, a future PCG OTTL filter for attribute-shaped
// data) can use a consistent vocabulary.
class NewRelicNativeHook {
  getMetadata() {
    return { name: 'newrelic-native-hook' };
  }
  beforeEvaluation(_hookContext, data) {
    return data;
  }
  afterEvaluation(hookContext, data, detail) {
    try {
      const attrs = {
        'feature_flag.key': hookContext.flagKey,
        'feature_flag.provider.name': 'LaunchDarkly',
        'feature_flag.context.id': hookContext.context?.key,
      };
      if (typeof detail?.variationIndex === 'number') {
        attrs['feature_flag.result.variationIndex'] = detail.variationIndex;
      }
      if (detail?.reason?.kind) {
        attrs['feature_flag.result.reason.kind'] = detail.reason.kind;
      }
      if (detail?.reason?.inExperiment) {
        attrs['feature_flag.result.reason.inExperiment'] = true;
      }
      if (detail?.value !== undefined) {
        attrs['feature_flag.result.value'] = JSON.stringify(detail.value);
      }
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) {
          newrelic.addCustomSpanAttribute(key, value);
        }
      }
    } catch (err) {
      console.warn(`[nr-hook] failed to enrich span: ${err.message}`);
    }
    return data;
  }
}

// Diagnostic hook — logs whether NR context is live at eval time.
class DiagnosticHook {
  getMetadata() {
    return { name: 'diagnostic-hook' };
  }
  afterEvaluation(hookContext, data, detail) {
    const meta = newrelic.getTraceMetadata?.() || {};
    console.log(
      `[diag] flag=${hookContext.flagKey} ` +
        `nrTraceId=${meta.traceId} nrSpanId=${meta.spanId} ` +
        `inExperiment=${detail?.reason?.inExperiment} variation=${detail?.variationIndex}`,
    );
    return data;
  }
}

const PORT = parseInt(process.env.PORT || '3001', 10);
const SDK_KEY = process.env.LD_SDK_KEY;
const FLAG_KEY = process.env.LD_FLAG_KEY || 'demo-rollout';
const CONTEXT_KINDS = ['user', 'tenant'];

async function buildLDClient() {
  if (!SDK_KEY) {
    console.warn('[ld] LD_SDK_KEY not set — flag evaluations will be skipped');
    return null;
  }
  const client = init(SDK_KEY, {
    hooks: [new DiagnosticHook(), new NewRelicNativeHook()],
  });
  await client.waitForInitialization({ timeout: 10 });
  console.log('[ld] LaunchDarkly client initialized');
  return client;
}

function randomContext() {
  const kind = CONTEXT_KINDS[Math.floor(Math.random() * CONTEXT_KINDS.length)];
  const id = Math.floor(Math.random() * 10_000).toString();
  return { kind, key: `${kind}-${id}` };
}

async function main() {
  const ld = await buildLDClient();
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok', service: 'nr-agent-service' }));

  app.get('/checkout', async (request, reply) => {
    const context = randomContext();
    let variation = 'control';
    if (ld) {
      variation = await ld.variation(FLAG_KEY, context, 'control');
    }
    // Simulate work
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
    return { ok: true, flag: FLAG_KEY, variation, context };
  });

  app.get('/search', async (request, reply) => {
    const context = randomContext();
    let variation = 'control';
    if (ld) {
      variation = await ld.variation(FLAG_KEY, context, 'control');
    }
    // 5% error rate to exercise the exception filter path
    if (Math.random() < 0.05) {
      throw new Error('search: simulated downstream failure');
    }
    await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
    return { ok: true, flag: FLAG_KEY, variation, context };
  });

  const shutdown = async () => {
    app.log.info('shutting down');
    await app.close();
    if (ld) await ld.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: '0.0.0.0', port: PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
