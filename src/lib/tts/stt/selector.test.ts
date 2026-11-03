import { describe, expect, it } from "vitest";
import { DEFAULT_STT_PROVIDER, qaTranscriptsDisabled, resolveSttProvider } from "./selector";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("resolveSttProvider", () => {
  it("defaults to self-hosted Whisper", () => {
    expect(DEFAULT_STT_PROVIDER).toBe("local");
    expect(resolveSttProvider(env({}))).toBe("local");
  });

  it("never falls through to the paid endpoint on a typo", () => {
    expect(resolveSttProvider(env({ TTS_QA_PROVIDER: "deegram" }))).toBe("local");
  });

  it("accepts the deepgram aliases", () => {
    for (const value of ["deepgram", "openrouter", "nova", "DEEPGRAM"]) {
      expect(resolveSttProvider(env({ TTS_QA_PROVIDER: value }))).toBe("deepgram");
    }
  });

  it("accepts the local aliases", () => {
    for (const value of ["local", "whisper", "self-hosted", "selfhosted"]) {
      expect(resolveSttProvider(env({ TTS_QA_PROVIDER: value }))).toBe("local");
    }
  });

  it("can be turned off by provider name", () => {
    for (const value of ["off", "0", "false", "none"]) {
      expect(resolveSttProvider(env({ TTS_QA_PROVIDER: value }))).toBeNull();
    }
  });

  it("still honours the older kill switch", () => {
    expect(resolveSttProvider(env({ TTS_SECTION_QA_ENABLED: "0" }))).toBeNull();
    expect(resolveSttProvider(env({ TTS_SECTION_QA_ENABLED: "off" }))).toBeNull();
  });

  it("leaves an explicit switch otherwise untouched", () => {
    expect(resolveSttProvider(env({ TTS_SECTION_QA_ENABLED: "1" }))).toBe("local");
  });
});

describe("qaTranscriptsDisabled", () => {
  it("reads the documented off values", () => {
    for (const value of ["0", "false", "off", "no", " OFF "]) {
      expect(qaTranscriptsDisabled(env({ TTS_SECTION_QA_ENABLED: value }))).toBe(true);
    }
  });

  it("is off only when explicitly set", () => {
    expect(qaTranscriptsDisabled(env({}))).toBe(false);
    expect(qaTranscriptsDisabled(env({ TTS_SECTION_QA_ENABLED: "1" }))).toBe(false);
  });
});
