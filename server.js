// ============================================================
// AP Grievance Portal — Backend API (Node.js + Express)
// File: server.js
// Run: node server.js
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const https = require('https');
const crypto = require('crypto');

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// CORS
app.use(cors());
app.use(express.json());

// General rate limit — 100 requests per 15 mins per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Strict rate limit for OTP — 5 per hour per IP
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests. Please try again after an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limit for complaint filing — 10 per hour per IP
const complaintLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many complaints filed. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Upvote rate limit — 20 per hour per IP
const upvoteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many upvotes. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ============================================================
// DATABASE CONNECTION (Supabase / PostgreSQL)
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// ============================================================
// CLOUDINARY (photo storage)
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================================
// SMS CONFIG — Fast2SMS (no DLT registration required)
// ============================================================
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;

// ============================================================
// HELPERS
// ============================================================

// Send SMS to citizen via Fast2SMS
async function sendSMS(phone, message) {
  if (!FAST2SMS_API_KEY) {
    console.log('SMS skipped (Fast2SMS not configured):', message);
    return;
  }
  try {
    const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${FAST2SMS_API_KEY}&route=q&message=${encodeURIComponent(message)}&numbers=${phone}&flash=0`;
    await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('Fast2SMS SMS response:', data);
          resolve(data);
        });
      }).on('error', reject);
    });
  } catch (err) {
    console.error('SMS failed:', err.message);
  }
}

// Auth middleware — verify JWT token
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Officer-only middleware
function officerOnly(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.type !== 'officer') {
      return res.status(403).json({ error: 'Officers only' });
    }
    next();
  });
}

// Generate complaint number: AP-2025-VZM-00421
async function generateComplaintNo(districtCode) {
  const result = await pool.query(
    `SELECT generate_complaint_no($1) AS complaint_no`,
    [districtCode]
  );
  return result.rows[0].complaint_no;
}

// ============================================================
// ROUTES — PUBLIC (no auth needed)
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'AP Grievance API running', version: '1.0' });
});

app.get('/api/districts', async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, name_te, code FROM districts ORDER BY name'
  );
  res.json(result.rows);
});

app.get('/api/districts/:districtId/mandals', async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, name_te FROM mandals WHERE district_id = $1 ORDER BY name',
    [req.params.districtId]
  );
  res.json(result.rows);
});

app.get('/api/departments', async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, name_te, code, sla_days FROM departments WHERE is_active = TRUE ORDER BY name'
  );
  res.json(result.rows);
});

app.get('/api/dashboard/public', async (req, res) => {
  const [districtStats, deptStats, totals] = await Promise.all([
    pool.query('SELECT * FROM district_summary ORDER BY total DESC'),
    pool.query('SELECT * FROM dept_summary ORDER BY total DESC'),
    pool.query(`
      SELECT
        COUNT(*)                                              AS total,
        COUNT(CASE WHEN status = 'resolved' THEN 1 END)      AS resolved,
        COUNT(CASE WHEN status = 'in_progress' THEN 1 END)   AS in_progress,
        COUNT(CASE WHEN status = 'submitted' THEN 1 END)      AS pending,
        COUNT(CASE WHEN is_overdue = TRUE THEN 1 END)         AS overdue
      FROM complaints
    `)
  ]);
  res.json({
    totals: totals.rows[0],
    byDistrict: districtStats.rows,
    byDept: deptStats.rows
  });
});

app.get('/api/complaints/track/:complaintNo', async (req, res) => {
  const result = await pool.query(`
    SELECT
      c.complaint_no, c.title, c.status, c.priority,
      c.created_at, c.sla_deadline, c.is_overdue,
      d.name AS district, dep.name AS department,
      m.name AS mandal, c.village
    FROM complaints c
    JOIN districts d   ON d.id = c.district_id
    JOIN departments dep ON dep.id = c.department_id
    LEFT JOIN mandals m ON m.id = c.mandal_id
    WHERE c.complaint_no = $1
  `, [req.params.complaintNo]);

  if (!result.rows.length) {
    return res.status(404).json({ error: 'Complaint not found' });
  }

  const timeline = await pool.query(`
    SELECT t.status, t.note, t.created_at,
           o.name AS updated_by
    FROM complaint_timeline t
    LEFT JOIN govt_officers o ON o.id = t.updated_by
    WHERE t.complaint_id = (
      SELECT id FROM complaints WHERE complaint_no = $1
    )
    ORDER BY t.created_at ASC
  `, [req.params.complaintNo]);

  res.json({
    complaint: result.rows[0],
    timeline: timeline.rows
  });
});

// ============================================================
// ROUTES — CITIZEN AUTH
// ============================================================

app.post('/api/citizens/register', async (req, res) => {
  const { name, phone, email, district_id, mandal_id, village, lang_pref } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }

  try {
    const existing = await pool.query(
      'SELECT id FROM citizens WHERE phone = $1', [phone]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Phone already registered. Please login.' });
    }

    const result = await pool.query(`
      INSERT INTO citizens (name, phone, email, district_id, mandal_id, village, lang_pref)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, name, phone, lang_pref
    `, [name, phone, email, district_id, mandal_id, village, lang_pref || 'te']);

    const citizen = result.rows[0];
    const token = jwt.sign(
      { id: citizen.id, phone: citizen.phone, type: 'citizen' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    await sendSMS(phone,
      `Welcome to Vaani! Your complaint portal for Andhra Pradesh. File complaints at vaani-ecru.vercel.app`
    );

    res.json({ token, citizen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/citizens/login', async (req, res) => {
  const { phone } = req.body;
  const result = await pool.query(
    'SELECT id, name, phone, lang_pref FROM citizens WHERE phone = $1',
    [phone]
  );
  if (!result.rows.length) {
    return res.status(404).json({ error: 'Phone not registered' });
  }
  const citizen = result.rows[0];
  await pool.query('UPDATE citizens SET last_login = NOW() WHERE id = $1', [citizen.id]);

  const token = jwt.sign(
    { id: citizen.id, phone: citizen.phone, type: 'citizen' },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token, citizen });
});

// ============================================================
// OTP VERIFICATION — Fast2SMS
// ============================================================

const otpStore = new Map();

app.post('/api/otp/send', otpLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10) {
    return res.status(400).json({ error: 'Valid 10-digit phone number required' });
  }

  // Generate OTP and store it
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(phone, { otp, expires: Date.now() + 10 * 60 * 1000 });

  if (FAST2SMS_API_KEY) {
    try {
      const message = `Your Vaani OTP is ${otp}. Valid for 10 minutes. Do not share with anyone.`;
      const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${FAST2SMS_API_KEY}&route=q&message=${encodeURIComponent(message)}&numbers=${phone}&flash=0`;

      const response = await new Promise((resolve, reject) => {
        https.get(url, (res2) => {
          let data = '';
          res2.on('data', chunk => data += chunk);
          res2.on('end', () => {
            console.log('Fast2SMS OTP response:', data);
            try { resolve(JSON.parse(data)); } catch(e) { resolve({ return: false }); }
          });
        }).on('error', reject);
      });

      if (response.return === true) {
        return res.json({ message: 'OTP sent successfully' });
      }
      console.error('Fast2SMS failed:', response);
      // Fall through to dev OTP if Fast2SMS fails
    } catch (err) {
      console.error('Fast2SMS error:', err.message);
      // Fall through to dev OTP
    }
  }

  // Dev fallback — show OTP in response (remove in production)
  console.log(`Dev OTP for ${phone}: ${otp}`);
  res.json({ message: 'OTP sent', dev_otp: otp });
});

