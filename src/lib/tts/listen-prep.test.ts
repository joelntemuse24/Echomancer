import { describe, expect, it } from "vitest";
import {
  LISTEN_PREP_MAX_DROP_SHARE,
  acceptListenOps,
  applyListenOps,
  coerceListenOps,
  deterministicPrepass,
  isIndexLikeChunk,
  isReferenceLine,
  lineSpans,
  listenBookTitle,
  prepassDropIds,
  prepareForListening,
  splitListenChunks,
  withoutProseDrops,
} from "./listen-prep";

const FIXTURE = [
  "The Harbor",
  "12",
  "She walked to the quay and closed the ledger.",
  "The Harbor",
  "She kept the letter in the drawer.",
  "",
].join("\n");

describe("applyListenOps", () => {
  it("drops page numbers and a running header without changing kept bytes", () => {
    const lines = lineSpans(FIXTURE);
    const page = lines.find((line) => line.text === "12")!;
    const headers = lines.filter((line) => line.text === "The Harbor");
    const running = headers[1]!;
    const next = applyListenOps(FIXTURE, {
      drop: [page.id, running.id],
      headings: [headers[0]!.id],
    });
    expect(next).toBe(
      "The Harbor\nShe walked to the quay and closed the ledger.\nShe kept the letter in the drawer.\n"
    );
    expect(next).toContain("She walked to the quay and closed the ledger.");
    expect(next).not.toMatch(/^12$/m);
  });

  it("rejects a drop that takes more than 40% of a prose chunk", () => {
    const prose = "She walked to the quay and closed the ledger.\n".repeat(4);
    const applied = acceptListenOps(prose, { drop: [1, 2, 3], headings: [] });
    expect(applied.accepted).toBe(false);
    expect(applied.text).toBe(prose);
    expect(LISTEN_PREP_MAX_DROP_SHARE).toBe(0.4);
  });

  it("allows a large drop on a copyright page", () => {
    const front = [
      "Copyright © 2014 Example Press. All rights reserved.",
      "ISBN 978-0-000-00000-0",
      "12",
      "Cataloging-in-Publication Data",
    ].join("\n");
    const applied = acceptListenOps(front, { drop: [1, 2, 3, 4], headings: [] });
    expect(applied.accepted).toBe(true);
    expect(applied.text.length).toBeGreaterThan(0);
    expect(applied.text.length).toBeLessThan(front.length);
    expect(applied.text).not.toBe("");
    expect(front.includes(applied.text.trim().split("\n")[0] || "missing")).toBe(true);
  });

  it("refuses a full drop of dialogue, verse, a play, or a short paste", () => {
    const dialogue = [
      '"We leave at dawn," she said.',
      '"The tide will not wait," he said.',
      '"Then we row," she said.',
    ].join("\n");
    const verse = ["The harbor", "was quiet", "after rain"].join("\n");
    const play = ["HAMLET: To be or not to be.", "OPHELIA: Good night, ladies."].join("\n");
    const paste = "She walked to the quay and closed the ledger before dawn.";
    for (const chunk of [dialogue, verse, play, paste]) {
      const ids = lineSpans(chunk).map((line) => line.id);
      const applied = acceptListenOps(chunk, { drop: ids, headings: [] });
      expect(applied.accepted).toBe(false);
      expect(applied.text).toBe(chunk);
    }
  });
});

function labelledRecall(
  chunk: string,
  proseLines: string[],
  clutterLines: string[]
): { recall: number; falseDrops: number } {
  const applied = acceptListenOps(chunk, {
    drop: lineSpans(chunk).map((line) => line.id),
    headings: [],
  });
  const kept = applied.text;
  const falseDrops = proseLines.filter((line) => !kept.includes(line)).length;
  const missed = clutterLines.filter((line) => kept.includes(line)).length;
  return {
    recall: clutterLines.length === 0 ? 1 : (clutterLines.length - missed) / clutterLines.length,
    falseDrops,
  };
}

