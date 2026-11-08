/**
 * The production failure mode, simulated with the same selectors the tick uses.
 *
 * Book shape from the 2026-11-08 VDH run: 293 sections, batch 24, publish
 * window 8. The logged wave was ~86s of GPU, then ~22s to master 8 sections,
 * then ~12s before the next wave. Those times are inputs to this model, not
 * a measurement of the patched worker.
 *
 * Old tick: render the first 24 claimable indexes (including ones already
 * staged) and only then master the first 8. New tick: render up to 24 that
 * are not cached, and master the already-staged prefix while that render is
 * in flight. A tick that starts with nothing staged still masters 8 of the
 * takes it just received, after the GPU returns.
 */

import { describe, expect, it } from "vitest";
import {
  selectClonePublishBatch,
  selectCloneRenderIndexes,
} from "@/lib/tts/providers/modal-clone-prefetch";

const GPU_MS = 86_000;
const MASTER_MS = 22_000;
const GAP_MS = 12_000;
const BATCH = 24;
const PUBLISH = 8;
const SECTIONS = 293;

function claimable(ready: ReadonlySet<number>, total: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!ready.has(i)) out.push(i);
  return out;
}

function simulate(strategy: "old" | "new") {
  const ready = new Set<number>();
  const cache = new Set<number>();
  let renders = 0;
  let repeats = 0;
  let ticks = 0;
  let wallMs = 0;
  let maxReady = -1;
  let orderHeld = true;

  while (ready.size < SECTIONS && ticks < 500) {
    ticks += 1;
    const pending = claimable(ready, SECTIONS);
    const isCached = (index: number) => cache.has(index);
    let tickWall = 0;

    if (strategy === "old") {
      const window = pending.slice(0, BATCH);
      if (window.length > 0) tickWall += GPU_MS;
      for (const index of window) {
        renders += 1;
        if (cache.has(index)) repeats += 1;
        cache.add(index);
      }
      const claimed = pending.slice(0, PUBLISH);
      if (claimed.length > 0) tickWall += MASTER_MS;
      for (const index of claimed) ready.add(index);
    } else {
      const { render } = selectCloneRenderIndexes(pending, isCached, BATCH);
      for (const index of render) {
        renders += 1;
        if (cache.has(index)) repeats += 1;
      }
      const blocked = new Set(render);
      let gpuLeft = render.length > 0 ? GPU_MS : 0;
      let publishedFromCache = 0;
      const attempted = new Set<number>();
      while (true) {
        const batch = selectClonePublishBatch(
          pending.filter((index) => !ready.has(index) && !attempted.has(index)),
          isCached,
          blocked,
          PUBLISH
        );
        if (batch.length === 0) {
          if (gpuLeft > 0) {
            tickWall += gpuLeft;
            gpuLeft = 0;
            for (const index of render) cache.add(index);
            blocked.clear();
          }
          break;
        }
        const master = MASTER_MS;
        if (gpuLeft > 0) {
          const used = Math.min(gpuLeft, master);
          tickWall += master;
          gpuLeft -= used;
        } else {
          tickWall += master;
        }
        for (const index of batch) {
          attempted.add(index);
          ready.add(index);
        }
        publishedFromCache += batch.length;
      }
      if (publishedFromCache === 0) {
        const fresh = selectClonePublishBatch(
          pending.filter((index) => !ready.has(index)),
          (index) => cache.has(index),
          new Set(),
          PUBLISH
        );
        if (fresh.length > 0) tickWall += MASTER_MS;
        for (const index of fresh) ready.add(index);
      }
    }

    tickWall += GAP_MS;
    wallMs += tickWall;
    const readyNow = [...ready].sort((a, b) => a - b);
    for (let i = 0; i < readyNow.length; i++) {
      if (readyNow[i] !== i) orderHeld = false;
      maxReady = Math.max(maxReady, readyNow[i]!);
    }
  }

  return { ticks, renders, repeats, wallMs, ready: ready.size, orderHeld, maxReady };
}

describe("clone prefetch selectors", () => {
  it("does not render a cached index, and does not publish past a hole", () => {
    const cached = new Set([0, 1, 2, 4, 8]);
    const pending = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const selected = selectCloneRenderIndexes(pending, (index) => cached.has(index), 4);
    expect(selected).toEqual({ render: [3, 5, 6, 7], skippedCached: 4 });
    expect(
      selectClonePublishBatch(pending, (index) => cached.has(index), new Set([3]), 8)
    ).toEqual([0, 1, 2]);
    expect(
      selectClonePublishBatch(pending, (index) => cached.has(index), new Set(), 2)
    ).toEqual([0, 1]);
  });

  it("keeps a retry-sized hole renderable when neighbours are cached", () => {
    const cached = new Set([0, 1, 3]);
    const selected = selectCloneRenderIndexes([0, 1, 2, 3], (index) => cached.has(index), 24);
    expect(selected.render).toEqual([2]);
    expect(selected.skippedCached).toBe(3);
  });
});

describe("simulated 293-section clone book", () => {
  const before = simulate("old");
  const after = simulate("new");

  it("renders each section once and keeps playback order", () => {
    expect(before.ready).toBe(SECTIONS);
    expect(after.ready).toBe(SECTIONS);
    expect(before.orderHeld).toBe(true);
    expect(after.orderHeld).toBe(true);
    expect(before.repeats).toBeGreaterThan(0);
    expect(after.repeats).toBe(0);
    expect(after.renders).toBe(SECTIONS);
    expect(before.renders).toBeGreaterThan(after.renders);
  });

  it("is faster on the logged wave shape without raising the publish window", () => {
    expect(after.wallMs).toBeLessThan(before.wallMs);
    expect(after.ticks).toBeLessThan(before.ticks);
    // Locked so a selector change that reintroduces repeat renders or drops
    // the overlap shows up as a number, not a vague "faster".
    expect(before).toMatchObject({
      ticks: 37,
      renders: 855,
      repeats: 562,
      wallMs: 4_440_000,
    });
    expect(after).toMatchObject({ ticks: 14, renders: 293, repeats: 0, wallMs: 1_330_000 });
  });
});
