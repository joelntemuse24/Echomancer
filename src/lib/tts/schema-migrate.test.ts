import { describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/harness";
import { execute, query } from "@/lib/turso";
import {
  ensureTtsJobColumns,
  resetSchemaMigrationCache,
} from "@/lib/tts/schema-migrate";

describe("ensureTtsJobColumns", () => {
  it("is a no-op hot path when the live schema is already current", async () => {
    await resetDatabase();
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it("does not take the hot path when idx_users_google_sub is missing", async () => {
    await resetDatabase();
    await execute(`DROP INDEX IF EXISTS idx_users_google_sub`);
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it("does not take the hot path when jobs.stream_timeline_json is missing", async () => {
    await resetDatabase();
    await execute(`ALTER TABLE jobs DROP COLUMN stream_timeline_json`);
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");
    const cols = await query<{ name: string }>(`SELECT name FROM pragma_table_info('jobs')`);
    expect(cols.map((col) => col.name)).toContain("stream_timeline_json");
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it("does not take the hot path when jobs.first_section_at is missing", async () => {
    // The ETA measures throughput from the first finished section; without the
    // column every estimate silently falls back to the startup-inclusive clock.
    await resetDatabase();
    await execute(`ALTER TABLE jobs DROP COLUMN first_section_at`);
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");
    const cols = await query<{ name: string }>(`SELECT name FROM pragma_table_info('jobs')`);
    expect(cols.map((col) => col.name)).toContain("first_section_at");
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it.each(["phase", "accept_quality_risk"])(
    "does not take the hot path when youtube_clips.%s is missing",
    async (column) => {
      await resetDatabase();
      await execute(`ALTER TABLE youtube_clips DROP COLUMN ${column}`);
      resetSchemaMigrationCache();
      expect(await ensureTtsJobColumns()).toBe("migrated");
      const cols = await query<{ name: string }>(
        `SELECT name FROM pragma_table_info('youtube_clips')`
      );
      expect(cols.map((col) => col.name)).toContain(column);
    }
  );

  it("does not take the hot path when cloned_voices.reference_transcript is missing", async () => {
    // Production shape on 2026-10-25: every older clone column present, the
    // new one absent. The check counted a hardcoded six, so it passed as
    // current and every clone query failed with "no such column".
    await resetDatabase();
    await execute(`ALTER TABLE cloned_voices DROP COLUMN reference_transcript`);
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");
    const cols = await query<{ name: string }>(
      `SELECT name FROM pragma_table_info('cloned_voices')`
    );
    expect(cols.map((col) => col.name)).toContain("reference_transcript");
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it.each([
    "accent",
    "source_kind",
    "source_url",
    "source_start_sec",
    "source_end_sec",
    "source_consented_at",
  ])("does not take the hot path when cloned_voices.%s is missing", async (column) => {
    // No clone column may be omitted from the check again.
    await resetDatabase();
    await execute(`ALTER TABLE cloned_voices DROP COLUMN ${column}`);
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");
    const cols = await query<{ name: string }>(
      `SELECT name FROM pragma_table_info('cloned_voices')`
    );
    expect(cols.map((col) => col.name)).toContain(column);
  });

  it("adds users.email_verified to a users table created before that column", async () => {
    await resetDatabase();
    await execute(`DROP TABLE users`);
    await execute(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        google_sub TEXT NOT NULL UNIQUE,
        email TEXT,
        name TEXT,
        image TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    await execute(`CREATE UNIQUE INDEX idx_users_google_sub ON users (google_sub)`);
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");

    const cols = await query<{ name: string }>(
      `SELECT name FROM pragma_table_info('users')`
    );
    expect(cols.map((col) => col.name)).toContain("email_verified");

    const { completeGoogleSignIn } = await import("@/lib/auth/google");
    const { user } = await completeGoogleSignIn({
      googleSub: "108000000000000000042",
      email: "joel@example.com",
      emailVerified: true,
    });
    expect(user.email_verified).toBe(1);

    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it("adds cloned_voices.accent and defaults existing rows to american", async () => {
    await resetDatabase();
    await execute(`DROP TABLE cloned_voices`);
    await execute(`
      CREATE TABLE cloned_voices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        fish_voice_id TEXT NOT NULL,
        title TEXT NOT NULL,
        sample_storage_path TEXT,
        state TEXT NOT NULL DEFAULT 'trained',
        model TEXT NOT NULL DEFAULT 's2.1-pro-free',
        created_at INTEGER DEFAULT (unixepoch()),
        deleted_at INTEGER
      )
    `);
    await execute(
      `INSERT INTO cloned_voices (id, user_id, fish_voice_id, title, state, model)
       VALUES ('shauna', 'user_joel', 'fish-shauna', 'Shauna', 'trained', 's2.1-pro-free')`
    );
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");

    const cols = await query<{ name: string }>(
      `SELECT name FROM pragma_table_info('cloned_voices')`
    );
    expect(cols.map((col) => col.name)).toContain("accent");
    expect(cols.map((col) => col.name)).toContain("source_url");
    expect(cols.map((col) => col.name)).toContain("source_consented_at");
    const row = await query<{ accent: string }>(
      `SELECT accent FROM cloned_voices WHERE id = 'shauna'`
    );
    expect(row[0]?.accent).toBe("american");

    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it("rebuilds a narrow jobs status check and keeps the rows", async () => {
    await resetDatabase();
    await execute(`DROP TABLE jobs`);
    await execute(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'anonymous',
        book_title TEXT NOT NULL DEFAULT 'Untitled',
        pdf_storage_path TEXT NOT NULL,
        status TEXT DEFAULT 'queued'
          CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
        job_kind TEXT DEFAULT 'takehome',
        deleted_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    await execute(
      `INSERT INTO jobs (id, user_id, book_title, pdf_storage_path, status, job_kind)
       VALUES ('keep-me', 'user_a', 'Kept title', 'pdfs/keep/content.txt', 'ready', 'takehome')`
    );
    await execute(
      `INSERT INTO uploads (id, user_id, storage_path, status)
       VALUES ('up-extracting', 'user_a', 'pdfs/reading/content.txt', 'extracting')`
    );
    await execute(
      `INSERT INTO jobs (id, user_id, book_title, pdf_storage_path, status, job_kind)
       VALUES ('park-me', 'user_a', 'Still reading', 'pdfs/reading/content.txt', 'queued', 'takehome')`
    );
    await execute(
      `INSERT INTO uploads (id, user_id, storage_path, status)
       VALUES ('up-ready', 'user_a', 'pdfs/ready/content.txt', 'ready')`
    );
    await execute(
      `INSERT INTO jobs (id, user_id, book_title, pdf_storage_path, status, job_kind)
       VALUES ('leave-me', 'user_a', 'Ready book', 'pdfs/ready/content.txt', 'queued', 'takehome')`
    );
    await expect(
      execute(`UPDATE jobs SET status = 'cancelled' WHERE id = 'keep-me'`)
    ).rejects.toThrow(/CHECK/i);

    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("migrated");

    const kept = await query<{ book_title: string; status: string }>(
      `SELECT book_title, status FROM jobs WHERE id = 'keep-me'`
    );
    expect(kept[0]).toEqual({ book_title: "Kept title", status: "ready" });
    const parked = await query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = 'park-me'`
    );
    expect(parked[0]?.status).toBe("waiting");
    const left = await query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = 'leave-me'`
    );
    expect(left[0]?.status).toBe("queued");

    await execute(
      `UPDATE jobs SET status = 'cancelled' WHERE id = 'keep-me'`
    );
    await execute(`UPDATE jobs SET status = 'waiting' WHERE id = 'leave-me'`);
    const after = await query<{ id: string; status: string }>(
      `SELECT id, status FROM jobs WHERE id IN ('keep-me', 'leave-me') ORDER BY id`
    );
    expect(after).toEqual([
      { id: "keep-me", status: "cancelled" },
      { id: "leave-me", status: "waiting" },
    ]);

    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });
});
