import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCatalogVoice, listCatalogVoices, DEFAULT_VOICE_ID } from "@/lib/tts/catalog";
import { resolveStockAdapter } from "@/lib/tts/providers";
import { takehomeCacheVariant } from "@/lib/tts/process-job";
import { hardMaxCharsForModel, maxCharsForModel } from "@/lib/tts/section-size";
import { voicesForPath } from "@/lib/voice-path";
import { stockPreviewUrl } from "@/lib/tts/stock-preview";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";
import {
  DREW_CACHE_VARIANT,
  drewCacheIdentity,
  drewRuntimeLabel,
  drewTakeMismatch,
  DREW_PROSODY_G_SUFFIX,
  DREW_FIXED_STYLE_INDEX,
  DREW_IN_FLIGHT,
  DREW_MAX_CHARS,
  DREW_NATIVE_KOKORO_SPEED,
  DREW_PROVIDER_VOICE_ID,
  DREW_KMODEL_PATH,
  DREW_VOICE_PACK_PATH,
  DREW_VOLUME_NAME,
  DREW_WEIGHTS_ID,
  DrewNotConfiguredError,
  drewCacheVariant,
  drewEnabled,
  drewEndpoint,
  drewKokoroSpeed,
  drewProsodyField,
  drewProsodyRulesEnabled,
  drewReady,
} from "@/lib/tts/drew-voice";

const readyEnv = {
  DREW_ENABLED: "1",
  DREW_URL: "https://example.modal.run",
  DREW_TOKEN: "token",
} as NodeJS.ProcessEnv;

function clearDrewEnv() {
  delete process.env.DREW_ENABLED;
  delete process.env.DREW_URL;
  delete process.env.DREW_TOKEN;
  delete process.env.WORKER;
  delete process.env.DREW_PROSODY_RULES;
}

function wavBody(): Buffer {
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
  return Buffer.concat([header, Buffer.alloc(200, 5)]);
}

afterEach(() => {
  clearDrewEnv();
});

