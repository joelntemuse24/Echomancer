import { describe, expect, it, vi } from "vitest";
import type { GetObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { presignPutObjectInput, openObject } from "@/lib/r2-storage";

describe("presignPutObjectInput", () => {
  it("signs Content-Type only — never ContentLength, which 400s browser PUTs", () => {
    const input = presignPutObjectInput("pdfs/abc/source.pdf", "application/pdf");
    expect(input.ContentType).toBe("application/pdf");
    expect(input.Key).toBe("pdfs/abc/source.pdf");
    expect(input).not.toHaveProperty("ContentLength");
  });
});

describe("openObject", () => {
  it("forwards a seek range and does not drain the object before returning", async () => {
    let pulls = 0;
    const send = vi.fn(async (command: GetObjectCommand) => {
      expect(command.input.Key).toBe("audiobooks/job/full.mp3");
      expect(command.input.Range).toBe("bytes=1000-1003");
      return {
        ContentType: "audio/mpeg",
        ContentLength: 4,
        ContentRange: "bytes 1000-1003/42000000",
        $metadata: { httpStatusCode: 206 },
        Body: {
          transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls += 1;
                // Never ends on its own in one shot. Buffering the body
                // until close would pull every chunk before returning.
                if (pulls >= 8) {
                  controller.close();
                  return;
                }
                controller.enqueue(new Uint8Array([pulls]));
              },
            }),
        },
      } as GetObjectCommandOutput;
    });

    const opened = await openObject("audiobooks/job/full.mp3", "bytes=1000-1003", {
      sender: { send },
    });

    expect(opened.statusCode).toBe(206);
    expect(opened.contentLength).toBe(4);
    expect(opened.contentRange).toBe("bytes 1000-1003/42000000");
    expect(pulls).toBeLessThan(8);
    await opened.body.cancel();
  });

  it("omits Range when the header is not a single byte range", async () => {
    const send = vi.fn(async (command: GetObjectCommand) => {
      expect(command.input.Range).toBeUndefined();
      return {
        ContentType: "audio/mpeg",
        ContentLength: 1,
        $metadata: { httpStatusCode: 200 },
        Body: {
          transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              },
            }),
        },
      } as GetObjectCommandOutput;
    });

    const opened = await openObject("audiobooks/job/full.mp3", "bytes=0-1,2-3", {
      sender: { send },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.contentRange).toBeUndefined();
  });

  it("does not call R2 when the player already aborted the seek", async () => {
    const signal = AbortSignal.abort();
    const send = vi.fn();
    await expect(
      openObject("audiobooks/job/full.mp3", "bytes=0-1", {
        signal,
        sender: { send },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
  });

  it("maps an R2 416 to RangeNotSatisfiableError", async () => {
    const send = vi.fn(async () => {
      const err = new Error("Invalid range");
      err.name = "InvalidRange";
      throw err;
    });
    await expect(
      openObject("audiobooks/job/full.mp3", "bytes=999999999-999999999", {
        sender: { send },
      })
    ).rejects.toMatchObject({ name: "RangeNotSatisfiableError" });
  });
});
