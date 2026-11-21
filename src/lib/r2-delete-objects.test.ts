/**
 * Batched R2 deletes. `S3Client.send` is mocked, so this never calls R2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { R2_DELETE_OBJECTS_LIMIT, deleteFiles } from "@/lib/r2-storage";

beforeEach(() => {
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({});
});

function sentBatches(): { Key?: string }[][] {
  return mocks.send.mock.calls.map((call) => {
    const command = call[0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input.Bucket).toBe("echomancer-audio");
    expect(command.input.Delete?.Quiet).toBe(true);
    return command.input.Delete?.Objects ?? [];
  });
}

describe("R2 deleteFiles", () => {
  it("sends one DeleteObjects call for 900 keys", async () => {
    const keys = Array.from({ length: 900 }, (_, i) => `audiobooks/job/sections/${i}.mp3`);
    await deleteFiles(keys);
    const batches = sentBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(900);
    expect(R2_DELETE_OBJECTS_LIMIT).toBe(1000);
  });

  it("splits a request above 1,000 keys into batches and drops duplicates", async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `audiobooks/job/raw/${i}.mp3`);
    await deleteFiles([keys[0]!, ...keys]);
    const batches = sentBatches();
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1]);
  });

  it("does not call R2 when there is nothing to delete", async () => {
    await deleteFiles([]);
    await deleteFiles(["", ""]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails the batch when R2 reports an error and does not include the key", async () => {
    mocks.send.mockResolvedValue({
      Errors: [{ Key: "audiobooks/job/secret-object.mp3", Code: "InternalError" }],
    });
    await expect(deleteFiles(["audiobooks/job/secret-object.mp3"])).rejects.toThrow(
      "R2 batched delete failed for 1 object(s) (InternalError)"
    );
  });
});
