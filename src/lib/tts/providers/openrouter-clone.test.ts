import { afterEach, describe, expect, it, vi } from "vitest";
import { openFishTtsStream, fishTtsProvider } from "./fish";
import { openOpenRouterCloneStream, usesOpenRouterClone } from "./openrouter-clone";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";
import { clonePreviewStoragePath } from "@/lib/tts/clone-preview-store";

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
  vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
  vi.stubEnv("FISH_API_KEY", "test-fish");
  vi.mocked(queryOne).mockResolvedValue({ sample_storage_path: "clones/saved/sample.wav" });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(mp3));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("OpenRouter clone synthesis", () => {
  it("uses saved audio and Drama 3 without sending private Fish ids or unsupported speed", async () => {
    const fetchMock = setup();
    const result = await fishTtsProvider.synthesize({ ...input, speed: 0.85 });
    expect(result.audio).toEqual(Buffer.from(mp3));
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("deleted_at IS NULL"), ["saved-id", "private-fish-id"]);
    expect(downloadFile).toHaveBeenCalledWith("clones/saved/sample.wav");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "fish-audio/drama-3", input: input.text, response_format: "mp3",
      input_references: [{ type: "input_audio", input_audio: { data: Buffer.from("reference audio").toString("base64") } }],
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["http", "network", "empty", "invalid", "broken-stream", "missing-sample", "missing-key", "oversized"])("falls back to direct Fish on %s", async (failure) => {
    const fetchMock = setup();
    if (failure === "http") fetchMock.mockResolvedValueOnce(new Response("error", { status: 400 }));
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("network failure"));
    if (failure === "empty") fetchMock.mockResolvedValueOnce(new Response());
    if (failure === "invalid") fetchMock.mockResolvedValueOnce(new Response("invalid audio"));
    if (failure === "broken-stream") fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("stream failed")); } })));
    if (failure === "missing-sample") vi.mocked(queryOne).mockResolvedValueOnce(null);
    if (failure === "missing-key") vi.stubEnv("OPENROUTER_API_KEY", "");
    if (failure === "oversized") vi.mocked(downloadFile).mockResolvedValueOnce(Buffer.alloc(15 * 1024 * 1024 + 1));
    const result = await openFishTtsStream(input, "balanced");
    expect(Buffer.from(await result.arrayBuffer())).toEqual(Buffer.from(mp3));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(JSON.parse(String(init?.body)).reference_id).toBe(input.voiceId);
    expect(new Headers(init?.headers).get("model")).toBe("s2.1-pro-free");
  });

  it("uses direct Fish for stock voices under every provider setting", async () => {
    const fetchMock = setup();
    await openFishTtsStream({ ...input, catalogVoiceId: "clara" }, "normal");
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    await openFishTtsStream({ ...input, catalogVoiceId: "clara" }, "normal");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("api.fish.audio"))).toBe(true);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("only claims clones for Drama 3 when explicitly asked", async () => {
    setup();
    // Modal is the default now; Drama 3 is opt-in and also the fallback.
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    expect(usesOpenRouterClone(input.catalogVoiceId)).toBe(false);
    vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
    expect(usesOpenRouterClone(input.catalogVoiceId)).toBe(false);
    vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
    expect(usesOpenRouterClone(input.catalogVoiceId)).toBe(true);
  });

  it("streams validated OpenRouter audio through the live entry point", async () => {
    const fetchMock = setup();
    const response = await openFishTtsStream(input, "balanced");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(await response.arrayBuffer()).toEqual(mp3.buffer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps stored previews separate when the provider changes", () => {
    setup();
    const key = { catalogVoiceId: input.catalogVoiceId, providerVoiceId: input.voiceId, model: input.model, script: input.text, speed: 1 };
    const drama = clonePreviewStoragePath(key);
    vi.stubEnv("CLONE_TTS_PROVIDER", "fish");
    expect(clonePreviewStoragePath(key)).not.toBe(drama);
  });

  it("propagates cancellation without calling either provider", async () => {
    const fetchMock = setup();
    const signal = AbortSignal.abort();
    await expect(openFishTtsStream({ ...input, signal }, "balanced")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(openOpenRouterCloneStream({ ...input, signal })).rejects.toThrow();
  });
});
