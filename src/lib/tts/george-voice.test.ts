import { createServer, type Server } from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getCatalogVoice, listCatalogVoices } from "@/lib/tts/catalog";
import { GEORGE_CACHE_VARIANT, georgeReady } from "@/lib/tts/george-voice";
import { resolveStockAdapter } from "@/lib/tts/providers";
import { takehomeCacheVariant } from "@/lib/tts/process-job";
import { hardMaxCharsForModel } from "@/lib/tts/section-size";
import { isRyanVoice } from "@/lib/tts/standard-voice";

const readyEnv = {
  GEORGE_ENABLED: "1",
  GEORGE_URL: "https://example.modal.run",
  GEORGE_TOKEN: "token",
} as NodeJS.ProcessEnv;

afterEach(() => {
  delete process.env.GEORGE_ENABLED;
  delete process.env.GEORGE_URL;
  delete process.env.GEORGE_TOKEN;
  delete process.env.WORKER;
});

describe("george voice", () => {
  it("stays off the list until its own endpoint is set", async () => {
    expect(georgeReady()).toBe(false);
    expect(await getCatalogVoice("george")).toBeUndefined();
    const listed = (await listCatalogVoices()).map((voice) => voice.id);
    expect(listed).not.toContain("george");
    expect(listed).not.toContain("ryan");
    expect(listed).toEqual(["standard", "echomancer-andrew", "ava", "libby"]);
  });

  it("lists George on the Kokoro CPU adapter and does not call OpenRouter", async () => {
    Object.assign(process.env, readyEnv);
    const voice = await getCatalogVoice("george");
    expect(voice?.provider).toBe("george");
    expect(voice?.providerVoiceId).toBe("bm_george");
    expect(voice?.locale).toBe("en-GB");
    expect(voice?.displayName).toMatch(/^George/);
    const listed = (await listCatalogVoices()).map((item) => item.id);
    expect(listed).toContain("george");
    expect(listed).not.toContain("ryan");
    expect(takehomeCacheVariant("george", "george")).toBe(GEORGE_CACHE_VARIANT);
    expect(takehomeCacheVariant("edge", "ryan")).not.toBe(GEORGE_CACHE_VARIANT);
    expect(takehomeCacheVariant("sowell", "sowell")).not.toBe(GEORGE_CACHE_VARIANT);
    expect(hardMaxCharsForModel({ provider: "george", model: "kokoro/bm_george" })).toBe(2000);

    let posted = "";
    let host = "";
    const server: Server = createServer((req, res) => {
      host = req.headers.host || "";
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
          "x-kokoro-voice": "bm_george",
        });
        res.end(Buffer.concat([header, Buffer.alloc(200, 7)]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.GEORGE_URL = `http://127.0.0.1:${port}`;
    delete process.env.WORKER;
    try {
      const adapter = resolveStockAdapter({
        provider: "george",
        catalogVoiceId: "george",
        model: "kokoro/bm_george",
      });
      expect(adapter.id).toBe("george");
      const audio = await adapter.synthesize({
        text: "The harbour was quiet.",
        voice: "bm_george",
      });
      expect(audio.contentType).toBe("audio/wav");
      const body = JSON.parse(posted) as { voice?: string; text?: string };
      expect(body.voice).toBe("bm_george");
      expect(body.text).toContain("harbour");
      expect(host).not.toContain("openrouter");
      expect(posted).not.toContain("en-GB-RyanNeural");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses audio that did not confirm bm_george", async () => {
    Object.assign(process.env, readyEnv);
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(Buffer.alloc(1200, 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.GEORGE_URL = `http://127.0.0.1:${port}`;
    delete process.env.WORKER;
    try {
      const adapter = resolveStockAdapter({ provider: "george", catalogVoiceId: "george" });
      await expect(
        adapter.synthesize({ text: "Hello.", voice: "bm_george" })
      ).rejects.toThrow(/bm_george/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("still recognises a stored Ryan row as Edge", () => {
    expect(
      isRyanVoice({
        id: "ryan",
        provider: "edge",
        providerVoiceId: "en-GB-RyanNeural",
        model: "edge/en-GB-RyanNeural",
      })
    ).toBe(true);
    expect(
      resolveStockAdapter({
        provider: "edge",
        catalogVoiceId: "ryan",
        model: "edge/en-GB-RyanNeural",
      }).id
    ).toBe("edge");
  });

  it("pins the container allowlist in the image sources", () => {
    const worker = readFileSync(path.join(process.cwd(), "modal/sowell_worker.py"), "utf8");
    expect(worker).toContain("canonical_kokoro_voice");
    expect(worker).toContain("x-kokoro-voice");
    expect(worker).toContain('max_containers=int(os.environ.get("SOWELL_MAX_CONTAINERS", "2"))');
    // The allowlist itself runs in the GPU image, which imports torch. Without
    // it there is nothing to run: skipping says so, where a failure used to
    // report a broken allowlist that was never exercised.
    const torch = spawnSync("python3", ["-c", "import torch"], { encoding: "utf8" });
    if (torch.status !== 0) {
      console.warn(
        "skipping the voice-allowlist execution check: python3 has no torch " +
          "(the GPU image installs it; a bare CI runner does not)"
      );
      return;
    }
    const run = spawnSync(
      "python3",
      [path.join(process.cwd(), "scripts/sowell/test_voice_allowlist.py")],
      { encoding: "utf8" }
    );
    expect(run.status, run.stderr || run.stdout).toBe(0);
  });
});
