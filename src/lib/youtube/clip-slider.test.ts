import { describe, expect, it } from "vitest";
import { formatClock, MAX_CLIP_SEC, MIN_CLIP_SEC } from "./range";
import {
  CLIP_HIT_PX,
  CLIP_PX_PER_SEC,
  applyClipDrag,
  clipEdgePanPx,
  clipPxToTime,
  clipRequestWindow,
  clipScale,
  clipTimeToPx,
  hitClipSlider,
  moveClipWindow,
  normalizeClipSpan,
  placeClipWindow,
  resizeClipEdge,
} from "./clip-slider";

describe("clip window geometry", () => {
  it("keeps a 10s clip wider than a thumb, even on a two-hour video", () => {
    const scale = clipScale(7200, 390);
    expect(scale.pxPerSec).toBe(CLIP_PX_PER_SEC);
    const gap = clipTimeToPx(10, scale.pxPerSec, scale.pad) - clipTimeToPx(0, scale.pxPerSec, scale.pad);
    expect(gap).toBeGreaterThanOrEqual(CLIP_HIT_PX);
    expect(gap).toBe(MIN_CLIP_SEC * CLIP_PX_PER_SEC);
  });

  it("spreads a short video across the row without stacking the handles", () => {
    const scale = clipScale(30, 390);
    expect(scale.pxPerSec).toBeGreaterThan(CLIP_PX_PER_SEC);
    expect(scale.width).toBe(390);
    const gap = 10 * scale.pxPerSec;
    expect(gap).toBeGreaterThanOrEqual(CLIP_HIT_PX);
  });

  it("hits the nearer handle, and a stacked pair moves the window", () => {
    const span = { startSec: 45, endSec: 65 };
    const startX = clipTimeToPx(45);
    const endX = clipTimeToPx(65);
    expect(endX - startX).toBeGreaterThanOrEqual(CLIP_HIT_PX);
    expect(hitClipSlider(startX, span)).toBe("start");
    expect(hitClipSlider(endX, span)).toBe("end");
    expect(hitClipSlider((startX + endX) / 2, span)).toBe("window");
    expect(hitClipSlider(startX - CLIP_HIT_PX, span)).toBe("track");

    // 20s of a 2h video on a 340px full-length track is under a pixel.
    // The later thumb used to sit on top and take every press.
    const stackedPx = 0.05;
    const pad = 22;
    const mid = clipTimeToPx(55, stackedPx, pad);
    expect(clipTimeToPx(65, stackedPx, pad) - clipTimeToPx(45, stackedPx, pad)).toBeLessThan(2);
    expect(hitClipSlider(mid, span, stackedPx, pad)).toBe("window");
    expect(hitClipSlider(clipTimeToPx(45, stackedPx, pad), span, stackedPx, pad)).toBe("window");
  });
});

