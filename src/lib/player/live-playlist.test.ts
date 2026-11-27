import { describe, expect, it } from "vitest";
import {
  chooseLiveTransport,
  evictionEnd,
  hlsEventPlaylist,
  keepLiveSource,
  liveChapterSeek,
  liveReadyTransition,
  pendingSegmentUris,
  readHlsPlaylist,
  seekTargetIfCovered,
  shouldResumeLive,
} from "@/lib/player/live-playlist";
import { commitLiveUpload, planLiveSegments, reconcilePublished } from "@/lib/tts/live-publish";

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

  it("keeps a Media Source at ready and moves native HLS onto the finished file", () => {
    const playing = {
      complete: true,
      ready: true,
      fullUrl: "/api/storage/audiobooks/job/full.mp3",
      currentSrc: "blob:live",
      currentTime: 158,
      playing: true,
    };
    expect(liveReadyTransition({ ...playing, transport: "mse" })).toEqual({ action: "stay" });
    expect(liveReadyTransition({ ...playing, transport: "mms" })).toEqual({ action: "stay" });
    expect(liveReadyTransition({ ...playing, transport: "hls" })).toEqual({
      action: "handoff",
      url: "/api/storage/audiobooks/job/full.mp3",
      at: 158,
      play: true,
    });
    expect(
      liveReadyTransition({
        ...playing,
        transport: "hls",
        currentSrc: "/api/storage/audiobooks/job/full.mp3?v=1",
      }).action
    ).toBe("stay");
    expect(liveReadyTransition({ ...playing, transport: "hls", ready: false }).action).toBe("stay");
  });

  it("seeks a chapter inside the buffer and hands the rest to the finished file", () => {
    expect(
      liveChapterSeek({
        target: 40,
        covered: 90,
        fullUrl: "/api/storage/audiobooks/job/full.mp3",
        playing: true,
      })
    ).toEqual({ action: "seek", at: 40 });
    expect(
      liveChapterSeek({
        target: 400,
        covered: 90,
        fullUrl: "/api/storage/audiobooks/job/full.mp3",
        playing: true,
      })
    ).toEqual({
      action: "handoff",
      url: "/api/storage/audiobooks/job/full.mp3",
      at: 400,
      play: true,
    });
  });

  it("resumes after the buffer runs out and leaves a chosen pause alone", () => {
    const edge = {
      listenerPaused: false,
      complete: false,
      paused: true,
      ended: false,
      currentTime: 117,
      covered: 117.2,
    };
    expect(shouldResumeLive(edge)).toBe(true);
    expect(shouldResumeLive({ ...edge, listenerPaused: true })).toBe(false);
    expect(shouldResumeLive({ ...edge, complete: true })).toBe(false);
    expect(shouldResumeLive({ ...edge, paused: false, currentTime: 20 })).toBe(false);
    expect(shouldResumeLive({ ...edge, ended: true, currentTime: 20, paused: true })).toBe(true);
    expect(shouldResumeLive({ ...edge, currentTime: 0, covered: 100 })).toBe(false);
    expect(shouldResumeLive({ ...edge, currentTime: 117, covered: 400 })).toBe(true);
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

describe("resume and buffer room", () => {
  it("keeps a seek that the first segment does not cover", () => {
    expect(seekTargetIfCovered(400, 12)).toBeNull();
    expect(seekTargetIfCovered(400, 400)).toBe(400);
    expect(evictionEnd(10)).toBe(9);
    expect(evictionEnd(100)).toBe(70);
    expect(evictionEnd(0.2)).toBeNull();
  });
});

describe("playlist repair", () => {
  it("rebuilds from matching objects and does not rewrite them on the next pass", () => {
    const remote = Buffer.from("aaaa");
    const delta = Buffer.from("bbbb");
    const wrong = Buffer.from("zzzz");
    const files = new Map<string, Buffer>([
      ["live/0000.mp3", remote],
      ["live/0001.mp3", wrong],
    ]);
    const repaired = planLiveSegments(remote, delta, files);
    expect(repaired.map((segment) => segment.uri)).toEqual(["live/0000.mp3", "live/0002.mp3"]);
    expect(repaired[0]?.write).toBe(false);
    expect(repaired[1]?.write).toBe(true);
    expect(repaired[1]?.bytes.toString()).toBe("bbbb");
    const again = new Map(files);
    again.set("live/0002.mp3", delta);
    const second = planLiveSegments(remote, delta, again);
    expect(second.every((segment) => segment.write === false)).toBe(true);
    expect(Buffer.concat(second.map((segment) => segment.bytes)).toString()).toBe("aaaabbbb");
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
