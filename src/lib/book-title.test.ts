import { describe, expect, it } from "vitest";
import {
  bookTitleFromFileName,
  bookTitleHeadingClass,
  looksLikeFileName,
  normalizeStoredBookTitle,
  titleForDownload,
  UNTITLED_BOOK_TITLE,
} from "@/lib/book-title";

describe("bookTitleFromFileName", () => {
  it("turns underscores into spaces and drops the extension", () => {
    expect(bookTitleFromFileName("the_hobbit.pdf")).toBe("The Hobbit");
    expect(bookTitleFromFileName("My_Great_Book.epub")).toBe("My Great Book");
    expect(bookTitleFromFileName("draft__two__final.docx")).toBe(
      "Draft Two Final"
    );
  });

  it("turns a slug's dashes into spaces but keeps a real hyphen", () => {
    expect(bookTitleFromFileName("the-hobbit.pdf")).toBe("The Hobbit");
    expect(bookTitleFromFileName("Spider-Man_Comics.pdf")).toBe(
      "Spider-Man Comics"
    );
    expect(bookTitleFromFileName("Catch-22.pdf")).toBe("Catch-22");
  });

  it("keeps a dash between title and author as a separator", () => {
    expect(bookTitleFromFileName("the_hobbit - tolkien.pdf")).toBe(
      "The Hobbit - Tolkien"
    );
    expect(bookTitleFromFileName("moby_dick--melville.txt")).toBe(
      "Moby Dick - Melville"
    );
  });

  it("title-cases a shouted or lowercase file name, Roman numerals kept", () => {
    expect(bookTitleFromFileName("PRIDE_AND_PREJUDICE.epub")).toBe(
      "Pride and Prejudice"
    );
    expect(bookTitleFromFileName("CHAPTER_II.pdf")).toBe("Chapter II");
    expect(bookTitleFromFileName("the_lord_of_the_rings.epub")).toBe(
      "The Lord of the Rings"
    );
  });

  it("leaves a name that already reads like a title alone", () => {
    expect(bookTitleFromFileName("Quay notes")).toBe("Quay notes");
    expect(bookTitleFromFileName("A Study in Scarlet")).toBe(
      "A Study in Scarlet"
    );
    expect(bookTitleFromFileName("UPITN 13 6 73 END OF LECTURE")).toBe(
      "UPITN 13 6 73 END OF LECTURE"
    );
    expect(bookTitleFromFileName("NASA History")).toBe("NASA History");
  });

  it("keeps a title that is only one capitalised word", () => {
    expect(bookTitleFromFileName("Ulysses.pdf")).toBe("Ulysses");
    expect(bookTitleFromFileName("ulysses.pdf")).toBe("Ulysses");
  });

  it("takes only the last segment of a path", () => {
    expect(
      bookTitleFromFileName("C:/Users/me/Downloads/silent_spring.pdf")
    ).toBe("Silent Spring");
  });

  it("keeps an author's initials and a trailing mark", () => {
    expect(bookTitleFromFileName("the_hobbit_j.r.r._tolkien.pdf")).toBe(
      "The Hobbit J.R.R. Tolkien"
    );
    expect(bookTitleFromFileName("notes_draft_.pdf")).toBe("Notes Draft");
    // A shouted source proves the initialism; a lowercase slug cannot.
    expect(bookTitleFromFileName("THE_FBI_STORY.pdf")).toBe("The FBI Story");
  });

  it("does not turn an ordinary short word into letters", () => {
    expect(bookTitleFromFileName("my_book.pdf")).toBe("My Book");
    expect(bookTitleFromFileName("it_was_a_dark_night.pdf")).toBe(
      "It Was a Dark Night"
    );
  });

  it("falls back to Untitled when there are no readable words", () => {
    expect(bookTitleFromFileName("")).toBe(UNTITLED_BOOK_TITLE);
    expect(bookTitleFromFileName("   ")).toBe(UNTITLED_BOOK_TITLE);
    expect(bookTitleFromFileName(null)).toBe(UNTITLED_BOOK_TITLE);
    expect(bookTitleFromFileName("___.pdf")).toBe(UNTITLED_BOOK_TITLE);
    expect(bookTitleFromFileName("- - -.pdf")).toBe(UNTITLED_BOOK_TITLE);
  });

  it("caps a very long name on a word boundary", () => {
    const long = `${"word ".repeat(80)}end.pdf`;
    const title = bookTitleFromFileName(long);
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.split(" ").every((word) => /^[A-Za-z]+$/.test(word))).toBe(
      true
    );
  });

  it("is idempotent", () => {
    for (const name of [
      "the_hobbit.pdf",
      "PRIDE_AND_PREJUDICE.epub",
      "Spider-Man_Comics.pdf",
      "Quay notes",
      "___.pdf",
    ]) {
      const once = bookTitleFromFileName(name);
      expect(bookTitleFromFileName(once)).toBe(once);
    }
  });
});

describe("looksLikeFileName", () => {
  it("only reports a name that still carries a document extension", () => {
    expect(looksLikeFileName("book.pdf")).toBe(true);
    expect(looksLikeFileName("Quay notes")).toBe(false);
    expect(looksLikeFileName("Chapter 1. The Storm")).toBe(false);
    expect(looksLikeFileName("")).toBe(false);
  });
});

describe("normalizeStoredBookTitle", () => {
  it("repairs a stored file name and leaves a typed title exactly as written", () => {
    expect(normalizeStoredBookTitle("my_book.pdf")).toBe("My Book");
    expect(normalizeStoredBookTitle("my_book")).toBe("My Book");
    expect(normalizeStoredBookTitle("my book")).toBe("my book");
    expect(normalizeStoredBookTitle("  Quay   notes ")).toBe("Quay notes");
    expect(normalizeStoredBookTitle("")).toBe("");
  });

  it("leaves a hyphenated title alone, because a person types those too", () => {
    expect(normalizeStoredBookTitle("Catch-22")).toBe("Catch-22");
    expect(normalizeStoredBookTitle("Spider-Man")).toBe("Spider-Man");
  });
});

describe("titleForDownload", () => {
  it("drops an untitled book to nothing so the caller's fallback applies", () => {
    expect(titleForDownload("___.pdf")).toBe("");
    expect(titleForDownload("")).toBe("");
    expect(titleForDownload("the_hobbit_-_tolkien.pdf")).toBe(
      "The Hobbit - Tolkien"
    );
  });
});

describe("bookTitleHeadingClass", () => {
  it("steps the size down as the title gets longer", () => {
    expect(bookTitleHeadingClass("Emma")).toContain("text-4xl");
    expect(bookTitleHeadingClass("A".repeat(60))).toContain("text-3xl");
    expect(bookTitleHeadingClass("A".repeat(120))).toContain("text-2xl");
  });
});
