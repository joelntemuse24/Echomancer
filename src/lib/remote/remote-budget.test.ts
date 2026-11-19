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
  remoteEvents,
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

    // Ten real hours. The cap keeps the latest six, and four of those sit
    // inside the trailing day. Dropping them to zero would admit another
    // full day on top of GPU time that already ran.
    const tenHoursMostlyBeforeTheWindow: SpendRow = {
      key: "before",
      provider: "s2-clone",
      path: "book",
      usd: 1,
      start: now - 30 * HOUR,
      end: now - 20 * HOUR,
      closed: true,
    };
    expect(chargedInterval(tenHoursMostlyBeforeTheWindow, now)).toEqual([
      now - 26 * HOUR,
      now - 20 * HOUR,
    ]);
    expect(dailySpendOf([tenHoursMostlyBeforeTheWindow], now).ms).toBe(4 * HOUR);

    // Unrepaired stretch: one cap, the most recent six hours, not the
    // whole 34. Repair moves the stored end back so this becomes zero.
    const stretchedToNow: SpendRow = {
      key: "stretched",
      provider: "s2-clone",
      path: "book",
      usd: 4,
      start: now - 34 * HOUR,
      end: now,
      closed: true,
    };
    expect(chargedInterval(stretchedToNow, now)).toEqual([now - CAP, now]);
    expect(dailySpendOf([stretchedToNow], now)).toEqual({ usd: 4, ms: CAP });

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
    const observed = start + 33 * HOUR;
    expect(reapStaleFlights(observed)).toBe(1);
    expect(quiet.flight.endedAt).toBe(observed);
    expect(reapStaleFlights(start + DAY)).toBe(0);
    expect(quiet.flight.endedAt).toBe(observed);
    const charged = chargedInterval(
      {
        key: quiet.flight.key,
        provider: "s2-clone",
        path: "book",
        usd: 1,
        start,
        end: quiet.flight.endedAt ?? observed,
        closed: true,
      },
      observed
    );
    expect(charged).toEqual([observed - CAP, observed]);
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
    expect(clonePreview.kind).toBe("blocked");
    if (clonePreview.kind === "blocked") expect(clonePreview.reason).toBe("budget");

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

  it("keeps an in-flight estimate so a second call cannot slip under the cap", () => {
    const now = Date.now();
    const caps = { bookMs: CAP, dailyMs: 12 * HOUR, bookUsd: 100, dailyUsd: 100 };
    const first = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "holding",
      sections: ["0"],
      enforceBudget: true,
      now,
      estMs: 4 * HOUR,
      caps,
    });
    expect(first.kind).toBe("start");
    const second = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "holding",
      sections: ["1"],
      enforceBudget: true,
      now: now + 5_000,
      estMs: 4 * HOUR,
      caps,
    });
    expect(second.kind).toBe("blocked");
    if (second.kind === "blocked") expect(second.reason).toBe("budget");
  });

  it("sums serial reservations and still merges parallel Kokoro lanes", () => {
    const now = Date.now();
    const laneA: SpendRow = {
      key: "lane-a",
      provider: "kokoro",
      path: "book",
      usd: 0.01,
      start: now - 1_000,
      end: now - 1_000,
      closed: false,
    };
    const laneB: SpendRow = { ...laneA, key: "lane-b" };
    expect(dailySpendOf([laneA, laneB], now).ms).toBe(1_000);

    const bookA: SpendRow = {
      key: "s2-a",
      provider: "s2-clone",
      path: "book",
      jobId: "a",
      usd: 1,
      start: now,
      end: now + 4 * HOUR,
    };
    const bookB: SpendRow = { ...bookA, key: "s2-b", jobId: "b" };
    expect(dailySpendOf([bookA, bookB], now).ms).toBe(8 * HOUR);
  });

  it("counts a real in-window tail so another full day cannot be admitted on top", () => {
    const now = Date.now();
    replacePersistedSpend([
      {
        key: "real-tail",
        jobId: "old",
        provider: "s2-clone",
        path: "book",
        gpu: false,
        usd: 1,
        start: now - 30 * HOUR,
        end: now - 20 * HOUR,
        closed: true,
      },
    ]);
    expect(dailySpend(now).ms).toBe(4 * HOUR);
    const caps = { bookMs: CAP, dailyMs: 12 * HOUR, bookUsd: 100, dailyUsd: 100 };
    const first = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "next-a",
      sections: ["0"],
      enforceBudget: true,
      now,
      estMs: CAP,
      caps,
    });
    expect(first.kind).toBe("start");
    const second = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "next-b",
      sections: ["0"],
      enforceBudget: true,
      now: now + 1_000,
      estMs: CAP,
      caps,
    });
    expect(second.kind).toBe("blocked");
    if (second.kind === "blocked") expect(second.reason).toBe("budget");
  });

  it("does not let an open call grow past the cap, and a second reap leaves the end", () => {
    const now = Date.now();
    const open: SpendRow = {
      key: "open",
      provider: "s2-clone",
      path: "book",
      usd: 1,
      start: now - 10 * HOUR,
      end: now - 10 * HOUR,
      closed: false,
    };
    expect(chargedInterval(open, now)).toEqual([now - CAP, now]);
    expect(dailySpendOf([open], now).ms).toBe(CAP);
    expect(chargedInterval(open, now + 4 * HOUR)).toEqual([now + 4 * HOUR - CAP, now + 4 * HOUR]);
  });

  it("mints an event id that is not reused after the process resets", () => {
    const now = Date.now();
    const first = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "id-a",
      sections: ["0"],
      now,
    });
    expect(first.kind).toBe("start");
    const idA = remoteEvents()[0]?.id ?? "";
    resetRemoteLayerForTests();
    const second = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "id-b",
      sections: ["0"],
      now,
    });
    expect(second.kind).toBe("start");
    const idB = remoteEvents()[0]?.id ?? "";
    expect(idA).toMatch(/^rc_[0-9a-z]+_[0-9a-z]+_[0-9a-f]{8}$/);
    expect(idB).toMatch(/^rc_[0-9a-z]+_[0-9a-z]+_[0-9a-f]{8}$/);
    expect(idA).not.toBe(idB);
    expect(idA).not.toBe("rc_1");
  });

  it("does not rewrite a call that is still inside the cap", async () => {
    await resetDatabase();
    const now = Date.now();
    const key = "s2-clone|fresh|0";
    await persistRemoteEvent({
      id: "fresh-started",
      flightKey: key,
      idempotencyKey: key,
      provider: "s2-clone",
      path: "book",
      jobId: "fresh",
      section: "0",
      outcome: "started",
      startedAt: now - 1_000,
      estCostUsd: 0.05,
    });
    const repaired = await repairInflatedRemoteCalls(now);
    expect(repaired).toEqual({ clamped: 0, closed: 0 });
    const row = await queryOne<{ ended_at: number | null; outcome: string; status: string }>(
      `SELECT ended_at, outcome, status FROM remote_calls WHERE id = ?`,
      ["fresh-started"]
    );
    expect(row?.ended_at ?? null).toBeNull();
    expect(row?.outcome).toBe("started");
    expect(row?.status).toBe("started");
  });

  it("closes a started row whose own end was slid, without stretching it to now", async () => {
    await resetDatabase();
    const now = Date.now();
    const start = now - 34 * HOUR;
    const key = "s2-clone|slid-start|0";
    await persistRemoteEvent({
      id: "slid-started",
      flightKey: key,
      idempotencyKey: key,
      provider: "s2-clone",
      path: "book",
      jobId: "slid-start",
      section: "0",
      outcome: "started",
      startedAt: start,
      endedAt: now,
      estCostUsd: 4,
    });
    const repaired = await repairInflatedRemoteCalls(now);
    expect(repaired).toEqual({ clamped: 1, closed: 0 });
    const row = await queryOne<{ ended_at: number; outcome: string; status: string }>(
      `SELECT ended_at, outcome, status FROM remote_calls WHERE id = ?`,
      ["slid-started"]
    );
    expect(Number(row?.ended_at)).toBe(Math.floor(start) + CAP);
    expect(row?.outcome).toBe("started");
    expect(row?.status).toBe("abandoned");
    const again = await repairInflatedRemoteCalls(now + HOUR);
    expect(again).toEqual({ clamped: 0, closed: 0 });

    resetRemoteLayerForTests();
    expect(await hydrateOpenRemoteCalls(now)).toBe(0);
    expect(dailySpend(now).ms).toBe(0);
    const admitted = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "after-slid",
      sections: ["0"],
      enforceBudget: true,
      now,
      estMs: 60_000,
    });
    expect(admitted.kind).toBe("start");
  });
});
