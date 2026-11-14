/**
 * The Kokoro CPU pool: lanes stay busy and mastering overlaps speech.
 *
 * These are pure scheduling tests. No HTTP, no Modal, no torch. The cost is a
 * fake render whose wall time stands for one section's speech (uneven on
 * purpose — that is what the old fixed-pair dispatch lost time to) and a fake
 * master whose wall time stands for the ffmpeg pass.
 */

import { describe, expect, it } from "vitest";
import {
  planKokoroBookLanes,
  runRollingRenderPool,
  type KokoroPoolEvent,
} from "./kokoro-pool";
import { createInFlightGate } from "./section-concurrency";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function track(): {
  events: KokoroPoolEvent[];
  onEvent: (event: KokoroPoolEvent) => void;
} {
  const events: KokoroPoolEvent[] = [];
  return {
    events,
    onEvent: (event: KokoroPoolEvent) => {
      events.push(event);
    },
  };
}

async function renderSections(durationsMs: number[], lanes: number) {
  const tracker = track();
  const claims: number[] = [];
  let next = 0;
  const result = await runRollingRenderPool({
    lanes,
    claimNext: async () => (next < durationsMs.length ? next++ : null),
    render: async (index) => {
      claims.push(index);
      await sleep(durationsMs[index]!);
      return index;
    },
    afterRender: async () => {
      await sleep(0);
    },
    onEvent: tracker.onEvent,
  });
  return { result, claims, events: tracker.events };
}

