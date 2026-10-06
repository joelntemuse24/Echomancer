import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Presigning is an offline HMAC, so dummy credentials are enough. r2-storage
 * reads its env at import, hence the module reset.
 */
const saved: Record<string, string | undefined> = {};
const ENV = {
  R2_ACCOUNT_ID: "acct0123",
  R2_ACCESS_KEY_ID: "AKIDTEST",
  R2_SECRET_ACCESS_KEY: "secret-test",
  R2_BUCKET_NAME: "echomancer-audio",
};

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  vi.resetModules();
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

describe("getPlaybackUrl", () => {
  it("signs a 13h URL that is identical within one hour", async () => {
    const { getPlaybackUrl } = await import("@/lib/r2-storage");
    const base = Date.UTC(2026, 9, 6, 22, 0, 0);
    const a = new URL(await getPlaybackUrl("audiobooks/j/full.mp3", { now: base + 60_000 }));
    const b = new URL(await getPlaybackUrl("audiobooks/j/full.mp3", { now: base + 59 * 60_000 }));
    expect(a.toString()).toBe(b.toString());
    expect(a.host).toBe("acct0123.r2.cloudflarestorage.com");
    expect(a.pathname).toBe("/echomancer-audio/audiobooks/j/full.mp3");
    expect(a.searchParams.get("X-Amz-Expires")).toBe("46800");
    expect(a.searchParams.get("X-Amz-Date")).toBe("20261006T220000Z");
    expect(a.searchParams.get("response-content-disposition")).toBeNull();

    const next = new URL(await getPlaybackUrl("audiobooks/j/full.mp3", { now: base + 61 * 60_000 }));
    expect(next.searchParams.get("X-Amz-Date")).toBe("20261006T230000Z");
  });

  it("forces an attachment for a named download", async () => {
    const { getPlaybackUrl } = await import("@/lib/r2-storage");
    const url = new URL(await getPlaybackUrl("audiobooks/j/full.mp3", { downloadName: "book.mp3" }));
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="book.mp3"');
    expect(url.searchParams.get("response-content-type")).toBe("application/octet-stream");
  });

  it("directObjectUrl honours the STORAGE_DIRECT_R2=0 kill switch", async () => {
    const { directObjectUrl } = await import("@/lib/storage");
    expect(await directObjectUrl("audiobooks/j/full.mp3")).toMatch(/^https:\/\//);
    process.env.STORAGE_DIRECT_R2 = "0";
    try {
      expect(await directObjectUrl("audiobooks/j/full.mp3")).toBeNull();
    } finally {
      delete process.env.STORAGE_DIRECT_R2;
    }
  });
});
