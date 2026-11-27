import { describe, expect, it } from "vitest";
import {
  chooseLiveTransport,
  hlsEventPlaylist,
  keepLiveSource,
  pendingSegmentUris,
  readHlsPlaylist,
} from "@/lib/player/live-playlist";
import { commitLiveUpload, reconcilePublished } from "@/lib/tts/live-publish";

describe("live playlist", () => {
  it("lists segments in order and withholds ENDLIST until the book is complete", () => {
    const growing = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12.5 },
        { uri: "live/0001.mp3", seconds: 40 },
      ],
      80_000,
      false
    );
    expect(growing).not.toContain("#EXT-X-ENDLIST");
    expect(growing.indexOf("live/0000.mp3")).toBeLessThan(growing.indexOf("live/0001.mp3"));
    const parsed = readHlsPlaylist(growing);
    expect(parsed.complete).toBe(false);
    expect(parsed.bytes).toBe(80_000);
    expect(parsed.segments.map((segment) => segment.uri)).toEqual([
      "live/0000.mp3",
      "live/0001.mp3",
    ]);
    const done = readHlsPlaylist(
      hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 12.5 }], 80_000, true)
    );
    expect(done.complete).toBe(true);
  });

  it("appends only a prefix extension and refuses a reordered playlist", () => {
    expect(pendingSegmentUris(["live/0000.mp3"], ["live/0000.mp3", "live/0001.mp3"])).toEqual([
      "live/0001.mp3",
    ]);
    expect(pendingSegmentUris(["live/0000.mp3"], ["live/0001.mp3", "live/0000.mp3"])).toEqual([]);
    expect(keepLiveSource(true)).toBe(true);
    expect(keepLiveSource(false)).toBe(false);
  });

  it("uses HLS where MPEG SourceBuffers are unavailable", () => {
    expect(
      chooseLiveTransport({
        managed: true,
        managedMpeg: false,
        mediaSource: true,
        mediaSourceMpeg: false,
      })
    ).toBe("hls");
    expect(
      chooseLiveTransport({
        managed: true,
        managedMpeg: true,
        mediaSource: true,
        mediaSourceMpeg: true,
      })
    ).toBe("mms");
    expect(
      chooseLiveTransport({
        managed: false,
        managedMpeg: false,
        mediaSource: true,
        mediaSourceMpeg: true,
      })
    ).toBe("mse");
  });
});

describe("published prefix", () => {
  it("returns only the bytes that extend the object already stored", () => {
    const remote = Buffer.from("abc");
    expect(reconcilePublished(remote, Buffer.from("abcdef"))?.toString()).toBe("def");
    expect(reconcilePublished(remote, Buffer.from("abXdef"))).toBeNull();
    expect(reconcilePublished(Buffer.alloc(0), Buffer.from("abc"))?.toString()).toBe("abc");
    expect(commitLiveUpload({ heldBefore: true, aborted: false, heldAfter: true })).toBe(true);
    expect(commitLiveUpload({ heldBefore: true, aborted: true, heldAfter: true })).toBe(false);
    expect(commitLiveUpload({ heldBefore: true, aborted: false, heldAfter: false })).toBe(false);
  });
});
