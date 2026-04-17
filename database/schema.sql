-- ============================================================
-- AP Grievance Portal — PostgreSQL Schema
-- Run this on Supabase SQL Editor or any PostgreSQL instance
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. DISTRICTS & MANDALS (Reference data)
-- ============================================================

CREATE TABLE districts (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(100) NOT NULL,
  name_te   VARCHAR(100),              -- Telugu name
  code      VARCHAR(10) UNIQUE NOT NULL -- e.g. 'VZM', 'GNT', 'CTR'
);

CREATE TABLE mandals (
  id          SERIAL PRIMARY KEY,
  district_id INTEGER REFERENCES districts(id),
  name        VARCHAR(100) NOT NULL,
  name_te     VARCHAR(100)
);

-- ============================================================
-- 2. DEPARTMENTS
-- ============================================================

CREATE TABLE departments (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  name_te     VARCHAR(150),
  code        VARCHAR(20) UNIQUE NOT NULL,  -- e.g. 'ROADS', 'WATER'
  sla_days    INTEGER DEFAULT 7,            -- days to resolve
  email       VARCHAR(200),                 -- dept contact email
  is_active   BOOLEAN DEFAULT TRUE
);

-- Insert default departments
INSERT INTO departments (name, name_te, code, sla_days) VALUES
  ('Roads & Infrastructure',    'రోడ్లు & మౌలిక సదుపాయాలు',    'ROADS',   7),
  ('Water Supply & Sanitation', 'నీటి సరఫరా & పారిశుద్ధ్యం',   'WATER',   5),
  ('Electricity (APSPDCL)',     'విద్యుత్ (APSPDCL)',            'ELEC',    3),
  ('Health & Medical',          'ఆరోగ్యం & వైద్యం',             'HEALTH',  5),
  ('Education',                 'విద్య',                         'EDU',     10),
  ('Municipal Services',        'పురపాలక సేవలు',                 'MUNI',    7),
  ('Revenue & Land',            'రెవెన్యూ & భూమి',               'REV',     14),
  ('Agriculture',               'వ్యవసాయం',                      'AGRI',    10),
  ('Police',                    'పోలీసు',                        'POLICE',  3),
  ('Other',                     'ఇతరాలు',                        'OTHER',   7);

-- ============================================================
-- 3. CITIZENS (Users who file complaints)
-- ============================================================

CREATE TABLE citizens (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(200) NOT NULL,
  phone        VARCHAR(15) UNIQUE NOT NULL,  -- used as login identifier
  email        VARCHAR(200),
  aadhaar_hash VARCHAR(64),                  -- store SHA-256 hash only, never raw
  district_id  INTEGER REFERENCES districts(id),
  mandal_id    INTEGER REFERENCES mandals(id),
  village      VARCHAR(200),
  lang_pref    VARCHAR(5) DEFAULT 'te',      -- 'te' Telugu, 'en' English
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_login   TIMESTAMPTZ
);

-- ============================================================
-- 4. COMPLAINTS (Core table)
-- ============================================================

CREATE TYPE complaint_status AS ENUM (
  'submitted',    -- just filed
  'acknowledged', -- received by dept
  'assigned',     -- assigned to officer
  'in_progress',  -- work started
  'resolved',     -- fixed
  'closed',       -- verified closed by citizen
  'rejected'      -- invalid/duplicate
);

CREATE TYPE complaint_priority AS ENUM ('normal', 'urgent', 'emergency');

CREATE TABLE complaints (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Human-readable ID: AP-2025-VZM-00421
  complaint_no    VARCHAR(30) UNIQUE NOT NULL,

  -- Who filed it
  citizen_id      UUID REFERENCES citizens(id),

  -- What it's about
  department_id   INTEGER REFERENCES departments(id) NOT NULL,
  district_id     INTEGER REFERENCES districts(id) NOT NULL,
  mandal_id       INTEGER REFERENCES mandals(id),
  village         VARCHAR(200),
  title           VARCHAR(300) NOT NULL,
  description     TEXT NOT NULL,
  priority        complaint_priority DEFAULT 'normal',

  -- Location (GPS from mobile)
  latitude        DECIMAL(10, 8),
  longitude       DECIMAL(11, 8),
  address         TEXT,

  -- Status tracking
  status          complaint_status DEFAULT 'submitted',
  assigned_to     INTEGER REFERENCES govt_officers(id),

  -- SLA deadline (auto-set from dept.sla_days)
  sla_deadline    TIMESTAMPTZ,
  is_overdue      BOOLEAN GENERATED ALWAYS AS (
                    NOW() > sla_deadline AND status NOT IN ('resolved','closed','rejected')
                  ) STORED,

  -- Anonymous filing option
  is_anonymous    BOOLEAN DEFAULT FALSE,

  -- Metadata
  source          VARCHAR(20) DEFAULT 'web', -- 'web', 'mobile', 'whatsapp', 'ivr'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ
);

-- Auto-generate complaint_no: AP-YYYY-DISTCODE-NNNNN
CREATE SEQUENCE complaint_seq START 1;

