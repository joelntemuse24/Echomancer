import { describe, expect, it } from "vitest";
import {
  clampClipRange,
  defaultSpeechRange,
  formatClock,
  MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  parseIso8601Duration,
  parseYoutubeVideoId,
  parseYoutubeStartSec,
  parseClipTime,
  canonicalYoutubeUrl,
  validateClipRange,
} from "./range";

describe("parseYoutubeVideoId", () => {
  it("accepts a bare id and common YouTube links", () => {
    const id = "abcdefghijk";
    expect(parseYoutubeVideoId(id)).toBe(id);
    expect(parseYoutubeVideoId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
    expect(parseYoutubeVideoId(`https://m.youtube.com/watch?v=${id}&t=12s`)).toBe(id);
    expect(parseYoutubeVideoId(`https://youtu.be/${id}`)).toBe(id);
    expect(parseYoutubeVideoId(`https://www.youtube.com/embed/${id}`)).toBe(id);
    expect(parseYoutubeVideoId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
    expect(parseYoutubeVideoId(`https://music.youtube.com/watch?v=${id}`)).toBe(id);
    expect(parseYoutubeVideoId(`youtube.com/live/${id}`)).toBe(id);
  });

  it("rejects other hosts and broken ids", () => {
    expect(parseYoutubeVideoId("https://vimeo.com/123")).toBeNull();
    expect(parseYoutubeVideoId("https://youtu.be/short")).toBeNull();
    expect(parseYoutubeVideoId("not a url")).toBeNull();
    expect(parseYoutubeVideoId("")).toBeNull();
  });
});

describe("timestamp links and editable clocks", () => {
  it("reads seconds, clocks, start parameters, and hash tokens", () => {
    expect(parseYoutubeStartSec("https://youtu.be/abcdefghijk?t=1h2m3s")).toBe(3723);
    expect(parseYoutubeStartSec("youtube.com/watch?v=abcdefghijk&t=95")).toBe(95);
    expect(parseYoutubeStartSec("https://youtube.com/embed/abcdefghijk?start=45")).toBe(45);
    expect(parseYoutubeStartSec("https://youtu.be/abcdefghijk#t=2m10s")).toBe(130);
    expect(parseYoutubeStartSec("https://youtu.be/abcdefghijk?t=1:02:03")).toBe(3723);
    expect(parseYoutubeStartSec("https://example.com/abcdefghijk?t=20")).toBeNull();
    expect(parseYoutubeStartSec("https://youtu.be/abcdefghijk?t=-1")).toBeNull();
    expect(canonicalYoutubeUrl("abcdefghijk", 95.8)).toBe("https://www.youtube.com/watch?v=abcdefghijk&t=95s");
  });

  it("rejects malformed clocks and preserves whole seconds", () => {
    expect(parseClipTime(" 1:02:03 ")).toBe(3723);
    expect(parseClipTime("95")).toBe(95);
    for (const value of ["1:60", "1:02:60", "-1", "1.5", "", "1:2:3:4"]) {
      expect(parseClipTime(value)).toBeNull();
    }
  });
});

describe("parseIso8601Duration", () => {
  it("parses hours, minutes, and seconds", () => {
    expect(parseIso8601Duration("PT1H2M3S")).toBe(3723);
    expect(parseIso8601Duration("PT5M")).toBe(300);
    expect(parseIso8601Duration("PT45S")).toBe(45);
    expect(parseIso8601Duration("PT1H")).toBe(3600);
    expect(parseIso8601Duration("PT0S")).toBe(0);
  });

  it("rejects dates and empty strings", () => {
    expect(parseIso8601Duration("P1D")).toBeNull();
    expect(parseIso8601Duration("")).toBeNull();
    expect(parseIso8601Duration("PT")).toBeNull();
  });
});

describe("clip range", () => {
  it("suggests 20 seconds past the intro of a long lecture", () => {
    expect(defaultSpeechRange(7200)).toEqual({ startSec: 45, endSec: 65 });
    expect(defaultSpeechRange(90)).toEqual({ startSec: 12, endSec: 32 });
  });

  it("uses the whole short video when it is between 10 and 30 seconds", () => {
    expect(defaultSpeechRange(20)).toEqual({ startSec: 0, endSec: 20 });
    expect(defaultSpeechRange(10)).toEqual({ startSec: 0, endSec: 10 });
    expect(defaultSpeechRange(9)).toBeNull();
  });

  it("allows 10 and 40 seconds and rejects everything outside", () => {
    expect(validateClipRange(0, 10)).toEqual({ ok: true, startSec: 0, endSec: 10 });
    expect(validateClipRange(5, 45)).toEqual({ ok: true, startSec: 5, endSec: 45 });
    expect(validateClipRange(0, 9).ok).toBe(false);
    expect(validateClipRange(0, 41).ok).toBe(false);
    expect(validateClipRange(20, 10).ok).toBe(false);
    expect(validateClipRange(0, 30, 20).ok).toBe(false);
  });

  it("keeps a dragged handle inside 10–40 seconds", () => {
    const widened = clampClipRange(0, 90, 600, "end");
    expect(widened).toEqual({ startSec: 50, endSec: 90 });
    expect(widened!.endSec - widened!.startSec).toBeLessThanOrEqual(MAX_CLIP_SEC);

    const squeezed = clampClipRange(10, 12, 600, "end");
    expect(squeezed!.endSec - squeezed!.startSec).toBeGreaterThanOrEqual(MIN_CLIP_SEC);

    expect(clampClipRange(0, 20, 8, "start")).toBeNull();
  });

  it("formats clocks", () => {
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3723)).toBe("1:02:03");
  });
});
