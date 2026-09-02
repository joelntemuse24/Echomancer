import { describe, expect, it } from "vitest";
import { fakeMp3 } from "@/test/harness";
import { downloadFile, uploadFile } from "@/lib/storage";
import { materializeFullAudiobook } from "./concat-audio";
import type { JobSegment } from "./types";

const JOB_ID = "dddddddd-0000-4000-8000-000000000001";

async function seedSection(bytes: Buffer): Promise<JobSegment[]> {
  const path = `audiobooks/${JOB_ID}/sections/0000.mp3`;
  await uploadFile(
    `audiobooks/${JOB_ID}/sections`,
    "0000.mp3",
    bytes,
    "audio/mpeg"
  );
  return [
    {
      index: 0,
      path,
      status: "ready",
      contentType: "audio/mpeg",
    },
  ];
}

describe("materializeFullAudiobook", () => {
  it("uploads full.mp3 with the dry concat when enhance is skipped", async () => {
    const audio = fakeMp3(8_192);
    const segments = await seedSection(audio);

    const path = await materializeFullAudiobook(JOB_ID, segments, 1);

    expect(path).toBe(`audiobooks/${JOB_ID}/full.mp3`);
    const uploaded = await downloadFile(path!);
    expect(uploaded.equals(audio)).toBe(true);
  });

  it("still uploads full.mp3 with original bytes when enhance throws", async () => {
    const audio = fakeMp3(64_000);
    const segments = await seedSection(audio);

    const path = await materializeFullAudiobook(JOB_ID, segments, 1, {
      enhance: async () => {
        throw new Error("dfn crashed");
      },
    });

    expect(path).toBe(`audiobooks/${JOB_ID}/full.mp3`);
    const uploaded = await downloadFile(path!);
    expect(uploaded.equals(audio)).toBe(true);
  });
});
