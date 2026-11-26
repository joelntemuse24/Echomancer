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
  kokoroAudioLaneCap,
  kokoroFairQuota,
  kokoroStreamsPerContainer,
  lanesForSameWaves,
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

  it("splits the fleet exactly, oldest book first, so quotas sum to the fleet", () => {
    const quota = (books: number, rank: number, fleet = 6) =>
      planKokoroBookLanes({
        configured: 16,
        fleet,
        activeBooks: books,
        remainingSections: 99,
        rank,
      });
    // Alone: the whole fleet.
    expect(quota(1, 0)).toBe(6);
    // Two books: 3 + 3.
    expect([quota(2, 0), quota(2, 1)]).toEqual([3, 3]);
    // Four books over six containers: the remainder goes to the older books.
    const four = [0, 1, 2, 3].map((rank) => quota(4, rank));
    expect(four).toEqual([2, 2, 1, 1]);
    expect(four.reduce((a, b) => a + b, 0)).toBe(6);
    // Eight books over six containers: six get one, two are serialised by the
    // slot rows but still get a lane so they are never starved.
    const eight = Array.from({ length: 8 }, (_, rank) => quota(8, rank));
    expect(eight).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(eight.every((n) => n >= 1)).toBe(true);
  });

  it("sums every book's fair share to the fleet when books fit inside it", () => {
    for (const fleet of [6, 8, 12, 16]) {
      for (let books = 1; books <= fleet; books++) {
        const quotas = Array.from({ length: books }, (_, rank) =>
          kokoroFairQuota({
            configured: fleet,
            fleet,
            activeBooks: books,
            rank,
          })
        );
        expect(quotas.reduce((a, b) => a + b, 0)).toBe(fleet);
      }
    }
  });

  it("drops lanes that would not remove a wave", () => {
    // 22 sections at 16 lanes is two waves (16 + 6). Eleven lanes is also two.
    expect(lanesForSameWaves(22, 16)).toBe(11);
    expect(Math.ceil(22 / 11)).toBe(Math.ceil(22 / 16));
    expect(
      planKokoroBookLanes({
        configured: 16,
        fleet: 16,
        activeBooks: 1,
        remainingSections: 22,
      })
    ).toBe(11);
    // A long book still fills the fleet. 714 sections is 45 waves at 16.
    const long = planKokoroBookLanes({
      configured: 16,
      fleet: 16,
      activeBooks: 1,
      remainingSections: 714,
    });
    expect(long).toBe(16);
    expect(Math.ceil(714 / long)).toBe(Math.ceil(714 / 16));
    // Two books keep their fair shares when those shares already fill each wave.
    expect([
      planKokoroBookLanes({ configured: 16, fleet: 16, activeBooks: 2, remainingSections: 40, rank: 0 }),
      planKokoroBookLanes({ configured: 16, fleet: 16, activeBooks: 2, remainingSections: 40, rank: 1 }),
    ]).toEqual([8, 8]);
  });

  it("honours a 16-lane fleet for one book and a 16-lane per-book cap", () => {
    // 40 sections is three waves at 16 lanes and still three at 14.
    expect(
      planKokoroBookLanes({
        configured: 16,
        fleet: 16,
        activeBooks: 1,
        remainingSections: 40,
      })
    ).toBe(14);
    expect(Math.ceil(40 / 14)).toBe(Math.ceil(40 / 16));
    // Two books over 16 containers get 8 each.
    expect([
      planKokoroBookLanes({ configured: 16, fleet: 16, activeBooks: 2, remainingSections: 40, rank: 0 }),
      planKokoroBookLanes({ configured: 16, fleet: 16, activeBooks: 2, remainingSections: 40, rank: 1 }),
    ]).toEqual([8, 8]);
    // The per-book cap still binds below the split.
    expect(
      planKokoroBookLanes({
        configured: 6,
        fleet: 16,
        activeBooks: 1,
        remainingSections: 40,
      })
    ).toBe(6);
  });

  it("shrinks a running book to its share when another book joins", async () => {
    // One book starts alone (6 lanes). A second book joins mid-wave, so the
    // first must stop claiming past its new 3-lane share: its already-open
    // renders finish, then it runs three at a time and leaves the rest of the
    // fleet to the newcomer.
    let budget = 6;
    let changedAt = Number.POSITIVE_INFINITY;
    let inFlight = 0;
    let peakBefore = 0;
    let peakAfter = 0;
    const start = Date.now();
    const now = () => Date.now() - start;
    let next = 0;

    const pool = runRollingRenderPool({
      lanes: 6,
      laneBudget: async () => budget,
      claimNext: async () => (next < 60 ? next++ : null),
      render: async () => {
        inFlight += 1;
        // One render is 20 ms. Ignore the renders that were already open when
        // the budget changed; those cannot be recalled.
        if (now() < changedAt) peakBefore = Math.max(peakBefore, inFlight);
        else if (now() > changedAt + 25) peakAfter = Math.max(peakAfter, inFlight);
        await sleep(20);
        inFlight -= 1;
        return 0;
      },
      afterRender: async () => {},
    });

    await sleep(50);
    budget = 3;
    changedAt = now();
    await pool;

    expect(peakBefore).toBe(6);
    expect(peakAfter).toBeGreaterThan(0);
    expect(peakAfter).toBeLessThanOrEqual(3);
  });

  it("gives a joining book its own lanes while the running book keeps speaking", async () => {
    // Two real pools share one budget of six. The second starts mid-way, and
    // both must render concurrently instead of one waiting out the other.
    let books = 1;
    let joinedAt = Number.POSITIVE_INFINITY;
    const starts: Array<{ book: string; at: number }> = [];
    let inFlightA = 0;
    let inFlightB = 0;
    let peakA = 0;
    let peakB = 0;
    const start = Date.now();
    const now = () => Date.now() - start;

    const runBook = async (book: string, total: number) => {
      let next = 0;
      await runRollingRenderPool({
        lanes: 6,
        laneBudget: async () => Math.max(1, Math.floor(6 / books)),
        claimNext: async () => (next < total ? next++ : null),
        render: async () => {
          starts.push({ book, at: now() });
          if (book === "a") {
            inFlightA += 1;
            if (now() > joinedAt + 25) peakA = Math.max(peakA, inFlightA);
          } else {
            inFlightB += 1;
            peakB = Math.max(peakB, inFlightB);
          }
          await sleep(20);
          if (book === "a") inFlightA -= 1;
          else inFlightB -= 1;
          return 0;
        },
        afterRender: async () => {},
      });
    };

    const bookA = runBook("a", 30);
    await sleep(50);
    books = 2;
    joinedAt = now();
    const bookB = runBook("b", 6);
    await Promise.all([bookA, bookB]);

    // B rendered, and A was still rendering after B joined.
    expect(starts.filter((s) => s.book === "b")).toHaveLength(6);
    expect(starts.filter((s) => s.book === "a" && s.at > joinedAt).length).toBeGreaterThan(0);
    // Each book stayed inside its three-lane share once the join settled, and
    // together they never held more than the six-container fleet.
    expect(peakA).toBeLessThanOrEqual(3);
    expect(peakA).toBeGreaterThan(0);
    expect(peakB).toBeLessThanOrEqual(3);
    expect(peakB).toBeGreaterThan(0);
    expect(peakA + peakB).toBeLessThanOrEqual(6);
  });

  it("never lets a shared pool exceed its budget while another book is active", async () => {
    let inFlight = 0;
    let peak = 0;
    const budget = 3;
    let next = 0;
    await runRollingRenderPool({
      lanes: 6,
      laneBudget: async () => budget,
      claimNext: async () => (next < 20 ? next++ : null),
      render: async (index) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight -= 1;
        return index;
      },
      afterRender: async () => {},
    });
    expect(peak).toBe(budget);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("falls back to the planned lanes when the shared budget read fails", async () => {
    let next = 0;
    let renders = 0;
    await runRollingRenderPool({
      lanes: 4,
      laneBudget: async () => {
        throw new Error("turso is down");
      },
      claimNext: async () => (next < 9 ? next++ : null),
      render: async (index) => {
        renders += 1;
        await sleep(1);
        return index;
      },
      afterRender: async () => {},
    });
    // A broken counter does not stall the book; the shared permit is still
    // the hard cap.
    expect(renders).toBe(9);
  });
});

