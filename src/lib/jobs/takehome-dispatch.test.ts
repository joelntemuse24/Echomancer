import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const triggerTask = vi.fn().mockResolvedValue({ id: "run_test" });
const enqueueTakehomeOnWorker = vi.fn().mockResolvedValue({ id: "job" });

vi.mock("@/lib/jobs/trigger-api", () => ({
  triggerTask: (...args: unknown[]) => triggerTask(...args),
}));

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
  "TRIGGER_SECRET_KEY",
  "TAKEHOME_TRIGGER_FALLBACK",
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
    triggerTask.mockReset();
    triggerTask.mockResolvedValue({ id: "run_test" });
    enqueueTakehomeOnWorker.mockReset();
    enqueueTakehomeOnWorker.mockResolvedValue({ id: "job" });
    setEnv("WORKER_URL", undefined);
    setEnv("TAKEHOME_WORKER_URL", undefined);
    setEnv("WORKER_SECRET", undefined);
    setEnv("TAKEHOME_WORKER_SECRET", undefined);
    setEnv("TAKEHOME_TRIGGER_FALLBACK", undefined);
    setEnv("VERCEL_ENV", undefined);
    setEnv("TRIGGER_SECRET_KEY", "tr_test_secret");
  });

  afterEach(() => {
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
    expect(triggerTask).not.toHaveBeenCalled();
  });

  it("uses Trigger when the worker URL is unset", async () => {
    const { enqueueTakehomeAdvance } = await import("./takehome-dispatch");
    await enqueueTakehomeAdvance("job-t");
    expect(enqueueTakehomeOnWorker).not.toHaveBeenCalled();
    expect(triggerTask).toHaveBeenCalledWith(
      "takehome.advance",
      { jobId: "job-t" },
      { concurrencyKey: "job-t" }
    );
  });

  it("falls back to Trigger when the worker POST fails and the flag is on", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    setEnv("TAKEHOME_TRIGGER_FALLBACK", "1");
    enqueueTakehomeOnWorker.mockRejectedValueOnce(new Error("worker down"));
    const { enqueueTakehomeAdvance } = await import("./takehome-dispatch");
    await enqueueTakehomeAdvance("job-fb");
    expect(triggerTask).toHaveBeenCalledWith(
      "takehome.advance",
      { jobId: "job-fb" },
      { concurrencyKey: "job-fb" }
    );
  });

  it("does not call Trigger after a worker failure unless the flag is on", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    setEnv("TAKEHOME_TRIGGER_FALLBACK", undefined);
    enqueueTakehomeOnWorker.mockRejectedValueOnce(new Error("worker down"));
    const { enqueueTakehomeAdvance } = await import("./takehome-dispatch");
    await enqueueTakehomeAdvance("job-nf");
    expect(triggerTask).not.toHaveBeenCalled();
  });

  it("production without worker or Trigger is TAKEHOME_NOT_CONFIGURED", async () => {
    setEnv("TRIGGER_SECRET_KEY", undefined);
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
    }
  });

  it("production with WORKER_URL does not require Trigger", async () => {
    setEnv("TRIGGER_SECRET_KEY", undefined);
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    setEnv("VERCEL_ENV", "production");
    const { assertCanDispatchTakehome } = await import("./takehome-dispatch");
    expect(() => assertCanDispatchTakehome()).not.toThrow();
  });
});