describe("clip window drags", () => {
  it("stops the start edge at 10 seconds instead of pushing the end", () => {
    const origin = { startSec: 100, endSec: 120 };
    const next = applyClipDrag({ hit: "start", origin, deltaSec: 50, durationSec: 600 });
    expect(next).toEqual({ startSec: 110, endSec: 120 });
    expect(next.endSec - next.startSec).toBe(MIN_CLIP_SEC);
  });

  it("stops the end edge at 40 seconds instead of pulling the start", () => {
    const origin = { startSec: 100, endSec: 120 };
    const next = applyClipDrag({ hit: "end", origin, deltaSec: 80, durationSec: 600 });
    expect(next).toEqual({ startSec: 100, endSec: 140 });
    expect(next.endSec - next.startSec).toBe(MAX_CLIP_SEC);
    const held = applyClipDrag({ hit: "end", origin: next, deltaSec: 30, durationSec: 600 });
    expect(held).toEqual(next);
  });

  it("does not swap edges when a drag jumps past the other handle", () => {
    const origin = { startSec: 100, endSec: 110 };
    const next = applyClipDrag({ hit: "start", origin, deltaSec: 80, durationSec: 600 });
    expect(next.endSec).toBe(110);
    expect(next.startSec).toBe(100);
    expect(next.endSec).toBeGreaterThan(next.startSec);
  });

  it("moves the window without changing its length", () => {
    const origin = { startSec: 45, endSec: 65 };
    expect(moveClipWindow(origin, 15, 7200)).toEqual({ startSec: 60, endSec: 80 });
    expect(moveClipWindow(origin, -100, 7200)).toEqual({ startSec: 0, endSec: 20 });
    expect(moveClipWindow({ startSec: 7160, endSec: 7200 }, 80, 7200)).toEqual({
      startSec: 7160,
      endSec: 7200,
    });
  });

  it("places a tap on empty timeline and stays inside the video", () => {
    expect(placeClipWindow(1000, 20, 7200)).toEqual({ startSec: 990, endSec: 1010 });
    expect(placeClipWindow(2, 20, 7200)).toEqual({ startSec: 0, endSec: 20 });
    expect(placeClipWindow(7190, 20, 7200)).toEqual({ startSec: 7180, endSec: 7200 });
  });

  it("pans only while the pointer is in the edge zone", () => {
    expect(clipEdgePanPx(200, 0, 400, 16)).toBe(0);
    expect(clipEdgePanPx(4, 0, 400, 16)).toBeLessThan(0);
    expect(clipEdgePanPx(396, 0, 400, 16)).toBeGreaterThan(0);
    expect(Math.abs(clipEdgePanPx(396, 0, 400, 16))).toBeGreaterThan(
      Math.abs(clipEdgePanPx(370, 0, 400, 16))
    );
  });
});

describe("clip request window", () => {
  it("posts the labelled whole seconds and does not run past the video", () => {
    // A half-second nudge used to round the length up: 580.5 + 20 = 600.5,
    // and the API rejected that as past a 600s video.
    expect(580.5 + Math.round(600 - 580.5)).toBeGreaterThan(600 + 0.05);
    const posted = clipRequestWindow(580.5, 600, 600);
    expect(posted).toEqual({ startSeconds: 581, lengthSeconds: 19 });
    expect(posted!.startSeconds + posted!.lengthSeconds).toBeLessThanOrEqual(600 + 0.05);
    expect(formatClock(posted!.startSeconds)).toBe("9:41");
    expect(formatClock(posted!.startSeconds + posted!.lengthSeconds)).toBe("10:00");

    const fractional = clipRequestWindow(3703.4, 3723.2, 3723.2);
    expect(fractional).not.toBeNull();
    expect(fractional!.startSeconds + fractional!.lengthSeconds).toBeLessThanOrEqual(3723.2 + 0.05);
    expect(fractional!.lengthSeconds).toBeGreaterThanOrEqual(MIN_CLIP_SEC);
    expect(fractional!.lengthSeconds).toBeLessThanOrEqual(MAX_CLIP_SEC);
  });

  it("matches normalize for the default lecture window", () => {
    expect(normalizeClipSpan(45, 65, 7200)).toEqual({ startSec: 45, endSec: 65 });
    expect(clipRequestWindow(45, 65, 7200)).toEqual({ startSeconds: 45, lengthSeconds: 20 });
    expect(normalizeClipSpan(0, 20, 8)).toBeNull();
  });

  it("rounds a drag back onto the same seconds the timeline uses", () => {
    const origin = { startSec: 45, endSec: 65 };
    const pxPerSec = CLIP_PX_PER_SEC;
    const deltaSec = clipPxToTime(clipTimeToPx(0) + 8 * 3, pxPerSec) - clipPxToTime(clipTimeToPx(0), pxPerSec);
    const next = resizeClipEdge(origin, "start", origin.startSec + deltaSec, 7200);
    expect(next).toEqual({ startSec: 48, endSec: 65 });
    expect(clipRequestWindow(next.startSec, next.endSec, 7200)).toEqual({
      startSeconds: 48,
      lengthSeconds: 17,
    });
  });
});
