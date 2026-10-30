import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCloneReference,
  modalCloneBatchSize,
  resetModalCloneRuntimeForTests,
  synthesizeModalCloneBatch,
} from "./modal-clone";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";

vi.mock("@/lib/turso", () => ({ queryOne: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]);
const items = [
  { key: "0", text: "First section." },
  { key: "1", text: "Second section." },
];

function audioRow(
  key: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    key,
    audio_b64: Buffer.from(mp3).toString("base64"),
    duration_s: key === "1" ? 14 : 12,
    truncated_units: 0,
    ...extra,
  };
}

function readyResponse() {
  return new Response(JSON.stringify({ ready: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(rows: Record<string, unknown>[] = [audioRow("0"), audioRow("1")]) {
  vi.stubEnv("MODAL_S2_TTS_URL", "https://example.modal.run");
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.stubEnv("MODAL_S2_BATCH_SIZE", "8");
  vi.mocked(queryOne).mockResolvedValue({
    sample_storage_path: "clones/saved/sample.wav",
    reference_transcript: "the sample words",
    user_id: "user_a",
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith("/ready")) return readyResponse();
    return new Response(JSON.stringify({ items: rows }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetModalCloneRuntimeForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("modal clone batch", () => {
  it("reads audio_b64, the field the container returns", async () => {
    const fetchMock = setup();
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const out = await synthesizeModalCloneBatch(items, ref);

    const batch = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/synthesize_batch")
    );
    expect(batch).toBeTruthy();
    const body = JSON.parse(String(batch![1]!.body));
    expect(body.items).toHaveLength(2);
    expect(body.reference_text).toBe("the sample words");
    expect(out.size).toBe(2);
    expect(out.get("1")!.durationSeconds).toBe(14);
  });

  it("still accepts the legacy audio_base64 name", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return readyResponse();
      return new Response(
        JSON.stringify({
          items: [
            {
              key: "0",
              audio_base64: Buffer.from(mp3).toString("base64"),
              duration_s: 12,
            },
          ],
        })
      );
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const out = await synthesizeModalCloneBatch([items[0]!], ref);
    expect([...out.keys()]).toEqual(["0"]);
  });

  it("skips a section the container reported as failed", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return readyResponse();
      return new Response(
        JSON.stringify({
          items: [audioRow("0"), { key: "1", error: "no speakable text" }],
        })
      );
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const out = await synthesizeModalCloneBatch(items, ref);
    expect([...out.keys()]).toEqual(["0"]);
  });

  it("fails when a row has no decodable audio and no error", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return readyResponse();
      return new Response(
        JSON.stringify({
          items: [audioRow("0"), { key: "1", duration_s: 12 }],
        })
      );
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await expect(synthesizeModalCloneBatch(items, ref)).rejects.toThrow(/decodable audio/);
  });

  it("drops a row the server marked truncated so it is not cached", async () => {
    const long = "word ".repeat(200);
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return readyResponse();
      return new Response(
        JSON.stringify({
          items: [
            audioRow("0", { duration_s: 80, truncated_units: 1 }),
            audioRow("1", { duration_s: 80, truncated_units: 0 }),
          ],
        })
      );
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const out = await synthesizeModalCloneBatch(
      [
        { key: "0", text: long },
        { key: "1", text: long },
      ],
      ref
    );
    expect([...out.keys()]).toEqual(["1"]);
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
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return readyResponse();
      return new Response("boom", { status: 503 });
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await expect(synthesizeModalCloneBatch(items, ref)).rejects.toThrow(/503/);
    const calls = fetchMock.mock.calls.length;
    await expect(synthesizeModalCloneBatch(items, ref)).rejects.toThrow(/not ready/);
    expect(fetchMock.mock.calls.length).toBe(calls);
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
    expect(await cloneTakehomeFanoutCap()).toBe(2);
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "4");
    expect(await cloneTakehomeFanoutCap()).toBe(4);
  });
});
