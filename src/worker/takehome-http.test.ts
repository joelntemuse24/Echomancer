import { afterEach, describe, expect, it, vi } from "vitest";
import { routeTakehomeWorkerRequest } from "@/worker/takehome-http";
import { TakehomeWorkerLoop } from "@/worker/takehome-loop";

const SECRET_KEYS = [
  "WORKER_SECRET",
  "TAKEHOME_WORKER_SECRET",
  "INTERNAL_JOB_SECRET",
] as const;

describe("takehome worker HTTP routes", () => {
  const snapshot = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of SECRET_KEYS) {
      if (!snapshot.has(key)) continue;
      const value = snapshot.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      snapshot.delete(key);
    }
  });

  function setSecret(value: string) {
    for (const key of SECRET_KEYS) {
      if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
    }
    process.env.WORKER_SECRET = value;
    delete process.env.TAKEHOME_WORKER_SECRET;
    delete process.env.INTERNAL_JOB_SECRET;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function loop(runUntilSettled?: () => Promise<{ status: string }>) {
    return new TakehomeWorkerLoop({
      concurrency: 1,
      budgetMs: 1000,
      runner: {
        runUntilSettled:
          runUntilSettled ?? vi.fn(async () => ({ status: "queued" })),
        listDrainable: vi.fn(async () => []),
        releaseExpired: vi.fn(async () => 0),
      },
      log: { info: () => {}, error: () => {} },
    });
  }

  it("GET /health is public", async () => {
    setSecret("s3cret");
    const worker = loop();
    const result = await routeTakehomeWorkerRequest({
      method: "GET",
      url: "/health",
      loop: worker,
      startedAt: Date.now(),
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      service: "echomancer-takehome",
      inflight: 0,
      concurrency: 1,
    });
  });

  it("POST /jobs rejects a missing bearer", async () => {
    setSecret("s3cret");
    const result = await routeTakehomeWorkerRequest({
      method: "POST",
      url: "/jobs",
      bodyText: JSON.stringify({ jobId: "j1" }),
      loop: loop(),
      startedAt: Date.now(),
    });
    expect(result.status).toBe(401);
  });

  it("POST /jobs accepts a job with the shared secret", async () => {
    setSecret("s3cret");
    const gate = deferred<{ status: string }>();
    const worker = loop(() => gate.promise);
    const result = await routeTakehomeWorkerRequest({
      method: "POST",
      url: "/jobs",
      authorization: "Bearer s3cret",
      bodyText: JSON.stringify({ jobId: "j1" }),
      loop: worker,
      startedAt: Date.now(),
    });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({
      ok: true,
      accepted: true,
      jobId: "j1",
      started: true,
    });
    expect(worker.isInflight("j1")).toBe(true);
    worker.stop();
    gate.resolve({ status: "ready" });
    await worker.waitIdle(1_000);
  });

  it("POST /jobs is 404 when acceptJob rejects the id", async () => {
    setSecret("s3cret");
    const result = await routeTakehomeWorkerRequest({
      method: "POST",
      url: "/jobs",
      authorization: "Bearer s3cret",
      bodyText: JSON.stringify({ jobId: "stream-1" }),
      loop: loop(),
      startedAt: Date.now(),
      acceptJob: async () => "wrong-kind",
    });
    expect(result.status).toBe(404);
  });

  it("GET /ready is 503 when Turso is down", async () => {
    setSecret("s3cret");
    const result = await routeTakehomeWorkerRequest({
      method: "GET",
      url: "/ready",
      loop: loop(),
      startedAt: Date.now(),
      ready: async () => false,
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false });
  });
});
