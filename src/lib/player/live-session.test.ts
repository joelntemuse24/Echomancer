import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseLivePart,
  hlsEventPlaylist,
  liveAttachResumeAt,
  liveSectionHold,
  segmentUrisAhead,
} from "@/lib/player/live-playlist";
import {
  absoluteFromPlaylist,
  liveAttachToken,
  liveBufferedSeconds,
  releaseLiveSession,
  retargetLiveResume,
  setLivePlayIntent,
  syncLivePlayback,
} from "@/lib/player/live-session";

type FakeAudio = HTMLAudioElement & {
  dispatch(type: string): void;
  state: { currentTime: number; duration: number; sets: number[] };
};

function fakeAudio(): FakeAudio {
  const listeners = new Map<string, Set<() => void>>();
  const state = { currentTime: 0, duration: 0, sets: [] as number[], plays: 0 };
  const audio = {
    src: "",
    paused: false,
    ended: false,
    buffered: { length: 0, end: () => 0 },
    addEventListener(type: string, fn: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    play: async () => {
      state.plays += 1;
      audio.paused = false;
      audio.ended = false;
    },
    dispatch(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    state,
  };
  Object.defineProperty(audio, "currentTime", {
    get: () => state.currentTime,
    set(value: number) {
      state.sets.push(value);
      state.currentTime = value;
    },
  });
  Object.defineProperty(audio, "duration", {
    get: () => state.duration,
    set(value: number) {
      state.duration = value;
    },
  });
  return audio as unknown as FakeAudio;
}

class FakeBuffer {
  mode = "segments";
  updating = false;
  appends: Uint8Array[] = [];
  removes: number[] = [];
  quota = false;
  private listeners = new Map<string, Array<() => void>>();

  constructor(readonly element: FakeAudio) {}

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private fire(type: string): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, []);
    for (const listener of list) listener();
  }

  appendBuffer(data: Uint8Array): void {
    if (this.quota) {
      this.quota = false;
      const err = new Error("quota");
      err.name = "QuotaExceededError";
      throw err;
    }
    this.appends.push(data);
    this.element.duration = this.appends.length === 1 ? 12 : 90;
    this.element.dispatch("durationchange");
    queueMicrotask(() => this.fire("updateend"));
  }

  remove(_start: number, end: number): void {
    this.removes.push(end);
    queueMicrotask(() => this.fire("updateend"));
  }
}

function installSource(buffer: FakeBuffer, ended?: { count: number }): void {
  class MediaSource {
    readyState = "open";
    addSourceBuffer(): FakeBuffer {
      return buffer;
    }
    endOfStream(): void {
      if (ended) ended.count += 1;
      this.readyState = "ended";
      // The platform fires ended once the playhead is at a closed source.
      buffer.element.ended = true;
      buffer.element.dispatch("ended");
    }
    addEventListener(type: string, fn: () => void): void {
      if (type === "sourceopen") fn();
    }
    static isTypeSupported(type: string): boolean {
      return type === "audio/mpeg";
    }
  }
  vi.stubGlobal("MediaSource", MediaSource);
  vi.stubGlobal("ManagedMediaSource", undefined);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => "blob:live",
  });
}

const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);

afterEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: nativeCreateObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: nativeRevokeObjectURL,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("playlist segment URLs", () => {
  it("resolves a page path against the document", () => {
    expect(
      absoluteFromPlaylist(
        "live/0000.mp3",
        "/api/storage/audiobooks/job/live.m3u8",
        "https://echomancer.xyz/dashboard/player/job"
      )
    ).toBe("https://echomancer.xyz/api/storage/audiobooks/job/live/0000.mp3");
  });
});

