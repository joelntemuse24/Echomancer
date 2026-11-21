/**
 * @vitest-environment jsdom
 *
 * The player page owns the <audio> element. These tests mount that page
 * with a media element that does what browsers do on a source change:
 * currentTime returns to 0, readyState drops to HAVE_NOTHING, and pause fires.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetJob, rememberJobDetail } from "@/lib/nav/screen-cache";
import { resetClientSearchForTests } from "@/lib/nav/client-search";
import { PlaybackProvider } from "@/components/playback-provider";
import PlayerPage from "./page";

const JOB = "resume-book";

type MediaState = {
  src: string;
  time: number;
  paused: boolean;
  ready: number;
  ended: boolean;
  duration: number;
};

const mediaState = new WeakMap<EventTarget, MediaState>();

function mediaOf(target: EventTarget): MediaState {
  let row = mediaState.get(target);
  if (!row) {
    row = { src: "", time: 0, paused: true, ready: 0, ended: false, duration: 400 };
    mediaState.set(target, row);
  }
  return row;
}

let applyingSrc = false;
let originalSetAttribute: typeof Element.prototype.setAttribute | null = null;

function applyMediaSrc(element: HTMLMediaElement, value: string) {
  const row = mediaOf(element);
  const next = String(value ?? "");
  const changed = row.src !== "" && next !== row.src;
  const wasPlaying = !row.paused;
  row.src = next;
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
      return mediaOf(this).src || this.getAttribute("src") || "";
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
      return mediaOf(this).src;
    },
  });
  define("currentTime", {
    get() {
      return mediaOf(this).time;
    },
    set(value: number) {
      const row = mediaOf(this);
      row.time = Number(value) || 0;
      row.ended = false;
      if (row.ready < 1) row.ready = 1;
    },
  });
  define("paused", {
    get() {
      return mediaOf(this).paused;
    },
  });
  define("readyState", {
    get() {
      return mediaOf(this).ready;
    },
    set(value: number) {
      mediaOf(this).ready = value;
    },
  });
  define("ended", {
    get() {
      return mediaOf(this).ended;
    },
  });
  define("duration", {
    get() {
      return mediaOf(this).duration;
    },
    set(value: number) {
      mediaOf(this).duration = value;
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
    mediaOf(this).paused = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  };
  proto.pause = function pause() {
    const row = mediaOf(this);
    if (row.paused) return;
    row.paused = true;
    this.dispatchEvent(new Event("pause"));
  };
  proto.load = function load() {};
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/player/resume-book",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children?: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

type JobBody = Record<string, unknown>;

type ServerRow = {
  positionSeconds: number;
  sectionIndex: number | null;
  updatedAt: number;
};

let jobBody: JobBody;
let puts: Array<Record<string, unknown>>;
let holdJob: Promise<void> | null;
let releaseJob: (() => void) | null;
let staleWrite: boolean;
let serverRow: ServerRow | null;
let transcriptDoc: Record<string, unknown> | null;
let bookmarkRows: Array<Record<string, unknown>>;

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
    audio_url: "/api/storage/audiobooks/resume-book/full.mp3",
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

/** The player page reads the one media element from the root-layout shell. */
function Player() {
  return (
    <PlaybackProvider>
      <PlayerPage />
    </PlaybackProvider>
  );
}

function audio(): HTMLAudioElement {
  const element = document.querySelector("audio");
  if (!element) throw new Error("player audio is not mounted");
  return element;
}

async function emit(target: EventTarget, name: string) {
  await act(async () => {
    target.dispatchEvent(new Event(name));
  });
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function openPlayer() {
  render(<Player />);
  await settle();
  if (releaseJob) {
    releaseJob();
    releaseJob = null;
    holdJob = null;
    await settle();
  }
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
  puts = [];
  staleWrite = false;
  holdJob = null;
  releaseJob = null;
  serverRow = null;
  transcriptDoc = null;
  bookmarkRows = [];
  jobBody = baseJob();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/position") && method === "GET") {
        const row = ensureServer();
        if (!row) return json({ positionSeconds: null, sectionIndex: null, updatedAt: null });
        return json(row);
      }
      if (url.includes("/position") && method === "PUT") {
        const body = JSON.parse(String(init?.body ? String(init.body) : "{}")) as Record<string, unknown>;
        puts.push(body);
        const current = ensureServer();
        if (staleWrite) {
          return json(
            {
              stale: true,
              positionSeconds: current?.positionSeconds ?? 50,
              sectionIndex: current?.sectionIndex ?? null,
              updatedAt: current?.updatedAt ?? 100,
            },
            409
          );
        }
        const expected = body.expectedUpdatedAt;
        const force = body.force === true;
        if (current && !force && expected !== current.updatedAt) {
          return json({ stale: true, ...current }, 409);
        }
        const next: ServerRow = {
          positionSeconds: Number(body.positionSeconds) || 0,
          sectionIndex: (body.sectionIndex as number | null) ?? null,
          updatedAt: (current?.updatedAt ?? 100) + 1,
        };
        serverRow = next;
        return json(next);
      }
      if (url.includes("/bookmarks")) return json({ bookmarks: bookmarkRows });
      if (url.includes("/transcript")) {
        if (!transcriptDoc) return json({ error: "missing" }, 404);
        return json(transcriptDoc);
      }
      if (url.includes(`/api/jobs/${JOB}`)) {
        if (holdJob) await holdJob;
        return json({ job: jobBody });
      }
      return json({});
    })
  );
});

