import { describe, expect, it } from "vitest";
import {
  chapterSpansFromSections,
  playbackChaptersFromSections,
  playbackChaptersWithTimes,
} from "./playback-chapters";
import { fineSeekBounds } from "./seek";

describe("playbackChaptersFromSections", () => {
  it("collapses later windows of a chapter onto the heading", () => {
    const chapters = playbackChaptersFromSections(
      [
        {
          index: 0,
          chapterIndex: 0,
          chapterTitle: "Chapter One",
          charStart: 0,
          charEnd: 100,
        },
        {
          index: 1,
          chapterIndex: 0,
          chapterTitle: null,
          charStart: 100,
          charEnd: 200,
        },
        {
          index: 2,
          chapterIndex: 1,
          chapterTitle: "Chapter Two",
          charStart: 200,
          charEnd: 280,
        },
      ],
      [
        { index: 0, durationSeconds: 30 },
        { index: 1, durationSeconds: 40 },
        { index: 2, durationSeconds: 20 },
      ]
    );

    expect(chapters).toEqual([
      { index: 0, title: "Chapter One", startFraction: 0 },
      { index: 1, title: "Chapter Two", startFraction: 0.7778 },
    ]);
  });

  it("stays empty when the book has no chapter titles", () => {
    expect(
      playbackChaptersFromSections(
        [
          {
            index: 0,
            chapterIndex: 0,
            chapterTitle: null,
            charStart: 0,
            charEnd: 50,
          },
        ],
        [{ index: 0, durationSeconds: 10 }]
      )
    ).toEqual([]);
  });

  it("keeps every titled chapter when no duration was stored", () => {
    const chapters = playbackChaptersFromSections(
      [
        {
          index: 0,
          chapterIndex: 0,
          chapterTitle: "Chapter One",
          charStart: 0,
          charEnd: 40,
        },
        {
          index: 1,
          chapterIndex: 0,
          chapterTitle: null,
          charStart: 40,
          charEnd: 80,
        },
        {
          index: 2,
          chapterIndex: 1,
          chapterTitle: "Chapter Two",
          charStart: 80,
          charEnd: 100,
        },
      ],
      [{ index: 0, durationSeconds: 12 }]
    );
    expect(chapters).toEqual([
      { index: 0, title: "Chapter One", startFraction: 0 },
      { index: 1, title: "Chapter Two", startFraction: 0.8 },
    ]);
  });

  it("places chapters from character offsets when a section duration is missing", () => {
    const chapters = playbackChaptersFromSections(
      [
        {
          index: 0,
          chapterIndex: 0,
          chapterTitle: "Opening",
          charStart: 0,
          charEnd: 25,
        },
        {
          index: 1,
          chapterIndex: 1,
          chapterTitle: "Later",
          charStart: 50,
          charEnd: 100,
        },
      ],
      []
    );
    expect(chapters).toEqual([
      { index: 0, title: "Opening", startFraction: 0 },
      { index: 1, title: "Later", startFraction: 0.5 },
    ]);
  });
});

describe("chapterSpansFromSections", () => {
  it("groups consecutive windows of one chapter onto its first section", () => {
    const spans = chapterSpansFromSections([
      { index: 0, chapterIndex: 0, chapterTitle: "Chapter One", charStart: 0, charEnd: 50 },
      { index: 1, chapterIndex: 0, chapterTitle: null, charStart: 50, charEnd: 90 },
      { index: 2, chapterIndex: 1, chapterTitle: "Chapter Two", charStart: 90, charEnd: 120 },
      { index: 3, chapterIndex: 1, chapterTitle: "Chapter Two", charStart: 120, charEnd: 150 },
    ]);
    expect(spans).toEqual([
      { title: "Chapter One", sectionIndex: 0 },
      { title: "Chapter Two", sectionIndex: 2 },
    ]);
  });

  it("skips untitled runs so a book without chapters stays a Section list", () => {
    expect(
      chapterSpansFromSections([
        { index: 0, chapterIndex: 0, chapterTitle: null, charStart: 0, charEnd: 50 },
      ])
    ).toEqual([]);
  });
});

describe("playbackChaptersWithTimes", () => {
  it("writes measured start and end seconds from the finished file", () => {
    const chapters = playbackChaptersWithTimes(
      [
        { title: "Chapter One", sectionIndex: 0 },
        { title: "Chapter Two", sectionIndex: 2 },
      ],
      [0, 30, 65.25],
      120
    );
    expect(chapters).toEqual([
      {
        index: 0,
        title: "Chapter One",
        startFraction: 0,
        startSeconds: 0,
        endSeconds: 65.25,
      },
      {
        index: 1,
        title: "Chapter Two",
        startFraction: 0.5438,
        startSeconds: 65.25,
        endSeconds: 120,
      },
    ]);
  });

  it("skips a chapter whose section was never timed", () => {
    const chapters = playbackChaptersWithTimes(
      [
        { title: "Chapter One", sectionIndex: 0 },
        { title: "Ghost", sectionIndex: 5 },
        { title: "Chapter Two", sectionIndex: 1 },
      ],
      [0, 40],
      80
    );
    expect(chapters.map((chapter) => chapter.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(chapters[1]).toMatchObject({ startSeconds: 40, endSeconds: 80 });
  });

  it("stays empty without a total", () => {
    expect(
      playbackChaptersWithTimes([{ title: "Chapter One", sectionIndex: 0 }], [0], 0)
    ).toEqual([]);
  });
});

describe("fineSeekBounds", () => {
  it("is absent on a short clip", () => {
    expect(fineSeekBounds(10, 15 * 60)).toBeNull();
  });

  it("centers a two-minute window and clamps at the ends", () => {
    expect(fineSeekBounds(1000, 3600)).toEqual({ start: 940, end: 1060 });
    expect(fineSeekBounds(10, 3600)).toEqual({ start: 0, end: 120 });
    expect(fineSeekBounds(3590, 3600)).toEqual({ start: 3480, end: 3600 });
  });
});
