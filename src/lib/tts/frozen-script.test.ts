import { describe, expect, it } from "vitest";
import {
  buildFrozenScript,
  loadOrBuildFrozenScript,
  persistFrozenScript,
} from "@/lib/tts/frozen-script";

describe("frozen script", () => {
  it("reuses sections.json instead of re-splitting when the cleaner would change", async () => {
    const jobId = "ffffffff-0000-4000-8000-000000000001";
    const original = [
      "Chapter 1",
      "Frozen opening paragraph that must keep its index. ".repeat(20),
      "Chapter 2",
      "Second frozen chapter stays on index 1. ".repeat(20),
    ].join("\n\n");
    const first = buildFrozenScript({
      rawText: original,
      maxChars: 800,
    });
    expect(first.sections.length).toBeGreaterThan(1);
    await persistFrozenScript(jobId, first);

    const mutated = buildFrozenScript({
      rawText: "A totally different book that would pack into one blob. ".repeat(80),
      maxChars: 200,
    });
    expect(mutated.sections.map((s) => s.text)).not.toEqual(
      first.sections.map((s) => s.text)
    );

    const loaded = await loadOrBuildFrozenScript(jobId, {
      rawText: "A totally different book that would pack into one blob. ".repeat(80),
      maxChars: 200,
    });
    expect(loaded.rebuilt).toBe(false);
    expect(loaded.sections.map((s) => s.text)).toEqual(
      first.sections.map((s) => s.text)
    );
    expect(loaded.sections[0]!.text).toContain("Frozen opening paragraph");
  });
});