describe("clutter recall", () => {
  it("keeps an index drop instead of rejecting it as prose", () => {
    const prose = [
      "She walked to the quay and closed the ledger before the rain began.",
      "He kept the letter in the drawer beside the window until dawn.",
    ];
    const index = Array.from({ length: 208 }, (_, i) => `Surname${i}, Given, ${i + 1}, ${i + 3}-${i + 5}`);
    const chunk = [prose[0], ...index, prose[1]].join("\n");
    const score = labelledRecall(chunk, prose, index);
    expect(score.falseDrops).toBe(0);
    expect(score.recall).toBeGreaterThanOrEqual(0.95);
  });

  it("drops front-matter lines and keeps the reading sentence", () => {
    const reading = "The harbor was quiet after the rain, and she closed the ledger.";
    const front = [
      "Copyright © 2014 Example Press. All rights reserved.",
      "ISBN 978-0-000-00000-0",
      ...Array.from({ length: 70 }, (_, i) => `Chapter Title ${i} .......... ${i + 1}`),
      reading,
    ];
    const clutter = front.filter((line) => line !== reading);
    const score = labelledRecall(front.join("\n"), [reading], clutter);
    expect(score.falseDrops).toBe(0);
    expect(score.recall).toBeGreaterThanOrEqual(0.95);
  });

  it("drops bibliography lines and keeps the paragraph", () => {
    const paragraph =
      "she walked to the quay and closed the ledger before the rain began to fall on the stones and she did not look back at the boats tied along the harbor wall.";
    const notes = Array.from(
      { length: 347 },
      (_, i) => `Smith ${i}, A History of the Harbor. See also Jones, ${i + 12}.`
    );
    const score = labelledRecall([paragraph, ...notes].join("\n"), [paragraph], notes);
    expect(paragraph.length).toBeGreaterThanOrEqual(150);
    expect(score.falseDrops).toBe(0);
    expect(score.recall).toBeGreaterThanOrEqual(0.95);
  });

  it("scores realistic endnotes, a Chicago bibliography, and an index", () => {
    const prose = [
      "For my mother, who kept the lamp lit.",
      "The harbor was quiet after the rain, and she closed the ledger.",
      "She walked to the quay and closed the ledger before the rain began.",
      '"I see him," she said.',
      "The fleet lost nearly 300",
      "in 1914, 1915 and 1916.",
      "Chapter 13",
      "Part Two",
    ];
    for (const line of prose) expect(isReferenceLine(line)).toBe(false);
    const endnotes = [
      "1. Smith, History of Boston (Boston: X Press, 1990), 45.",
      "2. Ibid., 67.",
      "3. Adams, The Ledger (Cambridge: Yard Press, 1988), 12-14.",
      "4. Ibid., 90.",
    ];
    const bibliography = [
      "Smith, John. A History of Boston. Boston: Beacon Press, 1990.",
      "Jones, Mary. The Harbor Ledger. New York: River Books, 2004.",
      "Adams, Ruth. Colonial Lights. Chicago: Lake Press, 1976.",
      "Nguyen, Lan. Yellow Fever. London: North Press, 2011.",
    ];
    const index = [
      "Apples, see Fruit",
      "yellow fever, 412",
      "  in colonial period, 34",
      "Boston, 12, 18-20",
      "harbor lights, 44",
      "Fruit, 12, 40-42",
    ];
    const clutter = [...endnotes, ...bibliography, ...index];
    for (const line of clutter) expect(isReferenceLine(line), line).toBe(true);
    const endnoteLines = [...endnotes, ...endnotes, ...endnotes];
    const indexLines = [...index, ...index, ...index, ...index];
    const bibliographyLines = [...bibliography, ...bibliography, ...bibliography];
    const endnoteScore = labelledRecall([...prose, ...endnoteLines].join("\n"), prose, endnoteLines);
    const indexScore = labelledRecall([...prose, ...indexLines].join("\n"), prose, indexLines);
    const bibliographyScore = labelledRecall(
      [...prose, ...bibliographyLines].join("\n"),
      prose,
      bibliographyLines
    );
    expect(endnoteScore).toEqual({ recall: 1, falseDrops: 0 });
    expect(indexScore).toEqual({ recall: 1, falseDrops: 0 });
    expect(bibliographyScore).toEqual({ recall: 1, falseDrops: 0 });
  });
});

