/**
 * Runtime schema guard.
 *
 * Echomancer has no separate migrator service: every request path that touches
 * the database calls {@link ensureTtsJobColumns} first, which creates missing
 * tables and adds missing columns. Everything here must therefore be additive
 * and idempotent — never destructive — because it runs against live production
 * data on an ordinary request.
 *
 * `migrate-turso.sql` is the same schema expressed for a fresh database.
 * `users` is additive (`CREATE TABLE IF NOT EXISTS`) and safe on the existing
 * production schema — `jobs.user_id` already exists.
 */

import { execute, queryOne } from "@/lib/turso";

let migrated = false;

const JOB_COLUMNS: { name: string; def: string }[] = [
  { name: "generation_mode", def: "TEXT DEFAULT 'stock'" },
  { name: "job_kind", def: "TEXT DEFAULT 'takehome'" },
  { name: "tts_provider", def: "TEXT" },
  { name: "provider_voice_id", def: "TEXT" },
  { name: "catalog_voice_id", def: "TEXT" },
  { name: "tts_options", def: "TEXT" },
  { name: "stream_cursor", def: "INTEGER DEFAULT 0" },
  { name: "stream_chars_used", def: "INTEGER DEFAULT 0" },
  { name: "stream_max_chars", def: "INTEGER" },
  { name: "segments_json", def: "TEXT" },
  { name: "next_section_index", def: "INTEGER DEFAULT 0" },
  { name: "char_count", def: "INTEGER DEFAULT 0" },
  { name: "parent_job_id", def: "TEXT" },
  { name: "price_estimate_eur", def: "REAL" },
  { name: "processing_started_at", def: "INTEGER" },
  { name: "processing_lease_token", def: "TEXT" },
  { name: "lease_expires_at", def: "INTEGER" },
  { name: "total_sections", def: "INTEGER" },
  { name: "current_section", def: "INTEGER" },
  { name: "audio_storage_path", def: "TEXT" },
  { name: "error_message", def: "TEXT" },
  { name: "deleted_at", def: "INTEGER" },
  { name: "duration_seconds", def: "INTEGER" },
  { name: "generation_started_at", def: "INTEGER" },
];

const CREATE_JOBS_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  book_title TEXT NOT NULL DEFAULT 'Untitled',
  voice_name TEXT DEFAULT 'Narrator',
  pdf_storage_path TEXT NOT NULL,
  audio_storage_path TEXT,
  status TEXT DEFAULT 'queued',
  progress INTEGER DEFAULT 0,
  current_section INTEGER DEFAULT 0,
  total_sections INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  error_message TEXT,
  deleted_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
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
  processing_lease_token TEXT,
  lease_expires_at INTEGER,
  generation_started_at INTEGER
)`;

/**
 * Ownership record for an uploaded document. Job creation refuses any
 * `pdfStoragePath` that does not appear here for the calling session, which is
 * what stops one visitor from narrating (and being billed for) another
 * visitor's upload.
 */
const CREATE_UPLOADS_SQL = `
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  source_path TEXT,
  file_name TEXT,
  format TEXT,
  byte_size INTEGER DEFAULT 0,
  char_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  status TEXT DEFAULT 'ready',
  error_message TEXT,
  content_type TEXT,
  extract_started_at INTEGER
)`;

const UPLOAD_COLUMNS: { name: string; def: string }[] = [
  { name: "status", def: "TEXT DEFAULT 'ready'" },
  { name: "error_message", def: "TEXT" },
  { name: "content_type", def: "TEXT" },
  { name: "extract_started_at", def: "INTEGER" },
];

const CREATE_USAGE_LOGS_SQL = `
CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  action TEXT NOT NULL,
  chars_processed INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
)`;

/**
 * Per-session Fish Audio voice clones. `fish_voice_id` is the Fish
 * `reference_id` used at synthesis time via the direct Fish adapter.
 */
const CREATE_CLONED_VOICES_SQL = `
CREATE TABLE IF NOT EXISTS cloned_voices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  fish_voice_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sample_storage_path TEXT,
  state TEXT NOT NULL DEFAULT 'trained',
  model TEXT NOT NULL DEFAULT 's2.1-pro-free',
  created_at INTEGER DEFAULT (unixepoch()),
  deleted_at INTEGER
)`;

/**
 * Best-effort live Fish inflight leases so take-home can leave a concurrency
 * slot for Live Listen / Live Stream on the same FISH_API_KEY.
 */
const CREATE_FISH_INFLIGHT_SQL = `
CREATE TABLE IF NOT EXISTS fish_inflight (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;

/**
 * Durable Google accounts. `id` is our `user_*` — never the Google `sub`.
 * Additive and idempotent; existing `jobs.user_id` values stay valid.
 */
const CREATE_USERS_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  image TEXT,
  created_at INTEGER DEFAULT (unixepoch())
)`;

async function addMissingColumns(
  table: "jobs" | "uploads",
  columns: { name: string; def: string }[]
): Promise<boolean> {
  const existingCols = await queryOne<{ cols: string }>(
    `SELECT GROUP_CONCAT(name) as cols FROM pragma_table_info('${table}')`
  );
  const existingSet = new Set(
    (existingCols?.cols || "").split(",").map((s) => s.trim())
  );

  let allOk = true;
  for (const col of columns) {
    if (existingSet.has(col.name)) continue;
    try {
      await execute(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.def}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Concurrent requests race on the same ALTER; a duplicate is success.
      if (!/duplicate column/i.test(msg)) {
        allOk = false;
        console.error(`[schema-migrate] ALTER ${table}.${col.name} failed:`, msg);
      }
    }
  }
  return allOk;
}

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_pdf_path ON jobs (pdf_storage_path)`,
  `CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_uploads_storage_path ON uploads (storage_path)`,
  `CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads (status)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cloned_voices_user_id ON cloned_voices (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cloned_voices_user_created ON cloned_voices (user_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)`,
];

export async function ensureTtsJobColumns(): Promise<void> {
  if (migrated) return;

  try {
    await execute(CREATE_JOBS_SQL);
    await execute(CREATE_UPLOADS_SQL);
    await execute(CREATE_USAGE_LOGS_SQL);
    await execute(CREATE_CLONED_VOICES_SQL);
    await execute(CREATE_FISH_INFLIGHT_SQL);
    await execute(CREATE_USERS_SQL);

    for (const sql of INDEXES) {
      await execute(sql).catch(() => {});
    }

    const tableCheck = await queryOne<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1`
    );
    if (!tableCheck) {
      console.error("[schema-migrate] jobs table still missing after CREATE");
      return;
    }

    let allOk = true;
    allOk =
      (await addMissingColumns("jobs", JOB_COLUMNS)) && allOk;
    allOk =
      (await addMissingColumns("uploads", UPLOAD_COLUMNS)) && allOk;

    if (allOk) migrated = true;
  } catch (err) {
    // Leave `migrated` false so the next request retries.
    console.error("[schema-migrate] failed:", err);
  }
}

/** Test seam: forget that migration already ran. */
export function resetSchemaMigrationCache(): void {
  migrated = false;
}
