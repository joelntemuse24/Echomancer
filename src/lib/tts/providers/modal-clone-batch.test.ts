import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCloneReference,
  modalCloneBatchSize,
  synthesizeModalCloneBatch,
} from "./modal-clone";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";

vi.mock("@/lib/turso", () => ({ queryOne: vi.fn() }));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]);
const items = [
  { key: "0", text: "First section." },
  { key: "1", text: "Second section." },
];

function setup() {
  vi.stubEnv("MODAL_S2_TTS_URL", "https://example.modal.run");
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.stubEnv("MODAL_S2_BATCH_SIZE", "8");
  vi.mocked(queryOne).mockResolvedValue({
    sample_storage_path: "clones/saved/sample.wav",
    reference_transcript: "the sample words",
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          items: [
            { key: "0", audio_base64: Buffer.from(mp3).toString("base64"), duration_s: 12 },
            { key: "1", audio_base64: Buffer.from(mp3).toString("base64"), duration_s: 14 },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("modal clone batch", () => {
  it("sends every section in one request, with the reference once", async () => {
    const fetchMock = setup();
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const out = await synthesizeModalCloneBatch(items, ref);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.modal.run/synthesize_batch");
    const body = JSON.parse(String(init!.body));
    expect(body.items).toHaveLength(2);
    expect(body.reference_text).toBe("the sample words");
    expect(out.size).toBe(2);
    expect(out.get("1")!.durationSeconds).toBe(14);
  });

  it("skips a section the container reported as failed", async () => {
    const fetchMock = setup();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { key: "0", audio_base64: Buffer.from(mp3).toString("base64"), duration_s: 12 },
            { key: "1", error: "no speakable text" },
          ],
        })
      )
    );
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const out = await synthesizeModalCloneBatch(items, ref);
    expect([...out.keys()]).toEqual(["0"]);
  });

  it("caps the page size so one call does not overflow the worker batch", () => {
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "24");
    expect(modalCloneBatchSize()).toBe(24);
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "999");
    expect(modalCloneBatchSize()).toBe(32);
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "");
    expect(modalCloneBatchSize()).toBe(24);
  });

  it("surfaces a failed call so the caller can fall back per section", async () => {
    const fetchMock = setup();
    fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await expect(synthesizeModalCloneBatch(items, ref)).rejects.toThrow(/503/);
  });

  it("routes clones through Modal by default", async () => {
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    vi.stubEnv("MODAL_S2_TTS_URL", "https://example.modal.run");
    const { usesModalClone } = await import("./modal-clone");
    expect(usesModalClone("clone:abc")).toBe(true);
    vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
    expect(usesModalClone("clone:abc")).toBe(false);
  });
});

describe("clone fan-out", () => {
  it("is not held to the 5-slot Fish account cap", async () => {
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "");
    const { cloneTakehomeFanoutCap } = await import("@/lib/tts/fish-slots");
    // Clones use our containers; the Fish cap must not clamp them.
    expect(await cloneTakehomeFanoutCap()).toBe(2);
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "4");
    expect(await cloneTakehomeFanoutCap()).toBe(4);
  });
});
