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
    CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'cancelled', 'waiting')),
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
  -- Measured per-window audio time for the live read-along
  stream_timeline_json TEXT,
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
  generation_started_at INTEGER,
  -- Drain skips a book until this unix time. Null means eligible now.
  sched_not_before INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_takehome_queue ON jobs (job_kind, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_takehome_due ON jobs (job_kind, status, sched_not_before);
CREATE INDEX IF NOT EXISTS idx_jobs_takehome_active ON jobs (job_kind, status, lease_expires_at);

-- One live take-home per user + upload + narrator. Not a UNIQUE index on
-- jobs: historical duplicate rows stay. A failed or cancelled book releases
-- the key so a later create may insert. See src/lib/jobs/takehome-identity.ts.
CREATE TABLE IF NOT EXISTS takehome_create_keys (
  idem_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  committed INTEGER NOT NULL DEFAULT 0,
  reserved_until INTEGER NOT NULL DEFAULT 0
);

-- Shared Fish / Edge / Modal-clone permits. Slot ids are 0..cap-1.
-- Expired rows are stolen by the next acquire. No sweeper.
CREATE TABLE IF NOT EXISTS provider_slots (
  provider TEXT NOT NULL,
  slot_id INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  job_id TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (provider, slot_id)
);

-- User round-robin clock for the take-home drain. Same-user ties still
-- follow jobs.updated_at.
CREATE TABLE IF NOT EXISTS takehome_fairness (
  user_id TEXT PRIMARY KEY,
  last_served_at INTEGER NOT NULL
);

-- Shared Edge 429 cap. Expired rows are ignored. No sweeper.
CREATE TABLE IF NOT EXISTS provider_throttle (
  provider TEXT PRIMARY KEY,
  cap INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- CPU work (extract, master, whisper, concat). Claim steals only an
-- expired lease. Input and output are object keys.
CREATE TABLE IF NOT EXISTS cpu_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  job_id TEXT,
  upload_id TEXT,
  section_index INTEGER,
  status TEXT NOT NULL,
  owner_token TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_path TEXT,
  output_path TEXT,
  payload_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  placed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  deadline_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cpu_tasks_status ON cpu_tasks (status, created_at);
CREATE INDEX IF NOT EXISTS idx_cpu_tasks_job ON cpu_tasks (job_id, status);
CREATE INDEX IF NOT EXISTS idx_cpu_tasks_lease ON cpu_tasks (status, lease_expires_at);
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

-- ==================== CLONED VOICES ====================
-- Fish Audio voice clones owned by a session. fish_voice_id is the Fish
-- reference_id used at synthesis time via the direct Fish adapter.
CREATE TABLE IF NOT EXISTS cloned_voices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  fish_voice_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sample_storage_path TEXT,
  state TEXT NOT NULL DEFAULT 'trained',
  model TEXT NOT NULL DEFAULT 's2.1-pro-free',
  accent TEXT NOT NULL DEFAULT 'american',
  created_at INTEGER DEFAULT (unixepoch()),
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cloned_voices_user_id ON cloned_voices (user_id);
CREATE INDEX IF NOT EXISTS idx_cloned_voices_user_created ON cloned_voices (user_id, created_at DESC);

-- ==================== CLONE SAMPLE UPLOADS ====================
-- Pending ownership for a voice-clone sample PUT to clones/<id>/…
-- Complete reads the object and inserts cloned_voices (same id).
CREATE TABLE IF NOT EXISTS clone_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sample_storage_path TEXT NOT NULL,
  file_name TEXT,
  content_type TEXT,
  byte_size INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  cloned_voice_id TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_clone_uploads_user_id ON clone_uploads (user_id);

-- ==================== USERS ====================
-- Durable Google accounts. `id` is our `user_*` — never the Google subject.
-- Safe on an existing production database: IF NOT EXISTS, no drops.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  image TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Single-use email sign-in links (SHA-256 of the token only).
CREATE TABLE IF NOT EXISTS email_login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_email_login_tokens_expires ON email_login_tokens (expires_at);

-- Shared YouTube search hits (10 minutes). Stops a repeated query from
-- calling search.list again across serverless isolates.
CREATE TABLE IF NOT EXISTS youtube_search_cache (
  query_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Proxied YouTube section downloads. Claimed one at a time on the worker.
CREATE TABLE IF NOT EXISTS youtube_clips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  start_seconds REAL NOT NULL,
  length_seconds REAL NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  bytes_proxy INTEGER NOT NULL DEFAULT 0,
  apify_run_id TEXT,
  apify_usd REAL NOT NULL DEFAULT 0,
  r2_key TEXT,
  consent_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_youtube_clips_queue ON youtube_clips (status, created_at);
CREATE INDEX IF NOT EXISTS idx_youtube_clips_user_day ON youtube_clips (user_id, created_at);

-- ==================== RATE LIMITS ====================
-- Shared counters; in-process maps enforce nothing across serverless isolates.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  identifier TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (key, identifier)
);
