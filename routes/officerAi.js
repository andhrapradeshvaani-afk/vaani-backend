// routes/officerAi.js
// Officer-facing AI brief endpoints. Uses your existing officer JWT auth.
// Mount with: app.use('/api/officer/ai', require('./routes/officerAi')(pool, officerOnly));

const express = require('express');
const { generateBriefForDistrict } = require('../services/dailyBrief');
const { buildBriefInput } = require('../services/briefInput');

/**
 * Resolve a district identifier (name OR code OR id) to {id, name}.
 */
async function resolveDistrict(pool, identifier) {
  // Numeric ID
  if (/^\d+$/.test(identifier)) {
    const { rows } = await pool.query(
      `SELECT id, name FROM districts WHERE id = $1 LIMIT 1`,
      [parseInt(identifier, 10)],
    );
    return rows[0] || null;
  }
  // Name or code
  const { rows } = await pool.query(
    `SELECT id, name FROM districts WHERE name = $1 OR code = $1 LIMIT 1`,
    [identifier],
  );
  return rows[0] || null;
}

/**
 * Get district {id, name} for the officer's own assigned district.
 */
async function getOfficerDistrict(pool, officerId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.name
     FROM govt_officers o
     JOIN districts d ON o.district_id = d.id
     WHERE o.id = $1`,
    [officerId],
  );
  return rows[0] || null;
}

/**
 * Centralised brief fetch + cache + generate logic.
 */
async function getOrGenerateBrief(pool, district, refresh) {
  if (!refresh) {
    const cached = await pool.query(
      `SELECT brief_md, generated_at FROM daily_briefs
       WHERE district_id = $1 AND brief_date = CURRENT_DATE`,
      [district.id],
    );
    if (cached.rows.length > 0) {
      return {
        cached: true,
        district: district.name,
        brief_md: cached.rows[0].brief_md,
        generated_at: cached.rows[0].generated_at,
      };
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
    [
      district.id,
      brief.brief_md,
      JSON.stringify(brief.brief_input),
      JSON.stringify(brief.snapshot),
    ],
  );

  return {
    cached: false,
    district: district.name,
    brief_md: brief.brief_md,
    generated_at: brief.generated_at,
  };
}

module.exports = (pool, officerOnly) => {
  const router = express.Router();

  /**
   * GET /api/officer/ai/brief
   * Returns the brief for the officer's own assigned district.
   * Any logged-in officer can call this.
   */
  router.get('/brief', officerOnly, async (req, res) => {
    try {
      const district = await getOfficerDistrict(pool, req.user.id);
      if (!district) {
        return res.status(403).json({
          error: 'No district assigned to your account. Contact admin.',
        });
      }
      const result = await getOrGenerateBrief(pool, district, req.query.refresh === '1');
      res.json(result);
    } catch (err) {
      console.error('[officer/ai/brief] error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/officer/ai/brief/:district
   * Admin-only — get brief for any district by name/code/id.
   */
  router.get('/brief/:district', officerOnly, async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only admin role can view briefs for other districts. Use /api/officer/ai/brief for your own district.',
        });
      }
      const district = await resolveDistrict(pool, req.params.district);
      if (!district) return res.status(404).json({ error: 'District not found' });
      const result = await getOrGenerateBrief(pool, district, req.query.refresh === '1');
      res.json(result);
    } catch (err) {
      console.error('[officer/ai/brief/:district] error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/officer/ai/districts
   * List of districts (for admin dropdown). Admin only.
   */
  router.get('/districts', officerOnly, async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
      }
      const { rows } = await pool.query(
        `SELECT d.id, d.name, d.code,
                COUNT(c.id) AS complaint_count,
                MAX(b.brief_date) AS last_brief_date
         FROM districts d
         LEFT JOIN complaints c ON c.district_id = d.id
         LEFT JOIN daily_briefs b ON b.district_id = d.id
         GROUP BY d.id, d.name, d.code
         ORDER BY d.name`,
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
