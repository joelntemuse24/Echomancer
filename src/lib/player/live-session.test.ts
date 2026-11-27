import { afterEach, describe, expect, it, vi } from "vitest";
import { hlsEventPlaylist } from "@/lib/player/live-playlist";
import { syncLivePlayback } from "@/lib/player/live-session";

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

describe("syncLivePlayback", () => {
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
});
