import { describe, expect, it } from "vitest";
import { fakeMp3 } from "@/test/harness";
import { downloadFile, uploadFile } from "@/lib/storage";
import {
  ConcatAssembleError,
  concatReadySegments,
  materializeFullAudiobook,
} from "./concat-audio";
import { pcmToWav } from "./pcm-wav";
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
    const audio = fakeMp3(64_000);
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

describe("concatReadySegments remux", () => {
  it("does not return raw Buffer.concat of MP3 frames when remux is available", async () => {
    const jobId = "dddddddd-0000-4000-8000-000000000003";
    const a = fakeMp3(2048, 1);
    const b = fakeMp3(2048, 2);
    await uploadFile(`audiobooks/${jobId}/sections`, "0000.mp3", a, "audio/mpeg");
    await uploadFile(`audiobooks/${jobId}/sections`, "0001.mp3", b, "audio/mpeg");
    const segments: JobSegment[] = [
      {
        index: 0,
        path: `audiobooks/${jobId}/sections/0000.mp3`,
        status: "ready",
        contentType: "audio/mpeg",
      },
      {
        index: 1,
        path: `audiobooks/${jobId}/sections/0001.mp3`,
        status: "ready",
        contentType: "audio/mpeg",
      },
    ];
    const remuxed = Buffer.from("REMUXED-NOT-GLUE");
    const built = await concatReadySegments(segments, "[test]", {
      total: 2,
      remux: async () => remuxed,
    });
    expect(built?.buffer.equals(remuxed)).toBe(true);
    expect(built?.buffer.equals(Buffer.concat([a, b]))).toBe(false);
  });

  it("does not silently glue MP3 frames when ffmpeg is missing", async () => {
    const prev = process.env.TTS_CONCAT_FORCE_MISSING_FFMPEG;
    process.env.TTS_CONCAT_FORCE_MISSING_FFMPEG = "1";
    const jobId = "dddddddd-0000-4000-8000-000000000004";
    const a = fakeMp3(2048, 3);
    const b = fakeMp3(2048, 4);
    await uploadFile(`audiobooks/${jobId}/sections`, "0000.mp3", a, "audio/mpeg");
    await uploadFile(`audiobooks/${jobId}/sections`, "0001.mp3", b, "audio/mpeg");
    const segments: JobSegment[] = [
      {
        index: 0,
        path: `audiobooks/${jobId}/sections/0000.mp3`,
        status: "ready",
        contentType: "audio/mpeg",
      },
      {
        index: 1,
        path: `audiobooks/${jobId}/sections/0001.mp3`,
        status: "ready",
        contentType: "audio/mpeg",
      },
    ];
    try {
      await expect(
        concatReadySegments(segments, "[test]", { total: 2 })
      ).rejects.toBeInstanceOf(ConcatAssembleError);
    } finally {
      if (prev === undefined) delete process.env.TTS_CONCAT_FORCE_MISSING_FFMPEG;
      else process.env.TTS_CONCAT_FORCE_MISSING_FFMPEG = prev;
    }
  });
});

describe("concatReadySegments soft joins", () => {
  it("crossfades WAV sections instead of hard-concatenating", async () => {
    const jobId = "dddddddd-0000-4000-8000-000000000002";
    const sampleRate = 24_000;
    const tone = (value: number) => {
      const pcm = Buffer.alloc(sampleRate * 2);
      for (let i = 0; i < sampleRate; i++) pcm.writeInt16LE(value, i * 2);
      return pcmToWav(pcm, { sampleRate });
    };
    const a = tone(8000);
    const b = tone(0);
    await uploadFile(`audiobooks/${jobId}/sections`, "0000.wav", a, "audio/wav");
    await uploadFile(`audiobooks/${jobId}/sections`, "0001.wav", b, "audio/wav");
    const segments: JobSegment[] = [
      {
        index: 0,
        path: `audiobooks/${jobId}/sections/0000.wav`,
        status: "ready",
        contentType: "audio/wav",
      },
      {
        index: 1,
        path: `audiobooks/${jobId}/sections/0001.wav`,
        status: "ready",
        contentType: "audio/wav",
      },
    ];

    const built = await concatReadySegments(segments, "[test]", { total: 2 });
    expect(built?.format.extension).toBe("wav");
    const hardLen = a.length + b.length - 44;
    expect(built!.buffer.length).toBeLessThan(hardLen);
  });
});
