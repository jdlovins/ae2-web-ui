// Configuration, all via environment so nothing secret lands in the repo.

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const num = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${v}`);
  return n;
};

export const config = {
  // Base URL of the mod's HTTP API, e.g. http://10.10.10.100:65500
  modUrl: req('AE2_URL').replace(/\/+$/, ''),
  // Admin password for POST /auth. Use a k8s Secret / .env, never a literal.
  password: req('AE2_PASSWORD'),
  username: process.env.AE2_USERNAME || 'Admin',

  // Either a whole DATABASE_URL, or the standard PG* variables (PGHOST, PGPORT,
  // PGUSER, PGPASSWORD, PGDATABASE), which node-pg reads from the environment on
  // its own. Prefer PG* wherever the password isn't yours to choose: a password
  // containing '@', ':' or '/' is perfectly legal but corrupts a URL, and '@' is
  // the nasty one — the driver parses everything after it as the hostname, so
  // you get a DNS failure rather than an auth error.
  databaseUrl: process.env.DATABASE_URL || null,

  // GetItems is an ISyncedRequest: it walks the whole network ON THE MINECRAFT
  // SERVER TICK. Sampling too often will visibly lag the game. 60s is a safe
  // default; going below ~15s is strongly discouraged on a large network.
  intervalSec: num('SAMPLE_INTERVAL_SEC', 60),

  // Optional comma-separated grid keys. Empty = discover via /grids and track
  // every attached grid.
  grids: (process.env.SAMPLE_GRIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  port: num('PORT', 8081),

  // e.g. "365 days" to drop samples older than that. Unset = keep forever.
  retention: process.env.SAMPLE_RETENTION || null,

  // --- Level maintainer ---
  // Runs at the end of each collector tick, off the snapshot that tick just
  // took, so its cadence IS SAMPLE_INTERVAL_SEC and it costs the game nothing
  // extra until a rule actually needs to order something.
  maintainEnabled: process.env.MAINTAIN_ENABLED !== 'false',
  // Ceiling on maintainer jobs in flight PER GRID — counted from that grid's own
  // CPU list, so one saturated network can never starve another. The backstop
  // against a bad rule eating the whole crafting capacity.
  maintainMaxJobs: num('MAINTAIN_MAX_JOBS', 3),
  // First backoff after a rule fails to plan, doubling per consecutive failure
  // up to the max. Only a returned simulation counts as a failure: planning is
  // the expensive part, so a rule missing ingredients must not retry every tick.
  maintainBackoffSec: num('MAINTAIN_BACKOFF_SEC', 1800),
  maintainBackoffMaxSec: num('MAINTAIN_BACKOFF_MAX_SEC', 28800),
  // How long to wait for a plan before abandoning it. The mod computes plans on
  // a worker thread and a deep recipe tree genuinely takes a while.
  maintainPlanTimeoutSec: num('MAINTAIN_PLAN_TIMEOUT_SEC', 30),
};

// One of the two database configurations must be present. Checked here so a
// misconfiguration fails immediately and says what's missing, rather than
// surfacing later as a confusing connection error.
if (!config.databaseUrl && !process.env.PGHOST) {
  throw new Error('set DATABASE_URL, or the PG* variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE)');
}

export const MIN_SANE_INTERVAL = 15;
