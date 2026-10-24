import { spawnSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import * as sectionMaster from "./section-master";
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
  ECHOMANCER_SCRATCH_DIR: path.join(tmpdir(), `ec-finalize-test-${process.pid}`),
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

  it("masters only missing sections and omits the chain on the mixed fallback", async () => {
    const master = vi.spyOn(sectionMaster, "masterSectionBuffer").mockResolvedValue(Buffer.from("mastered"));
    const join = vi.spyOn(sectionMaster, "joinMasteredMp3s").mockRejectedValue(new Error("force fallback"));
    const d = deps(false);
    const run = vi.fn(d.run);
    try {
      const result = await streamFinalizeAudiobook("mixed", [
        { storagePath: "mastered.mp3", extension: "mp3", join: "paragraph", premastered: true },
        { storagePath: "raw.wav", extension: "wav", join: "paragraph" },
      ], 120, { ...d, run }, { ...ENV, TTS_MASTER_SKIP: undefined });
      expect(master).toHaveBeenCalledTimes(1);
      expect(join).toHaveBeenCalledTimes(1);
      expect(run.mock.calls.every(([args]) => !args.includes("-af"))).toBe(true);
      expect(result.deliveryMastered).toBe(true);
      await expect(stat(jobScratchDir("mixed", ENV))).rejects.toThrow();
    } finally {
      master.mockRestore();
      join.mockRestore();
    }
  });

  it("uploads chapters as a prefix instead of muxing a second file", async () => {
    const d = deps(false);
    const runCalls: string[][] = [];
    d.run = async (args) => {
      runCalls.push(args);
      const dest = args[args.length - 1]!;
      if (String(dest).endsWith(".wav")) {
        await writeFile(dest, pcmToWav(tone(1000, 44_100), { sampleRate: 44_100 }));
        return;
      }
      // A finished MP3 already carries a 30-byte ID3v2.3 header that the
      // prefix upload must skip past.
      await writeFile(
        dest,
        Buffer.concat([
          Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20]),
          Buffer.alloc(20),
          Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]),
        ])
      );
    };
    const prefixed: { prefix: Buffer; skipBytes: number; contentType: string }[] = [];
    const uploadedFiles: string[] = [];
    const result = await streamFinalizeAudiobook(
      "job-prefix",
      [
        { storagePath: "a.mp3", extension: "mp3", join: "paragraph" },
        { storagePath: "b.mp3", extension: "mp3", join: "paragraph" },
      ],
      120,
      {
        ...d,
        upload: async (localPath) => {
          uploadedFiles.push(localPath);
          return "audiobooks/job-prefix/full.mp3";
        },
        uploadWithPrefix: async (prefix, _localPath, contentType, skipBytes) => {
          prefixed.push({ prefix, skipBytes, contentType });
          return "audiobooks/job-prefix/full.mp3";
        },
      },
      ENV,
      {
        chapters: [
          { title: "Chapter One", sectionIndex: 0 },
          { title: "Chapter Two", sectionIndex: 1 },
        ],
      }
    );
    expect(result.storagePath).toBe("audiobooks/job-prefix/full.mp3");
    expect(uploadedFiles).toHaveLength(0);
    expect(prefixed).toHaveLength(1);
    const [tag] = prefixed;
    expect(tag!.prefix.toString("ascii", 0, 3)).toBe("ID3");
    expect(tag!.prefix.includes(Buffer.from("Chapter Two", "utf16le"))).toBe(true);
    expect(tag!.skipBytes).toBe(30);
    expect(tag!.contentType).toBe("audio/mpeg");
    // No second ffmpeg pass for chapters: only the section decodes and the encode.
    expect(runCalls.some((args) => args.some((arg) => arg.endsWith("chapters.ffmeta")))).toBe(false);
    expect(
      d.uploaded.every((file) => !file.includes("full-chapters"))
    ).toBe(true);
  });

  it("falls back to the ffmpeg chapter mux when the prefix upload fails", async () => {
    const d = deps(false);
    const runCalls: string[][] = [];
    d.run = async (args) => {
      runCalls.push(args);
      const dest = args[args.length - 1]!;
      if (String(dest).endsWith(".wav")) {
        await writeFile(dest, pcmToWav(tone(1000, 44_100), { sampleRate: 44_100 }));
        return;
      }
      await writeFile(dest, Buffer.from("ID3-fake-mp3"));
    };
    const result = await streamFinalizeAudiobook(
      "job-prefix-fallback",
      [
        { storagePath: "a.mp3", extension: "mp3", join: "paragraph" },
        { storagePath: "b.mp3", extension: "mp3", join: "paragraph" },
      ],
      120,
      {
        ...d,
        uploadWithPrefix: async () => {
          throw new Error("r2 multipart unavailable");
        },
      },
      ENV,
      { chapters: [{ title: "Chapter One", sectionIndex: 0 }] }
    );
    expect(result.storagePath).toBe("audiobooks/job-stream-1/full.mp3");
    expect(runCalls.some((args) => args.some((arg) => arg.endsWith("chapters.ffmeta")))).toBe(true);
    expect(d.uploaded).toHaveLength(1);
    expect(d.uploaded[0]!.endsWith("full-chapters.mp3")).toBe(true);
  });

  it("downloads and masters in bounded parallel while keeping index order", async () => {
    const total = 7;
    let downloadsInFlight = 0;
    let maxDownloads = 0;
    let mastersInFlight = 0;
    let maxMasters = 0;
    const downloadOrder: string[] = [];
    const joinFiles: string[][] = [];
    const master = vi.spyOn(sectionMaster, "masterSectionBuffer").mockImplementation(
      async () => {
        mastersInFlight += 1;
        maxMasters = Math.max(maxMasters, mastersInFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        mastersInFlight -= 1;
        return Buffer.from("mastered");
      }
    );
    const join = vi
      .spyOn(sectionMaster, "joinMasteredMp3s")
      .mockImplementation(async (opts) => {
        joinFiles.push([...opts.files]);
        throw new Error("force fallback");
      });
    try {
      const sections = Array.from({ length: total }, (_item, i) => ({
        storagePath: `section-${i}.${i === 0 ? "mp3" : "wav"}`,
        extension: (i === 0 ? "mp3" : "wav") as "mp3" | "wav",
        join: "paragraph" as const,
        premastered: i === 0,
      }));
      const run = vi.fn(async (args: string[]) => {
        const dest = args[args.length - 1]!;
        if (String(dest).endsWith(".wav")) {
          await writeFile(dest, pcmToWav(tone(1000, 44_100), { sampleRate: 44_100 }));
          return;
        }
        await writeFile(dest, Buffer.from("ID3-fake-mp3"));
      });
      await streamFinalizeAudiobook(
        "job-concurrent",
        sections,
        120,
        {
          download: async (_storagePath, dest) => {
            downloadsInFlight += 1;
            maxDownloads = Math.max(maxDownloads, downloadsInFlight);
            downloadOrder.push(path.basename(dest));
            await new Promise((resolve) => setTimeout(resolve, 15));
            downloadsInFlight -= 1;
            await writeFile(dest, Buffer.from("section-bytes"));
          },
          upload: async () => "audiobooks/job-concurrent/full.mp3",
          run,
        },
        { ...ENV, TTS_MASTER_SKIP: undefined }
      );
      expect(master).toHaveBeenCalledTimes(total - 1);
      expect(maxDownloads).toBeGreaterThan(1);
      expect(maxDownloads).toBeLessThanOrEqual(8);
      expect(maxMasters).toBeGreaterThan(1);
      expect(maxMasters).toBeLessThanOrEqual(3);
      expect(downloadOrder.slice(0, total)).toEqual(
        Array.from({ length: total }, (_item, i) => `mixed_${i}.${i === 0 ? "mp3" : "wav"}`)
      );
      expect(joinFiles[0]).toEqual([
        path.join(jobScratchDir("job-concurrent", ENV), "mixed_0.mp3"),
        ...Array.from({ length: total - 1 }, (_item, i) =>
          path.join(jobScratchDir("job-concurrent", ENV), `mixed_mastered_${i + 1}.mp3`)
        ),
      ]);
    } finally {
      master.mockRestore();
      join.mockRestore();
    }
  });

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
