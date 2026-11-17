import { describe, expect, it } from "vitest";
import {
  BOOKMARK_DEDUPE_SECONDS,
  BOOKMARK_LABEL_MAX,
  BOOKMARK_NOTICE_MS,
  BOOKMARK_NOTICE_TEXT,
  bookmarkEscapeTarget,
  bookmarkLabel,
  bookmarkListKeyAction,
  bookmarkNoticeAfterResponse,
  bookmarkNoticeFromResponse,
  bookmarkSavedText,
  bookmarkPlaceLabel,
  bookmarkSaveTap,
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

describe("bookmark status", () => {
  it("keeps Saved and Already saved on screen for about two seconds", () => {
    expect(BOOKMARK_NOTICE_MS).toBeGreaterThanOrEqual(1500);
    expect(BOOKMARK_NOTICE_MS).toBeLessThanOrEqual(2000);
    expect(BOOKMARK_NOTICE_MS).toBe(2000);
  });

  it("maps a duplicate response to Already bookmarked and a new row to Bookmarked", () => {
    expect(BOOKMARK_NOTICE_TEXT[bookmarkNoticeFromResponse({ ok: true, duplicate: true })]).toBe(
      "Already bookmarked"
    );
    expect(BOOKMARK_NOTICE_TEXT[bookmarkNoticeFromResponse({ ok: true, duplicate: false })]).toBe(
      "Bookmarked"
    );
    expect(bookmarkSavedText(33 * 60 + 12)).toBe("Bookmarked 33:12");
    expect(BOOKMARK_NOTICE_TEXT[bookmarkNoticeFromResponse({ ok: false, duplicate: true })]).toBe(
      "Couldn't save bookmark"
    );
  });

  it("does not let an in-flight Saved response replace Already saved", () => {
    const started = 1;
    const afterSecondTap = started + 1;
    expect(
      bookmarkNoticeAfterResponse({
        httpOk: true,
        hasBookmark: true,
        duplicate: false,
        requestEpoch: started,
        currentEpoch: afterSecondTap,
      })
    ).toBeNull();
    expect(
      BOOKMARK_NOTICE_TEXT[
        bookmarkNoticeAfterResponse({
          httpOk: true,
          hasBookmark: true,
          duplicate: true,
          requestEpoch: afterSecondTap,
          currentEpoch: afterSecondTap,
        })!
      ]
    ).toBe("Already bookmarked");
  });

  it("treats a second tap within 2 seconds, including one still in flight, as Already saved", () => {
    const existing = [{ positionSeconds: 10, sectionIndex: null as number | null }];
    expect(
      bookmarkSaveTap({
        pending: true,
        bookmarks: [],
        positionSeconds: 10,
        sectionIndex: null,
      })
    ).toBe("duplicate");
    expect(
      bookmarkSaveTap({
        pending: false,
        bookmarks: existing,
        positionSeconds: 11.5,
        sectionIndex: null,
      })
    ).toBe("duplicate");
    expect(
      bookmarkSaveTap({
        pending: false,
        bookmarks: existing,
        positionSeconds: 14,
        sectionIndex: null,
      })
    ).toBe("send");
  });

  it("closes the list on Escape and leaves the surrounding view up", () => {
    expect(bookmarkListKeyAction("Escape")).toBe("close");
    expect(bookmarkListKeyAction("Esc")).toBe("close");
    expect(bookmarkListKeyAction("Enter")).toBe("none");
    expect(bookmarkEscapeTarget(true)).toBe("list");
    expect(bookmarkEscapeTarget(false)).toBe("view");
  });
});
