import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
