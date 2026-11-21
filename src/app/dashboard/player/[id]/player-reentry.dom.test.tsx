/**
 * @vitest-environment jsdom
 *
 * Re-entering a book while the root-layout shell is still playing it.
 *
 * The player page is unmounted on navigation, so its local media state starts
 * from scratch when the listener comes back. Nothing re-derives "is this
 * playing" from the one element, and no `play` event fires for an element that
 * never stopped — so the transport showed Play over playing audio and its tap
 * was a no-op. These tests mount the provider once, unmount only the page, and
 * come back to it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackProvider } from "@/components/playback-provider";
import { forgetJob, rememberJobDetail } from "@/lib/nav/screen-cache";
import { resetClientSearchForTests } from "@/lib/nav/client-search";
import PlayerPage from "./page";

const JOB = "reentry-book";

type MediaRow = {
  src: string;
  time: number;
  paused: boolean;
  ready: number;
  ended: boolean;
  duration: number;
};

const mediaState = new WeakMap<EventTarget, MediaRow>();

function rowOf(target: EventTarget): MediaRow {
  let row = mediaState.get(target);
  if (!row) {
    row = { src: "", time: 0, paused: true, ready: 0, ended: false, duration: 4000 };
    mediaState.set(target, row);
  }
  return row;
}

let applyingSrc = false;
let originalSetAttribute: typeof Element.prototype.setAttribute | null = null;

/** Every `src` the page or the shell writes, so a re-entry cannot restart. */
let srcWrites: string[] = [];
/** Every `load()` call, so a re-entry cannot reload. */
let loadCalls = 0;

function applyMediaSrc(element: HTMLMediaElement, value: string) {
  const row = rowOf(element);
  const next = String(value ?? "");
  const changed = row.src !== "" && next !== row.src;
  const wasPlaying = !row.paused;
  row.src = next;
  srcWrites.push(next);
  if (!changed) return;
  row.time = 0;
  row.ready = 0;
  row.ended = false;
  if (wasPlaying) {
    row.paused = true;
    element.dispatchEvent(new Event("pause"));
  }
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
  if (!originalSetAttribute) {
    originalSetAttribute = window.Element.prototype.setAttribute;
    const nativeSetAttribute = originalSetAttribute;
    window.Element.prototype.setAttribute = function setAttribute(name: string, value: string) {
      if (!applyingSrc && name === "src" && this instanceof window.HTMLMediaElement) {
        applyingSrc = true;
        try {
          applyMediaSrc(this, value);
          return nativeSetAttribute.call(this, name, value);
        } finally {
          applyingSrc = false;
        }
      }
      return nativeSetAttribute.call(this, name, value);
    };
  }
  define("src", {
    get() {
      return rowOf(this).src || this.getAttribute("src") || "";
    },
    set(value: string) {
      if (applyingSrc) return;
      applyingSrc = true;
      try {
        applyMediaSrc(this, value);
        originalSetAttribute!.call(this, "src", String(value ?? ""));
      } finally {
        applyingSrc = false;
      }
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
      const row = rowOf(this);
      row.time = Number(value) || 0;
      row.ended = false;
      if (row.ready < 1) row.ready = 1;
    },
  });
  define("paused", {
    get() {
      return rowOf(this).paused;
    },
  });
  define("readyState", {
    get() {
      return rowOf(this).ready;
    },
    set(value: number) {
      rowOf(this).ready = value;
    },
  });
  define("ended", {
    get() {
      return rowOf(this).ended;
    },
  });
  define("duration", {
    get() {
      return rowOf(this).duration;
    },
    set(value: number) {
      rowOf(this).duration = value;
    },
  });
  define("seeking", {
    get() {
      return false;
    },
  });
  define("networkState", {
    get() {
      return 1;
    },
  });
  proto.play = function play() {
    const row = rowOf(this);
    // Per the HTML spec, playing an ended element clears `ended` and restarts
    // it at the earliest position. A stub that left `ended` set would make a
    // correct transport look broken.
    if (row.ended) {
      row.ended = false;
      row.time = 0;
    }
    row.paused = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  };
  proto.pause = function pause() {
    const row = rowOf(this);
    if (row.paused) return;
    row.paused = true;
    this.dispatchEvent(new Event("pause"));
  };
  proto.load = function load() {
    loadCalls += 1;
  };
}

/**
 * The real route. The mini strip only renders when the route no longer matches
 * the book, which is exactly the state the listener is in after navigating
 * away, so the mock has to move.
 */
const nav = { pathname: `/dashboard/player/${JOB}` };

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

type JobBody = Record<string, unknown>;

