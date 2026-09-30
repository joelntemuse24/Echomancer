import { describe, expect, it } from "vitest";
import { checkTranscriptAlignment } from "@/lib/tts/transcript-qa";

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
