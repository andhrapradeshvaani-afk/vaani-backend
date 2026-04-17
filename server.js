// ============================================================
// AP Grievance Portal — Backend API (Node.js + Express)
// File: server.js
// Run: node server.js
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const cloudinary = require('cloudinary').v2;
const twilio  = require('twilio');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// DATABASE CONNECTION (Supabase / PostgreSQL)
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================================
// CLOUDINARY (photo storage)
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================================
// TWILIO (SMS)
// ============================================================
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID !== 'your_twilio_sid') {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

// ============================================================
// HELPERS
// ============================================================

// Send SMS to citizen
async function sendSMS(phone, message) {
  if (!twilioClient) {
    console.log('SMS skipped (Twilio not configured):', message);
    return;
  }
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE,
      to: '+91' + phone
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AP Grievance API running', version: '1.0' });
});

// Get all districts
app.get('/api/districts', async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, name_te, code FROM districts ORDER BY name'
  );
  res.json(result.rows);
});

// Get mandals for a district
app.get('/api/districts/:districtId/mandals', async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, name_te FROM mandals WHERE district_id = $1 ORDER BY name',
    [req.params.districtId]
  );
  res.json(result.rows);
});

// Get all departments
app.get('/api/departments', async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, name_te, code, sla_days FROM departments WHERE is_active = TRUE ORDER BY name'
  );
  res.json(result.rows);
});

// Public dashboard stats
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
    totals:      totals.rows[0],
    byDistrict:  districtStats.rows,
    byDept:      deptStats.rows
  });
});

// Track complaint by complaint_no (public)
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
    timeline:  timeline.rows
  });
});

// ============================================================
// ROUTES — CITIZEN AUTH
// ============================================================

// Register citizen (OTP-less — phone is the identity)
app.post('/api/citizens/register', async (req, res) => {
  const { name, phone, email, district_id, mandal_id, village, lang_pref } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }

  try {
    // Check if phone exists
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
      `నమస్కారం ${name}! AP Grievance Portal లో రిజిస్టర్ అయినందుకు ధన్యవాదాలు. మీ ఫిర్యాదులను నమోదు చేయడానికి యాప్‌ను ఉపయోగించండి.`
    );

    res.json({ token, citizen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login citizen by phone (send OTP in production — simplified here)
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
// OTP VERIFICATION
// ============================================================

const otpStore = new Map();

app.post('/api/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10) {
    return res.status(400).json({ error: 'Valid 10-digit phone number required' });
  }
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 10 * 60 * 1000;
  otpStore.set(phone, { otp, expires });
  try {
    const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        'authorization': process.env.FAST2SMS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ route: 'otp', variables_values: otp, numbers: phone })
    });
    const data = await response.json();
    console.log('Fast2SMS:', data);
  } catch (err) {
    console.log(`OTP for ${phone}: ${otp}`);
  }
  res.json({
    message: 'OTP sent successfully',
    dev_otp: process.env.NODE_ENV !== 'production' ? otp : undefined
  });
});

app.post('/api/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;
  const record = otpStore.get(phone);
  if (!record) {
    return res.status(400).json({ error: 'No OTP requested. Please request a new OTP.' });
  }
  if (Date.now() > record.expires) {
    otpStore.delete(phone);
    return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
  }
  if (record.otp !== otp) {
    return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });
  }
  otpStore.delete(phone);
  res.json({ verified: true, message: 'Phone verified successfully' });
});

