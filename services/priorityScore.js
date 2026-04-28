// services/priorityScore.js
// Computes priority_score 0-100 per active complaint.
//
// Formula:
//   score = 0.40 * severity_signal      (max of citizen priority + AI severity)
//         + 0.25 * sla_pressure
//         + 0.20 * citizen_impact       (upvotes, log-scaled)
//         + 0.15 * trend_velocity       (category WoW % change)

// Citizen-set priority enum → weight
const CITIZEN_PRIORITY_WEIGHT = { emergency: 100, urgent: 70, normal: 30 };
// AI-inferred severity → weight
const AI_SEVERITY_WEIGHT = { critical: 100, high: 70, medium: 40, low: 15 };

/**
 * Combine citizen priority and AI severity. Take the higher of the two —
 * citizen explicitly flagging "emergency" can't be downgraded by the LLM,
 * but the LLM can upgrade something the citizen marked "normal".
 */
function severitySignal(citizenPriority, aiSeverity) {
  const c = CITIZEN_PRIORITY_WEIGHT[citizenPriority] ?? 30;
  const a = AI_SEVERITY_WEIGHT[aiSeverity] ?? 30;
  return Math.max(c, a);
}

/**
 * SLA pressure based on time to deadline.
 */
function slaPressure(slaDeadline, isOverdue) {
  if (isOverdue === true) return 100;
  if (!slaDeadline) return 0;
  const hoursToBreach = (new Date(slaDeadline).getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursToBreach < 0) return 100;
  if (hoursToBreach < 6) return 85;
  if (hoursToBreach < 24) return 60;
  if (hoursToBreach < 72) return 30;
  return 0;
}

/**
 * Citizen impact via upvotes. Note: schema auto-escalates priority at 10 upvotes,
 * so this dimension is partially correlated with severity_signal — that's OK,
 * a 50-upvote complaint genuinely should rank higher than a 5-upvote one even
 * after escalation.
 */
function citizenImpact(upvotes) {
  const u = Math.max(0, upvotes || 0);
  if (u === 0) return 10;
  return Math.min(100, Math.round(20 * Math.log10(u + 1) * 10) / 10 + 10);
}

function trendVelocity(wowPctChange) {
  if (wowPctChange == null || wowPctChange <= 0) return 0;
  if (wowPctChange >= 200) return 100;
  if (wowPctChange >= 100) return 80;
  return Math.round(wowPctChange * 0.5);
}

/**
 * Compute score for one complaint.
 * @param {object} c - { priority, ai_severity, sla_deadline, is_overdue, upvote_count }
 * @param {object} ctx - { categoryWoWPct }
 */
function computeScore(c, ctx = {}) {
  const sev = severitySignal(c.priority, c.ai_severity);
  const sla = slaPressure(c.sla_deadline, c.is_overdue);
  const imp = citizenImpact(c.upvote_count);
  const vel = trendVelocity(ctx.categoryWoWPct);

  const score = 0.4 * sev + 0.25 * sla + 0.2 * imp + 0.15 * vel;
  return {
    score: Math.round(score * 10) / 10,
    components: { severity: sev, sla, impact: imp, velocity: vel },
  };
}

/**
 * Score all active complaints in a district. Bulk-update via VALUES list.
 * @param {object} pool - pg pool
 * @param {number} districtId - districts.id (NOT name)
 * @param {object} categoryTrendsMap - { [category]: pct_change }
 */
async function scoreDistrict(pool, districtId, categoryTrendsMap = {}) {
  const { rows } = await pool.query(
    `SELECT id, ai_category, ai_severity, priority, sla_deadline, is_overdue, upvote_count
     FROM complaints
     WHERE district_id = $1
       AND status NOT IN ('resolved','closed','rejected')
       AND ai_extracted_at IS NOT NULL`,
    [districtId],
  );

  if (rows.length === 0) return { scored: 0 };

  const updates = rows.map((c) => {
    const wow = categoryTrendsMap[c.ai_category] ?? null;
    const { score } = computeScore(c, { categoryWoWPct: wow });
    return { id: c.id, score };
  });

  const values = updates.map((u, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::numeric)`).join(',');
  const params = updates.flatMap((u) => [u.id, u.score]);

  await pool.query(
    `UPDATE complaints c SET priority_score = v.score, priority_scored_at = NOW()
     FROM (VALUES ${values}) AS v(id, score)
     WHERE c.id = v.id`,
    params,
  );

  return { scored: updates.length };
}

module.exports = {
  computeScore,
  scoreDistrict,
  severitySignal,
  CITIZEN_PRIORITY_WEIGHT,
  AI_SEVERITY_WEIGHT,
};
