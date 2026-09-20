import { describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/harness";
import { execute } from "@/lib/turso";
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
});
