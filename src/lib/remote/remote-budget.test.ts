import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/harness";
import { queryOne } from "@/lib/turso";
import {
  admitRemoteCall,
  chargedInterval,
  dailySpend,
  dailySpendOf,
  reapStaleFlights,
  remoteCallCapMs,
  replacePersistedSpend,
  resetRemoteLayerForTests,
  runRemoteCall,
  type SpendRow,
} from "@/lib/remote/layer";
import { hydrateOpenRemoteCalls, persistRemoteEvent, repairInflatedRemoteCalls } from "@/lib/remote/store";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CAP = 6 * HOUR;

const ABANDONED_JOBS = ["8d4aa537", "c3f9a595", "ba9403ee", "cae83e9f", "4f3cec01"];

beforeEach(() => {
  resetRemoteLayerForTests();
});

describe("daily remote budget", () => {
  it("charges only the overlap with the trailing day, and never a stretched span", () => {
    const now = Date.now();
    expect(remoteCallCapMs()).toBe(CAP);
    const sixHoursEndingTwentyHoursAgo: SpendRow = {
      key: "overlap",
      usd: 1,
      start: now - 26 * HOUR,
      end: now - 20 * HOUR,
    };
    expect(dailySpendOf([sixHoursEndingTwentyHoursAgo], now).ms).toBe(4 * HOUR);

    const tenHoursMostlyBeforeTheWindow: SpendRow = {
      key: "before",
      usd: 1,
      start: now - 30 * HOUR,
      end: now - 20 * HOUR,
    };
    expect(chargedInterval(tenHoursMostlyBeforeTheWindow, now)).toEqual([
      now - 30 * HOUR,
      now - 24 * HOUR,
    ]);
    expect(dailySpendOf([tenHoursMostlyBeforeTheWindow], now).ms).toBe(0);

    const stretchedToNow: SpendRow = {
      key: "stretched",
      usd: 4,
      start: now - 34 * HOUR,
      end: now,
    };
    expect(chargedInterval(stretchedToNow, now)?.[1]).toBe(now - 34 * HOUR + remoteCallCapMs());
    expect(dailySpendOf([stretchedToNow], now)).toEqual({ usd: 0, ms: 0 });

    const laneA: SpendRow = {
      key: "lane-a",
      usd: 1,
      start: now - 2 * HOUR,
      end: now - HOUR,
    };
    const laneB: SpendRow = {
      key: "lane-b",
      usd: 1,
      start: now - 2 * HOUR + 1_000,
      end: now - HOUR,
    };
    expect(dailySpendOf([laneA, laneB], now).ms).toBe(HOUR);
  });

  it("still counts a call admitted now against the day", () => {
    const now = Date.now();
    const full: SpendRow[] = [
      { key: "a", usd: 1, start: now - 12 * HOUR, end: now - 6 * HOUR },
      { key: "b", usd: 1, start: now - 6 * HOUR, end: now },
    ];
    const pending: SpendRow = {
      key: "pending",
      usd: 2,
      start: now,
      end: now + 30 * 60_000,
      gpu: true,
    };
    expect(dailySpendOf([...full, pending], now).ms).toBe(12 * HOUR + 30 * 60_000);
    expect(dailySpendOf([...full, pending], now).usd).toBe(4);
  });

  it("admits a new book when abandoned rows were stretched across more than a day", async () => {
    await resetDatabase();
    const now = Date.now();
    expect(remoteCallCapMs()).toBe(CAP);
    for (let i = 0; i < ABANDONED_JOBS.length; i++) {
      const jobId = ABANDONED_JOBS[i]!;
      const start = now - (34 * HOUR - i * 24 * 60_000);
      const key = `s2-clone|${jobId}|0`;
      await persistRemoteEvent({
        id: `started-${jobId}`,
        flightKey: key,
        idempotencyKey: key,
        provider: "s2-clone",
        path: "book",
        jobId,
        section: "0",
        outcome: "started",
        startedAt: start,
        estCostUsd: 1,
      });
      await persistRemoteEvent({
        id: `abandoned-${jobId}`,
        flightKey: key,
        idempotencyKey: key,
        provider: "s2-clone",
        path: "book",
        jobId,
        section: "0",
        outcome: "abandoned",
        startedAt: start,
        endedAt: now,
        error: "abandoned",
      });
    }

    const first = await repairInflatedRemoteCalls(now);
    expect(first.clamped).toBe(ABANDONED_JOBS.length);
    expect(first.closed).toBe(ABANDONED_JOBS.length);

    const sample = await queryOne<{ ended_at: number; outcome: string }>(
      `SELECT ended_at, outcome FROM remote_calls WHERE id = ?`,
      ["abandoned-8d4aa537"]
    );
    const started = await queryOne<{ ended_at: number; outcome: string }>(
      `SELECT ended_at, outcome FROM remote_calls WHERE id = ?`,
      ["started-8d4aa537"]
    );
    const sampleStart = now - 34 * HOUR;
    expect(Number(sample?.ended_at)).toBe(Math.floor(sampleStart) + CAP);
    expect(sample?.outcome).toBe("abandoned");
    expect(Number(started?.ended_at)).toBe(Math.floor(sampleStart) + CAP);
    expect(started?.outcome).toBe("started");

    const again = await repairInflatedRemoteCalls(now + 5 * HOUR);
    expect(again).toEqual({ clamped: 0, closed: 0 });
    const after = await queryOne<{ ended_at: number }>(
      `SELECT ended_at FROM remote_calls WHERE id = ?`,
      ["abandoned-8d4aa537"]
    );
    expect(Number(after?.ended_at)).toBe(Number(sample?.ended_at));

    resetRemoteLayerForTests();
    expect(await hydrateOpenRemoteCalls(now)).toBe(0);
    expect(dailySpend(now).ms).toBeLessThan(12 * HOUR);
    expect(dailySpend(now).ms).toBe(0);

    const admitted = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "new-book",
      sections: ["0"],
      enforceBudget: true,
      now,
      estMs: 60_000,
    });
    expect(admitted.kind).toBe("start");
  });

  it("does not move a terminal end when the same id is written again", async () => {
    await resetDatabase();
    const start = Date.now() - 33 * HOUR;
    const fixed = start + 2 * HOUR;
    const key = "s2-clone|recycled|0";
    await persistRemoteEvent({
      id: "rc_1",
      flightKey: key,
      idempotencyKey: key,
      provider: "s2-clone",
      path: "book",
      jobId: "recycled",
      section: "0",
      outcome: "abandoned",
      startedAt: start,
      endedAt: fixed,
      error: "abandoned",
    });
    await persistRemoteEvent({
      id: "rc_1",
      flightKey: key,
      idempotencyKey: key,
      provider: "s2-clone",
      path: "book",
      jobId: "recycled",
      section: "0",
      outcome: "abandoned",
      startedAt: start,
      endedAt: Date.now(),
      error: "abandoned",
    });
    const row = await queryOne<{ ended_at: number; outcome: string }>(
      `SELECT ended_at, outcome FROM remote_calls WHERE id = ?`,
      ["rc_1"]
    );
    expect(Number(row?.ended_at)).toBe(Math.floor(fixed));
    expect(row?.outcome).toBe("abandoned");

    const open = "s2-clone|open-end|0";
    await persistRemoteEvent({
      id: "rc_open",
      flightKey: open,
      idempotencyKey: open,
      provider: "s2-clone",
      path: "book",
      jobId: "open-end",
      section: "0",
      outcome: "started",
      startedAt: start,
    });
    await persistRemoteEvent({
      id: "rc_open",
      flightKey: open,
      idempotencyKey: open,
      provider: "s2-clone",
      path: "book",
      jobId: "open-end",
      section: "0",
      outcome: "success",
      startedAt: start,
      endedAt: start + HOUR,
    });
    await persistRemoteEvent({
      id: "rc_open",
      flightKey: open,
      idempotencyKey: open,
      provider: "s2-clone",
      path: "book",
      jobId: "open-end",
      section: "0",
      outcome: "success",
      startedAt: start,
      endedAt: Date.now(),
    });
    const closed = await queryOne<{ ended_at: number; outcome: string }>(
      `SELECT ended_at, outcome FROM remote_calls WHERE id = ?`,
      ["rc_open"]
    );
    expect(Number(closed?.ended_at)).toBe(Math.floor(start + HOUR));
    expect(closed?.outcome).toBe("success");
  });

  it("reaps a stale flight once, at the last heartbeat or the cap", () => {
    const start = Date.now() - 33 * HOUR;
    const admitted = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "stale-book",
      sections: ["0"],
      now: start,
      callId: "fc-stale",
    });
    expect(admitted.kind).toBe("start");
    if (admitted.kind !== "start") return;
    admitted.flight.polledAt = start + 2 * HOUR;

    expect(reapStaleFlights(start + 33 * HOUR)).toBe(1);
    expect(admitted.flight.endedAt).toBe(start + 2 * HOUR);
    expect(admitted.flight.status).toBe("cancelled");
    expect(reapStaleFlights(start + 40 * HOUR)).toBe(0);
    expect(admitted.flight.endedAt).toBe(start + 2 * HOUR);

    resetRemoteLayerForTests();
    const quiet = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "quiet-book",
      sections: ["0"],
      now: start,
    });
    expect(quiet.kind).toBe("start");
    if (quiet.kind !== "start") return;
    expect(reapStaleFlights(start + 33 * HOUR)).toBe(1);
    expect(quiet.flight.endedAt).toBe(start + CAP);
    expect(reapStaleFlights(start + DAY)).toBe(0);
    expect(quiet.flight.endedAt).toBe(start + CAP);
  });

  it("does not charge Fish or a preview, and never refuses a preview for the GPU day", async () => {
    const now = Date.now();
    replacePersistedSpend([
      {
        key: "gpu-a",
        jobId: "gpu-a",
        provider: "s2-clone",
        path: "book",
        gpu: true,
        usd: 1,
        start: now - 18 * HOUR,
        end: now - 12 * HOUR,
      },
      {
        key: "gpu-b",
        jobId: "gpu-b",
        provider: "s2-clone",
        path: "book",
        gpu: true,
        usd: 1,
        start: now - 12 * HOUR,
        end: now - 6 * HOUR,
      },
      {
        key: "gpu-c",
        jobId: "gpu-c",
        provider: "s2-clone",
        path: "book",
        gpu: true,
        usd: 1,
        start: now - 6 * HOUR,
        end: now,
      },
    ]);
    expect(dailySpend(now).ms).toBe(18 * HOUR);

    const blocked = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "another-book",
      sections: ["0"],
      enforceBudget: true,
      now,
    });
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind === "blocked") expect(blocked.reason).toBe("budget");

    await expect(
      runRemoteCall({
        provider: "s2-clone",
        path: "book",
        jobId: "another-book",
        sections: ["1"],
        enforceBudget: true,
        now,
        execute: async () => "audio",
      })
    ).rejects.toThrow("This book is over its remote-call budget.");

    const kokoro = admitRemoteCall({
      provider: "kokoro",
      path: "book",
      jobId: "kokoro-book",
      sections: ["0"],
      enforceBudget: true,
      now,
    });
    expect(kokoro.kind).toBe("blocked");

    const fishBook = admitRemoteCall({
      provider: "fish",
      path: "book",
      jobId: "fish-book",
      sections: ["0"],
      enforceBudget: true,
      now,
      estCostUsd: 0.02,
    });
    expect(fishBook.kind).toBe("start");

    const fishPreview = admitRemoteCall({
      provider: "fish",
      path: "preview",
      sections: ["preview:clip"],
      enforceBudget: true,
      now,
      estCostUsd: 0.02,
    });
    expect(fishPreview.kind).toBe("start");

    const clonePreview = admitRemoteCall({
      provider: "s2-clone",
      path: "preview",
      sections: ["preview:voice"],
      enforceBudget: true,
      now,
    });
    expect(clonePreview.kind).toBe("start");

    await expect(
      runRemoteCall({
        provider: "fish",
        path: "preview",
        sections: ["preview:bake"],
        enforceBudget: true,
        now,
        estCostUsd: 0.02,
        execute: async () => "preview-audio",
      })
    ).resolves.toBe("preview-audio");

    expect(dailySpend(now).ms).toBe(18 * HOUR);
  });
});
