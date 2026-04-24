'use strict';

const { request } = require('undici');

const NR_AGENT_URL = process.env.NR_AGENT_URL || 'http://nr-agent-service:3001';
const OTEL_URL = process.env.OTEL_URL || 'http://otel-service:3002';
const TARGET_RPS = parseFloat(process.env.TARGET_RPS || '10');
const ENDPOINTS = ['/checkout', '/search', '/health'];
const SERVICES = [
  { name: 'nr-agent', base: NR_AGENT_URL },
  { name: 'otel', base: OTEL_URL },
];

const intervalMs = Math.max(10, Math.round(1000 / TARGET_RPS));

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function tick() {
  const svc = pick(SERVICES);
  const path = pick(ENDPOINTS);
  const url = `${svc.base}${path}`;
  const started = Date.now();
  try {
    const { statusCode } = await request(url, { method: 'GET' });
    console.log(`[sim] ${svc.name} ${path} -> ${statusCode} (${Date.now() - started}ms)`);
  } catch (err) {
    console.log(`[sim] ${svc.name} ${path} -> ERR ${err.code || err.message} (${Date.now() - started}ms)`);
  }
}

console.log(`[sim] starting: targets=${SERVICES.map((s) => s.base).join(', ')} rps=${TARGET_RPS}`);
setInterval(() => {
  tick();
}, intervalMs);
