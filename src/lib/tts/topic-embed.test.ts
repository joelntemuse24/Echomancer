import { afterEach, describe, expect, it } from "vitest";
import { resolveChapters } from "@/lib/book-chapters";
import { resolveChaptersForBook } from "@/lib/tts/chapter-choice";
import {
  assignTopicsByEmbedding,
  cosineSimilarity,
  DEFAULT_EMBED_MODEL,
  embedConfigFromEnv,
  embedMinSimilarity,
  embedPrefixes,
  embedTexts,
  placePartTopicsByEmbed,
  placePrintedTocTopicsByEmbed,
  TOPIC_EMBED_MIN_SIMILARITY,
  topicEmbedEnabled,
  type EmbedConfig,
} from "@/lib/tts/topic-embed";
import { numberedParagraphs } from "@/lib/tts/topic-llm";

const ENV_KEYS = [
  "CHAPTER_TOPIC_EMBED",
  "CHAPTER_TOPIC_LLM",
  "CHAPTER_EMBED_PROVIDER",
  "CHAPTER_EMBED_MODEL",
  "CHAPTER_EMBED_API_KEY",
  "CHAPTER_EMBED_BASE_URL",
  "CHAPTER_EMBED_MIN_SIMILARITY",
  "CHAPTER_EMBED_QUERY_PREFIX",
  "CHAPTER_EMBED_DOCUMENT_PREFIX",
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

const CONFIG: EmbedConfig = {
  provider: "openrouter",
  url: "https://embed.example.test/api/v1/embeddings",
  apiKey: "s3cret",
  model: "qwen/qwen3-embedding-8b",
  prefixes: { query: "Q: ", document: "" },
};

function stripPrefix(text: string): string {
  return text.startsWith("Q: ") ? text.slice(3) : text;
}

/** Fixed 3-d vectors: "railroad" texts point at axis 0, "constitution" at axis 1, the rest at axis 2. */
function vectorFor(text: string): number[] {
  const lower = stripPrefix(text).toLowerCase();
  if (lower.includes("railroad")) return [1, 0, 0];
  if (lower.includes("constitution")) return [0, 1, 0];
  return [0, 0, 1];
}

interface Call {
  input: string[];
  model: string;
  auth: string | null;
}

/** OpenAI-style reply, rows deliberately reversed to check `index` ordering. */
function embedFetch(calls?: Call[]): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
    calls?.push({
      input: body.input,
      model: body.model,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const data = body.input.map((text, index) => ({
      object: "embedding",
      index,
      embedding: vectorFor(text),
    }));
    return new Response(JSON.stringify({ object: "list", data: data.reverse() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("config", () => {
  it("defaults to OpenRouter qwen3-embedding-8b on OPENROUTER_API_KEY", () => {
    const config = embedConfigFromEnv({ OPENROUTER_API_KEY: "or-key" });
    expect(config?.provider).toBe("openrouter");
    expect(config?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(config?.model).toBe("qwen/qwen3-embedding-8b");
    expect(config?.apiKey).toBe("or-key");
    expect(config?.prefixes.query).toMatch(/^Instruct: .*\nQuery: $/);
    expect(config?.prefixes.document).toBe("");
  });

  it("returns null without a key or with an unknown provider", () => {
    expect(embedConfigFromEnv({})).toBeNull();
    expect(embedConfigFromEnv({ CHAPTER_EMBED_PROVIDER: "nope", OPENROUTER_API_KEY: "k" })).toBeNull();
    expect(embedConfigFromEnv({ CHAPTER_EMBED_PROVIDER: "cloudflare", CLOUDFLARE_AI_API_TOKEN: "t" })).toBeNull();
  });

  it("honours model, key, base URL, and provider presets", () => {
    const custom = embedConfigFromEnv({
      OPENROUTER_API_KEY: "or-key",
      CHAPTER_EMBED_API_KEY: "override",
      CHAPTER_EMBED_MODEL: "baai/bge-m3",
      CHAPTER_EMBED_BASE_URL: "https://proxy.test/v1/",
    });
    expect(custom).toMatchObject({
      apiKey: "override",
      model: "baai/bge-m3",
      url: "https://proxy.test/v1/embeddings",
      prefixes: { query: "", document: "" },
    });
    const deepinfra = embedConfigFromEnv({ CHAPTER_EMBED_PROVIDER: "deepinfra", DEEPINFRA_API_KEY: "d" });
    expect(deepinfra?.url).toBe("https://api.deepinfra.com/v1/openai/embeddings");
    expect(deepinfra?.model).toBe(DEFAULT_EMBED_MODEL.deepinfra);
    expect(deepinfra?.prefixes).toEqual({
      query: "task: search result | query: ",
      document: "title: none | text: ",
    });
    const cloudflare = embedConfigFromEnv({
      CHAPTER_EMBED_PROVIDER: "cloudflare",
      CLOUDFLARE_AI_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    });
    expect(cloudflare?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/embeddings");
    expect(cloudflare?.model).toBe("@cf/google/embeddinggemma-300m");
  });

  it("lets env override prefixes", () => {
    expect(
      embedPrefixes("google/embeddinggemma-2", { CHAPTER_EMBED_QUERY_PREFIX: "q> " })
    ).toEqual({ query: "q> ", document: "title: none | text: " });
  });

  it("locks the similarity floor and reads the override", () => {
    expect(TOPIC_EMBED_MIN_SIMILARITY).toBe(0.35);
    expect(embedMinSimilarity({})).toBe(0.35);
    expect(embedMinSimilarity({ CHAPTER_EMBED_MIN_SIMILARITY: "0.5" })).toBe(0.5);
    expect(embedMinSimilarity({ CHAPTER_EMBED_MIN_SIMILARITY: "abc" })).toBe(0.35);
    expect(embedMinSimilarity({ CHAPTER_EMBED_MIN_SIMILARITY: "2" })).toBe(0.35);
  });

  it("reads CHAPTER_TOPIC_EMBED", () => {
    expect(topicEmbedEnabled({ CHAPTER_TOPIC_EMBED: "1" })).toBe(true);
    expect(topicEmbedEnabled({ CHAPTER_TOPIC_EMBED: "0" })).toBe(false);
    expect(topicEmbedEnabled({})).toBe(false);
  });
});

describe("cosine", () => {
  it("is unit-safe", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([3, 0], [5, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1], [1, 0])).toBe(0);
  });
});

describe("assignTopicsByEmbedding", () => {
  const paragraphs = numberedParagraphs(
    ["one", "two", "three", "four", "five", "six"].join("\n\n"),
    0
  );

  it("keeps anchors and stays in topic order", () => {
    // Topic 1 scores best at paragraph 2, which is before anchor topic 0 at 3.
    const scores = [
      [0, 0, 0, 0, 0, 0],
      [0, 0.9, 0.2, 0.8, 0.5, 0],
      [0, 0, 0, 0.1, 0.4, 0.95],
    ];
    const placed = assignTopicsByEmbedding(["a", "b", "c"], paragraphs, scores, new Map([[0, 3]]));
    expect([...placed.entries()]).toEqual([
      [0, 3],
      [1, 4],
      [2, 6],
    ]);
  });

  it("drops matches under the floor and does not advance past them", () => {
    const scores = [
      [0.1, 0.2, 0.3, 0.1, 0.1, 0.1],
      [0, 0, 0, 0, 0, 0.9],
    ];
    const placed = assignTopicsByEmbedding(["a", "b"], paragraphs, scores, new Map(), 0.35);
    expect([...placed.entries()]).toEqual([[1, 6]]);
    const exact = assignTopicsByEmbedding(
      ["a"],
      paragraphs,
      [[0, 0, TOPIC_EMBED_MIN_SIMILARITY, 0, 0, 0]],
      new Map(),
      TOPIC_EMBED_MIN_SIMILARITY
    );
    expect(exact.get(0)).toBe(3);
  });

  it("uses CHAPTER_EMBED_MIN_SIMILARITY as the default floor", () => {
    process.env.CHAPTER_EMBED_MIN_SIMILARITY = "0.6";
    const placed = assignTopicsByEmbedding(["a"], paragraphs, [[0, 0.5, 0, 0, 0, 0]], new Map());
    expect(placed.size).toBe(0);
  });

  it("keeps a topic inside the window before the next verbatim anchor", () => {
    // Topic 0's best paragraph (5) is past the anchor for topic 1 (3), so it takes 2.
    const scores = [
      [0.1, 0.5, 0.4, 0.4, 0.99, 0.4],
      [0, 0, 0, 0, 0, 0],
    ];
    const placed = assignTopicsByEmbedding(["a", "b"], paragraphs, scores, new Map([[1, 3]]), 0.35);
    expect([...placed.entries()]).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("leaves a topic out when no paragraph fits between its neighbours", () => {
    const scores = [
      [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
      [0, 0, 0, 0, 0, 0],
    ];
    const placed = assignTopicsByEmbedding(["a", "b"], paragraphs, scores, new Map([[1, 1]]), 0.35);
    expect([...placed.entries()]).toEqual([[1, 1]]);
  });

  it("compares raw vectors by cosine", () => {
    const placed = assignTopicsByEmbedding(
      ["a"],
      paragraphs,
      {
        topics: [[1, 0]],
        paragraphs: [[0, 1], [0.2, 1], [1, 0.1], [0, 1], [0, 1], [0, 1]],
      },
      new Map(),
      0.35
    );
    expect(placed.get(0)).toBe(3);
  });
});

describe("embedTexts", () => {
  it("batches, sends the key, model, and prefix, and orders rows by index", async () => {
    const calls: Call[] = [];
    const out = await embedTexts(["railroad", "b", "constitution", "d", "e"], "query", {
      config: CONFIG,
      batchSize: 2,
      fetch: embedFetch(calls),
    });
    expect(out).toEqual([[1, 0, 0], [0, 0, 1], [0, 1, 0], [0, 0, 1], [0, 0, 1]]);
    expect(calls.map((call) => call.input.length)).toEqual([2, 2, 1]);
    expect(calls[0]!.input[0]).toBe("Q: railroad");
    expect(calls.every((call) => call.model === "qwen/qwen3-embedding-8b")).toBe(true);
    expect(calls.every((call) => call.auth === "Bearer s3cret")).toBe(true);
  });

  it("adds no query prefix to documents", async () => {
    const calls: Call[] = [];
    await embedTexts(["a paragraph"], "document", { config: CONFIG, fetch: embedFetch(calls) });
    expect(calls[0]!.input).toEqual(["a paragraph"]);
  });

  it("returns null when not configured without calling fetch", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not be called");
    };
    expect(await embedTexts(["a"], "query", { fetch: fetchImpl })).toBeNull();
    expect(await embedTexts(["a"], "query", { config: null, fetch: fetchImpl })).toBeNull();
  });

  it("returns null on a bad status, a bad body, a short reply, or a thrown error", async () => {
    const reply = (body: unknown, status = 200): typeof fetch =>
      async () => new Response(JSON.stringify(body), { status });
    const opts = { config: CONFIG };
    expect(await embedTexts(["a"], "query", { ...opts, fetch: reply({}, 401) })).toBeNull();
    expect(await embedTexts(["a"], "query", { ...opts, fetch: reply({ nope: 1 }) })).toBeNull();
    expect(
      await embedTexts(["a", "b"], "query", {
        ...opts,
        fetch: reply({ data: [{ index: 0, embedding: [1] }] }),
      })
    ).toBeNull();
    expect(
      await embedTexts(["a"], "query", { ...opts, fetch: reply({ data: [{ index: 0, embedding: ["x"] }] }) })
    ).toBeNull();
    expect(
      await embedTexts(["a", "b"], "query", {
        ...opts,
        fetch: reply({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }),
      })
    ).toBeNull();
    const boom: typeof fetch = async () => {
      throw new Error("network down");
    };
    expect(await embedTexts(["a"], "query", { ...opts, fetch: boom })).toBeNull();
  });

  it("returns null when the call times out", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const out = await embedTexts(["a"], "query", { config: CONFIG, callTimeoutMs: 20, fetch: hang });
    expect(out).toBeNull();
  });
});

describe("placePartTopicsByEmbed", () => {
  const paragraphs = numberedParagraphs(
    [
      "Opening prose of the part sits here.",
      "The Missouri Compromise settled the question for a generation.",
      "Frontier towns grew after the railroad arrived and the settlers stayed.",
      "Washington led the army and the war ended in the spring.",
      "The constitution was written after the peace and the people ratified it.",
    ].join("\n\n"),
    100
  );

  it("places an unanchored topic by similarity and keeps the verbatim anchor", async () => {
    const calls: Call[] = [];
    const placed = await placePartTopicsByEmbed(
      ["The Missouri Compromise", "Railroad frontier", "Constitution debates", "Unrelated musings"],
      paragraphs,
      { config: CONFIG, fetch: embedFetch(calls) }
    );
    expect([...(placed?.entries() ?? [])]).toEqual([
      [0, 2],
      [1, 3],
      [2, 5],
    ]);
    // Only open topics are embedded, as prefixed queries.
    expect(calls[0]!.input).toEqual([
      "Q: Railroad frontier",
      "Q: Constitution debates",
      "Q: Unrelated musings",
    ]);
    expect(calls[1]!.input).toHaveLength(paragraphs.length);
  });

  it("returns null when not configured or on a fetch error", async () => {
    expect(
      await placePartTopicsByEmbed(["Railroad frontier"], paragraphs, { config: null, fetch: embedFetch() })
    ).toBeNull();
    const boom: typeof fetch = async () => {
      throw new Error("network down");
    };
    expect(
      await placePartTopicsByEmbed(["Railroad frontier"], paragraphs, { config: CONFIG, fetch: boom })
    ).toBeNull();
  });
});

const BOOK = [
  "CONTENTS",
  "Preface",
  "PART ONE",
  "'A City on a Hill'",
  "Colonial America, 1580—1750",
  "The Missouri Compromise",
  "Railroad towns",
  "PART TWO",
  "'That the Free Constitution Be Sacredly Maintained'",
  "Revolutionary America, 1750—1815",
  "PREFACE",
  "This work is a labor of love. When I was a little boy my parents taught me a great deal of history, and the name of America scarcely intruded at school.",
  "PART ONE",
  "'A City on a Hill' Colonial America, 1580—1750 The creation of the United States of America is the greatest of all human adventures.",
  "The Missouri Compromise settled the question for a generation.",
  "The railroad arrived and the settlers stayed in the frontier towns.",
  "PART TWO",
  "'That the Free Constitution Be Sacredly Maintained' Revolutionary America, 1750—1815 Washington led the continental army through a long war. The constitution was written after the peace and the people ratified it.",
].join("\n\n");

describe("printed-toc placement", () => {
  const hint = { source: "heading-lines" as const, titles: [] };

  it("rebuilds children from embeddings", async () => {
    const sync = resolveChapters(BOOK, hint);
    expect(sync.source).toBe("printed-toc");
    const placed = await placePrintedTocTopicsByEmbed(BOOK, sync, hint, {
      config: CONFIG,
      fetch: embedFetch(),
    });
    expect(placed?.chapters[1]?.children?.map((child) => child.title)).toEqual([
      "The Missouri Compromise",
      "Railroad towns",
    ]);
  });

  it("returns null when no key is configured", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const sync = resolveChapters(BOOK, hint);
    expect(await placePrintedTocTopicsByEmbed(BOOK, sync, hint, { fetch: embedFetch() })).toBeNull();
  });

  it("resolveChaptersForBook uses embeddings when CHAPTER_TOPIC_EMBED=1", async () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    delete process.env.CHAPTER_TOPIC_LLM;
    delete process.env.CHAPTER_TOPIC_EMBED;
    const urls: string[] = [];
    const counting: typeof fetch = async (url, init) => {
      urls.push(String(url));
      return embedFetch()(url, init);
    };
    const off = await resolveChaptersForBook(BOOK, hint, { fetch: counting });
    expect(urls).toHaveLength(0);
    expect(off.chapters[1]?.children?.map((child) => child.title)).toEqual([
      "The Missouri Compromise",
    ]);

    process.env.CHAPTER_TOPIC_EMBED = "1";
    const on = await resolveChaptersForBook(BOOK, hint, { fetch: counting });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url === "https://openrouter.ai/api/v1/embeddings")).toBe(true);
    expect(on.chapters[1]?.children?.map((child) => child.title)).toEqual([
      "The Missouri Compromise",
      "Railroad towns",
    ]);
  });

  it("keeps the verbatim tree when embeddings fail and the chat model is off", async () => {
    process.env.CHAPTER_TOPIC_EMBED = "1";
    process.env.OPENROUTER_API_KEY = "or-key";
    delete process.env.CHAPTER_TOPIC_LLM;
    const boom: typeof fetch = async () => {
      throw new Error("network down");
    };
    const doc = await resolveChaptersForBook(BOOK, hint, { fetch: boom, apiKey: "k" });
    expect(doc.chapters[1]?.children?.map((child) => child.title)).toEqual([
      "The Missouri Compromise",
    ]);
  });
});