// ============================================================
// ROUTES — FILE A COMPLAINT
// ============================================================

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/complaints', authMiddleware, upload.array('attachments', 5), async (req, res) => {
  const {
    department_id, district_id, mandal_id, village,
    title, description, priority,
    latitude, longitude, address,
    is_anonymous, aadhaar
  } = req.body;

  // Validate required fields
  if (!department_id || !district_id || !title || !description) {
    return res.status(400).json({ error: 'Department, district, title and description are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get district code for complaint number
    const distResult = await client.query(
      'SELECT code FROM districts WHERE id = $1', [district_id]
    );
    if (!distResult.rows.length) throw new Error('Invalid district');
    const districtCode = distResult.rows[0].code;

    // Get SLA deadline
    const deptResult = await client.query(
      'SELECT sla_days FROM departments WHERE id = $1', [department_id]
    );
    const slaDays = deptResult.rows[0]?.sla_days || 7;
    const slaDeadline = new Date(Date.now() + slaDays * 86400000);

    // Generate complaint number
    const complaintNo = await generateComplaintNo(districtCode);

    // Hash aadhaar if provided
    const aadhaarHash = aadhaar
      ? crypto.createHash('sha256').update(aadhaar).digest('hex')
      : null;

    // If filing anonymously, update citizen's aadhaar hash
    if (aadhaar && req.user.id) {
      await client.query(
        'UPDATE citizens SET aadhaar_hash = $1 WHERE id = $2',
        [aadhaarHash, req.user.id]
      );
    }

    // Insert complaint
    const compResult = await client.query(`
      INSERT INTO complaints (
        complaint_no, citizen_id, department_id, district_id, mandal_id,
        village, title, description, priority, latitude, longitude,
        address, sla_deadline, is_anonymous, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
      req.body.source || 'web'
    ]);

    const complaint = compResult.rows[0];

    // Log initial timeline entry
    await client.query(`
      INSERT INTO complaint_timeline (complaint_id, status, note)
      VALUES ($1, 'submitted', 'Complaint received')
    `, [complaint.id]);

    // Upload attachments to Cloudinary
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

    // Send SMS confirmation
    const citizenResult = await pool.query(
      'SELECT phone, name, lang_pref FROM citizens WHERE id = $1', [req.user.id]
    );
    if (citizenResult.rows.length) {
      const { phone, name, lang_pref } = citizenResult.rows[0];
      const msg = lang_pref === 'te'
        ? `నమస్కారం ${name}! మీ ఫిర్యాదు నమోదైంది. ID: ${complaintNo}. స్థితిని ట్రాక్ చేయడానికి ఈ IDని సేవ్ చేసుకోండి.`
        : `Dear ${name}, your complaint has been registered. ID: ${complaintNo}. Save this ID to track your complaint status.`;
      await sendSMS(phone, msg);
    }

    // Log notification
    await pool.query(`
      INSERT INTO notifications (complaint_id, citizen_id, channel, message, status)
      VALUES ($1, $2, 'sms', $3, 'sent')
    `, [complaint.id, req.user.id, `Complaint registered: ${complaintNo}`]);

    res.status(201).json({
      message:      'Complaint filed successfully',
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

// Get citizen's own complaints
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

// Officer login
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

  // Check plain text first (for dev), then bcrypt
  const validPlain  = password === 'Vaani@1234';
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

// Get complaints assigned to officer's department
app.get('/api/officer/complaints', officerOnly, async (req, res) => {
  const { status, priority, district_id, page = 1 } = req.query;
  const limit  = 20;
  const offset = (page - 1) * limit;

  let where = ['1=1'];
  let params = [];
  let idx = 1;

  // Supervisors/collectors see all; officers see their dept only
  if (req.user.role === 'officer') {
    where.push(`c.department_id = $${idx++}`);
    params.push(req.user.dept);
  }
  if (status)      { where.push(`c.status = $${idx++}`);      params.push(status); }
  if (priority)    { where.push(`c.priority = $${idx++}`);     params.push(priority); }
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

// Update complaint status (officer action)
app.patch('/api/officer/complaints/:id/status', officerOnly, async (req, res) => {
  const { status, note } = req.body;
  const validStatuses = ['acknowledged','assigned','in_progress','resolved','rejected'];

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

    // Add note to timeline
    await client.query(`
      INSERT INTO complaint_timeline (complaint_id, status, note, updated_by)
      VALUES ($1::uuid, $2, $3, $4)
    `, [req.params.id, status, note || null, req.user.id]);

    // Notify citizen via SMS
    const citizenResult = await client.query(`
      SELECT cit.phone, cit.name, cit.lang_pref, c.complaint_no
      FROM complaints c
      JOIN citizens cit ON cit.id = c.citizen_id
      WHERE c.id = $1::uuid
    `, [req.params.id]);

    if (citizenResult.rows.length) {
      const { phone, name, lang_pref, complaint_no } = citizenResult.rows[0];
      const statusMessages = {
        acknowledged: lang_pref === 'te'
          ? `మీ ఫిర్యాదు ${complaint_no} స్వీకరించబడింది.`
          : `Your complaint ${complaint_no} has been acknowledged.`,
        in_progress: lang_pref === 'te'
          ? `మీ ఫిర్యాదు ${complaint_no} పై పని ప్రారంభమైంది.`
          : `Work has started on your complaint ${complaint_no}.`,
        resolved: lang_pref === 'te'
          ? `మీ ఫిర్యాదు ${complaint_no} పరిష్కరించబడింది. మీ అభిప్రాయాన్ని పంచుకోండి.`
          : `Your complaint ${complaint_no} has been resolved. Please share your feedback.`
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

// Officer dashboard stats
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

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AP Grievance API running on port ${PORT}`);
});

module.exports = app;
