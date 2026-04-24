'use strict';

// The `newrelic` module must be the first require (done via `node -r newrelic`
// in package.json start script). From there the agent hooks into Node's
// instrumentation and registers the OTel API bridge.

const Fastify = require('fastify');
const { init, TestData, LDLogger } = require('@launchdarkly/node-server-sdk');
const { TracingHook } = require('@launchdarkly/node-server-sdk-otel');

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
    hooks: [new TracingHook()],
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
