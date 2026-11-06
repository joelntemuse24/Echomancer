/**
 * Drama 3 is gone from every clone path.
 *
 * It re-cloned the raw sample through a hosted model, so its take was a
 * *neighbour* of the customer's voice rather than that voice. On 2026-11-06 a
 * Drama fallback render was stored under an S2 preview key and then served as
 * "the S2 preview" — a saved clone played back in the wrong voice, from a key
 * that claimed to be its own.
 *
 * These tests exist to keep it gone. They assert the absence of the engine
 * rather than its behaviour: a `drama3` pin, an `openrouter` provider value,
 * and an unconfigured pool must all resolve to a real engine or a visible
 * failure, never to a Drama call.
 */

import { createHash } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFishTtsStream } from "./fish";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";
import {
  clonePreviewStoragePath,
  legacyClonePreviewStoragePath,
} from "@/lib/tts/clone-preview-store";

vi.mock("@/lib/turso", () => ({ queryOne: vi.fn() }));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const input = {
  text: "Hello from a saved voice.",
  voiceId: "private-fish-id",
  catalogVoiceId: "clone:saved-id",
  model: "s2.1-pro-free",
};
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]);

function setup() {
  vi.stubEnv("FISH_API_KEY", "test-fish");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
  vi.mocked(queryOne).mockResolvedValue({
    sample_storage_path: "clones/saved/sample.wav",
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(mp3));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Did anything reach OpenRouter's speech endpoint? */
function calledDrama(fetchMock: ReturnType<typeof setup>): boolean {
  return fetchMock.mock.calls.some(([url]) =>
    String(url).includes("openrouter.ai")
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  delete process.env.MODAL_S2_TTS_URL;
});

describe("Drama 3 is unreachable", () => {
  it("takes a clone to direct Fish when the pool is not configured", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_TTS_URL", "");
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    const res = await openFishTtsStream(input, "balanced");
    expect(await res.arrayBuffer()).toEqual(mp3.buffer);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(JSON.parse(String(init?.body)).reference_id).toBe(input.voiceId);
    expect(new Headers(init?.headers).get("model")).toBe("s2.1-pro-free");
    expect(calledDrama(fetchMock)).toBe(false);
  });

  it("does not reach Drama under any CLONE_TTS_PROVIDER value", async () => {
    for (const value of ["", "modal", "openrouter", "fish", "drama3", "bogus"]) {
      vi.resetAllMocks();
      const fetchMock = setup();
      vi.stubEnv("MODAL_S2_TTS_URL", "");
      vi.stubEnv("CLONE_TTS_PROVIDER", value);
      await openFishTtsStream(input, "balanced");
      expect(calledDrama(fetchMock)).toBe(false);
    }
  });

  it("turns a legacy drama3 pin into direct Fish instead of calling Drama", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_TTS_URL", "");
    const res = await openFishTtsStream(
      { ...input, cloneProviderPin: "drama3", allowFallback: false },
      "balanced"
    );
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.arrayBuffer()).toEqual(mp3.buffer);
    expect(calledDrama(fetchMock)).toBe(false);
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
      "https://api.fish.audio/v1/tts"
    );
  });

  it("fails loudly rather than substituting when no engine can speak the clone", async () => {
    setup();
    vi.stubEnv("FISH_API_KEY", "");
    vi.stubEnv("MODAL_S2_TTS_URL", "");
    await expect(
      openFishTtsStream(
        { ...input, cloneProviderPin: "modal", allowFallback: false },
        "balanced"
      )
    ).rejects.toThrow();
  });
});

describe("stored preview keys", () => {
  const key = {
    catalogVoiceId: input.catalogVoiceId,
    providerVoiceId: input.voiceId,
    model: input.model,
    script: input.text,
    speed: 1,
  };

  it("names the engine that rendered the take", () => {
    const s2 = clonePreviewStoragePath(key, "s2-pro");
    const fish = clonePreviewStoragePath(key, "fish");
    expect(s2).toMatch(/^previews\/clones\/saved-id\/[0-9a-f]{32}\.mp3$/);
    expect(fish).not.toBe(s2);
    // No key ever names Drama, so a Drama take can never be found under one.
    expect(s2).not.toMatch(/drama/i);
    expect(fish).not.toMatch(/drama/i);
  });

  it("keeps the legacy engine-free key reproducible for older Fish 2.1 files", () => {
    const legacy = legacyClonePreviewStoragePath(key);
    expect(legacy).toMatch(/^previews\/clones\/saved-id\/[0-9a-f]{32}\.mp3$/);
    // It is a different file from either engine-named key, which is why an
    // old Fish 2.1 preview is still found rather than shadowed.
    expect(legacy).not.toBe(clonePreviewStoragePath(key, "s2-pro"));
    expect(legacy).not.toBe(clonePreviewStoragePath(key, "fish"));
    expect(legacy).toBe(legacyClonePreviewStoragePath({ ...key }));
  });

  /**
   * The whole point of the legacy key is that it reproduces what the old code
   * wrote, byte for byte. This restates the original derivation (commit
   * 3764db1, before the engine suffix existed) and pins the two together. If
   * this ever drifts, every pre-S2 clone preview in production becomes
   * unreachable and the "reuse the Fish 2.1 preview" behaviour silently turns
   * into a cold GPU re-render — the exact regression this change fixes.
   */
  it("reproduces the original pre-engine hash exactly", () => {
    function originalPath(input: typeof key): string {
      const rowId = input.catalogVoiceId.slice("clone:".length);
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            "clone-preview-v1",
            input.providerVoiceId,
            input.model,
            input.speed,
            input.script,
          ])
        )
        .digest("hex")
        .slice(0, 32);
      return `previews/clones/${rowId}/${hash}.mp3`;
    }
    expect(legacyClonePreviewStoragePath(key)).toBe(originalPath(key));

    // Same for the awkward shapes the real rows have: a trimmed reference, a
    // null model, and an unset speed (which the old code wrote as 1).
    const variants = [
      { ...key, providerVoiceId: "  fish-ref-a  " },
      { ...key, model: null as unknown as string },
      { ...key, speed: null as unknown as number },
      { ...key, script: "Unicode — dash\nparagraph" },
    ];
    for (const variant of variants) {
      const expected = originalPath({
        ...variant,
        providerVoiceId: variant.providerVoiceId.trim(),
        model: variant.model ?? "",
        speed: variant.speed ?? 1,
      });
      expect(legacyClonePreviewStoragePath(variant)).toBe(expected);
    }
  });
});
