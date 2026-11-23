/**
 * The page log is the only evidence a cost investigation has, so it must be
 * correct, one line, and unable to fail a page.
 *
 * The incident these tests were written for: a 49-minute book spent 397 s of
 * GPU wall, one 20-section page took 294 s for 2,581 s of audio (8.8x against
 * the ~32x staging reached), and the worker's log carried `generate_s` but not
 * `prepare_s`, `codec_s`, `encode_s`, `batch_width`, `snapshot_age_s` or the
 * container id. "Where did 294 s go" was unanswerable from the log.
 */

import { describe, expect, it } from "vitest";
import {
  formatDispatchSummary,
  formatPageLog,
  logDispatchSummary,
  logPageCall,
  pageLogMode,
  snapshotAgeFrom,
} from "@/lib/tts/providers/modal-clone-timing";

const PAGE = {
  jobId: "job-abc",
  page: 3,
  pageRows: 20,
  renderedRows: 20,
  chars: 41_230,
  bookSections: 20,
  wallMs: 294_100,
  containerId: "ta-01M80H03GZTB0KX9RYYN37XGSR",
  build: "4eefb28b9308",
  boot: "restored",
  truncatedUnits: 0,
  warmBatch: true,
  performance: {
    sections: 20,
    audio_s: 2_581.4,
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
    frames: 55_500,
    frames_per_s: 629,
    generated_realtime_x: 29.3,
  },
};

describe("pageLogMode", () => {
  it("logs by default, because a page line is the only trace there is", () => {
    expect(pageLogMode({})).toBe("verbose");
    expect(pageLogMode({ MODAL_S2_PAGE_LOG: "" })).toBe("verbose");
  });

  it("can be switched off without a code change", () => {
    for (const raw of ["0", "off", "false", "no", " 0 "]) {
      expect(pageLogMode({ MODAL_S2_PAGE_LOG: raw })).toBe("off");
    }
  });

  it("understands an explicit summary mode", () => {
    expect(pageLogMode({ MODAL_S2_PAGE_LOG: "summary" })).toBe("summary");
  });

  it("treats an unrecognised value as on, not off", () => {
    expect(pageLogMode({ MODAL_S2_PAGE_LOG: "verbose" })).toBe("verbose");
    expect(pageLogMode({ MODAL_S2_PAGE_LOG: "1" })).toBe("verbose");
  });
});

describe("formatPageLog", () => {
  it("carries every split the container measured", () => {
    const line = formatPageLog(PAGE);
    expect(line).toContain("call=282.4s");
    expect(line).toContain("generate=88.2s");
    expect(line).toContain("codec=61.4s");
    expect(line).toContain("encode=141.9s");
    expect(line).toContain("audio=2581.4s");
    expect(line).toContain("width=20");
  });

  it("carries the wall the book actually paid, not just the container's view", () => {
    // `call_s` starts after Modal accepted the input. 294 s of wall against
    // 282 s of `call_s` is the placement and response-body region.
    const line = formatPageLog(PAGE);
    expect(line).toContain("wall=294.1s");
  });

  it("names the container, build, boot and snapshot age", () => {
    const line = formatPageLog(PAGE);
    expect(line).toContain("container=ta-01M80H03GZTB0KX9RYYN37XGSR");
    expect(line).toContain("build=4eefb28b9308");
    expect(line).toContain("boot=restored");
    expect(line).toContain("snapshot_age=57.0s");
  });

  it("counts the rows it planned and the rows it got", () => {
    const line = formatPageLog(PAGE);
    expect(line).toContain("page=3");
    expect(line).toContain("rows=20/20");
    expect(line).toContain("chars=41230");
    expect(line).toContain("book=20");
  });

  it("reports a page that lost rows to the frame cap", () => {
    const line = formatPageLog({
      ...PAGE,
      renderedRows: 18,
      truncatedUnits: 2,
      performance: { ...PAGE.performance, truncated_units: 2 },
    });
    expect(line).toContain("rows=18/20");
    expect(line).toContain("truncated=2");
  });

  it("falls back to the container's own truncated count", () => {
    const line = formatPageLog({
      ...PAGE,
      truncatedUnits: null,
      performance: { ...PAGE.performance, truncated_units: 3 },
    });
    expect(line).toContain("truncated=3");
  });

  it("appends the whole performance object so no field is lost", () => {
    const line = formatPageLog(PAGE);
    // The JSON is the escape hatch: a counter added to the container later is
    // still visible here without a worker change.
    expect(line).toContain('"frames_per_s":629');
    expect(line).toContain("frames_per_s=629");
  });

  it("keeps a field in the JSON even when it has no summary column", () => {
    const line = formatPageLog({
      ...PAGE,
      performance: { ...PAGE.performance, some_new_container_counter: 7 },
    });
    expect(line).toContain('"some_new_container_counter":7');
  });

  it("says `perf=absent` rather than inventing zeros", () => {
    const line = formatPageLog({ ...PAGE, performance: null });
    expect(line).toContain("perf=absent");
    expect(line).toContain("call=-");
    expect(line).toContain("generate=-");
  });

  it("stays on one line even if a value contains a newline", () => {
    const line = formatPageLog({
      ...PAGE,
      performance: { ...PAGE.performance, upload_transport: "r2\nspoofed line" },
    });
    expect(line.split("\n")).toHaveLength(1);
  });

  it("is empty when logging is off", () => {
    expect(formatPageLog({ ...PAGE, env: { MODAL_S2_PAGE_LOG: "0" } })).toBe("");
  });

  it("omits the page index when the caller has none", () => {
    const line = formatPageLog({ ...PAGE, page: null });
    expect(line).not.toContain("page=");
    expect(line).toContain("rows=20/20");
  });

  it("omits the wait kind when the caller did not set one", () => {
    expect(formatPageLog(PAGE)).not.toContain("wait=");
    expect(formatPageLog({ ...PAGE, waitKind: "warm" })).toContain("wait=warm");
  });

  it("says warm=1 or warm=0 rather than leaving the reader to infer it", () => {
    expect(formatPageLog({ ...PAGE, warmBatch: true })).toContain("warm=1");
    expect(formatPageLog({ ...PAGE, warmBatch: false })).toContain("warm=0");
  });

  it("never throws on a hostile performance value", () => {
    const circular: Record<string, unknown> = { generate_s: 1 };
    circular.self = circular;
    expect(() => formatPageLog({ ...PAGE, performance: circular })).not.toThrow();
  });
});