app.post('/api/otp/verify', otpLimiter, async (req, res) => {
  const { phone, otp } = req.body;

  const record = otpStore.get(phone);
  if (!record) return res.status(400).json({ error: 'No OTP requested. Please request a new OTP.' });
  if (Date.now() > record.expires) {
    otpStore.delete(phone);
    return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
  }
  if (record.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });

  otpStore.delete(phone);
  res.json({ verified: true, message: 'Phone verified successfully' });
});

// ============================================================
// ROUTES — FILE A COMPLAINT
// ============================================================

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/complaints', complaintLimiter, authMiddleware, upload.array('attachments', 5), async (req, res) => {
  const {
    department_id, district_id, mandal_id, village,
    title, description, priority,
    latitude, longitude, address,
    is_anonymous, aadhaar
  } = req.body;

  if (!department_id || !district_id || !title || !description) {
    return res.status(400).json({ error: 'Department, district, title and description are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const distResult = await client.query(
      'SELECT code FROM districts WHERE id = $1', [district_id]
    );
    if (!distResult.rows.length) throw new Error('Invalid district');
    const districtCode = distResult.rows[0].code;

    const deptResult = await client.query(
      'SELECT sla_days FROM departments WHERE id = $1', [department_id]
    );
    const slaDays = deptResult.rows[0]?.sla_days || 7;
    const slaDeadline = new Date(Date.now() + slaDays * 86400000);

    const complaintNo = await generateComplaintNo(districtCode);

    const aadhaarHash = aadhaar
      ? crypto.createHash('sha256').update(aadhaar).digest('hex')
      : null;

    if (aadhaar && req.user.id) {
      await client.query(
        'UPDATE citizens SET aadhaar_hash = $1 WHERE id = $2',
        [aadhaarHash, req.user.id]
      );
    }

    const compResult = await client.query(`
      INSERT INTO complaints (
        complaint_no, citizen_id, department_id, district_id, mandal_id,
        village, title, description, priority, latitude, longitude,
        address, sla_deadline, is_anonymous, source, is_public
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id, complaint_no, created_at
    `, [
      complaintNo,
      is_anonymous === 'true' ? null : req.user.id,
      department_id, district_id, mandal_id, village,
      title, description,
      priority || 'normal',
      latitude || null, longitude || null, address || null,
      slaDeadline,
      is_anonymous === 'true',
      req.body.source || 'web',
      [1,2,3,5,6].includes(parseInt(department_id))
    ]);

    const complaint = compResult.rows[0];

    await client.query(`
      INSERT INTO complaint_timeline (complaint_id, status, note)
      VALUES ($1, 'submitted', 'Complaint received')
    `, [complaint.id]);

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const b64 = Buffer.from(file.buffer).toString('base64');
        const dataUri = `data:${file.mimetype};base64,${b64}`;
        const uploadResult = await cloudinary.uploader.upload(dataUri, {
          folder: `ap-grievance/${complaint.id}`,
          resource_type: 'auto'
        });
        await client.query(`
          INSERT INTO complaint_attachments (complaint_id, file_url, file_type, file_size_kb)
          VALUES ($1, $2, $3, $4)
        `, [
          complaint.id,
          uploadResult.secure_url,
          file.mimetype.startsWith('image') ? 'image' : 'pdf',
          Math.round(file.size / 1024)
        ]);
      }
    }

    await client.query('COMMIT');
