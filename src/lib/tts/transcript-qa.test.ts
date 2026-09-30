import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioDurationSeconds,
  checkTranscriptAlignment,
  qaExplicitlyDisabled,
  resolveQaProvider,
  settleSectionTake,
} from "@/lib/tts/transcript-qa";

const NEIGHBOURS =
  "the harbor was quiet after the rain she closed the ledger and said they would leave at dawn";

describe("checkTranscriptAlignment", () => {
  it("flags an inserted run of six words that copies the span beside it", () => {
    const repeated = `${NEIGHBOURS} the harbor was quiet after the rain`;
    const report = checkTranscriptAlignment(NEIGHBOURS, repeated);
    expect(report.flags).toContain("repeat");
    expect(report.problemWord).not.toBeNull();
  });

  it("does not treat a five-word echo as a repeat", () => {
    const source = "alpha bravo charlie delta echo foxtrot golf hotel";
    const echoed = `${source} alpha bravo charlie delta echo`;
    const report = checkTranscriptAlignment(source, echoed);
    expect(report.flags).not.toContain("repeat");
  });

  it("does not flag six inserted words that are not a neighbouring copy", () => {
    const source = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const extra = `${source} something else was spoken here now`;
    const report = checkTranscriptAlignment(source, extra);
    expect(report.flags).not.toContain("repeat");
  });

  it("flags a missing run of six words", () => {
    const source =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    const heard = "one two three four five six thirteen fourteen";
    const report = checkTranscriptAlignment(source, heard);
    expect(report.flags).toContain("skip");
    expect(report.problemWord).toBe(6);
  });

  it("does not flag a missing run of five words", () => {
    const source = "one two three four five six seven eight nine ten eleven twelve";
    const heard = "one two eight nine ten eleven twelve";
    const report = checkTranscriptAlignment(source, heard);
    expect(report.flags).not.toContain("skip");
  });
});

