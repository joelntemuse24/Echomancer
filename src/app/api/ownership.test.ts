/**
 * Cross-session access must be impossible on every route that touches a job.
 *
 * These tests exist because the previous API had no notion of an owner at all:
 * any visitor holding a job id could list, stream, download or delete any other
 * visitor's audiobook. Each case below fails loudly if that regresses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  USER_B,
  buildRequest,
  fakeMp3,
  jobRow,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";

const JOB_A = "aaaaaaaa-0000-4000-8000-000000000001";

async function seedOwnedJob(
  overrides: Partial<Parameters<typeof seedJob>[0]> = {}
) {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text: "Chapter one. ".repeat(40),
  });
  await seedJob({
    id: JOB_A,
    userId: USER_A,
    pdfStoragePath: pdfPath,
    ...overrides,
  });
  return pdfPath;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("GET /api/jobs (library list)", () => {
  it("only returns jobs belonging to the caller", async () => {
    const { GET } = await import("@/app/api/jobs/route");
    await seedOwnedJob();

    const mine = await GET(await buildRequest("/api/jobs", { userId: USER_A }));
    expect(mine.status).toBe(200);
    expect((await mine.json()).jobs).toHaveLength(1);

    const theirs = await GET(
      await buildRequest("/api/jobs", { userId: USER_B })
    );
    expect(theirs.status).toBe(200);
    expect((await theirs.json()).jobs).toHaveLength(0);
  });

  it("returns an empty library rather than an error without a session", async () => {
    const { GET } = await import("@/app/api/jobs/route");
    await seedOwnedJob();

    const response = await GET(await buildRequest("/api/jobs"));
    expect(response.status).toBe(200);
    expect((await response.json()).jobs).toEqual([]);
  });
});

describe("GET /api/jobs/[id] (detail)", () => {
  it("serves the owner", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(200);
    expect((await response.json()).job.id).toBe(JOB_A);
  });

  it("hides the job from another session behind a 404", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_B }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(404);
  });

  it("requires a session at all", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(401);
  });

  it("rejects a forged session cookie", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, {
        headers: { cookie: `ec_session=v1.${USER_A}.1700000000.notasignature` },
      }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(401);
  });

  it("rejects a spoofed session header", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob();

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, {
        headers: { "x-ec-session": `v1.${USER_A}.1700000000.forged` },
      }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/jobs/[id]", () => {
  it("refuses to delete another session's job", async () => {
    const { DELETE } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob();

    const response = await DELETE(
      await buildRequest(`/api/jobs/${JOB_A}`, {
        userId: USER_B,
        method: "DELETE",
      }),
      routeParams({ id: JOB_A })
    );

    expect(response.status).toBe(404);
    expect((await jobRow(JOB_A))?.deleted_at).toBeFalsy();
  });
});

describe("PATCH /api/jobs/[id] (retry)", () => {
  it("refuses to requeue another session's job", async () => {
    const { PATCH } = await import("@/app/api/jobs/[id]/route");
    await seedOwnedJob({ status: "failed" });

    const response = await PATCH(
      await buildRequest(`/api/jobs/${JOB_A}`, {
        userId: USER_B,
        method: "PATCH",
        body: { action: "retry" },
      }),
      routeParams({ id: JOB_A })
    );

    expect(response.status).toBe(404);
    expect((await jobRow(JOB_A))?.status).toBe("failed");
  });
});

describe("POST /api/jobs/[id]/cancel", () => {
  it("refuses to cancel another session's job", async () => {
    const { POST } = await import("@/app/api/jobs/[id]/cancel/route");
    await seedOwnedJob({ status: "processing" });

    const response = await POST(
      await buildRequest(`/api/jobs/${JOB_A}/cancel`, {
        userId: USER_B,
        method: "POST",
      }),
      routeParams({ id: JOB_A })
    );

    expect(response.status).toBe(404);
    expect((await jobRow(JOB_A))?.status).toBe("processing");
  });

  it("lets the owner cancel and clears the worker lease", async () => {
    const { POST } = await import("@/app/api/jobs/[id]/cancel/route");
    await seedOwnedJob({ status: "processing" });

    const response = await POST(
      await buildRequest(`/api/jobs/${JOB_A}/cancel`, {
        userId: USER_A,
        method: "POST",
      }),
      routeParams({ id: JOB_A })
    );

    expect(response.status).toBe(200);
    const row = await jobRow(JOB_A);
    expect(row?.status).toBe("cancelled");
    expect(row?.processing_lease_token).toBeNull();
  });
});

describe("GET /api/jobs/[id]/download", () => {
  it("refuses another session", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/download/route");
    const { uploadFile } = await import("@/lib/storage");
    await uploadFile(
      `audiobooks/${JOB_A}`,
      "full.mp3",
      fakeMp3(),
      "audio/mpeg"
    );
    await seedOwnedJob({
      status: "ready",
      audioStoragePath: `audiobooks/${JOB_A}/full.mp3`,
    });

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/download`, { userId: USER_B }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(404);
  });

  it("serves the owner the assembled file", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/download/route");
    const { uploadFile } = await import("@/lib/storage");
    await uploadFile(
      `audiobooks/${JOB_A}`,
      "full.mp3",
      fakeMp3(4096),
      "audio/mpeg"
    );
    await seedOwnedJob({
      status: "ready",
      audioStoragePath: `audiobooks/${JOB_A}/full.mp3`,
    });

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/download`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(Number(response.headers.get("content-length"))).toBe(4096);
  });
});

describe("GET /api/jobs/[id]/stream", () => {
  it("refuses another session before any synthesis happens", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/stream/route");
    const providers = await import("@/lib/tts/providers");
    const resolve = vi.spyOn(providers, "resolveStockAdapter");

    await seedOwnedJob({ jobKind: "stream" });

    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}/stream`, { userId: USER_B }),
      routeParams({ id: JOB_A })
    );

    expect(response.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobs/[id]/takehome", () => {
  it("refuses to spawn a full book from another session's stream", async () => {
    const { POST } = await import("@/app/api/jobs/[id]/takehome/route");
    await seedOwnedJob({ jobKind: "stream" });

    const response = await POST(
      await buildRequest(`/api/jobs/${JOB_A}/takehome`, {
        userId: USER_B,
        method: "POST",
      }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/storage/[[...path]]", () => {
  it("serves an object to the session that owns the job", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const { uploadFile } = await import("@/lib/storage");
    await seedOwnedJob();
    await uploadFile(
      `audiobooks/${JOB_A}/sections`,
      "0000.mp3",
      fakeMp3(1024),
      "audio/mpeg"
    );

    const response = await GET(
      await buildRequest(
        `/api/storage/audiobooks/${JOB_A}/sections/0000.mp3`,
        { userId: USER_A }
      ),
      routeParams({ path: ["audiobooks", JOB_A, "sections", "0000.mp3"] })
    );
    expect(response.status).toBe(200);
  });

  it("denies an object owned by another session even with the exact key", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const { uploadFile } = await import("@/lib/storage");
    await seedOwnedJob();
    await uploadFile(
      `audiobooks/${JOB_A}/sections`,
      "0000.mp3",
      fakeMp3(1024),
      "audio/mpeg"
    );

    const response = await GET(
      await buildRequest(
        `/api/storage/audiobooks/${JOB_A}/sections/0000.mp3`,
        { userId: USER_B }
      ),
      routeParams({ path: ["audiobooks", JOB_A, "sections", "0000.mp3"] })
    );
    expect(response.status).toBe(404);
  });

  it("denies another session's uploaded document text", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    await seedOwnedJob();

    const response = await GET(
      await buildRequest(`/api/storage/pdfs/${UPLOAD_ID_A}/content.txt`, {
        userId: USER_B,
      }),
      routeParams({ path: ["pdfs", UPLOAD_ID_A, "content.txt"] })
    );
    expect(response.status).toBe(404);
  });

  it("requires a session", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    await seedOwnedJob();

    const response = await GET(
      await buildRequest(`/api/storage/pdfs/${UPLOAD_ID_A}/content.txt`),
      routeParams({ path: ["pdfs", UPLOAD_ID_A, "content.txt"] })
    );
    expect(response.status).toBe(404);
  });

  it("still blocks path traversal", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const response = await GET(
      await buildRequest("/api/storage/audiobooks/..%2Fsecret", {
        userId: USER_A,
      }),
      routeParams({ path: ["audiobooks", "..", "secret"] })
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/jobs (create)", () => {
  it("rejects a pdfStoragePath uploaded by someone else", async () => {
    const { POST } = await import("@/app/api/jobs/route");
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "Someone else's book. ".repeat(20),
    });

    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_B,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: pdfPath,
          bookTitle: "Stolen",
        },
      })
    );

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("UPLOAD_NOT_FOUND");
  });

  it("rejects a storage path that is not an upload at all", async () => {
    const { POST } = await import("@/app/api/jobs/route");

    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: "audiobooks/someone/full.mp3",
        },
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Validation failed");
  });

  it("requires a session", async () => {
    const { POST } = await import("@/app/api/jobs/route");
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "A book. ".repeat(20),
    });

    const response = await POST(
      await buildRequest("/api/jobs", {
        body: { mode: "stock", jobKind: "takehome", pdfStoragePath: pdfPath },
      })
    );
    expect(response.status).toBe(401);
  });
});

describe("Google sign-in merge (durable user_*)", () => {
  it("lets the signed-in owner through and still 404s another user", async () => {
    const { completeGoogleSignIn } = await import("@/lib/auth/google");
    await seedOwnedJob();

    const { session } = await completeGoogleSignIn({
      googleSub: "118234567890123456789",
      email: "joel@example.com",
      name: "Joel",
      anonUserId: USER_A,
    });

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const mine = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: session.userId }),
      routeParams({ id: JOB_A })
    );
    expect(mine.status).toBe(200);

    const theirs = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_B }),
      routeParams({ id: JOB_A })
    );
    expect(theirs.status).toBe(404);
  });
});

describe("worker routes", () => {
  it("rejects /process without the internal secret", async () => {
    const { POST } = await import("@/app/api/jobs/[id]/process/route");
    await seedOwnedJob();

    const response = await POST(
      await buildRequest(`/api/jobs/${JOB_A}/process`, {
        userId: USER_A,
        method: "POST",
      }),
      routeParams({ id: JOB_A })
    );
    expect(response.status).toBe(401);
  });

  it("rejects the cron drain without the cron secret", async () => {
    const { GET } = await import("@/app/api/cron/process-jobs/route");
    const response = await GET(
      await buildRequest("/api/cron/process-jobs", { userId: USER_A })
    );
    expect(response.status).toBe(401);
  });

  it("accepts the cron drain with the cron secret", async () => {
    const { GET } = await import("@/app/api/cron/process-jobs/route");
    const response = await GET(
      await buildRequest("/api/cron/process-jobs", {
        headers: { authorization: "Bearer test-cron-secret" },
      })
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });
});