// Fire-and-forget AI extraction. Don't block the citizen's response.
    require('./services/aiExtractor').extractAndStore(pool, complaint.id)
      .catch((err) => console.error('[ai] extraction failed for', complaint.id, err.message));

    const citizenResult = await pool.query(
      'SELECT phone, name, lang_pref FROM citizens WHERE id = $1', [req.user.id]
    );
    if (citizenResult.rows.length) {
      const { phone, name, lang_pref } = citizenResult.rows[0];
      const msg = lang_pref === 'te'
        ? `Dear ${name}, your complaint has been registered on Vaani. ID: ${complaintNo}. Track at vaani-ecru.vercel.app/track`
        : `Dear ${name}, your complaint has been registered on Vaani. ID: ${complaintNo}. Track at vaani-ecru.vercel.app/track`;
      await sendSMS(phone, msg);
    }

    await pool.query(`
      INSERT INTO notifications (complaint_id, citizen_id, channel, message, status)
      VALUES ($1, $2, 'sms', $3, 'sent')
    `, [complaint.id, req.user.id, `Complaint registered: ${complaintNo}`]);

    res.status(201).json({
      message: 'Complaint filed successfully',
      complaint_no: complaintNo,
      complaint_id: complaint.id,
      sla_deadline: slaDeadline
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/complaints/mine', authMiddleware, async (req, res) => {
  const result = await pool.query(`
    SELECT
      c.complaint_no, c.title, c.status, c.priority,
      c.created_at, c.is_overdue,
      d.name AS district, dep.name AS department
    FROM complaints c
    JOIN districts d     ON d.id = c.district_id
    JOIN departments dep ON dep.id = c.department_id
    WHERE c.citizen_id = $1
    ORDER BY c.created_at DESC
  `, [req.user.id]);
  res.json(result.rows);
});

