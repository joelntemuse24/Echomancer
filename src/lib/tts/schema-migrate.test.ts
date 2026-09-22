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
    const row = await query<{ accent: string }>(
      `SELECT accent FROM cloned_voices WHERE id = 'shauna'`
    );
    expect(row[0]?.accent).toBe("american");

    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });
});
