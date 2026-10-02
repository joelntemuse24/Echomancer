import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadYoutubeSection } from "./clip-fetch";

const TOKEN = "secret-apify-token";
const VIDEO = "abcdefghijk";

afterEach(() => {
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const LINK_RUNS = "/acts/utils~youtube-link/runs";
const SEGMENT_RUNS = "/acts/entertained_rattlesnake~youtube-audio-segment-downloader/runs";

describe("downloadYoutubeSection", () => {
  it("sends videos[], ignores the full-video duration, and probes the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-clip-"));
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).not.toContain(TOKEN);
      expect(init?.headers && JSON.stringify(init.headers)).toContain(TOKEN);
      if (url.includes(LINK_RUNS)) {
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
      videoId: VIDEO,
      startSec: 30,
      endSec: 50,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 20.4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor).toBe("link");
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
      videoId: VIDEO,
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

  it("falls back to the segment actor when the link actor returns the whole video", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-long-"));
    const actors: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(LINK_RUNS)) {
        actors.push("link");
        return json({
          data: { id: "run-long", status: "SUCCEEDED", defaultDatasetId: "ds-long", usageTotalUsd: 0.015 },
        });
      }
      if (url.includes(SEGMENT_RUNS)) {
        actors.push("segment");
        return json({
          data: {
            id: "run-seg",
            status: "SUCCEEDED",
            defaultKeyValueStoreId: "kv-1",
            usageTotalUsd: 0.0901,
          },
        });
      }
      if (url.includes("/items")) {
        return json([{ downloadUrl: "https://cdn.example/full.m4a", filename: "full.m4a", duration: 20 }]);
      }
      if (url.includes("/key-value-stores/kv-1/keys")) {
        return json({ data: { items: [{ key: "youtube-audio_abcdefghijk.wav" }] } });
      }
      if (url.includes("/key-value-stores/kv-1/records/")) {
        return new Response(Buffer.from("wav-bytes"), { status: 200 });
      }
      return new Response(Buffer.from("full-video"), { status: 200, headers: { "content-length": "10" } });
    };
    const probes: Record<string, number> = { "audio.m4a": 213, "audio.wav": 20 };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: VIDEO,
      startSec: 30,
      endSec: 50,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async (file) => probes[path.basename(file)] ?? null,
    });
    expect(actors).toEqual(["link", "segment"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor).toBe("segment");
    expect(result.runId).toBe("run-seg");
    expect(result.usd).toBeCloseTo(0.015 + 0.0901);
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
        clock += 120_000;
        return json({ data: { id: `run-wall-${hits.length}`, status: "RUNNING", usageTotalUsd: 0 } });
      }
      if (url.includes("/abort")) {
        return new Response("{}", { status: 200 });
      }
      return json({ data: { id: "run-wall", status: "RUNNING" } });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: VIDEO,
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
    expect(hits.filter((line) => line.startsWith("POST ") && line.includes("/abort"))).toHaveLength(2);
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
      videoId: VIDEO,
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
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/runs")) {
          return json({
            data: {
              id: "run-x",
              status: "FAILED",
              statusMessage: message,
              defaultDatasetId: "ds-x",
              defaultKeyValueStoreId: "kv-x",
              usageTotalUsd: 0,
            },
          });
        }
        if (url.includes("/key-value-stores/kv-x/keys")) {
          return json({ data: { items: [] } });
        }
        if (url.endsWith("/log")) return new Response("nothing useful", { status: 200 });
        return json([{ error: message, duration: 213 }]);
      };
      return downloadYoutubeSection({
        token: TOKEN,
        videoId: VIDEO,
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
        videoId: VIDEO,
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

  it("keeps the specific code when the fallback only manages a generic failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-big-"));
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes(LINK_RUNS)) {
        return json({
          data: { id: "run-big", status: "SUCCEEDED", defaultDatasetId: "ds-big", usageTotalUsd: 0.02 },
        });
      }
      if (init?.method === "POST" && url.includes(SEGMENT_RUNS)) {
        return json({
          data: { id: "run-big-2", status: "SUCCEEDED", usageTotalUsd: 0 },
        });
      }
      if (url.includes("/items")) {
        return json([{ downloadUrl: "https://cdn.example/audio.m4a", duration: 213 }]);
      }
      if (url.endsWith("/log")) return new Response("plain log tail", { status: 200 });
      return new Response("nope", { status: 200, headers: { "content-length": String(17 * 1024 * 1024) } });
    };
    const result = await downloadYoutubeSection({
      token: "t",
      videoId: VIDEO,
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

describe("downloadYoutubeSection segment actor", () => {
  it("runs first on a long source and reads the key-value store, not the dataset", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-seg-"));
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.includes(SEGMENT_RUNS)) {
        expect(url).toContain("maxTotalChargeUsd=0.15");
        expect(url).toContain("timeout=90");
        expect(JSON.parse(String(init?.body))).toEqual({
          videos: ["https://www.youtube.com/watch?v=abcdefghijk"],
          format: "wav",
          startTime: "300",
          endTime: "320",
          transcribe: false,
        });
        return json({
          data: {
            id: "run-seg",
            status: "SUCCEEDED",
            defaultKeyValueStoreId: "kv-9",
            usageTotalUsd: 0,
            chargedEventCounts: { "video-started": 1, "audio-minute-processed": 1, "apify-actor-start": 1 },
          },
        });
      }
      if (url.includes("/key-value-stores/kv-9/keys")) {
        return json({ data: { items: [{ key: "youtube-audio_abcdefghijk.wav" }] } });
      }
      if (url.includes("/key-value-stores/kv-9/records/")) {
        return new Response(Buffer.from("wav-audio"), { status: 200 });
      }
      return json({ error: "unexpected" }, 500);
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: VIDEO,
      startSec: 300,
      endSec: 320,
      cwd: dir,
      videoSeconds: 2738,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor).toBe("segment");
    expect(result.usd).toBeCloseTo(0.0901);
    expect(await readFile(result.file, "utf8")).toBe("wav-audio");
    expect(result.file.endsWith("audio.wav")).toBe(true);
    expect(calls.some((line) => line.includes(LINK_RUNS))).toBe(false);
    expect(calls.some((line) => line.includes("/datasets/"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("treats a SUCCEEDED run with a FAILED record as blocked and falls back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-bot-"));
    const actors: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(SEGMENT_RUNS)) {
        actors.push("segment");
        return json({
          data: {
            id: "run-bot",
            status: "SUCCEEDED",
            defaultKeyValueStoreId: "kv-bot",
            usageTotalUsd: 0,
            chargedEventCounts: { "apify-actor-start": 1 },
          },
        });
      }
      if (url.includes("/key-value-stores/kv-bot/keys")) {
        return json({ data: { items: [{ key: "FAILED_abcdefghijk.json" }] } });
      }
      if (url.includes("/key-value-stores/kv-bot/records/")) {
        return json({ error: "Sign in to confirm you're not a bot" });
      }
      if (url.includes(LINK_RUNS)) {
        actors.push("link");
        return json({
          data: { id: "run-link", status: "SUCCEEDED", defaultDatasetId: "ds-1", usageTotalUsd: 0.031 },
        });
      }
      if (url.includes("/items")) {
        return json([{ downloadUrl: "https://cdn.example/a.opus", filename: "a.opus" }]);
      }
      return new Response(Buffer.from("opus-audio"), { status: 200 });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: VIDEO,
      startSec: 300,
      endSec: 320,
      cwd: dir,
      videoSeconds: 4520,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 20,
    });
    expect(actors).toEqual(["segment", "link"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor).toBe("link");
    expect(result.usd).toBeCloseTo(0.031 + 0.00005);
    await rm(dir, { recursive: true, force: true });
  });

  it("floors a settled-at-zero segment charge at $0.05 plus $0.04 per started minute", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-floor-"));
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(SEGMENT_RUNS)) {
        return json({
          data: { id: "run-floor", status: "SUCCEEDED", defaultKeyValueStoreId: "kv-f", usageTotalUsd: 0 },
        });
      }
      if (url.includes("/key-value-stores/kv-f/keys")) {
        return json({ data: { items: [{ key: "a.wav" }] } });
      }
      if (url.includes("/key-value-stores/kv-f/records/")) {
        return new Response(Buffer.from("wav"), { status: 200 });
      }
      return json({ data: { id: "run-floor", status: "SUCCEEDED", usageTotalUsd: 0 } });
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: VIDEO,
      startSec: 300,
      endSec: 320,
      cwd: dir,
      videoSeconds: 2738,
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => 20,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usd).toBeCloseTo(0.09);
    await rm(dir, { recursive: true, force: true });
  }, 10_000);

  it("does not fall back on a budget stop", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-budget-"));
    const posts: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/runs")) {
        posts.push(url);
        return json({ error: "limit" }, 402);
      }
      return json({});
    };
    const result = await downloadYoutubeSection({
      token: TOKEN,
      videoId: VIDEO,
      startSec: 0,
      endSec: 20,
      cwd: dir,
      videoSeconds: 2738,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("budget");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("entertained_rattlesnake");
    await rm(dir, { recursive: true, force: true });
  });
});
