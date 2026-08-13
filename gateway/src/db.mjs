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

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });

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
 * Items known for a grid, newest quantity first, optionally name-filtered.
 * Powers the item picker, so it returns the latest value for context.
 */
export async function searchItems(gridKey, query, limit = 200) {
  const { rows } = await pool.query(
    `SELECT i.itemid, i.itemname, i.is_fluid, i.last_seen, s.quantity AS last_quantity
       FROM item i
       LEFT JOIN LATERAL (
            SELECT quantity FROM sample WHERE item_id = i.id ORDER BY ts DESC LIMIT 1
       ) s ON TRUE
      WHERE i.grid_key = $1
        AND ($2 = '' OR i.itemname ILIKE '%' || $2 || '%' OR i.itemid ILIKE '%' || $2 || '%')
      ORDER BY s.quantity DESC NULLS LAST
      LIMIT $3`,
    [gridKey, query || '', limit],
  );
  return rows;
}

/**
 * Time series for one or more itemids.
 *
 * Buckets server-side to ~`points` samples so the browser never receives more
 * than it can draw, and reads the hourly continuous aggregate once the bucket
 * is an hour or wider.
 */
export async function series(gridKey, itemids, from, to, points = 400) {
  if (!itemids.length) return [];
  const spanSec = Math.max(1, (to.getTime() - from.getTime()) / 1000);
  const bucketSec = Math.max(1, Math.round(spanSec / Math.max(1, points)));
  const useHourly = bucketSec >= 3600;

  // GROUP BY must repeat the time_bucket() expression rather than reference the
  // `ts` output alias: `sample` has its own `ts` column, and Postgres resolves
  // an ambiguous GROUP BY name to the INPUT column, which would group by the
  // raw timestamp and silently defeat the bucketing (duplicate buckets out).
  const sql = useHourly
    ? `SELECT i.itemid,
              time_bucket($3::interval, h.bucket) AS ts,
              max(h.max_qty)      AS quantity
         FROM sample_hourly h
         JOIN item i ON i.id = h.item_id
        WHERE i.grid_key = $1 AND i.itemid = ANY($2::text[])
          AND h.bucket >= $4 AND h.bucket <= $5
        GROUP BY i.itemid, time_bucket($3::interval, h.bucket)
        ORDER BY i.itemid, 2`
    : `SELECT i.itemid,
              time_bucket($3::interval, s.ts) AS ts,
              max(s.quantity)     AS quantity
         FROM sample s
         JOIN item i ON i.id = s.item_id
        WHERE i.grid_key = $1 AND i.itemid = ANY($2::text[])
          AND s.ts >= $4 AND s.ts <= $5
        GROUP BY i.itemid, time_bucket($3::interval, s.ts)
        ORDER BY i.itemid, 2`;

  const { rows } = await pool.query(sql, [gridKey, itemids, `${bucketSec} seconds`, from, to]);

  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.itemid)) byItem.set(r.itemid, []);
    byItem.get(r.itemid).push({ ts: r.ts, quantity: r.quantity });
  }
  return itemids
    .filter((id) => byItem.has(id))
    .map((id) => ({ itemid: id, points: byItem.get(id) }));
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
