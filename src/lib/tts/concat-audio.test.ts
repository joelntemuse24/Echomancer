import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeMp3 } from "@/test/harness";
import { deleteFile, downloadFile, uploadFile } from "@/lib/storage";
import {
  ConcatAssembleError,
  concatReadySegments,
  materializeFullAudiobook,
} from "./concat-audio";
import {
  frozenSpeakablePath,
  persistFrozenScript,
  PLAYBACK_CHAPTERS_NAME,
} from "./frozen-script";
import { pcmToWav } from "./pcm-wav";
import type { FrozenSection, JobSegment } from "./types";

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

  it("exposes dry concat via onDryUploaded before enhance overwrites", async () => {
    const audio = fakeMp3(64_000);
    const segments = await seedSection(audio);
    const mastered = Buffer.from("MASTERED-FULL-BOOK-BYTES-XXXX");
    const order: string[] = [];

    const path = await materializeFullAudiobook(JOB_ID, segments, 1, {
      onDryUploaded: async (uploadedPath) => {
        order.push("dry");
        const body = await downloadFile(uploadedPath);
        expect(body.equals(audio)).toBe(true);
      },
      enhance: async () => {
        order.push("enhance");
        return mastered;
      },
    });

    expect(path).toBe(`audiobooks/${JOB_ID}/full.mp3`);
    expect(order).toEqual(["dry", "enhance"]);
    const uploaded = await downloadFile(path!);
    expect(uploaded.equals(mastered)).toBe(true);
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

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("finalize chapter timing", () => {
  const SECTIONS = 14;
  const SECTION_SECONDS = 2;
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.TTS_CONCAT_CROSSFADE_FFMPEG = "1";
    process.env.TTS_MASTER_SKIP = "1";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function toneMp3(): Buffer {
    const dir = mkdtempSync(path.join(tmpdir(), "ec-chapter-tone-"));
    try {
      const out = path.join(dir, "tone.mp3");
      const run = spawnSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${SECTION_SECONDS}`,
        "-ar", "44100", "-ac", "1", "-b:a", "64k", out,
      ]);
      if (run.status !== 0) throw new Error("ffmpeg could not make a tone");
      return readFileSync(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function seed(jobId: string, speakableText?: string | null) {
    const bodies = Array.from({ length: SECTIONS }, (_, i) => `S${String(i).padStart(2, "0")} words go here.`);
    const speakable = bodies.join("\n\n");
    let running = 0;
    const sections: FrozenSection[] = bodies.map((text, index) => {
      const section: FrozenSection = {
        index,
        text,
        chapterIndex: 0,
        chapterTitle: index === 0 ? "Book" : null,
        charStart: running,
        charEnd: running + text.length,
      };
      running += text.length;
      return section;
    });
    await persistFrozenScript(jobId, { speakable, sections });
    if (speakableText === null) {
      await deleteFile(frozenSpeakablePath(jobId));
    }
    const heading = speakable.indexOf("S12 ");
    await uploadFile(
      `audiobooks/${jobId}`,
      PLAYBACK_CHAPTERS_NAME,
      Buffer.from(
        JSON.stringify({
          chapters: [
            { index: 0, title: "Book", startFraction: 0, charStart: 0 },
            { index: 1, title: "Late", startFraction: 0.9, charStart: heading },
          ],
        }),
        "utf8"
      ),
      "application/json"
    );
    const tone = toneMp3();
    const segments: JobSegment[] = [];
    for (let i = 0; i < SECTIONS; i++) {
      const name = `${String(i).padStart(4, "0")}.mp3`;
      await uploadFile(`audiobooks/${jobId}/sections`, name, tone, "audio/mpeg");
      segments.push({
        index: i,
        path: `audiobooks/${jobId}/sections/${name}`,
        status: "ready",
        contentType: "audio/mpeg",
      });
    }
    return segments;
  }

  async function lateStart(jobId: string): Promise<number> {
    const stored = JSON.parse(
      (await downloadFile(`audiobooks/${jobId}/${PLAYBACK_CHAPTERS_NAME}`)).toString("utf8")
    ) as { chapters: Array<{ title: string; startSeconds?: number }> };
    return stored.chapters.find((chapter) => chapter.title === "Late")!.startSeconds!;
  }

  async function sectionStart(jobId: string, index: number): Promise<number> {
    const stored = JSON.parse(
      (await downloadFile(`audiobooks/${jobId}/section-starts.json`)).toString("utf8")
    ) as { sectionStarts: number[] };
    return stored.sectionStarts[index]!;
  }

  it.skipIf(!hasFfmpeg)("times a late heading in its own section from the speakable text", async () => {
    const jobId = "dddddddd-0000-4000-8000-000000000010";
    const segments = await seed(jobId);
    await materializeFullAudiobook(jobId, segments, SECTIONS);
    expect(await lateStart(jobId)).toBeCloseTo(await sectionStart(jobId, 12), 2);
  });

  it.skipIf(!hasFfmpeg)("keeps timing from the outline when speakable.txt is missing", async () => {
    const jobId = "dddddddd-0000-4000-8000-000000000011";
    const segments = await seed(jobId, null);
    const path = await materializeFullAudiobook(jobId, segments, SECTIONS);
    expect(path).toBe(`audiobooks/${jobId}/full.mp3`);
    // Packed offsets put the heading past the start of its section.
    expect(await lateStart(jobId)).toBeGreaterThan((await sectionStart(jobId, 12)) + 0.2);
  });
});
