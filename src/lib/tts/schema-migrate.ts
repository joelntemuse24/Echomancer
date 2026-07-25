/**
 * Best-effort additive migrations for multi-provider TTS columns.
 * Safe to call on job create / process (idempotent ALTERs).
 */

import { execute } from "@/lib/turso";

let migrated = false;

const COLUMNS: { name: string; def: string }[] = [
  { name: "generation_mode", def: "TEXT DEFAULT 'clone'" },
  { name: "job_kind", def: "TEXT DEFAULT 'clone'" },
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
];

export async function ensureTtsJobColumns(): Promise<void> {
  if (migrated) return;
  for (const col of COLUMNS) {
    try {
      await execute(`ALTER TABLE jobs ADD COLUMN ${col.name} ${col.def}`);
    } catch {
      // Column already exists or table missing — ignore
    }
  }
  migrated = true;
}
