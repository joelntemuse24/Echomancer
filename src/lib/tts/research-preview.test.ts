import { afterEach, describe, expect, it } from "vitest";
import {
  isResearchPreviewAllowed,
  isResearchPreviewConfigured,
  isResearchVoice,
  listResearchPreviewVoices,
  RESEARCH_ID_PREFIX,
  RESEARCH_MODEL,
} from "./research-preview";

const ENV_KEYS = [
  "RESEARCH_PREVIEW_ENABLED",
  "RESEARCH_PREVIEW_ALLOWLIST",
  "RESEARCH_PREVIEW_ALLOW_TAKEHOME",
  "MINIMAX_FREE_API_BASE_URL",
  "MINIMAX_FREE_API_TOKEN",
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

describe("research-preview gate", () => {
  it("is off unless enabled + base URL + token are all set", () => {
    rememberEnv();
    delete process.env.RESEARCH_PREVIEW_ENABLED;
    delete process.env.MINIMAX_FREE_API_BASE_URL;
    delete process.env.MINIMAX_FREE_API_TOKEN;
    expect(isResearchPreviewConfigured()).toBe(false);

    process.env.RESEARCH_PREVIEW_ENABLED = "true";
    process.env.MINIMAX_FREE_API_BASE_URL = "http://127.0.0.1:8000";
    process.env.MINIMAX_FREE_API_TOKEN = "450+eyJhbGciOi";
    expect(isResearchPreviewConfigured()).toBe(true);
  });

  it("requires an allowlist match for access", () => {
    rememberEnv();
    process.env.RESEARCH_PREVIEW_ENABLED = "true";
    process.env.MINIMAX_FREE_API_BASE_URL = "http://127.0.0.1:8000";
    process.env.MINIMAX_FREE_API_TOKEN = "450+eyJhbGciOi";
    process.env.RESEARCH_PREVIEW_ALLOWLIST = "anon_abc,1.2.3.4";

    expect(isResearchPreviewAllowed({ userId: "anon_abc" })).toBe(true);
    expect(isResearchPreviewAllowed({ ip: "1.2.3.4" })).toBe(true);
    expect(isResearchPreviewAllowed({ userId: "anon_other" })).toBe(false);
    expect(isResearchPreviewAllowed({})).toBe(false);
  });

  it("exposes research catalog cards only when configured", () => {
    rememberEnv();
    delete process.env.RESEARCH_PREVIEW_ENABLED;
    expect(listResearchPreviewVoices()).toHaveLength(0);

    process.env.RESEARCH_PREVIEW_ENABLED = "true";
    process.env.MINIMAX_FREE_API_BASE_URL = "http://127.0.0.1:8000";
    process.env.MINIMAX_FREE_API_TOKEN = "450+eyJhbGciOi";
    const voices = listResearchPreviewVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]!.id.startsWith(RESEARCH_ID_PREFIX)).toBe(true);
    expect(voices[0]!.provider).toBe("research");
    expect(voices[0]!.model).toBe(RESEARCH_MODEL);
    expect(isResearchVoice(voices[0]!)).toBe(true);
  });
});