describe("snapshotAgeFrom", () => {
  it("reads the container's own field", () => {
    expect(snapshotAgeFrom({ snapshot_age_s: 57 })).toBe(57);
    expect(snapshotAgeFrom({ snapshot_age_s: "12.5" })).toBe(12.5);
  });

  it("reports null rather than NaN for a missing or unusable value", () => {
    expect(snapshotAgeFrom(null)).toBeNull();
    expect(snapshotAgeFrom({})).toBeNull();
    expect(snapshotAgeFrom({ snapshot_age_s: "unknown" })).toBeNull();
  });
});

describe("logPageCall", () => {
  it("writes one line through the caller's logger", () => {
    const seen: string[] = [];
    logPageCall(PAGE, (line) => seen.push(line));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("[S2 page]");
  });

  it("writes nothing when logging is off", () => {
    const seen: string[] = [];
    logPageCall({ ...PAGE, env: { MODAL_S2_PAGE_LOG: "0" } }, (line) => seen.push(line));
    expect(seen).toHaveLength(0);
  });

  it("cannot fail a page that already rendered", () => {
    const boom = () => {
      throw new Error("logger exploded");
    };
    expect(() => logPageCall(PAGE, boom)).not.toThrow();
  });
});

describe("formatDispatchSummary", () => {
  const DISPATCH = {
    jobId: "job-abc",
    pages: 3,
    rows: 20,
    staged: 20,
    generateSeconds: 88.2,
    wallMs: 397_000,
    truncatedUnits: 0,
    containers: ["ta-abc", "ta-def"],
  };

  it("pairs the wall the book paid with the generation it got", () => {
    const line = formatDispatchSummary(DISPATCH);
    expect(line).toContain("gpu_wall=397.0s");
    expect(line).toContain("generate=88.2s");
    // 4.50 is the number to investigate: 397 s of GPU for 88 s of generation.
    expect(line).toContain("wall_over_generate=4.50");
  });

  it("reports how many rows landed", () => {
    const line = formatDispatchSummary({ ...DISPATCH, staged: 18 });
    expect(line).toContain("rows=18/20");
  });

  it("lists the containers that served the dispatch", () => {
    expect(formatDispatchSummary(DISPATCH)).toContain("containers=ta-abc,ta-def");
    expect(
      formatDispatchSummary({ ...DISPATCH, containers: [] })
    ).toContain("containers=-");
  });

  it("has no ratio when the container reported no generation", () => {
    const line = formatDispatchSummary({ ...DISPATCH, generateSeconds: 0 });
    expect(line).toContain("wall_over_generate=-");
  });

  it("is empty when logging is off", () => {
    expect(
      formatDispatchSummary({ ...DISPATCH, env: { MODAL_S2_PAGE_LOG: "0" } })
    ).toBe("");
  });

  it("cannot throw out to the dispatcher", () => {
    expect(() =>
      logDispatchSummary(DISPATCH, () => {
        throw new Error("logger exploded");
      })
    ).not.toThrow();
  });
});
