import { beforeEach, describe, expect, it } from "vitest";
import {
  USER_A,
  USER_B,
  buildRequest,
  resetDatabase,
  routeParams,
  seedJob,
} from "@/test/harness";
import { execute, query } from "@/lib/turso";
import { DELETE } from "./[bookmarkId]/route";
import { GET, POST } from "./route";

const JOB_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
const JOB_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb1";

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

async function rowsFor(jobId: string) {
  return query<{ id: string; user_id: string; position_seconds: number; section_index: number | null }>(
    `SELECT id, user_id, position_seconds, section_index FROM bookmarks WHERE job_id = ? ORDER BY position_seconds`,
    [jobId]
  );
}

describe("job bookmarks", () => {
  it("creates, lists, and deletes a mark for the owner, including a guest session", async () => {
    const created = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 65.2, label: "The harbor was quiet" },
      }),
      routeParams({ id: JOB_A })
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.duplicate).toBe(false);
    expect(createdBody.bookmark.positionSeconds).toBeCloseTo(65.2);
    expect(createdBody.bookmark.sectionIndex).toBeNull();
    expect(createdBody.bookmark.label).toBe("The harbor was quiet");
    expect(created.headers.get("cache-control")).toContain("no-store");

    const listed = await GET(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "GET",
        userId: USER_A,
      }),
      routeParams({ id: JOB_A })
    );
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.bookmarks).toHaveLength(1);
    expect(listedBody.bookmarks[0].id).toBe(createdBody.bookmark.id);

    const removed = await DELETE(
      await buildRequest(
        `http://localhost/api/jobs/${JOB_A}/bookmarks/${createdBody.bookmark.id}`,
        { method: "DELETE", userId: USER_A }
      ),
      routeParams({ id: JOB_A, bookmarkId: createdBody.bookmark.id })
    );
    expect(removed.status).toBe(200);
    expect(await rowsFor(JOB_A)).toEqual([]);

    const missing = await DELETE(
      await buildRequest(
        `http://localhost/api/jobs/${JOB_A}/bookmarks/${createdBody.bookmark.id}`,
        { method: "DELETE", userId: USER_A }
      ),
      routeParams({ id: JOB_A, bookmarkId: createdBody.bookmark.id })
    );
    expect(missing.status).toBe(404);
  });

  it("returns the existing mark within 2 seconds and keeps a farther one", async () => {
    const first = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 10, sectionIndex: 0, label: "Opening" },
      }),
      routeParams({ id: JOB_A })
    );
    const firstBody = await first.json();

    const duplicate = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 12, sectionIndex: 0, label: "Again" },
      }),
      routeParams({ id: JOB_A })
    );
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.duplicate).toBe(true);
    expect(duplicateBody.bookmark.id).toBe(firstBody.bookmark.id);
    expect(duplicateBody.bookmark.label).toBe("Opening");

    const later = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 12.5, sectionIndex: 0 },
      }),
      routeParams({ id: JOB_A })
    );
    expect(later.status).toBe(201);

    const otherPart = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 10, sectionIndex: 1 },
      }),
      routeParams({ id: JOB_A })
    );
    expect(otherPart.status).toBe(201);

    const stored = await rowsFor(JOB_A);
    expect(stored).toHaveLength(3);
  });

  it("hides another listener's book and a mark that is not theirs", async () => {
    const created = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 4 },
      }),
      routeParams({ id: JOB_A })
    );
    const { bookmark } = await created.json();

    const strangerList = await GET(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "GET",
        userId: USER_B,
      }),
      routeParams({ id: JOB_A })
    );
    expect(strangerList.status).toBe(404);

    const strangerCreate = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_B,
        body: { positionSeconds: 8 },
      }),
      routeParams({ id: JOB_A })
    );
    expect(strangerCreate.status).toBe(404);

    const strangerDelete = await DELETE(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks/${bookmark.id}`, {
        method: "DELETE",
        userId: USER_B,
      }),
      routeParams({ id: JOB_A, bookmarkId: bookmark.id })
    );
    expect(strangerDelete.status).toBe(404);

    const onOwnJob = await DELETE(
      await buildRequest(`http://localhost/api/jobs/${JOB_B}/bookmarks/${bookmark.id}`, {
        method: "DELETE",
        userId: USER_B,
      }),
      routeParams({ id: JOB_B, bookmarkId: bookmark.id })
    );
    expect(onOwnJob.status).toBe(404);
    expect(await rowsFor(JOB_A)).toHaveLength(1);
  });

  it("does not list a mark stored under a different user id", async () => {
    await execute(
      `INSERT INTO bookmarks (id, user_id, job_id, position_seconds, section_index, label, created_at)
       VALUES ('foreign', ?, ?, 3, NULL, 'hidden', 1)`,
      [USER_B, JOB_A]
    );
    await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 30, label: "Mine" },
      }),
      routeParams({ id: JOB_A })
    );
    const listed = await GET(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "GET",
        userId: USER_A,
      }),
      routeParams({ id: JOB_A })
    );
    const body = await listed.json();
    expect(body.bookmarks.map((row: { label: string | null }) => row.label)).toEqual(["Mine"]);
  });

  it("rejects a missing session and a bad position", async () => {
    const anonymous = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        body: { positionSeconds: 1 },
      }),
      routeParams({ id: JOB_A })
    );
    expect(anonymous.status).toBe(401);

    const bad = await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: -1 },
      }),
      routeParams({ id: JOB_A })
    );
    expect(bad.status).toBe(400);
    expect(await rowsFor(JOB_A)).toEqual([]);
  });

  it("truncates a long snippet and lists marks in listening order", async () => {
    await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 90, label: "full" },
      }),
      routeParams({ id: JOB_A })
    );
    await POST(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "POST",
        userId: USER_A,
        body: { positionSeconds: 4, sectionIndex: 0, label: "x".repeat(180) },
      }),
      routeParams({ id: JOB_A })
    );
    const listed = await GET(
      await buildRequest(`http://localhost/api/jobs/${JOB_A}/bookmarks`, {
        method: "GET",
        userId: USER_A,
      }),
      routeParams({ id: JOB_A })
    );
    const body = await listed.json();
    expect(body.bookmarks.map((row: { positionSeconds: number }) => row.positionSeconds)).toEqual([
      90, 4,
    ]);
    expect(body.bookmarks[1].label).toHaveLength(120);
    expect(body.bookmarks[1].sectionIndex).toBe(0);
  });
});
