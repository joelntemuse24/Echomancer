import { afterEach, describe, expect, it } from "vitest";
import {
  isResearchPreviewConfigured,
  isResearchVoice,
  listResearchPreviewVoices,
  RESEARCH_ID_PREFIX,
  RESEARCH_MODEL,
} from "./research-preview";

const ENV_KEYS = [
  "MINIMAX_FREE_API_BASE_URL",
  "MINIMAX_FREE_API_TOKEN",
  "RESEARCH_PREVIEW_ENABLED",
  "RESEARCH_PREVIEW_ALLOWLIST",
  "RESEARCH_PREVIEW_ALLOW_TAKEHOME",
] as const;

const snapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

function rememberEnv() {
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
}

describe("research-preview (MiniMax Free API)", () => {
  it("is on whenever base URL + token are set", () => {
    rememberEnv();
    delete process.env.MINIMAX_FREE_API_BASE_URL;
    delete process.env.MINIMAX_FREE_API_TOKEN;
    expect(isResearchPreviewConfigured()).toBe(false);

    process.env.MINIMAX_FREE_API_BASE_URL = "http://127.0.0.1:8000";
    process.env.MINIMAX_FREE_API_TOKEN = "450+eyJhbGciOi";
    expect(isResearchPreviewConfigured()).toBe(true);
  });

  it("lists the single Storyteller preset when configured", () => {
    rememberEnv();
    delete process.env.MINIMAX_FREE_API_BASE_URL;
    expect(listResearchPreviewVoices()).toHaveLength(0);

    process.env.MINIMAX_FREE_API_BASE_URL = "http://127.0.0.1:8000";
    process.env.MINIMAX_FREE_API_TOKEN = "450+eyJhbGciOi";
    const voices = listResearchPreviewVoices();
    expect(voices).toHaveLength(1);
    expect(voices[0]!.id).toBe(
      `${RESEARCH_ID_PREFIX}English_CaptivatingStoryteller`
    );
    expect(voices[0]!.displayName).toMatch(/^Storyteller/);
    expect(voices[0]!.providerVoiceId).toBe("English_CaptivatingStoryteller");
    expect(voices[0]!.provider).toBe("research");
    expect(voices[0]!.model).toBe(RESEARCH_MODEL);
    expect(voices[0]!.recommendedForLongForm).toBe(true);
    expect(isResearchVoice(voices[0]!)).toBe(true);
  });
});
