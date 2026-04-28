// routes/ai.js
// Public AI brief routes.
// - Reading cached briefs: open to anyone, no auth.
// - Regenerating (?refresh=1): requires X-Brief-Passcode header matching env var BRIEF_REFRESH_PASSCODE.
// - Backfill / generate-all crons: still protected by CRON_SECRET.
//
// Mount with: app.use('/api/ai', require('./routes/ai')(pool));

const express = require('express');
const { extractAndStore, backfill } = require('../services/aiExtractor');
const { generateBriefForDistrict, generateAllBriefs } = require('../services/dailyBrief');
const { buildBriefInput } = require('../services/briefInput');

/**
 * Resolve a district identifier (name OR code OR id) to {id, name}.
 */
async function resolveDistrict(pool, identifier) {
  if (/^\d+$/.test(identifier)) {
    const { rows } = await pool.query(
      `SELECT id, name FROM districts WHERE id = $1 LIMIT 1`,
      [parseInt(identifier, 10)],
    );
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT id, name FROM districts WHERE name = $1 OR code = $1 LIMIT 1`,
    [identifier],
  );
  return rows[0] || null;
}

/**
 * Verify the passcode header. Returns true if valid, false otherwise.
 */
function verifyBriefPasscode(req) {
  const expected = process.env.BRIEF_REFRESH_PASSCODE;
  if (!expected) return false;
  const provided = req.headers['x-brief-passcode'];
  return typeof provided === 'string' && provided === expected;
}

const PASSCODE_ERROR = {
  error: 'Incorrect code, approach the founder - Rajesh.',
};

module.exports = (pool) => {
  const router = express.Router();

  // Per-complaint extraction (called fire-and-forget from submit handler).
  router.post('/extract/:complaintId', async (req, res) => {
    try {
      const result = await extractAndStore(pool, req.params.complaintId);
      res.json({ ok: true, ai: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Districts list — public, for the dropdown.
  router.get('/districts', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT d.id, d.name, d.code,
                COUNT(c.id)::int AS complaint_count,
                MAX(b.brief_date) AS last_brief_date
         FROM districts d
         LEFT JOIN complaints c ON c.district_id = d.id
         LEFT JOIN daily_briefs b ON b.district_id = d.id
         GROUP BY d.id, d.name, d.code
         ORDER BY COUNT(c.id) DESC, d.name`,
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // BriefInput debug (no LLM cost) — public for transparency.
  router.get('/brief-input/:district', async (req, res) => {
    try {
      const district = await resolveDistrict(pool, req.params.district);
      if (!district) return res.status(404).json({ error: 'District not found' });
      const { briefInput } = await buildBriefInput(pool, district);
      res.json(briefInput);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Brief — public read, passcode-gated regenerate.
  router.get('/brief/:district', async (req, res) => {
    try {
      const district = await resolveDistrict(pool, req.params.district);
      if (!district) return res.status(404).json({ error: 'District not found' });

      const wantsRefresh = req.query.refresh === '1';

      if (wantsRefresh && !verifyBriefPasscode(req)) {
        return res.status(401).json(PASSCODE_ERROR);
      }

      if (!wantsRefresh) {
        const cached = await pool.query(
          `SELECT brief_md, generated_at, brief_date
           FROM daily_briefs
           WHERE district_id = $1
           ORDER BY brief_date DESC
           LIMIT 1`,
          [district.id],
        );
        if (cached.rows.length > 0) {
          return res.json({
            cached: true,
            district: district.name,
            brief_md: cached.rows[0].brief_md,
            generated_at: cached.rows[0].generated_at,
            brief_date: cached.rows[0].brief_date,
          });
        }
        return res.status(404).json({
          error: 'No brief generated yet for this district. Use refresh to create one.',
          needs_first_generation: true,
          district: district.name,
        });
      }

      // wantsRefresh + valid passcode → LLM call.
      const brief = await generateBriefForDistrict(pool, district);
      await pool.query(
        `INSERT INTO daily_briefs (district_id, brief_date, brief_md, brief_input, state_snapshot)
         VALUES ($1, CURRENT_DATE, $2, $3, $4)
         ON CONFLICT (district_id, brief_date) DO UPDATE
           SET brief_md = EXCLUDED.brief_md,
               brief_input = EXCLUDED.brief_input,
               state_snapshot = EXCLUDED.state_snapshot,
               generated_at = NOW()`,
        [
          district.id,
          brief.brief_md,
          JSON.stringify(brief.brief_input),
          JSON.stringify(brief.snapshot),
        ],
      );
      res.json({
        cached: false,
        district: district.name,
        brief_md: brief.brief_md,
        generated_at: brief.generated_at,
        brief_date: new Date().toISOString().slice(0, 10),
      });
    } catch (err) {
      console.error('[ai/brief] error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Cron endpoints (CRON_SECRET-protected).
  router.post('/cron/generate-all', async (req, res) => {
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const results = await generateAllBriefs(pool);
    res.json({ results });
  });

  router.post('/cron/backfill', async (req, res) => {
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const result = await backfill(pool);
    res.json(result);
  });

  return router;
};
