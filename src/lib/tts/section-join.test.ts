import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MASTER_LOUDNORM_I } from "@/lib/tts/mastering";
import { masterSectionBuffer } from "@/lib/tts/section-master";
import { spawnFfmpeg, streamFinalizeAudiobook } from "@/lib/tts/stream-finalize";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const SECTIONS = 12;
// Long enough that a full-book loudnorm costs more than the join search.
// The search encodes a couple of seconds per boundary, so it stays put
// while the old finish grows with the book.
const SECTION_SECONDS = 60;

function run(args: string[]) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr.slice(-400));
}

function loudness(file: string, start: number, seconds: number): number {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-ss",
      String(start),
      "-t",
      String(seconds),
      "-i",
      file,
      "-af",
      "ebur128=framelog=verbose",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" }
  );
  const match = result.stderr.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  if (!match) throw new Error(result.stderr.slice(-300));
  return Number(match[1]);
}

describe.skipIf(!hasFfmpeg)("mastered section copy join", () => {
  it(
    "finishes twelve sections faster than a full-book encode, without clicks",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "ec-join-"));
      const scratch = path.join(dir, "scratch");
      const raw: string[] = [];
      for (let i = 0; i < SECTIONS; i++) {
        const file = path.join(dir, `raw-${i}.mp3`);
        const gain = [0.12, 0.35, 0.7][i % 3]!;
        const phase = (i * 1.3).toFixed(3);
        run([
          "-f",
          "lavfi",
          "-i",
          `aevalsrc=${gain}*sin(2*PI*220*t+${phase}):s=44100:d=${SECTION_SECONDS}`,
          "-ac",
          "1",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "192k",
          file,
        ]);
        raw.push(file);
      }

      const env = {
        ECHOMANCER_SCRATCH_DIR: scratch,
        FFMPEG_PATH: "ffmpeg",
        FFPROBE_PATH: "ffprobe",
      } as NodeJS.ProcessEnv;
      const download = async (storagePath: string, dest: string) => {
        await copyFile(storagePath, dest);
      };

      const oldOut = path.join(dir, "old.mp3");
      const oldStarted = Date.now();
      await streamFinalizeAudiobook(
        "old-finish",
        raw.map((file) => ({
          storagePath: file,
          extension: "mp3" as const,
          join: "paragraph" as const,
        })),
        120,
        {
          download,
          upload: async (localPath) => {
            await copyFile(localPath, oldOut);
            return oldOut;
          },
          run: spawnFfmpeg,
        },
        env
      );
      const oldFinishMs = Date.now() - oldStarted;

      const mastered: string[] = [];
      const masterStarted = Date.now();
      for (let i = 0; i < raw.length; i++) {
        const audio = await readFile(raw[i]!);
        const out = await masterSectionBuffer(audio, "mp3", {
          ...env,
          TTS_SECTION_MASTER: "1",
          WORKER: "1",
        });
        expect(out).toBeTruthy();
        const file = path.join(dir, `mastered-${i}.mp3`);
        await import("node:fs/promises").then((fs) => fs.writeFile(file, out!));
        mastered.push(file);
      }
      const sectionMasterMs = Date.now() - masterStarted;

      const newOut = path.join(dir, "new.mp3");
      const newStarted = Date.now();
      await streamFinalizeAudiobook(
        "new-finish",
        mastered.map((file) => ({
          storagePath: file,
          extension: "mp3" as const,
          join: "paragraph" as const,
          premastered: true,
        })),
        120,
        {
          download,
          upload: async (localPath) => {
            await copyFile(localPath, newOut);
            return newOut;
          },
          run: spawnFfmpeg,
        },
        env
      );
      const newFinishMs = Date.now() - newStarted;

      const pcmPath = path.join(dir, "new.pcm");
      run(["-i", newOut, "-ac", "1", "-ar", "44100", "-f", "s16le", pcmPath]);
      const pcm = await readFile(pcmPath);
      // LAME padding at the file ends is not a section join.
      const edge = 44100 * 2;
      const deltas: number[] = [];
      let maxJump = 0;
      for (let i = edge; i < pcm.length - edge; i += 2) {
        const jump = Math.abs(pcm.readInt16LE(i) - pcm.readInt16LE(i - 2));
        deltas.push(jump);
        if (jump > maxJump) maxJump = jump;
      }
      deltas.sort((a, b) => a - b);
      const p99 = deltas[Math.floor(deltas.length * 0.99)] ?? 0;

      const levels: number[] = [];
      for (let i = 0; i < SECTIONS; i++) {
        const start = 2 + i * (SECTION_SECONDS - 0.12);
        levels.push(loudness(newOut, start, 6));
      }
      const spread = Math.max(...levels) - Math.min(...levels);

      const duration = Number(
        spawnSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", newOut],
          { encoding: "utf8" }
        ).stdout
      );
      console.log(
        JSON.stringify({
          sections: SECTIONS,
          sectionSeconds: SECTION_SECONDS,
          oldFinishMs,
          newFinishMs,
          sectionMasterMs,
          maxJump,
          p99,
          duration: +duration.toFixed(2),
          levels: levels.map((n) => +n.toFixed(2)),
          spread: +spread.toFixed(2),
        })
      );
      const expected = SECTIONS * SECTION_SECONDS - (SECTIONS - 1) * 0.12;
      expect(duration).toBeGreaterThan(expected - 4);
      expect(duration).toBeLessThan(expected + 1.5);

      expect(newFinishMs).toBeLessThan(oldFinishMs);
      expect(maxJump).toBeLessThan(p99 * 6);
      expect(spread).toBeLessThan(2);
      for (const level of levels) {
        expect(Math.abs(level - MASTER_LOUDNORM_I)).toBeLessThan(2.5);
      }

      await rm(dir, { recursive: true, force: true });
    },
    180_000
  );

  it(
    "keeps the fast path when a section has a consonant-sized step",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "ec-join-spike-"));
      const scratch = path.join(dir, "scratch");
      const count = 4;
      const mastered: string[] = [];
      for (let i = 0; i < count; i++) {
        const raw = path.join(dir, `raw-${i}.mp3`);
        const phase = (i * 1.3).toFixed(3);
        run([
          "-f",
          "lavfi",
          "-i",
          `aevalsrc=0.2*sin(2*PI*180*t+${phase})+0.35*between(t\\,0.5\\,0.50005):s=44100:d=6`,
          "-ac",
          "1",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "192k",
          raw,
        ]);
        const audio = await readFile(raw);
        const out = await masterSectionBuffer(audio, "mp3", {
          ECHOMANCER_SCRATCH_DIR: scratch,
          FFMPEG_PATH: "ffmpeg",
          FFPROBE_PATH: "ffprobe",
          TTS_SECTION_MASTER: "1",
          WORKER: "1",
        } as NodeJS.ProcessEnv);
        expect(out).toBeTruthy();
        const file = path.join(dir, `mastered-${i}.mp3`);
        await import("node:fs/promises").then((fs) => fs.writeFile(file, out!));
        mastered.push(file);
      }

      const logs: string[] = [];
      const original = console.log;
      const warn = console.warn;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      console.warn = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      const out = path.join(dir, "joined.mp3");
      try {
        await streamFinalizeAudiobook(
          "spike-finish",
          mastered.map((file) => ({
            storagePath: file,
            extension: "mp3" as const,
            join: "paragraph" as const,
            premastered: true,
          })),
          120,
          {
            download: async (storagePath: string, dest: string) => {
              await copyFile(storagePath, dest);
            },
            upload: async (localPath) => {
              await copyFile(localPath, out);
              return out;
            },
            run: spawnFfmpeg,
          },
          { ECHOMANCER_SCRATCH_DIR: scratch, FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" }
        );
      } finally {
        console.log = original;
        console.warn = warn;
      }

      const clickLog = logs.find((line) => line.includes("would click"));
      expect(clickLog ?? "", logs.join("\n")).toBe("");
      expect(logs.some((line) => line.includes("joined 4 mastered sections"))).toBe(true);
      const step = Number(logs.join(" ").match(/worst splice step (\d+)/)?.[1]);
      expect(step).toBeLessThan(4000);
      await rm(dir, { recursive: true, force: true });
    },
    120_000
  );
});
