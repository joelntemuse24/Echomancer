import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUE_TAGGER_CHUNK_CHARS,
  CUE_TAGGER_MAX_OUTPUT_TOKENS,
  CUE_TAGGER_PARALLEL,
  DEFAULT_FISH_CUE_TAGGER_MODEL,
  DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS,
  FISH_CUE_TAGGER_OPENROUTER_PROVIDER,
  MAX_FISH_CUE_TAGGER_TIMEOUT_MS,
  MIN_FISH_CUE_TAGGER_TIMEOUT_MS,
  cueTaggerMaxOutputTokens,
  fishCueTaggerModel,
  fishCueTaggerSystemPrompt,
  fishCueTaggerTimeoutMs,
  isFishCueTaggerEnabled,
  splitSpeakableForCueTagging,
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

function longSpeakable(): string {
  const ch1 =
    "Chapter 1\n\nShe whispered UNIQUEONE softly near the quay. " +
    "The tide turned along the stones while evening settled in. ".repeat(80);
  const ch2 =
    "Chapter 2\n\nHe sighed UNIQUETWO and looked away across the dark water. " +
    "Night held its breath over the river until dawn. ".repeat(80);
  return `${ch1}\n\n${ch2}`;
}

function chatResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  } as Response;
}

function parseBody(init?: RequestInit): {
  model: string;
  max_tokens: number;
  reasoning?: { effort?: string };
  provider?: { only?: string[]; allow_fallbacks?: boolean };
  messages: Array<{ role: string; content: string }>;
} {
  return JSON.parse(String(init?.body || "{}")) as {
    model: string;
    max_tokens: number;
    reasoning?: { effort?: string };
    provider?: { only?: string[]; allow_fallbacks?: boolean };
    messages: Array<{ role: string; content: string }>;
  };
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

  it("defaults to DeepSeek V4.1 Flash, not a free-router model", () => {
    delete process.env.FISH_CUE_TAGGER_MODEL;
    expect(DEFAULT_FISH_CUE_TAGGER_MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(fishCueTaggerModel()).toBe("deepseek/deepseek-v4.1-flash");
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
  it("asks for sparse allowlisted cues ASAP, with no worker splits", () => {
    const prompt = fishCueTaggerSystemPrompt();
    expect(prompt).toMatch(/as soon as/i);
    expect(prompt).toMatch(/sparse/i);
    expect(prompt).toMatch(/\[break\]/);
    expect(prompt).toMatch(/allowlist|only these tags/i);
    expect(prompt).not.toMatch(/worker chunk|split the (?:book|text) into/i);
    expect(prompt).not.toMatch(/40 seconds/);
  });
});

describe("splitSpeakableForCueTagging", () => {
  it("keeps a short speakable as one chunk", () => {
    expect(splitSpeakableForCueTagging(FULL_SPEAKABLE)).toEqual([FULL_SPEAKABLE]);
  });

  it("splits a long book on paragraph boundaries under the chunk cap", () => {
    const long = longSpeakable();
    expect(long.length).toBeGreaterThan(CUE_TAGGER_CHUNK_CHARS * 2);
    const chunks = splitSpeakableForCueTagging(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.includes("UNIQUEONE"))).toBe(true);
    expect(chunks.some((c) => c.includes("UNIQUETWO"))).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CUE_TAGGER_CHUNK_CHARS + 800);
    }
    expect(chunks.join("\n\n")).toContain("UNIQUEONE");
    expect(chunks.join("\n\n")).toContain("UNIQUETWO");
  });
});

