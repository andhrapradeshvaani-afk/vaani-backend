// services/briefInput.js
// Builds the curated BriefInput JSON that the LLM consumes.
// Computes deltas vs the previous brief snapshot for "what changed since yesterday".

const {
  getTopPriorities, getCategoryTrends, getHotspots, trendsToMap,
} = require('./analytics');
const { scoreDistrict } = require('./priorityScore');
const { generateActions } = require('./actionRules');

async function getPreviousSnapshot(pool, districtId) {
  const { rows } = await pool.query(
    `SELECT state_snapshot FROM daily_briefs
     WHERE district_id = $1 AND brief_date < CURRENT_DATE
     ORDER BY brief_date DESC LIMIT 1`,
    [districtId],
  );
  return rows[0]?.state_snapshot || null;
}

function computeDeltas(currentSnapshot, previousSnapshot) {
  if (!previousSnapshot) {
    return {
      first_run: true,
      new_sla_breaches: [],
      resolved_since_last: [],
      escalated_severity: [],
      new_hotspots: [],
    };
  }

  const prevBreachIds = new Set(previousSnapshot.sla_breach_ids || []);
  const prevHotspotKeys = new Set(previousSnapshot.hotspot_keys || []);
  const prevSeverityMap = previousSnapshot.severity_map || {};
  const prevComplaintNoMap = previousSnapshot.complaint_no_map || {};

  const new_sla_breaches = (currentSnapshot.sla_breach_ids || [])
    .filter((id) => !prevBreachIds.has(id))
    .map((id) => ({
      id,
      complaint_no: currentSnapshot.complaint_no_map?.[id] || null,
    }));

  const resolved_since_last = [...prevBreachIds]
    .filter((id) => !currentSnapshot.sla_breach_ids?.includes(id))
    .map((id) => ({ id, complaint_no: prevComplaintNoMap[id] || null }));

  const escalated_severity = [];
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  for (const [id, currentSev] of Object.entries(currentSnapshot.severity_map || {})) {
    const prevSev = prevSeverityMap[id];
    if (prevSev && rank[currentSev] > rank[prevSev]) {
      escalated_severity.push({
        id,
        complaint_no: currentSnapshot.complaint_no_map?.[id] || null,
        from: prevSev,
        to: currentSev,
      });
    }
  }

  const new_hotspots = (currentSnapshot.hotspots || []).filter(
    (h) => !prevHotspotKeys.has(h.hotspot_key),
  );

  return { first_run: false, new_sla_breaches, resolved_since_last, escalated_severity, new_hotspots };
}

function buildSnapshot(priorities, hotspots) {
  const breached = priorities.filter((p) => p.sla_status === 'breached');
  return {
    sla_breach_ids: breached.map((p) => p.id),
    complaint_no_map: Object.fromEntries(priorities.map((p) => [p.id, p.complaint_no])),
    hotspot_keys: hotspots.map((h) => h.hotspot_key),
    hotspots: hotspots.map((h) => ({
      hotspot_key: h.hotspot_key,
      category: h.category,
      mandal: h.mandal || (h.mandals ? h.mandals[0] : null),
      complaint_count: h.complaint_count,
    })),
    severity_map: Object.fromEntries(priorities.map((p) => [p.id, p.ai_severity])),
  };
}

function trimPriority(p) {
  return {
    id: p.id,
    complaint_no: p.complaint_no,
    summary: p.ai_summary || p.title,
    category: p.ai_category,
    severity: p.ai_severity,
    citizen_priority: p.citizen_priority,
    department: p.dept_name,
    department_code: p.dept_code,
    mandal: p.mandal,
    upvotes: p.upvote_count,
    sla_status: p.sla_status,
    hours_overdue: p.hours_overdue,
    priority_score: p.priority_score ? Number(p.priority_score) : null,
  };
}

function trimHotspot(h) {
  return {
    category: h.category,
    location: h.mandal || (h.mandals ? h.mandals.join(', ') : 'cluster area'),
    count: h.complaint_count,
    sample_complaints: h.sample_summaries || [],
  };
}

function trimTrend(t) {
  return {
    category: t.category,
    this_week: t.this_week,
    last_week: t.last_week,
    pct_change: t.pct_change,
  };
}

/**
 * Filter trends to only meaningful WoW changes.
 * - Drop categories with last_week < 3 (0→1 or 1→2 is noise, not a trend)
 * - Drop categories with null pct_change (couldn't compute)
 * - Drop categories where |pct_change| < 30 (not noteworthy)
 * Run BEFORE passing to LLM so noisy items never appear in the brief.
 */
function filterMeaningfulTrends(trends) {
  return trends.filter((t) => {
    if (t.last_week < 3) return false;
    if (t.pct_change == null) return false;
    return Math.abs(Number(t.pct_change)) >= 30;
  });
}

/**
 * Main entrypoint.
 * @param {object} pool - pg pool
 * @param {object} district - { id, name } for the district being briefed
 */
async function buildBriefInput(pool, district) {
  // 1. Trends first — needed by priority score.
  const trends = await getCategoryTrends(pool, district.id);
  const trendMap = trendsToMap(trends);

  // 2. Score every active complaint.
  await scoreDistrict(pool, district.id, trendMap);

  // 3. Pull priorities + hotspots in parallel.
  const [priorities, hotspots] = await Promise.all([
    getTopPriorities(pool, district.id, 8),
    getHotspots(pool, district.id),
  ]);

  // 4. Deltas vs yesterday.
  const currentSnapshot = buildSnapshot(priorities, hotspots);
  const previousSnapshot = await getPreviousSnapshot(pool, district.id);
  const deltas = computeDeltas(currentSnapshot, previousSnapshot);

  // 5. Rule-based actions.
  const candidate_actions = generateActions({ priorities, trends, hotspots, deltas });

  // 6. Assemble.
  const meaningfulTrends = filterMeaningfulTrends(trends);
  const briefInput = {
    district: district.name,
    district_id: district.id,
    period: {
      generated_at: new Date().toISOString(),
      window: 'last 7 days; deltas vs previous brief',
    },
    top_priorities: priorities.map(trimPriority),
    weekly_trends: meaningfulTrends.map(trimTrend),
    hotspots: hotspots.map(trimHotspot),
    deltas_since_last_brief: deltas,
    candidate_actions,
    summary_stats: {
      total_priorities: priorities.length,
      sla_breached: priorities.filter((p) => p.sla_status === 'breached').length,
      sla_at_risk: priorities.filter((p) => p.sla_status === 'at_risk').length,
      critical_open: priorities.filter((p) => p.ai_severity === 'critical').length,
      citizen_emergencies: priorities.filter((p) => p.citizen_priority === 'emergency').length,
    },
  };

  return { briefInput, snapshot: currentSnapshot };
}

module.exports = { buildBriefInput, computeDeltas, buildSnapshot };
