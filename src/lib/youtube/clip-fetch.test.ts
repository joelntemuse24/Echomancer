import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { downloadYoutubeSection } from "./clip-fetch";

describe("downloadYoutubeSection", () => {
  it("runs the actor, downloads the file, and keeps the token out of the result", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-clip-"));
    const token = "secret-apify-token";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).not.toContain(token);
      expect(init?.headers && JSON.stringify(init.headers)).toContain(token);
      if (url.endsWith("/runs")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          url: "https://www.youtube.com/watch?v=abcdefghijk",
          audioQuality: "best",
          timeframe: "0:30-0:50",
        });
        return Response.json({
          data: { id: "run-9", status: "SUCCEEDED", defaultDatasetId: "ds-1", usageTotalUsd: 0.015 },
        });
      }
      if (url.includes("/datasets/ds-1/items")) {
        return Response.json([
          {
            downloadUrl: "https://api.apify.com/v2/key-value-stores/x/records/audio",
            filename: "talk.m4a",
            duration: 20,
          },
        ]);
      }
      return new Response(Buffer.from("audio-bytes"), {
        status: 200,
        headers: { "content-length": "11" },
      });
    };
    const result = await downloadYoutubeSection({
      token,
      videoId: "abcdefghijk",
      startSec: 30,
      endSec: 50,
      cwd: dir,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runId).toBe("run-9");
    expect(result.usd).toBeCloseTo(0.015);
    expect(result.bytes).toBe(11);
    expect(await readFile(result.file, "utf8")).toBe("audio-bytes");
    expect(JSON.stringify(result)).not.toContain(token);
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a file past 8 MB before saving it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "apify-big-"));
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs")) {
        return Response.json({
          data: { id: "run-big", status: "SUCCEEDED", defaultDatasetId: "ds-big", usageTotalUsd: 0.02 },
        });
      }
      if (url.includes("/items")) {
        return Response.json([{ downloadUrl: "https://cdn.example/audio.m4a", duration: 20 }]);
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
