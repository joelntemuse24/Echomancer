import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueTakehomeOnWorker = vi.fn().mockResolvedValue({ id: "job" });

vi.mock("@/lib/jobs/takehome-worker-client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/jobs/takehome-worker-client")
  >("@/lib/jobs/takehome-worker-client");
  return {
    ...actual,
    enqueueTakehomeOnWorker: (...args: unknown[]) =>
      enqueueTakehomeOnWorker(...args),
  };
});

const KEYS = [
  "WORKER_URL",
  "TAKEHOME_WORKER_URL",
  "WORKER_SECRET",
  "TAKEHOME_WORKER_SECRET",
  "INTERNAL_JOB_SECRET",
  "TAKEHOME_TRIGGER_FALLBACK",
  "TRIGGER_SECRET_KEY",
  "VERCEL_ENV",
  "NODE_ENV",
  "VITEST",
] as const;

describe("takehome dispatch adapter", () => {
  const snapshot = new Map<string, string | undefined>();

  function setEnv(key: (typeof KEYS)[number], value: string | undefined) {
    if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(() => {
    enqueueTakehomeOnWorker.mockReset();
    enqueueTakehomeOnWorker.mockResolvedValue({ id: "job" });
    setEnv("WORKER_URL", undefined);
    setEnv("TAKEHOME_WORKER_URL", undefined);
    setEnv("WORKER_SECRET", undefined);
    setEnv("TAKEHOME_WORKER_SECRET", undefined);
    setEnv("TAKEHOME_TRIGGER_FALLBACK", undefined);
    setEnv("TRIGGER_SECRET_KEY", undefined);
    setEnv("VERCEL_ENV", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of KEYS) {
      if (!snapshot.has(key)) continue;
      const value = snapshot.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      snapshot.delete(key);
    }
  });

  it("prefers the VM worker when WORKER_URL is set", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    const { enqueueTakehomeAdvance } = await import("./takehome-dispatch");
    await enqueueTakehomeAdvance("job-w");
    expect(enqueueTakehomeOnWorker).toHaveBeenCalledWith("job-w");
  });

  it("does not call the worker when WORKER_URL is unset", async () => {
    const { enqueueTakehomeAdvance } = await import("./takehome-dispatch");
    await enqueueTakehomeAdvance("job-t");
    expect(enqueueTakehomeOnWorker).not.toHaveBeenCalled();
  });

  it("leaves the caller when the worker POST fails", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    enqueueTakehomeOnWorker.mockRejectedValueOnce(new Error("worker down"));
    const { enqueueTakehomeAdvance } = await import("./takehome-dispatch");
    await expect(enqueueTakehomeAdvance("job-nf")).resolves.toBeUndefined();
    expect(enqueueTakehomeOnWorker).toHaveBeenCalledWith("job-nf");
  });

  it("ignores a leftover fallback flag and does not fetch another host", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    setEnv("TAKEHOME_TRIGGER_FALLBACK", "1");
    setEnv("TRIGGER_SECRET_KEY", "tr_test_secret");
    enqueueTakehomeOnWorker.mockRejectedValueOnce(new Error("worker down"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { enqueueTakehomeAdvance } = await import("./takehome-dispatch");
    await enqueueTakehomeAdvance("job-fb");
    expect(enqueueTakehomeOnWorker).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("production without WORKER_URL is TAKEHOME_NOT_CONFIGURED", async () => {
    setEnv("WORKER_URL", undefined);
    setEnv("VERCEL_ENV", "production");
    const { assertCanDispatchTakehome } = await import("./takehome-dispatch");
    try {
      assertCanDispatchTakehome();
      throw new Error("expected assertCanDispatchTakehome to throw");
    } catch (err) {
      expect(err).toMatchObject({
        name: "AppError",
        code: "TAKEHOME_NOT_CONFIGURED",
        statusCode: 503,
      });
      expect(String((err as Error).message)).toMatch(/WORKER_URL/);
      expect(String((err as Error).message)).not.toMatch(/TRIGGER/);
    }
  });

  it("production with WORKER_URL and a secret can dispatch", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    setEnv("VERCEL_ENV", "production");
    const { assertCanDispatchTakehome } = await import("./takehome-dispatch");
    expect(() => assertCanDispatchTakehome()).not.toThrow();
  });

  it("production with WORKER_URL but no secret is TAKEHOME_NOT_CONFIGURED", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", undefined);
    setEnv("TAKEHOME_WORKER_SECRET", undefined);
    setEnv("INTERNAL_JOB_SECRET", undefined);
    setEnv("VERCEL_ENV", "production");
    const { assertCanDispatchTakehome } = await import("./takehome-dispatch");
    try {
      assertCanDispatchTakehome();
      throw new Error("expected assertCanDispatchTakehome to throw");
    } catch (err) {
      expect(err).toMatchObject({
        name: "AppError",
        code: "TAKEHOME_NOT_CONFIGURED",
        statusCode: 503,
      });
      expect(String((err as Error).message)).toMatch(/WORKER_SECRET/);
    }
  });

  it("never imports or calls Trigger", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/jobs/takehome-dispatch.ts"),
      "utf8"
    );
    const product = ["tri", "gger"].join("");
    expect(source.toLowerCase()).not.toContain(`${product}.dev`);
    expect(source).not.toContain(`@${product}`);
    expect(source).not.toMatch(/TRIGGER_/);
    expect(source).not.toMatch(/TAKEHOME_TRIGGER/);
    expect(source).not.toContain(`${product}-api`);
    expect(source).not.toContain(`${product}Task`);
    expect(source).not.toContain(`enqueueOn${product[0].toUpperCase()}${product.slice(1)}`);
  });
});
