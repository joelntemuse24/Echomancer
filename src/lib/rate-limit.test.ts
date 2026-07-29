/**
 * The limiter's failure policy is the interesting part.
 *
 * Every limiter used to fail open, so a Turso outage silently removed all
 * throttling from the endpoints that spend money upstream. Costly routes now opt
 * into failing closed; cheap ones still fail open so a database blip cannot take
 * playback down.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "@/test/harness";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
  resetRateLimitTableCache,
} from "./rate-limit";

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("createRateLimiter", () => {
  it("allows up to the limit and then rejects", async () => {
    const limit = createRateLimiter(3, 60_000);

    expect(await limit("user-1")).toBe(true);
    expect(await limit("user-1")).toBe(true);
    expect(await limit("user-1")).toBe(true);
    expect(await limit("user-1")).toBe(false);
  });

  it("counts each identity separately", async () => {
    const limit = createRateLimiter(1, 60_000);

    expect(await limit("user-1")).toBe(true);
    expect(await limit("user-1")).toBe(false);
    expect(await limit("user-2")).toBe(true);
  });

  it("keeps separate budgets per limiter configuration", async () => {
    const strict = createRateLimiter(1, 60_000);
    const loose = createRateLimiter(10, 60_000);

    expect(await strict("user-1")).toBe(true);
    expect(await strict("user-1")).toBe(false);
    expect(await loose("user-1")).toBe(true);
  });

  it("fails closed when the counter is unavailable", async () => {
    const turso = await import("@/lib/turso");
    resetRateLimitTableCache();
    vi.spyOn(turso, "execute").mockRejectedValue(new Error("turso down"));
    vi.spyOn(turso, "queryOne").mockRejectedValue(new Error("turso down"));

    const limit = createRateLimiter(5, 60_000, { onError: "closed" });
    expect(await limit("user-1")).toBe(false);
  });

  it("fails open when the counter is unavailable and the route is cheap", async () => {
    const turso = await import("@/lib/turso");
    resetRateLimitTableCache();
    vi.spyOn(turso, "execute").mockRejectedValue(new Error("turso down"));
    vi.spyOn(turso, "queryOne").mockRejectedValue(new Error("turso down"));

    const limit = createRateLimiter(5, 60_000, { onError: "open" });
    expect(await limit("user-1")).toBe(true);
  });

  it("fails closed when the upsert returns no count", async () => {
    const turso = await import("@/lib/turso");
    vi.spyOn(turso, "queryOne").mockResolvedValue(null);

    const limit = createRateLimiter(5, 60_000, { onError: "closed" });
    expect(await limit("user-1")).toBe(false);
  });
});

describe("rateLimitIdentity", () => {
  it("prefers the session id, which cannot be rotated by the caller", async () => {
    expect(await rateLimitIdentity({ userId: "anon_1", ip: "1.2.3.4" })).toBe(
      "u:anon_1"
    );
  });

  it("hashes the IP rather than storing it", async () => {
    const identity = await rateLimitIdentity({ ip: "203.0.113.9" });
    expect(identity).toMatch(/^ip:[0-9a-f]{20}$/);
    expect(identity).not.toContain("203.0.113.9");
  });

  it("is stable for the same IP", async () => {
    const a = await rateLimitIdentity({ ip: "203.0.113.9" });
    const b = await rateLimitIdentity({ ip: "203.0.113.9" });
    expect(a).toBe(b);
  });

  it("falls back to a shared bucket without any identifier", async () => {
    expect(await rateLimitIdentity({})).toBe("ip:unknown");
  });
});

describe("clientIp", () => {
  it("takes the first hop from x-forwarded-for", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.9, 70.41.3.18",
    });
    expect(clientIp({ headers })).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip and then null", () => {
    expect(clientIp({ headers: new Headers({ "x-real-ip": "10.0.0.1" }) })).toBe(
      "10.0.0.1"
    );
    expect(clientIp({ headers: new Headers() })).toBeNull();
  });
});
