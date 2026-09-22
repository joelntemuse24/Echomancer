/**
 * Production playback is `/api/storage/…` with R2 behind it. A seek sends
 * `Range`; the handler must stream that slice and must not download the
 * whole audiobook first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  USER_B,
  buildRequest,
  resetDatabase,
  routeParams,
  seedJob,
} from "@/test/harness";
import { RangeNotSatisfiableError } from "@/lib/storage/byte-range";

const { openObjectMock, getFileMock } = vi.hoisted(() => ({
  openObjectMock: vi.fn(),
  getFileMock: vi.fn(),
}));

vi.mock("@/lib/r2-storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/r2-storage")>(
    "@/lib/r2-storage"
  );
  return {
    ...actual,
    isR2Configured: () => true,
    getFile: getFileMock,
    openObject: openObjectMock,
  };
});

const JOB_A = "aaaaaaaa-0000-4000-8000-0000000000aa";
const FULL = `audiobooks/${JOB_A}/full.mp3`;

function sliceStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

beforeEach(async () => {
  openObjectMock.mockReset();
  getFileMock.mockReset();
  getFileMock.mockImplementation(async () => {
    throw new Error("full-object download");
  });
  await resetDatabase();
  await seedJob({
    id: JOB_A,
    userId: USER_A,
    pdfStoragePath: "pdfs/11111111-1111-4111-8111-111111111111/content.txt",
    status: "ready",
    audioStoragePath: FULL,
  });
});

describe("GET /api/storage R2 ranges", () => {
  it("streams the seek slice and does not download the whole object", async () => {
    const slice = new Uint8Array([1, 2, 3, 4]);
    openObjectMock.mockResolvedValue({
      statusCode: 206,
      contentType: "audio/mpeg",
      contentLength: slice.byteLength,
      contentRange: "bytes 8000000-8000003/42000000",
      body: sliceStream(slice),
    });

    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const response = await GET(
      await buildRequest(`/api/storage/${FULL}`, {
        userId: USER_A,
        headers: { range: "bytes=8000000-8000003" },
      }),
      routeParams({ path: FULL.split("/") })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-range")).toBe(
      "bytes 8000000-8000003/42000000"
    );
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(slice));
    expect(openObjectMock).toHaveBeenCalledWith(
      FULL,
      "bytes=8000000-8000003",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(getFileMock).not.toHaveBeenCalled();
  });

  it("does not touch R2 for a book the caller does not own", async () => {
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const response = await GET(
      await buildRequest(`/api/storage/${FULL}`, {
        userId: USER_B,
        headers: { range: "bytes=0-10" },
      }),
      routeParams({ path: FULL.split("/") })
    );
    expect(response.status).toBe(404);
    expect(openObjectMock).not.toHaveBeenCalled();
    expect(getFileMock).not.toHaveBeenCalled();
  });

  it("serves a named download as an attachment without buffering the book", async () => {
    const slice = new Uint8Array([9, 8, 7, 6]);
    openObjectMock.mockResolvedValue({
      statusCode: 200,
      contentType: "audio/mpeg",
      contentLength: slice.byteLength,
      body: sliceStream(slice),
    });

    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const response = await GET(
      await buildRequest(
        `/api/storage/${FULL}?download=${encodeURIComponent("the_quay.mp3")}`,
        { userId: USER_A }
      ),
      routeParams({ path: FULL.split("/") })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("the_quay.mp3");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(getFileMock).not.toHaveBeenCalled();
    expect(openObjectMock).toHaveBeenCalledWith(
      FULL,
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("returns 416 when R2 rejects the range", async () => {
    openObjectMock.mockRejectedValue(new RangeNotSatisfiableError(42000000));
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const response = await GET(
      await buildRequest(`/api/storage/${FULL}`, {
        userId: USER_A,
        headers: { range: "bytes=999999999-999999999" },
      }),
      routeParams({ path: FULL.split("/") })
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */42000000");
    expect(getFileMock).not.toHaveBeenCalled();
  });

  it("still buffers raw PCM so the WAV header stays aligned", async () => {
    getFileMock.mockResolvedValue(Buffer.from([0, 1, 2, 3]));
    const pcm = `audiobooks/${JOB_A}/sections/0000.pcm`;
    const { GET } = await import("@/app/api/storage/[[...path]]/route");
    const response = await GET(
      await buildRequest(`/api/storage/${pcm}`, { userId: USER_A }),
      routeParams({ path: pcm.split("/") })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(getFileMock).toHaveBeenCalledWith(pcm);
    expect(openObjectMock).not.toHaveBeenCalled();
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(body.length).toBe(48);
  });
});
