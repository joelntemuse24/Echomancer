/**
 * The one cache key a take-home section is stored and looked up under.
 *
 * Two paths touch the same content-addressed entry: the clone lane prefetch
 * (which renders a batch ahead of the player) and the per-section path (which
 * masters, uploads, and publishes it). They used to build that key separately,
 * and the lane copy was wrong twice over: a fixed `normal` latency for section
 * 0, whose first take is rendered with `balanced`, and a fixed
 * `s2-pro-modal-v1` variant regardless of engine. Every prefetched section 0
 * was therefore a cache miss, so publishing the first audio paid for a second
 * GPU call — which is exactly the wall clock first light exists to remove.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TAKEHOME_FIRST_SECTION_FISH_LATENCY,
  TAKEHOME_FISH_LATENCY,
  takehomeCacheLatency,
  takehomeCacheVariant,
  takehomeSectionCacheKey,
} from "@/lib/tts/process-job";
import { sectionCacheKey } from "@/lib/tts/section-cache";

/** Modal configured: the default clone engine when the endpoint is set. */
function configureModalClone() {
  vi.stubEnv("MODAL_S2_TTS_URL", "https://acme--echomancer-s2-clone-synthesize-batch.modal.run");
  vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const base = {
  text: "A sentence.",
  voiceId: "clone-ref",
  model: "s2.1-pro-base",
  providerId: "fish",
  catalogVoiceId: "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeeffff",
};

describe("takehomeCacheLatency", () => {
  it("gives section 0's first take the faster profile and every later take normal", () => {
    expect(takehomeCacheLatency(0, 0)).toBe(TAKEHOME_FIRST_SECTION_FISH_LATENCY);
    expect(takehomeCacheLatency(0, 1)).toBe(TAKEHOME_FISH_LATENCY);
    expect(takehomeCacheLatency(1, 0)).toBe(TAKEHOME_FISH_LATENCY);
    expect(takehomeCacheLatency(7)).toBe(TAKEHOME_FISH_LATENCY);
  });
});

describe("takehomeCacheVariant", () => {
  it("names the engine the take actually came from", () => {
    configureModalClone();
    expect(takehomeCacheVariant("fish", base.catalogVoiceId)).toBe("s2-pro-modal-v1");
    vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
    expect(takehomeCacheVariant("fish", base.catalogVoiceId)).toBe("drama-3-plain-v1");
    vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
    expect(takehomeCacheVariant("fish", "standard")).toBe("fish-plain-v1");
    expect(takehomeCacheVariant("paradee", "echomancer-andrew")).toBe(
      "paradee-paragraph-v1"
    );
    expect(takehomeCacheVariant("openrouter", "standard")).toBe("");
  });
});

describe("takehomeSectionCacheKey", () => {
  it("matches the key the per-section path reads for section 0", () => {
    configureModalClone();
    // This is the regression: the lane prefetch and the per-section read must
    // produce byte-identical keys, or the first audio is paid for twice.
    const viaHelper = takehomeSectionCacheKey({ ...base, index: 0 });
    const viaPerSectionPath = sectionCacheKey({
      text: base.text,
      voiceId: base.voiceId,
      model: base.model,
      latency: "balanced",
      speed: undefined,
      chunkLength: 300,
      variant: "s2-pro-modal-v1",
    });
    expect(viaHelper).toBe(viaPerSectionPath);
  });

  it("keeps section 0's first take apart from its retake", () => {
    const first = takehomeSectionCacheKey({ ...base, index: 0, attempt: 0 });
    const retake = takehomeSectionCacheKey({ ...base, index: 0, attempt: 1 });
    expect(first).not.toBe(retake);
  });

  it("does not change with the index alone, so a moved section still hits", () => {
    // The key is a function of the text, not of the position: identical prose
    // in two places must not be rendered twice.
    const a = takehomeSectionCacheKey({ ...base, index: 3 });
    const b = takehomeSectionCacheKey({ ...base, index: 4 });
    expect(a).toBe(b);
  });

  it("changes with the speed a take was rendered at", () => {
    const slow = takehomeSectionCacheKey({ ...base, index: 1, speed: 0.85 });
    const normal = takehomeSectionCacheKey({ ...base, index: 1 });
    expect(slow).not.toBe(normal);
  });

  it("keeps a Drama 3 take out of the S2 entry", () => {
    configureModalClone();
    const modal = takehomeSectionCacheKey({ ...base, index: 1 });
    vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
    const drama = takehomeSectionCacheKey({ ...base, index: 1 });
    expect(modal).not.toBe(drama);
  });
});
