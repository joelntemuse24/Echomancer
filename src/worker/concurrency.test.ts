import { describe, expect, it } from "vitest";
import { workerConcurrencyFromEnv } from "@/worker/concurrency";

describe("workerConcurrencyFromEnv", () => {
  it("defaults to 1 when the variable is unset or blank", () => {
    expect(workerConcurrencyFromEnv({})).toBe(1);
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "" })).toBe(1);
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "   " })).toBe(1);
  });

  it("falls back to 1 for invalid or below-one values", () => {
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "nope" })).toBe(1);
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "0" })).toBe(1);
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "-3" })).toBe(1);
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "Infinity" })).toBe(1);
  });

  it("honours an explicit value above one", () => {
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "3" })).toBe(3);
    expect(workerConcurrencyFromEnv({ WORKER_CONCURRENCY: "2.9" })).toBe(2);
  });
});
