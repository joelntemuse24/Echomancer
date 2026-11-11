/**
 * The batch contract, pinned to what a *real* container sends.
 *
 * The 30 October regression was a name mismatch: the container returned
 * `audio_b64` and the client read `audio_base64`, so every row looked empty,
 * every book fell through to per-section GPU calls, and nothing failed. These
 * fixtures are byte-for-byte the shapes `s2_clone_service.synthesize_batch`
 * writes today, including the fields the client is allowed to ignore.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModalCloneColdError,
  loadCloneReference,
  renderModalCloneBatch,
  resetModalCloneRuntimeForTests,
} from "./modal-clone";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";
import {
  endpointOf,
  stubModalEndpoints,
} from "./modal-endpoints.fixture";

vi.mock("@/lib/turso", () => ({
  queryOne: vi.fn(),
  execute: vi.fn(async () => ({ rowsAffected: 1 })),
}));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

/** Smallest bytes that pass `sniffAudioContentType` and the truncation guard. */
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]);

function b64(bytes: Uint8Array = mp3): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Response shape produced by `S2CloneWorker.synthesize_batch` after the
 * snapshot work: rows plus build/container/seed/reference/performance.
 */
function serverBatchResponse(opts: {
  keys: string[];
  durationS?: number;
  truncated?: Record<string, number>;
  errors?: Record<string, { message: string; code: string }>;
  build?: string;
  containerId?: string;
}) {
  const rows: Record<string, unknown>[] = [];
  for (const key of opts.keys) {
    const failure = opts.errors?.[key];
    if (failure) {
      rows.push({ key, error: failure.message, error_code: failure.code });
      continue;
    }
    rows.push({
      key,
      audio_b64: b64(),
      duration_s: opts.durationS ?? 42.5,
      units: 3,
      truncated_units: opts.truncated?.[key] ?? 0,
    });
  }
  return {
    items: rows,
    build: opts.build ?? "abc123def456",
    container_id: opts.containerId ?? "container-7",
    seed: 918273,
    sampling: "0.9,0.9",
    reference: { sha256: "f".repeat(64), seconds: 21.4, rms: 0.081 },
    performance: {
      sections: opts.keys.length,
      audio_s: 42.5 * opts.keys.length,
      prepare_s: 0.4,
      generate_s: 31.2,
      codec_s: 1.9,
      encode_s: 2.1,
      call_s: 35.6,
      truncated_units: 0,
      frames: 4096,
      frames_per_s: 131.3,
      generated_realtime_x: 58.2,
      restored_s: 12.4,
    },
  };
}

