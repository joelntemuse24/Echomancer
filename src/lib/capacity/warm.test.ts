import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, queryOne } from "@/lib/turso";
import { resetDatabase } from "@/test/harness";
import {
  claimWarmPool,
  poolsForWarm,
  postWarm,
  releaseWarmPool,
  warmSharedCapacity,
  warmTarget,
  WARM_HOLD_MS,
} from "@/lib/capacity/warm";

const ENV_KEYS = [
  "MODAL_CPU_URL",
  "MODAL_CPU_TOKEN",
  "SOWELL_ENABLED",
  "SOWELL_URL",
  "SOWELL_TOKEN",
  "GEORGE_ENABLED",
  "GEORGE_URL",
  "GEORGE_TOKEN",
  "WORKER_URL",
  "WORKER_SECRET",
  "WORKER",
] as const;

describe("shared capacity warm", () => {
  const prior = new Map<string, string | undefined>();

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    prior.clear();
  });

  function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
    if (!prior.has(key)) prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("warms general CPU for Andrew and adds Kokoro only for Sowell or George", () => {
    expect(poolsForWarm({ reason: "create", voiceId: "standard" })).toEqual(["cpu"]);
    expect(poolsForWarm({ reason: "create", voiceId: "ava" })).toEqual(["cpu"]);
    expect(poolsForWarm({ reason: "create", voiceId: "libby" })).toEqual(["cpu"]);
    expect(poolsForWarm({ reason: "create", voiceId: "clone:abc" })).toEqual(["cpu"]);
    expect(poolsForWarm({ reason: "create", voiceId: null })).toEqual(["cpu"]);
    expect(poolsForWarm({ reason: "create", voiceId: "sowell" })).toEqual([
      "cpu",
      "kokoro",
    ]);
    expect(poolsForWarm({ reason: "create", voiceId: "george" })).toEqual([
      "cpu",
      "kokoro",
    ]);
    expect(poolsForWarm({ reason: "voice", voiceId: "sowell" })).toEqual(["kokoro"]);
    expect(poolsForWarm({ reason: "voice", voiceId: "ava" })).toEqual([]);
  });

  it("does not point Kokoro at the GPU clone app", () => {
    setEnv("SOWELL_ENABLED", "1");
    setEnv("SOWELL_URL", "https://sowell.example.modal.run");
    setEnv("SOWELL_TOKEN", "sowell-token");
    setEnv("MODAL_CPU_URL", "https://cpu.example.modal.run");
    setEnv("MODAL_CPU_TOKEN", "cpu-token");
    expect(warmTarget("cpu")?.url).toBe("https://cpu.example.modal.run");
    expect(warmTarget("kokoro")?.url).toBe("https://sowell.example.modal.run");
    expect(warmTarget("kokoro")?.url).not.toContain("s2");
  });

  it("claims a pool once and does not slide the hold", async () => {
    await resetDatabase();
    const first = await claimWarmPool("cpu", 1_000);
    const second = await claimWarmPool("cpu", 1_000 + WARM_HOLD_MS - 1);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    const third = await claimWarmPool("cpu", 1_000 + WARM_HOLD_MS);
    expect(third.claimed).toBe(true);
    const row = await queryOne<{ started_at: number }>(
      `SELECT started_at FROM capacity_warms WHERE pool = 'cpu'`
    );
    expect(Number(row?.started_at)).toBe(1_000 + WARM_HOLD_MS);
  });

  it("lets one of two racing claims win", async () => {
    await resetDatabase();
    const [a, b] = await Promise.all([
      claimWarmPool("kokoro", 50),
      claimWarmPool("kokoro", 50),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
  });

  it("posts {warm:true} once and treats 429 as enough", async () => {
    await resetDatabase();
    setEnv("WORKER_URL", undefined);
    setEnv("WORKER_SECRET", undefined);
    setEnv("MODAL_CPU_URL", "https://cpu.example.modal.run");
    setEnv("MODAL_CPU_TOKEN", "cpu-token");
    setEnv("SOWELL_ENABLED", undefined);
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, state: "busy" }), { status: 429 });
    });
    const first = await warmSharedCapacity({
      reason: "create",
      voiceId: "standard",
      now: 10,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const second = await warmSharedCapacity({
      reason: "create",
      voiceId: "standard",
      now: 11,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(first.posted).toEqual(["cpu"]);
    expect(second.posted).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual([{ warm: true }]);
    const tasks = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM cpu_tasks`);
    expect(Number(tasks?.n)).toBe(0);
  });

  it("releases the hold when the pool cannot be reached, then allows another warm", async () => {
    await resetDatabase();
    setEnv("WORKER_URL", undefined);
    setEnv("MODAL_CPU_URL", "https://cpu.example.modal.run");
    setEnv("MODAL_CPU_TOKEN", "cpu-token");
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("down"), { cause: { code: "ECONNREFUSED" } });
    });
    const missed = await warmSharedCapacity({
      reason: "create",
      voiceId: "ava",
      now: 20,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(missed.posted).toEqual([]);
    const again = await warmSharedCapacity({
      reason: "create",
      voiceId: "ava",
      now: 21,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    expect(again.posted).toEqual(["cpu"]);
  });

  it("does not POST when the claim store throws", async () => {
    await resetDatabase();
    setEnv("MODAL_CPU_URL", "https://cpu.example.modal.run");
    setEnv("MODAL_CPU_TOKEN", "cpu-token");
    setEnv("WORKER_URL", undefined);
    await execute(`DROP TABLE capacity_warms`);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await warmSharedCapacity({
      reason: "create",
      voiceId: "libby",
      now: 30,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.posted).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    await execute(
      `CREATE TABLE capacity_warms (
        pool TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`
    );
    const later = await warmSharedCapacity({
      reason: "create",
      voiceId: "libby",
      now: 31,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(later.posted).toEqual(["cpu"]);
  });

  it("sends Kokoro and CPU on one create, and only Kokoro for a voice tap", async () => {
    await resetDatabase();
    setEnv("WORKER_URL", undefined);
    setEnv("MODAL_CPU_URL", "https://cpu.example.modal.run");
    setEnv("MODAL_CPU_TOKEN", "cpu-token");
    setEnv("SOWELL_ENABLED", "1");
    setEnv("SOWELL_URL", "https://sowell.example.modal.run");
    setEnv("SOWELL_TOKEN", "sowell-token");
    setEnv("WORKER", undefined);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response("{}", { status: 200 });
    });
    await warmSharedCapacity({
      reason: "create",
      voiceId: "george",
      now: 40,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(urls).toEqual([
      "https://cpu.example.modal.run",
      "https://sowell.example.modal.run",
    ]);
    urls.length = 0;
    await warmSharedCapacity({
      reason: "voice",
      voiceId: "sowell",
      now: 41,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(urls).toEqual([]);
    await warmSharedCapacity({
      reason: "voice",
      voiceId: "sowell",
      now: 40 + WARM_HOLD_MS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(urls).toEqual(["https://sowell.example.modal.run"]);
  });

  it("asks the worker once instead of calling Modal from this process", async () => {
    await resetDatabase();
    setEnv("WORKER_URL", "https://worker.example");
    setEnv("WORKER_SECRET", "worker-secret");
    setEnv("MODAL_CPU_URL", "https://cpu.example.modal.run");
    setEnv("MODAL_CPU_TOKEN", "cpu-token");
    const calls: { url: string; auth: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        auth: String((init?.headers as Record<string, string>).authorization),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({ ok: true, results: { cpu: "ready" } }),
        { status: 200 }
      );
    });
    const result = await warmSharedCapacity({
      reason: "create",
      voiceId: "standard",
      now: 70,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.posted).toEqual(["cpu"]);
    expect(calls).toEqual([
      {
        url: "https://worker.example/capacity-warm",
        auth: "Bearer worker-secret",
        body: { pools: ["cpu"] },
      },
    ]);
    expect(calls[0]?.auth).not.toContain("cpu-token");
  });

  it("postWarm does not retry a 429", async () => {
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 429 }));
    const result = await postWarm(
      "cpu",
      {
        MODAL_CPU_URL: "https://cpu.example.modal.run",
        MODAL_CPU_TOKEN: "cpu-token",
      } as NodeJS.ProcessEnv,
      fetchImpl as typeof fetch
    );
    expect(result).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("releases only the hold that failed", async () => {
    await resetDatabase();
    await claimWarmPool("cpu", 5);
    await releaseWarmPool("cpu", 4);
    const still = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM capacity_warms WHERE pool = 'cpu'`
    );
    expect(Number(still?.n)).toBe(1);
    await releaseWarmPool("cpu", 5);
    const gone = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM capacity_warms WHERE pool = 'cpu'`
    );
    expect(Number(gone?.n)).toBe(0);
  });
});
