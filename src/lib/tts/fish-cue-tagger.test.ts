import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FISH_CUE_TAGGER_MODEL,
  fishCueTaggerModel,
  isFishCueTaggerEnabled,
  tagFishCuesForSection,
} from "./fish-cue-tagger";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "FISH_CUE_TAGGER",
  "FISH_CUE_TAGGER_MODEL",
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
    process.env.FISH_CUE_TAGGER_MODEL = "openrouter/free";
    expect(fishCueTaggerModel()).toBe("openrouter/free");
  });
});

describe("tagFishCuesForSection", () => {
  it("does not call OpenRouter without a key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchFn = vi.fn();
    const out = await tagFishCuesForSection(SECTION, { fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toBe(SECTION);
  });

  it("keeps allowlisted tags and rejects a prose rewrite", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchFn = vi.fn(async () =>
      chatResponse(`[whispering] ${SECTION}`)
    );
    const tagged = await tagFishCuesForSection(SECTION, { fetch: fetchFn });
    expect(tagged).toContain("[whispering]");
    expect(tagged).toContain("Stay close");
    expect(fetchFn).toHaveBeenCalledOnce();
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(DEFAULT_FISH_CUE_TAGGER_MODEL);
    expect(body.messages.some((m) => m.content === SECTION)).toBe(true);
    expect(body.messages.some((m) => m.content.includes("Stay close"))).toBe(
      true
    );

    const rewriteFetch = vi.fn(async () =>
      chatResponse('[sad] She asked him to stay nearby instead.')
    );
    const rejected = await tagFishCuesForSection(SECTION, {
      fetch: rewriteFetch,
    });
    expect(rejected).toBe(SECTION);
  });

  it("fail-opens on HTTP errors and never throws", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchFn = vi.fn(async () =>
      ({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      }) as Response
    );
    await expect(
      tagFishCuesForSection(SECTION, { fetch: fetchFn })
    ).resolves.toBe(SECTION);
  });
});
