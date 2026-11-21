/**
 * DELETE /api/jobs/[id] hides the row before object cleanup.
 * A few hundred serial DeleteObject calls used to hit maxDuration first.
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  USER_B,
  buildRequest,
  jobRow,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute, queryOne } from "@/lib/turso";
import * as storage from "@/lib/storage";
import { audiobookObjectPrefix } from "@/lib/jobs/delete-owned-job";

const LONG_JOB = "7c1bcf22-0000-4000-8000-000000000293";
const SIBLING_JOB = "7c1bcf22-0000-4000-8000-000000000294";
const OBJECTS = 900;

const queuedPurges: Array<() => unknown> = [];
const afterSpy = vi.hoisted(() => vi.fn<(task: () => unknown) => void>());

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      afterSpy(task);
      queuedPurges.push(task);
    },
  };
});

const originalDeleteFiles = storage.deleteFiles;
const originalListFiles = storage.listFiles;
const deleteBatches: string[][] = [];
const listedPrefixes: string[] = [];

async function flushPurges(): Promise<void> {
  const tasks = queuedPurges.splice(0);
  for (const task of tasks) await task();
}

async function writeObjects(prefix: string, count: number): Promise<void> {
  const dir = path.join(process.env.STORAGE_PATH || "", prefix);
  await mkdir(dir, { recursive: true });
  const width = 50;
  for (let offset = 0; offset < count; offset += width) {
    const n = Math.min(width, count - offset);
    await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const index = offset + i;
        return writeFile(
          path.join(dir, `${String(index).padStart(4, "0")}.mp3`),
          Buffer.from("x")
        );
      })
    );
  }
}

beforeEach(async () => {
  queuedPurges.length = 0;
  deleteBatches.length = 0;
  listedPrefixes.length = 0;
  afterSpy.mockClear();
  vi.restoreAllMocks();
  vi.spyOn(storage, "deleteFiles").mockImplementation(async (keys) => {
    deleteBatches.push([...keys]);
    return originalDeleteFiles(keys);
  });
  vi.spyOn(storage, "deleteFile").mockImplementation(async () => {
    throw new Error("per-object DeleteObject");
  });
  vi.spyOn(storage, "listFiles").mockImplementation(async (directory) => {
    listedPrefixes.push(directory);
    return originalListFiles(directory);
  });
  await resetDatabase();
});

describe("DELETE /api/jobs/[id] long book", () => {
  it("hides the row before a 900-object purge and deletes them in one batch", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(40),
    });
    const missing = Array.from({ length: 420 }, (_, index) => ({
      index,
      path: `audiobooks/${LONG_JOB}/missing/${String(index).padStart(4, "0")}.mp3`,
      status: "ready",
    }));
    await seedJob({
      id: LONG_JOB,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "ready",
      segments: missing,
      audioStoragePath: `audiobooks/${LONG_JOB}/full.mp3`,
      totalSections: 293,
    });
    await writeObjects(`audiobooks/${LONG_JOB}/sections`, 500);
    await writeObjects(`audiobooks/${LONG_JOB}/raw`, 400);

    const { DELETE, GET } = await import("@/app/api/jobs/[id]/route");
    const { GET: listJobs } = await import("@/app/api/jobs/route");

    const response = await DELETE(
      await buildRequest(`/api/jobs/${LONG_JOB}`, { userId: USER_A, method: "DELETE" }),
      routeParams({ id: LONG_JOB })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, message: "Job deleted" });
    expect((await jobRow(LONG_JOB))?.deleted_at).toBeTruthy();
    expect(deleteBatches).toEqual([]);
    expect(await storage.listFiles(`audiobooks/${LONG_JOB}/`)).toHaveLength(OBJECTS);

    const library = await listJobs(await buildRequest("/api/jobs", { userId: USER_A }));
    expect(library.status).toBe(200);
    expect((await library.json()).jobs).toEqual([]);

    const detail = await GET(
      await buildRequest(`/api/jobs/${LONG_JOB}`, { userId: USER_A }),
      routeParams({ id: LONG_JOB })
    );
    expect(detail.status).toBe(404);

    await flushPurges();

    expect(deleteBatches).toHaveLength(1);
    const keys = deleteBatches[0] ?? [];
    expect(keys.filter((key) => key.startsWith(`audiobooks/${LONG_JOB}/`))).toHaveLength(OBJECTS);
    expect(keys.some((key) => key.includes("/missing/"))).toBe(false);
    expect(keys.some((key) => key.startsWith(`pdfs/${UPLOAD_ID_A}/`))).toBe(true);
    expect(await originalListFiles(`audiobooks/${LONG_JOB}/`)).toEqual([]);
    expect(
      await queryOne(`SELECT id FROM uploads WHERE storage_path = ?`, [pdfPath])
    ).toBeNull();
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it("succeeds again for an already soft-deleted book and purges what remains", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Chapter one. ".repeat(20),
    });
    await seedJob({
      id: LONG_JOB,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "ready",
    });
    await writeObjects(`audiobooks/${LONG_JOB}/sections`, 3);
    await execute(`UPDATE jobs SET deleted_at = unixepoch() WHERE id = ?`, [LONG_JOB]);

    const { DELETE } = await import("@/app/api/jobs/[id]/route");
    const first = await DELETE(
      await buildRequest(`/api/jobs/${LONG_JOB}`, { userId: USER_A, method: "DELETE" }),
      routeParams({ id: LONG_JOB })
    );
    expect(first.status).toBe(200);
    const listsBeforeFlush = listedPrefixes.length;
    expect(deleteBatches).toEqual([]);
    await flushPurges();
    expect(deleteBatches).toHaveLength(1);
    expect(await originalListFiles(`audiobooks/${LONG_JOB}/`)).toEqual([]);

    const second = await DELETE(
      await buildRequest(`/api/jobs/${LONG_JOB}`, { userId: USER_A, method: "DELETE" }),
      routeParams({ id: LONG_JOB })
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ success: true });
    await flushPurges();
    expect(listedPrefixes.length).toBeGreaterThan(listsBeforeFlush);
    expect(listedPrefixes.filter((prefix) => prefix === `audiobooks/${LONG_JOB}/`).length).toBe(2);

    const other = await DELETE(
      await buildRequest(`/api/jobs/${LONG_JOB}`, { userId: USER_B, method: "DELETE" }),
      routeParams({ id: LONG_JOB })
    );
    expect(other.status).toBe(404);
    expect((await jobRow(LONG_JOB))?.user_id).toBe(USER_A);
  });

  it("keeps a pdf folder another live book still uses", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Shared chapter. ".repeat(10),
    });
    await seedJob({
      id: LONG_JOB,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "ready",
    });
    await seedJob({
      id: SIBLING_JOB,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "ready",
    });
    await writeObjects(`audiobooks/${LONG_JOB}/sections`, 2);
    await writeObjects(`audiobooks/${SIBLING_JOB}/sections`, 2);

    const { DELETE } = await import("@/app/api/jobs/[id]/route");
    const response = await DELETE(
      await buildRequest(`/api/jobs/${LONG_JOB}`, { userId: USER_A, method: "DELETE" }),
      routeParams({ id: LONG_JOB })
    );
    expect(response.status).toBe(200);
    await flushPurges();

    const keys = deleteBatches.flat();
    expect(keys.some((key) => key.startsWith("pdfs/"))).toBe(false);
    expect(keys.filter((key) => key.startsWith(`audiobooks/${LONG_JOB}/`))).toHaveLength(2);
    expect(await originalListFiles(`audiobooks/${LONG_JOB}/`)).toEqual([]);
    expect(await originalListFiles(`audiobooks/${SIBLING_JOB}/`)).toHaveLength(2);
    expect(await storage.fileExists(pdfPath)).toBe(true);
    expect(
      await queryOne(`SELECT id FROM uploads WHERE storage_path = ?`, [pdfPath])
    ).toBeTruthy();
    expect((await jobRow(SIBLING_JOB))?.deleted_at).toBeFalsy();

    const last = await DELETE(
      await buildRequest(`/api/jobs/${SIBLING_JOB}`, { userId: USER_A, method: "DELETE" }),
      routeParams({ id: SIBLING_JOB })
    );
    expect(last.status).toBe(200);
    await flushPurges();
    expect(await storage.fileExists(pdfPath)).toBe(false);
    expect(
      await queryOne(`SELECT id FROM uploads WHERE storage_path = ?`, [pdfPath])
    ).toBeNull();
  });

  it("builds an audiobook prefix that cannot leave the job folder", () => {
    expect(audiobookObjectPrefix(LONG_JOB)).toBe(`audiobooks/${LONG_JOB}/`);
    expect(audiobookObjectPrefix("../other")).toBeNull();
    expect(audiobookObjectPrefix("a/b")).toBeNull();
  });
});
