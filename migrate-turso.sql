-- ============================================================
-- Echomancer v2 - Turso Schema Migration
-- Fixes schema mismatch between code and database
-- ============================================================

-- ==================== JOBS ====================
-- The existing jobs table has old column names (pdf_name, voice_sample_path, audiobook_path)
-- and is missing many columns the code expects.
-- Since there are 0 jobs, we can safely recreate.

DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  book_title TEXT NOT NULL DEFAULT 'Untitled',
  voice_name TEXT DEFAULT 'Custom Voice',
  pdf_storage_path TEXT NOT NULL,
  voice_storage_path TEXT,
  audio_storage_path TEXT,
  video_id TEXT,
  start_time INTEGER DEFAULT 0,
  end_time INTEGER DEFAULT 30,
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  progress INTEGER DEFAULT 0,
  current_section INTEGER DEFAULT 0,
  total_sections INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  error_message TEXT,
  tts_variant TEXT,
  char_count INTEGER,
  paragraph_count INTEGER,
  deleted_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_jobs_user_id ON jobs (user_id);
CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_created_at ON jobs (created_at DESC);
CREATE INDEX idx_jobs_not_deleted ON jobs (user_id, created_at DESC) WHERE deleted_at IS NULL;

-- ==================== VOICES ====================
-- Add missing columns to existing voices table
-- SQLite doesn't support ALTER TABLE ADD COLUMN with all constraints,
-- so we recreate with data migration.

CREATE TABLE voices_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  source TEXT DEFAULT 'upload' CHECK (source IN ('youtube', 'upload')),
  source_video_id TEXT,
  voice_id TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Copy existing voices data
INSERT INTO voices_new (id, user_id, name, storage_path, source, created_at)
SELECT id, user_id, name, storage_path, source, created_at FROM voices;

DROP TABLE voices;
ALTER TABLE voices_new RENAME TO voices;

CREATE INDEX idx_voices_user_id ON voices (user_id);

-- ==================== USAGE LOGS ====================
-- Ensure usage_logs has the expected schema
CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  action TEXT NOT NULL,
  chars_processed INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