let jobBody: JobBody;
let session: {
  playbackState: string;
  handlers: Map<string, ((details: Record<string, unknown>) => void) | null>;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseJob(overrides: JobBody = {}): JobBody {
  return {
    id: JOB,
    book_title: "Harbor",
    voice_name: "Drew",
    status: "ready",
    progress: 100,
    current_section: 1,
    total_sections: 1,
    audio_url: `/api/storage/audiobooks/${JOB}/full.mp3`,
    duration_seconds: 4000,
    error_message: null,
    created_at: "2026-11-17T00:00:00.000Z",
    updated_at: "2026-11-17T00:00:00.000Z",
    job_kind: "takehome",
    tts_provider: "drew",
    segments: null,
    chapters: [],
    resume_position_seconds: null,
    resume_section_index: null,
    resume_updated_at: null,
    ...overrides,
  };
}

function audio(): HTMLAudioElement {
  const element = document.querySelector("audio");
  if (!element) throw new Error("the shell's audio element is not mounted");
  return element;
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/** The provider stays mounted; only the page comes and goes. */
function Shell({ showPage }: { showPage: boolean }) {
  return <PlaybackProvider>{showPage ? <PlayerPage /> : null}</PlaybackProvider>;
}

async function enterPlayer() {
  const view = render(<Shell showPage />);
  await settle();
  return view;
}

/** Navigate away: the page unmounts, the route no longer names the book. */
function leaveToLibrary(view: { rerender: (ui: React.ReactElement) => void }) {
  nav.pathname = "/dashboard/queue";
  view.rerender(<Shell showPage={false} />);
}

/** Come back to the book: the page mounts again on its own route. */
function returnToBook(view: { rerender: (ui: React.ReactElement) => void }) {
  nav.pathname = `/dashboard/player/${JOB}`;
  view.rerender(<Shell showPage />);
}

beforeEach(() => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
  installMediaElement();
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  }
  vi.useFakeTimers();
  resetClientSearchForTests();
  localStorage.clear();
  forgetJob(JOB);
  srcWrites = [];
  loadCalls = 0;
  nav.pathname = `/dashboard/player/${JOB}`;
  jobBody = baseJob();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });

  const handlers = new Map<string, ((details: Record<string, unknown>) => void) | null>();
  session = { playbackState: "none", handlers };
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      metadata: null,
      get playbackState() {
        return session.playbackState;
      },
      set playbackState(value: string) {
        session.playbackState = value;
      },
      setActionHandler(action: string, handler: ((details: Record<string, unknown>) => void) | null) {
        handlers.set(action, handler);
      },
      setPositionState() {},
    },
  });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    }
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/position")) {
        return json({ positionSeconds: null, sectionIndex: null, updatedAt: null });
      }
      if (url.includes("/bookmarks")) return json({ bookmarks: [] });
      if (url.includes("/transcript")) return json({ error: "missing" }, 404);
      if (url.includes(`/api/jobs/${JOB}`)) return json({ job: jobBody });
      return json({});
    })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  forgetJob(JOB);
});

