/**
 * With R2 configured, `/api/storage` answers an owner with a 302 to a
 * presigned R2 URL so audio bytes never pass through the function. The
 * ownership check must still run first, and raw PCM keeps the proxy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  USER_B,
  buildRequest,
  fakeMp3,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";

const directObjectUrl = vi.hoisted(() =>
  vi.fn<(key: string, opts?: { downloadName?: string }) => Promise<string | null>>()
);

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  directObjectUrl,
}));

const JOB_A = "aaaaaaaa-0000-4000-8000-0000000000d1";
const SIGNED = "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=abc";

async function seedOwnedJob(overrides: Partial<Parameters<typeof seedJob>[0]> = {}) {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text: "Chapter one. ".repeat(40),
  });
  await seedJob({ id: JOB_A, userId: USER_A, pdfStoragePath: pdfPath, ...overrides });
  return pdfPath;
}

beforeEach(async () => {
  directObjectUrl.mockReset();
  directObjectUrl.mockResolvedValue(SIGNED);
  await resetDatabase();
});

describe("GET /api/storage direct R2", () => {
  it("redirects the owner to R2 with a reusable private redirect", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    await seedOwnedJob();
    const response = await GET(
      await buildRequest(`/api/storage/audiobooks/${JOB_A}/full.mp3`, {
        userId: USER_A,
        headers: { range: "bytes=0-99" },
      }),
      routeParams({ path: ["audiobooks", JOB_A, "full.mp3"] })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(directObjectUrl).toHaveBeenCalledWith(`audiobooks/${JOB_A}/full.mp3`, {
      downloadName: undefined,
    });
  });

  it("does not presign for someone else's job", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    await seedOwnedJob();
    const response = await GET(
      await buildRequest(`/api/storage/audiobooks/${JOB_A}/full.mp3`, { userId: USER_B }),
      routeParams({ path: ["audiobooks", JOB_A, "full.mp3"] })
    );
    expect(response.status).toBe(404);
    expect(directObjectUrl).not.toHaveBeenCalled();
  });

  it("does not presign without a session", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    await seedOwnedJob();
    const response = await GET(
      await buildRequest(`/api/storage/audiobooks/${JOB_A}/full.mp3`),
      routeParams({ path: ["audiobooks", JOB_A, "full.mp3"] })
    );
    expect(response.status).toBe(404);
    expect(directObjectUrl).not.toHaveBeenCalled();
  });

  it("passes a sanitized download name", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    await seedOwnedJob();
    const response = await GET(
      await buildRequest(
        `/api/storage/audiobooks/${JOB_A}/full.mp3?download=${encodeURIComponent('my "book".mp3')}`,
        { userId: USER_A }
      ),
      routeParams({ path: ["audiobooks", JOB_A, "full.mp3"] })
    );
    expect(response.status).toBe(302);
    expect(directObjectUrl).toHaveBeenCalledWith(`audiobooks/${JOB_A}/full.mp3`, {
      downloadName: "my _book_.mp3",
    });
  });

  it("keeps raw PCM on the proxy (it needs a WAV header)", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const { uploadFile } = await import("@/lib/storage");
    await seedOwnedJob();
    await uploadFile(`audiobooks/${JOB_A}/sections`, "0000.pcm", Buffer.alloc(2048, 1), "audio/L16");
    const response = await GET(
      await buildRequest(`/api/storage/audiobooks/${JOB_A}/sections/0000.pcm`, { userId: USER_A }),
      routeParams({ path: ["audiobooks", JOB_A, "sections", "0000.pcm"] })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(directObjectUrl).not.toHaveBeenCalled();
  });

  it("falls back to proxying when presigning is off or fails", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const { uploadFile } = await import("@/lib/storage");
    await seedOwnedJob();
    await uploadFile(`audiobooks/${JOB_A}/sections`, "0000.mp3", fakeMp3(512), "audio/mpeg");
    for (const behaviour of ["null", "throw"] as const) {
      directObjectUrl.mockReset();
      if (behaviour === "null") directObjectUrl.mockResolvedValue(null);
      else directObjectUrl.mockRejectedValue(new Error("no creds"));
      const response = await GET(
        await buildRequest(`/api/storage/audiobooks/${JOB_A}/sections/0000.mp3`, { userId: USER_A }),
        routeParams({ path: ["audiobooks", JOB_A, "sections", "0000.mp3"] })
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).length).toBe(512);
    }
  });
});

describe("GET /api/jobs download_url", () => {
  it("adds a direct attachment link only for a ready full-file book", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob({
      status: "ready",
      audioStoragePath: `audiobooks/${JOB_A}/full.mp3`,
    });
    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(200);
    const { job } = await response.json();
    expect(job.download_url).toBe(SIGNED);
    expect(directObjectUrl).toHaveBeenCalledWith(`audiobooks/${JOB_A}/full.mp3`, {
      downloadName: "test_book.mp3",
    });
  });
});

describe("GET /api/jobs download_url (not ready)", () => {
  it("leaves a generating book on the download route", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob({ status: "processing", audioStoragePath: null });
    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    const { job } = await response.json();
    expect(job.download_url).toBeUndefined();
    expect(directObjectUrl).not.toHaveBeenCalled();
  });
});