describe("syncLivePlayback", () => {
  it("fetches a segment when the playlist URL is a page path", async () => {
    const audio = fakeAudio();
    const buffer = new FakeBuffer(audio);
    installSource(buffer);
    const playlist = hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 12 }], 10, false);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-relative",
      resumeAt: 0,
      play: true,
    });
    expect(result.attached).toBe(true);
    expect(fetched.some((url) => url.startsWith("http") && url.endsWith("/live/0000.mp3"))).toBe(true);
    expect(buffer.appends).toHaveLength(1);
  });

  it("appends each segment once when two polls overlap", async () => {
    const audio = fakeAudio();
    const buffer = new FakeBuffer(audio);
    installSource(buffer);
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    let opened = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) {
        if (!opened) {
          opened = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return new Response(playlist, { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const first = syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-a",
      resumeAt: 0,
    });
    const second = syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-a",
      resumeAt: 0,
    });
    await Promise.all([first, second]);
    expect(buffer.appends).toHaveLength(2);
  });

  it("waits to resume until the buffer covers the saved position", async () => {
    const audio = fakeAudio();
    const buffer = new FakeBuffer(audio);
    installSource(buffer);
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-b",
      resumeAt: 40,
    });
    expect(audio.state.sets).toEqual([40]);
    expect(audio.state.currentTime).toBe(40);
  });

  it("evicts played media and retries when the buffer is full", async () => {
    const audio = fakeAudio();
    audio.state.currentTime = 100;
    const buffer = new FakeBuffer(audio);
    buffer.quota = true;
    installSource(buffer);
    const playlist = hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 12 }], 20, false);
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([9, 9, 9, 9]), { status: 200 });
    });
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-c",
      resumeAt: 0,
    });
    expect(buffer.removes).toEqual([70]);
    expect(buffer.appends).toHaveLength(1);
  });

  it("releases a segment reservation when the fetch fails, then retries it", async () => {
    const audio = fakeAudio();
    const buffer = new FakeBuffer(audio);
    installSource(buffer);
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 4 },
        { uri: "live/0001.mp3", seconds: 4 },
      ],
      40,
      false
    );
    let segmentFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      segmentFetches += 1;
      if (segmentFetches === 1) return new Response(null, { status: 500 });
      if (segmentFetches === 2) throw new Error("network");
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const opts = {
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-retry",
      resumeAt: 0,
    };
    await syncLivePlayback(opts);
    expect(buffer.appends).toHaveLength(0);
    await syncLivePlayback(opts);
    expect(buffer.appends).toHaveLength(0);
    await syncLivePlayback(opts);
    expect(buffer.appends).toHaveLength(2);
  });

  it("does not close or rewind a live buffer when the playlist finishes", async () => {
    const audio = fakeAudio();
    audio.state.currentTime = 40;
    const buffer = new FakeBuffer(audio);
    const ended = { count: 0 };
    installSource(buffer, ended);
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 25 },
        { uri: "live/0001.mp3", seconds: 400 },
      ],
      900_000,
      true
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-ready",
      resumeAt: 0,
    });
    expect(ended.count).toBe(0);
    expect(audio.state.currentTime).toBe(40);
    expect(audio.state.plays).toBe(0);
    expect(audio.src).toBe("blob:live");
  });

  it("ends the source when the playhead reaches the buffer after ready", async () => {
    const audio = fakeAudio();
    audio.state.currentTime = 40;
    const buffer = new FakeBuffer(audio);
    const ended = { count: 0 };
    const revoked: string[] = [];
    installSource(buffer, ended);
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: (url: string) => {
        revoked.push(url);
        nativeRevokeObjectURL(url);
      },
    });
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 25 },
        { uri: "live/0001.mp3", seconds: 65 },
      ],
      900_000,
      true
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-end",
      resumeAt: 0,
    });
    expect(ended.count).toBe(0);
    expect(revoked).toEqual([]);
    let endedEvent = false;
    audio.addEventListener("ended", () => {
      endedEvent = true;
    });
    audio.currentTime = audio.duration;
    audio.dispatch("timeupdate");
    expect(ended.count).toBe(1);
    expect(endedEvent).toBe(true);
    expect(audio.ended).toBe(true);
    expect(revoked).toEqual(["blob:live"]);
  });

  it("resumes when the playhead ran off the buffer and the listener did not pause", async () => {
    const playlist = hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 130 }], 200, false);
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const stalled = () => {
      const audio = fakeAudio();
      audio.paused = true;
      audio.ended = true;
      audio.state.currentTime = 11;
      installSource(new FakeBuffer(audio));
      return audio;
    };
    const held = stalled();
    await syncLivePlayback({
      audio: held,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-held",
      resumeAt: 0,
      listenerPaused: true,
    });
    expect(held.state.plays).toBe(0);
    expect(held.state.currentTime).toBe(11);
    const audio = stalled();
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-stall",
      resumeAt: 0,
    });
    expect(audio.state.plays).toBe(1);
    expect(audio.state.currentTime).toBe(11);
  });

  it("hands a playing later section to the live source at the book position", async () => {
    const audio = fakeAudio();
    audio.paused = true;
    audio.src = "https://app.test/api/storage/audiobooks/job/sections/0002.mp3";
    audio.state.currentTime = 25;
    const bookAt = liveAttachResumeAt({
      elementSeconds: audio.state.currentTime,
      onSection: true,
      sectionStart: 40,
      saved: { positionSeconds: 25, sectionIndex: 2 },
      savedSectionStart: 40,
    });
    expect(bookAt).toBe(65);
    const buffer = new FakeBuffer(audio);
    installSource(buffer);
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-walk",
      resumeAt: bookAt,
      play: true,
    });
    expect(result.attached).toBe(true);
    expect(audio.src).toBe("blob:live");
    expect(audio.state.currentTime).toBe(65);
    expect(audio.state.plays).toBe(1);
    expect(audio.paused).toBe(false);
  });

  it("keeps the section when the playlist has not reached that book position", async () => {
    const audio = fakeAudio();
    audio.paused = false;
    const section = "https://app.test/api/storage/audiobooks/job/sections/0003.mp3";
    audio.src = section;
    audio.state.currentTime = 25;
    const bookAt = liveAttachResumeAt({
      elementSeconds: 25,
      onSection: true,
      sectionStart: 80,
      saved: null,
      savedSectionStart: 0,
    });
    expect(bookAt).toBe(105);
    installSource(new FakeBuffer(audio));
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-ahead",
      resumeAt: bookAt,
      play: true,
    });
    expect(result.attached).toBe(false);
    expect(audio.src).toBe(section);
    expect(audio.state.currentTime).toBe(25);
    expect(audio.state.plays).toBe(0);
  });

  it("seeks a buffered part and does not snap back to the live start", async () => {
    const audio = fakeAudio();
    audio.paused = true;
    audio.state.currentTime = 25;
    const buffer = new FakeBuffer(audio);
    installSource(buffer);
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const opts = {
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-parts",
      resumeAt: 65,
      play: true,
    };
    await syncLivePlayback(opts);
    expect(audio.state.currentTime).toBe(65);
    const section = "https://app.test/api/storage/audiobooks/job/sections/0003.mp3";
    const buffered = chooseLivePart({
      attached: true,
      target: 80,
      covered: audio.duration,
      sectionUrl: section,
      playing: true,
    });
    expect(buffered).toEqual({ action: "seek", at: 80, play: true });
    if (buffered.action !== "seek") return;
    audio.currentTime = buffered.at;
    retargetLiveResume(audio, buffered.at, true);
    if (buffered.play) await audio.play();
    const sets = audio.state.sets.length;
    await syncLivePlayback({ ...opts, resumeAt: 10 });
    expect(audio.src).toBe("blob:live");
    expect(audio.state.currentTime).toBe(80);
    expect(audio.state.sets).toHaveLength(sets);

    const later = chooseLivePart({
      attached: true,
      target: 200,
      covered: audio.duration,
      sectionUrl: section,
      playing: true,
    });
    expect(later).toMatchObject({ action: "section", release: true, url: section });
    if (later.action !== "section") return;
    releaseLiveSession(audio);
    audio.src = later.url;
    audio.state.currentTime = 0;
    const again = await syncLivePlayback({ ...opts, resumeAt: 200, play: true });
    expect(again.attached).toBe(false);
    expect(audio.src).toBe(section);
    expect(audio.state.currentTime).toBe(0);
  });

  it.each([
    ["Parts tap", 200, "https://app.test/api/storage/audiobooks/job/sections/0004.mp3"],
    ["scrub past the buffer", 180, "https://app.test/api/storage/audiobooks/job/sections/0003.mp3"],
    ["chapter handoff", 240, "https://app.test/api/storage/audiobooks/job/full.mp3"],
  ])(
    "a %s during a playlist fetch does not reattach or seek",
    async (_label, leftAt, nextUrl) => {
      const audio = fakeAudio();
      audio.paused = false;
      audio.src = "https://app.test/api/storage/audiobooks/job/sections/0002.mp3";
      audio.state.currentTime = 25;
      installSource(new FakeBuffer(audio));
      let releaseFetch: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      const playlist = hlsEventPlaylist(
        [
          { uri: "live/0000.mp3", seconds: 12 },
          { uri: "live/0001.mp3", seconds: 78 },
        ],
        100,
        false
      );
      vi.stubGlobal("fetch", async (url: string) => {
        if (String(url).includes("live.m3u8")) {
          await gate;
          return new Response(playlist, { status: 200 });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      });
      const token = liveAttachToken(audio);
      const pending = syncLivePlayback({
        audio,
        playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
        jobId: "job-race",
        resumeAt: 65,
        play: true,
      });
      releaseLiveSession(audio, leftAt);
      audio.src = nextUrl;
      audio.state.currentTime = 0;
      releaseFetch();
      const result = await pending;
      let applied: string | null = null;
      if (liveAttachToken(audio) === token && result.attached && result.url) applied = result.url;
      expect(applied).toBeNull();
      expect(result.attached).toBe(false);
      expect(audio.src).toBe(nextUrl);
      expect(audio.state.currentTime).toBe(0);
      expect(audio.state.sets).not.toContain(65);
      expect(audio.state.plays).toBe(0);

      const again = await syncLivePlayback({
        audio,
        playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
        jobId: "job-race",
        resumeAt: 65,
        play: true,
      });
      expect(again.attached).toBe(false);
      expect(audio.src).toBe(nextUrl);
      expect(audio.state.currentTime).toBe(0);
    }
  );

  it("keeps a chosen section after the playlist covers the time the listener left for", async () => {
    const audio = fakeAudio();
    audio.paused = true;
    const section = "https://app.test/api/storage/audiobooks/job/sections/0002.mp3";
    audio.src = section;
    audio.state.currentTime = 10;
    installSource(new FakeBuffer(audio));
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const short = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    const caughtUp = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    let playlist = short;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) {
        await gate;
        return new Response(playlist, { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const pending = syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-catch",
      resumeAt: 40,
      play: true,
    });
    releaseLiveSession(audio, 80);
    audio.src = section;
    audio.state.currentTime = 0;
    releaseFetch();
    expect((await pending).attached).toBe(false);
    const stale = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-catch",
      resumeAt: 40,
      play: false,
    });
    expect(stale.attached).toBe(false);
    expect(audio.src).toBe(section);
    playlist = caughtUp;
    const landed = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-catch",
      resumeAt: 80,
      play: false,
    });
    expect(landed.attached).toBe(false);
    expect(audio.src).toBe(section);
    expect(audio.state.currentTime).toBe(0);
    expect(audio.state.plays).toBe(0);
  });

  it("joins the live element at the book time when a chosen section ends inside it", async () => {
    const audio = fakeAudio();
    audio.paused = true;
    audio.ended = false;
    const section = "https://app.test/api/storage/audiobooks/job/sections/0014.mp3";
    audio.src = section;
    audio.state.currentTime = 0;
    installSource(new FakeBuffer(audio));
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-end",
      resumeAt: 200,
      play: false,
    });
    releaseLiveSession(audio, 80);
    audio.src = section;
    audio.ended = true;
    audio.state.currentTime = 0;
    const joined = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-end",
      resumeAt: 80,
      play: true,
    });
    expect(joined.attached).toBe(true);
    expect(audio.state.currentTime).toBe(80);
    expect(audio.state.plays).toBeGreaterThan(0);
    expect(audio.src.startsWith("blob:")).toBe(true);
  });

  it("a departure on one book does not block the next book", async () => {
    const audio = fakeAudio();
    audio.paused = false;
    installSource(new FakeBuffer(audio));
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const first = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/book-a/live.m3u8",
      jobId: "book-a",
      resumeAt: 40,
      play: true,
    });
    expect(first.attached).toBe(true);
    setLivePlayIntent(audio, false);
    releaseLiveSession(audio, 200);
    audio.src = "https://app.test/api/storage/audiobooks/book-a/sections/0004.mp3";
    audio.state.currentTime = 0;
    const plays = audio.state.plays;
    const next = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/book-b/live.m3u8",
      jobId: "book-b",
      resumeAt: 40,
      play: true,
    });
    expect(next.attached).toBe(true);
    expect(audio.state.currentTime).toBe(40);
    expect(audio.state.plays).toBe(plays + 1);
    expect(audio.src.startsWith("blob:")).toBe(true);
  });

  it("a book switch during a playlist fetch does not attach the book that was left", async () => {
    const audio = fakeAudio();
    audio.paused = true;
    audio.src = "https://app.test/api/storage/audiobooks/book-b/sections/0000.mp3";
    installSource(new FakeBuffer(audio));
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) {
        await gate;
        return new Response(playlist, { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const pendingA = syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/book-a/live.m3u8",
      jobId: "book-a",
      resumeAt: 40,
      play: true,
    });
    releaseLiveSession(audio, 200);
    const pendingB = syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/book-b/live.m3u8",
      jobId: "book-b",
      resumeAt: 40,
      play: false,
    });
    releaseFetch();
    const left = await pendingA;
    const next = await pendingB;
    expect(left.attached).toBe(false);
    expect(next.attached).toBe(true);
    expect(audio.state.currentTime).toBe(40);
    expect(audio.state.plays).toBe(0);
    expect(audio.src.startsWith("blob:")).toBe(true);
  });

  it("keeps the section file when the playlist is missing", async () => {
    const audio = fakeAudio();
    const section = "https://app.test/api/storage/audiobooks/job/sections/0000.mp3";
    audio.src = section;
    installSource(new FakeBuffer(audio));
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-missing",
      resumeAt: 0,
      play: true,
    });
    expect(result.attached).toBe(false);
    expect(audio.src).toBe(section);
  });

  it("plays the playlist on Safari once it lists a segment", async () => {
    const audio = fakeAudio();
    const section = "https://app.test/api/storage/audiobooks/job/sections/0000.mp3";
    audio.src = section;
    audio.canPlayType = (type: string) =>
      type === "application/vnd.apple.mpegurl" ? "maybe" : "";
    vi.stubGlobal("MediaSource", undefined);
    vi.stubGlobal("ManagedMediaSource", undefined);
    const playlist = hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 22 }], 100, false);
    vi.stubGlobal("fetch", async () => new Response(playlist, { status: 200 }));
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-safari",
      resumeAt: 0,
      play: true,
    });
    expect(result.attached).toBe(true);
    expect(result.transport).toBe("hls");
    expect(audio.src).toBe("https://app.test/api/storage/audiobooks/job/live.m3u8");
  });

  it("leaves the section file when Safari's playlist has no segment yet", async () => {
    const audio = fakeAudio();
    const section = "https://app.test/api/storage/audiobooks/job/sections/0000.mp3";
    audio.src = section;
    audio.canPlayType = () => "maybe";
    vi.stubGlobal("MediaSource", undefined);
    vi.stubGlobal("ManagedMediaSource", undefined);
    vi.stubGlobal("fetch", async () => new Response("#EXTM3U\n", { status: 200 }));
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-safari-empty",
      resumeAt: 0,
      play: true,
    });
    expect(result.attached).toBe(false);
    expect(audio.src).toBe(section);
  });

  it("keeps the section file when MPEG cannot be appended", async () => {
    const audio = fakeAudio();
    const section = "https://app.test/api/storage/audiobooks/job/sections/0000.mp3";
    audio.src = section;
    class MediaSource {
      static isTypeSupported(): boolean {
        return false;
      }
    }
    vi.stubGlobal("MediaSource", MediaSource);
    vi.stubGlobal("ManagedMediaSource", undefined);
    const playlist = hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 22 }], 100, false);
    vi.stubGlobal("fetch", async () => new Response(playlist, { status: 200 }));
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-chrome",
      resumeAt: 0,
      play: true,
    });
    expect(result.attached).toBe(false);
    expect(result.transport).toBeNull();
    expect(audio.src).toBe(section);
  });

  it("restores the section file when the live segment never arrives", async () => {
    const audio = fakeAudio();
    const section = "https://app.test/api/storage/audiobooks/job/sections/0033.mp3";
    audio.src = section;
    installSource(new FakeBuffer(audio));
    const playlist = hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 22 }], 100, false);
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response("missing", { status: 404 });
    });
    const first = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-segment",
      resumeAt: 0,
      play: true,
    });
    expect(first.attached).toBe(false);
    expect(audio.src).toBe(section);
    const second = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-segment",
      resumeAt: 0,
      play: true,
    });
    expect(second.attached).toBe(false);
    expect(audio.src).toBe(section);
  });

  it("restores a refresh from a part-local save without starting playback", async () => {
    const audio = fakeAudio();
    audio.paused = true;
    audio.state.currentTime = 0;
    const bookAt = liveAttachResumeAt({
      elementSeconds: 0,
      onSection: false,
      sectionStart: 0,
      saved: { positionSeconds: 25, sectionIndex: 2 },
      savedSectionStart: 40,
    });
    expect(bookAt).toBe(65);
    installSource(new FakeBuffer(audio));
    const playlist = hlsEventPlaylist(
      [
        { uri: "live/0000.mp3", seconds: 12 },
        { uri: "live/0001.mp3", seconds: 78 },
      ],
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-refresh",
      resumeAt: bookAt,
      play: false,
    });
    expect(audio.state.currentTime).toBe(65);
    expect(audio.state.plays).toBe(0);
    expect(audio.paused).toBe(true);
  });

  it("reads the buffered end when the element duration is infinite", () => {
    const audio = fakeAudio();
    audio.state.duration = Number.POSITIVE_INFINITY;
    Object.defineProperty(audio, "buffered", { value: { length: 1, end: () => 320 } });
    expect(liveBufferedSeconds(audio)).toBe(320);
    expect(segmentUrisAhead(
      Array.from({ length: 6 }, (_, index) => ({ uri: `live/${index}.mp3`, seconds: 10 })),
      30
    )).toHaveLength(3);
    expect(
      liveSectionHold({
        src: "https://app.test/sections/0008.mp3",
        ended: false,
        resumeAt: 120,
      })
    ).toBe(true);
    expect(
      liveSectionHold({
        src: "https://app.test/sections/0000.mp3",
        ended: false,
        resumeAt: 12,
      })
    ).toBe(false);
    expect(
      liveSectionHold({
        src: "https://app.test/sections/0003.mp3",
        ended: false,
        resumeAt: 60,
        chosen: true,
        bufferedEnd: 20,
      })
    ).toBe(true);
    expect(
      liveSectionHold({
        src: "https://app.test/sections/0003.mp3",
        ended: false,
        resumeAt: 45,
        bufferedEnd: 20,
      })
    ).toBe(true);
  });

  it("appends the window ahead of the playhead and extends it as the clock moves", async () => {
    const audio = fakeAudio();
    const buffer = new FakeBuffer(audio);
    installSource(buffer);
    const playlist = hlsEventPlaylist(
      Array.from({ length: 6 }, (_, index) => ({
        uri: `live/${String(index).padStart(4, "0")}.mp3`,
        seconds: 10,
      })),
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-window",
      resumeAt: 0,
      play: false,
    });
    expect(buffer.appends).toHaveLength(3);
    audio.state.currentTime = 8;
    audio.dispatch("timeupdate");
    await vi.waitFor(() => expect(buffer.appends.length).toBeGreaterThan(3));
  });

  it("leaves a far section playing instead of opening the live element at 0:00", async () => {
    const audio = fakeAudio();
    audio.paused = false;
    const section = "https://app.test/api/storage/audiobooks/job/sections/0008.mp3";
    audio.src = section;
    audio.state.currentTime = 4;
    installSource(new FakeBuffer(audio));
    const playlist = hlsEventPlaylist(
      Array.from({ length: 12 }, (_, index) => ({
        uri: `live/${String(index).padStart(4, "0")}.mp3`,
        seconds: 15,
      })),
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const result = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-far",
      resumeAt: 120,
      play: true,
    });
    expect(result.attached).toBe(false);
    expect(audio.src).toBe(section);
    expect(audio.state.currentTime).toBe(4);
    expect(audio.state.plays).toBe(0);
  });

  it("keeps a section chosen inside the first 90 seconds through the next poll", async () => {
    const audio = fakeAudio();
    audio.paused = false;
    installSource(new FakeBuffer(audio));
    Object.defineProperty(audio, "buffered", { value: { length: 1, end: () => 30 } });
    const playlist = hlsEventPlaylist(
      Array.from({ length: 12 }, (_, index) => ({
        uri: `live/${String(index).padStart(4, "0")}.mp3`,
        seconds: 15,
      })),
      100,
      false
    );
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("live.m3u8")) return new Response(playlist, { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    const started = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-mid",
      resumeAt: 15,
      play: true,
    });
    expect(started.attached).toBe(true);
    const section = "https://app.test/api/storage/audiobooks/job/sections/0003.mp3";
    releaseLiveSession(audio, 60);
    audio.src = section;
    audio.state.currentTime = 2;
    audio.paused = false;
    const plays = audio.state.plays;
    const again = await syncLivePlayback({
      audio,
      playlistUrl: "https://app.test/api/storage/audiobooks/job/live.m3u8",
      jobId: "job-mid",
      resumeAt: 60,
      play: true,
    });
    expect(again.attached).toBe(false);
    expect(audio.src).toBe(section);
    expect(audio.src.startsWith("blob:")).toBe(false);
    expect(audio.state.currentTime).toBe(2);
    expect(audio.state.plays).toBe(plays);
  });
});