describe("deterministicPrepass", () => {
  it("drops sequential page numbers, a repeated header, and Gutenberg boilerplate", () => {
    const book = [
      "The Project Gutenberg eBook of Harbor",
      "*** START OF THE PROJECT GUTENBERG EBOOK HARBOR ***",
      "The Harbor",
      "She walked to the quay and closed the ledger before the rain.",
      "12",
      "The Harbor",
      "She kept the letter in the drawer beside the window.",
      "13",
      "The Harbor",
      "14",
      "The Harbor",
      "The rain kept on.",
      "15",
      "The Harbor",
      "She turned the page.",
      "16",
      "The Harbor",
      "The HarborShe walked on with the letter still in her hand and did not look back at the quay.",
      "*** END OF THE PROJECT GUTENBERG EBOOK HARBOR ***",
      "This ebook is for the use of anyone anywhere.",
    ].join("\n");
    const next = deterministicPrepass(book);
    expect(next).not.toMatch(/Project Gutenberg/i);
    expect(next).not.toMatch(/^12$/m);
    expect(next).not.toMatch(/^13$/m);
    expect(next).toContain("The Harbor");
    expect(next.match(/^The Harbor$/gm)?.length).toBe(1);
    expect(next).toContain("She walked to the quay and closed the ledger before the rain.");
    expect(next).toContain(
      "The HarborShe walked on with the letter still in her hand and did not look back at the quay."
    );
  });

  it("sees a page number past a blank line and keeps the title once", () => {
    const book = [
      "The Harbor",
      "",
      "12",
      "She walked to the quay and closed the ledger before the rain.",
      "",
      "The Harbor",
      "",
      "13",
      "She kept the letter in the drawer beside the window.",
      "",
      "The Harbor",
      "",
      "14",
    ].join("\n");
    const next = deterministicPrepass(book);
    expect(next.match(/^The Harbor$/gm)?.length).toBe(1);
    expect(next.startsWith("The Harbor")).toBe(true);
    expect(next).not.toMatch(/^12$/m);
    expect(next).not.toMatch(/^13$/m);
    expect(next).not.toMatch(/^14$/m);
    expect(next).toContain("She walked to the quay and closed the ledger before the rain.");
  });

  it("counts repeated headers in linear time", () => {
    const lines = Array.from({ length: 1500 }, (_, i) =>
      i % 2 === 0 ? `Harbor Note ${i % 7}` : String((i % 40) + 1)
    );
    const started = Date.now();
    const dropped = prepassDropIds(lines.map((text, index) => ({ id: index + 1, text })));
    expect(Date.now() - started).toBeLessThan(200);
    expect(dropped.length).toBeGreaterThan(0);
  });
});

