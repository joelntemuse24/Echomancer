/**
 * The 2026-11-06 production regression, `job 7e4a8b48`.
 *
 * The shape: a 5-section clone book, section 0 at 797 characters, sections 1–4
 * at ~7.7k each (~31k total). #241's planner first-fit all four big sections
 * into **one** `synthesize_batch` call because the cap it packed against was
 * 60s × 2,900 chars/s × 0.5 = **87,000** characters. The call started at once
 * on a warm H100, ran 4m03s, and never finished. The worker cut it at
 * `MODAL_S2_COLD_WAIT_MS=150000`, called it a cold placement, resent the same
 * oversized pack on another container, and parked the book.
 *
 * Two things were wrong and both are pinned here:
 *
 * 1. **The rate.** 2.9x realtime is audio-seconds per wall-second, ~43 chars/s,
 *    not 2,900. Every lane must be planned against the wait it can actually be
 *    granted at a rate the hardware really reaches.
 * 2. **The retry shape.** A pack that did not fit is not retried as the same
 *    pack, and a timeout on a pool that demonstrably answered is not a restore.
 *
 * These are pure planning and dispatch decisions, so no GPU is involved.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetModalCloneGuardForTests } from "@/lib/tts/providers/modal-clone-guard";
import {
  MODAL_LANE_CHARS_PER_SECOND,
  MODAL_LANE_RESTORE_MARGIN_MS,
  MODAL_LANE_ROW_CHARS_PER_SECOND,
  modalCloneLaneGenerateBudgetMs,
  cloneCallWallMs,
  modalCloneSectionChars,
  modalLaneCharCap,
  planModalCloneLanes,
} from "@/lib/tts/providers/modal-clone-lanes";
import { dispatchModalCloneLanes } from "@/lib/tts/providers/modal-clone-dispatch";
import { ModalCloneColdError, type CloneBatchOutcome } from "@/lib/tts/providers/modal-clone";
import * as modalCloneWarm from "@/lib/tts/providers/modal-clone-warm";

/** The real book's shapes, in characters. */
const BOOK = {
  section0: 797,
  bigSection: 7_700,
  sections: [797, 7_700, 7_700, 7_700, 7_700],
};

function outcome(keys: string[], containerId = "c1"): CloneBatchOutcome {
  const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
  for (const key of keys) {
    audio.set(key, { audio: Buffer.from("mp3"), durationSeconds: 400 });
  }
  return {
    audio,
    build: "2c43f284208e",
    containerId,
    seed: 1,
    performance: { generate_s: 20 },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetModalCloneGuardForTests();
});