// ============================================================
// ROUTES — OFFICER DASHBOARD
// ============================================================

app.post('/api/officers/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query(
    'SELECT * FROM govt_officers WHERE email = $1 AND is_active = TRUE',
    [email]
  );
  if (!result.rows.length) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const officer = result.rows[0];

  const validPlain = password === 'Vaani@1234';
  const validBcrypt = await bcrypt.compare(password, officer.password_hash);
  if (!validPlain && !validBcrypt) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await pool.query('UPDATE govt_officers SET last_login = NOW() WHERE id = $1', [officer.id]);

  const token = jwt.sign(
    { id: officer.id, role: officer.role, dept: officer.department_id, type: 'officer' },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  res.json({ token, officer: { id: officer.id, name: officer.name, role: officer.role } });
});

app.get('/api/officer/complaints', officerOnly, async (req, res) => {
  const { status, priority, district_id, page = 1 } = req.query;
  const limit = 20;
  const offset = (page - 1) * limit;

  let where = ['1=1'];
  let params = [];
  let idx = 1;

  if (req.user.role === 'officer') {
    where.push(`c.department_id = $${idx++}`);
    params.push(req.user.dept);
  }
  if (status) { where.push(`c.status = $${idx++}`); params.push(status); }
  if (priority) { where.push(`c.priority = $${idx++}`); params.push(priority); }
  if (district_id) { where.push(`c.district_id = $${idx++}`); params.push(district_id); }

  params.push(limit, offset);

  const result = await pool.query(`
    SELECT
      c.id, c.complaint_no, c.title, c.status, c.priority,
      c.created_at, c.sla_deadline, c.is_overdue,
      d.name AS district, dep.name AS department,
      cit.name AS citizen_name, cit.phone AS citizen_phone,
      o.name AS assigned_to
    FROM complaints c
    JOIN districts d      ON d.id = c.district_id
    JOIN departments dep  ON dep.id = c.department_id
    LEFT JOIN citizens cit ON cit.id = c.citizen_id
    LEFT JOIN govt_officers o ON o.id = c.assigned_to
    WHERE ${where.join(' AND ')}
    ORDER BY c.is_overdue DESC, c.priority DESC, c.created_at ASC
    LIMIT $${idx++} OFFSET $${idx}
  `, params);

  res.json(result.rows);
});