describe("audio-sized Kokoro lanes", () => {
  it("leaves the torch fleet alone when streams are unset", () => {
    expect(kokoroStreamsPerContainer({} as NodeJS.ProcessEnv)).toBe(0);
    expect(kokoroStreamsPerContainer({ KOKORO_STREAMS_PER_CONTAINER: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(kokoroStreamsPerContainer({ KOKORO_STREAMS_PER_CONTAINER: "4" } as NodeJS.ProcessEnv)).toBe(4);
    expect(kokoroStreamsPerContainer({ KOKORO_STREAMS_PER_CONTAINER: "99" } as NodeJS.ProcessEnv)).toBe(8);
  });

  it("sizes a 16-minute book at 12 containers and 48 calls", () => {
    // 16 minutes is 960 s. One container per 80 s is 12 containers, 48 calls.
    expect(kokoroAudioLaneCap(16_000, 4)).toBe(48);
    expect(kokoroAudioLaneCap(16_000, 1)).toBe(12);
    expect(kokoroStreamsPerContainer({ KOKORO_RUNTIME: "onnx" } as NodeJS.ProcessEnv)).toBe(4);
    expect(
      planKokoroBookLanes({
        configured: 64,
        fleet: 64,
        activeBooks: 1,
        remainingSections: 48,
        remainingChars: 16_000,
        streamsPerContainer: 4,
      })
    ).toBe(48);
  });

  it("drops idle ONNX lanes when the section count is past the audio cap", () => {
    expect(
      planKokoroBookLanes({
        configured: 64,
        fleet: 64,
        activeBooks: 1,
        remainingSections: 200,
        remainingChars: 16_000,
        streamsPerContainer: 4,
      })
    ).toBe(40);
  });

  it("does not cap lanes when the torch path leaves streams unset", () => {
    expect(
      planKokoroBookLanes({
        configured: 16,
        fleet: 16,
        activeBooks: 1,
        remainingSections: 22,
        remainingChars: 15_700,
        streamsPerContainer: 0,
      })
    ).toBe(11);
  });
});
