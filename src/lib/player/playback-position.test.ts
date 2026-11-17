import { describe, expect, it } from "vitest";
import {
  RESUME_SAVE_INTERVAL_MS,
  absoluteBookmarkSeconds,
  availableBookSeconds,
  bookTimeFromElement,
  bookmarkClockLabel,
  bookmarkOnAbsoluteClock,
  contiguousSpans,
  decideResume,
  libraryResumeLabel,
  placeOnTimeline,
  positionToPersist,
  preferResume,
  readStoredResume,
  shouldPersistPlayhead,
  sortBookmarksByClock,
  writeStoredResume,
  type StoredResume,
} from "@/lib/player/playback-position";
import { bookmarksAreDuplicates } from "@/lib/player/bookmarks";

const parts = [
  { index: 0, status: "ready", durationSeconds: 100 },
  { index: 1, status: "ready", durationSeconds: 80 },
  { index: 2, status: "ready", durationSeconds: 50 },
];

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("multi-part book clock", () => {
  const spans = contiguousSpans(parts);

  it("turns each part's playhead into one book time", () => {
    expect(spans.map((span) => span.startSeconds)).toEqual([0, 100, 180]);
    expect(
      bookTimeFromElement({
        mode: "section",
        elementSeconds: 20,
        sectionIndex: 1,
        spans,
      })
    ).toEqual({ seconds: 120, absolute: true });
    expect(
      bookTimeFromElement({
        mode: "full",
        elementSeconds: 33 * 60 + 12,
        sectionIndex: null,
        spans,
      }).seconds
    ).toBe(33 * 60 + 12);
  });

  it("places a book time back onto the part that contains it", () => {
    expect(placeOnTimeline({ bookSeconds: 120, spans })).toEqual({
      sectionIndex: 1,
      localSeconds: 20,
      bookSeconds: 120,
    });
    expect(placeOnTimeline({ bookSeconds: 190, spans })).toMatchObject({
      sectionIndex: 2,
      localSeconds: 10,
    });
  });

  it("stops the clock at a hole so a later part is not given a fake start", () => {
    const gapped = contiguousSpans([
      { index: 0, status: "ready", durationSeconds: 100 },
      { index: 1, status: "mastering", durationSeconds: 80 },
      { index: 2, status: "ready", durationSeconds: 50 },
    ]);
    expect(gapped).toEqual([{ index: 0, startSeconds: 0, durationSeconds: 100 }]);
    expect(
      bookTimeFromElement({
        mode: "section",
        elementSeconds: 12,
        sectionIndex: 2,
        spans: gapped,
      })
    ).toEqual({ seconds: 12, absolute: false });
  });
});

describe("resume decisions", () => {
  it("restores a mid-book position and ignores a failed book", () => {
    expect(
      decideResume({
        playbackAllowed: true,
        positionSeconds: 33 * 60 + 12,
        durationSeconds: 3600,
        availableSeconds: 3600,
        complete: true,
      })
    ).toEqual({ kind: "restore", seconds: 33 * 60 + 12 });
    expect(
      decideResume({
        playbackAllowed: false,
        positionSeconds: 33 * 60 + 12,
        durationSeconds: 3600,
        availableSeconds: 3600,
        complete: true,
      })
    ).toEqual({ kind: "ignore" });
  });

  it("restarts when the stored spot is at the end of a finished book", () => {
    expect(
      decideResume({
        playbackAllowed: true,
        positionSeconds: 995,
        durationSeconds: 1000,
        availableSeconds: 1000,
        complete: true,
      }).kind
    ).toBe("restart");
    expect(
      positionToPersist({
        bookSeconds: 995,
        durationSeconds: 1000,
        complete: true,
        ended: false,
      })
    ).toEqual({ positionSeconds: 0, finished: true });
    expect(
      positionToPersist({
        bookSeconds: 120,
        durationSeconds: 1000,
        complete: true,
        ended: true,
      })
    ).toEqual({ positionSeconds: 0, finished: true });
  });

  it("clamps a generating book to the audio that exists", () => {
    const spans = contiguousSpans(parts.slice(0, 2));
    const available = availableBookSeconds(spans, null, false);
    expect(available).toBe(180);
    const decision = decideResume({
      playbackAllowed: true,
      positionSeconds: 500,
      durationSeconds: null,
      availableSeconds: available,
      complete: false,
    });
    expect(decision.kind).toBe("restore");
    if (decision.kind !== "restore") return;
    expect(decision.seconds).toBeCloseTo(179.75, 2);
    expect(placeOnTimeline({ bookSeconds: decision.seconds, spans })).toMatchObject({
      sectionIndex: 1,
    });
    expect(
      positionToPersist({
        bookSeconds: available - 1,
        durationSeconds: null,
        complete: false,
        ended: false,
      }).finished
    ).toBe(false);
  });

  it("keeps the newer of the local and server copies", () => {
    const local: StoredResume = { positionSeconds: 10, sectionIndex: null, updatedAt: 5 };
    const remote: StoredResume = { positionSeconds: 40, sectionIndex: null, updatedAt: 9 };
    expect(preferResume(local, remote)).toBe(remote);
    expect(preferResume(remote, { ...local, updatedAt: 1 })).toBe(remote);
    expect(preferResume(null, remote)).toBe(remote);
  });

  it("writes on pause, seek, hide, and part change, and paces ticks to five seconds", () => {
    expect(RESUME_SAVE_INTERVAL_MS).toBe(5000);
    expect(shouldPersistPlayhead({ reason: "tick", elapsedMs: 4999, gated: false })).toBe(false);
    expect(shouldPersistPlayhead({ reason: "tick", elapsedMs: 5000, gated: false })).toBe(true);
    expect(shouldPersistPlayhead({ reason: "pause", elapsedMs: 0, gated: false })).toBe(true);
    expect(shouldPersistPlayhead({ reason: "seek", elapsedMs: 0, gated: false })).toBe(true);
    expect(shouldPersistPlayhead({ reason: "hide", elapsedMs: 0, gated: false })).toBe(true);
    expect(shouldPersistPlayhead({ reason: "track", elapsedMs: 0, gated: false })).toBe(true);
    expect(shouldPersistPlayhead({ reason: "tick", elapsedMs: 9000, gated: true })).toBe(false);
    expect(shouldPersistPlayhead({ reason: "pause", elapsedMs: 0, gated: true })).toBe(false);
    expect(shouldPersistPlayhead({ reason: "seek", elapsedMs: 0, gated: true })).toBe(true);
  });

  it("round-trips a position through a storage stand-in", () => {
    const store = memoryStore();
    const saved: StoredResume = { positionSeconds: 1992, sectionIndex: null, updatedAt: 50 };
    writeStoredResume(store, "job-1", saved);
    expect(readStoredResume(store, "job-1")).toEqual(saved);
    expect(readStoredResume(store, "job-2")).toBeNull();
    expect(readStoredResume(null, "job-1")).toBeNull();
  });
});

