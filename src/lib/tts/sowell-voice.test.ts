import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCatalogVoices, getCatalogVoice } from "@/lib/tts/catalog";
import { resolveStockAdapter } from "@/lib/tts/providers";
import { splitSowellText } from "@/lib/tts/providers/sowell";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";
import { voicesForPath } from "@/lib/voice-path";
import { takehomeCacheVariant } from "@/lib/tts/process-job";
import { hardMaxCharsForModel } from "@/lib/tts/section-size";
import {
  SOWELL_CACHE_VARIANT,
  SOWELL_IN_FLIGHT,
  SOWELL_MAX_CHARS,
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
    expect(voicesForPath(listed, "standard").map((voice) => voice.id)).toEqual([
      ...SLIM_STOCK_VOICE_IDS,
    ]);
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
    const catalog = await listCatalogVoices();
    const listed = catalog.map((item) => item.id);
    expect(listed.slice(0, 5)).toEqual([...SLIM_STOCK_VOICE_IDS]);
    expect(listed).toContain("sowell");
    expect(voicesForPath(catalog, "standard").map((voice) => voice.id)).toEqual([
      ...SLIM_STOCK_VOICE_IDS,
      "sowell",
    ]);
    expect(voicesForPath(catalog, "standard").at(-1)?.displayName).toMatch(/^Sowell/);
    expect(takehomeCacheVariant("sowell", "sowell")).toBe(SOWELL_CACHE_VARIANT);
    expect(takehomeCacheVariant("edge", "standard")).not.toBe(SOWELL_CACHE_VARIANT);
    expect(takehomeCacheVariant("paradee", "echomancer-andrew")).toBe("paradee-paragraph-v1");
    expect(hardMaxCharsForModel({ provider: "sowell", catalogMax: 4000 })).toBe(SOWELL_MAX_CHARS);
    expect(SOWELL_IN_FLIGHT).toBe(2);
    expect(SOWELL_MAX_CHARS).toBe(2000);
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
      expect(sent.text.length).toBeLessThanOrEqual(SOWELL_MAX_CHARS);
      expect(sent.text).toContain("The harbor was quiet.");
      expect(auth).toBe("Bearer token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runs two pieces at once, keeps order, and drops the take on a later error", async () => {
    Object.assign(process.env, readyEnv);
    const piece = "The harbor was quiet after the rain. ";
    const text = piece.repeat(80);
    expect(text.length).toBeGreaterThan(SOWELL_MAX_CHARS);
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const sent = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text: string };
        seen.push(sent.text);
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          if (sent.text.includes("FAIL")) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          const header = Buffer.alloc(44);
          header.write("RIFF", 0);
          header.writeUInt32LE(36 + 200, 4);
          header.write("WAVE", 8);
          header.write("fmt ", 12);
          header.writeUInt32LE(16, 16);
          header.writeUInt16LE(1, 20);
          header.writeUInt16LE(1, 22);
          header.writeUInt32LE(24000, 24);
          header.writeUInt32LE(48000, 28);
          header.writeUInt16LE(2, 32);
          header.writeUInt16LE(16, 34);
          header.write("data", 36);
          header.writeUInt32LE(200, 40);
          const mark = Buffer.alloc(200, sent.text.length % 251);
          res.writeHead(200, { "content-type": "audio/wav" });
          res.end(Buffer.concat([header, mark]));
        }, 80);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.SOWELL_URL = `http://127.0.0.1:${port}`;
    const adapter = resolveStockAdapter({ provider: "sowell", catalogVoiceId: "sowell" });
    try {
      const audio = await adapter.synthesize({ text, voice: "am_sowell_avg" });
      const pieces = splitSowellText(text);
      expect(pieces.length).toBeGreaterThan(1);
      expect(peak).toBe(SOWELL_IN_FLIGHT);
      expect(new Set(seen)).toEqual(new Set(pieces));
      expect(pieces.join(" ")).toBe(text.trim());
      const pcm = audio.audio.subarray(44);
      expect(pcm.length).toBe(200 * pieces.length);
      pieces.forEach((pieceText, index) => {
        const mark = pieceText.length % 251;
        const slice = pcm.subarray(index * 200, (index + 1) * 200);
        expect(slice.every((byte) => byte === mark)).toBe(true);
      });
      await expect(
        adapter.synthesize({ text: `${text} FAIL the second half please.`, voice: "am_sowell_avg" })
      ).rejects.toThrow(/Sowell TTS 500/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps one resident runtime in the Modal class and does not spawn per request", () => {
    const source = readFileSync(path.join(process.cwd(), "modal/sowell_worker.py"), "utf8");
    expect(source).toContain("@modal.enter()");
    expect(source).toContain("min_containers=0");
    expect(source).toContain('max_containers=int(os.environ.get("SOWELL_MAX_CONTAINERS", "2"))');
    expect(source).toContain("cpu=2");
    expect(source).toContain("memory=4096");
    expect(source).toContain("max_inputs=1");
    expect(source).toContain("timing_headers");
    expect(source).not.toContain("subprocess");
    expect(source).not.toContain("/tmp/sowell.wav");
    const engine = readFileSync(path.join(process.cwd(), "scripts/sowell/engine.py"), "utf8");
    expect(engine).toContain("init_count += 1");
    expect(engine).toContain("refusing to drop text");
  });

  it("rejects a malformed pack when torch is installed", () => {
    const probe = spawnSync("python3", ["-c", "import torch"], { encoding: "utf8" });
    if (probe.status !== 0) return;
    const run = spawnSync("python3", [path.join(process.cwd(), "scripts/sowell/test_pack.py")], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const resident = spawnSync(
      "python3",
      [path.join(process.cwd(), "scripts/sowell/test_engine.py")],
      { encoding: "utf8" }
    );
    expect(resident.status, resident.stderr).toBe(0);
  });
});
