// services/dailyBrief.js
// LLM consumes the curated BriefInput and produces markdown for the CM dashboard.

const OpenAI = require('openai');
const { buildBriefInput } = require('./briefInput');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BRIEF_SYSTEM_PROMPT = `You are a chief-of-staff briefing an Andhra Pradesh district collector.
Write the morning grievance brief in markdown. Concise, factual, decision-grade.
The reader is an IAS officer who reads this in 90 seconds before the 9am review.

You will receive a STRUCTURED BriefInput JSON. Your job is to humanize it — NOT to invent
priorities, scores, or actions. The data has already been ranked, deltas computed, and
actions drafted by a rules engine. Pick the most important items and write the brief.

Format — use these EXACT sections in order. Skip a section ONLY if it has zero relevant items.

### 🔴 Top priorities today
List 3-5 items from top_priorities (highest priority_score first). Each bullet:
- One line: "[severity emoji] **[Severity]** in **[mandal]** — [one-line summary]. (#AP-2026-XXX-NNNNN)"
- Sub-line in italics: "[upvote count] citizen(s) · SLA [status with hours] · score [priority_score]"

CRITICAL formatting rules:
- The severity badge MUST be one of these four words EXACTLY, matching the 'severity' field (NOT citizen_priority): **Critical**, **High**, **Medium**, **Low**
- Use 🔴 for Critical, 🟠 for High, 🟡 for Medium, ⚪ for Low
- Complaint numbers go in plain parens with NO square brackets: write "(#AP-2026-SKL-00011)" — NEVER "(#[AP-2026-SKL-00011])"
- If citizen_priority is "emergency", append " · 🚨 citizen flagged emergency" to the sub-line
- If mandal is null, write "**unknown mandal**" in bold

### 📊 What changed since yesterday
Use deltas_since_last_brief. Format as 2-4 short bullets. Examples:
- "3 new SLA breaches: AP-2026-SKL-00001 (Pothole), AP-2026-SKL-00011 (Live wire hazard)"
- "2 complaints resolved that were breaching SLA yesterday"
- "1 complaint escalated medium → high: #AP-2026-SKL-00003 (Streetlight outage, Sarubujjili)"
If deltas.first_run is true, write: "First brief — no prior state to compare."

### 📈 Weekly trends
List categories from weekly_trends with notable WoW changes.
Filtering rules — apply BOTH:
  1. Only include categories where last_week >= 3 (skip categories that were 0 or 1 last week — those go from 0→1 trivially)
  2. Of those, only include categories where pct_change >= 30 OR pct_change <= -30
Format: "**[category]**: [this_week] this week vs [last_week] last week ([+/-pct]%)"
If NO category passes both filters, SKIP the entire section (do not output the heading).

### 🗺️ Geographic hotspots
List 2-3 hotspots. Format: "**[count] [category] complaints** clustered in [location]"
Add ONE line of interpretation: e.g. "suggests systemic issue, not isolated reports."
Skip section if hotspots array is empty.

### 💡 Recommended actions
Pick 2-3 most important from candidate_actions. Use them VERBATIM in spirit
but you may polish the wording. Do NOT invent new actions. Numbered list.
End each: "— Owner: [suggested_owner]".

Hard rules:
- Use ONLY data from the BriefInput. Never invent complaint numbers, counts, or place names.
- The 'severity' field is what determines the badge — NOT the citizen_priority field.
- If candidate_actions is empty, write "No urgent actions flagged by rules engine." and stop.
- No filler, no "I hope this helps", no "as an AI", no preamble.
- Keep total length under 350 words.`;

function buildUserMessage(briefInput) {
  return `BriefInput JSON for district "${briefInput.district}":

\`\`\`json
${JSON.stringify(briefInput, null, 2)}
\`\`\`

Write the morning brief now.`;
}

/**
 * @param {object} pool - pg pool
 * @param {object} district - { id, name } — pass both. Use getAllDistricts() to fetch.
 */
async function generateBriefForDistrict(pool, district) {
  const { briefInput, snapshot } = await buildBriefInput(pool, district);

  const totallyEmpty =
    briefInput.top_priorities.length === 0 &&
    briefInput.weekly_trends.length === 0 &&
    briefInput.hotspots.length === 0;

  if (totallyEmpty) {
    return {
      district,
      generated_at: briefInput.period.generated_at,
      brief_md: `### ${district.name} — Daily Brief\n\nNo significant complaint activity today.`,
      brief_input: briefInput,
      snapshot,
    };
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 900,
    messages: [
      { role: 'system', content: BRIEF_SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(briefInput) },
    ],
  });

  return {
    district,
    generated_at: briefInput.period.generated_at,
    brief_md: completion.choices[0].message.content.trim(),
    brief_input: briefInput,
    snapshot,
  };
}

/**
 * Generate briefs for every district that has any complaint activity.
 */
async function generateAllBriefs(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT d.id, d.name
     FROM districts d
     JOIN complaints c ON c.district_id = d.id
     ORDER BY d.name`,
  );

  const results = [];
  for (const district of rows) {
    try {
      const brief = await generateBriefForDistrict(pool, district);
      await pool.query(
        `INSERT INTO daily_briefs (district_id, brief_date, brief_md, brief_input, state_snapshot, generated_at)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, NOW())
         ON CONFLICT (district_id, brief_date) DO UPDATE
           SET brief_md = EXCLUDED.brief_md,
               brief_input = EXCLUDED.brief_input,
               state_snapshot = EXCLUDED.state_snapshot,
               generated_at = NOW()`,
        [district.id, brief.brief_md, JSON.stringify(brief.brief_input), JSON.stringify(brief.snapshot)],
      );
      results.push({ district: district.name, status: 'ok' });
    } catch (err) {
      console.error(`[dailyBrief] Failed for ${district.name}:`, err.message);
      results.push({ district: district.name, status: 'error', error: err.message });
    }
  }
  return results;
}

module.exports = { generateBriefForDistrict, generateAllBriefs };