describe("re-entering a book from the mini player", () => {
  it("follows a notification pause and resume while the page is open", async () => {
    // Not a navigation test, but the same rule: the icon must follow the
    // element, including when the platform pauses it from outside the page.
    rememberJobDetail(JOB, { job: jobBody });
    await enterPlayer();
    const element = audio();
    rowOf(element).ready = 4;
    await act(async () => {
      element.dispatchEvent(new Event("loadedmetadata"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();

    // The lock-screen pause reaches the element, not the page's state.
    await act(async () => {
      session.handlers.get("pause")?.({ action: "pause" });
    });
    await settle();
    expect(rowOf(element).paused).toBe(true);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(session.playbackState).toBe("paused");

    // ...and the lock-screen play brings it back, with the icon following.
    await act(async () => {
      session.handlers.get("play")?.({ action: "play" });
    });
    await settle();
    expect(rowOf(element).paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(session.playbackState).toBe("playing");
  });

  it("shows Play and starts on the first tap after the book ended in the mini strip", async () => {
    rememberJobDetail(JOB, { job: jobBody });
    const view = await enterPlayer();
    const element = audio();
    rowOf(element).ready = 4;
    rowOf(element).duration = 4000;
    await act(async () => {
      element.dispatchEvent(new Event("loadedmetadata"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();

    // Leave; the book runs to the end while the strip is up.
    leaveToLibrary(view);
    await settle();
    await act(async () => {
      rowOf(element).time = 4000;
      rowOf(element).ended = true;
      rowOf(element).paused = true;
      element.dispatchEvent(new Event("ended"));
    });
    await settle();
    expect(session.playbackState).toBe("paused");

    returnToBook(view);
    await settle();
    // An ended book is not playing, so the transport offers Play.
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    // One tap starts it again rather than doing nothing.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();
    expect(rowOf(element).paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("starts on the first tap after the strip closed the book", async () => {
    rememberJobDetail(JOB, { job: jobBody });
    const view = await enterPlayer();
    const element = audio();
    rowOf(element).ready = 4;
    await act(async () => {
      element.dispatchEvent(new Event("loadedmetadata"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();

    // Leave and close from the strip: the shell releases the source.
    leaveToLibrary(view);
    await settle();
    await act(async () => {
      screen.getByRole("button", { name: "Close player" }).click();
    });
    await settle();
    expect(element.getAttribute("src")).toBeNull();

    returnToBook(view);
    await settle();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();
    expect(element.getAttribute("src")).toContain("full.mp3");
    expect(rowOf(element).paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("shows the part the shell is on, not the first part, for a part book", async () => {
    // The page's own part index starts at 0 on re-entry. A book the shell is
    // playing in part 1 must come back on part 1, with its own clock.
    const segments = [
      { index: 0, status: "ready", path: `${JOB}/sections/0000.mp3`, durationSeconds: 300 },
      { index: 1, status: "ready", path: `${JOB}/sections/0001.mp3`, durationSeconds: 300 },
    ];
    jobBody = baseJob({
      status: "processing",
      progress: 50,
      audio_url: null,
      duration_seconds: null,
      segments,
    });
    rememberJobDetail(JOB, { job: jobBody });
    const view = await enterPlayer();
    const element = audio();
    // The shell is holding part 1 at 0:42, playing.
    await act(async () => {
      element.setAttribute("src", `/api/storage/${JOB}/sections/0001.mp3`);
      rowOf(element).ready = 4;
      rowOf(element).time = 42;
      rowOf(element).paused = false;
      element.dispatchEvent(new Event("loadedmetadata"));
    });
    leaveToLibrary(view);
    await settle();
    returnToBook(view);
    await settle();

    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(element.getAttribute("src")).toContain("sections/0001.mp3");
    expect(rowOf(element).time).toBe(42);
    expect(rowOf(element).paused).toBe(false);
    // The 42s in part 1 is 5:42 on the book clock, not 0:42 of part 0.
    expect(screen.getAllByText(/5:42/).length).toBeGreaterThan(0);
  });

  it("shows Pause and toggles correctly when the shell never stopped playing", async () => {
    rememberJobDetail(JOB, { job: jobBody });
    const view = await enterPlayer();
    const element = audio();
    rowOf(element).ready = 4;
    await act(async () => {
      element.dispatchEvent(new Event("loadedmetadata"));
    });

    // Start the book from the page's own transport.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();
    expect(rowOf(element).paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();

    // Walk away: the page unmounts, the element keeps playing.
    leaveToLibrary(view);
    await settle();
    expect(rowOf(element).paused).toBe(false);

    const srcBefore = element.getAttribute("src");
    const writesBefore = srcWrites.length;
    const loadsBefore = loadCalls;
    rowOf(element).time = 137;

    // Come back to the same book.
    returnToBook(view);
    await settle();

    // The transport reflects the element, not a fresh "paused" default.
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
    // The platform session says so too.
    expect(session.playbackState).toBe("playing");
    // Re-entry must not restart, reload, or seek the audio.
    expect(element.getAttribute("src")).toBe(srcBefore);
    expect(srcWrites.length).toBe(writesBefore);
    expect(loadCalls).toBe(loadsBefore);
    expect(rowOf(element).time).toBe(137);
    expect(rowOf(element).paused).toBe(false);

    // Tap pauses, tap resumes.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });
    await settle();
    expect(rowOf(element).paused).toBe(true);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(session.playbackState).toBe("paused");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();
    expect(rowOf(element).paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(rowOf(element).time).toBe(137);
  });

  it("resumes on the first tap when the mini player paused the book", async () => {
    rememberJobDetail(JOB, { job: jobBody });
    const view = await enterPlayer();
    const element = audio();
    rowOf(element).ready = 4;
    await act(async () => {
      element.dispatchEvent(new Event("loadedmetadata"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();
    rowOf(element).time = 88;

    // Leave, and pause from the mini strip.
    leaveToLibrary(view);
    await settle();
    await act(async () => {
      screen.getByRole("button", { name: "Pause" }).click();
    });
    await settle();
    expect(rowOf(element).paused).toBe(true);

    const srcBefore = element.getAttribute("src");
    const writesBefore = srcWrites.length;
    const loadsBefore = loadCalls;

    // Back into the book: it reads as paused at the saved spot.
    returnToBook(view);
    await settle();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(session.playbackState).toBe("paused");

    // One tap resumes, with no reload and no rewind.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
    });
    await settle();
    expect(rowOf(element).paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(element.getAttribute("src")).toBe(srcBefore);
    expect(srcWrites.length).toBe(writesBefore);
    expect(loadCalls).toBe(loadsBefore);
    expect(rowOf(element).time).toBe(88);
    expect(session.playbackState).toBe("playing");
  });
});
