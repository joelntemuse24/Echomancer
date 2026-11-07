import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCatalogVoices, getCatalogVoice } from "@/lib/tts/catalog";
import { resolveStockAdapter } from "@/lib/tts/providers";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";
import { takehomeCacheVariant } from "@/lib/tts/process-job";
import { hardMaxCharsForModel } from "@/lib/tts/section-size";
import {
  SOWELL_CACHE_VARIANT,
  SowellNotConfiguredError,
  sowellEndpoint,
  sowellReady,
} from "@/lib/tts/sowell-voice";

const readyEnv = {
  SOWELL_ENABLED: "1",
  SOWELL_URL: "https://example.modal.run",
  SOWELL_TOKEN: "token",
} as NodeJS.ProcessEnv;

afterEach(() => {
  delete process.env.SOWELL_ENABLED;
  delete process.env.SOWELL_URL;
  delete process.env.SOWELL_TOKEN;
  delete process.env.WORKER;
});

describe("sowell voice", () => {
  it("stays out of the slim list and fails closed until configured", async () => {
    expect(SLIM_STOCK_VOICE_IDS).not.toContain("sowell");
    expect(sowellReady()).toBe(false);
    expect(await getCatalogVoice("sowell")).toBeUndefined();
    const listed = await listCatalogVoices();
    expect(listed.map((voice) => voice.id)).not.toContain("sowell");
    expect(() => sowellEndpoint()).toThrow(SowellNotConfiguredError);
    await expect(
      resolveStockAdapter({ provider: "sowell", catalogVoiceId: "sowell" }).synthesize({
        text: "Hello.",
        voice: "am_sowell_avg",
      })
    ).rejects.toThrow(/not enabled|not configured/);
  });

  it("lists Sowell only when the endpoint is ready and keeps other voices", async () => {
    Object.assign(process.env, readyEnv);
    expect(sowellReady()).toBe(true);
    const voice = await getCatalogVoice("sowell");
    expect(voice?.provider).toBe("sowell");
    expect(voice?.displayName).toMatch(/^Sowell/);
    const listed = (await listCatalogVoices()).map((item) => item.id);
    expect(listed.slice(0, 5)).toEqual([...SLIM_STOCK_VOICE_IDS]);
    expect(listed).toContain("sowell");
    expect(takehomeCacheVariant("sowell", "sowell")).toBe(SOWELL_CACHE_VARIANT);
    expect(takehomeCacheVariant("edge", "standard")).not.toBe(SOWELL_CACHE_VARIANT);
    expect(takehomeCacheVariant("paradee", "echomancer-andrew")).toBe("paradee-paragraph-v1");
    expect(hardMaxCharsForModel({ provider: "sowell", catalogMax: 4000 })).toBe(280);
    const { isTakehomeFriendly } = await import("@/lib/tts/voice-persona");
    expect(isTakehomeFriendly(voice!)).toBe(true);
  });

  it("refuses a path and refuses loopback on the take-home VM", () => {
    expect(() =>
      sowellEndpoint({
        ...readyEnv,
        SOWELL_URL: "https://example.modal.run/speak",
      })
    ).toThrow(/no path/);
    expect(() =>
      sowellEndpoint({
        ...readyEnv,
        WORKER: "1",
        SOWELL_URL: "http://127.0.0.1:8792",
      })
    ).toThrow(/take-home VM/);
  });

  it("does not substitute another narrator and posts only the configured host", async () => {
    Object.assign(process.env, readyEnv);
    const adapter = resolveStockAdapter({
      provider: "edge",
      catalogVoiceId: "sowell",
      model: "edge/en-US-AndrewNeural",
    });
    expect(adapter.id).toBe("sowell");
    let body = "";
    let auth = "";
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        auth = req.headers.authorization || "";
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(Buffer.alloc(1200, 1));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.SOWELL_URL = `http://127.0.0.1:${port}`;
    delete process.env.WORKER;
    try {
      const audio = await adapter.synthesize({
        text: "The harbor was quiet. ".repeat(40),
        voice: "am_sowell_avg",
      });
      expect(audio.contentType).toBe("audio/wav");
      expect(audio.audio.length).toBeGreaterThan(1000);
      const sent = JSON.parse(body) as { text: string };
      expect(sent.text.length).toBeLessThanOrEqual(280);
      expect(auth).toBe("Bearer token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a malformed pack when torch is installed", () => {
    const probe = spawnSync("python3", ["-c", "import torch"], { encoding: "utf8" });
    if (probe.status !== 0) return;
    const run = spawnSync("python3", [path.join(process.cwd(), "scripts/sowell/test_pack.py")], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
  });
});
