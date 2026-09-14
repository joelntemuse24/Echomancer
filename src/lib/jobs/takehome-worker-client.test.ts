import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  enqueueTakehomeOnWorker,
  isTakehomeWorkerConfigured,
  takehomeWorkerSecret,
  takehomeWorkerUrl,
} from "@/lib/jobs/takehome-worker-client";

const KEYS = [
  "WORKER_URL",
  "TAKEHOME_WORKER_URL",
  "WORKER_SECRET",
  "TAKEHOME_WORKER_SECRET",
  "INTERNAL_JOB_SECRET",
] as const;

describe("takehome worker client", () => {
  const snapshot = new Map<string, string | undefined>();

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

  function setEnv(key: (typeof KEYS)[number], value: string | undefined) {
    if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("reads WORKER_URL / WORKER_SECRET and falls back to INTERNAL_JOB_SECRET", () => {
    setEnv("WORKER_URL", "https://worker.example.com/");
    setEnv("WORKER_SECRET", undefined);
    setEnv("TAKEHOME_WORKER_SECRET", undefined);
    setEnv("INTERNAL_JOB_SECRET", "internal");
    expect(takehomeWorkerUrl()).toBe("https://worker.example.com");
    expect(takehomeWorkerSecret()).toBe("internal");
    expect(isTakehomeWorkerConfigured()).toBe(true);
  });

  it("is not configured without a URL", () => {
    setEnv("WORKER_URL", undefined);
    setEnv("TAKEHOME_WORKER_URL", undefined);
    setEnv("WORKER_SECRET", "secret");
    expect(isTakehomeWorkerConfigured()).toBe(false);
  });

  it("POSTs { jobId } with the shared bearer secret", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      statusText: "Accepted",
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueueTakehomeOnWorker("job-1")).resolves.toEqual({
      id: "job-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://worker.example.com/jobs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer worker-secret"
    );
    expect(JSON.parse(String(init.body))).toEqual({ jobId: "job-1" });
  });

  it("does not retry a 401", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "nope",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      enqueueTakehomeOnWorker("job-401", { attempts: 3 })
    ).rejects.toMatchObject({
      name: "AppError",
      code: "TAKEHOME_WORKER_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries then throws TAKEHOME_WORKER_FAILED", async () => {
    setEnv("WORKER_URL", "https://worker.example.com");
    setEnv("WORKER_SECRET", "worker-secret");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      text: async () => "down",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      enqueueTakehomeOnWorker("job-2", { attempts: 2 })
    ).rejects.toMatchObject({
      name: "AppError",
      code: "TAKEHOME_WORKER_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws TAKEHOME_WORKER_NOT_CONFIGURED when the URL is missing", async () => {
    setEnv("WORKER_URL", undefined);
    setEnv("TAKEHOME_WORKER_URL", undefined);
    await expect(enqueueTakehomeOnWorker("job-3")).rejects.toBeInstanceOf(
      AppError
    );
    await expect(enqueueTakehomeOnWorker("job-3")).rejects.toMatchObject({
      code: "TAKEHOME_WORKER_NOT_CONFIGURED",
    });
  });
});
