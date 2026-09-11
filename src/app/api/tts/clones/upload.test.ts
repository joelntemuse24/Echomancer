/**
 * Clone-sample intake: JSON presign, PUT bytes to storage, then create the
 * Fish clone from the stored object — never from a Vercel multipart body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxCloneSampleBytes } from "@/lib/clone-sample-formats";
import {
  USER_A,
  USER_B,
  buildRequest,
  fakeMp3,
  resetDatabase,
  routeParams,
} from "@/test/harness";

const SAMPLE = fakeMp3(16 * 1024, 3);

async function mockFishClone() {
  const fish = await import("@/lib/tts/providers/fish");
  return vi.spyOn(fish, "createFishVoiceClone").mockResolvedValue({
    fishVoiceId: "fish-ref-test",
    state: "trained",
    title: "Alex",
  });
}

async function presignSample(
  opts: {
    userId?: string | null;
    fileName?: string;
    contentType?: string;
    byteSize?: number;
  } = {}
) {
  const { POST } = await import("@/app/api/tts/clones/upload/route");
  return POST(
    await buildRequest("/api/tts/clones/upload", {
      userId: opts.userId === undefined ? USER_A : opts.userId,
      body: {
        fileName: opts.fileName ?? "alex.mp3",
        contentType: opts.contentType ?? "audio/mpeg",
        byteSize: opts.byteSize ?? SAMPLE.length,
      },
    })
  );
}

async function putSample(
  uploadId: string,
  putUrl: string,
  putHeaders: Record<string, string>,
  bytes: Buffer,
  userId: string
) {
  const { PUT } = await import(
    "@/app/api/tts/clones/upload/[id]/object/route"
  );
  return PUT(
    await buildRequest(putUrl, {
      method: "PUT",
      userId,
      headers: putHeaders,
      rawBody: bytes,
    }),
    routeParams({ id: uploadId })
  );
}

async function completeClone(
  uploadId: string,
  userId: string | null,
  extra: Record<string, unknown> = {}
) {
  const { POST } = await import("@/app/api/tts/clones/route");
  return POST(
    await buildRequest("/api/tts/clones", {
      userId,
      body: { uploadId, title: "Alex", ...extra },
    })
  );
}

beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.FISH_API_KEY = "test-fish-key";
  await resetDatabase();
});

describe("POST /api/tts/clones/upload (presign)", () => {
  it("returns a PUT target without reading file bytes", async () => {
    const fish = await mockFishClone();
    const response = await presignSample();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.uploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(body.putUrl).toBe(`/api/tts/clones/upload/${body.uploadId}/object`);
    expect(body.putMethod).toBe("PUT");
    expect(body.putHeaders["Content-Type"]).toBe("audio/mpeg");
    expect(body.sampleStoragePath).toBe(
      `clones/${body.uploadId}/sample.mp3`
    );
    expect(fish).not.toHaveBeenCalled();
  });

  it("rejects multipart so the sample cannot enter the function payload", async () => {
    const { POST } = await import("@/app/api/tts/clones/upload/route");
    const formData = new FormData();
    formData.append(
      "audio",
      new File([SAMPLE], "alex.mp3", { type: "audio/mpeg" }),
      "alex.mp3"
    );
    const response = await POST(
      await buildRequest("/api/tts/clones/upload", {
        method: "POST",
        formData,
        userId: USER_A,
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("USE_PRESIGN");
  });

  it("rejects a declared size over the clone-sample ceiling", async () => {
    const response = await presignSample({
      byteSize: maxCloneSampleBytes() + 1,
    });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("FILE_TOO_LARGE");
  });

  it("rejects a non-audio content type", async () => {
    const response = await presignSample({
      fileName: "notes.pdf",
      contentType: "application/pdf",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_SAMPLE");
  });

  it("stores the sample under an allowlisted clones/<id>/sample.<ext> key", async () => {
    const response = await presignSample({
      fileName: "a.mp3/../../etc/passwd",
      contentType: "audio/mpeg",
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.sampleStoragePath).toBe(`clones/${body.uploadId}/sample.mp3`);
    expect(body.sampleStoragePath).not.toMatch(/\.\.|\/etc\//);
  });

  it("rejects a missing session", async () => {
    const response = await presignSample({ userId: null });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("SESSION_REQUIRED");
  });
});

describe("PUT + POST /api/tts/clones (create from stored object)", () => {
  it("creates the clone from storage, not from a request body", async () => {
    const fish = await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    expect(presignRes.status).toBe(200);

    const putRes = await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      SAMPLE,
      USER_A
    );
    expect(putRes.status).toBe(200);

    const completeRes = await completeClone(presign.uploadId, USER_A);
    const complete = await completeRes.json();
    expect(completeRes.status).toBe(200);
    expect(complete.clone.catalogVoiceId).toBe(`clone:${presign.uploadId}`);
    expect(String(complete.clone.displayName)).toMatch(/Alex/);

    expect(fish).toHaveBeenCalledTimes(1);
    const fishArg = fish.mock.calls[0]![0]!;
    expect(fishArg.audio.equals(SAMPLE)).toBe(true);
    expect(fishArg.filename).toMatch(/\.mp3$/);

    const { downloadFile } = await import("@/lib/storage");
    const stored = await downloadFile(presign.sampleStoragePath);
    expect(stored.equals(SAMPLE)).toBe(true);
  });

  it("reports another session's sample as 404, never 403", async () => {
    await mockFishClone();
    const presignRes = await presignSample({ userId: USER_A });
    const presign = await presignRes.json();
    await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      SAMPLE,
      USER_A
    );

    const completeRes = await completeClone(presign.uploadId, USER_B);
    expect(completeRes.status).toBe(404);
    expect((await completeRes.json()).code).toBe("NOT_FOUND");
    expect(completeRes.status).not.toBe(403);
  });

  it("rejects complete without a session", async () => {
    await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    const response = await completeClone(presign.uploadId, null);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("SESSION_REQUIRED");
  });

  it("returns the existing clone instead of calling Fish again", async () => {
    const fish = await mockFishClone();
    const presignRes = await presignSample();
    const presign = await presignRes.json();
    await putSample(
      presign.uploadId,
      presign.putUrl,
      presign.putHeaders,
      SAMPLE,
      USER_A
    );
    const first = await completeClone(presign.uploadId, USER_A);
    expect(first.status).toBe(200);
    expect(fish).toHaveBeenCalledTimes(1);

    const second = await completeClone(presign.uploadId, USER_A);
    const body = await second.json();
    expect(second.status).toBe(200);
    expect(body.clone.catalogVoiceId).toBe(`clone:${presign.uploadId}`);
    expect(fish).toHaveBeenCalledTimes(1);
  });

  it("rejects the old multipart fat-body create path", async () => {
    const { POST } = await import("@/app/api/tts/clones/route");
    const formData = new FormData();
    formData.set("title", "Alex");
    formData.append(
      "audio",
      new File([SAMPLE], "alex.mp3", { type: "audio/mpeg" }),
      "alex.mp3"
    );
    const response = await POST(
      await buildRequest("/api/tts/clones", {
        method: "POST",
        formData,
        userId: USER_A,
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("USE_PRESIGN");
  });
});
