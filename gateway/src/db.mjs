// Postgres/TimescaleDB access: schema bootstrap, item identity cache, batch
// sample writes, and the read queries backing the charts.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { config } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// quantity is BIGINT and can exceed 2^53 in theory, but AE2 stack counts stay
// far below it, so parse to Number for clean JSON instead of emitting strings.
pg.types.setTypeParser(20, (v) => Number(v));

// With no connectionString, node-pg falls back to the standard PG* environment
// variables — which is the safer path, since nothing has to survive being
// spliced into a URL. See config.mjs.
export const pool = new pg.Pool(
  config.databaseUrl ? { connectionString: config.databaseUrl, max: 8 } : { max: 8 },
);

export async function migrate() {
  const sql = await readFile(resolve(__dirname, '../schema.sql'), 'utf8');
  await pool.query(sql);
  if (config.retention) {
    await pool.query(
      `SELECT add_retention_policy('sample', $1::interval, if_not_exists => TRUE)`,
      [config.retention],
    );
  }
}

// (grid_key|itemid) -> item.id. Avoids a round-trip per item per tick.
const idCache = new Map();
const cacheKey = (gridKey, itemid) => `${gridKey}|${itemid}`;

/** Resolve item ids for a snapshot, inserting rows for items seen first time. */
async function resolveItemIds(gridKey, items, ts) {
  const unknown = items.filter((it) => !idCache.has(cacheKey(gridKey, it.itemid)));
  if (unknown.length) {
    const { rows } = await pool.query(
      `INSERT INTO item (grid_key, itemid, itemname, is_fluid, first_seen, last_seen)
       SELECT $1::bigint, itemid, itemname, is_fluid, $5::timestamptz, $5::timestamptz
         FROM UNNEST($2::text[], $3::text[], $4::boolean[]) AS t(itemid, itemname, is_fluid)
       ON CONFLICT (grid_key, itemid)
         DO UPDATE SET itemname = EXCLUDED.itemname, last_seen = EXCLUDED.last_seen
       RETURNING id, itemid`,
      [
        gridKey,
        unknown.map((i) => i.itemid),
        unknown.map((i) => i.itemname),
        unknown.map((i) => i.isFluid),
        ts,
      ],
    );
    for (const r of rows) idCache.set(cacheKey(gridKey, r.itemid), r.id);
  }
  return items.map((it) => idCache.get(cacheKey(gridKey, it.itemid)));
}

/** Write one snapshot. Returns rows inserted. */
export async function writeSnapshot(gridKey, items, ts) {
  if (!items.length) return 0;
  const ids = await resolveItemIds(gridKey, items, ts);
  const { rowCount } = await pool.query(
    `INSERT INTO sample (ts, item_id, quantity, craftable)
     SELECT $1::timestamptz, * FROM UNNEST($2::bigint[], $3::bigint[], $4::boolean[])
     ON CONFLICT (item_id, ts) DO NOTHING`,
    [ts, ids, items.map((i) => i.quantity), items.map((i) => i.craftable)],
  );
  // Names drift (localisation, renames); keep the newest without touching history.
  await pool.query(`UPDATE item SET last_seen = $2 WHERE id = ANY($1::bigint[])`, [ids, ts]);
  return rowCount;
}

/** Grids that have at least one sample, for the UI's grid picker. */
export async function listTrackedGrids() {
  const { rows } = await pool.query(
    `SELECT grid_key, count(*)::int AS items, max(last_seen) AS last_seen
       FROM item GROUP BY grid_key ORDER BY grid_key`,
  );
  return rows;
}

/**
 * Items known for a grid, optionally name-filtered. Powers the item picker, so
 * it carries the latest value for context.
 *
 * With `from`, each row also gets its first quantity in that window and the
 * fractional change since — which is what `sort: 'change'` orders by, signed:
 * descending puts the biggest gains on top, ascending the biggest drains.
 *
 * Change mode drops items whose stock is now zero. Every one of them is exactly
 * -100%, so they would fill the whole ascending view and bury the gradual drains
 * that are the actual signal — an item falling from 40k to 900 matters more than
 * one that was down to its last 3.
 *
 * The ordering has to happen outside the projection: Postgres accepts a bare
 * output-column name in ORDER BY but not one wrapped in a function or filtered
 * in WHERE, so neither `abs(change)` nor `WHERE change IS NOT NULL` resolves
 * against the alias.
 */
