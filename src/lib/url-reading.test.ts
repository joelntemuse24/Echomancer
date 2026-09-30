import { describe, expect, it } from "vitest";
import {
  findFullTextLink,
  isFrontendChrome,
  prepareFetchedBook,
} from "@/lib/url-reading";

const CATALOG = `<html><body>
  <a href="/help/reading_options.html">Reading guide</a>
  <a href="/ebooks/1342.epub3.images">EPUB3</a>
  <a href="/cache/epub/1342/pg1342-images.html">Read online now</a>
  <a href="/ebooks/1342.txt.utf-8">Plain Text</a>
  <p>Pride and Prejudice is a novel about Elizabeth Bennet and Mr. Darcy, long enough to look like a blurb but not the book itself.</p>
</body></html>`;

describe("findFullTextLink", () => {
  it("prefers the plain-text book over the catalog, epub, and help pages", () => {
    const link = findFullTextLink(
      CATALOG,
      new URL("https://www.gutenberg.org/ebooks/1342")
    );
    expect(link?.href).toBe("https://www.gutenberg.org/ebooks/1342.txt.utf-8");
  });

  it("ignores a plain-text file on another site", () => {
    const html = `<a href="https://evil.example/book.txt">Plain Text</a>`;
    expect(
      findFullTextLink(html, new URL("https://www.gutenberg.org/ebooks/1342"))
    ).toBeNull();
  });
});

describe("isFrontendChrome", () => {
  it("rejects a navigation wall and a source dump", () => {
    const nav = [
      "Log in",
      "Sign up",
      "My Books",
      "Subjects",
      "Trending",
      "Library Explorer",
      "Please verify you are human to continue.",
      "Verification failed. Please try again.",
    ].join("\n");
    expect(isFrontendChrome(nav)).toBe(true);
    const code = [
      "function boot(app) { return app.start(); }",
      "const state = { open: true };",
      "import router from './router';",
      "export default function Page() { return null }",
    ].join("\n");
    expect(isFrontendChrome(code)).toBe(true);
  });

  it("keeps a paragraph of prose", () => {
    const prose =
      "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.";
    expect(isFrontendChrome(prose)).toBe(false);
  });
});

describe("prepareFetchedBook", () => {
  it("drops the Project Gutenberg license and keeps the title", () => {
    const raw = `The Project Gutenberg eBook of Pride and Prejudice

*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***

It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.

*** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***

The license goes on for pages.`;
    const book = prepareFetchedBook(raw, null);
    expect(book.title).toBe("Pride And Prejudice");
    expect(book.text).toContain("truth universally acknowledged");
    expect(book.text).not.toContain("Project Gutenberg");
    expect(book.text).not.toContain("license goes on");
  });
});
