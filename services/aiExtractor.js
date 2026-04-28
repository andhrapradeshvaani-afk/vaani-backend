// services/aiExtractor.js
// Step 1: Per-complaint structured extraction.
// LLM picks from real department codes. We resolve to FK ai_department_id.

const OpenAI = require('openai');
const { normalize: normalizeCategory } = require('./categoryNormalizer');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-process cache for departments lookup.
let _deptCache = null;
async function getDepartments(pool) {
  if (_deptCache) return _deptCache;
  const { rows } = await pool.query(
    `SELECT id, code, name FROM departments WHERE is_active = TRUE ORDER BY id`,
  );
  _deptCache = {
    list: rows,                                // [{id, code, name}, ...]
    byCode: Object.fromEntries(rows.map((r) => [r.code, r])),
    promptString: rows.map((r) => `${r.code} = ${r.name}`).join('; '),
  };
  return _deptCache;
}

const SYSTEM_PROMPT = (deptString) => `You are a civic complaint triage assistant for the Government of Andhra Pradesh.
Citizens write complaints in English, Telugu, or code-mixed Telugu-English. Extract structured fields.

Rules:
- summary: ONE neutral English sentence (max 25 words). State the issue and location if mentioned.

- category: a 1-3 word noun phrase that names the SPECIFIC PROBLEM TYPE described.
  CRITICAL — be precise about WHAT is wrong, not WHO fixes it:
    • "exposed live wires" / "live wire hazard" — NOT "Power cut" (a hazard, not an outage)
    • "Power outage" — only when electricity is genuinely off
    • "No water supply" — when supply has stopped (NOT "Water leakage" which is a leak)
    • "Water leakage" — only when water is leaking from a pipe
    • "Water contamination" — when water is dirty/unsafe (NOT generic "Public health")
    • "Pothole" — for road surface damage
    • "Streetlight outage" — for non-working streetlights
    • "Garbage pile-up" — for uncollected garbage
  When in doubt, use the most literal description of the physical problem.
  Use a CONSISTENT phrase across similar complaints (e.g. always "Pothole", never sometimes "Road damage").
  AVOID generic catch-alls like "Public health", "Infrastructure", "Civic issue" — be specific.

- severity:
    critical = imminent risk to life/safety (live wires, open manhole, contaminated drinking water, fire hazard)
    high     = major disruption affecting many (no water for days, road impassable, hospital outage)
    medium   = standard issue affecting daily life (pothole, broken streetlight, garbage pile)
    low      = minor inconvenience or cosmetic

- department_code: SINGLE most relevant department CODE from this list (return only the code, e.g. "ROADS"):
    ${deptString}
  Return "OTHER" if genuinely unclear.

Respond ONLY with valid JSON. No markdown, no commentary.`;

async function extractComplaint(pool, complaint) {
  const depts = await getDepartments(pool);

  const user = `Complaint:
Title: ${complaint.title || '(none)'}
Description: ${complaint.description || ''}
District: ${complaint.district_name || 'unknown'}
Mandal: ${complaint.mandal_name || 'unknown'}
Citizen-set priority: ${complaint.priority || 'normal'}

Return JSON:
{"summary": "...", "category": "...", "severity": "...", "department_code": "..."}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 250,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT(depts.promptString) },
      { role: 'user', content: user },
    ],
  });

  const p = JSON.parse(completion.choices[0].message.content);

  // Validate department code against real list, fall back to OTHER.
  const deptCode = depts.byCode[p.department_code] ? p.department_code : 'OTHER';
  const dept = depts.byCode[deptCode] || depts.byCode['OTHER'];

  return {
    summary: (p.summary || '').slice(0, 500),
    category: normalizeCategory((p.category || 'Uncategorized').slice(0, 100)),
    severity: ['low', 'medium', 'high', 'critical'].includes(p.severity) ? p.severity : 'medium',
    department_id: dept ? dept.id : null,
    department_code: dept ? dept.code : 'OTHER',
    department_name: dept ? dept.name : 'Other',
  };
}

/**
 * Extract one complaint and persist to DB.
 * Joins districts/mandals so the LLM gets human-readable place names.
 */
async function extractAndStore(pool, complaintId) {
  const { rows } = await pool.query(
    `SELECT
       c.id, c.title, c.description, c.priority,
       d.name AS district_name, m.name AS mandal_name
     FROM complaints c
     LEFT JOIN districts d ON c.district_id = d.id
     LEFT JOIN mandals  m ON c.mandal_id   = m.id
     WHERE c.id = $1`,
    [complaintId],
  );
  if (rows.length === 0) throw new Error(`Complaint ${complaintId} not found`);

  try {
    const ai = await extractComplaint(pool, rows[0]);
    await pool.query(
      `UPDATE complaints
       SET ai_summary=$1, ai_category=$2, ai_severity=$3,
           ai_department_id=$4, ai_extracted_at=NOW()
       WHERE id=$5`,
      [ai.summary, ai.category, ai.severity, ai.department_id, complaintId],
    );
    return ai;
  } catch (err) {
    console.error(`[aiExtractor] Failed for complaint ${complaintId}:`, err.message);
    return null;
  }
}

/**
 * Backfill: extract for all complaints missing AI fields.
 */
async function backfill(pool, batchSize = 20) {
  const { rows } = await pool.query(
    `SELECT id FROM complaints WHERE ai_extracted_at IS NULL ORDER BY created_at DESC`,
  );
  console.log(`[backfill] Processing ${rows.length} complaints...`);
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await Promise.all(chunk.map((r) => extractAndStore(pool, r.id)));
    done += chunk.length;
    console.log(`[backfill] ${done}/${rows.length}`);
  }
  return { processed: done };
}

module.exports = { extractComplaint, extractAndStore, backfill, getDepartments };
