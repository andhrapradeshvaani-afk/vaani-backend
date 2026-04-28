-- Stores generated briefs + state snapshot for "what changed since yesterday" deltas.

CREATE TABLE IF NOT EXISTS daily_briefs (
  id              BIGSERIAL PRIMARY KEY,
  district_id     INTEGER NOT NULL REFERENCES districts(id),
  brief_date      DATE NOT NULL,
  brief_md        TEXT NOT NULL,
  brief_input     JSONB,
  state_snapshot  JSONB,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (district_id, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_briefs_district_date
  ON daily_briefs (district_id, brief_date DESC);
