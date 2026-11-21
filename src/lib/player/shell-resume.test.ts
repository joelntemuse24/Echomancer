import { describe, expect, it } from "vitest";
import {
  saveShellResume,
  shellBookSeconds,
  shellPositionIsStorable,
  storedShellResume,
} from "./shell-resume";
import { readStoredResume } from "./playback-position";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    dump: () => Object.fromEntries(data),
  };
}

describe("shell resume clock", () => {
  it("puts an element clock on the book clock through the part offset", () => {
    expect(shellBookSeconds({ elementSeconds: 42, elementOffset: 0 })).toBe(42);
    // Part 3 of a book: 600s of earlier parts, 30s into this file.
    expect(shellBookSeconds({ elementSeconds: 30, elementOffset: 600 })).toBe(630);
    expect(shellBookSeconds({ elementSeconds: Number.NaN, elementOffset: 600 })).toBe(600);
  });

  it("refuses the 0 of a source that has only just been assigned", () => {
    expect(shellPositionIsStorable({ bookSeconds: 0, readyState: 4 })).toBe(false);
    expect(shellPositionIsStorable({ bookSeconds: 0.5, readyState: 4 })).toBe(false);
    expect(shellPositionIsStorable({ bookSeconds: 12, readyState: 0 })).toBe(false);
    expect(shellPositionIsStorable({ bookSeconds: 12, readyState: 1 })).toBe(true);
  });

  it("writes the same row shape the player page writes", () => {
    const store = memoryStore();
    const saved = saveShellResume(store, {
      jobId: "book-1",
      elementSeconds: 30,
      elementOffset: 600,
      readyState: 4,
      nowSeconds: 1_700_000_000.9,
    });
    expect(saved).toEqual({
      positionSeconds: 630,
      sectionIndex: null,
      updatedAt: 1_700_000_000,
    });
    // Readable by the same reader the page uses, so a reopen resumes here.
    expect(readStoredResume(store, "book-1")).toEqual(saved);
    expect(storedShellResume(store, "book-1")).toEqual(saved);
  });

  it("does not overwrite a real position with a load that has no clock", () => {
    const store = memoryStore();
    saveShellResume(store, {
      jobId: "book-1",
      elementSeconds: 120,
      elementOffset: 0,
      readyState: 4,
      nowSeconds: 1000,
    });
    const untouched = saveShellResume(store, {
      jobId: "book-1",
      elementSeconds: 0,
      elementOffset: 0,
      readyState: 0,
      nowSeconds: 2000,
    });
    expect(untouched).toBeNull();
    expect(readStoredResume(store, "book-1")?.positionSeconds).toBe(120);
  });

  it("moves updatedAt forward so a newer shell row wins over an older one", () => {
    const store = memoryStore();
    const first = saveShellResume(store, {
      jobId: "book-1",
      elementSeconds: 10,
      elementOffset: 0,
      readyState: 4,
      nowSeconds: 1000,
    });
    const second = saveShellResume(store, {
      jobId: "book-1",
      elementSeconds: 25,
      elementOffset: 0,
      readyState: 4,
      nowSeconds: 1005,
    });
    expect(second!.updatedAt).toBeGreaterThan(first!.updatedAt);
    expect(readStoredResume(store, "book-1")?.positionSeconds).toBe(25);
  });
});
