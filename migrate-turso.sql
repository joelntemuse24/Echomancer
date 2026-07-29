-- ============================================================
-- Echomancer v2 - Turso Schema Migration
-- Stock TTS jobs (OpenRouter). Prefer runtime ensureTtsJobColumns()
-- for additive ALTERs; this script recreates jobs when safe.
-- ============================================================

-- ==================== JOBS ====================
-- Recreate when empty / greenfield. Matches schema-migrate defaults.

DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  book_title TEXT NOT NULL DEFAULT 'Untitled',
  voice_name TEXT DEFAULT 'Narrator',
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
  stream_cursor INTEGER DEFAULT 0,
  stream_chars_used INTEGER DEFAULT 0,
  stream_max_chars INTEGER,
  segments_json TEXT,
  next_section_index INTEGER DEFAULT 0,
  char_count INTEGER DEFAULT 0,
  parent_job_id TEXT,
  price_estimate_eur REAL,
  processing_started_at INTEGER,
  generation_started_at INTEGER
);

CREATE INDEX idx_jobs_user_id ON jobs (user_id);
CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_created_at ON jobs (created_at DESC);
CREATE INDEX idx_jobs_not_deleted ON jobs (user_id, created_at DESC) WHERE deleted_at IS NULL;

-- ==================== USAGE LOGS ====================
CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  action TEXT NOT NULL,
  chars_processed INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
