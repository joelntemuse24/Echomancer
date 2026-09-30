import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioDurationSeconds,
  checkTranscriptAlignment,
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

  it("prefers Groq when that key is set", () => {
    expect(
      resolveQaProvider({
        GROQ_API_KEY: "gsk-test",
        OPENROUTER_API_KEY: "sk-or-test",
      } as NodeJS.ProcessEnv)
    ).toBe("groq");
  });

  it("uses OpenRouter when that is the only key and the test opts in", () => {
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

  it("is null when neither key is set", () => {
    expect(resolveQaProvider({} as NodeJS.ProcessEnv)).toBeNull();
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

describe("settleSectionTake duration", () => {
  it("keeps a matching transcript and reports duration inside the same wait", async () => {
    const frames = 200;
    const audio = edgeLikeMp3(frames);
    const source = "the harbor was quiet after the rain";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: source }), { status: 200 })
    );
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
      } as NodeJS.ProcessEnv,
    });
    const elapsed = Date.now() - started;
    vi.restoreAllMocks();
    expect(result.durationSec).toBeCloseTo((frames * 576) / 24000, 5);
    expect(elapsed).toBeLessThan(1_000);
    expect(logs.some((line) => /action=keep/.test(line) && /ms=\d+/.test(line))).toBe(true);
  });
});

describe("settleSectionTake budget", () => {
  it("keeps the audio when the transcript does not return within the budget", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {})
    );
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
        TTS_QA_BUDGET_MS: "80",
      } as NodeJS.ProcessEnv,
    });
    const elapsed = Date.now() - started;
    const opened = warn.mock.calls.some((call) => String(call[0]).includes("action=open"));
    spy.mockRestore();
    warn.mockRestore();
    expect(result.audio).toBe(audio);
    expect(elapsed).toBeLessThan(1_000);
    expect(opened).toBe(true);
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
});
