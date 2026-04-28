// services/analytics.js
// SQL queries that feed the daily brief, against the real `complaints` schema.
// Identifies districts/mandals via FK ID; resolves human-readable names in SELECT.

let _hasGeoPoint = null;
async function hasGeoPoint(pool) {
  if (_hasGeoPoint !== null) return _hasGeoPoint;
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'complaints' AND column_name = 'geo_point'`,
  );
  _hasGeoPoint = rows.length > 0;
  return _hasGeoPoint;
}

/**
 * Resolve district name → id. Cached.
 */
const _districtIdCache = new Map();
async function getDistrictId(pool, districtName) {
  if (_districtIdCache.has(districtName)) return _districtIdCache.get(districtName);
  const { rows } = await pool.query(
    `SELECT id FROM districts WHERE name = $1 LIMIT 1`,
    [districtName],
  );
  const id = rows[0]?.id || null;
  _districtIdCache.set(districtName, id);
  return id;
}

/**
 * Q1: Top priorities (ranked by priority_score).
 */
async function getTopPriorities(pool, districtId, limit = 8) {
  const { rows } = await pool.query(
    `SELECT
        c.id,
        c.complaint_no,
        c.title,
        c.ai_summary,
        c.ai_category,
        c.ai_severity,
        c.priority                           AS citizen_priority,
        dep.code                              AS dept_code,
        dep.name                              AS dept_name,
        m.name                                AS mandal,
        c.upvote_count,
        c.created_at,
        c.sla_deadline,
        c.is_overdue,
        c.priority_score,
        c.status,
        CASE
          WHEN c.sla_deadline IS NULL THEN NULL
          WHEN c.is_overdue THEN 'breached'
          WHEN c.sla_deadline < NOW() + INTERVAL '24 hours' THEN 'at_risk'
          ELSE 'on_track'
        END AS sla_status,
        CASE
          WHEN c.is_overdue
          THEN ROUND(EXTRACT(EPOCH FROM (NOW() - c.sla_deadline)) / 3600)
          ELSE NULL
        END AS hours_overdue
     FROM complaints c
     LEFT JOIN departments dep ON c.ai_department_id = dep.id
     LEFT JOIN mandals     m   ON c.mandal_id        = m.id
     WHERE c.district_id = $1
       AND c.status NOT IN ('resolved','closed','rejected')
       AND c.priority_score IS NOT NULL
     ORDER BY c.priority_score DESC NULLS LAST
     LIMIT $2`,
    [districtId, limit],
  );
  return rows;
}

/**
 * Q2: Category trends — this week vs last week with % change.
 */
async function getCategoryTrends(pool, districtId) {
  const { rows } = await pool.query(
    `WITH this_week AS (
       SELECT ai_category, COUNT(*)::int AS n FROM complaints
       WHERE district_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
         AND ai_category IS NOT NULL
       GROUP BY ai_category
     ),
     last_week AS (
       SELECT ai_category, COUNT(*)::int AS n FROM complaints
       WHERE district_id = $1
         AND created_at >= NOW() - INTERVAL '14 days'
         AND created_at <  NOW() - INTERVAL '7 days'
         AND ai_category IS NOT NULL
       GROUP BY ai_category
     )
     SELECT
       t.ai_category    AS category,
       t.n              AS this_week,
       COALESCE(l.n, 0) AS last_week,
       CASE WHEN COALESCE(l.n, 0) = 0 THEN NULL
            ELSE ROUND(((t.n - l.n)::numeric / l.n) * 100, 1) END AS pct_change
     FROM this_week t
     LEFT JOIN last_week l USING (ai_category)
     ORDER BY t.n DESC LIMIT 8`,
    [districtId],
  );
  return rows;
}

/**
 * Q3a: Mandal-level hotspots (default — no PostGIS).
 */
async function getMandalHotspots(pool, districtId, minCount = 3) {
  const { rows } = await pool.query(
    `SELECT
       c.ai_category   AS category,
       m.name          AS mandal,
       COUNT(*)::int   AS complaint_count,
       MAX(CASE c.ai_severity
             WHEN 'critical' THEN 4 WHEN 'high' THEN 3
             WHEN 'medium'   THEN 2 ELSE 1 END) AS max_severity_rank,
       (ARRAY_AGG(c.ai_summary ORDER BY c.priority_score DESC NULLS LAST))[1:3] AS sample_summaries
     FROM complaints c
     JOIN mandals m ON c.mandal_id = m.id
     WHERE c.district_id = $1
       AND c.created_at >= NOW() - INTERVAL '7 days'
       AND c.ai_category IS NOT NULL
       AND c.status NOT IN ('resolved','closed','rejected')
     GROUP BY c.ai_category, m.name
     HAVING COUNT(*) >= $2
     ORDER BY COUNT(*) DESC
     LIMIT 10`,
    [districtId, minCount],
  );
  return rows.map((r) => ({ ...r, hotspot_key: `${r.category}|${r.mandal}` }));
}

/**
 * Q3b: Geo-clusters (only if PostGIS migration is run).
 */
async function getGeoClusters(pool, districtId, opts = {}) {
  const radiusM = opts.radiusMeters || 2000;
  const minPoints = opts.minPoints || 4;

  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT c.id, c.ai_category, c.ai_severity, c.ai_summary, m.name AS mandal,
              c.geo_point,
              ST_ClusterDBSCAN(c.geo_point::geometry, $2, $3) OVER (PARTITION BY c.ai_category) AS cluster_id
       FROM complaints c
       LEFT JOIN mandals m ON c.mandal_id = m.id
       WHERE c.district_id = $1
         AND c.created_at >= NOW() - INTERVAL '7 days'
         AND c.geo_point IS NOT NULL
         AND c.ai_category IS NOT NULL
         AND c.status NOT IN ('resolved','closed','rejected')
     )
     SELECT
       ai_category   AS category,
       COUNT(*)::int AS complaint_count,
       ARRAY_AGG(DISTINCT mandal) AS mandals,
       ST_Y(ST_Centroid(ST_Collect(geo_point::geometry)))::float AS center_lat,
       ST_X(ST_Centroid(ST_Collect(geo_point::geometry)))::float AS center_lng,
       (ARRAY_AGG(ai_summary ORDER BY id DESC) FILTER (WHERE ai_summary IS NOT NULL))[1:3] AS sample_summaries,
       cluster_id
     FROM recent
     WHERE cluster_id IS NOT NULL
     GROUP BY ai_category, cluster_id
     HAVING COUNT(*) >= $3
     ORDER BY COUNT(*) DESC LIMIT 10`,
    [districtId, radiusM / 111000.0, minPoints],
  );
  return rows.map((r) => ({
    ...r,
    hotspot_key: `${r.category}|geo:${r.center_lat.toFixed(3)},${r.center_lng.toFixed(3)}`,
  }));
}

async function getHotspots(pool, districtId) {
  const useGeo = await hasGeoPoint(pool);
  return useGeo ? getGeoClusters(pool, districtId) : getMandalHotspots(pool, districtId);
}

function trendsToMap(trends) {
  const m = {};
  for (const t of trends) m[t.category] = t.pct_change;
  return m;
}

module.exports = {
  getTopPriorities,
  getCategoryTrends,
  getMandalHotspots,
  getGeoClusters,
  getHotspots,
  trendsToMap,
  hasGeoPoint,
  getDistrictId,
};
