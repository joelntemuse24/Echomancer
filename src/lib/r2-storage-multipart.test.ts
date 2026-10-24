import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => {
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET_NAME = "echomancer-audio";
  return { send: vi.fn() };
});

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class S3Client {
    send = mocks.send;
  }
  return { ...actual, S3Client };
});

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  uploadFileFromPath,
  uploadFileWithPrefix,
} from "@/lib/r2-storage";

const MB = 1024 * 1024;

function makeContent(size: number, seed = 7): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 31 + seed) & 0xff;
  return buf;
}

let dir: string;

beforeEach(async () => {
  mocks.send.mockReset();
  process.env.R2_UPLOAD_PART_MB = "8";
  process.env.R2_UPLOAD_CONCURRENCY = "6";
  dir = await mkdtemp(path.join(tmpdir(), "r2-multipart-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface SentPart {
  PartNumber: number;
  Body: Buffer;
}

function installSend(options?: {
  failPartOnce?: number;
  failPartAlways?: number;
  partDelayMs?: (partNumber: number) => number;
}) {
  const parts: SentPart[] = [];
  let complete: { Parts: { ETag?: string; PartNumber: number }[] } | null = null;
  let aborted = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const attempts = new Map<number, number>();

  mocks.send.mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) {
      return { UploadId: "upload-1" };
    }
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      return { ETag: `"put-${Buffer.isBuffer(body) ? body.length : "stream"}"` };
    }
    if (command instanceof UploadPartCommand) {
      const partNumber = command.input.PartNumber!;
      attempts.set(partNumber, (attempts.get(partNumber) ?? 0) + 1);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (partNumber === options?.failPartAlways) {
          const err = new Error("boom");
          err.name = "InternalError";
          (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
            httpStatusCode: 500,
          };
          throw err;
        }
        if (partNumber === options?.failPartOnce && attempts.get(partNumber) === 1) {
          const err = new Error("transient");
          err.name = "InternalError";
          throw err;
        }
        const delay = options?.partDelayMs?.(partNumber) ?? 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const body = Buffer.from(command.input.Body as Buffer);
        parts.push({ PartNumber: partNumber, Body: body });
        return { ETag: `"etag-${partNumber}"` };
      } finally {
        inFlight -= 1;
      }
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      complete = command.input.MultipartUpload as typeof complete;
      return { ETag: '"complete"' };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      aborted = true;
      return {};
    }
    throw new Error(`unexpected command ${String(command)}`);
  });

  return {
    parts,
    attempts,
    get complete() {
      return complete;
    },
    get aborted() {
      return aborted;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

describe("uploadFileFromPath multipart", () => {
  it("uploads parts concurrently and completes them in PartNumber order", async () => {
    const size = 8 * MB * 2 + 12345;
    const content = makeContent(size);
    const file = path.join(dir, "big.bin");
    await writeFile(file, content);

    // Later parts resolve first so completion order differs from part order.
    const harness = installSend({ partDelayMs: (n) => (4 - n) * 15 });

    await uploadFileFromPath("audio/big.bin", file, "audio/mpeg");

    expect(harness.parts.map((p) => p.PartNumber).sort()).toEqual([1, 2, 3]);
    expect(harness.maxInFlight).toBeGreaterThan(1);
    expect(harness.complete).not.toBeNull();
    const completed = harness.complete!.Parts;
    expect(completed.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    expect(completed.map((p) => p.ETag)).toEqual([
      '"etag-1"',
      '"etag-2"',
      '"etag-3"',
    ]);

    const byNumber = [...harness.parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const rejoined = Buffer.concat(byNumber.map((p) => p.Body));
    expect(rejoined.length).toBe(size);
    expect(rejoined.equals(content)).toBe(true);
    expect(byNumber[2]!.Body.length).toBe(12345);
  });

  it("retries a part that fails once and still completes", async () => {
    const size = 8 * MB + 1024;
    const content = makeContent(size, 11);
    const file = path.join(dir, "retry.bin");
    await writeFile(file, content);

    const harness = installSend({ failPartOnce: 2 });

    await uploadFileFromPath("audio/retry.bin", file, "audio/mpeg");

    expect(harness.attempts.get(2)).toBe(2);
    expect(harness.aborted).toBe(false);
    expect(harness.complete).not.toBeNull();

    const byNumber = [...harness.parts].sort((a, b) => a.PartNumber - b.PartNumber);
    expect(Buffer.concat(byNumber.map((p) => p.Body)).equals(content)).toBe(true);
  });

  it("aborts the multipart upload when a part keeps failing", async () => {
    const file = path.join(dir, "failing.bin");
    await writeFile(file, makeContent(8 * MB + 10, 3));

    const harness = installSend({ failPartAlways: 1 });

    await expect(
      uploadFileFromPath("audio/failing.bin", file, "audio/mpeg")
    ).rejects.toThrow("boom");

    expect(harness.attempts.get(1)).toBe(3);
    expect(harness.aborted).toBe(true);
    expect(harness.complete).toBeNull();
  });

  it("uses a single PutObject buffer below the part size", async () => {
    const content = makeContent(1000, 5);
    const file = path.join(dir, "small.bin");
    await writeFile(file, content);

    let putBody: Buffer | null = null;
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        putBody = Buffer.from(command.input.Body as Buffer);
        return { ETag: '"put"' };
      }
      throw new Error("multipart should not be used for a small file");
    });

    await uploadFileFromPath("audio/small.bin", file, "audio/mpeg");

    expect(putBody).not.toBeNull();
    expect(putBody!.equals(content)).toBe(true);
  });
});

describe("uploadFileWithPrefix", () => {
  it("prepends the prefix and skips leading file bytes in one PutObject", async () => {
    const content = Buffer.from("0123456789ABCDEF");
    const file = path.join(dir, "header.bin");
    await writeFile(file, content);

    let put: { Body: Buffer; ContentLength?: number } | null = null;
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        put = {
          Body: Buffer.from(command.input.Body as Buffer),
          ContentLength: command.input.ContentLength,
        };
        return { ETag: '"put"' };
      }
      throw new Error("expected a single PutObject");
    });

    const prefix = Buffer.from("RIFF");
    await uploadFileWithPrefix("audio/prefixed.bin", prefix, file, "audio/wav", 4);

    expect(put).not.toBeNull();
    expect(put!.Body.toString()).toBe("RIFF456789ABCDEF");
    expect(put!.ContentLength).toBe(16);
  });

  it("splices a prefix across the first part boundary in multipart uploads", async () => {
    const size = 8 * MB + 4096;
    const content = makeContent(size, 13);
    const file = path.join(dir, "prefixed-big.bin");
    await writeFile(file, content);

    // A prefix that spills past the 8 MB part boundary is unrealistic for a
    // WAV header, but it exercises the readRange offset arithmetic.
    const prefix = makeContent(100, 99);
    const skip = 27;

    const harness = installSend();

    await uploadFileWithPrefix(
      "audio/prefixed-big.bin",
      prefix,
      file,
      "audio/wav",
      skip
    );

    const expected = Buffer.concat([prefix, content.subarray(skip)]);
    const byNumber = [...harness.parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const rejoined = Buffer.concat(byNumber.map((p) => p.Body));
    expect(rejoined.equals(expected)).toBe(true);
    expect(harness.complete!.Parts.map((p) => p.PartNumber)).toEqual([1, 2]);

    const completed = harness.complete!.Parts;
    expect(completed.map((p) => p.ETag)).toEqual(['"etag-1"', '"etag-2"']);
  });
});