describe("Drew identity", () => {
  it("is the app default and the first slim id", async () => {
    expect(DEFAULT_VOICE_ID).toBe("drew");
    expect(SLIM_STOCK_VOICE_IDS[0]).toBe("drew");
    Object.assign(process.env, readyEnv);
    const listed = await listCatalogVoices();
    expect(listed[0]!.id).toBe("drew");
    expect(listed[0]!.displayName).toBe("Drew");
    expect(listed[0]!.provider).toBe("drew");
    expect(listed.map((voice) => voice.id)).not.toContain("standard");
    expect(listed.map((voice) => voice.id)).not.toContain("echomancer-andrew");
    expect(voicesForPath(listed, "standard")[0]?.displayName).toBe("Drew");
  });

  it("fails closed until configured and never falls back to Edge Andrew", async () => {
    expect(drewReady()).toBe(false);
    expect(drewEnabled()).toBe(false);
    expect(await getCatalogVoice("drew")).toBeUndefined();
    expect(() => drewEndpoint()).toThrow(DrewNotConfiguredError);
    await expect(
      resolveStockAdapter({ provider: "drew", catalogVoiceId: "drew" }).synthesize({
        text: "Hello.",
        voice: DREW_PROVIDER_VOICE_ID,
      })
    ).rejects.toThrow(/not enabled|not configured/);
  });

  it("refuses a path and refuses loopback on the take-home VM", () => {
    expect(() =>
      drewEndpoint({ ...readyEnv, DREW_URL: "https://example.modal.run/speak" })
    ).toThrow(/no path/);
    expect(() =>
      drewEndpoint({
        ...readyEnv,
        WORKER: "1",
        DREW_URL: "http://127.0.0.1:8793",
      })
    ).toThrow(/take-home VM/);
  });

  it("pins the private volume paths the bot uploads to", () => {
    expect(DREW_VOLUME_NAME).toBe("andrew-distill");
    expect(DREW_KMODEL_PATH).toBe(
      "/kokoro/retrain_v3/stageA/step00900_kmodel.pth"
    );
    expect(DREW_VOICE_PACK_PATH).toBe(
      "/kokoro/retrain_v3/stageA/step00900_voice.pt"
    );
  });

  it("has its own take-home cache variant and section ceiling", () => {
    expect(takehomeCacheVariant("drew", "drew")).toBe(DREW_CACHE_VARIANT);
    expect(takehomeCacheVariant("edge", "standard")).not.toBe(DREW_CACHE_VARIANT);
    expect(takehomeCacheVariant("sowell", "sowell")).not.toBe(DREW_CACHE_VARIANT);
    expect(takehomeCacheVariant("george", "george")).not.toBe(DREW_CACHE_VARIANT);
    expect(maxCharsForModel({ provider: "drew", model: "kokoro/drew" })).toBe(
      DREW_MAX_CHARS
    );
    expect(
      hardMaxCharsForModel({
        provider: "drew",
        model: "kokoro/drew",
        catalogMax: 4000,
      })
    ).toBe(DREW_MAX_CHARS);
    expect(DREW_IN_FLIGHT).toBe(2);
    expect(DREW_CACHE_VARIANT).toBe(
      `drew-kokoro82m-ft-${DREW_WEIGHTS_ID}-style${DREW_FIXED_STYLE_INDEX}-torch-speed1.000`
    );
    expect(drewRuntimeLabel({})).toBe("torch");
    expect(drewRuntimeLabel({ KOKORO_RUNTIME: "onnx" } as NodeJS.ProcessEnv)).toBe("onnx");
    expect(drewCacheIdentity({ KOKORO_RUNTIME: "onnx" } as NodeJS.ProcessEnv)).toContain(
      "-onnx-speed1.000"
    );
    expect(drewCacheIdentity({ KOKORO_RUNTIME: "onnx" } as NodeJS.ProcessEnv)).not.toBe(
      DREW_CACHE_VARIANT
    );
    expect(takehomeCacheVariant("sowell", "sowell")).not.toContain("style");
    expect(takehomeCacheVariant("george", "george")).not.toContain("style");
    delete process.env.DREW_PROSODY_RULES;
    expect(drewProsodyRulesEnabled()).toBe(false);
    expect(drewProsodyField()).toBeUndefined();
    expect(drewCacheVariant()).toBe(DREW_CACHE_VARIANT);
  });

  it("moves only Drew's cache key when variant G is on", () => {
    const sowell = takehomeCacheVariant("sowell", "sowell");
    const george = takehomeCacheVariant("george", "george");
    process.env.DREW_PROSODY_RULES = "1";
    try {
      expect(drewProsodyRulesEnabled()).toBe(true);
      expect(drewProsodyField()).toBe("G");
      expect(takehomeCacheVariant("drew", "drew")).toBe(
        `${DREW_CACHE_VARIANT}${DREW_PROSODY_G_SUFFIX}`
      );
      expect(DREW_PROSODY_G_SUFFIX).toBe("-prosodyG");
      expect(takehomeCacheVariant("sowell", "sowell")).toBe(sowell);
      expect(takehomeCacheVariant("george", "george")).toBe(george);
    } finally {
      delete process.env.DREW_PROSODY_RULES;
    }
    expect(takehomeCacheVariant("drew", "drew")).toBe(DREW_CACHE_VARIANT);
    expect(drewProsodyRulesEnabled({ DREW_PROSODY_RULES: "0" })).toBe(false);
    expect(drewProsodyRulesEnabled({ DREW_PROSODY_RULES: "" })).toBe(false);
  });

  it("serves a committed Drew preview", () => {
    expect(stockPreviewUrl("drew")).toBe("/voice-previews/drew.mp3");
    expect(stockPreviewUrl("standard")).toBe("/voice-previews/drew.mp3");
    expect(stockPreviewUrl("echomancer-andrew")).toBe("/voice-previews/drew.mp3");
    expect(stockPreviewUrl("sowell")).toBe("/voice-previews/sowell.mp3");
  });
});

