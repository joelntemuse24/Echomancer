import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookmarkList, PlayerBookmarks } from "@/components/player-bookmarks";
import type { JobBookmark } from "@/lib/player/bookmarks";

const marks: JobBookmark[] = [
  {
    id: "mark-1",
    positionSeconds: 65,
    sectionIndex: null,
    label: "The harbor was quiet",
    createdAt: 1,
  },
  {
    id: "mark-2",
    positionSeconds: 12,
    sectionIndex: 1,
    label: null,
    createdAt: 2,
  },
];

function html(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node);
}

describe("PlayerBookmarks", () => {
  it("is a one-tap save control with an accessible name and no text field", () => {
    const markup = html(
      createElement(PlayerBookmarks, {
        bookmarks: marks,
        disabled: false,
        notice: null,
        onSave: () => {},
        onJump: () => {},
        onRemove: () => {},
      })
    );
    expect(markup).toContain('aria-label="Save bookmark"');
    expect(markup).toContain('data-testid="save-bookmark"');
    expect(markup).toContain('data-bookmark-state="idle"');
    expect(markup).toContain('aria-label="Bookmarks, 2"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain('data-testid="bookmark-list"');
  });

  it("fills the icon and says Saved after a new mark", () => {
    const markup = html(
      createElement(PlayerBookmarks, {
        bookmarks: marks,
        disabled: false,
        notice: "saved",
        onSave: () => {},
        onJump: () => {},
        onRemove: () => {},
      })
    );
    expect(markup).toContain('data-bookmark-state="saved"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain(">Saved<");
    expect(markup).toContain('role="status"');
  });

  it("says Already saved when the playhead is already marked", () => {
    const markup = html(
      createElement(PlayerBookmarks, {
        bookmarks: marks,
        disabled: false,
        notice: "duplicate",
        onSave: () => {},
        onJump: () => {},
        onRemove: () => {},
      })
    );
    expect(markup).toContain(">Already saved<");
    expect(markup).toContain('fill="none"');
    expect(markup).not.toContain('fill="currentColor"');
  });

  it("disables the save control when playback cannot be marked", () => {
    const markup = html(
      createElement(PlayerBookmarks, {
        bookmarks: [],
        disabled: true,
        notice: null,
        onSave: () => {},
        onJump: () => {},
        onRemove: () => {},
      })
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Bookmarks"');
  });

  it("opens a list of timestamps and snippets with a remove control", () => {
    const markup = html(
      createElement(PlayerBookmarks, {
        bookmarks: marks,
        disabled: false,
        notice: null,
        defaultOpen: true,
        onSave: () => {},
        onJump: () => {},
        onRemove: () => {},
      })
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-testid="bookmark-list"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("1:05");
    expect(markup).toContain("The harbor was quiet");
    expect(markup).toContain("Part 2 · 0:12");
    expect(markup).toContain('aria-label="Remove bookmark at 1:05"');
    expect(markup).toContain('aria-label="Remove bookmark at Part 2 · 0:12"');
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
  });
});

describe("BookmarkList", () => {
  it("shows an empty state with no editor", () => {
    const markup = html(
      createElement(BookmarkList, {
        bookmarks: [],
        onJump: () => {},
        onRemove: () => {},
      })
    );
    expect(markup).toContain("No bookmarks");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
  });
});
