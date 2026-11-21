import { describe, expect, it, vi } from "vitest";
import {
  installMediaSessionActions,
  mediaSessionMetadata,
  mediaSessionPositionState,
  shouldReacquireSource,
  type MediaSessionActionDetails,
  type MediaSessionActionName,
  type MediaSessionLike,
} from "./media-session";

type Recorded = Map<MediaSessionActionName, ((details: MediaSessionActionDetails) => void) | null>;

function fakeSession(unsupported: MediaSessionActionName[] = []) {
  const handlers: Recorded = new Map();
  const positions: Array<{ duration: number; position: number; playbackRate: number }> = [];
  const session: MediaSessionLike = {
    metadata: null,
    playbackState: "none",
    setActionHandler(action, handler) {
      if (unsupported.includes(action)) throw new Error(`unsupported: ${action}`);
      handlers.set(action, handler);
    },
    setPositionState(state) {
      if (!state) return;
      positions.push(state);
    },
  };
  return { session, handlers, positions };
}

function actions() {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    seekBy: vi.fn(),
    seekTo: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
  };
}

describe("media session metadata", () => {
  it("names the book, the voice, and the artwork", () => {
    const metadata = mediaSessionMetadata({
      title: "  Harbor   Lights ",
      artist: "Drew",
      album: "Chapter Two",
      artwork: "/icon-512.png",
    });
    expect(metadata.title).toBe("Harbor Lights");
    expect(metadata.artist).toBe("Drew");
    expect(metadata.album).toBe("Chapter Two");
    expect(metadata.artwork).toEqual([
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ]);
  });

  it("omits empty fields and never leaves a blank title", () => {
    const metadata = mediaSessionMetadata({ title: "   ", artist: "  " });
    expect(metadata.title).toBe("Audiobook");
    expect(metadata.artist).toBeUndefined();
    expect(metadata.artwork).toBeUndefined();
    expect(Object.keys(metadata)).toEqual(["title"]);
  });
});

describe("media session position state", () => {
  it("publishes a real duration and a clamped position", () => {
    expect(mediaSessionPositionState({ duration: 4000, position: 1200, playbackRate: 1.2 })).toEqual({
      duration: 4000,
      position: 1200,
      playbackRate: 1.2,
    });
    const atEnd = mediaSessionPositionState({ duration: 4000, position: 4000, playbackRate: 1 });
    expect(atEnd?.position).toBeCloseTo(3999.95, 2);
    const past = mediaSessionPositionState({ duration: 4000, position: -20, playbackRate: 0 });
    expect(past).toEqual({ duration: 4000, position: 0, playbackRate: 1 });
  });

  it("reports nothing for a book that has not loaded yet", () => {
    expect(mediaSessionPositionState({ duration: 0, position: 0, playbackRate: 1 })).toBeNull();
    expect(mediaSessionPositionState({ duration: NaN, position: 0, playbackRate: 1 })).toBeNull();
    expect(mediaSessionPositionState({ duration: Infinity, position: 0, playbackRate: 1 })).toBeNull();
  });
});

describe("media session action handlers", () => {
  it("installs play, pause, seekbackward, seekforward, and seekto", () => {
    const { session, handlers } = fakeSession();
    installMediaSessionActions(session, actions(), { chapterSkip: true, skipSeconds: 10 });
    for (const name of [
      "play",
      "pause",
      "seekbackward",
      "seekforward",
      "seekto",
      "previoustrack",
      "nexttrack",
    ] as MediaSessionActionName[]) {
      expect(handlers.has(name)).toBe(true);
    }
  });

  it("routes each platform action to the page's transport", () => {
    const { session, handlers } = fakeSession();
    const page = actions();
    installMediaSessionActions(session, page, { chapterSkip: true, skipSeconds: 10 });

    handlers.get("play")!({ action: "play" });
    handlers.get("pause")!({ action: "pause" });
    // A platform that sends its own offset wins over the default skip.
    handlers.get("seekbackward")!({ action: "seekbackward", seekOffset: 30 });
    handlers.get("seekforward")!({ action: "seekforward" });
    handlers.get("seekto")!({ action: "seekto", seekTime: 1200 });
    handlers.get("previoustrack")!({ action: "previoustrack" });
    handlers.get("nexttrack")!({ action: "nexttrack" });

    expect(page.play).toHaveBeenCalledTimes(1);
    expect(page.pause).toHaveBeenCalledTimes(1);
    expect(page.seekBy).toHaveBeenNthCalledWith(1, -30);
    expect(page.seekBy).toHaveBeenNthCalledWith(2, 10);
    expect(page.seekTo).toHaveBeenCalledWith(1200);
    expect(page.previous).toHaveBeenCalledTimes(1);
    expect(page.next).toHaveBeenCalledTimes(1);
  });

  it("ignores a seekto without a time instead of seeking to zero", () => {
    const { session, handlers } = fakeSession();
    const page = actions();
    installMediaSessionActions(session, page, { chapterSkip: false, skipSeconds: 10 });
    handlers.get("seekto")!({ action: "seekto" });
    expect(page.seekTo).not.toHaveBeenCalled();
  });

  it("keeps the transport when the browser has no seekto", () => {
    const { session, handlers } = fakeSession(["seekto"]);
    const page = actions();
    installMediaSessionActions(session, page, { chapterSkip: true, skipSeconds: 10 });
    expect(handlers.get("play")).toBeTypeOf("function");
    expect(handlers.get("seekto")).toBeUndefined();
    handlers.get("play")!({ action: "play" });
    expect(page.play).toHaveBeenCalledTimes(1);
  });

  it("clears chapter skip for a book with no chapters", () => {
    const { session, handlers } = fakeSession();
    installMediaSessionActions(session, actions(), { chapterSkip: false, skipSeconds: 10 });
    expect(handlers.get("previoustrack")).toBeNull();
    expect(handlers.get("nexttrack")).toBeNull();
    expect(handlers.get("play")).toBeTypeOf("function");
  });
});

describe("re-acquiring a dropped source", () => {
  it("re-acquires when the platform freed the buffer", () => {
    // Chrome reports NO_SOURCE with an empty currentSrc for a parked tab.
    expect(
      shouldReacquireSource({
        hasSource: true,
        srcAttribute: "",
        currentSrc: "",
        networkState: 3,
        errorCode: null,
      })
    ).toBe(true);
  });

  it("re-acquires when the resource was cleared but a stale currentSrc remains", () => {
    // The shape that made a long-pause resume look like it worked: play()
    // resolves, the clock never moves.
    expect(
      shouldReacquireSource({
        hasSource: true,
        srcAttribute: "",
        currentSrc: "https://cdn.example/x.mp3",
        networkState: 0,
        errorCode: null,
      })
    ).toBe(true);
  });

  it("re-acquires after a media error", () => {
    expect(
      shouldReacquireSource({
        hasSource: true,
        srcAttribute: "/api/storage/x.mp3",
        currentSrc: "/api/storage/x.mp3",
        networkState: 1,
        errorCode: 4,
      })
    ).toBe(true);
  });

  it("leaves a healthy, merely paused element alone", () => {
    expect(
      shouldReacquireSource({
        hasSource: true,
        srcAttribute: "/api/storage/x.mp3",
        currentSrc: "/api/storage/x.mp3",
        networkState: 1,
        errorCode: null,
      })
    ).toBe(false);
    expect(
      shouldReacquireSource({
        hasSource: false,
        srcAttribute: "",
        currentSrc: "",
        networkState: 3,
        errorCode: null,
      })
    ).toBe(false);
  });
});
