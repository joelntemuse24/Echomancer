import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV } from "@/lib/ux-copy";
import { showHeaderNewBook } from "@/lib/nav/routes";

/**
 * The header plus is an icon with an accessible name, not "plus + words".
 * The home page is the upload page, so it does not repeat the control.
 */
describe("header new book control", () => {
  const source = readFileSync("src/app/dashboard/chrome.tsx", "utf8");

  it("keeps an accessible name on an icon-only control", () => {
    expect(source).toContain("aria-label={NAV.newBook}");
    expect(source).toContain("title={NAV.newBook}");
    expect(NAV.newBook).toBe("New book");
  });

  it("does not render a visible label beside the plus", () => {
    // The old control appended the words on a wide screen.
    expect(source).not.toContain('className="hidden sm:inline">{NAV.newBook}');
    expect(source).not.toContain("{NAV.newBook}</span>");
  });

  it("hides the plus where the page already uploads a book", () => {
    expect(source).toContain("showHeaderNewBook(pathname)");
    expect(showHeaderNewBook("/")).toBe(false);
    expect(showHeaderNewBook("/dashboard/queue")).toBe(true);
    expect(showHeaderNewBook("/dashboard/voice")).toBe(true);
    expect(showHeaderNewBook("/dashboard/player/abc")).toBe(true);
    expect(showHeaderNewBook(null)).toBe(false);
  });

  it("leaves exactly one new-book affordance on the home page", () => {
    // Home's own composer is the upload control; nothing else names a new book.
    const landing = readFileSync("src/components/landing-page.tsx", "utf8");
    expect(landing).not.toContain("NAV.newBook");
    expect(landing).not.toContain("New audiobook");
  });
});
