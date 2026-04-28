// services/actionRules.js
// Deterministic rules engine. Generates candidate actions BEFORE the LLM.
// Each rule emits 0..N actions; LLM later picks the best 2-3 and humanizes prose.

const RULES = [
  {
    id: 'critical_sla_breach',
    apply: ({ priorities }) => priorities
      .filter((p) => p.ai_severity === 'critical' && p.sla_status === 'breached')
      .slice(0, 3)
      .map((p) => ({
        id: 'critical_sla_breach',
        priority: 1,
        action: `Personally escalate ${p.complaint_no} (${p.ai_category} in ${p.mandal || 'unknown mandal'}) — critical, ${p.hours_overdue}h past SLA.`,
        evidence: { complaint_no: p.complaint_no, category: p.ai_category, mandal: p.mandal, hours_overdue: p.hours_overdue },
        suggested_owner: `Joint Collector / ${p.dept_name || 'department head'}`,
      })),
  },

  {
    id: 'high_impact_breach',
    apply: ({ priorities }) => priorities
      .filter((p) => p.sla_status === 'breached' && (p.upvote_count || 0) >= 20)
      .slice(0, 2)
      .map((p) => ({
        id: 'high_impact_breach',
        priority: 1,
        action: `Address ${p.complaint_no} (${p.ai_category}, ${p.mandal || 'unknown mandal'}) — ${p.upvote_count} citizens affected, SLA breached ${p.hours_overdue}h ago.`,
        evidence: { complaint_no: p.complaint_no, upvotes: p.upvote_count, hours_overdue: p.hours_overdue },
        suggested_owner: p.dept_name || 'department head',
      })),
  },

  {
    id: 'citizen_emergency_unaddressed',
    apply: ({ priorities }) => priorities
      .filter((p) => p.citizen_priority === 'emergency' && p.sla_status !== 'on_track')
      .slice(0, 2)
      .map((p) => ({
        id: 'citizen_emergency_unaddressed',
        priority: 1,
        action: `Citizen-flagged emergency: ${p.complaint_no} (${p.ai_category}, ${p.mandal || 'unknown mandal'}). SLA ${p.sla_status}. Confirm action within 6 hours.`,
        evidence: { complaint_no: p.complaint_no, sla_status: p.sla_status },
        suggested_owner: p.dept_name || 'department head',
      })),
  },

  {
    id: 'systemic_cluster',
    apply: ({ hotspots }) => hotspots
      .filter((h) => h.complaint_count >= 3)
      .slice(0, 3)
      .map((h) => {
        const where = h.mandal || (h.mandals ? h.mandals.join(', ') : 'cluster area');
        return {
          id: 'systemic_cluster',
          priority: 2,
          action: `Investigate ${h.category} cluster in ${where} — ${h.complaint_count} complaints in 7 days suggests systemic issue, not isolated reports.`,
          evidence: { category: h.category, location: where, count: h.complaint_count },
          suggested_owner: `Department head responsible for ${h.category}`,
        };
      }),
  },

  {
    id: 'velocity_spike',
    apply: ({ trends }) => trends
      .filter((t) => t.pct_change != null && t.pct_change >= 100 && t.this_week >= 5)
      .slice(0, 2)
      .map((t) => ({
        id: 'velocity_spike',
        priority: 2,
        action: `Investigate sudden rise in ${t.category} complaints — up ${t.pct_change}% (${t.last_week} → ${t.this_week}). Check for upstream cause (weather, infrastructure event, policy change).`,
        evidence: { category: t.category, pct_change: t.pct_change, this_week: t.this_week, last_week: t.last_week },
        suggested_owner: 'District-level review',
      })),
  },

  {
    id: 'state_change_alert',
    apply: ({ deltas }) => {
      const newBreaches = (deltas?.new_sla_breaches || []).slice(0, 3);
      if (newBreaches.length === 0) return [];
      return [{
        id: 'state_change_alert',
        priority: 2,
        action: `${newBreaches.length} complaint${newBreaches.length > 1 ? 's' : ''} newly breached SLA since yesterday — review before older items.`,
        evidence: { new_breach_complaint_nos: newBreaches.map((b) => b.complaint_no) },
        suggested_owner: 'Reviewing officer',
      }];
    },
  },

  {
    id: 'new_hotspot',
    apply: ({ deltas }) => (deltas?.new_hotspots || []).slice(0, 2).map((h) => ({
      id: 'new_hotspot',
      priority: 3,
      action: `New emerging hotspot: ${h.category} in ${h.mandal || 'cluster area'} (${h.complaint_count} complaints). Did not exist in yesterday's brief — early intervention possible.`,
      evidence: { category: h.category, location: h.mandal, count: h.complaint_count },
      suggested_owner: 'Department head',
    })),
  },
];

function generateActions({ priorities, trends, hotspots, deltas }) {
  const ctx = { priorities, trends, hotspots, deltas };
  const all = [];
  for (const rule of RULES) {
    try {
      const out = rule.apply(ctx) || [];
      all.push(...out);
    } catch (err) {
      console.error(`[actionRules] Rule ${rule.id} failed:`, err.message);
    }
  }
  all.sort((a, b) => a.priority - b.priority);
  return all.slice(0, 6);
}

module.exports = { generateActions, RULES };
