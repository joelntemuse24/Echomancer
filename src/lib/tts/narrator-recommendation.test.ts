import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "@/lib/storage";
import {
  NARRATOR_EXCERPT_BYTES,
  NARRATOR_EXCERPT_CHARS,
  coerceNarratorRecommendation,
  loadNarratorRecommendation,
  narratorMarksVoice,
  withNarratorRecommendation,
  narratorSystemPrompt,
  openingExcerpt,
  recommendNarrator,
} from "./narrator-recommendation";

const LONG = "The harbor was quiet after the rain. ".repeat(4000);

function chat(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

describe("openingExcerpt", () => {
  it("keeps a short opening and does not send the rest of a long book", () => {
    const excerpt = openingExcerpt(LONG);
    expect(excerpt.length).toBeLessThanOrEqual(NARRATOR_EXCERPT_CHARS);
    expect(excerpt.length).toBeGreaterThan(400);
    expect(LONG.length).toBeGreaterThan(excerpt.length * 10);
  });
});

describe("coerceNarratorRecommendation", () => {
  it("forces articles, biography, and general nonfiction onto Andrew standard", () => {
    for (const kind of ["article", "biography", "nonfiction"] as const) {
      expect(
        coerceNarratorRecommendation({
          kind,
          catalogVoiceId: "michelle",
          delivery: "expressive",
          novelKind: "romance",
        })
      ).toMatchObject({
        catalogVoiceId: "standard",
        delivery: "standard",
        kind,
        novelKind: null,
      });
    }
  });

  it("forces history onto Randolph standard", () => {
    expect(
      coerceNarratorRecommendation({
        kind: "history",
        catalogVoiceId: "standard",
        delivery: "expressive",
      })
    ).toMatchObject({
      catalogVoiceId: "randolph",
      delivery: "standard",
      kind: "history",
    });
  });

  it("keeps a novel recommendation and refuses a clone id", () => {
    expect(
      coerceNarratorRecommendation({
        kind: "novel",
        novelKind: "thriller",
        catalogVoiceId: "standard",
        delivery: "expressive",
      })
    ).toMatchObject({
      catalogVoiceId: "standard",
      delivery: "expressive",
      kindLabel: "Thriller",
    });
    expect(
      coerceNarratorRecommendation({
        kind: "novel",
        catalogVoiceId: "clone:abc",
        delivery: "expressive",
      })
    ).toBeNull();
    expect(
      coerceNarratorRecommendation({
        kind: "novel",
        novelKind: "literary",
        catalogVoiceId: "clara",
        delivery: "expressive",
      })
    ).toMatchObject({ catalogVoiceId: "clara", delivery: "standard" });
  });
});

describe("withNarratorRecommendation", () => {
  it("marks the matching line in brackets", () => {
    const rec = coerceNarratorRecommendation({
      kind: "novel",
      novelKind: "romance",
      catalogVoiceId: "michelle",
      delivery: "expressive",
    })!;
    expect(
      narratorMarksVoice(rec, "michelle", "expressive", {
        expressiveAvailable: true,
      })
    ).toBe(true);
    expect(
      narratorMarksVoice(rec, "michelle", "standard", {
        expressiveAvailable: true,
      })
    ).toBe(false);
    expect(narratorMarksVoice(rec, "michelle", "expressive")).toBe(false);
    expect(narratorMarksVoice(rec, "michelle", "standard")).toBe(true);
    expect(withNarratorRecommendation("Michelle", true)).toBe(
      "Michelle (recommended)"
    );
    expect(withNarratorRecommendation("Michelle (Expressive)", true)).toBe(
      "Michelle (Expressive, recommended)"
    );
    expect(withNarratorRecommendation("Andrew", false)).toBe("Andrew");
  });
});

describe("recommendNarrator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("asks DeepSeek about the opening only and pins the provider", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const tail = "UNIQUE_TAIL_SHOULD_NOT_BE_SENT_TO_DEEPSEEK";
    const book = `${LONG.slice(0, 12_000)}${tail}`;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as {
        model: string;
        temperature: number;
        max_tokens: number;
        reasoning?: { effort?: string };
        provider?: { only?: string[]; allow_fallbacks?: boolean };
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.model).toBe("deepseek/deepseek-v4.1-flash");
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(64);
      expect(body.reasoning).toEqual({ effort: "none" });
      expect(body.provider).toEqual({ only: ["deepseek"], allow_fallbacks: false });
      const system = body.messages.find((m) => m.role === "system")?.content || "";
      expect(system).toBe(narratorSystemPrompt());
      expect(system).toMatch(/catalogVoiceId must be standard/);
      expect(system).toMatch(/randolph/);
      const user = body.messages.find((m) => m.role === "user")?.content || "";
      expect(user).toContain("Title: Harbor Notes");
      expect(user.length).toBeLessThan(NARRATOR_EXCERPT_CHARS + 80);
      expect(user).not.toContain(tail);
      return chat(
        '{"kind":"novel","novelKind":"literary","catalogVoiceId":"standard","delivery":"standard"}'
      );
    });
    const rec = await recommendNarrator({
      excerpt: book,
      fileName: "Harbor Notes.pdf",
      fetch: fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(rec).toMatchObject({
      catalogVoiceId: "standard",
      delivery: "standard",
      kind: "novel",
      kindLabel: "Literary",
    });
  });

  it("returns null when the key is missing or the reply is not json", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchFn = vi.fn(async () => chat("{}"));
    expect(
      await recommendNarrator({
        excerpt: "The harbor was quiet after the rain and the boats stayed tied.",
        fetch: fetchFn,
      })
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();

    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const bad = vi.fn(async () => chat("not json"));
    expect(
      await recommendNarrator({
        excerpt: "The harbor was quiet after the rain and the boats stayed tied.",
        fetch: bad,
      })
    ).toBeNull();
  });
});

describe("loadNarratorRecommendation", () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it("range-reads the opening, asks DeepSeek once, and reuses the cache", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const tail = "UNIQUE_TAIL_SHOULD_NOT_BE_SENT_TO_DEEPSEEK";
    const body = `${"The harbor was quiet after the rain. ".repeat(800)}${tail}`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(NARRATOR_EXCERPT_BYTES);
    await uploadFile(
      "pdfs/narr-opening",
      "content.txt",
      Buffer.from(body, "utf8"),
      "text/plain"
    );
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body || "{}")) as {
        messages: Array<{ role: string; content: string }>;
      };
      const user = parsed.messages.find((m) => m.role === "user")?.content || "";
      expect(user).toContain("Title: Harbor Notes");
      expect(user.length).toBeLessThan(NARRATOR_EXCERPT_CHARS + 80);
      expect(user).not.toContain(tail);
      return chat(
        '{"kind":"article","novelKind":null,"catalogVoiceId":"michelle","delivery":"expressive"}'
      );
    });
    const first = await loadNarratorRecommendation("narr-opening", "Harbor Notes.pdf", {
      fetch: fetchFn,
    });
    expect(first).toMatchObject({
      catalogVoiceId: "standard",
      delivery: "standard",
      kind: "article",
    });
    const second = await loadNarratorRecommendation("narr-opening", "Harbor Notes.pdf", {
      fetch: fetchFn,
    });
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
