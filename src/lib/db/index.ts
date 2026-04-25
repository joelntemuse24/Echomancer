import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_DIR = process.env.DB_PATH || "./data";
const DB_PATH = path.join(DB_DIR, "echomancer.db");

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  // Ensure data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  // Create database instance
  dbInstance = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  dbInstance.pragma("journal_mode = WAL");

  // Initialize schema
  initDb(dbInstance);

  return dbInstance;
}

function initDb(db: Database.Database) {
  // Jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'anonymous',
      book_title TEXT NOT NULL DEFAULT 'Untitled',
      pdf_storage_path TEXT NOT NULL,
      voice_storage_path TEXT,
      voice_name TEXT,
      video_id TEXT,
      start_time INTEGER DEFAULT 0,
      end_time INTEGER DEFAULT 30,
      status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
      progress INTEGER DEFAULT 0,
      current_section INTEGER DEFAULT 0,
      total_sections INTEGER DEFAULT 0,
      audio_storage_path TEXT,
      duration_seconds INTEGER,
      error_message TEXT,
      duplicate_of TEXT,
      deleted_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Voices table
  db.exec(`
    CREATE TABLE IF NOT EXISTS voices (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL DEFAULT 'anonymous',
      name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      source TEXT DEFAULT 'upload' CHECK (source IN ('youtube', 'upload')),
      source_video_id TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Usage logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL DEFAULT 'anonymous',
      action TEXT NOT NULL,
      chars_processed INTEGER DEFAULT 0,
      duration_seconds INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs (user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_not_deleted ON jobs (user_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_voices_user_id ON voices (user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs (user_id);
  `);

  console.log("✓ SQLite database initialized at", DB_PATH);
}

// Export the database getter
export const db = getDb();
