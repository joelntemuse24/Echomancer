import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { getCatalogVoice, listCatalogVoices } from "@/lib/tts/catalog";
import { DREW_CACHE_VARIANT } from "@/lib/tts/drew-voice";
import { GEORGE_CACHE_VARIANT } from "@/lib/tts/george-voice";
import {
  HEART_CACHE_VARIANT,
  HEART_DISPLAY_NAME,
  heartReady,
} from "@/lib/tts/heart-voice";
import { resolveStockAdapter } from "@/lib/tts/providers";
import { takehomeCacheVariant } from "@/lib/tts/process-job";
import { hardMaxCharsForModel } from "@/lib/tts/section-size";
import { SOWELL_CACHE_VARIANT } from "@/lib/tts/sowell-voice";
import { isAvaVoice, isEdgeStockVoice, isLibbyVoice } from "@/lib/tts/standard-voice";
import { stockPreviewUrl } from "@/lib/tts/stock-preview";

const readyEnv = {
  HEART_ENABLED: "1",
  HEART_URL: "https://example.modal.run",
  HEART_TOKEN: "token",
} as NodeJS.ProcessEnv;

const drewEnv = {
  DREW_ENABLED: "1",
  DREW_URL: "https://example.modal.run",
  DREW_TOKEN: "token",
} as NodeJS.ProcessEnv;

const georgeEnv = {
  GEORGE_ENABLED: "1",
  GEORGE_URL: "https://example.modal.run",
  GEORGE_TOKEN: "token",
} as NodeJS.ProcessEnv;

afterEach(() => {
  for (const key of [
    "HEART_ENABLED",
    "HEART_URL",
    "HEART_TOKEN",
    "DREW_ENABLED",
    "DREW_URL",
    "DREW_TOKEN",
    "GEORGE_ENABLED",
    "GEORGE_URL",
    "GEORGE_TOKEN",
    "WORKER",
  ]) {
    delete process.env[key];
  }
});

describe("heart voice", () => {
  it("stays off the list until its own endpoint is set", async () => {
    expect(heartReady()).toBe(false);
    expect(await getCatalogVoice("heart")).toBeUndefined();
    const listed = (await listCatalogVoices()).map((voice) => voice.id);
    expect(listed).not.toContain("heart");
    expect(listed).toEqual(["ava", "libby"]);
  });

  it("lists Heart between Drew and George, under the one display-name constant", async () => {
    Object.assign(process.env, readyEnv, drewEnv, georgeEnv);
    const voice = await getCatalogVoice("heart");
    expect(voice?.provider).toBe("heart");
    expect(voice?.providerVoiceId).toBe("af_heart");
    expect(voice?.locale).toBe("en-US");
    expect(HEART_DISPLAY_NAME).toBe("Esther");
    expect(voice?.displayName).toBe("Esther");
    const listed = (await listCatalogVoices()).map((item) => item.id);
    expect(listed).toEqual(["drew", "heart", "george"]);
    expect(listed).not.toContain("ava");
    expect(listed).not.toContain("libby");
  });

  it("keeps a cache key apart from George, Drew, Walter, and stored Edge Ava", () => {
    expect(HEART_CACHE_VARIANT).toBe("kokoro82m-a-af_heart-f3ff3571791e");
    expect(takehomeCacheVariant("heart", "heart")).toBe(HEART_CACHE_VARIANT);
    expect(HEART_CACHE_VARIANT).not.toBe(GEORGE_CACHE_VARIANT);
    expect(HEART_CACHE_VARIANT).not.toBe(DREW_CACHE_VARIANT);
    expect(HEART_CACHE_VARIANT).not.toBe(SOWELL_CACHE_VARIANT);
    expect(takehomeCacheVariant("edge", "ava")).not.toBe(HEART_CACHE_VARIANT);
    expect(takehomeCacheVariant("edge", "libby")).not.toBe(HEART_CACHE_VARIANT);
    expect(hardMaxCharsForModel({ provider: "heart", model: "kokoro/af_heart" })).toBe(
      2000
    );
  });

  it("posts af_heart and refuses audio that did not confirm it", async () => {
    Object.assign(process.env, readyEnv);
    let posted = "";
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        posted = Buffer.concat(chunks).toString("utf8");
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
        res.writeHead(200, {
          "content-type": "audio/wav",
          "x-kokoro-voice": "af_heart",
        });
        res.end(Buffer.concat([header, Buffer.alloc(200, 7)]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.HEART_URL = `http://127.0.0.1:${port}`;
    delete process.env.WORKER;
    try {
      const adapter = resolveStockAdapter({
        provider: "heart",
        catalogVoiceId: "heart",
        model: "kokoro/af_heart",
      });
      expect(adapter.id).toBe("heart");
      const audio = await adapter.synthesize({ text: "The harbor was quiet.", voice: "af_heart" });
      expect(audio.contentType).toBe("audio/wav");
      const body = JSON.parse(posted) as { voice?: string; speed?: number };
      expect(body.voice).toBe("af_heart");
      expect(body.speed).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const silent: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(Buffer.alloc(1200, 1));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const silentAddress = silent.address();
    const silentPort =
      typeof silentAddress === "object" && silentAddress ? silentAddress.port : 0;
    process.env.HEART_URL = `http://127.0.0.1:${silentPort}`;
    try {
      const adapter = resolveStockAdapter({
        provider: "heart",
        catalogVoiceId: "heart",
      });
      await expect(adapter.synthesize({ text: "Hello.", voice: "af_heart" })).rejects.toThrow(
        /af_heart/
      );
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("serves Esther's sample for her card and Ava's own sample while Ava is listed", () => {
    expect(stockPreviewUrl("heart")).toBe("/voice-previews/heart.mp3");
    expect(stockPreviewUrl("ava")).toBe("/voice-previews/ava.mp3");
    expect(stockPreviewUrl("libby")).toBe("/voice-previews/libby.mp3");
    const file = path.join(process.cwd(), "public/voice-previews/heart.mp3");
    expect(existsSync(file)).toBe(true);
    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { encoding: "utf8" }
    );
    expect(probe.status, probe.stderr).toBe(0);
    const duration = Number(probe.stdout.trim());
    expect(duration).toBeGreaterThan(1);
    expect(duration).toBeLessThan(15);
  });

  it("still speaks a stored Ava or Libby row on Edge", () => {
    expect(
      isAvaVoice({
        id: "ava",
        provider: "edge",
        providerVoiceId: "en-US-AvaNeural",
        model: "edge/en-US-AvaNeural",
      })
    ).toBe(true);
    expect(isEdgeStockVoice({ id: "ava", provider: "edge" })).toBe(true);
    expect(isEdgeStockVoice({ id: "heart", provider: "heart" })).toBe(false);
    expect(isLibbyVoice({ id: "libby", provider: "edge" })).toBe(true);
    expect(
      resolveStockAdapter({
        provider: "edge",
        catalogVoiceId: "ava",
        model: "edge/en-US-AvaNeural",
      }).id
    ).toBe("edge");
    expect(
      resolveStockAdapter({
        provider: "edge",
        catalogVoiceId: "libby",
        model: "edge/en-GB-LibbyNeural",
      }).id
    ).toBe("edge");
    expect(
      resolveStockAdapter({
        provider: "fish",
        catalogVoiceId: "clara",
        model: "s2.1-pro-free",
      }).id
    ).toBe("fish");
  });
});