describe("title once and hand-labelled lines", () => {
  it("keeps chapter headings, speaker labels, and a refrain", () => {
    const book = [
      "The Harbor",
      "Chapter 12",
      "She walked to the quay.",
      "Chapter 13",
      "HAMLET",
      "To be or not to be.",
      "Nevermore",
      "The lamps were lit.",
      "Nevermore",
      '"I see him," she said.',
      "The fleet lost nearly 300",
      "in 1914, 1915 and 1916.",
    ].join("\n");
    const next = deterministicPrepass(book);
    expect(next).toContain("Chapter 12");
    expect(next).toContain("Chapter 13");
    expect(next).toContain("HAMLET");
    expect(next).toContain("Nevermore");
    expect(next.match(/Nevermore/g)?.length).toBe(2);
    expect(next).toContain('"I see him," she said.');
    expect(next).toContain("lost nearly 300");
    expect(next).toContain("1914, 1915 and 1916");
  });

  it("does not treat a leading chapter heading as the book title", () => {
    const book = [
      "Chapter 1",
      "She walked to the quay and closed the ledger before the rain.",
      "12",
      "Chapter 1",
      "She kept the letter in the drawer beside the window.",
    ].join("\n");
    expect(listenBookTitle(book)).toBeNull();
    const lines = lineSpans(book);
    const dropped = prepassDropIds(lines, {
      bookTitle: listenBookTitle(book),
      keepTitleId: null,
    });
    const chapterIds = lines.filter((line) => line.text === "Chapter 1").map((line) => line.id);
    expect(chapterIds.every((id) => !dropped.includes(id))).toBe(true);
    expect(deterministicPrepass(book).match(/^Chapter 1$/gm)?.length).toBe(2);
  });

  it("keeps speaker labels that repeat beside page numbers", () => {
    const lines = ["The Play"];
    for (let i = 0; i < 6; i++) {
      lines.push(String(20 + i), "HAMLET", '"To be or not to be."');
    }
    const next = deterministicPrepass(lines.join("\n"));
    expect(next.match(/^HAMLET$/gm)?.length).toBe(6);
    expect(next).toContain('"To be or not to be."');
  });

  it("does not treat title-case lines without page refs as an index", () => {
    const speakers = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? "HAMLET" : "OPHELIA"
    );
    expect(isIndexLikeChunk(speakers.join("\n"))).toBe(false);
    const applied = acceptListenOps(speakers.join("\n"), {
      drop: speakers.map((_, i) => i + 1),
      headings: [],
    });
    expect(applied.accepted).toBe(false);
    expect(applied.text).toContain("HAMLET");
  });

  it("does not drop a heading the model kept when the chunk opens on a chapter", async () => {
    process.env.LISTEN_PREP_RETRY_MS = "0";
    const book = [
      "Chapter 12",
      "She walked to the quay and closed the ledger before the rain.",
      "Chapter 13",
      "She kept the letter in the drawer beside the window.",
    ].join("\n");
    const next = await prepareForListening(book, {
      apiKey: "test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    drop: [],
                    headings: ["3"],
                    note: {
                      kind: "novel",
                      novelKind: null,
                      tone: "quiet",
                      pov: "third",
                      dialogue: "low",
                    },
                  }),
                },
              },
            ],
          })
        ),
    });
    expect(next.text).toContain("Chapter 12");
    expect(next.text).toContain("Chapter 13");
    delete process.env.LISTEN_PREP_RETRY_MS;
  });

  it("keeps Chapter and Part headings when the model drops them", async () => {
    process.env.LISTEN_PREP_RETRY_MS = "0";
    const book = [
      "Chapter 13",
      "She walked to the quay and closed the ledger before the rain.",
      "Part Two",
      "She kept the letter in the drawer beside the window.",
    ].join("\n");
    const next = await prepareForListening(book, {
      apiKey: "test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    drop: ["1", "3"],
                    headings: [],
                    note: {
                      kind: "novel",
                      novelKind: null,
                      tone: "quiet",
                      pov: "third",
                      dialogue: "low",
                    },
                  }),
                },
              },
            ],
          })
        ),
    });
    expect(next.text).toContain("Chapter 13");
    expect(next.text).toContain("Part Two");
    delete process.env.LISTEN_PREP_RETRY_MS;
  });
});

describe("prose check and ranges", () => {
  it("refuses a long paragraph and still expands a drop range", () => {
    const prose =
      "she walked to the quay and closed the ledger before the rain began to fall on the stones and she did not look back at the boats tied along the harbor wall.";
    expect(prose.length).toBeGreaterThanOrEqual(150);
    const chunk = `12\n${prose}\n`;
    const ops = coerceListenOps({ drop: ["1-2"], headings: [] }, 2);
    expect(ops?.drop).toEqual([1, 2]);
    const checked = withoutProseDrops(chunk, ops!);
    expect(checked.drop).toEqual([1]);
  });
});

