import { describe, expect, it, vi } from "vitest";
import {
  buildAndPersistFrozenScript,
  buildFrozenScript,
  loadOrBuildFrozenScript,
  persistFrozenScript,
} from "@/lib/tts/frozen-script";
import {
  FISH_FIRST_SECTION_CHARS,
  FISH_HARD_MAX_CHARS,
  FISH_TARGET_CHARS,
  evenTakehomeTargetChars,
} from "@/lib/tts/section-size";

function midSizeProseBook(): string {
  const para = "A clause of academic prose continues without a heading. ";
  return Array.from({ length: 80 }, () => para.repeat(8)).join("\n\n");
}

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
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `[confident] ${user}` } }],
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
      expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(first.rebuilt).toBe(true);
      expect(first.speakable).toContain("[confident]");
      expect(first.sections.length).toBeGreaterThan(1);
      expect(first.sections[0]!.text).toContain("[confident]");
      expect(first.sections.some((s) => s.text.includes("UNIQUEONE"))).toBe(
        true
      );
      expect(first.sections.some((s) => s.text.includes("UNIQUETWO"))).toBe(
        true
      );

      const taggedCalls = fetchFn.mock.calls.length;
      const second = await loadOrBuildFrozenScript(jobId, {
        rawText: "A different book. ".repeat(40),
        maxChars: 200,
        tagFishCues: true,
        cueTaggerFetch: fetchFn,
      });
      expect(fetchFn.mock.calls.length).toBe(taggedCalls);
      expect(second.rebuilt).toBe(false);
      expect(second.speakable).toBe(first.speakable);
    } finally {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  });

  it("caps section 0 when evenFanout is unset", () => {
    const packed = buildFrozenScript({
      rawText: midSizeProseBook(),
      maxChars: FISH_TARGET_CHARS,
      hardMaxChars: FISH_HARD_MAX_CHARS,
      firstSectionMaxChars: FISH_FIRST_SECTION_CHARS,
    });
    expect(packed.sections[0]!.text.length).toBeLessThanOrEqual(
      FISH_FIRST_SECTION_CHARS + 80
    );
  });

  it("evenFanout skips the section-0 cap so fan-out slices stay similar", () => {
    const packed = buildFrozenScript({
      rawText: midSizeProseBook(),
      maxChars: FISH_TARGET_CHARS,
      hardMaxChars: FISH_HARD_MAX_CHARS,
      firstSectionMaxChars: FISH_FIRST_SECTION_CHARS,
      evenFanout: 5,
    });
    const lengths = packed.sections.map((s) => s.text.length);
    const first = lengths[0]!;
    const max = Math.max(...lengths);
    const target = evenTakehomeTargetChars(packed.speakable.length, 5);

    expect(packed.sections).toHaveLength(5);
    expect(first).toBeGreaterThan(FISH_FIRST_SECTION_CHARS + 80);
    expect(first).toBeGreaterThan(max * 0.85);
    expect(Math.abs(first - target)).toBeLessThan(target * 0.3);
    expect(max).toBeLessThanOrEqual(FISH_HARD_MAX_CHARS);
  });

  it("logs pack summary with evenFanout, counts, and first≈max", async () => {
    const jobId = "ffffffff-0000-4000-8000-000000000003";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const packed = await buildAndPersistFrozenScript(jobId, {
        rawText: midSizeProseBook(),
        maxChars: FISH_TARGET_CHARS,
        hardMaxChars: FISH_HARD_MAX_CHARS,
        firstSectionMaxChars: FISH_FIRST_SECTION_CHARS,
        evenFanout: 5,
      });
      const first = packed.sections[0]!.text.length;
      const max = Math.max(...packed.sections.map((s) => s.text.length));
      const target = evenTakehomeTargetChars(packed.speakable.length, 5);
      const line = log.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes("evenFanout="));
      expect(line).toBeTruthy();
      expect(line).toContain("evenFanout=5");
      expect(line).toContain(`sections=${packed.sections.length}`);
      expect(line).toContain(`target=${target}`);
      expect(line).toContain(`first=${first}`);
      expect(line).toContain(`max=${max}`);
    } finally {
      log.mockRestore();
    }
  });
});
