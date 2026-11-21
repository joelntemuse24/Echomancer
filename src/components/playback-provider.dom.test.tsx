/**
 * @vitest-environment jsdom
 *
 * The whole point of lifting audio into the root layout is that a route
 * change must not stop it. These tests mount the provider, play, unmount the
 * page inside it, and check that the element, its source, its position, and
 * the Media Session all survive.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    if (!audioRef.current) return;
    const audio = audioRef.current;
    onAudio(audio);
    // A book only gets a strip after the listener has heard it, and the shell
    // reads that from the element. The page no longer reports "playing", so
    // the harness starts the element the way a real tap would. The provider
    // attaches its listeners in a parent effect, which runs after this one, so
    // the start is queued behind it.
    rowOf(audio).paused = false;
    queueMicrotask(() => audio.dispatchEvent(new Event("play")));
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
    parts: [],
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
        <Harness report={report({ position: 640 })} onAudio={() => {}} />
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
          report={report({ active: false, jobId: null })}
          onAudio={() => {}}
        />
      </PlaybackProvider>
    );
    await act(async () => {});
    // An inactive report means the page has no playable book: nothing to
    // release by itself, and nothing to keep the mini player up for either.
    expect(screen.queryByTestId("mini-player")).toBeNull();
  });

  it("keeps saving the position after the player page unmounts", async () => {
    // The regression: leaving the player for Library left the stored position
    // frozen at the moment of navigation, so closing the tab from the mini
    // player reopened the book minutes behind what had been heard.
    installMediaSession();
    const view = render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    const audio = document.querySelector("audio")!;
    localStorage.removeItem("ec-resume:book-1");

    // Library: the page unmounts, the element keeps playing.
    nav.pathname = "/dashboard/queue";
    view.rerender(<PlaybackProvider>{null}</PlaybackProvider>);
    await act(async () => {});
    rowOf(audio).paused = false;
    rowOf(audio).time = 305;
    rowOf(audio).ready = 4;
    await act(async () => {
      audio.dispatchEvent(new Event("timeupdate"));
    });
    const stored = JSON.parse(localStorage.getItem("ec-resume:book-1") || "null");
    expect(stored?.positionSeconds).toBe(305);
    expect(stored?.sectionIndex).toBeNull();
  });

  it("does not publish a paused session after the strip closes the book", async () => {
    const session = installMediaSession();
    nav.pathname = "/dashboard/queue";
    render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    await act(async () => {
      screen.getByRole("button", { name: "Close player" }).click();
    });
    // Close must end the platform session, not leave it paused-with-a-book.
    expect(session.session.playbackState).toBe("none");
    expect(document.querySelector("audio")!.getAttribute("src")).toBeNull();
  });

  it("puts the strip above the tab bar using the bar's measured height", async () => {
    installMediaSession();
    nav.pathname = "/dashboard/queue";
    const bar = document.createElement("nav");
    bar.setAttribute("data-tab-bar", "");
    // jsdom reports zero layout, so the bar's height is stubbed.
    bar.getBoundingClientRect = () =>
      ({ height: 72, top: 0, bottom: 72, left: 0, right: 0, width: 390, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(bar);
    render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    const mini = screen.getByTestId("mini-player");
    expect(mini.style.bottom).toBe("72px");
    bar.remove();
  });

  it("publishes the chosen speed to the platform, not the first-rendered one", async () => {
    // The element listeners attach once, so a captured `speed` pinned the
    // notification's scrubber to 1× while the book played at another rate.
    const session = installMediaSession();
    const view = render(
      <PlaybackProvider>
        <Harness report={report()} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    // Pick the rate the way the player control does.
    const { setNumberPref, SPEED_PREF_KEY } = await import("@/lib/player/player-prefs");
    await act(async () => {
      setNumberPref(SPEED_PREF_KEY, 1.45);
    });
    const last = session.positions.at(-1)!;
    expect(last.playbackRate).toBe(1.45);
    view.unmount();
  });

  it("moves to the right part when the mini strip seeks across a boundary", async () => {
    // Two 300s parts. The page reports them, then unmounts; the strip's
    // scrubber lands in part 0 while the element holds part 1. It used to
    // clamp into the loaded part and jump to 0:00 of part 1 instead.
    installMediaSession();
    const parts = [
      { index: 0, startSeconds: 0, durationSeconds: 300, url: "/api/storage/part-0.mp3" },
      { index: 1, startSeconds: 300, durationSeconds: 300, url: "/api/storage/part-1.mp3" },
    ];
    const view = render(
      <PlaybackProvider>
        <Harness
          report={report({ position: 320, elementOffset: 300, duration: 600, parts })}
          onAudio={() => {}}
        />
      </PlaybackProvider>
    );
    await act(async () => {});
    const audio = document.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe("/api/storage/book.mp3");

    // Leave the route; the strip appears.
    nav.pathname = "/dashboard/queue";
    view.rerender(<PlaybackProvider>{null}</PlaybackProvider>);
    await act(async () => {});
    await act(async () => {
      fireEvent.change(screen.getByRole("slider", { name: "Seek" }), {
        target: { value: "55" },
      });
    });
    // A fresh `src` is HAVE_NOTHING, so the seek lands with the metadata.
    await act(async () => {
      rowOf(audio).ready = 1;
      audio.dispatchEvent(new Event("loadedmetadata"));
    });
    // The element now holds part 0, and is seeked inside it.
    expect(audio.getAttribute("src")).toBe("/api/storage/part-0.mp3");
    expect(Math.round(rowOf(audio).time)).toBe(55);
  });

  it("does not pause the book when the mini strip seeks", async () => {
    installMediaSession();
    // A single-file book: the element's own part is the whole book.
    const view = render(
      <PlaybackProvider>
        <Harness report={report({ position: 60, duration: 4000 })} onAudio={() => {}} />
      </PlaybackProvider>
    );
    await act(async () => {});
    const audio = document.querySelector("audio")!;
    rowOf(audio).paused = false;
    rowOf(audio).ready = 4;
    rowOf(audio).duration = 4000;
    nav.pathname = "/dashboard/queue";
    view.rerender(<PlaybackProvider>{null}</PlaybackProvider>);
    await act(async () => {});
    await act(async () => {
      fireEvent.change(screen.getByRole("slider", { name: "Seek" }), {
        target: { value: "120" },
      });
    });
    // Seeking inside the part the element already holds never changes `src`,
    // so playback is untouched.
    expect(audio.getAttribute("src")).toBe("/api/storage/book.mp3");
    expect(rowOf(audio).paused).toBe(false);
    expect(Math.round(rowOf(audio).time)).toBe(120);
  });
});
