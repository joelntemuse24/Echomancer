import { describe, expect, it } from "vitest";
import {
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
    expect(headers["Cache-Control"]).toContain("no-store");
    expect(headers["Content-Type"]).toBe("audio/mpeg");
  });
});
