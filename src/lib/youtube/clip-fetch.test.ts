import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadYoutubeSection } from "./clip-fetch";

const TOKEN = "secret-apify-token";

afterEach(() => {
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("downloadYoutubeSection", () => {
  it("sends videos[], ignores the full-video duration, and probes the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-clip-"));
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).not.toContain(TOKEN);
      expect(init?.headers && JSON.stringify(init.headers)).toContain(TOKEN);
      if (url.includes("/acts/utils~youtube-link/runs")) {
        expect(url).toContain("maxTotalChargeUsd=0.05");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          videos: [
            {
              url: "https://www.youtube.com/watch?v=abcdefghijk",
              timeframe: "0:30-0:50",
              audioQuality: "best",
            },
          ],
        });
        return json({
          data: {
            id: "run-9",
            status: "SUCCEEDED",
            defaultDatasetId: "ds-1",
            usageTotalUsd: 0,
            chargedEventCounts: { AUDIO_DOWNLOADED: 1, AUDIO_LONG_EXTRA: 5 },
          },
        });
      }
      if (url.includes("/datasets/ds-1/items")) {
        return json([
          {
            downloadUrl: "https://api.apify.com/v2/key-value-stores/x/records/audio",
            filename: "talk.opus",
            duration: 213,
          },
        ]);
      }
      return new Response(Buffer.from("audio-bytes"), {
        status: 200,
        headers: { "content-length": "11" },
      });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: "abcdefghijk",
      startSec: 30,
      endSec: 50,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 20.4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runId).toBe("run-9");
    expect(result.usd).toBeCloseTo(0.035);
    expect(result.bytes).toBe(11);
    expect(await readFile(result.file, "utf8")).toBe("audio-bytes");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    await rm(dir, { recursive: true, force: true });
  });

  it("records the published price when the charge read stays at zero", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-floor-"));
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return json({
          data: { id: "run-floor", status: "SUCCEEDED", defaultDatasetId: "ds-floor", usageTotalUsd: 0 },
        });
      }
      if (url.endsWith("/actor-runs/run-floor")) {
        return json({ data: { id: "run-floor", status: "SUCCEEDED", usageTotalUsd: 0 } });
      }
      if (url.includes("/items")) {
        return json([{ downloadUrl: "https://cdn.example/a.opus", filename: "a.opus", duration: 3000 }]);
      }
      return new Response(Buffer.from("ok"), { status: 200, headers: { "content-length": "2" } });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: "abcdefghijk",
      startSec: 0,
      endSec: 20,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 20,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usd).toBeCloseTo(0.035);
    await rm(dir, { recursive: true, force: true });
  });

  it("re-reads the run when the charge is still zero", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-bill-"));
    let billed = 0;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return json({
          data: { id: "run-b", status: "SUCCEEDED", defaultDatasetId: "ds-b", usageTotalUsd: 0 },
        });
      }
      if (url.endsWith("/actor-runs/run-b")) {
        billed += 1;
        return json({
          data: { id: "run-b", status: "SUCCEEDED", usageTotalUsd: 0.015 },
        });
      }
      if (url.includes("/items")) {
        return json([{ downloadUrl: "https://cdn.example/a.opus", filename: "a.opus", duration: 213 }]);
      }
      return new Response(Buffer.from("ok"), { status: 200, headers: { "content-length": "2" } });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: "abcdefghijk",
      startSec: 0,
      endSec: 20,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 19,
    });
    expect(billed).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usd).toBeCloseTo(0.015);
    await rm(dir, { recursive: true, force: true });
  }, 10_000);

  it("rejects a downloaded file that is the whole video", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-long-"));
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return json({
          data: { id: "run-long", status: "SUCCEEDED", defaultDatasetId: "ds-long", usageTotalUsd: 0.015 },
        });
      }
      if (url.includes("/items")) {
        return json([{ downloadUrl: "https://cdn.example/full.m4a", filename: "full.m4a", duration: 20 }]);
      }
      return new Response(Buffer.from("full-video"), { status: 200, headers: { "content-length": "10" } });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: "abcdefghijk",
      startSec: 30,
      endSec: 50,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 213,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("range_unsupported");
    expect(result.usd).toBeCloseTo(0.015);
    await rm(dir, { recursive: true, force: true });
  });

  it("aborts a run that is still going when the wall clock hits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-wall-"));
    let clock = 1_000_000;
    const hits: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      hits.push(`${init?.method || "GET"} ${url}`);
      if (init?.method === "POST" && url.includes("/runs")) {
        clock = 1_000_000 + 120_000;
        return json({ data: { id: "run-wall", status: "RUNNING", usageTotalUsd: 0 } });
      }
      if (url.endsWith("/actor-runs/run-wall/abort")) {
        return new Response("{}", { status: 200 });
      }
      return json({ data: { id: "run-wall", status: "RUNNING" } });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: "abcdefghijk",
      startSec: 0,
      endSec: 20,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => clock,
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("timeout");
    expect(hits.some((line) => line.includes("waitForFinish="))).toBe(true);
    expect(hits.some((line) => line.startsWith("POST ") && line.includes("/actor-runs/run-wall/abort"))).toBe(
      true
    );
    expect(hits.join("\n")).not.toContain(TOKEN);
    await rm(dir, { recursive: true, force: true });
  });

  it("long-polls the run and starts the file before the charge settles", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-overlap-"));
    const order: string[] = [];
    let bills = 0;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/runs")) {
        order.push("start");
        expect(url).toContain("waitForFinish=");
        expect(url).toContain("timeout=90");
        expect(url).toContain("maxTotalChargeUsd=0.05");
        return json({
          data: { id: "run-w", status: "RUNNING", defaultDatasetId: "ds-w", usageTotalUsd: 0 },
        });
      }
      if (url.includes("waitForFinish")) {
        order.push("poll");
        return json({
          data: { id: "run-w", status: "SUCCEEDED", defaultDatasetId: "ds-w", usageTotalUsd: 0 },
        });
      }
      if (url.includes("/items")) {
        order.push("items");
        return json([{ downloadUrl: "https://cdn.example/a.opus", filename: "a.opus" }]);
      }
      if (url.endsWith("/actor-runs/run-w")) {
        bills += 1;
        order.push("bill");
        return json({
          data: { id: "run-w", status: "SUCCEEDED", usageTotalUsd: bills >= 2 ? 0.015 : 0 },
        });
      }
      order.push("audio");
      return new Response(Buffer.from("abc"), { status: 200, headers: { "content-length": "3" } });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: "abcdefghijk",
      startSec: 0,
      endSec: 20,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 20,
      sleep: async (ms) => {
        order.push(`sleep:${ms}`);
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usd).toBeCloseTo(0.015);
    expect(order.indexOf("audio")).toBeGreaterThan(-1);
    expect(order.indexOf("audio")).toBeLessThan(order.indexOf("sleep:1000"));
    expect(order.filter((step) => step === "sleep:2000")).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("maps a blocked video to restricted and a missing one to unavailable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-block-"));
    const run = async (message: string) => {
      const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json({
            data: {
              id: "run-x",
              status: "FAILED",
              statusMessage: message,
              defaultDatasetId: "ds-x",
              usageTotalUsd: 0,
            },
          });
        }
        return json([{ error: message, duration: 213 }]);
      };
      return downloadYoutubeSection({
        token: TOKEN,
        videoId: "abcdefghijk",
        startSec: 0,
        endSec: 20,
        cwd: dir,
        fetchImpl: fetchImpl as typeof fetch,
      });
    };
    const blocked = await run("no usable connections");
    const missing = await run("Video not found");
    expect(blocked.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (blocked.ok || missing.ok) return;
    expect(blocked.code).toBe("restricted");
    expect(blocked.usd).toBe(0);
    expect(missing.code).toBe("unavailable");
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the run log when the dataset is empty and the status message is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-log-"));
    const run = async (log: string) => {
      const urls: string[] = [];
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        expect(url).not.toContain(TOKEN);
        if (init?.method === "POST") {
          return json({
            data: {
              id: "run-log",
              status: "SUCCEEDED",
              statusMessage: null,
              defaultDatasetId: "ds-log",
              usageTotalUsd: 0,
            },
          });
        }
        if (url.endsWith("/log")) return new Response(log, { status: 200 });
        if (url.includes("/items")) return json([]);
        return json({ data: { id: "run-log", status: "SUCCEEDED", usageTotalUsd: 0 } });
      };
      const result = await downloadYoutubeSection({
        token: TOKEN,
        videoId: "abcdefghijk",
        startSec: 0,
        endSec: 20,
        cwd: dir,
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(urls.some((url) => url.endsWith("/actor-runs/run-log/log"))).toBe(true);
      return result;
    };
    const aged = await run(`${"x".repeat(100)}\nACTOR_ERROR no usable connections after scan\n`);
    const gapped = await run('INFO hello\nRESULTS_JSON {"ok":false,"error":"sabr-gapped"}\n');
    expect(aged.ok).toBe(false);
    expect(gapped.ok).toBe(false);
    if (aged.ok || gapped.ok) return;
    expect(aged.code).toBe("restricted");
    expect(aged.usd).toBe(0);
    expect(gapped.code).toBe("transient");
    expect(gapped.usd).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a file past 8 MB before saving it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-big-"));
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return json({
          data: { id: "run-big", status: "SUCCEEDED", defaultDatasetId: "ds-big", usageTotalUsd: 0.02 },
        });
      }
      if (url.includes("/items")) {
        return json([{ downloadUrl: "https://cdn.example/audio.m4a", duration: 213 }]);
      }
      return new Response("nope", { status: 200, headers: { "content-length": String(9 * 1024 * 1024) } });
    };
    const result = await downloadYoutubeSection({
      token: "t",
      videoId: "abcdefghijk",
      startSec: 0,
      endSec: 20,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_big");
    expect(result.usd).toBeCloseTo(0.02);
    await rm(dir, { recursive: true, force: true });
  });
});
