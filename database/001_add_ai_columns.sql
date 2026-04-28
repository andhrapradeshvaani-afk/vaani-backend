-- Vaani AI Phase 2 — Migration 001 (schema-aligned)
-- Targets the existing `complaints` table (not `grievances`).
-- Adds AI-extracted fields. Department is stored as FK to departments(id).

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS ai_summary          TEXT,
  ADD COLUMN IF NOT EXISTS ai_category         TEXT,
  ADD COLUMN IF NOT EXISTS ai_severity         TEXT
    CHECK (ai_severity IN ('low','medium','high','critical')),
  ADD COLUMN IF NOT EXISTS ai_department_id    INTEGER REFERENCES departments(id),
  ADD COLUMN IF NOT EXISTS ai_extracted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS priority_score      NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS priority_scored_at  TIMESTAMPTZ;

-- Indexes for the analytics queries.
CREATE INDEX IF NOT EXISTS idx_complaints_ai_category    ON complaints (ai_category);
CREATE INDEX IF NOT EXISTS idx_complaints_ai_severity    ON complaints (ai_severity);
CREATE INDEX IF NOT EXISTS idx_complaints_ai_dept        ON complaints (ai_department_id);
CREATE INDEX IF NOT EXISTS idx_complaints_priority_score ON complaints (priority_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_complaints_status_sla     ON complaints (status, sla_deadline);