describe("Drew speed mapping", () => {
  it("treats 1.0 as native 1x", () => {
    expect(DREW_NATIVE_KOKORO_SPEED).toBe(1);
    expect(drewKokoroSpeed(1)).toBe(1);
    expect(drewKokoroSpeed(undefined)).toBe(1);
    expect(drewKokoroSpeed(null)).toBe(1);
  });

  it("scales from native pace instead of slowing further", () => {
    // 1.0 is natural. The container multiplies once, so 1.0 stays 1.0.
    expect(drewKokoroSpeed(1)).toBe(1);
    expect(drewKokoroSpeed(0.95)).toBe(0.95);
    expect(drewKokoroSpeed(1.2)).toBe(1.2);
  });

  it("clamps to what the container accepts", () => {
    expect(drewKokoroSpeed(0)).toBe(1);
    expect(drewKokoroSpeed(-3)).toBe(1);
    expect(drewKokoroSpeed(0.01)).toBe(0.5);
    expect(drewKokoroSpeed(100)).toBe(2);
    expect(drewKokoroSpeed(Number.NaN)).toBe(1);
  });
});

describe("Drew provider", () => {
  let server: Server | null = null;

  beforeEach(() => {
    Object.assign(process.env, readyEnv);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function listen(
    handler: (posted: string, res: import("node:http").ServerResponse) => void
  ): Promise<string> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => handler(Buffer.concat(chunks).toString("utf8"), res));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("sends the app speed once and never posts a vendor id", async () => {
    const seen: Record<string, unknown>[] = [];
    const url = await listen((body, res) => {
      seen.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, {
        "content-type": "audio/wav",
        "x-kokoro-voice": DREW_PROVIDER_VOICE_ID,
        "x-kokoro-speed": "1.0",
        "x-kokoro-runtime": "torch",
      });
      res.end(wavBody());
    });
    process.env.DREW_URL = url;
    delete process.env.WORKER;

    const audio = await resolveStockAdapter({
      provider: "drew",
      catalogVoiceId: "drew",
      model: "kokoro/drew",
    }).synthesize({
      text: "The harbor was quiet after the rain.",
      voice: DREW_PROVIDER_VOICE_ID,
      speed: 1,
    });

    expect(audio.contentType).toBe("audio/wav");
    expect(audio.audio.length).toBe(244);
    expect(seen).toHaveLength(1);
    // The container multiplies by 1.0. The worker sends the app's 1.0 unchanged so
    // the multiply happens exactly once.
    expect(seen[0]!.speed).toBe(1);
    expect(seen[0]!.voice).toBe("drew");
    expect(String(seen[0]!.text)).toContain("harbor");
    // Flag off: the field is absent, so an older container's stock forward
    // is what this cache key stores.
    expect(seen[0]).not.toHaveProperty("prosody");
  });

  it("asks for G and refuses audio that did not apply it", async () => {
    const seen: Record<string, unknown>[] = [];
    const url = await listen((body, res) => {
      seen.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, {
        "content-type": "audio/wav",
        "x-kokoro-voice": DREW_PROVIDER_VOICE_ID,
      });
      res.end(wavBody());
    });
    process.env.DREW_URL = url;
    process.env.DREW_PROSODY_RULES = "1";
    delete process.env.WORKER;
    await expect(
      resolveStockAdapter({ provider: "drew", catalogVoiceId: "drew" }).synthesize({
        text: "Is the harbor quiet?",
        voice: DREW_PROVIDER_VOICE_ID,
      })
    ).rejects.toThrow(/prosody G/i);
    expect(seen[0]!.prosody).toBe("G");
    expect(seen[0]!.speed).toBe(1);
  });

  it("stores audio when the container confirms G", async () => {
    const url = await listen((_body, res) => {
      res.writeHead(200, {
        "content-type": "audio/wav",
        "x-kokoro-voice": DREW_PROVIDER_VOICE_ID,
        "x-kokoro-prosody": "G",
        "x-kokoro-speed": "1.0",
        "x-kokoro-runtime": "torch",
      });
      res.end(wavBody());
    });
    process.env.DREW_URL = url;
    process.env.DREW_PROSODY_RULES = "1";
    delete process.env.WORKER;
    const audio = await resolveStockAdapter({
      provider: "drew",
      catalogVoiceId: "drew",
    }).synthesize({
      text: "Is the harbor quiet?",
      voice: DREW_PROVIDER_VOICE_ID,
    });
    expect(audio.audio.length).toBe(244);
  });

  it("refuses a take whose Kokoro speed or runtime is not the cache key", async () => {
    const headers = new Headers({ "x-kokoro-speed": "0.88", "x-kokoro-runtime": "torch" });
    expect(drewTakeMismatch(headers, 1)).toMatch(/0\.88/);
    expect(drewTakeMismatch(headers, 1)).toMatch(/not stored/i);
    const otherGraph = new Headers({ "x-kokoro-speed": "1", "x-kokoro-runtime": "onnx" });
    expect(drewTakeMismatch(otherGraph, 1)).toMatch(/onnx/);
    expect(drewTakeMismatch(new Headers({ "x-kokoro-speed": "1" }), 1)).toMatch(/unknown/);
    const url = await listen((_body, res) => {
      res.writeHead(200, {
        "content-type": "audio/wav",
        "x-kokoro-voice": DREW_PROVIDER_VOICE_ID,
        "x-kokoro-speed": "0.88",
        "x-kokoro-runtime": "torch",
      });
      res.end(wavBody());
    });
    process.env.DREW_URL = url;
    delete process.env.WORKER;
    delete process.env.KOKORO_RUNTIME;
    await expect(
      resolveStockAdapter({ provider: "drew", catalogVoiceId: "drew" }).synthesize({
        text: "The harbor was quiet.",
        voice: DREW_PROVIDER_VOICE_ID,
        speed: 1,
      })
    ).rejects.toThrow(/not stored/i);
  });

  it("refuses audio that did not confirm the Drew voice", async () => {
    const url = await listen((_body, res) => {
      // An older app that answers for Sowell must not be stored as Drew.
      res.writeHead(200, {
        "content-type": "audio/wav",
        "x-kokoro-voice": "am_sowell",
      });
      res.end(wavBody());
    });
    process.env.DREW_URL = url;
    delete process.env.WORKER;
    await expect(
      resolveStockAdapter({ provider: "drew", catalogVoiceId: "drew" }).synthesize({
        text: "Hello.",
        voice: DREW_PROVIDER_VOICE_ID,
      })
    ).rejects.toThrow(/did not confirm/i);
  });

  it("routes a Drew catalog id to the Drew adapter even with an Edge-shaped hint", () => {
    const adapter = resolveStockAdapter({
      provider: "edge",
      catalogVoiceId: "drew",
      model: "edge/en-US-AndrewNeural",
    });
    expect(adapter.id).toBe("drew");
  });
});

