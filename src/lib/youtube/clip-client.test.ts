import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIP_CLIENT_WAIT_MS } from "./clip-policy";
import { clipJson, clipPollDelay, readPendingClip, storePendingClip } from "./clip-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pending clip recovery", () => {
  function storage() {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    return values;
  }

  it("persists only the id, owner context and deadline origin", () => {
    const values = storage();
    const pending = { id: "clip_123", ownerContext: "opaque-owner-a", startedAt: Date.now() };
    storePendingClip(pending);
    expect(readPendingClip("opaque-owner-a")).toEqual(pending);
    expect(JSON.parse([...values.values()][0])).toEqual(pending);
    expect(readPendingClip("opaque-owner-b")).toBeNull();
    expect(values.size).toBe(0);
  });

  it("drops expired, future and malformed records", () => {
    storage();
    for (const job of [
      { id: "clip", startedAt: Date.now() - CLIP_CLIENT_WAIT_MS - 1 },
      { id: "clip", startedAt: Date.now() + 60_000 },
      { id: "../another-owner", startedAt: Date.now() },
    ]) {
      storePendingClip({ ...job, ownerContext: "owner" });
      expect(readPendingClip("owner")).toBeNull();
    }
  });
});

describe("bounded requests and polling", () => {
  it("backs off to ten seconds", () => {
    expect(clipPollDelay(0)).toBe(1500);
    expect(clipPollDelay(2)).toBeGreaterThan(clipPollDelay(1));
    expect(clipPollDelay(100)).toBe(10_000);
  });

  it("aborts a stalled body read after fifteen seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => Promise.resolve({
      json: () => new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    })));
    const request = clipJson("/api/clips");
    const rejected = expect(request).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  });
});
