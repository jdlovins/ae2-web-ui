// Entry point: apply schema, start the poller, serve the read API.

import { migrate, pool } from './db.mjs';
import { startCollector } from './collector.mjs';
import { startApi } from './api.mjs';

const started = Date.now();

// Retry rather than exit: under an orchestrator the database frequently isn't
// accepting connections yet, and crash-looping to wait for it is noisy and slow.
const MIGRATE_ATTEMPTS = 30;
let migrated = false;
for (let attempt = 1; attempt <= MIGRATE_ATTEMPTS; attempt++) {
  try {
    if (attempt === 1) console.log('[boot] applying schema …');
    await migrate();
    console.log(`[boot] schema ready in ${Date.now() - started}ms`);
    migrated = true;
    break;
  } catch (e) {
    if (attempt === MIGRATE_ATTEMPTS) {
      console.error(`[boot] migration failed after ${attempt} attempts: ${e.message}`);
      break;
    }
    console.warn(`[boot] database not ready (${e.message}); retry ${attempt}/${MIGRATE_ATTEMPTS} in 2s`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
if (!migrated) process.exit(1);

const stopCollector = startCollector();
const server = startApi();

async function shutdown(sig) {
  console.log(`[boot] ${sig}, shutting down`);
  stopCollector();
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