describe("prepareForListening", () => {
  it("retries a 429 once and asks Gemini with a strict schema", async () => {
    process.env.LISTEN_PREP_RETRY_MS = "0";
    let calls = 0;
    const next = await prepareForListening(FIXTURE, {
      apiKey: "test",
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("google/gemini-3.8-flash");
        expect(body.max_tokens).toBe(4000);
        expect(body.reasoning).toEqual({ effort: "minimal" });
        expect(body.provider.order).toEqual(["google-ai-studio", "google-vertex"]);
        expect(body.response_format.json_schema.strict).toBe(true);
        expect(body.provider.only).toBeUndefined();
        if (calls === 1) return new Response("busy", { status: 429 });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    drop: ["2"],
                    headings: [],
                    note: {
                      kind: "novel",
                      novelKind: "literary",
                      tone: "quiet",
                      pov: "third",
                      dialogue: "low",
                    },
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });
    expect(calls).toBe(2);
    expect(next.text).not.toMatch(/^12$/m);
    expect(next.text).toContain("She walked to the quay and closed the ledger.");
    expect(next.notes[0]?.kind).toBe("novel");
    delete process.env.LISTEN_PREP_RETRY_MS;
  });

  it("uses the pre-pass text when the model and the fallback both fail", async () => {
    process.env.LISTEN_PREP_RETRY_MS = "0";
    const book = ["10", "11", "She walked to the quay and closed the ledger.", "12"].join("\n");
    const next = await prepareForListening(book, {
      apiKey: "test",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    expect(next.text).not.toMatch(/^10$/m);
    expect(next.text).not.toMatch(/^11$/m);
    expect(next.text).toContain("She walked to the quay and closed the ledger.");
    expect(next.failOpenChunks).toBeGreaterThan(0);
    delete process.env.LISTEN_PREP_RETRY_MS;
  });

  it("leaves reading in place when both replies are not json", async () => {
    const next = await prepareForListening(FIXTURE, {
      apiKey: "test",
      fetch: async () => new Response("nope", { status: 200 }),
    });
    expect(next.text).toContain("She walked to the quay and closed the ledger.");
    expect(next.text).toContain("She kept the letter in the drawer.");
    expect(next.failOpenChunks).toBe(1);
    expect(next.chunks[0]?.ok).toBe(false);
  });

  it("asks the fallback model when the primary reply is not json", async () => {
    const models: string[] = [];
    const next = await prepareForListening(FIXTURE, {
      apiKey: "test",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        models.push(body.model);
        if (body.model.startsWith("google/")) return new Response("not json", { status: 200 });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    drop: ["2"],
                    headings: ["1"],
                    note: {
                      kind: "novel",
                      novelKind: null,
                      tone: "",
                      pov: "",
                      dialogue: null,
                    },
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });
    expect(models).toEqual([
      "google/gemini-3.8-flash",
      "deepseek/deepseek-v4.1-flash",
    ]);
    expect(next.text).not.toMatch(/^12$/m);
    expect(next.text).toContain("The Harbor");
    expect(next.chunks[0]?.ok).toBe(false);
  });

  it("drops a page number inside prose and keeps the sentences", () => {
    const applied = acceptListenOps(FIXTURE, {
      drop: lineSpans(FIXTURE).map((line) => line.id),
      headings: [],
    });
    expect(applied.text).toContain("She walked to the quay and closed the ledger.");
    expect(applied.text).toContain("She kept the letter in the drawer.");
    expect(applied.text).not.toMatch(/^12$/m);
  });

  it("retries only chunks that have not succeeded", async () => {
    const book = `${"She walked to the quay.\n".repeat(2000)}${"He waited by the door.\n".repeat(2000)}`;
    const chunks = splitListenChunks(book);
    expect(chunks.length).toBeGreaterThan(1);
    let calls = 0;
    await prepareForListening(book, {
      apiKey: "test",
      prior: chunks.map((text, index) => ({
        ok: index !== chunks.length - 1,
        text,
        note: null,
      })),
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"drop":[],"headings":[],"note":{"kind":"novel","novelKind":null,"tone":"","pov":"","dialogue":null}}',
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });
    expect(calls).toBe(1);
  });

  it("splits a long book into chunks instead of a front sample", () => {
    const book = `${"She walked to the quay.\n".repeat(2000)}END_OF_BOOK`;
    const chunks = splitListenChunks(book);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(book);
    expect(chunks[chunks.length - 1]).toContain("END_OF_BOOK");
  });
});