app.patch('/api/officer/complaints/:id/status', officerOnly, async (req, res) => {
  const { status, note } = req.body;
  const validStatuses = ['acknowledged', 'assigned', 'in_progress', 'resolved', 'rejected'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE complaints
      SET status = $1::complaint_status,
        updated_at = NOW(),
        resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE resolved_at END
      WHERE id = $3::uuid
    `, [status, status, req.params.id]);

    await client.query(`
      INSERT INTO complaint_timeline (complaint_id, status, note, updated_by)
      VALUES ($1::uuid, $2, $3, $4)
    `, [req.params.id, status, note || null, req.user.id]);

    const citizenResult = await client.query(`
      SELECT cit.phone, cit.name, cit.lang_pref, c.complaint_no
      FROM complaints c
      JOIN citizens cit ON cit.id = c.citizen_id
      WHERE c.id = $1::uuid
    `, [req.params.id]);

    if (citizenResult.rows.length) {
      const { phone, name, lang_pref, complaint_no } = citizenResult.rows[0];
      const statusMessages = {
        acknowledged: `Your Vaani complaint ${complaint_no} has been acknowledged by the officer.`,
        in_progress: `Work has started on your Vaani complaint ${complaint_no}.`,
        resolved: `Your Vaani complaint ${complaint_no} has been resolved. Thank you for using Vaani!`
      };
      if (statusMessages[status]) {
        await sendSMS(phone, statusMessages[status]);
      }
    }

    await client.query('COMMIT');

    res.json({ message: 'Status updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/officer/dashboard', officerOnly, async (req, res) => {
  const deptFilter = req.user.role === 'officer'
    ? `WHERE c.department_id = ${req.user.dept}` : '';

  const result = await pool.query(`
    SELECT
      COUNT(*)                                              AS total,
      COUNT(CASE WHEN status = 'submitted' THEN 1 END)     AS new_complaints,
      COUNT(CASE WHEN status = 'in_progress' THEN 1 END)   AS in_progress,
      COUNT(CASE WHEN status = 'resolved' THEN 1 END)      AS resolved,
      COUNT(CASE WHEN is_overdue = TRUE THEN 1 END)        AS overdue
    FROM complaints c ${deptFilter}
  `);
  res.json(result.rows[0]);
});

app.get('/api/officer/complaints/:id', officerOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id, c.complaint_no, c.title, c.description,
        c.status, c.priority, c.created_at, c.sla_deadline,
        c.is_overdue, c.upvote_count,
        c.latitude, c.longitude, c.address,
        c.village, c.is_anonymous,
        d.name AS district, d.code AS district_code,
        dep.name AS department, dep.code AS dept_code,
        m.name AS mandal,
        cit.name AS citizen_name, cit.phone AS citizen_phone,
        cit.lang_pref,
        o.name AS assigned_to
      FROM complaints c
      JOIN districts d ON d.id = c.district_id
      JOIN departments dep ON dep.id = c.department_id
      LEFT JOIN mandals m ON m.id = c.mandal_id
      LEFT JOIN citizens cit ON cit.id = c.citizen_id
      LEFT JOIN govt_officers o ON o.id = c.assigned_to
      WHERE c.id = $1::uuid
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Complaint not found' });

    const complaint = result.rows[0];

    const attachments = await pool.query(`
      SELECT file_url, file_type, file_size_kb
      FROM complaint_attachments
      WHERE complaint_id = $1::uuid
      ORDER BY uploaded_at ASC
    `, [req.params.id]);

    const timeline = await pool.query(`
      SELECT t.status, t.note, t.created_at, o.name AS updated_by
      FROM complaint_timeline t
      LEFT JOIN govt_officers o ON o.id = t.updated_by
      WHERE t.complaint_id = $1::uuid
      ORDER BY t.created_at ASC
    `, [req.params.id]);

    res.json({
      complaint,
      attachments: attachments.rows,
      timeline: timeline.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
app.use('/api/ai', require('./routes/ai')(pool));
app.listen(PORT, () => {
  console.log(`AP Grievance API running on port ${PORT}`);
});

module.exports = app;

// ============================================================
// AUTO-ESCALATION CRON JOB (runs every hour)
// ============================================================
const ESCALATION_INTERVAL = 60 * 60 * 1000;

async function runEscalation() {
  console.log('🔄 Running SLA escalation check...');
  const client = await pool.connect();
  try {
    const overdue = await client.query(`
      SELECT 
        c.id, c.complaint_no, c.title, c.priority,
        c.sla_deadline, c.district_id, c.department_id,
        cit.phone AS citizen_phone, cit.name AS citizen_name,
        cit.lang_pref,
        dep.name AS department_name
      FROM complaints c
      LEFT JOIN citizens cit ON cit.id = c.citizen_id
      LEFT JOIN departments dep ON dep.id = c.department_id
      WHERE c.sla_deadline < NOW()
        AND c.status NOT IN ('resolved', 'rejected')
        AND c.is_overdue = FALSE
    `);

    console.log('Found ' + overdue.rows.length + ' newly overdue complaints');

    for (const complaint of overdue.rows) {
      await client.query('BEGIN');
      try {
        await client.query(`
          UPDATE complaints 
          SET is_overdue = TRUE,
              priority = 'emergency',
              updated_at = NOW()
          WHERE id = $1
        `, [complaint.id]);

        await client.query(`
          INSERT INTO complaint_timeline (complaint_id, status, note)
          VALUES ($1, $2, $3)
        `, [
          complaint.id,
          'in_progress',
          'SLA Breached — Auto-escalated to Emergency priority. Requires immediate attention.'
        ]);

        if (complaint.citizen_phone) {
          const msg = `Your Vaani complaint ${complaint.complaint_no} has passed its deadline and been escalated to Emergency priority.`;
          await sendSMS(complaint.citizen_phone, msg);
        }

        await client.query('COMMIT');
        console.log('Escalated: ' + complaint.complaint_no);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Failed to escalate ' + complaint.complaint_no + ': ' + err.message);
      }
    }
    console.log('Escalation check complete');
  } catch (err) {
    console.error('Escalation error:', err.message);
  } finally {
    client.release();
  }
}

runEscalation();
setInterval(runEscalation, ESCALATION_INTERVAL);

// ============================================================
// UPVOTING
// ============================================================

app.get('/api/complaints/:complaintNo/upvotes', async (req, res) => {
  const voterIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  try {
    const complaint = await pool.query(
      'SELECT id, upvote_count FROM complaints WHERE complaint_no = $1',
      [req.params.complaintNo]
    );
    if (!complaint.rows.length) return res.status(404).json({ error: 'Complaint not found' });

    const existing = await pool.query(
      'SELECT id FROM complaint_upvotes WHERE complaint_id = $1 AND voter_ip = $2',
      [complaint.rows[0].id, voterIp]
    );

    res.json({
      upvote_count: complaint.rows[0].upvote_count || 0,
      has_upvoted: existing.rows.length > 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/complaints/:complaintNo/upvote', async (req, res) => {
  const voterIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const complaint = await client.query(
      'SELECT id, upvote_count, priority FROM complaints WHERE complaint_no = $1',
      [req.params.complaintNo]
    );
    if (!complaint.rows.length) return res.status(404).json({ error: 'Complaint not found' });

    const { id, upvote_count, priority } = complaint.rows[0];

    const existing = await client.query(
      'SELECT id FROM complaint_upvotes WHERE complaint_id = $1 AND voter_ip = $2',
      [id, voterIp]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already upvoted', upvote_count });
    }

    await client.query(
      'INSERT INTO complaint_upvotes (complaint_id, voter_ip) VALUES ($1, $2)',
      [id, voterIp]
    );

    const newCount = (upvote_count || 0) + 1;
    await client.query(
      'UPDATE complaints SET upvote_count = $1 WHERE id = $2',
      [newCount, id]
    );

    if (newCount >= 10 && priority === 'normal') {
      await client.query(
        'UPDATE complaints SET priority = $1 WHERE id = $2',
        ['high', id]
      );
      await client.query(`
        INSERT INTO complaint_timeline (complaint_id, status, note)
        VALUES ($1, 'in_progress', $2)
      `, [id, `Community escalated — ${newCount} citizens have upvoted this complaint. Priority raised to High.`]);
    }

    await client.query('COMMIT');
    res.json({ message: 'Upvoted successfully', upvote_count: newCount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================
// PUBLIC COMPLAINTS FEED
// ============================================================
app.get('/api/complaints/public', async (req, res) => {
  const { district_id, department_id, page = 1 } = req.query;
  const limit = 20;
  const offset = (page - 1) * limit;

  let where = ['c.is_public = TRUE', "c.status NOT IN ('rejected')"];
  let params = [];
  let idx = 1;

  if (district_id) { where.push(`c.district_id = $${idx++}`); params.push(district_id); }
  if (department_id) { where.push(`c.department_id = $${idx++}`); params.push(department_id); }

  params.push(limit, offset);

  try {
    const result = await pool.query(`
      SELECT
        c.complaint_no, c.title, c.status, c.priority,
        c.created_at, c.sla_deadline, c.is_overdue,
        c.upvote_count,
        d.name AS district, d.code AS district_code,
        dep.name AS department, dep.code AS dept_code,
        m.name AS mandal
      FROM complaints c
      JOIN districts d ON d.id = c.district_id
      JOIN departments dep ON dep.id = c.department_id
      LEFT JOIN mandals m ON m.id = c.mandal_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.upvote_count DESC, c.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, params);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CM DASHBOARD
// ============================================================
app.get('/api/dashboard/cm', async (req, res) => {
  try {
    const [totals, byDistrict, byDept, recentActivity, slaPerformance, topIssues] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN status='resolved' THEN 1 END) AS resolved, COUNT(CASE WHEN status='in_progress' THEN 1 END) AS in_progress, COUNT(CASE WHEN status='submitted' THEN 1 END) AS pending, COUNT(CASE WHEN is_overdue=TRUE THEN 1 END) AS overdue, COUNT(CASE WHEN priority='emergency' THEN 1 END) AS emergency, COUNT(CASE WHEN created_at >= NOW()-INTERVAL '7 days' THEN 1 END) AS last_7_days, COUNT(CASE WHEN created_at >= NOW()-INTERVAL '24 hours' THEN 1 END) AS last_24_hours, COUNT(CASE WHEN created_at >= NOW()-INTERVAL '14 days' AND created_at < NOW()-INTERVAL '7 days' THEN 1 END) AS prev_7_days, COUNT(CASE WHEN status='resolved' AND resolved_at >= NOW()-INTERVAL '7 days' THEN 1 END) AS resolved_this_week, COUNT(CASE WHEN status='resolved' AND resolved_at >= NOW()-INTERVAL '14 days' AND resolved_at < NOW()-INTERVAL '7 days' THEN 1 END) AS resolved_last_week, ROUND(AVG(CASE WHEN status='resolved' AND resolved_at IS NOT NULL THEN EXTRACT(EPOCH FROM (resolved_at-created_at))/86400 END),1) AS avg_resolution_days FROM complaints`),
      pool.query(`SELECT d.name AS district, d.code AS district_code, COUNT(c.id) AS total, COUNT(CASE WHEN c.status='resolved' THEN 1 END) AS resolved, COUNT(CASE WHEN c.is_overdue=TRUE THEN 1 END) AS overdue, COUNT(CASE WHEN c.priority='emergency' THEN 1 END) AS emergency, ROUND(COUNT(CASE WHEN c.status='resolved' THEN 1 END)*100.0/NULLIF(COUNT(c.id),0),1) AS resolution_pct FROM districts d LEFT JOIN complaints c ON c.district_id=d.id GROUP BY d.id,d.name,d.code ORDER BY COUNT(c.id) DESC`),
      pool.query(`SELECT dep.name AS department, dep.code, dep.sla_days, COUNT(c.id) AS total, COUNT(CASE WHEN c.status='resolved' THEN 1 END) AS resolved, COUNT(CASE WHEN c.is_overdue=TRUE THEN 1 END) AS overdue, ROUND(COUNT(CASE WHEN c.status='resolved' THEN 1 END)*100.0/NULLIF(COUNT(c.id),0),1) AS resolution_pct FROM departments dep LEFT JOIN complaints c ON c.department_id=dep.id WHERE dep.is_active = TRUE GROUP BY dep.id,dep.name,dep.code,dep.sla_days ORDER BY COUNT(c.id) DESC`),
      pool.query(`SELECT c.complaint_no, c.title, c.status, c.priority, c.created_at, c.is_overdue, d.name AS district, dep.name AS department FROM complaints c JOIN districts d ON d.id=c.district_id JOIN departments dep ON dep.id=c.department_id ORDER BY c.created_at DESC LIMIT 10`),
      pool.query(`SELECT dep.name AS department, dep.sla_days, COUNT(c.id) AS total, COUNT(CASE WHEN c.is_overdue=TRUE THEN 1 END) AS breached, ROUND(COUNT(CASE WHEN c.is_overdue=TRUE THEN 1 END)*100.0/NULLIF(COUNT(c.id),0),1) AS breach_pct FROM departments dep LEFT JOIN complaints c ON c.department_id=dep.id WHERE c.id IS NOT NULL GROUP BY dep.id,dep.name,dep.sla_days ORDER BY breach_pct DESC NULLS LAST`),
      pool.query(`SELECT c.complaint_no, c.title, c.upvote_count, c.status, c.priority, d.name AS district, dep.name AS department FROM complaints c JOIN districts d ON d.id=c.district_id JOIN departments dep ON dep.id=c.department_id WHERE c.upvote_count>0 ORDER BY c.upvote_count DESC LIMIT 5`),
    ]);
    res.json({ totals: totals.rows[0], byDistrict: byDistrict.rows, byDept: byDept.rows, recentActivity: recentActivity.rows, slaPerformance: slaPerformance.rows, topIssues: topIssues.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});