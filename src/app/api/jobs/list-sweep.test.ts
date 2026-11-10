/**
 * The library list used to await the lease sweep before sending JSON.
 * The rows in the response are the ones already read, so the write must
 * not hold the screen.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  buildRequest,
  resetDatabase,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { resetPollSweepThrottle } from "@/lib/tts/process-job";

const JOB_A = "dddddddd-0000-4000-8000-0000000000f1";

const nudge = vi.hoisted(() => vi.fn<() => Promise<number>>());
const afterSpy = vi.hoisted(() => vi.fn<(task: () => unknown) => void>());

vi.mock("@/lib/tts/process-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tts/process-job")>()),
  nudgeStaleTakehomeJobs: nudge,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      afterSpy(task);
      void task();
    },
  };
});

beforeEach(async () => {
  nudge.mockReset();
  afterSpy.mockReset();
  resetPollSweepThrottle();
  await resetDatabase();
});

describe("GET /api/jobs lease sweep", () => {
  it("returns the list while the sweep is still running", async () => {
    let release: (value: number) => void = () => {};
    nudge.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        })
    );
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(20),
    });
    await seedJob({
      id: JOB_A,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "processing",
      jobKind: "takehome",
    });

    const { GET } = await import("./route");
    const pending = GET(await buildRequest("/api/jobs", { userId: USER_A }));
    const raced = await Promise.race([
      pending.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);

    expect(raced).toBe("done");
    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe(JOB_A);

    await Promise.resolve();
    expect(afterSpy).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledTimes(1);
    release(0);
  });

  it("does not schedule a sweep when every take-home is ready", async () => {
    nudge.mockResolvedValue(0);
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(20),
    });
    await seedJob({
      id: JOB_A,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "ready",
      jobKind: "takehome",
      audioStoragePath: "audiobooks/x/full.mp3",
    });

    const { GET } = await import("./route");
    const response = await GET(await buildRequest("/api/jobs", { userId: USER_A }));
    expect(response.status).toBe(200);
    await Promise.resolve();
    expect(afterSpy).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
  });

  it("does not sweep a failed or cancelled book", async () => {
    nudge.mockResolvedValue(0);
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(20),
    });
    await seedJob({
      id: JOB_A,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "failed",
      jobKind: "takehome",
    });

    const { GET } = await import("./route");
    const failed = await GET(await buildRequest("/api/jobs", { userId: USER_A }));
    expect(failed.status).toBe(200);
    await Promise.resolve();
    expect(nudge).not.toHaveBeenCalled();

    await seedJob({
      id: "dddddddd-0000-4000-8000-0000000000f2",
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "cancelled",
      jobKind: "takehome",
    });
    const cancelled = await GET(await buildRequest("/api/jobs", { userId: USER_A }));
    expect(cancelled.status).toBe(200);
    await Promise.resolve();
    expect(nudge).not.toHaveBeenCalled();
  });

  it("does not sweep again inside the poll throttle", async () => {
    nudge.mockResolvedValue(0);
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(20),
    });
    await seedJob({
      id: JOB_A,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
      jobKind: "takehome",
    });

    const { GET } = await import("./route");
    await GET(await buildRequest("/api/jobs", { userId: USER_A }));
    await Promise.resolve();
    expect(nudge).toHaveBeenCalledTimes(1);

    await GET(await buildRequest("/api/jobs", { userId: USER_A }));
    await Promise.resolve();
    expect(nudge).toHaveBeenCalledTimes(1);
  });
});
