import { describe, expect, it } from "vitest";
import { emptyWav, fakeMp3 } from "@/test/harness";
import { FISH_COMPARE_SCRIPT } from "@/lib/tts/delivery-sample";
import { FISH_TWIN_MODEL } from "@/lib/tts/fish-stock-twins";
import {
  EXPRESSIVE_PREVIEW_CACHE_REVISION,
  expressivePreviewCacheKey,
  expressivePreviewObjectPath,
  readExpressivePreviewCache,
  writeExpressivePreviewCache,
} from "@/lib/tts/expressive-preview-cache";

const REF = "a50f1ee074124ba2b1dc44623f99abbe";

function keyFor(overrides?: Partial<Parameters<typeof expressivePreviewCacheKey>[0]>) {
  return expressivePreviewCacheKey({
    catalogVoiceId: "standard",
    referenceId: REF,
    model: FISH_TWIN_MODEL,
    script: FISH_COMPARE_SCRIPT,
    ...overrides,
  });
}

describe("expressivePreviewCacheKey", () => {
  it("changes when the script, twin ref, voice, model, or revision changes", () => {
    const base = keyFor();
    expect(EXPRESSIVE_PREVIEW_CACHE_REVISION).toBe("compare-plain-v1");
    expect(base).toHaveLength(64);
    expect(expressivePreviewObjectPath(base)).toBe(
      `previews/expressive/${base}.mp3`
    );
    expect(keyFor({ script: `${FISH_COMPARE_SCRIPT}\n` })).not.toBe(base);
    expect(
      keyFor({ referenceId: "b50f1ee074124ba2b1dc44623f99abbe" })
    ).not.toBe(base);
    expect(keyFor({ catalogVoiceId: "michelle" })).not.toBe(base);
    expect(keyFor({ model: "s2-pro" })).not.toBe(base);
    expect(keyFor({ revision: `${EXPRESSIVE_PREVIEW_CACHE_REVISION}-next` })).not.toBe(
      base
    );
    expect(keyFor({ referenceId: REF.toUpperCase() })).toBe(base);
    expect(keyFor({ catalogVoiceId: "Standard" })).toBe(base);
  });
});

describe("expressive preview cache storage", () => {
  it("returns a saved clip and ignores silence", async () => {
    const key = keyFor();
    expect(await readExpressivePreviewCache(key)).toBeNull();
    expect(
      await writeExpressivePreviewCache(key, emptyWav(), "audio/wav")
    ).toBe(false);
    expect(await readExpressivePreviewCache(key)).toBeNull();

    const audio = fakeMp3(1200, 4);
    expect(
      await writeExpressivePreviewCache(key, audio, "audio/mpeg")
    ).toBe(true);
    const hit = await readExpressivePreviewCache(key);
    expect(hit?.equals(audio)).toBe(true);

    const silentKey = keyFor({ catalogVoiceId: "michelle" });
    expect(
      await writeExpressivePreviewCache(silentKey, emptyWav(), "audio/mpeg")
    ).toBe(false);
    expect(await readExpressivePreviewCache(silentKey)).toBeNull();
  });
});
