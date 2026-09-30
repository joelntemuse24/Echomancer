import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "@/lib/storage";
import {
  coerceNarratorRecommendation,
  loadNarratorRecommendation,
  narratorMarksVoice,
  withNarratorRecommendation,
} from "./narrator-recommendation";

function chat(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

describe("coerceNarratorRecommendation", () => {
  it("forces articles, biography, and general nonfiction onto Andrew standard", () => {
    for (const kind of ["article", "biography", "nonfiction"] as const) {
      expect(
        coerceNarratorRecommendation({
          kind,
          catalogVoiceId: "ava",
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
      delivery: "standard",
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
    ).toMatchObject({ catalogVoiceId: "libby", delivery: "standard" });
  });
});

describe("withNarratorRecommendation", () => {
  it("marks the matching line in brackets", () => {
    const rec = coerceNarratorRecommendation({
      kind: "novel",
      novelKind: "romance",
      catalogVoiceId: "ava",
      delivery: "expressive",
    })!;
    expect(rec).toMatchObject({ catalogVoiceId: "ava", delivery: "standard" });
    expect(narratorMarksVoice(rec, "ava")).toBe(true);
    expect(narratorMarksVoice(rec, "standard")).toBe(false);
    expect(
      coerceNarratorRecommendation({
        kind: "novel",
        novelKind: "romance",
        catalogVoiceId: "michelle",
        delivery: "expressive",
      })
    ).toMatchObject({ catalogVoiceId: "ava", delivery: "standard" });
    expect(withNarratorRecommendation("Ava", true)).toBe("Ava (recommended)");
    expect(withNarratorRecommendation("Andrew", false)).toBe("Andrew");
  });
});

describe("loadNarratorRecommendation", () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it("reads the cached chunk notes and does not send the book", async () => {
    const body = "The harbor was quiet after the rain. She closed the ledger.";
    await uploadFile(
      "pdfs/narr-opening",
      "content.txt",
      Buffer.from(body, "utf8"),
      "text/plain"
    );
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    await uploadFile(
      "pdfs/narr-opening",
      "listen-cleaned.txt",
      Buffer.from(body, "utf8"),
      "text/plain"
    );
    await uploadFile(
      "pdfs/narr-opening",
      "listen-prep.json",
      Buffer.from(
        JSON.stringify({
          status: "done",
          sourceHash: hash,
          narratorSettled: true,
          notes: [{ kind: "article", novelKind: null, tone: "plain", pov: "third", dialogue: "low" }],
          narrator: {
            catalogVoiceId: "standard",
            delivery: "standard",
            kind: "article",
            novelKind: null,
            kindLabel: "Article",
          },
        }),
        "utf8"
      ),
      "application/json"
    );
    const fetchFn = vi.fn(async () => chat("{}"));
    const first = await loadNarratorRecommendation("narr-opening", "Harbor Notes.pdf", {
      fetch: fetchFn,
    });
    expect(first).toMatchObject({ catalogVoiceId: "standard", kind: "article" });
    const second = await loadNarratorRecommendation("narr-opening", "Harbor Notes.pdf", {
      fetch: fetchFn,
    });
    expect(second).toEqual(first);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads a stored Michelle romance suggestion as Ava on the first load", async () => {
    const body = "She closed the ledger and said they would leave at dawn.";
    await uploadFile(
      "pdfs/narr-michelle",
      "content.txt",
      Buffer.from(body, "utf8"),
      "text/plain"
    );
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    await uploadFile(
      "pdfs/narr-michelle",
      "listen-cleaned.txt",
      Buffer.from(body, "utf8"),
      "text/plain"
    );
    await uploadFile(
      "pdfs/narr-michelle",
      "listen-prep.json",
      Buffer.from(
        JSON.stringify({
          status: "done",
          sourceHash: hash,
          narratorSettled: true,
          notes: [
            {
              kind: "novel",
              novelKind: "romance",
              tone: "warm",
              pov: "third",
              dialogue: "medium",
            },
          ],
          narrator: {
            catalogVoiceId: "michelle",
            delivery: "expressive",
            kind: "novel",
            novelKind: "romance",
            kindLabel: "Romance",
          },
        }),
        "utf8"
      ),
      "application/json"
    );
    const first = await loadNarratorRecommendation("narr-michelle", "Quay.pdf");
    expect(first).toMatchObject({
      catalogVoiceId: "ava",
      delivery: "standard",
      kind: "novel",
    });
    const { downloadFile } = await import("@/lib/storage");
    const saved = JSON.parse(
      (await downloadFile("pdfs/narr-michelle/narrator.json")).toString("utf8")
    ) as { catalogVoiceId?: string; delivery?: string };
    expect(saved).toMatchObject({ catalogVoiceId: "ava", delivery: "standard" });
  });
});
