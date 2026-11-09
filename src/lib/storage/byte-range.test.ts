import { describe, expect, it } from "vitest";
import {
  PLAYBACK_OPEN_RANGE_BYTES,
  cappedPlaybackRange,
  openEndedPlaybackWindow,
  parseByteRange,
  playbackHeaders,
  singleByteRangeHeader,
} from "@/lib/storage/byte-range";

describe("singleByteRangeHeader", () => {
  it("forwards open, closed, and suffix ranges unchanged", () => {
    expect(singleByteRangeHeader("bytes=1000-2000")).toBe("bytes=1000-2000");
    expect(singleByteRangeHeader("bytes=1000-")).toBe("bytes=1000-");
    expect(singleByteRangeHeader("bytes=-32")).toBe("bytes=-32");
    expect(singleByteRangeHeader("  Bytes=0-1  ")).toBe("bytes=0-1");
  });

  it("drops multi-ranges and empty specs", () => {
    expect(singleByteRangeHeader("bytes=0-1,5-6")).toBeUndefined();
    expect(singleByteRangeHeader("bytes=-")).toBeUndefined();
    expect(singleByteRangeHeader("bytes=-0")).toBeUndefined();
    expect(singleByteRangeHeader("items=0-1")).toBeUndefined();
    expect(singleByteRangeHeader(null)).toBeUndefined();
  });
});

describe("parseByteRange", () => {
  it("keeps a closed range and clamps the end to the object", () => {
    expect(parseByteRange("bytes=100-149", 4096)).toEqual({
      start: 100,
      end: 149,
    });
    expect(parseByteRange("bytes=100-99999", 4096)).toEqual({
      start: 100,
      end: 4095,
    });
  });

  it("treats a suffix as the last N bytes, not a range from the start", () => {
    expect(parseByteRange("bytes=-20", 4096)).toEqual({
      start: 4076,
      end: 4095,
    });
    expect(parseByteRange("bytes=-10000", 100)).toEqual({
      start: 0,
      end: 99,
    });
  });

  it("marks ranges past the end as unsatisfiable", () => {
    expect(parseByteRange("bytes=5000-5001", 4096)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=80-10", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-1", 0)).toBe("unsatisfiable");
  });
});

describe("openEndedPlaybackWindow", () => {
  const end = PLAYBACK_OPEN_RANGE_BYTES - 1;

  it("caps an open-ended media range so the 206 can finish", () => {
    // Chrome's first request is `bytes=0-`. A 206 that runs to the last
    // byte of a multi-hour file never completes, and the element errors
    // while the body is still arriving. The same bytes play from disk cache.
    expect(openEndedPlaybackWindow("bytes=0-")).toBe(`bytes=0-${end}`);
    expect(openEndedPlaybackWindow("bytes=450000000-")).toBe(
      `bytes=450000000-${450000000 + end}`
    );
  });

  it("leaves a closed range and a tail probe alone", () => {
    expect(openEndedPlaybackWindow("bytes=0-99")).toBeNull();
    expect(openEndedPlaybackWindow("bytes=8000000-8000003")).toBeNull();
    expect(openEndedPlaybackWindow("bytes=-32")).toBeNull();
    expect(openEndedPlaybackWindow(null)).toBeNull();
  });
});

describe("cappedPlaybackRange", () => {
  const end = PLAYBACK_OPEN_RANGE_BYTES - 1;

  it("keeps the follow-up Chrome sends after the first window on this origin", () => {
    // After `bytes=0-` returns 256 KiB, Chrome asks for `bytes=262144-`.
    // That read has to be answered here. A 302 to R2 is a network error.
    expect(cappedPlaybackRange("bytes=262144-")).toBe(`bytes=262144-${262144 + end}`);
    expect(cappedPlaybackRange("bytes=0-")).toBe(`bytes=0-${end}`);
  });

  it("keeps a short closed range and a tail probe, and caps a huge slice", () => {
    expect(cappedPlaybackRange("bytes=0-99")).toBe("bytes=0-99");
    expect(cappedPlaybackRange("bytes=8000000-8000003")).toBe("bytes=8000000-8000003");
    expect(cappedPlaybackRange("bytes=-32")).toBe("bytes=-32");
    expect(cappedPlaybackRange(`bytes=0-${PLAYBACK_OPEN_RANGE_BYTES * 4}`)).toBe(
      `bytes=0-${end}`
    );
    expect(cappedPlaybackRange(`bytes=-${PLAYBACK_OPEN_RANGE_BYTES * 4}`)).toBe(
      `bytes=-${PLAYBACK_OPEN_RANGE_BYTES}`
    );
    expect(cappedPlaybackRange(null)).toBeNull();
  });
});

describe("playbackHeaders", () => {
  it("advertises a private byte range and the slice length", () => {
    const headers = playbackHeaders({
      contentType: "audio/mpeg",
      contentLength: 50,
      contentRange: "bytes 100-149/40000000",
    });
    expect(headers["Content-Length"]).toBe("50");
    expect(headers["Content-Range"]).toBe("bytes 100-149/40000000");
    expect(headers["Accept-Ranges"]).toBe("bytes");
    expect(headers["Cache-Control"]).toContain("private");
    expect(headers["Cache-Control"]).toContain("max-age=3600");
    expect(headers["Cache-Control"]).not.toContain("no-store");
    expect(headers["Vary"]).toBe("Range, Cookie");
    expect(headers["Content-Type"]).toBe("audio/mpeg");
  });
});
