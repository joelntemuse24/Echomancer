import { describe, expect, it } from "vitest";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";
import { cloneUploadLead, youtubeClipNotice } from "./clone-upload-copy";

const OUTAGE = "YouTube clips aren't available";

describe("clone upload copy", () => {
  it("does not lead the upload with the YouTube outage", () => {
    expect(cloneUploadLead(false).startsWith(OUTAGE)).toBe(false);
    expect(cloneUploadLead(true).startsWith(OUTAGE)).toBe(false);
    expect(cloneUploadLead(true)).toContain("Name this voice");
    expect(cloneUploadLead(false)).toBe(YOUTUBE_COPY.sampleGuide);
  });

  it("shows the outage only when clips are unavailable and no file is chosen", () => {
    expect(youtubeClipNotice({ fileSelected: true, clipsEnabled: false })).toBeNull();
    expect(youtubeClipNotice({ fileSelected: false, clipsEnabled: true })).toBeNull();
    expect(youtubeClipNotice({ fileSelected: false, clipsEnabled: false })).toBe(
      YOUTUBE_COPY.clippingUnavailable
    );
  });
});
