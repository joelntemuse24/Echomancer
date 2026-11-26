import { afterEach, describe, expect, it } from "vitest";
import {
  CPU_WARM_HOLD_MS,
  __keepaliveTimerCountForTest,
  cpuWarmKeepaliveDelays,
  cpuWarmKeepaliveEnabled,
  resetCpuWarmKeepalive,
  startCpuWarmKeepalive,
} from "./cpu-warm-keepalive";

afterEach(() => {
  resetCpuWarmKeepalive();
});

describe("cpu warm keepalive", () => {
  it("stays off until the worker is told the deployed window is short", () => {
    expect(cpuWarmKeepaliveEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(cpuWarmKeepaliveEnabled({ CPU_SCALEDOWN_SECONDS: "300" } as NodeJS.ProcessEnv)).toBe(
      false
    );
    expect(cpuWarmKeepaliveEnabled({ CPU_SCALEDOWN_SECONDS: "10" } as NodeJS.ProcessEnv)).toBe(
      true
    );
  });

  it("posts inside the idle window and lets the container die with the hold", () => {
    const delays = cpuWarmKeepaliveDelays(CPU_WARM_HOLD_MS, 10);
    expect(delays.length).toBeGreaterThan(1);
    expect(delays[delays.length - 1]).toBe(CPU_WARM_HOLD_MS - 10_000);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]! - delays[i - 1]!).toBeLessThan(10_000);
    }
    expect(delays[0]).toBeLessThan(10_000);
  });

  it("does not start a second loop inside the hold", () => {
    const env = { CPU_SCALEDOWN_SECONDS: "10" } as NodeJS.ProcessEnv;
    const now = Date.now();
    expect(startCpuWarmKeepalive(async () => undefined, env, now)).toBe(true);
    expect(startCpuWarmKeepalive(async () => undefined, env, now + 10_000)).toBe(false);
  });
});

describe("cpu warm keepalive timers", () => {
  it("drops a timer from the set once it has fired", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const env = { CPU_SCALEDOWN_SECONDS: "10" } as NodeJS.ProcessEnv;
      let posts = 0;
      startCpuWarmKeepalive(async () => void posts++, env, Date.now());
      await vi.advanceTimersByTimeAsync(CPU_WARM_HOLD_MS + 1_000);
      expect(posts).toBeGreaterThan(1);
      expect(__keepaliveTimerCountForTest()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
