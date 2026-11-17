import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("header new book control", () => {
  it("keeps an accessible name and hides the words on a narrow screen", () => {
    const source = readFileSync("src/app/dashboard/chrome.tsx", "utf8");
    expect(source).toContain("aria-label={NAV.newBook}");
    expect(source).toContain("title={NAV.newBook}");
    expect(source).toContain('className="hidden sm:inline">{NAV.newBook}');
  });
});
