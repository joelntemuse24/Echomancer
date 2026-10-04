/**
 * Runtime schema guard.
 *
 * Echomancer has no separate migrator service: every request path that touches
 * the database calls {@link ensureTtsJobColumns} first, which creates missing
 * tables and adds missing columns. Column adds stay additive and idempotent.
 * The one exception is a jobs-table rebuild when an existing `status` CHECK
 * rejects `waiting` or `cancelled`: SQLite cannot alter a CHECK, so the
 * migrator copies every row into a new table and renames it. That copy runs
 * inside a write transaction and does not drop rows.
 *
 * `migrate-turso.sql` is the same schema expressed for a fresh database.
 * `users` is additive: `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE ADD
 * COLUMN` for a table that already existed without `google_sub` (Auth.js-shaped
 * leftovers). `clone_uploads` is the pending-ownership row for a voice-clone
 * sample PUT to `clones/<id>/…`.
 */

import { execute, executeBatch, query, queryOne } from "@/lib/turso";

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
  { name: "warning", def: "TEXT" },
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
  extract_started_at INTEGER,
  extract_host TEXT,
  extract_attempts INTEGER DEFAULT 0,
  extract_accepted_at INTEGER
)`;

const UPLOAD_COLUMNS: { name: string; def: string }[] = [
  { name: "status", def: "TEXT DEFAULT 'ready'" },
  { name: "error_message", def: "TEXT" },
  { name: "content_type", def: "TEXT" },
  { name: "extract_started_at", def: "INTEGER" },
  { name: "extract_host", def: "TEXT" },
  { name: "extract_attempts", def: "INTEGER DEFAULT 0" },
  { name: "extract_accepted_at", def: "INTEGER" },
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
  accent TEXT NOT NULL DEFAULT 'american',
  source_kind TEXT,
  source_url TEXT,
  source_start_sec REAL,
  source_end_sec REAL,
  source_consented_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  deleted_at INTEGER
)`;

/**
 * Additive columns for a pre-existing `cloned_voices` table.
 * `accent` is the catalog label (american / british / australian / irish).
 * Existing rows pick up DEFAULT 'american' so current clones stay American
 * until an owner PATCH or a direct UPDATE sets another accent.
 */
const CLONED_VOICE_COLUMNS: { name: string; def: string }[] = [
  { name: "accent", def: "TEXT NOT NULL DEFAULT 'american'" },
  { name: "source_kind", def: "TEXT" },
  { name: "source_url", def: "TEXT" },
  { name: "source_start_sec", def: "REAL" },
  { name: "source_end_sec", def: "REAL" },
  { name: "source_consented_at", def: "INTEGER" },
];

/**
 * Pending clone-sample PUT. The browser uploads to R2; complete reads the
 * object and inserts `cloned_voices`. Same id as the eventual clone row.
 */