describe("resolveQaProvider", () => {
  afterEach(() => {
    delete process.env.TTS_SECTION_QA;
  });

  it("uses OpenRouter when the key is set and the test opts in", () => {
    expect(
      resolveQaProvider({
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA: "1",
      } as NodeJS.ProcessEnv)
    ).toBe("openrouter");
  });

  it("stays off in vitest when the OpenRouter key is the fake test key", () => {
    expect(
      resolveQaProvider({ OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv)
    ).toBeNull();
  });

  it("is null when no key is set", () => {
    expect(resolveQaProvider({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("stays off when the kill switch is set, even with a key", () => {
    expect(qaExplicitlyDisabled({ TTS_SECTION_QA_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(
      true
    );
    expect(
      resolveQaProvider({
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA: "1",
        TTS_SECTION_QA_ENABLED: "0",
      } as NodeJS.ProcessEnv)
    ).toBeNull();
  });
});

/** MPEG2 Layer III, 48 kbps, 24 kHz, 144 bytes, no padding. Same layout as Edge. */
function edgeLikeMp3(frames: number): Buffer {
  const frame = Buffer.alloc(144);
  frame[0] = 0xff;
  frame[1] = 0xf3;
  frame[2] = 0x64;
  frame[3] = 0xc4;
  return Buffer.concat(Array.from({ length: frames }, () => Buffer.from(frame)));
}

describe("audioDurationSeconds", () => {
  it("reads an Edge-shaped mp3 from the frame headers", () => {
    const frames = 3631;
    const audio = edgeLikeMp3(frames);
    const duration = audioDurationSeconds(audio);
    expect(duration).toBeCloseTo((frames * 576) / 24000, 5);
  });

  it("reads a wav from the header", () => {
    const data = Buffer.alloc(24000 * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
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
    header.writeUInt32LE(data.length, 40);
    expect(audioDurationSeconds(Buffer.concat([header, data]))).toBeCloseTo(1, 5);
  });

  it("walks a full-length section without blocking", () => {
    const audio = edgeLikeMp3(3631);
    const started = Date.now();
    for (let i = 0; i < 8; i++) audioDurationSeconds(audio);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("returns null for a buffer that is not audio", () => {
    expect(audioDurationSeconds(Buffer.from("section-audio"))).toBeNull();
  });
});

function listen(
  onRequest: (close: { at: () => number }) => void
): Promise<{ server: Server; base: string; closedAt: () => number }> {
  let closedAt = 0;
  const server = createServer((req, res) => {
    req.on("close", () => {
      closedAt = Date.now();
    });
    onRequest({ at: () => closedAt });
    res.writeHead(200, { "content-type": "application/json" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        base: `http://127.0.0.1:${port}/api/v1`,
        closedAt: () => closedAt,
      });
    });
  });
}

describe("settleSectionTake duration", () => {
  it("keeps a matching transcript and reports duration inside the same wait", async () => {
    const frames = 200;
    const audio = edgeLikeMp3(frames);
    const source = "the harbor was quiet after the rain";
    const { server, base } = await listen(() => {});
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: source }));
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    const started = Date.now();
    const result = await settleSectionTake({
      jobId: "job-duration",
      index: 1,
      sourceText: source,
      first: { audio, contentType: "audio/mpeg" },
      synthesize: async () => null,
      rate: { chars: 0, seconds: 0 },
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA: "1",
        OPENROUTER_BASE_URL: base,
      } as NodeJS.ProcessEnv,
    });
    const elapsed = Date.now() - started;
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(result.durationSec).toBeCloseTo((frames * 576) / 24000, 5);
    expect(elapsed).toBeLessThan(1_000);
    expect(logs.some((line) => /action=keep/.test(line) && /ms=\d+/.test(line))).toBe(true);
  });
});

describe("settleSectionTake budget", () => {
  it("keeps the audio when the transcript does not return within the budget", async () => {
    let openedAt = 0;
    const { server, base, closedAt } = await listen(() => {
      openedAt = openedAt || Date.now();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audio = Buffer.from("section-audio");
    const started = Date.now();
    const result = await settleSectionTake({
      jobId: "job-budget",
      index: 3,
      sourceText: "the harbor was quiet after the rain",
      first: { audio, contentType: "audio/mpeg" },
      synthesize: async () => null,
      rate: { chars: 0, seconds: 0 },
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA: "1",
        TTS_QA_BUDGET_MS: "200",
        OPENROUTER_BASE_URL: base,
      } as NodeJS.ProcessEnv,
    });
    const elapsed = Date.now() - started;
    const opened = warn.mock.calls.some((call) => String(call[0]).includes("action=open"));
    warn.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(result.audio).toBe(audio);
    expect(opened).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
    expect(closedAt() - openedAt).toBeLessThan(700);
  });

  it("aborts the socket on the wall clock while the main thread is blocked", async () => {
    const { Worker } = await import("node:worker_threads");
    const serverWorker = new Worker(
      `
        const { parentPort } = require("node:worker_threads");
        const { createServer } = require("node:http");
        const server = createServer((req, res) => {
          const opened = Date.now();
          parentPort.postMessage({ openedOnly: opened });
          req.on("close", () => parentPort.postMessage({ opened, closed: Date.now() }));
          res.writeHead(200, { "content-type": "application/json" });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          parentPort.postMessage({ port: address.port });
        });
      `,
      { eval: true }
    );
    const port = await new Promise<number>((resolve) => {
      serverWorker.once("message", (msg: { port: number }) => resolve(msg.port));
    });
    const closed = new Promise<{ opened: number; closed: number }>((resolve) => {
      serverWorker.on("message", (msg: { opened?: number; closed?: number }) => {
        if (msg.closed) resolve({ opened: msg.opened!, closed: msg.closed });
      });
    });
    const opened = new Promise<void>((resolve) => {
      const onMsg = (msg: { openedOnly?: number }) => {
        if (msg.openedOnly) {
          serverWorker.off("message", onMsg);
          resolve();
        }
      };
      serverWorker.on("message", onMsg);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = settleSectionTake({
      jobId: "job-blocked",
      index: 4,
      sourceText: "the harbor was quiet after the rain",
      first: { audio: Buffer.from("section-audio"), contentType: "audio/mpeg" },
      synthesize: async () => null,
      rate: { chars: 0, seconds: 0 },
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA: "1",
        TTS_QA_BUDGET_MS: "150",
        OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      } as NodeJS.ProcessEnv,
    });
    await Promise.race([
      opened,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    spawnSync("sleep", ["0.45"]);
    const timing = await Promise.race([
      closed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    await pending;
    vi.restoreAllMocks();
    await serverWorker.terminate();
    expect(timing).not.toBeNull();
    expect(timing!.closed - timing!.opened).toBeLessThan(400);
  });
});

describe("settleSectionTake without a provider", () => {
  it("logs one skip line and keeps the audio", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    const audio = Buffer.from("not-audio");
    const opts = {
      sourceText: "the harbor was quiet",
      first: { audio, contentType: "audio/mpeg" },
      synthesize: async () => null,
      rate: { chars: 0, seconds: 0 },
      env: {} as NodeJS.ProcessEnv,
    };
    const first = await settleSectionTake({ ...opts, jobId: "job-no-provider", index: 0 });
    const second = await settleSectionTake({ ...opts, jobId: "job-no-provider", index: 1 });
    spy.mockRestore();
    expect(first.audio).toBe(audio);
    expect(second.audio).toBe(audio);
    const skipped = logs.filter((line) => line.includes("qa skipped: no provider"));
    expect(skipped).toEqual(["[Job job-no-provider] qa skipped: no provider"]);
  });

  it("logs one disabled line when the kill switch is set", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    const audio = Buffer.from("not-audio");
    const first = await settleSectionTake({
      jobId: "job-disabled",
      index: 0,
      sourceText: "the harbor was quiet",
      first: { audio, contentType: "audio/mpeg" },
      synthesize: async () => null,
      rate: { chars: 0, seconds: 0 },
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA_ENABLED: "0",
      } as NodeJS.ProcessEnv,
    });
    const second = await settleSectionTake({
      jobId: "job-disabled",
      index: 1,
      sourceText: "the harbor was quiet",
      first: { audio, contentType: "audio/mpeg" },
      synthesize: async () => null,
      rate: { chars: 0, seconds: 0 },
      env: {
        OPENROUTER_API_KEY: "sk-or-test",
        TTS_SECTION_QA_ENABLED: "0",
      } as NodeJS.ProcessEnv,
    });
    spy.mockRestore();
    expect(first.audio).toBe(audio);
    expect(second.audio).toBe(audio);
    expect(logs.filter((line) => line.includes("qa skipped: disabled"))).toEqual([
      "[Job job-disabled] qa skipped: disabled",
    ]);
    expect(logs.some((line) => line.includes("no provider"))).toBe(false);
  });
});