describe("library resume line", () => {
  it("names the book clock and hides the end, streams, and failed books", () => {
    expect(
      libraryResumeLabel({
        status: "ready",
        positionSeconds: 33 * 60 + 12,
        sectionIndex: null,
        durationSeconds: 7200,
      })
    ).toBe("Resume at 33:12");
    expect(
      libraryResumeLabel({
        status: "ready",
        positionSeconds: 7195,
        durationSeconds: 7200,
      })
    ).toBeNull();
    expect(
      libraryResumeLabel({
        status: "failed",
        positionSeconds: 120,
        durationSeconds: 7200,
      })
    ).toBeNull();
    expect(
      libraryResumeLabel({
        status: "processing",
        jobKind: "stream",
        positionSeconds: 120,
      })
    ).toBeNull();
  });
});

describe("bookmark clock", () => {
  const spans = contiguousSpans(parts);

  it("shows one timestamp, seeks that book time, and drops a second tap within 2s", () => {
    const legacy = { positionSeconds: 12, sectionIndex: 1 as number | null };
    expect(absoluteBookmarkSeconds(legacy, spans)).toBe(112);
    expect(bookmarkClockLabel(legacy, spans)).toBe("1:52");
    expect(bookmarkClockLabel({ positionSeconds: 33 * 60 + 12, sectionIndex: null }, spans)).toBe(
      "33:12"
    );
    const first = bookmarkOnAbsoluteClock(
      { positionSeconds: 33 * 60 + 12, sectionIndex: null },
      spans
    );
    const again = bookmarkOnAbsoluteClock(
      { positionSeconds: 33 * 60 + 13, sectionIndex: null },
      spans
    );
    expect(bookmarksAreDuplicates(first, again)).toBe(true);
    expect(
      bookmarksAreDuplicates(
        first,
        bookmarkOnAbsoluteClock({ positionSeconds: 33 * 60 + 20, sectionIndex: null }, spans)
      )
    ).toBe(false);
    const rows = sortBookmarksByClock(
      [
        { id: "late", positionSeconds: 190, sectionIndex: null },
        { id: "legacy", positionSeconds: 12, sectionIndex: 1 },
        { id: "open", positionSeconds: 4, sectionIndex: null },
      ],
      spans
    );
    expect(rows.map((row) => row.id)).toEqual(["open", "legacy", "late"]);
  });

  it("keeps a legacy part mark when its duration is still unknown", () => {
    expect(absoluteBookmarkSeconds({ positionSeconds: 12, sectionIndex: 4 }, [])).toBeNull();
    expect(bookmarkClockLabel({ positionSeconds: 12, sectionIndex: 4 }, [])).toBe("Part 5 · 0:12");
  });
});