const CREATE_CLONE_UPLOADS_SQL = `
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

/**
 * Single-use email sign-in links. Only the SHA-256 of the token is stored, so a
 * database read cannot be replayed as a login.
 */
const CREATE_EMAIL_LOGIN_TOKENS_SQL = `
CREATE TABLE IF NOT EXISTS email_login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
)`;

/**
 * Shared YouTube search hits. In-memory maps reset on every Vercel isolate, so
 * a repeated query would otherwise call search.list again (100 quota units).
 */
const CREATE_YOUTUBE_SEARCH_CACHE_SQL = `
CREATE TABLE IF NOT EXISTS youtube_search_cache (
  query_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;

/** Proxied YouTube section clips. One worker claims a queued row at a time. */
const CREATE_YOUTUBE_CLIPS_SQL = `
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
  finished_at INTEGER,
  phase TEXT,
  title TEXT
)`;

/** Quiet progress on a clip the worker is already running; source length picks the Apify actor. */
const CLIP_COLUMNS: { name: string; def: string }[] = [
  { name: "phase", def: "TEXT" },
  { name: "video_seconds", def: "REAL" },
  { name: "title", def: "TEXT" },
];

/**
 * Additive columns for a pre-existing `users` table.
 * CREATE_USERS_SQL uses `google_sub TEXT NOT NULL UNIQUE` and
 * `created_at INTEGER DEFAULT (unixepoch())`. SQLite forbids UNIQUE,
 * NOT NULL-without-default, and non-constant defaults on ADD COLUMN, so
 * ALTER uses nullable TEXT / bare INTEGER. Uniqueness is idx_users_google_sub.
 */
const USER_COLUMNS: { name: string; def: string }[] = [
  { name: "google_sub", def: "TEXT" },
  { name: "email", def: "TEXT" },
  { name: "name", def: "TEXT" },
  { name: "image", def: "TEXT" },
  { name: "created_at", def: "INTEGER" },
  { name: "email_verified", def: "INTEGER" },
];

async function addMissingColumns(
  table: "jobs" | "uploads" | "users" | "cloned_voices" | "youtube_clips",
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
  `CREATE INDEX IF NOT EXISTS idx_clone_uploads_user_id ON clone_uploads (user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)`,
  `CREATE INDEX IF NOT EXISTS idx_email_login_tokens_expires ON email_login_tokens (expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_clips_queue ON youtube_clips (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_clips_user_day ON youtube_clips (user_id, created_at)`,
];

const USER_COLUMN_NAMES_SQL = USER_COLUMNS.map((c) => `'${c.name}'`).join(", ");

const SCHEMA_CURRENT_SQL = `
SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (
    'jobs', 'uploads', 'usage_logs', 'cloned_voices', 'clone_uploads',
    'fish_inflight', 'users', 'email_login_tokens', 'youtube_search_cache',
    'youtube_clips'
  )) AS tables_ok,
  (SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name = 'generation_started_at') AS jobs_col,
  (SELECT COUNT(*) FROM pragma_table_info('uploads') WHERE name IN (
    'extract_started_at', 'extract_host', 'extract_attempts', 'extract_accepted_at'
  )) AS uploads_col,
  (SELECT COUNT(*) FROM pragma_table_info('users') WHERE name IN (${USER_COLUMN_NAMES_SQL})) AS users_col,
  (SELECT COUNT(*) FROM pragma_table_info('cloned_voices') WHERE name IN (
    'accent', 'source_kind', 'source_url', 'source_start_sec', 'source_end_sec', 'source_consented_at'
  )) AS clones_col,
  (SELECT COUNT(*) FROM pragma_table_info('youtube_clips') WHERE name IN ('phase', 'video_seconds', 'title')) AS clips_phase,
  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_google_sub') AS users_idx
`;

/**
 * A missing CHECK accepts every status. A CHECK that omits `waiting` or
 * `cancelled` is the production table: cancel returns 500, and a parked
 * take-home cannot leave `queued` without a rebuild.
 */
export function jobsStatusCheckAllows(sql: string | null | undefined): boolean {
  if (!sql) return false;
  if (!/CHECK\s*\(/i.test(sql)) return true;
  return sql.includes("'waiting'") && sql.includes("'cancelled'");
}

interface JobsColumnInfo {
  name: string;
  type: string | null;
  nn: number;
  dflt_value: string | number | null;
  pk: number;
}

function quoteJobsIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`[schema-migrate] unexpected jobs column ${name}`);
  }
  return `"${name}"`;
}

function jobsDefaultClause(value: string | number | null): string {
  if (value == null) return "";
  const text = String(value);
  if (/^[-\d.]+$/.test(text) || /^'(?:[^']|'')*'$/.test(text)) {
    return ` DEFAULT ${text}`;
  }
  if (/^\(?unixepoch\(\)\)?$/i.test(text)) return " DEFAULT (unixepoch())";
  if (/^NULL$/i.test(text)) return " DEFAULT NULL";
  throw new Error(`[schema-migrate] unexpected jobs default ${text}`);
}

