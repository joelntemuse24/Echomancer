import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const takehome = readFileSync(new URL("./takehome.ts", import.meta.url), "utf8");
const extract = readFileSync(new URL("./extract-upload.ts", import.meta.url), "utf8");

describe("Trigger drain schedules", () => {
  it("keeps the fallback tasks and declares no drain cron", () => {
    for (const source of [takehome, extract]) {
      expect(source).not.toMatch(/schedules\.task/);
      expect(source).not.toMatch(/\bcron\s*:/);
    }
    expect(takehome).not.toMatch(/id:\s*"takehome\.drain"/);
    expect(extract).not.toMatch(/id:\s*"upload\.drain"/);
    expect(takehome).toMatch(/id:\s*"takehome\.advance"/);
    expect(extract).toMatch(/id:\s*"upload\.extract"/);
  });
});
