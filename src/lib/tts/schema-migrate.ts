/**
 * Best-effort additive migrations for multi-provider TTS columns.
 * Safe to call on job create / process (idempotent ALTERs).
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
];

export async function ensureTtsJobColumns(): Promise<void> {
  if (migrated) return;

  try {
    // Verify the jobs table exists before attempting ALTERs
    const tableCheck = await queryOne<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1`
    );
    if (!tableCheck) {
      // Table doesn't exist yet — don't mark as migrated
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