function ready() {
  return new Response(
    JSON.stringify({ ready: true, warm_containers: 2, build: "abc123def456" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function setupFetch(body: unknown, status = 200) {
  stubModalEndpoints(vi.stubEnv);
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes("usage_logs")) return { user_chars: 0, global_chars: 0 };
    return {
      sample_storage_path: "clones/saved/sample.wav",
      reference_transcript: "the sample words",
      user_id: "user_a",
    };
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (endpointOf(String(url)) === "ready") return ready();
    return new Response(JSON.stringify(body), {
      status,
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

describe("batch contract against the real server shape", () => {
  it("reads every row of a real response and reports build and container", async () => {
    setupFetch(serverBatchResponse({ keys: ["0", "1", "2"] }));
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const outcome = await renderModalCloneBatch(
      [
        { key: "0", text: "First section." },
        { key: "1", text: "Second section." },
        { key: "2", text: "Third section." },
      ],
      ref
    );

    expect([...outcome.audio.keys()]).toEqual(["0", "1", "2"]);
    expect(outcome.build).toBe("abc123def456");
    expect(outcome.containerId).toBe("container-7");
    expect(outcome.seed).toBe(918273);
    expect(outcome.performance?.generated_realtime_x).toBe(58.2);
    expect(outcome.audio.get("2")!.durationSeconds).toBe(42.5);
  });

  it("sends the fields the container validates: keys, reference, seed epoch", async () => {
    const fetchMock = setupFetch(serverBatchResponse({ keys: ["7"] }));
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await renderModalCloneBatch(
      [{ key: "7", text: "Only section." }],
      ref,
      undefined,
      "job-1",
      { seedEpoch: 2 }
    );

    const call = fetchMock.mock.calls.find((c) =>
      endpointOf(String(c[0])) === "batch"
    )!;
    const body = JSON.parse(String(call[1]!.body));
    expect(body.items).toEqual([{ key: "7", text: "Only section." }]);
    expect(body.reference_text).toBe("the sample words");
    expect(body.job_id).toBe("job-1");
    expect(body.seed_epoch).toBe(2);
    expect(body.sampling).toBeTruthy();
  });

  it("sends a per-row reference only when the mixed-book flag is on", async () => {
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const item = {
      key: "3",
      text: "Section.",
      referenceAudioBase64: "bbb",
      referenceText: "other voice",
      seed: 9,
    };
    const offMock = setupFetch(serverBatchResponse({ keys: ["3"] }));
    await renderModalCloneBatch([item], ref, undefined, "job-1");
    const off = JSON.parse(String(offMock.mock.calls.at(-1)?.[1]?.body));
    expect(off.items).toEqual([{ key: "3", text: "Section." }]);

    vi.stubEnv("MODAL_S2_MIXED_BOOK_BATCH", "1");
    const onMock = setupFetch(serverBatchResponse({ keys: ["3"] }));
    await renderModalCloneBatch([item], ref, undefined, "job-1");
    const on = JSON.parse(String(onMock.mock.calls.at(-1)?.[1]?.body));
    expect(on.items[0]).toMatchObject({
      key: "3",
      text: "Section.",
      reference_audio_base64: "bbb",
      reference_text: "other voice",
      seed: 9,
    });
    expect(on.reference_audio_base64).toBeTruthy();
  });

  it("keeps the row order the server sent, including interleaved errors", async () => {
    setupFetch(
      serverBatchResponse({
        keys: ["0", "1", "2"],
        errors: { "1": { message: "no speakable text", code: "empty_text" } },
      })
    );
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const outcome = await renderModalCloneBatch(
      [
        { key: "0", text: "First." },
        { key: "1", text: "   " },
        { key: "2", text: "Third." },
      ],
      ref
    );
    // The error row is skipped, the other two are staged.
    expect([...outcome.audio.keys()]).toEqual(["0", "2"]);
  });

  it("drops a truncated row so it is never cached as a finished section", async () => {
    const long = "word ".repeat(200);
    setupFetch(
      serverBatchResponse({
        keys: ["0", "1"],
        durationS: 80,
        truncated: { "0": 2 },
      })
    );
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const outcome = await renderModalCloneBatch(
      [
        { key: "0", text: long },
        { key: "1", text: long },
      ],
      ref
    );
    expect([...outcome.audio.keys()]).toEqual(["1"]);
  });

  it("fails loudly rather than staging zero sections", async () => {
    setupFetch({ items: [{ key: "0", duration_s: 12 }, { key: "1", duration_s: 12 }] });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await expect(
      renderModalCloneBatch(
        [
          { key: "0", text: "First." },
          { key: "1", text: "Second." },
        ],
        ref
      )
    ).rejects.toThrow(/decodable audio/);
  });

  it("accepts the legacy audio_base64 name from an older container build", async () => {
    setupFetch({
      items: [{ key: "0", audio_base64: b64(), duration_s: 12, units: 1 }],
    });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const outcome = await renderModalCloneBatch([{ key: "0", text: "Hi." }], ref);
    expect([...outcome.audio.keys()]).toEqual(["0"]);
    expect(outcome.build).toBeNull();
  });

  it("treats a 502/503/504 as a cold pool, not a broken book", async () => {
    setupFetch({ error: "gateway" }, 502);
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await expect(
      renderModalCloneBatch([{ key: "0", text: "Hi." }], ref)
    ).rejects.toThrow(ModalCloneColdError);
  });

  it("surfaces a reference rejection as a non-retryable error", async () => {
    setupFetch({ error: "reference clip is empty (0 bytes)" }, 422);
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    const { ModalCloneReferenceError } = await import("./modal-clone");
    await expect(
      renderModalCloneBatch([{ key: "0", text: "Hi." }], ref)
    ).rejects.toThrow(ModalCloneReferenceError);
  });
});
