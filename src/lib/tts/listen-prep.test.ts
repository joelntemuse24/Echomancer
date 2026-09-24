import { describe, expect, it } from "vitest";
import {
  LISTEN_PREP_MAX_TOKENS,
  LISTEN_PREP_TIMEOUT_MS,
  applyListenPrep,
  coerceListenPrepPlan,
  listenPrepFront,
  planListenPrep,
  prepareForListening,
} from "./listen-prep";

const FRONT = [
  "The Harbor",
  "",
  "Copyright © 2014 Example Press. All rights reserved.",
  "",
  "ISBN 978-0-000-00000-0",
  "",
  "Foreword",
  "",
  "A short note from the editor, kept for the listener.",
  "",
  "Introduction The harbor was quiet after the rain.",
  "",
  "Chapter One",
  "",
  "She closed the ledger.",
].join("\n");

describe("applyListenPrep", () => {
  it("drops copyright lines, keeps a foreword, and speaks Introduction alone", () => {
    const next = applyListenPrep(FRONT, {
      drop: ["Copyright © 2014 Example Press. All rights reserved.", "ISBN 978-0-000-00000-0"],
      headings: ["Introduction"],
    });
    expect(next).not.toMatch(/Copyright/);
    expect(next).not.toMatch(/ISBN/);
    expect(next).toMatch(/Foreword/);
    expect(next).toMatch(/A short note from the editor/);
    expect(next).toMatch(/Introduction\n\nThe harbor was quiet/);
    expect(next).toMatch(/Chapter One/);
    expect(next).toMatch(/She closed the ledger/);
  });

  it("does not drop a phrase the front does not contain", () => {
    const plan = coerceListenPrepPlan(
      { drop: ["This sentence was invented"], headings: [] },
      FRONT
    );
    expect(plan.drop).toEqual([]);
  });

  it("does not drop a later mention or a foreword that only contains the phrase", () => {
    const book = `${FRONT}\n\nShe mentioned the copyright in passing.\n\nThe ISBN stayed in the story.`;
    const next = applyListenPrep(book, {
      drop: [
        "Copyright © 2014 Example Press. All rights reserved.",
        "ISBN 978-0-000-00000-0",
        "copyright",
      ],
      headings: ["Introduction"],
    });
    expect(next).toMatch(/She mentioned the copyright in passing/);
    expect(next).toMatch(/A short note from the editor/);
    expect(next).not.toMatch(/All rights reserved/);
  });

  it("stops before a numbered chapter and does not split a sentence", () => {
    const book = [
      "Copyright © 2014 Example Press. All rights reserved.",
      "",
      "Introduction of the bill took all winter.",
      "",
      "1",
      "",
      "She mentioned the copyright in passing.",
    ].join("\n");
    const next = applyListenPrep(book, {
      drop: ["Copyright © 2014 Example Press. All rights reserved.", "copyright"],
      headings: ["Introduction", "In"],
    });
    expect(next).toMatch(/Introduction of the bill took all winter/);
    expect(next).toMatch(/She mentioned the copyright in passing/);
    expect(next).not.toMatch(/^In\n/m);
  });

  it("cuts the model input at the first chapter", () => {
    const front = listenPrepFront(`${FRONT}\n\n${"Later prose. ".repeat(800)}`);
    expect(front).toMatch(/Chapter One/);
    expect(front).not.toMatch(/Later prose/);
  });
});

describe("planListenPrep", () => {
  it("sends only the front, pinned to DeepSeek, with a short budget", async () => {
    let body: {
      model?: string;
      max_tokens?: number;
      provider?: { only?: string[] };
      messages?: Array<{ role: string; content: string }>;
    } = {};
    const plan = await planListenPrep({
      rawText: `${FRONT}\n\n${"Later prose. ".repeat(800)}`,
      title: "The Harbor",
      apiKey: "test",
      timeoutMs: LISTEN_PREP_TIMEOUT_MS,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body || "{}"));
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"drop":[],"headings":[]}' } }],
          }),
          { status: 200 }
        );
      },
    });
    expect(plan).toEqual({ drop: [], headings: [] });
    expect(body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(body.max_tokens).toBe(LISTEN_PREP_MAX_TOKENS);
    expect(body.provider?.only).toEqual(["deepseek"]);
    const user = body.messages?.find((message) => message.role === "user")?.content || "";
    expect(user).toContain("Title: The Harbor");
    expect(user).toContain("Chapter One");
    expect(user).not.toContain("Later prose");
  });
});

describe("prepareForListening", () => {
  it("returns the original text when the call fails", async () => {
    const next = await prepareForListening(FRONT, {
      title: "The Harbor",
      apiKey: "test",
      fetch: async () => new Response("no", { status: 500 }),
    });
    expect(next).toBe(FRONT);
  });
});
