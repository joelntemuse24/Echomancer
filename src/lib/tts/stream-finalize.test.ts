import { spawnSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pcmToWav } from "./pcm-wav";
import { crossfadePcm16Mono, trimPcm16EdgeSilence } from "./crossfade-audio";
import { jobScratchDir } from "./job-scratch";
import {
  MAX_EDGE_READ_SAMPLES,
  encodedMp3TooLarge,
  planDiskJoins,
  readWavSampleRange,
  streamFinalizeAudiobook,
  type StreamFinalizeDeps,
} from "./stream-finalize";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ENV = {
  ECHOMANCER_SCRATCH_DIR: path.join("/tmp", `ec-finalize-test-${process.pid}`),
  FFMPEG_PATH: "ffmpeg",
  TTS_MASTER_SKIP: "1",
} as NodeJS.ProcessEnv;

function tone(value: number, samples: number, leadSilence = 0): Buffer {
  const pcm = Buffer.alloc((samples + leadSilence) * 2);
  for (let i = leadSilence; i < samples + leadSilence; i++) pcm.writeInt16LE(value, i * 2);
  return pcm;
}

describe("disk joins stay on the edges", () => {
  it("matches the in-memory trim and equal-power crossfade", async () => {
    const dir = path.join(ENV.ECHOMANCER_SCRATCH_DIR!, "joins");
    await mkdir(dir, { recursive: true });
    const rate = 44_100;
    const left = trimPcm16EdgeSilence(tone(8000, rate, 2000), rate);
    const right = trimPcm16EdgeSilence(tone(2000, rate, 1000), rate);
    const a = path.join(dir, "a.wav");
    const b = path.join(dir, "b.wav");
    await writeFile(a, pcmToWav(tone(8000, rate, 2000), { sampleRate: rate }));
    await writeFile(b, pcmToWav(tone(2000, rate, 1000), { sampleRate: rate }));
    const planned = await planDiskJoins([a, b], ["paragraph", "paragraph"], 120);
    const mix = planned.pieces.find((piece) => piece.kind === "mix");
    expect(mix && mix.kind === "mix").toBe(true);
    if (!mix || mix.kind !== "mix") return;
    const fade = Math.round((rate * 120) / 1000);
    const expected = crossfadePcm16Mono(
      left.subarray(left.length - fade * 2),
      right.subarray(0, fade * 2),
      rate,
      120
    );
    expect(mix.pcm.equals(expected)).toBe(true);
    const span0 = planned.spans[0]!;
    expect(span0.end - span0.start).toBe(left.length / 2 - fade);
  });

  it("refuses a book-length sample read", async () => {
    const dir = path.join(ENV.ECHOMANCER_SCRATCH_DIR!, "cap");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "short.wav");
    await writeFile(file, pcmToWav(tone(1, 100), { sampleRate: 44_100 }));
    await expect(
      readWavSampleRange(file, 0, MAX_EDGE_READ_SAMPLES + 1)
    ).rejects.toThrow(/refusing wav read/);
  });
});

describe("streamFinalizeAudiobook", () => {
  const jobId = "job-stream-1";

  function deps(failEncode: boolean): StreamFinalizeDeps & { uploaded: string[] } {
    const uploaded: string[] = [];
    return {
      uploaded,
      download: async (_storage, dest) => {
        await writeFile(dest, Buffer.from("section-bytes"));
      },
      upload: async (localPath) => {
        const info = await stat(localPath);
        expect(info.size).toBeGreaterThan(0);
        uploaded.push(localPath);
        return `audiobooks/${jobId}/full.mp3`;
      },
      run: async (args) => {
        const dest = args[args.length - 1]!;
        if (String(dest).endsWith(".wav")) {
          await writeFile(dest, pcmToWav(tone(1000, 44_100), { sampleRate: 44_100 }));
          return;
        }
        if (failEncode) throw new Error("ffmpeg exploded");
        await writeFile(dest, Buffer.from("ID3-fake-mp3"));
      },
    };
  }

  it("uploads from a file and deletes the scratch dir", async () => {
    const d = deps(false);
    const result = await streamFinalizeAudiobook(
      jobId,
      [
        { storagePath: "a.mp3", extension: "mp3", join: "paragraph" },
        { storagePath: "b.mp3", extension: "mp3", join: "paragraph" },
      ],
      120,
      d,
      ENV
    );
    expect(result.storagePath).toBe(`audiobooks/${jobId}/full.mp3`);
    expect(d.uploaded).toHaveLength(1);
    await expect(stat(jobScratchDir(jobId, ENV))).rejects.toThrow();
  });

  it("refuses a fallback encode that is many times the decoded audio", async () => {
    const d = deps(false);
    d.run = async (args) => {
      const dest = args[args.length - 1]!;
      if (String(dest).endsWith(".wav")) {
        await writeFile(dest, pcmToWav(tone(1000, 44_100), { sampleRate: 44_100 }));
        return;
      }
      await writeFile(dest, Buffer.alloc(5_000_000, 1));
    };
    await expect(
      streamFinalizeAudiobook(
        jobId,
        [
          { storagePath: "a.mp3", extension: "mp3", join: "paragraph" },
          { storagePath: "b.mp3", extension: "mp3", join: "paragraph" },
        ],
        120,
        d,
        ENV
      )
    ).rejects.toThrow(/128 kbps size of the decoded audio/);
    expect(d.uploaded).toHaveLength(0);
  });

  it("deletes the scratch dir when ffmpeg fails", async () => {
    const d = deps(true);
    await expect(
      streamFinalizeAudiobook(
        jobId,
        [{ storagePath: "a.mp3", extension: "mp3", join: "paragraph" }],
        120,
        d,
        ENV
      )
    ).rejects.toThrow(/ffmpeg exploded/);
    await expect(stat(jobScratchDir(jobId, ENV))).rejects.toThrow();
    expect(d.uploaded).toHaveLength(0);
  });
});