CREATE OR REPLACE FUNCTION generate_complaint_no(district_code TEXT)
RETURNS TEXT AS $$
DECLARE
  seq_val INTEGER;
  year_val TEXT;
BEGIN
  seq_val := nextval('complaint_seq');
  year_val := TO_CHAR(NOW(), 'YYYY');
  RETURN 'AP-' || year_val || '-' || district_code || '-' || LPAD(seq_val::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. COMPLAINT ATTACHMENTS
-- ============================================================

CREATE TABLE complaint_attachments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  complaint_id  UUID REFERENCES complaints(id) ON DELETE CASCADE,
  file_url      TEXT NOT NULL,          -- Cloudinary URL
  file_type     VARCHAR(50),            -- 'image', 'pdf', 'video'
  file_size_kb  INTEGER,
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 6. GOVERNMENT OFFICERS (Admin users)
-- ============================================================

CREATE TABLE govt_officers (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  email         VARCHAR(200) UNIQUE NOT NULL,
  phone         VARCHAR(15),
  password_hash VARCHAR(255) NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  district_id   INTEGER REFERENCES districts(id),
  role          VARCHAR(30) DEFAULT 'officer', -- 'officer', 'supervisor', 'collector', 'admin'
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

-- ============================================================
-- 7. COMPLAINT TIMELINE (Status history)
-- ============================================================

CREATE TABLE complaint_timeline (
  id            SERIAL PRIMARY KEY,
  complaint_id  UUID REFERENCES complaints(id) ON DELETE CASCADE,
  status        complaint_status NOT NULL,
  note          TEXT,                           -- officer's note
  updated_by    INTEGER REFERENCES govt_officers(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-log timeline when complaint status changes
CREATE OR REPLACE FUNCTION log_complaint_status()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO complaint_timeline (complaint_id, status, updated_by)
    VALUES (NEW.id, NEW.status, NEW.assigned_to);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_complaint_status
AFTER UPDATE ON complaints
FOR EACH ROW EXECUTE FUNCTION log_complaint_status();

-- ============================================================
-- 8. SMS / NOTIFICATION LOG
-- ============================================================

CREATE TABLE notifications (
  id            SERIAL PRIMARY KEY,
  complaint_id  UUID REFERENCES complaints(id),
  citizen_id    UUID REFERENCES citizens(id),
  channel       VARCHAR(20) NOT NULL,  -- 'sms', 'whatsapp', 'push', 'email'
  message       TEXT NOT NULL,
  status        VARCHAR(20) DEFAULT 'sent', -- 'sent', 'failed', 'delivered'
  sent_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 9. INDEXES (for fast queries)
-- ============================================================

CREATE INDEX idx_complaints_district    ON complaints(district_id);
CREATE INDEX idx_complaints_dept        ON complaints(department_id);
CREATE INDEX idx_complaints_status      ON complaints(status);
CREATE INDEX idx_complaints_citizen     ON complaints(citizen_id);
CREATE INDEX idx_complaints_overdue     ON complaints(is_overdue) WHERE is_overdue = TRUE;
CREATE INDEX idx_complaints_created     ON complaints(created_at DESC);
CREATE INDEX idx_timeline_complaint     ON complaint_timeline(complaint_id);
CREATE INDEX idx_citizens_phone         ON citizens(phone);

-- ============================================================
-- 10. VIEWS (for dashboard queries)
-- ============================================================

-- District-wise summary for the public dashboard
CREATE VIEW district_summary AS
SELECT
  d.name                                              AS district,
  d.code                                              AS district_code,
  COUNT(c.id)                                         AS total,
  COUNT(CASE WHEN c.status = 'resolved' THEN 1 END)  AS resolved,
  COUNT(CASE WHEN c.status = 'in_progress' THEN 1 END) AS in_progress,
  COUNT(CASE WHEN c.is_overdue = TRUE THEN 1 END)    AS overdue,
  ROUND(
    COUNT(CASE WHEN c.status = 'resolved' THEN 1 END)::NUMERIC
    / NULLIF(COUNT(c.id), 0) * 100, 1
  )                                                   AS resolution_pct
FROM districts d
LEFT JOIN complaints c ON c.district_id = d.id
GROUP BY d.id, d.name, d.code;

-- Department-wise summary
CREATE VIEW dept_summary AS
SELECT
  dep.name                                            AS department,
  dep.code,
  dep.sla_days,
  COUNT(c.id)                                         AS total,
  COUNT(CASE WHEN c.status = 'resolved' THEN 1 END)  AS resolved,
  COUNT(CASE WHEN c.is_overdue = TRUE THEN 1 END)    AS overdue,
  AVG(
    CASE WHEN c.resolved_at IS NOT NULL
    THEN EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))/86400
    END
  )::NUMERIC(5,1)                                     AS avg_resolution_days
FROM departments dep
LEFT JOIN complaints c ON c.department_id = dep.id
GROUP BY dep.id, dep.name, dep.code, dep.sla_days;
