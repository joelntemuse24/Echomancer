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
});
