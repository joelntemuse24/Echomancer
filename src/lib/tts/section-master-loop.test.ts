import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ffmpegSlotLimit, masterSectionBuffer } from "@/lib/tts/section-master";
import { settleSectionTake } from "@/lib/tts/transcript-qa";
import { routeTakehomeWorkerRequest } from "@/worker/takehome-http";
import type { TakehomeWorkerLoop } from "@/worker/takehome-loop";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function sineMp3(file: string, seconds: number): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=24000:duration=${seconds}`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "48k",
      file,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr.slice(-300));
}

describe.skipIf(!hasFfmpeg)("section master event loop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps ffmpeg at the CPU count", () => {
    expect(ffmpegSlotLimit()).toBe(Math.max(1, availableParallelism()));
  });

  it("fires the QA cap while a section master is still running", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ec-master-loop-"));
    const file = path.join(dir, "section.mp3");
    sineMp3(file, 25);
    const audio = await readFile(file);
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      FFMPEG_PATH: "ffmpeg",
      FFPROBE_PATH: "ffprobe",
      ECHOMANCER_SCRATCH_DIR: dir,
      TTS_SECTION_MASTER: "1",
    } as NodeJS.ProcessEnv;

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 30);
    const mastering = masterSectionBuffer(audio, "mp3", env);
    const healthStarted = Date.now();
    const health = await routeTakehomeWorkerRequest({
      method: "GET",
      url: "/health",
      loop: { inflightCount: 1, concurrency: 1 } as TakehomeWorkerLoop,
      startedAt: Date.now(),
    });
    const healthMs = Date.now() - healthStarted;
    const started = Date.now();
    const settled = await settleSectionTake({
      jobId: "loop",
      index: 1,
      sourceText: "the harbor was quiet after the rain",
      first: { audio, contentType: "audio/mpeg" },
      synthesize: async () => null,
      rate: { chars: 0, seconds: 0 },
      env: {
        ...env,
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA: "1",
        TTS_QA_BUDGET_MS: "200",
      } as NodeJS.ProcessEnv,
    });
    const qaMs = Date.now() - started;
    clearInterval(timer);
    const opened = warn.mock.calls.some((call) => String(call[0]).includes("action=open"));
    await mastering;
    await rm(dir, { recursive: true, force: true });

    expect(settled.audio).toBe(audio);
    expect(opened).toBe(true);
    expect(qaMs).toBeLessThan(1_000);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(health.status).toBe(200);
    expect(healthMs).toBeLessThan(200);
  });
});
