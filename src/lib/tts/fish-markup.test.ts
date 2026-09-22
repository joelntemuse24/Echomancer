import { beforeEach, describe, expect, it } from "vitest";
import { persistFrozenScript, buildFrozenScript } from "@/lib/tts/frozen-script";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { loadStoredFishMarkup } from "@/lib/tts/fish-markup";
import { resetDatabase } from "@/test/harness";

const JOB_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";

beforeEach(async () => {
  await resetDatabase();
});

describe("loadStoredFishMarkup", () => {
  it("returns the stored section text and the exact Fish text field", async () => {
    const stored = "[calm] She whispered near the quay and the tide turned.";
    const built = buildFrozenScript({
      rawText: stored,
      maxChars: 4000,
    });
    expect(built.sections).toHaveLength(1);
    await persistFrozenScript(JOB_ID, {
      speakable: stored,
      sections: built.sections.map((section, index) => ({
        ...section,
        text: index === 0 ? stored : section.text,
      })),
    });

    const markup = await loadStoredFishMarkup({
      id: JOB_ID,
      tts_provider: "fish",
      tts_options: JSON.stringify({
        pauseStyle: "normal",
        deliveryPrefix: false,
      }),
    });

    expect(markup).not.toBeNull();
    expect(markup!.speakable).toBe(stored);
    expect(markup!.speakableSource).toBe("speakable.txt");
    expect(markup!.fishBound).toBe(true);
    expect(markup!.sections[0]!.storedText).toBe(stored);
    expect(markup!.sections[0]!.fishText).toBe(
      narrationScriptForSynthesis(stored, "fish", {
        pauseStyle: "normal",
        deliveryPrefix: false,
      })
    );
  });

  it("does not invent a script when the freeze is missing", async () => {
    const markup = await loadStoredFishMarkup({
      id: JOB_ID,
      tts_provider: "fish",
      tts_options: null,
    });
    expect(markup).toBeNull();
  });

  it("leaves fishText empty for a non-Fish provider", async () => {
    const stored = "[calm] The lecture continues after the heading.";
    const built = buildFrozenScript({ rawText: stored, maxChars: 4000 });
    await persistFrozenScript(JOB_ID, built);

    const markup = await loadStoredFishMarkup({
      id: JOB_ID,
      tts_provider: "edge",
      tts_options: null,
    });
    expect(markup!.fishBound).toBe(false);
    expect(markup!.sections[0]!.fishText).toBeNull();
    expect(markup!.sections[0]!.storedText).toBe(built.sections[0]!.text);
  });
});
