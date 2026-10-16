import { describe, expect, it } from "vitest";
import {
  activeBlockIndex,
  buildReadAlongDocument,
  charIndexForPlayback,
  type ReadAlongPosition,
} from "@/lib/player/read-along";
import {
  parseStreamTimeline,
  streamClockDocument,
  streamCoveredSeconds,
  streamUrlWithConn,
  timelineMatchesConn,
  type StreamTimeline,
} from "@/lib/player/stream-clock";

const FIRST = "The harbor was quiet. Gulls circled the pier. Nobody spoke.";
const SECOND = "Morning came slowly. The nets were wet.";
const THIRD = "Night fell.";
const TEXT = `${FIRST}\n\n${SECOND}\n\n${THIRD}`;
const doc = buildReadAlongDocument({ contentText: TEXT });
const at = (needle: string) => TEXT.indexOf(needle);

function timeline(seconds: Array<number | null>): StreamTimeline {
  const ranges = [
    [0, FIRST.length],
    [at(SECOND), at(SECOND) + SECOND.length],
    [at(THIRD), at(THIRD) + THIRD.length],
  ] as const;
  return {
    conn: "conn-test0001",
    windows: ranges.map(([start, end], i) => ({ start, end, seconds: seconds[i] ?? null })),
  };
}

function charAt(clock: ReturnType<typeof streamClockDocument>, currentTime: number) {
  const position: ReadAlongPosition = {
    mode: "full", currentTime, duration: 0, sectionIndex: null, streamCursor: null,
  };
  return charIndexForPlayback(clock, position);
}

describe("streamClockDocument", () => {
  it("maps media time through measured, unequal window lengths", () => {
    const clock = streamClockDocument(doc, timeline([30, 10, 5]));
    expect(charAt(clock, 0)).toBe(0);
    expect(charAt(clock, 29)).toBeLessThan(at(SECOND));
    expect(charAt(clock, 30.5)).toBe(at(SECOND));
    expect(charAt(clock, 41)).toBe(at(THIRD));
    expect(activeBlockIndex(clock, { mode: "full", currentTime: 41, duration: 0, sectionIndex: null, streamCursor: null })).toBe(2);
  });

  it("weights sentences by speakable length inside a window", () => {
    const clock = streamClockDocument(doc, timeline([30, 10, 5]));
    const secondSentence = at("Gulls");
    const thirdSentence = at("Nobody");
    expect(charAt(clock, 0.5)).toBe(0);
    expect(charAt(clock, 14)).toBe(secondSentence);
    expect(charAt(clock, 29)).toBe(thirdSentence);
  });

  it("holds the same passage while paused, buffering or at any playback rate", () => {
    const clock = streamClockDocument(doc, timeline([30, 10, 5]));
    // currentTime is media time: it stops when paused or buffering and does
    // not scale with rate, so the same media time always gives the same text.
    const first = charAt(clock, 33);
    for (let i = 0; i < 5; i++) expect(charAt(clock, 33)).toBe(first);
    expect(charAt(clock, 33.4)).toBeGreaterThanOrEqual(first);
  });

  it("never runs ahead of the measured audio", () => {
    const clock = streamClockDocument(doc, timeline([30, null, null]));
    expect(charAt(clock, 29.9)).toBeLessThan(at(SECOND));
    expect(charAt(clock, 0)).toBe(0);
  });

  it("estimates an unmeasured window at the measured pace and corrects it when measured", () => {
    const estimated = streamClockDocument(doc, timeline([30, null, null]));
    const secondWindow = estimated.sections[1]!;
    const pace = 30 / FIRST.replace(/\s+/g, " ").length;
    expect(secondWindow.durationSeconds!).toBeGreaterThan(SECOND.length * pace * 0.9);
    expect(secondWindow.startSeconds).toBe(30);
    const measured = streamClockDocument(doc, timeline([30, 10, 5]));
    expect(measured.sections[1]!.durationSeconds).toBe(10);
    expect(charAt(measured, 30.1)).toBe(at(SECOND));
  });

  it("rests on the first sentence of the first window until any window is measured", () => {
    const unmeasured = streamClockDocument(doc, timeline([null, null, null]));
    for (const seconds of [0, 12, 300, 4000]) expect(charAt(unmeasured, seconds)).toBe(0);
    const resumed = { ...timeline([null, null, null]), windows: timeline([null, null, null]).windows.slice(1) };
    expect(charAt(streamClockDocument(doc, resumed), 25)).toBe(at(SECOND));
  });

  it("keeps the passage when a window's measurement arrives", () => {
    const before = streamClockDocument(doc, timeline([30, null, null]));
    const after = streamClockDocument(doc, timeline([30, 10, 5]));
    expect(charAt(after, 12)).toBe(charAt(before, 12));
  });

  it("starts the clock at the connection's first window, not at the book start", () => {
    const resumed = { ...timeline([10, 4, null]), windows: timeline([10, 4, null]).windows.slice(1) };
    const clock = streamClockDocument(doc, resumed);
    expect(charAt(clock, 0)).toBe(at(SECOND));
    expect(charAt(clock, 4.5)).toBe(at(THIRD));
  });

  it("ends on the last window", () => {
    const clock = streamClockDocument(doc, timeline([30, 10, 5]));
    expect(charAt(clock, 500)).toBeGreaterThanOrEqual(at(THIRD));
    expect(charAt(clock, 500)).toBeLessThan(doc.charCount);
  });
});

describe("timelineMatchesConn", () => {
  it("applies only to the connection that wrote it", () => {
    expect(timelineMatchesConn(timeline([5]), "conn-test0001")).toBe(true);
    expect(timelineMatchesConn(timeline([5]), "conn-other001")).toBe(false);
    expect(timelineMatchesConn(timeline([5]), null)).toBe(false);
    expect(timelineMatchesConn({ conn: "conn-test0001", windows: [] }, "conn-test0001")).toBe(false);
    expect(timelineMatchesConn(null, "conn-test0001")).toBe(false);
  });
});

describe("streamCoveredSeconds", () => {
  it("counts only the leading measured windows", () => {
    expect(streamCoveredSeconds(timeline([30, 10, null]))).toBe(40);
    expect(streamCoveredSeconds(timeline([30, null, 5]))).toBe(30);
    expect(streamCoveredSeconds(timeline([null, 10, 5]))).toBe(0);
  });
});

describe("parseStreamTimeline", () => {
  it("round-trips a stored timeline and rejects malformed ones", () => {
    const stored = timeline([5, null, 2]);
    expect(parseStreamTimeline(JSON.stringify(stored))).toEqual(stored);
    expect(parseStreamTimeline(null)).toBeNull();
    expect(parseStreamTimeline("not json")).toBeNull();
    expect(parseStreamTimeline({ conn: "x", windows: [{ start: 5, end: 2, seconds: 1 }] })).toBeNull();
    expect(parseStreamTimeline({ conn: "x" })).toBeNull();
  });
});

describe("streamUrlWithConn", () => {
  it("adds the connection id to a bare or query-bearing url", () => {
    expect(streamUrlWithConn("/api/jobs/1/stream", "abc")).toBe("/api/jobs/1/stream?conn=abc");
    expect(streamUrlWithConn("/s?x=1", "abc")).toBe("/s?x=1&conn=abc");
  });
});
