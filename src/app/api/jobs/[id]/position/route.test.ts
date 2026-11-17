import { beforeEach, describe, expect, it } from "vitest";
import { USER_A, USER_B, buildRequest, resetDatabase, routeParams, seedJob } from "@/test/harness";
import { query } from "@/lib/turso";
import { GET, PUT } from "./route";

const JOB_A = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaa2";
const JOB_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2";

beforeEach(async () => {
  await resetDatabase();
  await seedJob({
    id: JOB_A,
    userId: USER_A,
    pdfStoragePath: "pdfs/upload-a/content.txt",
    status: "ready",
  });
  await seedJob({
    id: JOB_B,
    userId: USER_B,
    pdfStoragePath: "pdfs/upload-b/content.txt",
    status: "ready",
  });
});

describe("playback position", () => {
  it("saves and reads the owner's book clock, including a guest session", async () => {
    const saved = await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: 33 * 60 + 12, sectionIndex: null },
      }),
      routeParams({ id: JOB_A })
    );
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.positionSeconds).toBe(33 * 60 + 12);
    expect(body.sectionIndex).toBeNull();
    expect(body.updatedAt).toEqual(expect.any(Number));

    const listed = await GET(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).positionSeconds).toBe(33 * 60 + 12);
  });

  it("replaces the previous position instead of stacking rows", async () => {
    const first = await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: 10 },
      }),
      routeParams({ id: JOB_A })
    );
    const saved = await first.json();
    await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: 90, sectionIndex: 2, expectedUpdatedAt: saved.updatedAt },
      }),
      routeParams({ id: JOB_A })
    );
    const rows = await query<{ position_seconds: number; section_index: number | null }>(
      `SELECT position_seconds, section_index FROM playback_positions WHERE job_id = ?`,
      [JOB_A]
    );
    expect(rows).toEqual([{ position_seconds: 90, section_index: 2 }]);
  });

  it("does not read or write another person's book", async () => {
    await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: 40 },
      }),
      routeParams({ id: JOB_A })
    );
    const foreign = await GET(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, { userId: USER_B }),
      routeParams({ id: JOB_A })
    );
    expect(foreign.status).toBe(404);
    const write = await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_B,
        body: { positionSeconds: 1 },
      }),
      routeParams({ id: JOB_A })
    );
    expect(write.status).toBe(404);
    const rows = await query<{ user_id: string }>(
      `SELECT user_id FROM playback_positions WHERE job_id = ?`,
      [JOB_A]
    );
    expect(rows).toEqual([{ user_id: USER_A }]);
  });

  it("rejects a write from a tab that last read an older row", async () => {
    const first = await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: 33 * 60 + 12 },
      }),
      routeParams({ id: JOB_A })
    );
    const saved = await first.json();
    const phone = await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: 40 * 60, expectedUpdatedAt: saved.updatedAt },
      }),
      routeParams({ id: JOB_A })
    );
    expect(phone.status).toBe(200);
    const stale = await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: 33 * 60 + 12, expectedUpdatedAt: saved.updatedAt },
      }),
      routeParams({ id: JOB_A })
    );
    expect(stale.status).toBe(409);
    const rows = await query<{ position_seconds: number }>(
      `SELECT position_seconds FROM playback_positions WHERE job_id = ?`,
      [JOB_A]
    );
    expect(rows).toEqual([{ position_seconds: 40 * 60 }]);
  });

  it("rejects a position that is not a timestamp", async () => {
    const response = await PUT(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/position`, {
        method: "PUT",
        userId: USER_A,
        body: { positionSeconds: -1 },
      }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(400);
  });
});
