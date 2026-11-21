import { describe, expect, it } from "vitest";
import {
  classifyClonePreviewRead,
  clonePreparingAfterTokenCheck,
  clonePreviewButtonState,
  clonePreviewShowsPreparing,
  clonePreviewUiAfterRead,
  clonePreviewUiOnPlay,
  PREVIEW_PREPARING_LABEL,
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
    expect(classifyClonePreviewRead(409, "PREVIEW_BAKE_FAILED")).toBe("failed");
  });
});

describe("preview preparing label", () => {
  it("is visible text, not only a spinner name", () => {
    expect(PREVIEW_PREPARING_LABEL).toBe("Preparing preview…");
    expect(PREVIEW_PREPARING_LABEL.length).toBeGreaterThan("Play".length);
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
    expect(previewControl({ preparing: false, playing: false, failed: true })).toBe("retry");
    expect(
      previewControlLabel({ preparing: false, playing: false, failed: true, name: "Voice" })
    ).toBe("Try Voice again");
    expect(previewControlLabel({ preparing: false, playing: false, name: "Voice" })).toBe(
      "Play Voice"
    );
  });
});

describe("stored preview versus a bake", () => {
  it("never sets Preparing for a stored clip, and does after a 202", () => {
    const voiceId = "clone:abc";
    const opening = clonePreviewUiOnPlay(voiceId);
    expect(opening.preparingId).toBeNull();
    expect(opening.loadingId).toBe(voiceId);

    const stored = clonePreviewUiAfterRead(voiceId, "audio");
    expect(stored.preparingId).toBeNull();
    const storedButton = clonePreviewButtonState({
      preparing: stored.preparingId === voiceId,
      loading: stored.loadingId === voiceId,
      playing: false,
    });
    expect(storedButton).toBe("loading");
    expect(clonePreviewShowsPreparing(storedButton)).toBe(false);

    const baking = clonePreviewUiAfterRead(voiceId, "preparing");
    expect(baking.preparingId).toBe(voiceId);
    const bakingButton = clonePreviewButtonState({
      preparing: baking.preparingId === voiceId,
      loading: baking.loadingId === voiceId,
      playing: false,
    });
    expect(bakingButton).toBe("preparing");
    expect(clonePreviewShowsPreparing(bakingButton)).toBe(true);

    const failed = clonePreviewUiAfterRead(voiceId, "failed");
    expect(failed.preparingId).toBeNull();
    expect(failed.failedId).toBe(voiceId);
    expect(
      clonePreviewButtonState({
        preparing: false,
        loading: false,
        playing: false,
        failed: true,
      })
    ).toBe("failed");
  });
});

describe("clonePreparingAfterTokenCheck", () => {
  it("clears Preparing when the token check fails for the attempt that owns it", () => {
    expect(
      clonePreparingAfterTokenCheck({
        preparingId: "clone:abc",
        voiceId: "clone:abc",
        requestToken: 1,
        activeToken: 2,
        ownerToken: 1,
        show: true,
      })
    ).toEqual({ preparingId: null, ownerToken: 0 });
  });

  it("does not put Preparing back after Stop moved the token", () => {
    expect(
      clonePreparingAfterTokenCheck({
        preparingId: null,
        voiceId: "clone:abc",
        requestToken: 1,
        activeToken: 2,
        ownerToken: 0,
        show: true,
      })
    ).toEqual({ preparingId: null, ownerToken: 0 });
  });

  it("leaves a newer attempt's Preparing in place", () => {
    expect(
      clonePreparingAfterTokenCheck({
        preparingId: "clone:abc",
        voiceId: "clone:abc",
        requestToken: 1,
        activeToken: 2,
        ownerToken: 2,
        show: false,
      })
    ).toEqual({ preparingId: "clone:abc", ownerToken: 2 });
  });

  it("shows Preparing while this attempt still holds the token", () => {
    expect(
      clonePreparingAfterTokenCheck({
        preparingId: null,
        voiceId: "clone:abc",
        requestToken: 4,
        activeToken: 4,
        ownerToken: 0,
        show: true,
      })
    ).toEqual({ preparingId: "clone:abc", ownerToken: 4 });
  });
});
