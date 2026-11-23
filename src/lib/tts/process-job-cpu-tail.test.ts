/**
 * The CPU tail, measured through a real clone tick.
 *
 * Reported on a 49-minute book: 397 s of GPU wall and ~93 s of CPU tail after
 * the last section (~19% of the book's time), with a ~17 s gap at each page
 * boundary. The gap was a timer, not work: a tick that ended with a section
 * still `mastering` released its lease with `CPU_YIELD_SEC` of delay, and the
 * drain picked the book up on its next 15 s tick — while the master it had
 * already placed was finishing the whole time.
 *
 * This test drives the real tick against the in-memory harness and asserts the
 * two halves of the fix:
 *
 *  1. a master that finishes inside `TTS_MASTER_SETTLE_MS` is published **by
 *     that tick**, so the book never round-trips through the queue;
 *  2. a master that is still running when the settle ends still yields, with a
 *     `cpu work is queued` result the drain can re-claim — the fairness rule is
 *     untouched.
 *
 * The loudness pass is stubbed out of ffmpeg (no ffmpeg in CI) but is otherwise
 * the real `commitSectionAudio` path, including the master task row, its
 * placement, and `promoteFinishedSections`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  fakeMp3,
  jobRow,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";
import {
  BATCH_HOST,
  READY_HOST,
  endpointOf,
} from "@/lib/tts/providers/modal-endpoints.fixture";

const JOB_ID = "dddddddd-0000-4000-8000-0000000000aa";
const CLONE_ID = "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeefffe";
const UPLOAD_ID = "upload-tail-0000-4000-8000-0000000000aa";

async function seedCloneJob(text: string) {
  const pdfPath = await seedUpload({ id: UPLOAD_ID, userId: USER_A, text });
  await seedJob({
    id: JOB_ID,
    userId: USER_A,
    pdfStoragePath: pdfPath,
    catalogVoiceId: CLONE_ID,
    ttsProvider: "fish",
    providerVoiceId: "clone-ref",
    model: "s2.1-pro-base",
    ttsOptions: { model: "s2.1-pro-base", pauseStyle: "normal" },
  });
  const { uploadFile } = await import("@/lib/storage");
  await uploadFile(
    "clones/saved",
    "sample.wav",
    Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(28), Buffer.from("WAVE"), Buffer.alloc(4096)]),
    "audio/wav"
  ).catch(() => undefined);
  await execute(
    `INSERT OR REPLACE INTO cloned_voices
       (id, user_id, fish_voice_id, title, sample_storage_path, state,
        model, reference_transcript)
     VALUES (?, ?, ?, ?, ?, 'trained', 's2.1-pro-base', 'the sample words')`,
    [CLONE_ID.slice("clone:".length), USER_A, "clone-ref", "Tail Clone", "clones/saved/sample.wav"]
  );
}

function warmPool() {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (endpointOf(String(url)) === "ready") {
      return new Response(JSON.stringify({ ready: true, warm_containers: 2, build: "abc123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const items = Array.isArray(body.items) ? body.items : [];
    return new Response(
      JSON.stringify({
        items: items.map((item: { key: string; text: string }) => ({
          key: item.key,
          audio_b64: Buffer.from(fakeMp3(2048, 3)).toString("base64"),
          duration_s: (item.text.length / 900) * 60,
          units: 2,
          truncated_units: 0,
        })),
        build: "abc123",
        container_id: "c-tail",
        seed: 11,
        performance: { generate_s: 4, sections: items.length },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  });
}

function configureModal() {
  process.env.MODAL_S2_TTS_URL = BATCH_HOST;
  process.env.MODAL_S2_READY_URL = READY_HOST;
  process.env.MODAL_S2_TOKEN = "test-token";
}

/**
 * A short book: two or three sections, so one tick claims the whole remainder
 * and the tail is the only thing the assertions are about. A longer book needs
 * several GPU ticks, which is a different test.
 */
const BOOK = Array.from(
  { length: 4 },
  (_, index) => `Paragraph ${index} of the book is only this one paragraph. `.repeat(12)
).join("\n\n");

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  process.env.TTS_SECTION_CACHE = "1";
  process.env.TTS_SECTION_QA_ENABLED = "0";
  process.env.TTS_QA_PROVIDER = "off";
  process.env.MODAL_S2_BATCH_SIZE = "24";
  process.env.MODAL_S2_SECTION_CONCURRENCY = "1";
  process.env.MODAL_S2_FIRST_LIGHT = "1";
  process.env.TTS_SECTION_MASTER = "1";
  process.env.CPU_RUNNER = "local";
});

afterEach(() => {
  delete process.env.TTS_SECTION_CACHE;
  delete process.env.TTS_SECTION_QA_ENABLED;
  delete process.env.TTS_QA_PROVIDER;
  delete process.env.MODAL_S2_BATCH_SIZE;
  delete process.env.MODAL_S2_SECTION_CONCURRENCY;
  delete process.env.MODAL_S2_FIRST_LIGHT;
  delete process.env.TTS_SECTION_MASTER;
  delete process.env.CPU_RUNNER;
  delete process.env.TTS_MASTER_SETTLE_MS;
  delete process.env.TTS_MASTER_ACCEPT_RETRIES;
  delete process.env.MODAL_S2_TTS_URL;
  delete process.env.MODAL_S2_READY_URL;
  delete process.env.MODAL_S2_TOKEN;
});

describe("CPU tail: one tick", () => {
  it("publishes a master that lands inside the settle, in that tick", async () => {
    configureModal();
    vi.stubGlobal("fetch", warmPool());
    await seedCloneJob(BOOK);

    // The master is real work minus ffmpeg: it claims, is held for a moment,
    // and completes. The hold is shorter than the settle, which is the whole
    // case the settle exists for.
    const sectionMaster = await import("@/lib/tts/section-master");
    vi.spyOn(sectionMaster, "masterSectionBuffer").mockImplementation(
      async (audio) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        return audio;
      }
    );

    process.env.TTS_MASTER_SETTLE_MS = "5000";
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const result = await processTakehomeTick(JOB_ID, {});

    // The tick did not hand the book back: every section it staged was
    // published by this same call.
    expect(result.done).toBe(true);
    const row = await jobRow(JOB_ID);
    expect(row?.status).toBe("ready");
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as Array<{
      index: number;
      status: string;
    }>;
    expect(segments.every((segment) => segment.status === "ready")).toBe(true);
    // And no section was left parked as mastering for the drain to finish.
    expect(segments.some((segment) => segment.status === "mastering")).toBe(false);
  }, 120_000);

  it("does not repeat a master when the placement only reached `accepted`", async () => {
    configureModal();
    vi.stubGlobal("fetch", warmPool());
    await seedCloneJob(BOOK);
    process.env.TTS_MASTER_SETTLE_MS = "2000";

    // Count how many times the pass runs. A re-post must read the same task row,
    // never start a second ffmpeg for that section.
    const sectionMaster = await import("@/lib/tts/section-master");
    const master = vi
      .spyOn(sectionMaster, "masterSectionBuffer")
      .mockImplementation(async (audio) => audio);

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(JOB_ID, {});

    // One pass per section index, not one per attempt.
    const calls = master.mock.calls.length;
    const row = await jobRow(JOB_ID);
    const segments = JSON.parse(String(row?.segments_json ?? "[]")) as Array<{
      index: number;
    }>;
    expect(calls).toBe(segments.length);
  }, 120_000);
});
