import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("one-shot Fish-cues the full speakable then packs sections, and does not re-tag later ticks", async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const jobId = "ffffffff-0000-4000-8000-000000000002";
    const chapter1 =
      "Chapter 1\n\nShe whispered UNIQUEONE softly near the quay. " +
      "The tide turned along the stones while evening settled in. ".repeat(40);
    const chapter2 =
      "Chapter 2\n\nHe sighed UNIQUETWO and looked away across the dark water. " +
      "Night held its breath over the river until dawn. ".repeat(40);
    const rawText = `${chapter1}\n\n${chapter2}`;

    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body || "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const user =
        parsed.messages?.find((m) => m.role === "user")?.content || "";
      expect(user).toMatch(/UNIQUEONE[\s\S]*UNIQUETWO/);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `[calm] ${user}` } }],
        }),
      } as Response;
    });

    try {
      const first = await loadOrBuildFrozenScript(jobId, {
        rawText,
        maxChars: 800,
        tagFishCues: true,
        cueTaggerFetch: fetchFn,
      });
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(first.rebuilt).toBe(true);
      expect(first.speakable).toContain("[calm]");
      expect(first.sections.length).toBeGreaterThan(1);
      expect(first.sections[0]!.text).toContain("[calm]");
      expect(first.sections.some((s) => s.text.includes("UNIQUEONE"))).toBe(
        true
      );
      expect(first.sections.some((s) => s.text.includes("UNIQUETWO"))).toBe(
        true
      );

      const second = await loadOrBuildFrozenScript(jobId, {
        rawText: "A different book. ".repeat(40),
        maxChars: 200,
        tagFishCues: true,
        cueTaggerFetch: fetchFn,
      });
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(second.rebuilt).toBe(false);
      expect(second.speakable).toBe(first.speakable);
    } finally {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });
});
