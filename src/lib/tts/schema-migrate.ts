/**
 * Best-effort additive migrations for multi-provider TTS columns.
 * Safe to call on job create / process (idempotent CREATE + ALTERs).
 */

import { execute, queryOne } from "@/lib/turso";

let migrated = false;

const COLUMNS: { name: string; def: string }[] = [
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
  { name: "total_sections", def: "INTEGER" },
  { name: "current_section", def: "INTEGER" },
  { name: "audio_storage_path", def: "TEXT" },
  { name: "error_message", def: "TEXT" },
  { name: "deleted_at", def: "INTEGER" },
  { name: "voice_storage_path", def: "TEXT" },
  { name: "video_id", def: "TEXT" },
  { name: "start_time", def: "INTEGER DEFAULT 0" },
  { name: "end_time", def: "INTEGER DEFAULT 30" },
  { name: "duration_seconds", def: "INTEGER" },
];

const CREATE_JOBS_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
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
  processing_started_at INTEGER
)`;

export async function ensureTtsJobColumns(): Promise<void> {
  if (migrated) return;

  try {
    // Create jobs table if missing (fresh deploys / empty Turso DBs)
    await execute(CREATE_JOBS_SQL);
    await execute(
      `CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id)`
    ).catch(() => {});
    await execute(
      `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status)`
    ).catch(() => {});
    await execute(
      `CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC)`
    ).catch(() => {});

    const tableCheck = await queryOne<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1`
    );
    if (!tableCheck) {
      console.error("[schema-migrate] jobs table still missing after CREATE");
      return;
    }

    // Check existing columns to avoid unnecessary ALTER attempts
    const existingCols = await queryOne<{ cols: string }>(
      `SELECT GROUP_CONCAT(name) as cols FROM pragma_table_info('jobs')`
    );
    const existingSet = new Set(
      (existingCols?.cols || "").split(",").map((s) => s.trim())
    );

    let allOk = true;
    for (const col of COLUMNS) {
      if (existingSet.has(col.name)) continue;
      try {
        await execute(`ALTER TABLE jobs ADD COLUMN ${col.name} ${col.def}`);
      } catch (err) {
        // Ignore duplicate-column errors (concurrent migration)
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column/i.test(msg)) {
          allOk = false;
          console.error(`[schema-migrate] ALTER ${col.name} failed:`, msg);
        }
      }
    }

    if (allOk) migrated = true;
  } catch (err) {
    // Don't set migrated=true on failure — allow retry on next request
    console.error("[schema-migrate] failed:", err);
  }
}