describe("rolling Kokoro render pool", () => {
  it("keeps every lane busy with uneven sections instead of waiting for a pair", async () => {
    // Nine sections, six lanes. Section 0 is the slow one, so a fixed-pair
    // dispatch would hold lane 1 idle until section 1 caught up. Rolling,
    // lane 1 claims section 2 the moment it is free.
    const durations = [60, 5, 40, 5, 40, 5, 40, 5, 40];
    const { claims, events, result } = await renderSections(durations, 6);

    // Every section ran exactly once, in ascending claim order.
    expect(claims).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    // Six renders in flight at once: the pool filled the fleet.
    expect(result.peakRenders).toBe(6);

    // No lane idled while work remained. "Idle" here is a render slot that
    // was free while an unclaimed section existed: with a rolling pool the
    // number of render-starts following a render-end equals the number of
    // sections that had to wait for a lane, and no extra wait appears.
    const starts = events.filter((event) => event.type === "render-start");
    expect(starts).toHaveLength(9);

    // The old pair dispatch would have finished sections 0 and 1 together at
    // t=60. Rolling finished section 1 at t=5, so section 6 was claimed long
    // before the slow section 0 returned.
    const start6 = starts.find((event) => event.type === "render-start" && event.index === 6);
    const end0 = events.find((event) => event.type === "render-end" && event.index === 0);
    expect(start6).toBeTruthy();
    expect(end0).toBeTruthy();
    expect(start6!.at).toBeLessThan(end0!.at);
  });

  it("preserves index order in the result even when later sections finish first", async () => {
    const durations = [80, 5, 5, 5, 5, 5];
    const { result } = await renderSections(durations, 6);
    expect(result.indexes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.rendered).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("overlaps mastering with the next section's rendering", async () => {
    const masterStarted: number[] = [];
    const masterFinished: number[] = [];
    const renderEnded: number[] = [];
    let mastersInFlight = 0;
    let peakMasters = 0;
    let rendersInFlight = 0;
    let peakRenders = 0;
    let next = 0;
    const total = 8;

    const started = Date.now();
    await runRollingRenderPool({
      lanes: 3,
      claimNext: async () => (next < total ? next++ : null),
      render: async (index) => {
        rendersInFlight += 1;
        peakRenders = Math.max(peakRenders, rendersInFlight);
        // Uneven, so mastering would serialise visibly if it blocked a lane.
        await sleep(10 + (index % 3) * 15);
        rendersInFlight -= 1;
        renderEnded.push(Date.now() - started);
        return index;
      },
      afterRender: async () => {
        mastersInFlight += 1;
        peakMasters = Math.max(peakMasters, mastersInFlight);
        masterStarted.push(Date.now() - started);
        await sleep(15);
        mastersInFlight -= 1;
        masterFinished.push(Date.now() - started);
      },
    });

    // Mastering ran concurrently both with other masters and with renders.
    expect(peakMasters).toBeGreaterThan(1);
    expect(peakRenders).toBe(3);
    // The last master finished after the last render: the pool waits for
    // mastering to settle before it reports done, but it never blocked a lane.
    expect(Math.max(...masterFinished)).toBeGreaterThanOrEqual(
      Math.max(...renderEnded)
    );
    // A master starts before all renders have finished, i.e. it overlapped.
    expect(Math.min(...masterStarted)).toBeLessThan(Math.max(...renderEnded));

    // If mastering had been serialised with rendering, wall time would be at
    // least renders + masters. Overlapping keeps it close to renders alone.
    const rendersAlone = renderEnded.reduce((sum, ms) => sum + ms, 0);
    const mastersAlone = masterFinished.reduce((sum, ms) => sum + ms, 0);
    const wall = Date.now() - started;
    expect(wall).toBeLessThan(rendersAlone / 2 + mastersAlone / 2 + 200);
  });

  it("keeps every lane busy when the claim source is slower than a lane", async () => {
    // A gate models the shared `kokoro` provider-slot rows: the pool can have
    // six lanes but only four permits, so a claim waits. No lane should hold a
    // permit while waiting to claim.
    const gate = createInFlightGate(4);
    const claims: number[] = [];
    let next = 0;
    let held = 0;
    let peakHeld = 0;
    const total = 10;
    const result = await runRollingRenderPool({
      lanes: 6,
      claimNext: async () => {
        if (next >= total) return null;
        const index = next++;
        claims.push(index);
        return index;
      },
      render: async (index) => {
        await gate.acquire();
        held += 1;
        peakHeld = Math.max(peakHeld, held);
        try {
          await sleep(5);
        } finally {
          held -= 1;
          gate.release();
        }
        return index;
      },
      afterRender: async () => {},
    });
    expect(claims).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(result.indexes).toEqual(Array.from({ length: total }, (_, i) => i));
    // The gate, not the pool, throttled: four container permits were in use
    // and no more, while the pool asked for six.
    expect(peakHeld).toBe(4);
  });

  it("stops claiming near the deadline but still finishes the work it took", async () => {
    const deadline = Date.now() + 40;
    const claims: number[] = [];
    let next = 0;
    const result = await runRollingRenderPool({
      lanes: 3,
      shouldStop: () => Date.now() >= deadline,
      claimNext: async () => (next < 20 ? (claims.push(next), next++) : null),
      render: async (index) => {
        await sleep(10);
        return index;
      },
      afterRender: async () => {},
    });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.length).toBeLessThan(20);
    // Everything claimed rendered: nothing is half-done.
    expect(result.indexes).toEqual(claims);
  });

  it("settles in-flight mastering before reporting, so the segment map is final", async () => {
    const stored: number[] = [];
    let next = 0;
    const result = await runRollingRenderPool({
      lanes: 4,
      claimNext: async () => (next < 5 ? next++ : null),
      render: async (index) => index,
      afterRender: async (index) => {
        await sleep(5);
        stored.push(index);
      },
    });
    expect(result.indexes).toEqual([0, 1, 2, 3, 4]);
    expect([...stored].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("rethrows a render failure after the work it already started settles", async () => {
    const stored: number[] = [];
    let next = 0;
    await expect(
      runRollingRenderPool({
        lanes: 2,
        claimNext: async () => (next < 4 ? next++ : null),
        render: async (index) => {
          if (index === 1) throw new Error("sowell refused the take");
          return index;
        },
        afterRender: async (index) => {
          await sleep(10);
          stored.push(index);
        },
      })
    ).rejects.toThrow(/refused the take/);
    // Section 0's master did not leak past the rejection.
    expect(stored).toContain(0);
  });
});

describe("kokoro book lanes", () => {
  it("gives one book the whole fleet and several books a fair share", () => {
    expect(
      planKokoroBookLanes({
        configured: 6,
        fleet: 6,
        activeBooks: 1,
        remainingSections: 11,
      })
    ).toBe(6);
    // Two books share six containers, so neither can starve the other.
    expect(
      planKokoroBookLanes({
        configured: 6,
        fleet: 6,
        activeBooks: 2,
        remainingSections: 11,
      })
    ).toBe(3);
    expect(
      planKokoroBookLanes({
        configured: 6,
        fleet: 6,
        activeBooks: 7,
        remainingSections: 11,
      })
    ).toBe(1);
    // A book cannot use more lanes than it has sections.
    expect(
      planKokoroBookLanes({
        configured: 6,
        fleet: 6,
        activeBooks: 1,
        remainingSections: 2,
      })
    ).toBe(2);
    // A book with nothing left still reports one claimable lane.
    expect(
      planKokoroBookLanes({
        configured: 6,
        fleet: 6,
        activeBooks: 1,
        remainingSections: 0,
      })
    ).toBe(1);
  });

  it("never exceeds the configured cap", () => {
    expect(
      planKokoroBookLanes({
        configured: 2,
        fleet: 6,
        activeBooks: 1,
        remainingSections: 11,
      })
    ).toBe(2);
  });
});
