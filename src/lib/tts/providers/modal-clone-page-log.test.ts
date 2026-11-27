/**
 * A dispatch must emit one page line per GPU call, carrying the numbers the
 * container already measured.
 *
 * Written for the 49-minute book that reported 397 s of GPU wall with a single
 * 20-section page at 294 s for 2,581 s of audio (8.8x against the ~32x staging
 * reached). The worker logged `generate_s` and nothing else, so a page that
 * spent 142 s in encode and 31 s in prepare looked the same as a page that
 * spent 282 s generating. These tests pin the line's presence and its payload;
 * pricing the numbers is a separate, later decision.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchModalCloneLanes } from "@/lib/tts/providers/modal-clone-dispatch";

const perf = {
  sections: 20,
  audio_s: 2_581.4,
  page_rows: 20,
  prepare_s: 31.2,
  generate_s: 88.2,
  generate_and_codec_s: 121.8,
  codec_s: 61.4,
  encode_s: 141.9,
  call_s: 282.4,
  batch_width: 20,
  sections_streamed: 20,
  snapshot_age_s: 57,
  truncated_units: 0,
  upload_transport: "r2",
  frames: 55_500,
  frames_per_s: 629,
  generated_realtime_x: 29.3,
  host: {
    cloud: "modal",
    cpu_model: "Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz",
    gpu: "NVIDIA H100 80GB HBM3",
    driver: "580.95.05",
    cpu_count: 8,
  },
};

function outcome(keys: string[]) {
  const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
  for (const key of keys) {
    audio.set(key, { audio: Buffer.from("mp3"), durationSeconds: 120 });
  }
  return {
    audio,
    build: "4eefb28b9308",
    containerId: "ta-01M80H03GZTB0KX9RYYN37XGSR",
    boot: "restored",
    seed: 7,
    performance: perf,
    truncatedUnits: 0,
  };
}

const textAt = (index: number) => `section ${index} `.repeat(400);

function lines(seen: string[], marker: string): string[] {
  return seen.filter((line) => line.includes(marker));
}

/**
 * The dispatch already routes everything through `opts.log`, and the tick
 * passes `console.log`. Capturing here is the same path a book takes, and it
 * also proves no page line escapes to a second destination.
 */
function capture() {
  const seen: string[] = [];
  return { seen, log: (message: string) => seen.push(message) };
}

describe("dispatch page logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MODAL_S2_PAGE_LOG;
  });

  it("logs one page line per GPU call, with the container's own split", async () => {
    const { seen, log } = capture();
    await dispatchModalCloneLanes({
      indexes: [0, 1, 2],
      textAt,
      lanes: 1,
      batch: 24,
      maxLaneChars: 40_000,
      seedEpoch: 0,
      firstLight: false,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      jobId: "job-abc",
      log,
      render: async (items: { key: string }[]) => outcome(items.map((item) => item.key)),
      stage: async () => {},
    });

    const pages = lines(seen, "[S2 page]");
    expect(pages).toHaveLength(1);

    const page = pages[0]!;
    expect(page).toContain("job=job-abc");
    expect(page).toContain("rows=3/3");
    expect(page).toContain("call=282.4s");
    expect(page).toContain("generate=88.2s");
    expect(page).toContain("codec=61.4s");
    // Encode was the largest single block on the real call, and it used to be
    // invisible: `generate_s` alone said 88 s of a 294 s page.
    expect(page).toContain("encode=141.9s");
    expect(page).toContain("container=ta-01M80H03GZTB0KX9RYYN37XGSR");
    expect(page).toContain("snapshot_age=57.0s");
    expect(page).toContain("width=20");
    // The whole object travels too, so a counter added server-side later is
    // visible without a worker change.
    expect(page).toContain('"frames_per_s":629');
  });

  it("logs a dispatch summary pairing the wall paid with the generation it got", async () => {
    const { seen, log } = capture();
    await dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt,
      lanes: 1,
      batch: 24,
      maxLaneChars: 40_000,
      seedEpoch: 0,
      firstLight: false,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      jobId: "job-xyz",
      log,
      render: async (items: { key: string }[]) => outcome(items.map((item) => item.key)),
      stage: async () => {},
    });

    const summary = lines(seen, "[S2 dispatch]");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain("job=job-xyz");
    expect(summary[0]).toContain("pages=1");
    expect(summary[0]).toContain("rows=2/2");
    expect(summary[0]).toContain("generate=88.2s");
    expect(summary[0]).toContain("gpu_wall=");
    expect(summary[0]).toContain("wall_over_generate=");
  });

  it("counts a page's frame-cap truncations on the dispatch result", async () => {
    const { seen, log } = capture();
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt,
      lanes: 1,
      batch: 24,
      maxLaneChars: 40_000,
      seedEpoch: 0,
      firstLight: false,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      jobId: "job-trunc",
      log,
      render: async (items: { key: string }[]) => ({
        ...outcome(items.map((item) => item.key)),
        truncatedUnits: 2,
      }),
      stage: async () => {},
    });
    expect(result.truncatedUnits).toBe(2);
    expect(lines(seen, "[S2 page]")[0]).toContain("truncated=2");
  });

  it("logs nothing when the page log is switched off", async () => {
    process.env.MODAL_S2_PAGE_LOG = "0";
    const { seen, log } = capture();
    await dispatchModalCloneLanes({
      indexes: [0],
      textAt,
      lanes: 1,
      batch: 24,
      maxLaneChars: 40_000,
      seedEpoch: 0,
      firstLight: false,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      log,
      render: async (items: { key: string }[]) => outcome(items.map((item) => item.key)),
      stage: async () => {},
    });
    expect(lines(seen, "[S2 page]")).toHaveLength(0);
    expect(lines(seen, "[S2 dispatch]")).toHaveLength(0);
    // The rest of the dispatch's own reporting is untouched.
    expect(lines(seen, "[S2 lanes]").length).toBeGreaterThan(0);
  });

  it("routes both lines through the dispatch's logger, not stdout", async () => {
    const stdout: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(" "));
    });
    const custom: string[] = [];
    await dispatchModalCloneLanes({
      indexes: [0],
      textAt,
      lanes: 1,
      batch: 24,
      maxLaneChars: 40_000,
      seedEpoch: 0,
      firstLight: false,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      log: (message) => custom.push(message),
      render: async (items: { key: string }[]) => outcome(items.map((item) => item.key)),
      stage: async () => {},
    });
    expect(lines(custom, "[S2 page]")).toHaveLength(1);
    expect(lines(custom, "[S2 dispatch]")).toHaveLength(1);
    expect(lines(stdout, "[S2 page]")).toHaveLength(0);
    expect(lines(stdout, "[S2 dispatch]")).toHaveLength(0);
  });

  it("writes the page line to stdout when the tick's logger is console.log", async () => {
    const stdout: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(" "));
    });
    await dispatchModalCloneLanes({
      indexes: [0],
      textAt,
      lanes: 1,
      batch: 24,
      maxLaneChars: 40_000,
      seedEpoch: 0,
      firstLight: false,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      log: (message) => console.log(message),
      render: async (items: { key: string }[]) => outcome(items.map((item) => item.key)),
      stage: async () => {},
    });
    expect(lines(stdout, "[S2 page]")).toHaveLength(1);
  });
});
