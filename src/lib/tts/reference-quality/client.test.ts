import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestReferenceCheck } from "@/lib/tts/reference-quality/client";
import { isSafeSamplePath } from "@/lib/tts/reference-quality/check";

const KEYS = ["WORKER_URL", "TAKEHOME_WORKER_URL", "WORKER_SECRET", "TAKEHOME_WORKER_SECRET", "INTERNAL_JOB_SECRET"];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of KEYS) saved.set(k, process.env[k]);
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

const input = { uploadId: "u1", samplePath: "clone-samples/u/a.wav" };
const report = { verdict: "fail", headline: "h", body: "b", issues: [{ code: "echo", detail: "d" }], remaster: true, metrics: {} };

describe("requestReferenceCheck", () => {
  it("skips (null) when the worker is not configured or the gate is off", async () => {
    const fetchImpl = vi.fn();
    expect(await requestReferenceCheck(input, { fetchImpl: fetchImpl as never })).toBeNull();
    process.env.WORKER_URL = "http://w";
    process.env.WORKER_SECRET = "s";
    expect(
      await requestReferenceCheck(input, { fetchImpl: fetchImpl as never, env: { REFERENCE_QUALITY_GATE: "0" } })
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts with the bearer secret and returns the result", async () => {
    process.env.WORKER_URL = "http://w/";
    process.env.WORKER_SECRET = "s";
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { report, remasteredPath: null, ms: 1200 } }), { status: 200 })
    );
    const out = await requestReferenceCheck(input, { fetchImpl: fetchImpl as never, env: {} });
    expect(out?.report.verdict).toBe("fail");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://w/reference-quality");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s");
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("fails open on errors, timeouts and empty results", async () => {
    process.env.WORKER_URL = "http://w";
    process.env.WORKER_SECRET = "s";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await requestReferenceCheck(input, { fetchImpl: bad as never, env: {} })).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await requestReferenceCheck(input, { fetchImpl: boom as never, env: {} })).toBeNull();
    const empty = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: null }), { status: 200 }));
    expect(await requestReferenceCheck(input, { fetchImpl: empty as never, env: {} })).toBeNull();
  });
});

describe("isSafeSamplePath", () => {
  it("accepts storage keys and rejects traversal or absolute paths", () => {
    expect(isSafeSamplePath("clones/abc-123/sample.webm")).toBe(true);
    expect(isSafeSamplePath("books/u/x.pdf")).toBe(false);
    expect(isSafeSamplePath("clips/u/x.wav")).toBe(true);
    expect(isSafeSamplePath("../etc/passwd")).toBe(false);
    expect(isSafeSamplePath("/etc/passwd")).toBe(false);
    expect(isSafeSamplePath("a b.wav")).toBe(false);
  });
});