describe("cueTaggerMaxOutputTokens", () => {
  it("caps output tokens so a full-book echo cannot request 128k", () => {
    expect(CUE_TAGGER_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(4_096);
    const small = cueTaggerMaxOutputTokens(FULL_SPEAKABLE);
    expect(small).toBeGreaterThan(FULL_SPEAKABLE.length / 6);
    expect(small).toBeLessThanOrEqual(CUE_TAGGER_MAX_OUTPUT_TOKENS);
    expect(cueTaggerMaxOutputTokens("x".repeat(80_000))).toBe(
      CUE_TAGGER_MAX_OUTPUT_TOKENS
    );
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

  it("tags a short speakable in one OpenRouter call with reasoning off", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async () =>
      chatResponse(`[whispering] ${FULL_SPEAKABLE}`)
    );
    const tagged = await tagFishCuesForSpeakable(FULL_SPEAKABLE, {
      fetch: fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalled();
    expect(tagged).toContain("[whispering]");
    expect(tagged).toContain("UNIQUEONE");
    expect(tagged).toContain("UNIQUETWO");

    const body = parseBody(fetchFn.mock.calls[0]![1] as RequestInit);
    expect(body.model).toBe(DEFAULT_FISH_CUE_TAGGER_MODEL);
    expect(body.provider).toEqual(FISH_CUE_TAGGER_OPENROUTER_PROVIDER);
    expect(body.provider).toEqual({
      only: ["deepseek"],
      allow_fallbacks: false,
    });
    expect(JSON.stringify(body)).toContain('"allow_fallbacks":false');
    expect(body.reasoning?.effort).toBe("none");
    const user = body.messages.find((m) => m.role === "user")?.content || "";
    expect(user).toBe(FULL_SPEAKABLE);
    expect(body.messages.some((m) => m.role === "system")).toBe(true);
    expect(body.max_tokens).toBe(cueTaggerMaxOutputTokens(FULL_SPEAKABLE));
    expect(body.max_tokens).toBeLessThanOrEqual(CUE_TAGGER_MAX_OUTPUT_TOKENS);
  });

  it("keeps the DeepSeek provider pin when FISH_CUE_TAGGER_MODEL overrides the slug", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.FISH_CUE_TAGGER_MODEL = "deepseek/deepseek-chat";
    const fetchFn = vi.fn(async () => chatResponse(FULL_SPEAKABLE));
    await tagFishCuesForSpeakable(FULL_SPEAKABLE, { fetch: fetchFn });
    const body = parseBody(fetchFn.mock.calls[0]![1] as RequestInit);
    expect(body.model).toBe("deepseek/deepseek-chat");
    expect(body.provider).toEqual({
      only: ["deepseek"],
      allow_fallbacks: false,
    });
  });

  it("chunks a long book and tags those chunks in parallel", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const long = longSpeakable();
    const expectedChunks = splitSpeakableForCueTagging(long);
    expect(expectedChunks.length).toBeGreaterThan(1);

    let inflight = 0;
    let maxInflight = 0;
    const seen: string[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const body = parseBody(init);
      const user = body.messages.find((m) => m.role === "user")?.content || "";
      seen.push(user);
      expect(body.max_tokens).toBeLessThanOrEqual(CUE_TAGGER_MAX_OUTPUT_TOKENS);
      expect(body.reasoning?.effort).toBe("none");
      expect(body.provider).toEqual(FISH_CUE_TAGGER_OPENROUTER_PROVIDER);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return chatResponse(`[calm] ${user}`);
    });

    const tagged = await tagFishCuesForSpeakable(long, { fetch: fetchFn });
    expect(fetchFn.mock.calls.length).toBe(expectedChunks.length);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
    expect(maxInflight).toBeGreaterThan(1);
    expect(maxInflight).toBeLessThanOrEqual(CUE_TAGGER_PARALLEL);
    expect(seen.some((u) => u.includes("UNIQUEONE"))).toBe(true);
    expect(seen.some((u) => u.includes("UNIQUETWO"))).toBe(true);
    expect(seen.every((u) => u.includes("UNIQUEONE") && u.includes("UNIQUETWO"))).toBe(
      false
    );
    expect(tagged).toContain("[calm]");
    expect(tagged).toContain("UNIQUEONE");
    expect(tagged).toContain("UNIQUETWO");
  });

  it("honors FISH_CUE_TAGGER_TIMEOUT_MS as an AbortSignal ceiling, not a wait", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.FISH_CUE_TAGGER_TIMEOUT_MS = "15000";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async () => chatResponse(FULL_SPEAKABLE));
    const started = Date.now();
    await tagFishCuesForSpeakable(FULL_SPEAKABLE, { fetch: fetchFn });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(timeoutSpy.mock.calls.some((c) => (c[0] as number) <= 15_000)).toBe(
      true
    );
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

  it("keeps allowlisted tags from successful chunks when a sibling chunk fails", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const long = longSpeakable();
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = parseBody(init);
      const user = body.messages.find((m) => m.role === "user")?.content || "";
      if (user.includes("UNIQUETWO")) {
        throw new DOMException("The operation was aborted.", "TimeoutError");
      }
      return chatResponse(`[whispering] ${user}`);
    });
    const tagged = await tagFishCuesForSpeakable(long, { fetch: fetchFn });
    expect(tagged).toContain("UNIQUEONE");
    expect(tagged).toContain("UNIQUETWO");
    expect(tagged).toContain("[whispering]");
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
