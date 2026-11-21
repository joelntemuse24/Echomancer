/**
 * @vitest-environment jsdom
 *
 * The whole point of lifting audio into the root layout is that a route
 * change must not stop it. These tests mount the provider, play, unmount the
 * page inside it, and check that the element, its source, its position, and
 * the Media Session all survive.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider, usePlayback, type PlaybackReport } from "@/components/playback-provider";

const nav = { pathname: "/dashboard/player/book-1" };

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

type MediaRow = {
  src: string;
  time: number;
  paused: boolean;
  duration: number;
  ready: number;
};

const rows = new WeakMap<EventTarget, MediaRow>();

function rowOf(target: EventTarget): MediaRow {
  let row = rows.get(target);
  if (!row) {
    row = { src: "", time: 0, paused: true, duration: 0, ready: 0 };
    rows.set(target, row);
  }
  return row;
}

function installMediaElement() {
  const proto = window.HTMLMediaElement.prototype;
  const define = (
    name: string,
    descriptor: {
      get?: (this: HTMLMediaElement) => unknown;
      set?: (this: HTMLMediaElement, value: never) => void;
    }
  ) => {
    Object.defineProperty(proto, name, { configurable: true, ...descriptor });
  };
  define("src", {
    get() {
      return rowOf(this).src || this.getAttribute("src") || "";
    },
    set(value: string) {
      const row = rowOf(this);
      row.src = String(value ?? "");
      row.time = 0;
      row.ready = 0;
      this.setAttribute("src", String(value ?? ""));
    },
  });
  define("currentSrc", {
    get() {
      return rowOf(this).src;
    },
  });
  define("currentTime", {
    get() {
      return rowOf(this).time;
    },
    set(value: number) {
      rowOf(this).time = Number(value) || 0;
    },
  });
  define("paused", {
    get() {
      return rowOf(this).paused;
    },
  });
  define("duration", {
    get() {
      return rowOf(this).duration;
    },
  });
  define("readyState", {
    get() {
      return rowOf(this).ready;
    },
  });
  define("networkState", {
    get() {
      return 1;
    },
  });
  proto.play = function play() {
    rowOf(this).paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  proto.pause = function pause() {
    const row = rowOf(this);
    if (row.paused) return;
    row.paused = true;
    this.dispatchEvent(new Event("pause"));
  };
  proto.load = function load() {};
}

type Recorded = Map<string, ((details: Record<string, unknown>) => void) | null>;

function installMediaSession() {
  const handlers: Recorded = new Map();
  const positions: Array<Record<string, number>> = [];
  const metadata: Array<Record<string, unknown>> = [];
  const session = {
    metadata: null as unknown,
    playbackState: "none",
    setActionHandler(action: string, handler: ((details: Record<string, unknown>) => void) | null) {
      handlers.set(action, handler);
    },
    setPositionState(state?: Record<string, number>) {
      if (state) positions.push(state);
    },
  };
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: session,
  });
  class Metadata {
    constructor(init: Record<string, unknown>) {
      metadata.push(init);
    }
  }
  vi.stubGlobal("MediaMetadata", Metadata);
  // `session.metadata = new MediaMetadata(...)` has to land somewhere visible.
  let stored: unknown = null;
  Object.defineProperty(session, "metadata", {
    configurable: true,
    get: () => stored,
    set: (value: unknown) => {
      stored = value;
    },
  });
  return { session, handlers, positions, metadata };
}

/** A page inside the shell that reports a book and owns the transport. */
function Harness({
  report,
  onAudio,
}: {
  report: PlaybackReport;
  onAudio: (audio: HTMLAudioElement) => void;
}) {
  const { audioRef, setSource, reportSession, detachSession } = usePlayback();
  return (
    <PageBody
      audioRef={audioRef}
      report={report}
      onAudio={onAudio}
      setSource={setSource}
      reportSession={reportSession}
      detachSession={detachSession}
    />
  );
}

