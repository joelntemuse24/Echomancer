import { describe, expect, it } from "vitest";
import {
  applyAsrSnap,
  asrWindow,
  segmentsFromWhisperJson,
  snapToSpokenHeading,
} from "./asr-snap";

describe("snapToSpokenHeading", () => {
  it("moves the mark to the spoken heading inside the window", () => {
    const window = asrWindow(100, 500);
    expect(window).toEqual({ start: 75, end: 115 });
    const segments = segmentsFromWhisperJson({
      segments: [
        { start: 2, end: 6, text: " the colonies held" },
        { start: 8.5, end: 12, text: " Part Three a general" },
      ],
    });
    expect(snapToSpokenHeading(segments, "Part Three", window.start)).toBe(75 + 8.5);
  });

  it("keeps the estimate when the window does not contain the heading", async () => {
    const chapters = await applyAsrSnap(
      [{ index: 0, title: "Part Six", startFraction: 0.5, startSeconds: 400, endSeconds: 500 }],
      1000,
      async () => [{ start: 1, end: 3, text: "nothing like the title" }]
    );
    expect(chapters[0]?.startSeconds).toBe(400);
  });
});
