import { describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/harness";
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
});
