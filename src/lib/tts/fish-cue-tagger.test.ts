import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FISH_CUE_TAGGER_MODEL,
  DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS,
  MAX_FISH_CUE_TAGGER_TIMEOUT_MS,
  MIN_FISH_CUE_TAGGER_TIMEOUT_MS,
  fishCueTaggerModel,
  fishCueTaggerSystemPrompt,
  fishCueTaggerTimeoutMs,
  isFishCueTaggerEnabled,
  tagFishCuesForSpeakable,
} from "./fish-cue-tagger";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "FISH_CUE_TAGGER",
  "FISH_CUE_TAGGER_MODEL",
  "FISH_CUE_TAGGER_TIMEOUT_MS",
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

const SECTION = [
  'She whispered softly, "Stay close."',
  "He sighed and looked away across the dark water near the quay.",
].join(" ");

const FULL_SPEAKABLE = [
  "Chapter 1",
  'She whispered UNIQUEONE softly, "Stay close." The tide turned along the stones.',
  "Chapter 2",
  "He sighed UNIQUETWO and looked away across the dark water near the quay.",
].join("\n\n");

function chatResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  } as Response;
}

describe("isFishCueTaggerEnabled", () => {
  it("is off without a key, and off when FISH_CUE_TAGGER=0", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPEN_ROUTER_API_KEY;
    delete process.env.FISH_CUE_TAGGER;
    expect(isFishCueTaggerEnabled()).toBe(false);

    process.env.OPENROUTER_API_KEY = "sk-or-test";
    expect(isFishCueTaggerEnabled()).toBe(true);
    process.env.FISH_CUE_TAGGER = "0";
    expect(isFishCueTaggerEnabled()).toBe(false);
  });

  it("defaults to the cheap gpt-oss-20b model", () => {
    delete process.env.FISH_CUE_TAGGER_MODEL;
    expect(fishCueTaggerModel()).toBe(DEFAULT_FISH_CUE_TAGGER_MODEL);
    process.env.FISH_CUE_TAGGER_MODEL = "nvidia/nemotron-3.5-lightning:free";
    expect(fishCueTaggerModel()).toBe("nvidia/nemotron-3.5-lightning:free");
  });
});

describe("fishCueTaggerTimeoutMs", () => {
  it("defaults to 40s and clamps the ceiling between 1s and 120s", () => {
    delete process.env.FISH_CUE_TAGGER_TIMEOUT_MS;
    expect(DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS).toBe(40_000);
    expect(MIN_FISH_CUE_TAGGER_TIMEOUT_MS).toBe(1_000);
    expect(MAX_FISH_CUE_TAGGER_TIMEOUT_MS).toBe(120_000);
    expect(fishCueTaggerTimeoutMs()).toBe(40_000);

    process.env.FISH_CUE_TAGGER_TIMEOUT_MS = "40000";
    expect(fishCueTaggerTimeoutMs()).toBe(40_000);
    process.env.FISH_CUE_TAGGER_TIMEOUT_MS = "1000";
    expect(fishCueTaggerTimeoutMs()).toBe(1_000);
    process.env.FISH_CUE_TAGGER_TIMEOUT_MS = "120000";
    expect(fishCueTaggerTimeoutMs()).toBe(120_000);
    process.env.FISH_CUE_TAGGER_TIMEOUT_MS = "500";
    expect(fishCueTaggerTimeoutMs()).toBe(40_000);
    process.env.FISH_CUE_TAGGER_TIMEOUT_MS = "130000";
    expect(fishCueTaggerTimeoutMs()).toBe(40_000);
  });
});

describe("fishCueTaggerSystemPrompt", () => {
  it("asks for sparse allowlisted cues ASAP, with a ~40s ceiling, and no worker splits", () => {
    const prompt = fishCueTaggerSystemPrompt(40_000);
    expect(prompt).toMatch(/40 seconds/);
    expect(prompt).toMatch(/as soon as/i);
    expect(prompt).toMatch(/sparse/i);
    expect(prompt).toMatch(/\[break\]/);
    expect(prompt).toMatch(/allowlist|only these tags/i);
    expect(prompt).not.toMatch(/worker chunk|split the (?:book|text) into/i);
  });
});

describe("tagFishCuesForSpeakable", () => {
  it("does not call OpenRouter without a key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchFn = vi.fn();
    const out = await tagFishCuesForSpeakable(FULL_SPEAKABLE, { fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toBe(FULL_SPEAKABLE);
  });

  it("tags the full speakable in one OpenRouter call", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async () =>
      chatResponse(`[whispering] ${FULL_SPEAKABLE}`)
    );
    const tagged = await tagFishCuesForSpeakable(FULL_SPEAKABLE, {
      fetch: fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS);
    expect(tagged).toContain("[whispering]");
    expect(tagged).toContain("UNIQUEONE");
    expect(tagged).toContain("UNIQUETWO");

    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(DEFAULT_FISH_CUE_TAGGER_MODEL);
    const user = body.messages.find((m) => m.role === "user")?.content || "";
    expect(user).toBe(FULL_SPEAKABLE);
    expect(user).toMatch(/UNIQUEONE[\s\S]*UNIQUETWO/);
    expect(body.messages.some((m) => m.role === "system")).toBe(true);
    expect(body.messages.find((m) => m.role === "system")!.content).toMatch(
      /as soon as/i
    );
    expect(body.max_tokens).toBeGreaterThan(FULL_SPEAKABLE.length / 4);
  });

  it("honors FISH_CUE_TAGGER_TIMEOUT_MS as an AbortSignal ceiling, not a wait", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.FISH_CUE_TAGGER_TIMEOUT_MS = "15000";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async () => chatResponse(FULL_SPEAKABLE));
    const started = Date.now();
    await tagFishCuesForSpeakable(FULL_SPEAKABLE, { fetch: fetchFn });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("fail-opens on timeout/abort without throwing", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchFn = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    await expect(
      tagFishCuesForSpeakable(FULL_SPEAKABLE, { fetch: fetchFn })
    ).resolves.toBe(FULL_SPEAKABLE);
  });

  it("keeps allowlisted tags and rejects a prose rewrite", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchFn = vi.fn(async () =>
      chatResponse(`[whispering] ${SECTION}`)
    );
    const tagged = await tagFishCuesForSpeakable(SECTION, { fetch: fetchFn });
    expect(tagged).toContain("[whispering]");
    expect(tagged).toContain("Stay close");

    const rewriteFetch = vi.fn(async () =>
      chatResponse("[sad] She asked him to stay nearby instead.")
    );
    const rejected = await tagFishCuesForSpeakable(SECTION, {
      fetch: rewriteFetch,
    });
    expect(rejected).toBe(SECTION);
  });

  it("fail-opens on HTTP errors and never throws", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: false,
          status: 429,
          text: async () => "rate limited",
        }) as Response
    );
    await expect(
      tagFishCuesForSpeakable(SECTION, { fetch: fetchFn })
    ).resolves.toBe(SECTION);
  });
});
