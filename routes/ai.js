// routes/ai.js
// Mount with: app.use('/api/ai', require('./routes/ai')(pool));

const express = require('express');
const { extractAndStore, backfill } = require('../services/aiExtractor');
const { generateBriefForDistrict, generateAllBriefs } = require('../services/dailyBrief');
const { buildBriefInput } = require('../services/briefInput');

/**
 * Resolve a district identifier (name OR code) to {id, name}.
 * Lets URLs use either /api/ai/brief/Krishna or /api/ai/brief/KRSH.
 */
async function resolveDistrict(pool, identifier) {
  const { rows } = await pool.query(
    `SELECT id, name FROM districts WHERE name = $1 OR code = $1 LIMIT 1`,
    [identifier],
  );
  return rows[0] || null;
}

module.exports = (pool) => {
  const router = express.Router();

  // Per-complaint extraction. Call fire-and-forget after INSERT.
  router.post('/extract/:complaintId', async (req, res) => {
    try {
      const result = await extractAndStore(pool, req.params.complaintId);
      res.json({ ok: true, ai: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Inspect BriefInput WITHOUT calling LLM — for debugging.
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

  // Fetch today's brief — generates on demand if missing.
  router.get('/brief/:district', async (req, res) => {
    try {
      const district = await resolveDistrict(pool, req.params.district);
      if (!district) return res.status(404).json({ error: 'District not found' });

      if (!req.query.refresh) {
        const cached = await pool.query(
          `SELECT brief_md, generated_at FROM daily_briefs
           WHERE district_id = $1 AND brief_date = CURRENT_DATE`,
          [district.id],
        );
        if (cached.rows.length > 0) {
          return res.json({ cached: true, district: district.name, ...cached.rows[0] });
        }
      }

      const brief = await generateBriefForDistrict(pool, district);
      await pool.query(
        `INSERT INTO daily_briefs (district_id, brief_date, brief_md, brief_input, state_snapshot)
         VALUES ($1, CURRENT_DATE, $2, $3, $4)
         ON CONFLICT (district_id, brief_date) DO UPDATE
           SET brief_md = EXCLUDED.brief_md,
               brief_input = EXCLUDED.brief_input,
               state_snapshot = EXCLUDED.state_snapshot,
               generated_at = NOW()`,
        [district.id, brief.brief_md, JSON.stringify(brief.brief_input), JSON.stringify(brief.snapshot)],
      );
      res.json({ cached: false, district: district.name, brief_md: brief.brief_md, generated_at: brief.generated_at });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Daily cron — protect with secret.
  router.post('/cron/generate-all', async (req, res) => {
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const results = await generateAllBriefs(pool);
    res.json({ results });
  });

  // One-time backfill after deploying.
  router.post('/cron/backfill', async (req, res) => {
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const result = await backfill(pool);
    res.json(result);
  });

  return router;
};
