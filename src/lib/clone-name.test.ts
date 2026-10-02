import { describe, expect, it } from "vitest";
import { cloneNameFromSource, cloneNameOrFallback } from "@/lib/clone-name";

describe("cloneNameFromSource", () => {
  it("keeps a speaker's name at the start of a video title", () => {
    expect(cloneNameFromSource("Henry Kissinger announces the end of the war")).toBe(
      "Henry Kissinger"
    );
    expect(cloneNameFromSource("Allan Bloom lecture")).toBe("Allan Bloom");
  });

  it("uses a cleaned file name and refuses a generic placeholder", () => {
    expect(cloneNameFromSource("kissinger-speech.wav")).toBe("kissinger speech");
    expect(cloneNameFromSource("YouTube clip")).toBe("");
    expect(cloneNameFromSource("Youtube Clip")).toBe("");
    expect(cloneNameOrFallback("YouTube clip")).toBe("Voice");
    expect(cloneNameOrFallback("notes.mp3")).toBe("notes");
  });

  it("keeps a title that is not a personal name", () => {
    expect(cloneNameFromSource("UPITN 13 6 73 END OF LECTURE")).toBe(
      "UPITN 13 6 73 END OF LECTURE"
    );
  });
});
