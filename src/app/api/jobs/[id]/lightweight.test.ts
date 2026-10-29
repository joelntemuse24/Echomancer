/**
 * GET /api/jobs/[id] runs on every poll of the player, so it must do only the
 * work its status calls for: no second row read unless the nudge moved
 * something, no storage reads for chapters or section starts until the book is
 * ready, and no upload lookup unless the job is waiting for its text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  buildRequest,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";

const JOB_A = "dddddddd-0000-4000-8000-0000000000e1";

const nudge = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>()
);

vi.mock("@/lib/tts/process-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tts/process-job")>()),
  nudgeStaleTakehomeJobIfNeeded: nudge,
}));

async function seedOwnedJob(overrides: Partial<Parameters<typeof seedJob>[0]> = {}) {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text: "Chapter one. ".repeat(40),
  });
  await seedJob({ id: JOB_A, userId: USER_A, pdfStoragePath: pdfPath, ...overrides });
  return pdfPath;
}

async function get() {
  const { GET } = await import("@/app/api/jobs/[id]/route");
  const response = await GET(
    await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
    routeParams({ id: JOB_A })
  );
  return { response, body: await response.json() };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  nudge.mockReset();
  nudge.mockResolvedValue(false);
  await resetDatabase();
  delete process.env.TTS_POLL_NUDGE_BUDGET_MS;
});

describe("GET /api/jobs/[id] on a poll", () => {
  it("reads the job once when the nudge changed nothing", async () => {
    await seedOwnedJob({ status: "processing" });
    const guard = await import("@/lib/auth/guard");
    const read = vi.spyOn(guard, "requireOwnedJob");

    const { response, body } = await get();

    expect(response.status).toBe(200);
    expect(body.job.id).toBe(JOB_A);
    expect(read).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it("re-reads the job after the nudge moved it", async () => {
    await seedOwnedJob({ status: "processing" });
    nudge.mockResolvedValue(true);
    const guard = await import("@/lib/auth/guard");
    const read = vi.spyOn(guard, "requireOwnedJob");

    const { response } = await get();

    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("skips chapter and section-start storage reads while generating", async () => {
    const pdfPath = await seedOwnedJob({ status: "processing" });
    const storage = await import("@/lib/storage");
    const download = vi.spyOn(storage, "downloadFile");
    // A processing row still gets a status check on its upload; that is not a
    // chapter read, and the book text must not be offered as ready.
    void pdfPath;
    const { body } = await get();

    expect(body.job.status).toBe("processing");
    expect(body.job.chapters).toBeUndefined();
    for (const call of download.mock.calls) {
      expect(String(call[0])).not.toMatch(/playback-chapters|section-starts/);
    }
  });

  it("reads chapters for a ready book", async () => {
    await seedOwnedJob({ status: "ready", audioStoragePath: "audiobooks/x/full.mp3" });
    const storage = await import("@/lib/storage");
    const download = vi.spyOn(storage, "downloadFile");

    const { body } = await get();

    expect(body.job.status).toBe("ready");
    expect(
      download.mock.calls.some((call) => /playback-chapters|section-starts/.test(String(call[0])))
    ).toBe(true);
  });

  it("does no upload lookup when the job is not waiting for text", async () => {
    await seedOwnedJob({ status: "ready", audioStoragePath: "audiobooks/x/full.mp3" });
    const uploads = await import("@/lib/turso/uploads");
    const lookup = vi.spyOn(uploads, "getUploadByStoragePath");

    const { body } = await get();

    expect(body.job.waiting_for_text).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});