function ensureServer(): ServerRow | null {
  if (serverRow) return serverRow;
  if (
    typeof jobBody.resume_position_seconds === "number" &&
    typeof jobBody.resume_updated_at === "number"
  ) {
    serverRow = {
      positionSeconds: jobBody.resume_position_seconds,
      sectionIndex: (jobBody.resume_section_index as number | null) ?? null,
      updatedAt: jobBody.resume_updated_at,
    };
  }
  return serverRow;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  forgetJob(JOB);
});

describe("player resume", () => {
  it("does not persist 0 when the source changes while playing", async () => {
    jobBody = baseJob({
      status: "processing",
      progress: 40,
      current_section: 1,
      total_sections: 2,
      audio_url: null,
      duration_seconds: null,
      segments: [
        {
          index: 0,
          status: "ready",
          path: "audiobooks/resume-book/sections/0000.mp3",
          durationSeconds: 200,
        },
        {
          index: 1,
          status: "ready",
          path: "audiobooks/resume-book/sections/0001.mp3",
          durationSeconds: 100,
        },
      ],
    });
    await openPlayer();
    const element = audio();
    await act(async () => {
      await element.play();
    });
    element.currentTime = 50;
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    const partTwo = screen.getAllByRole("button").find((button) => button.textContent?.includes("02"));
    if (!partTwo) throw new Error("part 2 row is missing");
    await act(async () => {
      fireEvent.click(partTwo);
    });
    await settle();
    expect(element.currentTime).toBe(0);
    expect(puts.some((body) => body.positionSeconds === 0 && body.sectionIndex == null)).toBe(false);
    expect(puts.some((body) => body.positionSeconds === 200)).toBe(true);
  });

  it("does not write until the server row is merged", async () => {
    holdJob = new Promise((resolve) => {
      releaseJob = resolve;
    });
    rememberJobDetail(JOB, { job: jobBody });
    render(<Player />);
    await settle();
    const element = audio();
    await emit(element, "loadedmetadata");
    await emit(element, "pause");
    await settle();
    expect(puts).toEqual([]);
    jobBody = baseJob({
      resume_position_seconds: 1992,
      resume_section_index: null,
      resume_updated_at: 500,
    });
    releaseJob?.();
    releaseJob = null;
    holdJob = null;
    await settle();
    await emit(element, "loadedmetadata");
    await emit(element, "pause");
    await settle();
    expect(puts.filter((body) => body.positionSeconds === 0)).toEqual([]);
  });

  it("keeps playing and saves the server place when play happens before the job loads", async () => {
    holdJob = new Promise((resolve) => {
      releaseJob = resolve;
    });
    rememberJobDetail(JOB, { job: jobBody });
    render(<Player />);
    await settle();
    const element = audio();
    await act(async () => {
      await element.play();
    });
    element.currentTime = 15;
    jobBody = baseJob({
      resume_position_seconds: 1992,
      resume_section_index: null,
      resume_updated_at: 500,
    });
    releaseJob?.();
    releaseJob = null;
    holdJob = null;
    await settle();
    expect(element.paused).toBe(false);
    expect(element.currentTime).toBeCloseTo(1992, 0);
    expect(element.src).toContain("full.mp3");
    element.currentTime = 2010;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await settle();
    expect(puts.some((body) => Number(body.positionSeconds) < 10)).toBe(false);
    expect(
      puts.some(
        (body) =>
          Number(body.positionSeconds) >= 1992 && body.expectedUpdatedAt === 500
      )
    ).toBe(true);
  });

  it("recovers from one conflict while playing and keeps saving the live playhead", async () => {
    jobBody = baseJob({
      resume_position_seconds: 40,
      resume_updated_at: 10,
    });
    await openPlayer();
    const element = audio();
    await emit(element, "loadedmetadata");
    await settle();
    serverRow = { positionSeconds: 100, sectionIndex: null, updatedAt: 20 };
    await act(async () => {
      await element.play();
    });
    element.currentTime = 55;
    await emit(element, "timeupdate");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await settle();
    expect(puts[0]).toMatchObject({ expectedUpdatedAt: 10 });
    const retry = puts.find((body) => body.expectedUpdatedAt === 20);
    expect(Number(retry?.positionSeconds)).toBeGreaterThan(50);
    expect(Number(retry?.positionSeconds)).toBeLessThan(70);
    element.currentTime = 70;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await settle();
    const later = puts.filter((body) => Number(body.positionSeconds) >= 65);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((body) => body.expectedUpdatedAt !== 10)).toBe(true);
    expect(puts.filter((body) => body.expectedUpdatedAt === 10)).toHaveLength(1);
  });

  it("adopts a newer place when an idle tab becomes visible, then saves from there", async () => {
    jobBody = baseJob({
      resume_position_seconds: 100,
      resume_updated_at: 10,
    });
    await openPlayer();
    const element = audio();
    await emit(element, "loadedmetadata");
    await settle();
    expect(element.currentTime).toBeCloseTo(100, 0);
    serverRow = { positionSeconds: 500, sectionIndex: null, updatedAt: 30 };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await emit(document, "visibilitychange");
    await settle();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await emit(document, "visibilitychange");
    await settle();
    expect(element.currentTime).toBeCloseTo(500, 0);
    await act(async () => {
      await element.play();
    });
    element.currentTime = 520;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await settle();
    expect(puts.some((body) => Number(body.positionSeconds) < 50)).toBe(false);
    expect(
      puts.some(
        (body) =>
          Number(body.positionSeconds) >= 510 && body.expectedUpdatedAt === 30
      )
    ).toBe(true);
  });

  it("does not write while paused or when the tab becomes visible", async () => {
    jobBody = baseJob({
      resume_position_seconds: 50,
      resume_updated_at: 100,
    });
    await openPlayer();
    const element = audio();
    await emit(element, "loadedmetadata");
    await settle();
    element.currentTime = 80;
    await emit(element, "timeupdate");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(puts).toEqual([]);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await emit(document, "visibilitychange");
    await settle();
    expect(puts).toEqual([
      expect.objectContaining({ positionSeconds: 80, expectedUpdatedAt: 100, force: false }),
    ]);
    const afterHide = puts.length;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await emit(document, "visibilitychange");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(puts).toHaveLength(afterHide);
  });

  it("keeps a rejected stale write from becoming the stored clock", async () => {
    staleWrite = true;
    jobBody = baseJob({
      resume_position_seconds: 50,
      resume_updated_at: 100,
    });
    await openPlayer();
    const element = audio();
    await emit(element, "loadedmetadata");
    await settle();
    element.currentTime = 80;
    await emit(element, "timeupdate");
    await emit(element, "pause");
    await settle();
    expect(puts[0]).toMatchObject({
      positionSeconds: 80,
      expectedUpdatedAt: 100,
      force: false,
    });
    const stored = JSON.parse(localStorage.getItem(`ec-resume:${JOB}`) ?? "{}") as {
      positionSeconds?: number;
      updatedAt?: number;
    };
    expect(stored.updatedAt).toBe(100);
    expect(stored.positionSeconds).toBe(50);
  });

  it("seeks to the saved place when metadata arrives after the pending-seek limit", async () => {
    localStorage.setItem(
      `ec-resume:${JOB}`,
      JSON.stringify({ positionSeconds: 1992, sectionIndex: null, updatedAt: 500 })
    );
    jobBody = baseJob({
      resume_position_seconds: 1992,
      resume_section_index: null,
      resume_updated_at: 500,
    });
    await openPlayer();
    const element = audio();
    expect(mediaOf(element).ready).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(element.currentTime).toBe(0);
    mediaOf(element).duration = 4000;
    await emit(element, "loadedmetadata");
    expect(element.currentTime).toBeCloseTo(1992, 0);
    await act(async () => {
      await element.play();
    });
    element.currentTime = 2005;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await settle();
    expect(puts.some((body) => Number(body.positionSeconds) < 10)).toBe(false);
    expect(puts.some((body) => Number(body.positionSeconds) >= 1992)).toBe(true);
  });

  it("seeks a bookmark on another part after a slow load", async () => {
    bookmarkRows = [
      {
        id: "mark-1",
        positionSeconds: 250,
        sectionIndex: null,
        label: null,
        createdAt: 1,
      },
    ];
    jobBody = baseJob({
      status: "processing",
      progress: 40,
      current_section: 0,
      total_sections: 2,
      audio_url: null,
      duration_seconds: null,
      segments: [
        {
          index: 0,
          status: "ready",
          path: "audiobooks/resume-book/sections/0000.mp3",
          durationSeconds: 200,
        },
        {
          index: 1,
          status: "ready",
          path: "audiobooks/resume-book/sections/0001.mp3",
          durationSeconds: 100,
        },
      ],
    });
    await openPlayer();
    const element = audio();
    mediaOf(element).duration = 200;
    mediaOf(element).ready = 4;
    await emit(element, "loadedmetadata");
    await act(async () => {
      await element.play();
    });
    element.currentTime = 20;
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks, 1" }));
    const jump = screen.getByRole("button", { name: "4:10" });
    await act(async () => {
      fireEvent.click(jump);
    });
    await settle();
    expect(element.src).toContain("0001.mp3");
    expect(mediaOf(element).ready).toBe(0);
    expect(element.currentTime).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(element.currentTime).toBe(0);
    expect(element.src).toContain("0001.mp3");
    mediaOf(element).duration = 100;
    await emit(element, "loadedmetadata");
    expect(element.currentTime).toBeCloseTo(50, 0);
    element.currentTime = 55;
    if (element.paused) {
      await act(async () => {
        await element.play();
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await settle();
    expect(puts.some((body) => Number(body.positionSeconds) < 10)).toBe(false);
    expect(puts.some((body) => Number(body.positionSeconds) >= 250)).toBe(true);
  });

  it("does not rewind when the server row has the same timestamp", async () => {
    localStorage.setItem(
      `ec-resume:${JOB}`,
      JSON.stringify({ positionSeconds: 1000, sectionIndex: null, updatedAt: 40 })
    );
    jobBody = baseJob({
      resume_position_seconds: 1000,
      resume_section_index: null,
      resume_updated_at: 40,
    });
    holdJob = new Promise((resolve) => {
      releaseJob = resolve;
    });
    rememberJobDetail(JOB, { job: jobBody });
    render(<Player />);
    await settle();
    const element = audio();
    mediaOf(element).duration = 4000;
    await emit(element, "loadedmetadata");
    expect(element.currentTime).toBeCloseTo(1000, 0);
    await act(async () => {
      await element.play();
    });
    element.currentTime = 1003;
    await emit(element, "timeupdate");
    releaseJob?.();
    releaseJob = null;
    holdJob = null;
    await settle();
    expect(element.currentTime).toBeCloseTo(1003, 0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await settle();
    expect(puts.some((body) => Number(body.positionSeconds) < 1002)).toBe(false);
    expect(puts.some((body) => Number(body.positionSeconds) >= 1003)).toBe(true);
  });

  it("a seek that cannot be placed does not stop later saves", async () => {
    jobBody = baseJob({ duration_seconds: null });
    transcriptDoc = {
      blocks: [
        {
          id: "p1",
          kind: "paragraph",
          level: 1,
          text: "Hello there.",
          charStart: 0,
          charEnd: 12,
          sectionIndex: 0,
        },
      ],
      charCount: 12,
      sections: [
        {
          index: 0,
          charStart: 0,
          charEnd: 12,
          durationSeconds: null,
          startSeconds: null,
          sentences: [],
        },
      ],
    };
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(
      () => new AbortController().signal
    );
    try {
      await openPlayer();
      const element = audio();
      mediaOf(element).duration = 0;
      element.currentTime = 40;
      await emit(element, "timeupdate");
      fireEvent.click(screen.getByRole("button", { name: "Transcript" }));
      await settle();
      fireEvent.click(screen.getByRole("button", { name: /Play from Hello there/ }));
      await settle();
      await emit(element, "pause");
      await settle();
      expect(puts.some((body) => Number(body.positionSeconds) >= 30)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("skips on a part past a hole using that part's clock", async () => {
    jobBody = baseJob({
      status: "processing",
      progress: 30,
      current_section: 0,
      total_sections: 3,
      audio_url: null,
      duration_seconds: null,
      segments: [
        {
          index: 0,
          status: "ready",
          path: "audiobooks/resume-book/sections/0000.mp3",
          durationSeconds: 100,
        },
        { index: 1, status: "pending", path: "", durationSeconds: null },
        {
          index: 2,
          status: "ready",
          path: "audiobooks/resume-book/sections/0002.mp3",
          durationSeconds: 80,
        },
      ],
    });
    await openPlayer();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    const partThree = screen.getAllByRole("button").find((button) => button.textContent?.includes("03"));
    if (!partThree) throw new Error("part 3 row is missing");
    await act(async () => {
      fireEvent.click(partThree);
    });
    const element = audio();
    expect(element.src).toContain("0002.mp3");
    element.currentTime = 20;
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    expect(element.currentTime).toBe(30);
    expect(element.src).toContain("0002.mp3");
  });
});
