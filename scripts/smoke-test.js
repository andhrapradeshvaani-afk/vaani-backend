// scripts/smoke-test.js
// Verifies priority scoring and rules engine produce sensible output
// with the schema-aligned data shapes.
// Run from project root: node scripts/smoke-test.js

const { computeScore, severitySignal } = require('../services/priorityScore');
const { generateActions } = require('../services/actionRules');
const { computeDeltas, buildSnapshot } = require('../services/briefInput');

console.log('=== Severity Signal (citizen + AI combined) ===\n');
console.log('citizen=emergency, ai=medium → ', severitySignal('emergency', 'medium'), '(should be 100, citizen wins)');
console.log('citizen=normal, ai=critical  → ', severitySignal('normal', 'critical'),  '(should be 100, AI wins)');
console.log('citizen=urgent, ai=low       → ', severitySignal('urgent', 'low'),       '(should be 70, citizen wins)');
console.log('citizen=normal, ai=medium    → ', severitySignal('normal', 'medium'),    '(should be 40, AI wins)');

console.log('\n=== Priority Score Sanity Checks ===\n');

const cases = [
  {
    label: 'Critical+overdue+50 upvotes+hot category',
    c: { ai_severity: 'critical', priority: 'normal', sla_deadline: new Date(Date.now() - 3600000), is_overdue: true, upvote_count: 50 },
    ctx: { categoryWoWPct: 150 },
  },
  {
    label: 'Citizen-flagged emergency, AI=medium, 0 upvotes, on-track',
    c: { ai_severity: 'medium', priority: 'emergency', sla_deadline: new Date(Date.now() + 5 * 24 * 3600000), is_overdue: false, upvote_count: 0 },
    ctx: { categoryWoWPct: null },
  },
  {
    label: 'Routine pothole, normal priority, 4 upvotes, breach in 4h',
    c: { ai_severity: 'medium', priority: 'normal', sla_deadline: new Date(Date.now() + 4 * 3600000), is_overdue: false, upvote_count: 4 },
    ctx: { categoryWoWPct: 80 },
  },
  {
    label: 'Low severity, plenty of time, no upvotes',
    c: { ai_severity: 'low', priority: 'normal', sla_deadline: new Date(Date.now() + 5 * 24 * 3600000), is_overdue: false, upvote_count: 0 },
    ctx: { categoryWoWPct: 0 },
  },
];

for (const tc of cases) {
  const { score, components } = computeScore(tc.c, tc.ctx);
  console.log(`${tc.label}\n  → score: ${score}  components:`, components, '\n');
}

console.log('\n=== Rules Engine Sanity Check ===\n');

const mockData = {
  priorities: [
    {
      id: 'uuid-101', complaint_no: 'AP-2025-VZM-00421',
      ai_severity: 'critical', citizen_priority: 'urgent', sla_status: 'breached', hours_overdue: 18,
      ai_category: 'Open manhole', mandal: 'Vijayawada Urban', upvote_count: 47,
      dept_code: 'MUNI', dept_name: 'Municipal Services',
    },
    {
      id: 'uuid-102', complaint_no: 'AP-2025-GNT-00892',
      ai_severity: 'high', citizen_priority: 'emergency', sla_status: 'at_risk', hours_overdue: null,
      ai_category: 'Water leakage', mandal: 'Guntur', upvote_count: 35,
      dept_code: 'WATER', dept_name: 'Water Supply & Sanitation',
    },
    {
      id: 'uuid-103', complaint_no: 'AP-2025-CTR-00111',
      ai_severity: 'medium', citizen_priority: 'normal', sla_status: 'on_track', hours_overdue: null,
      ai_category: 'Pothole', mandal: 'Kakinada', upvote_count: 4,
      dept_code: 'ROADS', dept_name: 'Roads & Infrastructure',
    },
  ],
  trends: [
    { category: 'Pothole', this_week: 89, last_week: 21, pct_change: 323.8 },
    { category: 'Streetlight outage', this_week: 18, last_week: 8, pct_change: 125 },
  ],
  hotspots: [
    { category: 'Pothole', mandal: 'Vijayawada Urban', complaint_count: 12, sample_summaries: ['Large pothole near KBN College'] },
    { category: 'Water leakage', mandal: 'Guntur', complaint_count: 5, sample_summaries: ['Pipe burst in Brodipet'] },
  ],
  deltas: {
    first_run: false,
    new_sla_breaches: [{ id: 'uuid-101', complaint_no: 'AP-2025-VZM-00421' }],
    resolved_since_last: [],
    escalated_severity: [{ id: 'uuid-103', complaint_no: 'AP-2025-CTR-00111', from: 'low', to: 'medium' }],
    new_hotspots: [{ category: 'Streetlight outage', mandal: 'Tirupati', complaint_count: 6 }],
  },
};

const actions = generateActions(mockData);
console.log(`Generated ${actions.length} actions:`);
for (const a of actions) {
  console.log(`  [P${a.priority}] ${a.id}: ${a.action}`);
  console.log(`         Owner: ${a.suggested_owner}\n`);
}

console.log('=== Delta Computation ===\n');
const yesterday = {
  sla_breach_ids: ['uuid-old-88', 'uuid-old-92'],
  complaint_no_map: { 'uuid-old-88': 'AP-2025-VZM-00100', 'uuid-old-92': 'AP-2025-VZM-00150' },
  hotspot_keys: ['Pothole|Vijayawada Urban', 'Garbage|Tirupati'],
  severity_map: { 'uuid-103': 'low' },
};

const today = buildSnapshot(mockData.priorities, mockData.hotspots);
console.log('Current snapshot keys:', Object.keys(today));
console.log('  sla_breach_ids:', today.sla_breach_ids);
console.log('  hotspot_keys:', today.hotspot_keys);

const deltas = computeDeltas(today, yesterday);
console.log('\nDeltas:');
console.log(JSON.stringify(deltas, null, 2));

console.log('\n✅ All smoke tests passed.');
