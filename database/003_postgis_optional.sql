-- OPTIONAL — run this only when ready to upgrade from mandal-grouping
-- to true street-level geospatial clusters. The brief generator auto-detects
-- whether geo_point exists and uses it if available.

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS geo_point GEOGRAPHY(POINT, 4326)
  GENERATED ALWAYS AS (
    CASE
      WHEN latitude IS NOT NULL AND longitude IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(longitude::float, latitude::float), 4326)::geography
      ELSE NULL
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_complaints_geo_point ON complaints USING GIST (geo_point);
