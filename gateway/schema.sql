-- Inventory time-series schema (TimescaleDB).
-- Applied on every collector start; must stay idempotent.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- One row per (grid, itemid) ever seen. Keeping identity out of the sample
-- table keeps the hot table narrow and lets item names change over time
-- (localisation, renames) without rewriting history.
--
-- Note we key on itemid, not the API's `hashcode`: hashcode comes from
-- ItemStack.hashCode() and is not stable across server restarts, so it's
-- useless as a durable key. Items whose itemid collides (same id, different
-- NBT — ~170 of 4.7k on a real network) are summed into one series.
CREATE TABLE IF NOT EXISTS item (
    id         BIGSERIAL   PRIMARY KEY,
    grid_key   BIGINT      NOT NULL,
    itemid     TEXT        NOT NULL,
    itemname   TEXT        NOT NULL,
    is_fluid   BOOLEAN     NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (grid_key, itemid)
);

CREATE INDEX IF NOT EXISTS item_grid_idx ON item (grid_key);

CREATE TABLE IF NOT EXISTS sample (
    ts        TIMESTAMPTZ NOT NULL,
    item_id   BIGINT      NOT NULL REFERENCES item (id) ON DELETE CASCADE,
    quantity  BIGINT      NOT NULL,
    craftable BOOLEAN     NOT NULL DEFAULT FALSE
);

SELECT create_hypertable('sample', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day');

-- Unique so a retried/overlapping collection tick can't double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS sample_item_ts_idx ON sample (item_id, ts DESC);

-- Compression: item_id segments compress extremely well because quantities for
-- one item change slowly. Applied to chunks older than 7 days.
DO $$
BEGIN
    BEGIN
        ALTER TABLE sample SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'item_id',
            timescaledb.compress_orderby = 'ts DESC'
        );
    EXCEPTION WHEN others THEN
        NULL; -- already configured
    END;
END $$;

SELECT add_compression_policy('sample', INTERVAL '7 days', if_not_exists => TRUE);

-- Hourly rollup, used automatically for long chart ranges so a 30-day query
-- reads ~720 rows per item instead of ~43k.
CREATE MATERIALIZED VIEW IF NOT EXISTS sample_hourly
    WITH (timescaledb.continuous) AS
SELECT item_id,
       time_bucket(INTERVAL '1 hour', ts) AS bucket,
       min(quantity)                      AS min_qty,
       max(quantity)                      AS max_qty,
       avg(quantity)::BIGINT              AS avg_qty,
       last(quantity, ts)                 AS last_qty
FROM sample
GROUP BY item_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sample_hourly',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE);

-- Real-time aggregation: transparently UNION materialised buckets with raw
-- samples that the policy hasn't rolled up yet. Without this the view returns
-- NOTHING until the first refresh runs, so a long chart range would look empty
-- while the raw data was sitting right there.
ALTER MATERIALIZED VIEW sample_hourly SET (timescaledb.materialized_only = FALSE);

-- Retention is opt-in: set METRICS_RETENTION (e.g. '365 days') to enable it.
-- Left off by default so nobody silently loses history.

-- ---------------------------------------------------------------------------
-- Level maintainer
-- ---------------------------------------------------------------------------

-- One rule per (grid, item): keep at least `target`, and when stock falls below
-- it, order exactly `batch`.
--
-- Keyed on itemid, like `item` above, and for the same reason: the API's
-- `hashcode` is ItemStack.hashCode() and does not survive a server restart, so
-- it can only ever be resolved fresh at order time. Nothing durable may store it.
--
-- A fixed batch rather than "top up to target" is deliberate. AE2 rounds any
-- request up to whole pattern outputs, so asking for an exact shortfall buys
-- precision the crafting system cannot honour anyway.
--
-- A rule occupies at most ONE CPU at a time, enforced by the maintainer skipping
-- any rule whose item is already being crafted anywhere on the grid. There is no
-- per-rule concurrency setting on purpose: parallel crafts of one item are a
-- throughput tool for high-churn items, and allowing them would cost the very
-- protection that stops a slow or stuck job piling up duplicate orders.
CREATE TABLE IF NOT EXISTS maintain_rule (
    id             BIGSERIAL   PRIMARY KEY,
    grid_key       BIGINT      NOT NULL,
    itemid         TEXT        NOT NULL,
    itemname       TEXT        NOT NULL,
    target         BIGINT      NOT NULL CHECK (target > 0),
    batch          BIGINT      NOT NULL CHECK (batch > 0),
    enabled        BOOLEAN     NOT NULL DEFAULT TRUE,

    -- Backoff state lives on the row, not in memory, so that a container which
    -- restarts (or crash-loops) resumes the backoff instead of immediately
    -- re-ordering. In memory this would turn a bad rule into an order storm.
    fail_count     INT         NOT NULL DEFAULT 0,
    retry_after    TIMESTAMPTZ,
    last_error     TEXT,
    last_ordered_at TIMESTAMPTZ,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (grid_key, itemid)
);

-- CREATE TABLE IF NOT EXISTS won't alter a table that already exists, so any
-- database created before max_concurrent was dropped keeps the column. Removing
-- it here rather than leaving it stranded and NOT NULL.
ALTER TABLE maintain_rule DROP COLUMN IF EXISTS max_concurrent;

CREATE INDEX IF NOT EXISTS maintain_rule_grid_idx ON maintain_rule (grid_key);

-- Activity log, shown per rule in the UI. Plain table, not a hypertable: this
-- gets a handful of rows a day, and it is pruned by row count rather than age
-- so a quiet rule keeps its last few events however old they are.
CREATE TABLE IF NOT EXISTS maintain_event (
    id       BIGSERIAL   PRIMARY KEY,
    rule_id  BIGINT      NOT NULL REFERENCES maintain_rule (id) ON DELETE CASCADE,
    ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind     TEXT        NOT NULL,
    quantity BIGINT,
    cpu      TEXT,
    detail   TEXT
);

CREATE INDEX IF NOT EXISTS maintain_event_rule_idx ON maintain_event (rule_id, ts DESC);