describe("Drew on the Modal CPU app", () => {
  it("loads as a second resident model with a volume, not a third fleet", () => {
    const worker = readFileSync(
      path.join(process.cwd(), "modal/sowell_worker.py"),
      "utf8"
    );
    expect(worker).toContain("modal.Volume.from_name");
    expect(worker).toContain('"andrew-distill"');
    expect(worker).toContain("min_containers=0");
    expect(worker).toContain("max_containers=max_containers()");
    // ONNX memory is measured. Torch stays at 6144, one call per container.
    expect(worker).toContain("memory=memory_mb()");
    expect(worker).toContain("TORCH_MEMORY_MB = 6144");
    expect(worker).toContain("@modal.concurrent(max_inputs=STREAMS)");
    expect(worker).toContain("load_assets()");
    expect(worker).toContain("open_sessions()");
    expect(worker).toContain("ensure_drew()");
    expect(worker).toContain("ONNX_MEMORY_MB_DEFAULT = 5120");
    expect(worker).toContain("load_drew()");
    expect(worker).toContain("DREW_UNAVAILABLE");
    expect(worker).toContain('raw_prosody == "G"');
    expect(worker).toContain('headers["x-kokoro-prosody"]');

    const drew = readFileSync(
      path.join(process.cwd(), "scripts/sowell/drew.py"),
      "utf8"
    );
    expect(drew).toContain("DREW_NATIVE_KOKORO_SPEED = 1.0");
    const index = drew.match(/DREW_FIXED_STYLE_INDEX = (\d+)/);
    expect(index, drew).toBeTruthy();
    expect(DREW_FIXED_STYLE_INDEX).toBe(Number(index![1]));
    expect(drew).toContain("PACK_SHAPE = (510, 1, 256)");
    expect(drew).toContain("KModel(model=str(path))");
    expect(drew).toContain(
      'DREW_KMODEL_PATH = "/kokoro/retrain_v3/stageA/step00900_kmodel.pth"'
    );
    expect(drew).toContain(
      'DREW_VOICE_PACK_PATH = "/kokoro/retrain_v3/stageA/step00900_voice.pt"'
    );
  });

  it("multiplies the speed once, in the container", () => {
    const engine = readFileSync(
      path.join(process.cwd(), "scripts/sowell/engine.py"),
      "utf8"
    );
    // Drew picks its own kokoro speed; Walter and George stay at 1.0.
    expect(engine).toContain("kokoro_speed = drew_speed(speed)");
    expect(engine).toContain("kokoro_speed = 1.0");
    expect(engine).toContain("pipeline_cls.infer(");
    // No recipe: the same infer, with the hooks not installed.
    expect(engine).toContain("if recipe is None:");
    expect(engine).toContain("prosody_hooks(");
    expect(engine).toContain("pin_style(");
    expect(engine).toContain("fixed_style_index(");
    expect(engine).toContain("kokoro_speed");
    // Importing Kokoro is lazy so the speed plumbing is testable without it.
    expect(engine).toContain("def kpipeline()");
  });

  it("executes the 1.0 multiply through the resident engine", () => {
    // The Python suite stubs Kokoro but uses real torch, so this runs the
    // actual `_render_locked` speed path. A double multiply fails here.
    const torch = spawnSync("python3", ["-c", "import torch"], { encoding: "utf8" });
    if (torch.status !== 0) {
      console.warn(
        "skipping the Drew speed execution check: python3 has no torch"
      );
      return;
    }
    const drew = spawnSync(
      "python3",
      [path.join(process.cwd(), "scripts/sowell/test_drew.py")],
      { encoding: "utf8" }
    );
    expect(drew.status, drew.stderr || drew.stdout).toBe(0);
    const engine = spawnSync(
      "python3",
      [path.join(process.cwd(), "scripts/sowell/test_engine.py")],
      { encoding: "utf8" }
    );
    expect(engine.status, engine.stderr || engine.stdout).toBe(0);
  });

  it("runs the prosody rules against the production chunker", () => {
    const rules = spawnSync(
      "python3",
      [path.join(process.cwd(), "scripts/sowell/test_prosody_rules.py")],
      { encoding: "utf8" }
    );
    expect(rules.status, rules.stderr || rules.stdout).toBe(0);
    const source = readFileSync(
      path.join(process.cwd(), "scripts/sowell/prosody_rules.py"),
      "utf8"
    );
    expect(source).toContain("accent_k=0.7");
    expect(source).toContain("decl_st=3.0");
    expect(source).toContain('PROSODY_G_CACHE_SUFFIX = "-prosodyG"');
  });
});