function jobsColumnDef(col: JobsColumnInfo): string {
  const type = col.type && /^[A-Za-z0-9_ ]+$/.test(col.type) ? col.type : "TEXT";
  const parts = [quoteJobsIdent(col.name), type];
  if (Number(col.pk) === 1) {
    parts.push("PRIMARY KEY");
  } else if (Number(col.nn) === 1) {
    parts.push("NOT NULL");
  }
  if (Number(col.pk) !== 1) parts.push(jobsDefaultClause(col.dflt_value).trim());
  if (col.name === "status") {
    parts.push(
      "CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'cancelled', 'waiting'))"
    );
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * Copy `jobs` onto a table whose status CHECK allows `waiting` and
 * `cancelled`. Rows, column values, and existing indexes are kept.
 */
async function widenJobsStatusCheck(): Promise<void> {
  const current = await queryOne<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`
  );
  if (jobsStatusCheckAllows(current?.sql)) return;

  const cols = await query<JobsColumnInfo>(
    `SELECT name, type, "notnull" AS nn, dflt_value, pk
     FROM pragma_table_info('jobs') ORDER BY cid`
  );
  if (cols.length === 0) return;
  const primaryKeys = cols.filter((col) => Number(col.pk) > 0);
  if (primaryKeys.length !== 1) {
    throw new Error("[schema-migrate] jobs primary key is not a single column");
  }

  const indexes = await query<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master
     WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL`
  );
  const defs = cols.map((col) => jobsColumnDef(col)).join(",\n  ");
  const names = cols.map((col) => quoteJobsIdent(col.name)).join(", ");
  // One write batch, not client.transaction(): that helper drops the
  // connection, and an in-memory database would come back empty.
  const statements: { sql: string }[] = [
    { sql: `DROP TABLE IF EXISTS jobs_status_rebuild` },
    { sql: `CREATE TABLE jobs_status_rebuild (\n  ${defs}\n)` },
    {
      sql: `INSERT INTO jobs_status_rebuild (${names}) SELECT ${names} FROM jobs`,
    },
    { sql: `DROP TABLE jobs` },
    { sql: `ALTER TABLE jobs_status_rebuild RENAME TO jobs` },
  ];
  for (const index of indexes) {
    if (index.sql) statements.push({ sql: index.sql });
  }
  await executeBatch(statements);
  console.info(
    "[schema-migrate] rebuilt jobs so status allows waiting and cancelled"
  );
}

/**
 * Take-homes still marked `queued` while their file is unread are visible to
 * the deployed Trigger drain. Move them to `waiting` once that status is legal.
 */
async function parkTakehomesWaitingOnText(): Promise<void> {
  const parked = await execute(
    `UPDATE jobs SET status = 'waiting', updated_at = unixepoch()
     WHERE deleted_at IS NULL
       AND job_kind = 'takehome'
       AND status = 'queued'
       AND pdf_storage_path IN (
         SELECT storage_path FROM uploads
         WHERE status IN ('pending', 'uploaded', 'extracting')
       )`
  );
  if (parked.rowsAffected > 0) {
    console.info(
      `[schema-migrate] parked ${parked.rowsAffected} take-home job(s) as waiting`
    );
  }
}

async function schemaAlreadyCurrent(): Promise<boolean> {
  try {
    const row = await queryOne<{
      tables_ok: number;
      jobs_col: number;
      uploads_col: number;
      users_col: number;
      clones_col: number;
      clips_phase: number;
      users_idx: number;
    }>(SCHEMA_CURRENT_SQL);
    const jobsDdl = await queryOne<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`
    );
    return (
      Number(row?.tables_ok || 0) >= 10 &&
      Number(row?.jobs_col || 0) >= 1 &&
      Number(row?.uploads_col || 0) >= 4 &&
      Number(row?.users_col || 0) >= USER_COLUMNS.length &&
      Number(row?.clones_col || 0) >= 6 &&
      Number(row?.clips_phase || 0) >= 3 &&
      Number(row?.users_idx || 0) >= 1 &&
      jobsStatusCheckAllows(jobsDdl?.sql)
    );
  } catch {
    return false;
  }
}

export async function ensureTtsJobColumns(): Promise<"hot" | "migrated"> {
  if (migrated) return "hot";

  try {
    if (await schemaAlreadyCurrent()) {
      migrated = true;
      return "hot";
    }

    try {
      await executeBatch([
        { sql: CREATE_JOBS_SQL },
        { sql: CREATE_UPLOADS_SQL },
        { sql: CREATE_USAGE_LOGS_SQL },
        { sql: CREATE_CLONED_VOICES_SQL },
        { sql: CREATE_CLONE_UPLOADS_SQL },
        { sql: CREATE_FISH_INFLIGHT_SQL },
        { sql: CREATE_USERS_SQL },
        { sql: CREATE_EMAIL_LOGIN_TOKENS_SQL },
        { sql: CREATE_YOUTUBE_SEARCH_CACHE_SQL },
        { sql: CREATE_YOUTUBE_CLIPS_SQL },
      ]);
    } catch {
      await execute(CREATE_JOBS_SQL);
      await execute(CREATE_UPLOADS_SQL);
      await execute(CREATE_USAGE_LOGS_SQL);
      await execute(CREATE_CLONED_VOICES_SQL);
      await execute(CREATE_CLONE_UPLOADS_SQL);
      await execute(CREATE_FISH_INFLIGHT_SQL);
      await execute(CREATE_USERS_SQL);
      await execute(CREATE_EMAIL_LOGIN_TOKENS_SQL);
      await execute(CREATE_YOUTUBE_SEARCH_CACHE_SQL);
      await execute(CREATE_YOUTUBE_CLIPS_SQL);
    }

    const tableCheck = await queryOne<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1`
    );
    if (!tableCheck) {
      console.error("[schema-migrate] jobs table still missing after CREATE");
      return "migrated";
    }

    let allOk = true;
    allOk =
      (await addMissingColumns("jobs", JOB_COLUMNS)) && allOk;
    allOk =
      (await addMissingColumns("uploads", UPLOAD_COLUMNS)) && allOk;
    allOk =
      (await addMissingColumns("users", USER_COLUMNS)) && allOk;
    allOk =
      (await addMissingColumns("cloned_voices", CLONED_VOICE_COLUMNS)) && allOk;
    allOk =
      (await addMissingColumns("youtube_clips", CLIP_COLUMNS)) && allOk;

    if (allOk) {
      await widenJobsStatusCheck();
      await parkTakehomesWaitingOnText();
    }

    // Indexes after ADD COLUMN so idx_users_google_sub can see the new field.
    await executeBatch(INDEXES.map((sql) => ({ sql }))).catch(async () => {
      for (const sql of INDEXES) {
        await execute(sql).catch(() => {});
      }
    });

    if (allOk) migrated = true;
    return "migrated";
  } catch (err) {
    // Leave `migrated` false so the next request retries.
    console.error("[schema-migrate] failed:", err);
    return "migrated";
  }
}

/** Test seam: forget that migration already ran. */
export function resetSchemaMigrationCache(): void {
  migrated = false;
}
