import { describe, expect, it } from "vitest";
import { libraryStatus, kindLabel, UX } from "./ux-copy";

describe("ux-copy", () => {
  it("maps jobs to library mental-model statuses", () => {
    expect(libraryStatus({ status: "ready" }).label).toBe(UX.ready);
    expect(libraryStatus({ status: "failed" }).label).toBe(UX.failed);
    expect(libraryStatus({ status: "queued" }).label).toBe(UX.starting);
    expect(
      libraryStatus({
        status: "processing",
        segments: [{ status: "ready" }],
      }).label
    ).toBe(UX.readyToPlay);
    expect(
      libraryStatus({ status: "ready", job_kind: "stream" }).label
    ).toBe(UX.ready);
    expect(
      libraryStatus({ status: "queued", job_kind: "stream" }).label
    ).toBe(UX.listening);
  });

  it("labels job kinds for customers", () => {
    expect(kindLabel("stream")).toBe("Chapter preview");
    expect(kindLabel("takehome")).toBe(UX.savedBook);
  });
});