export async function searchItems(
  gridKey,
  query,
  limit = 200,
  { from = null, sort = 'quantity', dir = 'desc', min = 0 } = {},
) {
  const byChange = sort === 'change';
  // Never interpolate `dir` itself — reduce it to a boolean first.
  const order = byChange
    ? `change ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, last_quantity DESC NULLS LAST`
    : 'last_quantity DESC NULLS LAST';
  // `min` applies in every mode, so the rule stays "hide anything under X"
  // rather than something that silently means different things per sort.
  const conds = [];
  if (byChange) conds.push('last_quantity <> 0');
  conds.push('($5::bigint = 0 OR last_quantity >= $5)');
  const zeroFilter = `WHERE ${conds.join(' AND ')}`;
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT i.itemid, i.itemname, i.is_fluid, i.last_seen,
              s.quantity AS last_quantity,
              f.quantity AS first_quantity,
              CASE WHEN $4::timestamptz IS NOT NULL AND f.quantity > 0 AND s.quantity IS NOT NULL
                   THEN (s.quantity - f.quantity)::float8 / f.quantity
              END AS change
         FROM item i
         LEFT JOIN LATERAL (
              SELECT quantity FROM sample WHERE item_id = i.id ORDER BY ts DESC LIMIT 1
         ) s ON TRUE
         LEFT JOIN LATERAL (
              SELECT quantity FROM sample
               WHERE item_id = i.id AND ($4::timestamptz IS NULL OR ts >= $4)
               ORDER BY ts ASC LIMIT 1
         ) f ON TRUE
        WHERE i.grid_key = $1
          AND ($2 = '' OR i.itemname ILIKE '%' || $2 || '%' OR i.itemid ILIKE '%' || $2 || '%')
     ) t
     ${zeroFilter}
     ORDER BY ${order}
     LIMIT $3`,
    [gridKey, query || '', limit, from, Math.max(0, Number(min) || 0)],
  );
  return rows;
}

/**
 * Time series for one or more itemids.
 *
 * Buckets server-side to ~`points` samples so the browser never receives more
 * than it can draw, and reads the hourly continuous aggregate once the bucket
 * is an hour or wider.
 *
 * Each point carries `quantity` plus `min`/`avg`/`max` for the bucket. Those
 * three come free: `sample_hourly` has materialised them all along and nothing
 * read them. `quantity` stays the bucket MAX, which is what it has always been —
 * the chart's tooltip and the Trends table are written against that meaning, so
 * this is purely additive.
 *
 * Returns `{ series, names }`. `names` is a separate itemid -> itemname lookup
 * rather than a field on each series, because it must resolve for itemids with
 * NO points in range — that is exactly the case a stale bookmark restores.
 */
export async function series(gridKey, itemids, from, to, points = 400) {
  if (!itemids.length) return { series: [], names: {} };
  const spanSec = Math.max(1, (to.getTime() - from.getTime()) / 1000);
  const bucketSec = Math.max(1, Math.round(spanSec / Math.max(1, points)));
  const useHourly = bucketSec >= 3600;

  // GROUP BY must repeat the time_bucket() expression rather than reference the
  // `ts` output alias: `sample` has its own `ts` column, and Postgres resolves
  // an ambiguous GROUP BY name to the INPUT column, which would group by the
  // raw timestamp and silently defeat the bucketing (duplicate buckets out).
  //
  // The ::bigint on avg is load-bearing, not tidiness. db.mjs registers a type
  // parser for OID 20 (BIGINT) only; avg() returns NUMERIC (OID 1700), which
  // node-pg hands back as a STRING. Without the cast this one field would ship
  // as "1234.5000" while every sibling is a number.
  //
  // On the hourly branch the average is a mean of means: exact when an output
  // bucket is one hour, approximate when several hours collapse into one. The
  // exact fix would need count/sum columns in sample_hourly, and that view
  // cannot be changed in place — schema.sql uses CREATE MATERIALIZED VIEW IF NOT
  // EXISTS, which silently keeps the old definition on an existing database, so
  // editing it would change fresh installs only and leave production behind.
  const sql = useHourly
    ? `SELECT i.itemid,
              time_bucket($3::interval, h.bucket) AS ts,
              max(h.max_qty)         AS quantity,
              min(h.min_qty)         AS min_qty,
              max(h.max_qty)         AS max_qty,
              avg(h.avg_qty)::bigint AS avg_qty
         FROM sample_hourly h
         JOIN item i ON i.id = h.item_id
        WHERE i.grid_key = $1 AND i.itemid = ANY($2::text[])
          AND h.bucket >= $4 AND h.bucket <= $5
        GROUP BY i.itemid, time_bucket($3::interval, h.bucket)
        ORDER BY i.itemid, 2`
    : `SELECT i.itemid,
              time_bucket($3::interval, s.ts) AS ts,
              max(s.quantity)         AS quantity,
              min(s.quantity)         AS min_qty,
              max(s.quantity)         AS max_qty,
              avg(s.quantity)::bigint AS avg_qty
         FROM sample s
         JOIN item i ON i.id = s.item_id
        WHERE i.grid_key = $1 AND i.itemid = ANY($2::text[])
          AND s.ts >= $4 AND s.ts <= $5
        GROUP BY i.itemid, time_bucket($3::interval, s.ts)
        ORDER BY i.itemid, 2`;

  const [{ rows }, { rows: nameRows }] = await Promise.all([
    pool.query(sql, [gridKey, itemids, `${bucketSec} seconds`, from, to]),
    pool.query(`SELECT itemid, itemname FROM item WHERE grid_key = $1 AND itemid = ANY($2::text[])`, [
      gridKey,
      itemids,
    ]),
  ]);

  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.itemid)) byItem.set(r.itemid, []);
    byItem.get(r.itemid).push({
      ts: r.ts,
      quantity: r.quantity,
      min: r.min_qty,
      avg: r.avg_qty,
      max: r.max_qty,
    });
  }

  const names = {};
  for (const r of nameRows) names[r.itemid] = r.itemname;

  return {
    series: itemids.filter((id) => byItem.has(id)).map((id) => ({ itemid: id, points: byItem.get(id) })),
    names,
  };
}

/**
 * Everything the item detail panel needs about one item, in one round trip:
 * identity (including `first_seen`, which nothing else reads), the latest
 * sample, and exact min/max/avg over the requested range.
 *
 * Range stats come from the RAW `sample` table even for a 90-day window, not
 * from `sample_hourly`. This is one item_id — the compression segmentby key and
 * the leading column of sample_item_ts_idx — so it stays a narrow index scan,
 * and the numbers the user reads are then exact rather than inheriting the
 * hourly branch's mean-of-means approximation.
 *
 * Returns null when the item has never been recorded on this grid. That is a
 * normal state (a live item the collector has not reached yet), not an error.
 */
export async function itemDetail(gridKey, itemid, from, to) {
  const { rows } = await pool.query(
    `WITH it AS (
       SELECT id, itemid, itemname, is_fluid, first_seen, last_seen
         FROM item WHERE grid_key = $1 AND itemid = $2
     )
     SELECT it.itemid, it.itemname, it.is_fluid, it.first_seen, it.last_seen,
            l.quantity AS last_quantity, l.ts AS last_sample_at,
            r.min_qty, r.max_qty, r.avg_qty, r.samples
       FROM it
       LEFT JOIN LATERAL (
            SELECT quantity, ts FROM sample WHERE item_id = it.id ORDER BY ts DESC LIMIT 1
       ) l ON TRUE
       LEFT JOIN LATERAL (
            SELECT min(quantity)         AS min_qty,
                   max(quantity)         AS max_qty,
                   avg(quantity)::bigint AS avg_qty,
                   count(*)::int         AS samples
              FROM sample WHERE item_id = it.id AND ts >= $3 AND ts <= $4
       ) r ON TRUE`,
    [gridKey, itemid, from, to],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    item: {
      itemid: r.itemid,
      itemname: r.itemname,
      is_fluid: r.is_fluid,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      last_quantity: r.last_quantity,
      last_sample_at: r.last_sample_at,
    },
    range: { min: r.min_qty, max: r.max_qty, avg: r.avg_qty, samples: r.samples ?? 0 },
  };
}

export async function stats() {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM item)                        AS items,
            (SELECT count(*)::bigint FROM sample)                   AS samples,
            (SELECT min(ts) FROM sample)                            AS oldest,
            (SELECT max(ts) FROM sample)                            AS newest,
            pg_size_pretty(hypertable_size('sample'))               AS size`,
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Level maintainer
// ---------------------------------------------------------------------------

