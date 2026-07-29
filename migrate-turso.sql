-- ============================================================
-- Echomancer v2 — Turso schema
--
-- This script is ADDITIVE and safe to run against a live database: every
-- statement is `IF NOT EXISTS`, and nothing is ever dropped. It mirrors
-- `src/lib/tts/schema-migrate.ts`, which performs the same work at runtime on
-- the first request after a deploy.
--
--   Fresh database      → run this once (or just start the app).
--   Existing database   → running it again is a no-op.
--
-- Adding a column to an existing table:
--   SQLite has no `ADD COLUMN IF NOT EXISTS`, so add it to the JOB_COLUMNS list
--   in `schema-migrate.ts` instead and let the runtime migrator apply it. That
--   keeps one source of truth and tolerates the duplicate-column race between
--   concurrent requests.
--
-- Rebuilding from scratch (DESTROYS DATA — never run against production):
--   DROP TABLE IF EXISTS jobs;
--   DROP TABLE IF EXISTS uploads;
--   DROP TABLE IF EXISTS usage_logs;
--   DROP TABLE IF EXISTS rate_limits;
-- ============================================================

-- ==================== JOBS ====================
-- One narration attempt: one document + one catalog voice.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  book_title TEXT NOT NULL DEFAULT 'Untitled',
  voice_name TEXT DEFAULT 'Narrator',
  pdf_storage_path TEXT NOT NULL,
  audio_storage_path TEXT,
  status TEXT DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'cancelled')),
  progress INTEGER DEFAULT 0,
  current_section INTEGER DEFAULT 0,
  total_sections INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  error_message TEXT,
  deleted_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  -- Stock TTS (OpenRouter)
  generation_mode TEXT DEFAULT 'stock',
  job_kind TEXT DEFAULT 'takehome',
  tts_provider TEXT,
  provider_voice_id TEXT,
  catalog_voice_id TEXT,
  tts_options TEXT,
  -- Live listen progress
  stream_cursor INTEGER DEFAULT 0,
  stream_chars_used INTEGER DEFAULT 0,
  stream_max_chars INTEGER,
  -- Take-home progress
  segments_json TEXT,
  next_section_index INTEGER DEFAULT 0,
  char_count INTEGER DEFAULT 0,
  parent_job_id TEXT,
  price_estimate_eur REAL,
  -- Worker lease: one holder at a time, renewed by heartbeat
  processing_started_at INTEGER,
  processing_lease_token TEXT,
  lease_expires_at INTEGER,
  generation_started_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_pdf_path ON jobs (pdf_storage_path);

-- ==================== UPLOADS ====================
-- Proves which session uploaded a document. Job creation rejects any
-- `pdfStoragePath` without a matching row for the caller.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  source_path TEXT,
  file_name TEXT,
  format TEXT,
  byte_size INTEGER DEFAULT 0,
  char_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads (user_id);
CREATE INDEX IF NOT EXISTS idx_uploads_storage_path ON uploads (storage_path);

-- ==================== USAGE LOGS ====================
-- Characters synthesized per action, for cost accounting.
CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  action TEXT NOT NULL,
  chars_processed INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs (user_id);

-- ==================== RATE LIMITS ====================
-- Shared counters; in-process maps enforce nothing across serverless isolates.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  identifier TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (key, identifier)
);
