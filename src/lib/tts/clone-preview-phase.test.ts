import { describe, expect, it } from "vitest";
import {
  classifyClonePreviewRead,
  previewControl,
  previewControlLabel,
} from "./clone-preview-phase";

describe("classifyClonePreviewRead", () => {
  it("treats 202 PREVIEW_PREPARING as preparing, not playback", () => {
    expect(classifyClonePreviewRead(202, "PREVIEW_PREPARING")).toBe("preparing");
    expect(classifyClonePreviewRead(202, null)).toBe("preparing");
    expect(classifyClonePreviewRead(200, "PREVIEW_PREPARING")).toBe("preparing");
  });

  it("treats a stored clip as audio and any other error as failure", () => {
    expect(classifyClonePreviewRead(200, null)).toBe("audio");
    expect(classifyClonePreviewRead(500, "PREVIEW_FAILED")).toBe("failed");
    expect(classifyClonePreviewRead(404, "PREVIEW_NOT_STORED")).toBe("failed");
  });
});

describe("previewControl", () => {
  it("shows Preparing while a clip is baking, Stop only while it is playing, and Play after failure", () => {
    expect(previewControl({ preparing: true, playing: true })).toBe("preparing");
    expect(previewControlLabel({ preparing: true, playing: false, name: "Voice" })).toBe(
      "Preparing Voice"
    );
    expect(previewControlLabel({ preparing: false, playing: true, name: "Voice" })).toBe(
      "Stop Voice"
    );
    expect(previewControl({ preparing: false, playing: false })).toBe("play");
    expect(previewControlLabel({ preparing: false, playing: false, name: "Voice" })).toBe(
      "Play Voice"
    );
  });
});
