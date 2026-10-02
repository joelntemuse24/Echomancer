import { describe, expect, it, vi } from "vitest";
import { TakehomeWorkerLoop } from "@/worker/takehome-loop";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("TakehomeWorkerLoop", () => {
  it("never runs the same job twice and caps concurrency", async () => {
    const started: string[] = [];
    const finished = new Set<string>();
    const gates = new Map<string, ReturnType<typeof deferred<{ status: string }>>>();
    const runner = {
      runUntilSettled: vi.fn(async (jobId: string) => {
        started.push(jobId);
        const gate = deferred<{ status: string }>();
        gates.set(jobId, gate);
        const result = await gate.promise;
        finished.add(jobId);
        return result;
      }),
      listDrainable: vi.fn(async () =>
        ["a", "b", "c"].filter((id) => !finished.has(id))
      ),
      releaseExpired: vi.fn(async () => 0),
    };
    const loop = new TakehomeWorkerLoop({
      concurrency: 2,
      budgetMs: 1000,
      runner,
      log: { info: () => {}, error: () => {} },
    });

    expect(loop.enqueue("a")).toBe(true);
    expect(loop.enqueue("a")).toBe(false);
    expect(loop.enqueue("b")).toBe(true);
    expect(loop.enqueue("c")).toBe(false);
    expect(loop.inflightCount).toBe(2);
    expect(started).toEqual(["a", "b"]);

    const drain = await loop.drain();
    expect(drain.started).toEqual([]);
    expect(runner.runUntilSettled).toHaveBeenCalledTimes(2);

    gates.get("a")!.resolve({ status: "ready" });
    await vi.waitFor(() => expect(loop.isInflight("c")).toBe(true));
    expect(started).toEqual(["a", "b", "c"]);

    loop.stop();
    gates.get("b")!.resolve({ status: "ready" });
    gates.get("c")!.resolve({ status: "cancelled" });
    await loop.waitIdle(1_000);
  });

  it("drain releases expired leases then starts queued ids", async () => {
    const runner = {
      runUntilSettled: vi.fn(async () => ({ status: "ready" })),
      listDrainable: vi.fn(async () => ["j1"]),
      releaseExpired: vi.fn(async () => 2),
    };
    const loop = new TakehomeWorkerLoop({
      concurrency: 1,
      budgetMs: 500,
      runner,
      log: { info: () => {}, error: () => {} },
    });
    const result = await loop.drain();
    expect(result.released).toBe(2);
    expect(result.started).toEqual(["j1"]);
    expect(runner.releaseExpired).toHaveBeenCalled();
    loop.stop();
    await loop.waitIdle(1_000);
  });

  it("does not start the same job twice when drain overlaps", async () => {
    const started: string[] = [];
    const gate = deferred<{ status: string }>();
    let releaseHold!: () => void;
    const holdRelease = new Promise<void>((res) => {
      releaseHold = res;
    });
    const runner = {
      runUntilSettled: vi.fn((jobId: string) => {
        started.push(jobId);
        return gate.promise;
      }),
      listDrainable: vi.fn(async () => ["only"]),
      releaseExpired: vi.fn(async () => {
        await holdRelease;
        return 0;
      }),
    };
    const loop = new TakehomeWorkerLoop({
      concurrency: 2,
      budgetMs: 500,
      runner,
      log: { info: () => {}, error: () => {} },
    });
    const first = loop.drain();
    const second = loop.drain();
    releaseHold();
    const [a, b] = await Promise.all([first, second]);
    expect(started).toEqual(["only"]);
    expect(a).toEqual(b);
    expect(a.started).toEqual(["only"]);
    loop.stop();
    gate.resolve({ status: "ready" });
    await loop.waitIdle(1_000);
  });

  it("keeps polling after a Turso 502 and does not hide a real bug", async () => {
    const gateway = Object.assign(new Error("Server returned HTTP status 502"), { status: 502 });
    const errors: unknown[] = [];
    let now = 1_000_000;
    let calls = 0;
    const runner = {
      runUntilSettled: vi.fn(async () => ({ status: "ready" })),
      listDrainable: vi.fn(async () => ["j1"]),
      releaseExpired: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw gateway;
        return 1;
      }),
    };
    const loop = new TakehomeWorkerLoop({
      concurrency: 1,
      budgetMs: 500,
      backoffMs: 5_000,
      now: () => now,
      runner,
      log: { info: () => {}, error: (...args) => errors.push(args[0]) },
    });

    const paused = await loop.drain();
    expect(paused).toEqual({ started: [], released: 0 });
    expect(errors).toEqual(["[takehome-worker] drain paused after a transient database error"]);
    expect(runner.runUntilSettled).not.toHaveBeenCalled();

    const held = await loop.drain();
    expect(held).toEqual({ started: [], released: 0 });
    expect(runner.releaseExpired).toHaveBeenCalledTimes(1);

    now += 5_000;
    const resumed = await loop.drain();
    expect(resumed.released).toBe(1);
    expect(resumed.started).toEqual(["j1"]);

    loop.stop();
    await loop.waitIdle(1_000);

    const broken = new TakehomeWorkerLoop({
      concurrency: 1,
      budgetMs: 500,
      runner: {
        runUntilSettled: async () => ({ status: "ready" }),
        listDrainable: async () => [],
        releaseExpired: async () => {
          throw new TypeError("releaseExpired is not a function");
        },
      },
      log: { info: () => {}, error: () => {} },
    });
    await expect(broken.drain()).rejects.toThrow(TypeError);
  });
});