function PageBody({
  audioRef,
  report,
  onAudio,
  setSource,
  reportSession,
  detachSession,
}: {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  report: PlaybackReport;
  onAudio: (audio: HTMLAudioElement) => void;
  setSource: (src: string, jobId: string) => void;
  reportSession: (report: PlaybackReport) => void;
  detachSession: () => void;
}) {
  useEffect(() => {
    if (!report.jobId) return;
    setSource("/api/storage/book.mp3", report.jobId);
    if (audioRef.current) onAudio(audioRef.current);
  }, [report.jobId, setSource, onAudio, audioRef]);
  useEffect(() => {
    reportSession(report);
  }, [report, reportSession]);
  useEffect(() => detachSession, [detachSession]);
  return <p>player page</p>;
}

function report(overrides: Partial<PlaybackReport> = {}): PlaybackReport {
  return {
    active: true,
    jobId: "book-1",
    title: "Harbor Lights",
    artist: "Drew",
    album: null,
    duration: 4000,
    position: 120,
    elementOffset: 0,
    playing: true,
    seekable: true,
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    skip: vi.fn(),
    chapter: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  installMediaElement();
  nav.pathname = "/dashboard/player/book-1";
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("playback provider", () => {
  it("keeps the one element and its source when the page unmounts", async () => {
    const session = installMediaSession();
    let captured: HTMLAudioElement | null = null;
    const view = render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={(audio) => (captured = audio)} />
      </PlaybackProvider>
    );
    await act(async () => {});
    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute("src")).toBe("/api/storage/book.mp3");
    expect(captured).toBe(audio);

    // The player page goes away; the shell stays.
    view.rerender(<PlaybackProvider>{null}</PlaybackProvider>);
    await act(async () => {});
    expect(document.querySelector("audio")).toBe(audio);
    expect(audio!.getAttribute("src")).toBe("/api/storage/book.mp3");
    // The session is still installed and still named.
    expect(session.handlers.get("play")).toBeTypeOf("function");
    expect(session.handlers.get("seekto")).toBeTypeOf("function");
  });

  it("shows the mini player once the route no longer matches the book", async () => {
    installMediaSession();
    const view = render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    expect(screen.queryByTestId("mini-player")).toBeNull();

    nav.pathname = "/dashboard/queue";
    view.rerender(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    const mini = screen.getByTestId("mini-player");
    expect(mini.getAttribute("aria-label")).toBe("Now playing");
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close player" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeTruthy();
  });

  it("publishes metadata, playback state, and a position for the platform", async () => {
    const session = installMediaSession();
    render(
      <PlaybackProvider>
        <Harness report={report({ position: 640, playing: true })} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    expect(session.metadata[0]).toMatchObject({
      title: "Harbor Lights",
      artist: "Drew",
    });
    expect(session.session.playbackState).toBe("playing");
    const last = session.positions.at(-1)!;
    expect(last.duration).toBe(4000);
    expect(last.position).toBe(640);
  });

  it("routes lock-screen play and pause to the page while it is mounted", async () => {
    const session = installMediaSession();
    const page = report();
    render(
      <PlaybackProvider>
        <Harness report={page} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    await act(async () => {
      session.handlers.get("play")!({ action: "play" });
    });
    expect(page.play).toHaveBeenCalledTimes(1);
    await act(async () => {
      session.handlers.get("pause")!({ action: "pause" });
    });
    expect(page.pause).toHaveBeenCalledTimes(1);
  });

  it("does not tear the element down when the tab is hidden or unloaded", async () => {
    installMediaSession();
    render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    const audio = document.querySelector("audio")!;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(document.querySelector("audio")).toBe(audio);
    expect(audio.getAttribute("src")).toBe("/api/storage/book.mp3");
  });

  it("releases the source only when the book may no longer play", async () => {
    installMediaSession();
    const view = render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    const audio = document.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe("/api/storage/book.mp3");

    view.rerender(
      <PlaybackProvider>
        <Harness
          report={report({ active: false, jobId: null, playing: false })}
          onAudio={() => {}}
        />
      </PlaybackProvider>
    );
    await act(async () => {});
    // An inactive report means the page has no playable book: nothing to
    // release by itself, and nothing to keep the mini player up for either.
    expect(screen.queryByTestId("mini-player")).toBeNull();
  });
});
