import { afterEach, describe, expect, it, vi } from "vitest";
import { openFishTtsStream } from "./fish";
import { synthesizeModalClone, usesModalClone } from "./modal-clone";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";

vi.mock("@/lib/turso", () => ({ queryOne: vi.fn() }));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const input = {
  text: "It is a truth universally acknowledged.",
  voiceId: "private-fish-id",
  catalogVoiceId: "clone:saved-id",
  model: "s2.1-pro-free",
};
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]); // "ID3"

function setup() {
  vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
  vi.stubEnv("MODAL_S2_TTS_URL", "https://example.modal.run/");
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.stubEnv("FISH_API_KEY", "test-fish");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
  vi.stubEnv("MODAL_S2_SAMPLING", "0.9,0.9");
  vi.mocked(queryOne).mockResolvedValue({
    sample_storage_path: "clones/saved/sample.wav",
    reference_transcript: "the spoken text of the sample",
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(mp3, {
        headers: { "x-s2-duration": "42.5" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("modal clone routing", () => {
  it("claims clone voices only when the provider is modal", () => {
    // Default: on, with no CLONE_TTS_PROVIDER set at all.
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    vi.stubEnv("MODAL_S2_TTS_URL", "https://example.modal.run");
    expect(usesModalClone("clone:abc")).toBe(true);
    expect(usesModalClone("fish:abc")).toBe(false);
    vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
    expect(usesModalClone("clone:abc")).toBe(true);
    vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
    expect(usesModalClone("clone:abc")).toBe(false);
  });

  it("stands down when the endpoint is not configured", () => {
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    vi.stubEnv("MODAL_S2_TTS_URL", "");
    // No URL means nothing to call: let Drama 3 handle it.
    expect(usesModalClone("clone:abc")).toBe(false);
  });

  it("posts the section, reference and transcript to the container", async () => {
    const fetchMock = setup();
    const result = await synthesizeModalClone(input);

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.durationHintSeconds).toBe(42.5);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.modal.run/synthesize");
    expect((init!.headers as Record<string, string>)["x-echomancer-token"]).toBe(
      "test-token"
    );
    const body = JSON.parse(String(init!.body));
    expect(body.text).toBe(input.text);
    expect(body.reference_text).toBe("the spoken text of the sample");
    expect(body.sampling).toBe("0.9,0.9");
    expect(Buffer.from(body.reference_audio_base64, "base64").toString()).toBe(
      "reference audio"
    );
  });

  it("rejects a clone whose sample is missing", async () => {
    setup();
    vi.mocked(queryOne).mockResolvedValue({ sample_storage_path: null });
    await expect(synthesizeModalClone(input)).rejects.toThrow(/unavailable/);
  });

  it("rejects non-MP3 audio so the caller can fall back", async () => {
    const fetchMock = setup();
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0, 1, 2, 3])));
    await expect(synthesizeModalClone(input)).rejects.toThrow(/invalid MP3/);
  });

  it("surfaces the container's status and detail", async () => {
    const fetchMock = setup();
    fetchMock.mockResolvedValue(new Response("section is too large", { status: 422 }));
    await expect(synthesizeModalClone(input)).rejects.toThrow(/422[\s\S]*too large/);
  });
});

describe("fish adapter fallback order", () => {
  it("falls back to Drama 3 when the container fails", async () => {
    const fetchMock = setup();
    fetchMock
      .mockRejectedValueOnce(new Error("container cold"))
      .mockResolvedValueOnce(new Response(mp3));
    const res = await openFishTtsStream(input, "balanced");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("openrouter.ai/api/v1/audio/speech");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });
});
