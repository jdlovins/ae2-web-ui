// Entry point: apply schema, start the poller, serve the read API.

import { migrate, pool } from './db.mjs';
import { startCollector } from './collector.mjs';
import { startApi } from './api.mjs';

const started = Date.now();

try {
  console.log('[boot] applying schema …');
  await migrate();
  console.log(`[boot] schema ready in ${Date.now() - started}ms`);
} catch (e) {
  console.error(`[boot] migration failed: ${e.message}`);
  process.exit(1);
}

const timer = startCollector();
const server = startApi();

async function shutdown(sig) {
  console.log(`[boot] ${sig}, shutting down`);
  clearInterval(timer);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