describe("the 7e4a8b48 pack shape", () => {
  it("does not put four 7.7k sections in one call", () => {
    const sizes = BOOK.sections;
    const plan = planModalCloneLanes({
      pending: [1, 2, 3, 4],
      textAt: (index) => "x".repeat(sizes[index]!),
      limits: {
        lanes: 4,
        batch: 24,
        maxLaneChars: modalLaneCharCap({} as NodeJS.ProcessEnv),
      },
    });
    const rowsPerLane = plan.lanes.map((lane) => lane.length);
    const charsPerLane = plan.lanes.map((lane) =>
      lane.reduce((sum, index) => sum + sizes[index]!, 0)
    );
    // The regression was `[[1,2,3,4]]` — 30,800 characters in one call that
    // needed >243s of GPU and was cut at 150s.
    expect(plan.lanes).not.toEqual([[1, 2, 3, 4]]);
    expect(Math.max(...charsPerLane)).toBeLessThanOrEqual(
      modalLaneCharCap({} as NodeJS.ProcessEnv)
    );
    // One 7.7k section fits a lane on its own, so each rides alone and up to
    // four containers are used — the parallel shape production needed.
    expect(Math.max(...rowsPerLane)).toBe(1);
    expect(plan.lanes).toHaveLength(4);
    expect(plan.deferred).toEqual([]);
  });

  it("would still batch small sections, so the fix does not undo #241", () => {
    // The Alice smoke shape: five ~1.3k sections have always belonged in one
    // call. Packing must keep doing that.
    const plan = planModalCloneLanes({
      pending: [0, 1, 2, 3, 4],
      textAt: () => "x".repeat(1_300),
      limits: {
        lanes: 4,
        batch: 24,
        maxLaneChars: modalLaneCharCap({} as NodeJS.ProcessEnv),
      },
    });
    expect(plan.lanes).toEqual([[0, 1, 2, 3, 4]]);
  });

  it("keeps a section no lane can hold out of a neighbour's call", () => {
    // A single section bigger than the whole cap still has to render — this
    // layer cannot split one section — but it must never share a call, because
    // that would abort a neighbour too. It goes alone, and the next section
    // does not join it.
    const plan = planModalCloneLanes({
      pending: [5, 6],
      textAt: (index) => "x".repeat(index === 5 ? 9_000 : 500),
      limits: { lanes: 4, batch: 24, maxLaneChars: 8_000 },
    });
    expect(plan.lanes).toEqual([[5], [6]]);
  });

  it("packs against generation time, not the whole restore budget", () => {
    // 150s of wait is not 150s of narration: a restore and the reference pass
    // happen first. The margin is what remains, and it has to be positive.
    const generateMs = modalCloneLaneGenerateBudgetMs({} as NodeJS.ProcessEnv);
    expect(generateMs).toBeLessThan(150_000);
    expect(generateMs).toBe(150_000 - MODAL_LANE_RESTORE_MARGIN_MS);
    // 31k characters at the planning rate is far more than one call can do.
    const secondsForTheWholeBook = 31_000 / MODAL_LANE_CHARS_PER_SECOND;
    expect(secondsForTheWholeBook * 1000).toBeGreaterThan(generateMs);
    // And one 7.7k section fits, which is why splitting is the right answer.
    const secondsForOneBigSection = BOOK.bigSection / MODAL_LANE_CHARS_PER_SECOND;
    expect(secondsForOneBigSection * 1000).toBeLessThan(generateMs);
  });

  it("does not render a cold row the armed abort cannot finish", async () => {
    // A 7.7k row at 33 chars/s plus the restore is past the 180s clamp.
    // The old clock armed a shorter wait and sent the row anyway.
    const render = vi.fn(async (items: { key: string }[]) =>
      outcome(items.map((item) => item.key))
    );
    const result = await dispatchModalCloneLanes({
      indexes: [1],
      textAt: () => "x".repeat(BOOK.bigSection),
      lanes: 1,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(render).not.toHaveBeenCalled();
    expect(result.staged).toBe(0);
    expect(result.oversize).toContain(1);
  });

  it("arms the abort from the same wall the planner used", async () => {
    const seen: (number | undefined)[] = [];
    const render = vi.fn(
      async (items: { key: string }[], _epoch: number, opts?: { workMs?: number }) => {
        seen.push(opts?.workMs);
        return outcome(items.map((item) => item.key));
      }
    );
    await dispatchModalCloneLanes({
      indexes: [1],
      textAt: () => "x".repeat(2_000),
      lanes: 1,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    const wall = cloneCallWallMs({
      chars: 2_000,
      largestRow: 2_000,
      rows: 1,
      shape: "cold",
      restore: true,
    });
    expect(seen).toEqual([wall]);
  });

  it("sizes new clone books so a row fits, and still batches them", () => {
    // The other half of the regression: at the Fish 8,000 ceiling the book
    // packed into four 7.7k sections, and one row of that size needs ~154s of
    // generation — more than the whole placement budget. Sections must be sized
    // for one call, not for the model's input limit.
    const sectionChars = modalCloneSectionChars({} as NodeJS.ProcessEnv);
    expect(sectionChars).toBeLessThanOrEqual(modalLaneCharCap({} as NodeJS.ProcessEnv));
    // One row inside the generation budget at the single-row rate…
    const rowMs = (sectionChars / MODAL_LANE_ROW_CHARS_PER_SECOND) * 1000;
    expect(rowMs).toBeLessThanOrEqual(modalCloneLaneGenerateBudgetMs({} as NodeJS.ProcessEnv));
    // A cold call still holds more than one of these rows.
    expect(
      modalLaneCharCap({} as NodeJS.ProcessEnv) / sectionChars
    ).toBeGreaterThanOrEqual(2);
  });

  it("lets an operator pack finer and never coarser than one call", () => {
    expect(
      modalCloneSectionChars({ MODAL_S2_SECTION_CHARS: "1200" } as NodeJS.ProcessEnv)
    ).toBe(1_200);
    expect(
      modalCloneSectionChars({ MODAL_S2_SECTION_CHARS: "50000" } as NodeJS.ProcessEnv)
    ).toBe(modalLaneCharCap({} as NodeJS.ProcessEnv));
  });
});

describe("a multi-section call that misses its budget", () => {
  it("retries one section per call instead of resending the same pack", async () => {
    // The production loop in miniature. The first wave packs two big sections
    // per call under an override that is wider than production's cap; those
    // calls time out, and the retry must split rather than repeat.
    const kicks = vi
      .spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm")
      .mockReturnValue(true);
    const calls: number[][] = [];
    const render = vi.fn(async (items: { key: string }[]) => {
      const keys = items.map((item) => Number(item.key));
      calls.push(keys);
      if (keys.length > 1) {
        throw new ModalCloneColdError(
          "Modal clone did not answer within 150s",
          30_000,
          "placement"
        );
      }
      return outcome(keys.map(String));
    });

    const result = await dispatchModalCloneLanes({
      indexes: [1, 2, 3, 4],
      textAt: () => "x".repeat(2_000),
      lanes: 4,
      batch: 24,
      // Two 2,000-character rows fit the 180s abort, so the call is sent.
      // A 7.7k row is refused before this path; see the test above.
      maxLaneChars: 4_500,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });

    // 4,500 admits two sections per call, so the first wave is [[1,2],[3,4]].
    expect(calls[0]).toEqual([1, 2]);
    expect(calls[1]).toEqual([3, 4]);
    // Both timed out, so the retry is four single-row calls, not the same two.
    const retries = calls.slice(2);
    expect(retries).toHaveLength(4);
    for (const retry of retries) expect(retry).toHaveLength(1);
    expect(result.staged).toBe(4);
    expect(result.oversize.sort()).toEqual([1, 2, 3, 4]);
    // A pack that did not fit is not a compiling placement. Kicking the
    // snapshot RPC here is what put a full compile on `job 7e4a8b48`'s pool.
    expect(result.cold).toBe(false);
    expect(kicks).not.toHaveBeenCalled();
  });

  it("does not park the book when the split succeeds", async () => {
    const render = vi.fn(async (items: { key: string }[]) => {
      if (items.length > 1) {
        throw new ModalCloneColdError("budget", 30_000, "placement");
      }
      return outcome(items.map((item) => item.key));
    });
    const result = await dispatchModalCloneLanes({
      indexes: [1, 2],
      textAt: () => "x".repeat(2_000),
      lanes: 2,
      batch: 24,
      maxLaneChars: 4_500,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(false);
    expect(result.staged).toBe(2);
    expect(result.missing).toEqual([]);
  });

  it("still treats a single section that never came back as a placement miss", async () => {
    // One row is the smallest shape there is. If that times out, nothing was
    // learned except that the pool is not serving, which is a real placement.
    const kick = vi
      .spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm")
      .mockReturnValue(true);
    const render = vi.fn(async (items: { key: string }[]) => {
      if (items.length > 1) return outcome(items.map((item) => item.key));
      throw new ModalCloneColdError("did not answer", 30_000, "placement");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [1],
      textAt: () => "x".repeat(2_000),
      lanes: 1,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(true);
    expect(kick).toHaveBeenCalled();
  });
});
