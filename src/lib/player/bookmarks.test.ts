import { describe, expect, it } from "vitest";
import {
  BOOKMARK_DEDUPE_SECONDS,
  BOOKMARK_LABEL_MAX,
  bookmarkLabel,
  bookmarkPlaceLabel,
  bookmarksAreDuplicates,
  cleanBookmarkLabel,
  passageSnippet,
  sortBookmarks,
  withSavedBookmark,
  withoutBookmark,
  type JobBookmark,
} from "@/lib/player/bookmarks";

function mark(
  partial: Partial<JobBookmark> & Pick<JobBookmark, "id" | "positionSeconds">
): JobBookmark {
  return {
    sectionIndex: null,
    label: null,
    createdAt: 1,
    ...partial,
  };
}

describe("bookmark dedupe", () => {
  it("treats a mark within 2 seconds on the same clock as the same bookmark", () => {
    const existing = { positionSeconds: 10, sectionIndex: null as number | null };
    expect(bookmarksAreDuplicates(existing, { positionSeconds: 12, sectionIndex: null })).toBe(
      true
    );
    expect(bookmarksAreDuplicates(existing, { positionSeconds: 8, sectionIndex: null })).toBe(
      true
    );
    expect(
      bookmarksAreDuplicates(existing, {
        positionSeconds: 10 + BOOKMARK_DEDUPE_SECONDS + 0.01,
        sectionIndex: null,
      })
    ).toBe(false);
  });

  it("keeps the same timestamp on a different part", () => {
    expect(
      bookmarksAreDuplicates(
        { positionSeconds: 4, sectionIndex: 0 },
        { positionSeconds: 4, sectionIndex: 1 }
      )
    ).toBe(false);
    expect(
      bookmarksAreDuplicates(
        { positionSeconds: 4, sectionIndex: null },
        { positionSeconds: 4, sectionIndex: 0 }
      )
    ).toBe(false);
  });
});

describe("bookmark labels", () => {
  it("keeps a short snippet and drops a blank", () => {
    expect(cleanBookmarkLabel("  Harbor   light  ")).toBe("Harbor light");
    expect(cleanBookmarkLabel("   ")).toBeNull();
    expect(cleanBookmarkLabel(null)).toBeNull();
    const long = "a".repeat(BOOKMARK_LABEL_MAX + 40);
    expect(cleanBookmarkLabel(long)).toHaveLength(BOOKMARK_LABEL_MAX);
  });

  it("prefers the passage under the playhead, then the chapter", () => {
    const blocks = [
      { text: "Chapter One", charStart: 0, charEnd: 11 },
      { text: "The harbor was quiet after dark.", charStart: 12, charEnd: 44 },
    ];
    expect(passageSnippet(blocks, 20)).toBe("The harbor was quiet after dark.");
    expect(passageSnippet(blocks, 99)).toBeNull();
    expect(
      bookmarkLabel({ passage: passageSnippet(blocks, 20), chapterTitle: "Chapter One" })
    ).toBe("The harbor was quiet after dark.");
    expect(bookmarkLabel({ passage: null, chapterTitle: "Chapter One" })).toBe("Chapter One");
  });

  it("names a section clock so two short marks stay distinct", () => {
    expect(bookmarkPlaceLabel({ positionSeconds: 65, sectionIndex: null })).toBe("1:05");
    expect(bookmarkPlaceLabel({ positionSeconds: 12, sectionIndex: 0 })).toBe("Part 1 · 0:12");
    expect(bookmarkPlaceLabel({ positionSeconds: 3723, sectionIndex: null })).toBe("1:02:03");
  });
});

describe("bookmark list updates", () => {
  it("inserts a new mark in listening order and ignores a duplicate id", () => {
    const first = mark({ id: "a", positionSeconds: 40, sectionIndex: null });
    const second = mark({ id: "b", positionSeconds: 5, sectionIndex: 0, label: "Harbor" });
    const sorted = withSavedBookmark([first], second);
    expect(sorted.map((row) => row.id)).toEqual(["a", "b"]);
    expect(withSavedBookmark(sorted, second)).toHaveLength(2);
  });

  it("sorts full-file marks before later parts", () => {
    const rows = sortBookmarks([
      mark({ id: "part", positionSeconds: 1, sectionIndex: 2 }),
      mark({ id: "full", positionSeconds: 90, sectionIndex: null }),
      mark({ id: "open", positionSeconds: 3, sectionIndex: 0 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["full", "open", "part"]);
  });

  it("removes only the requested mark", () => {
    const rows = [
      mark({ id: "a", positionSeconds: 1 }),
      mark({ id: "b", positionSeconds: 20 }),
    ];
    expect(withoutBookmark(rows, "a").map((row) => row.id)).toEqual(["b"]);
  });
});