// Columns a rule exposes. Listed explicitly rather than SELECT * so adding an
// internal column later can't silently start leaking into the API.
const RULE_COLS = `id, grid_key, itemid, itemname, target, batch,
                   enabled, fail_count, retry_after, last_error, last_ordered_at,
                   created_at, updated_at`;

/** All rules for a grid, or every rule when gridKey is null. */
export async function listRules(gridKey = null) {
  const { rows } = await pool.query(
    `SELECT ${RULE_COLS} FROM maintain_rule
      WHERE ($1::bigint IS NULL OR grid_key = $1)
      ORDER BY enabled DESC, itemname`,
    [gridKey],
  );
  return rows;
}

export async function getRule(id) {
  const { rows } = await pool.query(`SELECT ${RULE_COLS} FROM maintain_rule WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createRule({ gridKey, itemid, itemname, target, batch }) {
  const { rows } = await pool.query(
    `INSERT INTO maintain_rule (grid_key, itemid, itemname, target, batch)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (grid_key, itemid) DO UPDATE
        SET itemname = EXCLUDED.itemname, target = EXCLUDED.target,
            batch = EXCLUDED.batch, updated_at = now()
     RETURNING ${RULE_COLS}`,
    [gridKey, itemid, itemname, target, batch],
  );
  return rows[0];
}

/**
 * Patch a rule. Undefined fields are left alone.
 *
 * Editing the thresholds or re-enabling a rule also clears the backoff: the
 * user has just told us something changed, and making them wait out a 4-hour
 * timer they can't see would read as the feature being broken.
 */
export async function updateRule(id, patch) {
  const { rows } = await pool.query(
    `UPDATE maintain_rule
        SET target      = COALESCE($2::bigint, target),
            batch       = COALESCE($3::bigint, batch),
            enabled     = COALESCE($4::boolean, enabled),
            fail_count  = 0,
            retry_after = NULL,
            last_error  = NULL,
            updated_at  = now()
      WHERE id = $1
      RETURNING ${RULE_COLS}`,
    [id, patch.target ?? null, patch.batch ?? null, patch.enabled ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteRule(id) {
  const { rowCount } = await pool.query(`DELETE FROM maintain_rule WHERE id = $1`, [id]);
  return rowCount > 0;
}

/** Record a failed attempt and push the next try out by `backoffMs`. */
export async function recordFailure(id, error, backoffMs) {
  await pool.query(
    `UPDATE maintain_rule
        SET fail_count  = fail_count + 1,
            retry_after = now() + ($2::bigint || ' milliseconds')::interval,
            last_error  = $3
      WHERE id = $1`,
    [id, Math.round(backoffMs), String(error).slice(0, 500)],
  );
}

/** A successful submission clears the backoff and stamps the order time. */
export async function noteOrdered(id) {
  await pool.query(
    `UPDATE maintain_rule
        SET fail_count = 0, retry_after = NULL, last_error = NULL, last_ordered_at = now()
      WHERE id = $1`,
    [id],
  );
}

export async function logEvent(ruleId, kind, { quantity = null, cpu = null, detail = null } = {}) {
  await pool.query(
    `INSERT INTO maintain_event (rule_id, kind, quantity, cpu, detail) VALUES ($1, $2, $3, $4, $5)`,
    [ruleId, kind, quantity, cpu, detail ? String(detail).slice(0, 500) : null],
  );
  // Trim by row count, not age, so a rule that fires twice a month still shows
  // its last few events rather than an empty log.
  await pool.query(
    `DELETE FROM maintain_event
      WHERE rule_id = $1
        AND id NOT IN (SELECT id FROM maintain_event WHERE rule_id = $1 ORDER BY ts DESC LIMIT 50)`,
    [ruleId],
  );
}

export async function listEvents(ruleId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, ts, kind, quantity, cpu, detail FROM maintain_event
      WHERE rule_id = $1 ORDER BY ts DESC LIMIT $2`,
    [ruleId, limit],
  );
  return rows;
}