describe("encoded size guard", () => {
  it("allows a 128 kbps file and rejects an hour stuffed into a few seconds", () => {
    const samples = 44_100 * 3;
    expect(encodedMp3TooLarge(3 * 16_000, samples)).toBe(false);
    expect(encodedMp3TooLarge(3 * 16_000 * 20, samples)).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg)("ffmpeg streaming finalize", () => {
  it("encodes two sections without keeping the wavs after upload", async () => {
    const dir = path.join(ENV.ECHOMANCER_SCRATCH_DIR!, "src");
    await mkdir(dir, { recursive: true });
    const make = (name: string, freq: number) =>
      new Promise<void>((resolve, reject) => {
        const child = spawnSync(
          "ffmpeg",
          [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=${freq}:sample_rate=44100:duration=1`,
            "-ac",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            path.join(dir, name),
          ],
          { encoding: "utf8" }
        );
        if (child.status === 0) resolve();
        else reject(new Error(child.stderr));
      });
    await make("a.mp3", 220);
    await make("b.mp3", 330);
    const jobId = "job-ffmpeg";
    let sawFile = false;
    const result = await streamFinalizeAudiobook(
      jobId,
      [
        { storagePath: path.join(dir, "a.mp3"), extension: "mp3", join: "paragraph" },
        { storagePath: path.join(dir, "b.mp3"), extension: "mp3", join: "mid-paragraph" },
      ],
      120,
      {
        download: async (storagePath, dest) => {
          const { copyFile } = await import("node:fs/promises");
          await copyFile(storagePath, dest);
        },
        upload: async (localPath) => {
          const info = await stat(localPath);
          expect(info.size).toBeGreaterThan(1000);
          sawFile = true;
          return "audiobooks/job-ffmpeg/full.mp3";
        },
        run: (await import("./stream-finalize")).spawnFfmpeg,
      },
      { ...ENV, TTS_MASTER_SKIP: "1" }
    );
    expect(result.deliveryMastered).toBe(false);
    expect(sawFile).toBe(true);
    await expect(stat(jobScratchDir(jobId, ENV))).rejects.toThrow();
  });

  it("keeps a mastered-join fallback near the section duration", async () => {
    const dir = path.join(ENV.ECHOMANCER_SCRATCH_DIR!, "fallback");
    await mkdir(dir, { recursive: true });
    const files = ["a.mp3", "b.mp3", "c.mp3"];
    for (let i = 0; i < files.length; i++) {
      const child = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${220 + i * 40}:sample_rate=44100:duration=2`,
          "-ac",
          "1",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "128k",
          path.join(dir, files[i]!),
        ],
        { encoding: "utf8" }
      );
      if (child.status !== 0) throw new Error(child.stderr.slice(-300));
    }
    const jobId = "job-fallback-size";
    let size = 0;
    let duration = 0;
    await streamFinalizeAudiobook(
      jobId,
      files.map((name) => ({
        storagePath: path.join(dir, name),
        extension: "mp3" as const,
        join: "paragraph" as const,
        premastered: true,
      })),
      80,
      {
        download: async (storagePath, dest) => {
          const { copyFile } = await import("node:fs/promises");
          await copyFile(storagePath, dest);
        },
        upload: async (localPath) => {
          const info = await stat(localPath);
          size = info.size;
          const probed = spawnSync(
            "ffprobe",
            ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", localPath],
            { encoding: "utf8" }
          );
          duration = Number(probed.stdout.trim());
          return `audiobooks/${jobId}/full.mp3`;
        },
        run: (await import("./stream-finalize")).spawnFfmpeg,
      },
      { ...ENV, TTS_MASTER_SKIP: undefined, TTS_MASTER_DFN: undefined, TTS_MASTER_DFN_WET: undefined }
    );
    expect(duration).toBeGreaterThan(4);
    expect(duration).toBeLessThan(9);
    expect(size).toBeLessThan(9 * 16_000 * 1.4);
  });
});
