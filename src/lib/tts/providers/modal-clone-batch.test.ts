import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModalCloneColdError,
  drainTakeCleanup,
  loadCloneReference,
  modalCloneBatchSize,
  modalClonePoolReady,
  resetModalCloneRuntimeForTests,
  resetModalCloneStorageForTests,
  synthesizeModalCloneBatch,
} from "./modal-clone";
import { modalCloneReportedMaxBatchItems } from "./modal-clone-transport";
import { queryOne } from "@/lib/turso";
import { deleteFile, downloadFile } from "@/lib/storage";
import {
  endpointOf,
  stubModalEndpoints,
} from "./modal-endpoints.fixture";

vi.mock("@/lib/turso", () => ({
  queryOne: vi.fn(),
  execute: vi.fn(async () => ({ rowsAffected: 1 })),
}));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn(), deleteFile: vi.fn() }));

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
  stubModalEndpoints(vi.stubEnv);
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.stubEnv("MODAL_S2_BATCH_SIZE", "8");
  vi.mocked(queryOne).mockResolvedValue({
    sample_storage_path: "clones/saved/sample.wav",
    reference_transcript: "the sample words",
    user_id: "user_a",
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (endpointOf(String(url)) === "ready") return readyResponse();
    return new Response(JSON.stringify({ items: rows }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetModalCloneRuntimeForTests();
  // The storage module is cached per process, so a mock swapped between cases
  // must be re-resolved or the next case sees the previous one's function.
  resetModalCloneStorageForTests();
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
      endpointOf(String(call[0])) === "batch"
    );
    expect(batch).toBeTruthy();
    const body = JSON.parse(String(batch![1]!.body));
    expect(body.items).toHaveLength(2);
    expect(body.reference_text).toBe("the sample words");
    expect(out.size).toBe(2);
    expect(out.get("1")!.durationSeconds).toBe(14);
  });

  it("reads a storage key and leaves a foreign key alone", async () => {
    const fetchMock = setup();
    vi.mocked(downloadFile).mockImplementation(async (path: string) => {
      if (String(path).startsWith("s2-takes/")) return Buffer.from(mp3);
      return Buffer.from("reference audio");
    });
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response(
        JSON.stringify({
          items: [
            { key: "0", storage_key: "s2-takes/job/call/0.mp3", duration_s: 12 },
          ],
        })
      );
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const out = await synthesizeModalCloneBatch([items[0]!], ref);
    expect(out.get("0")!.audio.equals(Buffer.from(mp3))).toBe(true);
    expect(downloadFile).toHaveBeenCalledWith("s2-takes/job/call/0.mp3");

    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response(
        JSON.stringify({
          items: [{ key: "0", storage_key: "audiobooks/other/full.mp3", duration_s: 12 }],
        })
      );
    });
    await expect(synthesizeModalCloneBatch([items[0]!], ref)).rejects.toThrow(/decodable audio/);
    expect(downloadFile).not.toHaveBeenCalledWith("audiobooks/other/full.mp3");
  });

  it("downloads a wide R2 page concurrently and deletes without blocking", async () => {
    // A 24-row r2 page is 24 separate object reads. Serially that is 24 round
    // trips of idle GPU time, and an awaited DELETE adds another before the
    // next batch can post — which is what the warm hold budget is spent on.
    const fetchMock = setup();
    const rows = Array.from({ length: 24 }, (_, i) => ({
      key: String(i),
      storage_key: `s2-takes/job/call/${i}.mp3`,
      duration_s: 12,
    }));
    let inFlight = 0;
    let peak = 0;
    const deletes: string[] = [];
    vi.mocked(downloadFile).mockImplementation(async (path: string) => {
      if (!String(path).startsWith("s2-takes/")) return Buffer.from("reference audio");
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return Buffer.from(mp3);
    });
    // A delete that is slow enough to be visible if the call awaited it. The
    // call must return without waiting, but the delete must still happen.
    vi.mocked(deleteFile).mockImplementation(async (path: string) => {
      deletes.push(path);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response(JSON.stringify({ items: rows }));
    });

    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const wide = Array.from({ length: 24 }, (_, i) => ({
      key: String(i),
      text: "A sentence of narration for one section.",
    }));
    const out = await synthesizeModalCloneBatch(wide, ref, undefined, "job");

    expect(out.size).toBe(24);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    // Every staged object still gets its DELETE — just not on the critical path.
    await drainTakeCleanup();
    expect(deletes).toHaveLength(24);
    expect(deletes[0]).toBe("s2-takes/job/call/0.mp3");
  });

  it("records the batch cap /ready reports so the planner can widen", async () => {
    const fetchMock = setup();
    // No explicit page size: the width must follow what /ready proved.
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "");
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") {
        return new Response(
          JSON.stringify({
            ready: true,
            warm_containers: 1,
            audio_transport: "r2",
            max_batch_items: 32,
          })
        );
      }
      return new Response(JSON.stringify({ items: [audioRow("0"), audioRow("1")] }));
    });
    const probe = await modalClonePoolReady();
    expect(probe.audioTransport).toBe("r2");
    expect(modalCloneReportedMaxBatchItems()).toBe(32);
    expect(modalCloneBatchSize()).toBe(32);
  });

  it("keeps 24 rows when the container does not advertise a wider page", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "");
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") {
        // The live v9 container: r2 absent, no row cap field.
        return new Response(JSON.stringify({ ready: true, warm_containers: 1 }));
      }
      return new Response(JSON.stringify({ items: [audioRow("0")] }));
    });
    await modalClonePoolReady();
    expect(modalCloneBatchSize()).toBe(24);
  });

  it("still accepts the legacy audio_base64 name", async () => {    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
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
      if (endpointOf(String(url)) === "ready") return readyResponse();
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
      if (endpointOf(String(url)) === "ready") return readyResponse();
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
      if (endpointOf(String(url)) === "ready") return readyResponse();
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
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response("boom", { status: 503 });
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    // A 503 is a cold pool, not a bad book: the worker parks the book.
    await expect(synthesizeModalCloneBatch(items, ref)).rejects.toThrow(
      ModalCloneColdError
    );
    const calls = fetchMock.mock.calls.length;
    await expect(synthesizeModalCloneBatch(items, ref)).rejects.toThrow(
      /cold/
    );
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("routes clones through Modal by default", async () => {
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    stubModalEndpoints(vi.stubEnv);
    const { usesModalClone } = await import("./modal-clone");
    expect(usesModalClone("clone:abc")).toBe(true);
    vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
    expect(usesModalClone("clone:abc")).toBe(false);
  });
});

describe("clone fan-out", () => {
  it("defaults to four independent one-GPU lanes", async () => {
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "");
    const { cloneTakehomeFanoutCap } = await import("@/lib/tts/fish-slots");
    // Four lanes = four one-GPU containers; never the 5-slot Fish account cap.
    expect(await cloneTakehomeFanoutCap()).toBe(4);
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "2");
    expect(await cloneTakehomeFanoutCap()).toBe(2);
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "4");
    expect(await cloneTakehomeFanoutCap()).toBe(4);
    // Clamped to the documented ceiling.
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "99");
    expect(await cloneTakehomeFanoutCap()).toBe(8);
  });
});
