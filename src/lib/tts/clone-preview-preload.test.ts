import { describe, expect, it } from "vitest";
import {
  CLONE_PREVIEW_PRELOAD_CAP,
  clonePreviewPreloadMode,
  planClonePreviewPreload,
} from "@/lib/tts/clone-preview-preload";

const clip = (id: string) => ({
  id,
  previewUrl: `/api/tts/clone-preview/${id}`,
});

describe("clone preview preload", () => {
  it("preloads nothing on save-data or 2G", () => {
    expect(clonePreviewPreloadMode({ saveData: true, effectiveType: "4g" })).toEqual({
      list: "none",
      selected: "none",
    });
    expect(clonePreviewPreloadMode({ effectiveType: "2g" })).toEqual({
      list: "none",
      selected: "none",
    });
    expect(clonePreviewPreloadMode({ effectiveType: "slow-2g" })).toEqual({
      list: "none",
      selected: "none",
    });
  });

  it("stays at metadata unless the link is 4G", () => {
    expect(clonePreviewPreloadMode(null)).toEqual({
      list: "metadata",
      selected: "metadata",
    });
    expect(clonePreviewPreloadMode({ effectiveType: "3g" })).toEqual({
      list: "metadata",
      selected: "metadata",
    });
    expect(clonePreviewPreloadMode({ effectiveType: "4g" })).toEqual({
      list: "metadata",
      selected: "auto",
    });
  });

  it("preloads the selected clip first and caps the visible list", () => {
    const voices = Array.from({ length: 12 }, (_, index) => clip(`clone:${index}`));
    voices.push({ id: "drew", previewUrl: "/voice-previews/drew.mp3" });
    const plan = planClonePreviewPreload({
      voices,
      selectedId: "clone:10",
      mode: { list: "metadata", selected: "auto" },
    });
    expect(plan).toHaveLength(CLONE_PREVIEW_PRELOAD_CAP);
    expect(plan[0]).toEqual({ url: "/api/tts/clone-preview/clone:10", preload: "auto" });
    expect(plan.slice(1).every((item) => item.preload === "metadata")).toBe(true);
    expect(plan.some((item) => item.url.includes("drew"))).toBe(false);
  });

  it("skips the list when the network cannot spare the bytes", () => {
    expect(
      planClonePreviewPreload({
        voices: [clip("clone:1")],
        selectedId: "clone:1",
        mode: { list: "none", selected: "none" },
      })
    ).toEqual([]);
  });
});
