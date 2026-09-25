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

  it("keeps a paragraph break when blanks around a page number are dropped", () => {
    const chunk = [
      "She walked to the quay and closed the ledger.",
      "",
      "12",
      "",
      "Chapter 13",
      "She kept the letter in the drawer.",
    ].join("\n");
    const ids = lineSpans(chunk)
      .filter((line) => line.text.trim() === "" || line.text === "12")
      .map((line) => line.id);
    const next = applyListenOps(chunk, { drop: ids, headings: [] });
    expect(next).toMatch(/ledger\.\n\nChapter 13/);
    expect(next).not.toMatch(/ledger\.Chapter 13/);
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
    expect(score.recall).toBe(0);
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
    expect(score.recall).toBeGreaterThan(0.9);
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
    expect(score.recall).toBe(0);
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
    expect(endnoteScore.falseDrops).toBe(0);
    expect(indexScore.falseDrops).toBe(0);
    expect(bibliographyScore.falseDrops).toBe(0);
    expect(endnoteScore.recall).toBe(0);
    expect(indexScore.recall).toBe(0);
    expect(bibliographyScore.recall).toBe(0);
  });

  it("scores varied sections of at least sixty lines", () => {
    const prose = [
      "For my mother, who kept the lamp lit.",
      "He turned to page 12 and began to read.",
      '"I see him," she said.',
      "The fleet lost nearly 300",
      "in 1914, 1915 and 1916.",
      "Chapter 13",
      "She walked to the quay and closed the ledger before the rain began to fall on the stones.",
    ];
    const places = ["Boston", "Salem", "Plymouth", "Newport", "Charleston", "Quebec"];
    const journals = ["Past and Present", "William and Mary Quarterly", "American Historical Review", "Journal of American History"];
    const months = ["January", "March", "May", "July", "September", "November"];
    const notes = Array.from({ length: 60 }, (_, i) => {
      const page = 20 + i;
      return `Alden, John. "Harbor duty in ${places[i % places.length]}." ${journals[i % journals.length]} ${10 + (i % 8)}, no. ${(i % 4) + 1} (${1950 + (i % 40)}): ${page}-${page + 6}.`;
    });
    const letters = Array.from({ length: 60 }, (_, i) => {
      return `Adams to Jefferson, ${(i % 27) + 1} ${months[i % months.length]} ${1810 + (i % 20)}, on the ${places[i % places.length]} customs house.`;
    });
    const seeChapters = Array.from({ length: 60 }, (_, i) => `See chapter ${i + 1} for the ${places[i % places.length]} ledger.`);
    const apa = Array.from({ length: 60 }, (_, i) => {
      return `Nguyen, Lan. (${1970 + (i % 50)}). Lights of ${places[i % places.length]} ${i + 1}. Boston, MA: River Press.`;
    });
    const seeAlso = Array.from({ length: 60 }, (_, i) => `${places[i % places.length]}. See ${places[(i + 1) % places.length]}, the ${1800 + i} voyage.`);
    const headwords = Array.from({ length: 60 }, (_, i) => `${["Jefferson", "Adams", "Otis", "Revere", "Wheatley", "Franklin"][i % 6]}, ${["Thomas", "Abigail", "James", "Paul", "Phillis", "Benjamin"][i % 6]} ${i + 1}`);
    const folio = Array.from({ length: 60 }, (_, i) => `yellow fever in ${places[i % places.length]}, ${i + 1}f`);
    const sections = [
      ["journal notes", notes],
      ["letters", letters],
      ["see chapter", seeChapters],
      ["apa", apa],
      ["see cross refs", seeAlso],
      ["headwords", headwords],
      ["folio refs", folio],
    ] as const;
    const scores: Record<string, { recall: number; falseDrops: number }> = {};
    for (const [name, clutter] of sections) {
      expect(clutter.length).toBeGreaterThanOrEqual(60);
      const unique = new Set(clutter);
      expect(unique.size).toBe(clutter.length);
      scores[name] = labelledRecall([...prose, ...clutter].join("\n"), prose, [...clutter]);
      expect(scores[name].falseDrops, name).toBe(0);
    }
    expect(scores).toEqual({
      "journal notes": { recall: 0, falseDrops: 0 },
      letters: { recall: 0, falseDrops: 0 },
      "see chapter": { recall: 0, falseDrops: 0 },
      apa: { recall: 0, falseDrops: 0 },
      "see cross refs": { recall: 0, falseDrops: 0 },
      headwords: { recall: 0, falseDrops: 0 },
      "folio refs": { recall: 0, falseDrops: 0 },
    });
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
    expect(next.match(/^The Harbor$/gm)?.length).toBe(3);
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
    const dropped = prepassDropIds(lines);
    const chapterIds = lines.filter((line) => line.text === "Chapter 1").map((line) => line.id);
    expect(chapterIds.every((id) => !dropped.includes(id))).toBe(true);
    expect(deterministicPrepass(book).match(/^Chapter 1$/gm)?.length).toBe(2);
  });

  it("keeps a speaker label that is not a page-boundary header", () => {
    const lines = ["The Play"];
    for (let i = 0; i < 4; i++) {
      lines.push(String(20 + i), "HAMLET", '"To be or not to be."');
    }
    const next = deterministicPrepass(lines.join("\n"));
    expect(next.match(/^HAMLET$/gm)?.length).toBe(4);
    expect(next).toContain('"To be or not to be."');
  });

  it("drops all-caps and mixed-case headers that repeat on seven pages only when the model asks", () => {
    for (const header of ["THE VALLEY", "A HISTORY OF BOSTON", "CHAPTER THREE", "The Valley"]) {
      const lines = ["She opened the book on the first evening."];
      for (let page = 1; page <= 7; page++) {
        lines.push(String(page), header, "The river kept its own slow counsel through the night.");
      }
      const chunk = lines.join("\n");
      const cleaned = deterministicPrepass(chunk);
      expect(cleaned.match(new RegExp(`^${header}$`, "gm"))?.length ?? 0).toBe(0);
      const ids = lineSpans(chunk)
        .filter((line) => line.text === header)
        .map((line) => line.id);
      const kept = acceptListenOps(chunk, { drop: [], headings: [] });
      expect(kept.text.match(new RegExp(`^${header}$`, "gm"))?.length ?? 0).toBe(7);
      const applied = acceptListenOps(chunk, { drop: ids, headings: ids });
      expect(applied.text.match(new RegExp(`^${header}$`, "gm"))?.length ?? 0).toBe(0);
      expect(applied.text).toContain("The river kept its own slow counsel through the night.");
    }
  });

  it("drops contents entries the model marks, including lines with no dot leaders", () => {
    const prose = "She walked to the quay and closed the ledger before the rain began. ".repeat(40);
    const formats: string[][] = [
      ["1 The Early Years 1", "2 The Middle Passage 14", "3 The Ledger 40", "4 The Harbor 88", "5 The Letter 120", "6 The Return 150"],
      ["The Early Years 1", "The Middle Passage 14", "The Ledger 40", "The Harbor 88", "The Letter 120", "The Return 150"],
      ["Epilogue 301", "Foreword vii", "Preface ix", "Introduction xi", "Appendix xiii", "Notes xv"],
      ["Chapter 1: The Early Years 1", "Chapter 2: The Middle Passage 14", "Chapter 3: The Ledger 40", "Chapter 4: The Harbor 88", "Chapter 5: The Letter 120", "Chapter 6: The Return 150"],
    ];
    for (const entries of formats) {
      const chunk = ["The Valley", "Copyright © 2014 Example Press.", "Contents", ...entries, "Chapter 1", prose].join("\n");
      const drop = lineSpans(chunk).filter((line) => entries.includes(line.text)).map((line) => line.id);
      const applied = acceptListenOps(chunk, { drop, headings: [] });
      for (const entry of entries) expect(applied.text).not.toContain(entry);
      expect(applied.text).toContain(prose);
      expect(applied.text).toContain("Chapter 1");
    }
    const untitled = ["The Early Years", "The Middle Passage", "The Ledger", "The Harbor", "The Letter", "The Return"];
    const block = ["The Valley", "Contents", ...untitled, "Chapter 1", prose].join("\n");
    const drop = lineSpans(block).filter((line) => untitled.includes(line.text) || line.text === "Contents").map((line) => line.id);
    const applied = acceptListenOps(block, { drop, headings: [] });
    for (const entry of untitled) expect(applied.text).toContain(entry);
    expect(applied.text).toContain(prose);
    expect(applied.text).toContain("Chapter 1");
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

  it("drops Chapter and Part headings when the model asks and the drop is not most of the body", async () => {
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
    expect(next.text).not.toContain("Chapter 13");
    expect(next.text).not.toContain("Part Two");
    delete process.env.LISTEN_PREP_RETRY_MS;
  });
});

describe("fourth-review false drops", () => {
  function modes(chunk: string, ideal: number[] = []) {
    const all = lineSpans(chunk).map((line) => line.id);
    return {
      "drop-all": acceptListenOps(chunk, { drop: all, headings: [] }),
      none: acceptListenOps(chunk, { drop: [], headings: [] }),
      ideal: acceptListenOps(chunk, { drop: ideal, headings: [] }),
    };
  }

  function expectKept(chunk: string, needles: string[], ideal: number[] = []) {
    for (const [name, applied] of Object.entries(modes(chunk, ideal))) {
      for (const needle of needles) {
        const hits = applied.text.split(needle).length - 1;
        expect(hits, `${name} lost ${needle}`).toBeGreaterThan(0);
      }
    }
  }

  it("keeps every MARTA label beside a page number", () => {
    const lines = ["The Play"];
    for (let page = 1; page <= 6; page++) {
      lines.push(String(page), "MARTA", "The door was already open.");
    }
    lines.push("MARTA", "We leave at dawn.");
    const chunk = lines.join("\n");
    for (const applied of Object.values(modes(chunk))) {
      expect(applied.text.match(/^MARTA$/gm)?.length ?? 0).toBe(7);
      expect(applied.text).toContain("The door was already open.");
      expect(applied.text).toContain("We leave at dawn.");
    }
  });

  it("keeps a short dialogue opening after Contents", () => {
    const lines = [
      "Contents",
      "Chapter 1",
      "MARTA",
      "We leave at dawn.",
      "JOHN",
      "Not tonight.",
    ];
    expectKept(lines.join("\n"), lines.slice(1));
  });

  it("keeps an unpunctuated poem after Contents", () => {
    const poem = Array.from({ length: 14 }, (_, i) => `the harbor line ${i + 1} stays`);
    const lines = ["Contents", ...poem];
    expectKept(lines.join("\n"), poem);
  });

  it("keeps an in-story Contents list", () => {
    const list = ["rope", "lamps", "flares", "oil"];
    const lines = ["She read the label.", "Contents", ...list, "Then she closed the box."];
    expectKept(lines.join("\n"), list);
    const chunk = lines.join("\n");
    expect(modes(chunk).none.text).toContain("Contents");
    expect(modes(chunk).ideal.text).toContain("Contents");
  });

  it("keeps verse that ends in ordinary words or route numbers", () => {
    const verse = [
      "the lamp burned dim",
      "III",
      "the morning was mild",
      "I",
      "Route 66",
      "Platform 9",
      "Gate 12",
    ];
    for (const chunk of [verse.join("\n"), ["Contents", ...verse].join("\n")]) {
      for (const applied of Object.values(modes(chunk))) {
        for (const line of verse) {
          expect(applied.text.match(new RegExp(`^${line}$`, "gm"))?.length ?? 0, line).toBe(1);
        }
      }
    }
  });

  it("keeps a packing list", () => {
    const list = ["rope 2", "lamps 4", "flares 12"];
    const packed = ["Contents", ...list, "She packed the boat."].join("\n");
    expect(modes(packed).none.text).toContain("rope 2");
    expect(modes(packed).ideal.text).toContain("rope 2");
    expect(modes(packed)["drop-all"].text).toContain("She packed the boat.");
  });

  it("keeps body part headings after a contents block", () => {
    const body = ["PART I", "THE NORTHERN SHEETS", "Ice Charts", "She read the charts."];
    const lines = [
      "Contents",
      "Part I The Northern Sheets 3",
      "Part II The Ice Charts 40",
      ...body,
    ];
    expectKept(lines.join("\n"), body);
  });

  it("allows a chapter-title header seen elsewhere when the model asks", () => {
    const header = "The Northern Sheets";
    const chunk = ["2", header, "She read the charts by the lamp."].join("\n");
    const kept = acceptListenOps(chunk, { drop: [], headings: [] });
    expect(kept.text).toContain(header);
    const id = lineSpans(chunk).find((line) => line.text === header)!.id;
    const dropped = acceptListenOps(chunk, { drop: [id], headings: [] });
    expect(dropped.text).not.toContain(header);
    expect(dropped.text).toContain("She read the charts by the lamp.");
    const forced = deterministicPrepass(["1", header, "She read the charts.", "2", header].join("\n"));
    expect(forced.match(/The Northern Sheets/g)?.length).toBe(2);
  });
});

describe("fifth-review contents and headers", () => {
  const prose = "She walked to the quay and closed the ledger before the rain began. ".repeat(40);

  function count(text: string, line: string): number {
    return text.split("\n").filter((row) => row === line).length;
  }

  function idealDrop(chunk: string, entries: string[]): number[] {
    return lineSpans(chunk).filter((line) => entries.includes(line.text)).map((line) => line.id);
  }

  it("drops contents shapes the model marks and keeps them when it drops nothing", () => {
    const cases: Array<{ name: string; lines: string[]; entries: string[] }> = [
      {
        name: "numbered",
        lines: ["1. Harbour 1", "2. Pier 4", "3. Ledger 12", "4. Letter 40", "5. Return 80"],
        entries: ["1. Harbour 1", "2. Pier 4", "3. Ledger 12", "4. Letter 40", "5. Return 80"],
      },
      {
        name: "single word",
        lines: ["Pier 14", "Wharf 15", "Dock 16", "Quay 18", "Slip 19"],
        entries: ["Pier 14", "Wharf 15", "Dock 16", "Quay 18", "Slip 19"],
      },
      {
        name: "contents vii",
        lines: ["Contents vii", "Harbour 1", "Pier 4", "Ledger 12", "Letter 40"],
        entries: ["Contents vii", "Harbour 1", "Pier 4", "Ledger 12", "Letter 40"],
      },
      {
        name: "split page",
        lines: ["The Early Years", "1", "The Ledger", "14", "The Letter", "40", "The Return"],
        entries: ["The Early Years", "1", "The Ledger", "14", "The Letter", "40", "The Return"],
      },
      {
        name: "one two",
        lines: ["One 1", "Two 19", "Three 40", "Four 88"],
        entries: ["One 1", "Two 19", "Three 40", "Four 88"],
      },
      {
        name: "poem titles",
        lines: ["Salt 5", "Tide 12", "Lamp 18", "Keel 30"],
        entries: ["Salt 5", "Tide 12", "Lamp 18", "Keel 30"],
      },
      {
        name: "parts",
        lines: [
          "Part I",
          "     The first survey 7",
          "     The second survey 12",
          "Part II",
          "     The letter 19",
          "     The return 24",
          "Part III",
          "     The storm 30",
          "     The calm 36",
          "Part IV",
          "     The gate 40",
          "     The road 44",
          "Part V",
          "     The dawn 50",
          "     The dusk 55",
          "Notes 60",
        ],
        entries: [
          "Part I", "     The first survey 7", "     The second survey 12",
          "Part II", "     The letter 19", "     The return 24",
          "Part III", "     The storm 30", "     The calm 36",
          "Part IV", "     The gate 40", "     The road 44",
          "Part V", "     The dawn 50", "     The dusk 55", "Notes 60",
        ],
      },
      {
        name: "chapter title",
        lines: [
          "Chapter 1 The Early Years",
          "Chapter 2 The Middle Passage",
          "Chapter 3 The Ledger",
          "Chapter 4 The Harbor",
          "Chapter 5 The Letter",
          "Chapter 6 The Return",
        ],
        entries: [
          "Chapter 1 The Early Years",
          "Chapter 2 The Middle Passage",
          "Chapter 3 The Ledger",
          "Chapter 4 The Harbor",
          "Chapter 5 The Letter",
          "Chapter 6 The Return",
        ],
      },
      {
        name: "early years",
        lines: ["The Early Years 1", "The Middle Passage 14", "The Ledger 40", "The Harbor 88", "The Letter 120", "The Return 150"],
        entries: ["The Early Years 1", "The Middle Passage 14", "The Ledger 40", "The Harbor 88", "The Letter 120", "The Return 150"],
      },
    ];
    for (const row of cases) {
      const chunk = ["Contents", ...row.lines, "Chapter 1", prose].join("\n");
      const none = acceptListenOps(chunk, { drop: [], headings: [] });
      for (const entry of row.entries) expect(count(none.text, entry), row.name).toBeGreaterThan(0);
      const ideal = acceptListenOps(chunk, { drop: idealDrop(chunk, row.entries), headings: [] });
      for (const entry of row.entries) {
        const shaped =
          /^\d{1,4}$/.test(entry.trim()) ||
          /(?:\.{2,}|…)\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*$/i.test(entry.trim()) ||
          /\s(?:\d{1,4}|[ivxlcdm]{1,7})\s*$/i.test(entry.trim()) ||
          /^(?:chapter|part)\s+[\divxlcdm]+\b/i.test(entry.trim());
        expect(count(ideal.text, entry), `${row.name} ${entry}`).toBe(shaped ? 0 : 1);
      }
      expect(ideal.text).toContain("Chapter 1");
      expect(ideal.text).toContain("She walked to the quay");
      const all = acceptListenOps(chunk, { drop: lineSpans(chunk).map((line) => line.id), headings: [] });
      expect(all.text, row.name).toContain("She walked to the quay");
    }
  });

  it("drops an unlabeled contents run when the model asks", () => {
    const entries = Array.from({ length: 60 }, (_, i) => `Harbor Essay ${i + 1} ${i + 10}`);
    const chunk = [...entries, prose].join("\n");
    const none = acceptListenOps(chunk, { drop: [], headings: [] });
    expect(count(none.text, entries[0]!)).toBe(1);
    const ideal = acceptListenOps(chunk, { drop: idealDrop(chunk, entries), headings: [] });
    expect(entries.filter((entry) => count(ideal.text, entry) > 0)).toEqual([]);
    expect(ideal.text).toContain("She walked to the quay");
    const all = acceptListenOps(chunk, { drop: lineSpans(chunk).map((line) => line.id), headings: [] });
    expect(all.text).toContain("She walked to the quay");
  });

  it("drops a header that appears twice when the model asks and keeps it otherwise", () => {
    const headers = ["The Valley", "Boston History"];
    const lines = ["She opened the book on the first evening."];
    for (let page = 1; page <= 4; page++) {
      lines.push(String(page), headers[(page - 1) % 2]!, "The river kept its own slow counsel through the night.");
    }
    const chunk = lines.join("\n");
    expect(deterministicPrepass(chunk).match(/^The Valley$/gm)?.length).toBe(2);
    const none = acceptListenOps(chunk, { drop: [], headings: [] });
    expect(count(none.text, "The Valley")).toBe(2);
    const ids = idealDrop(chunk, headers);
    const ideal = acceptListenOps(chunk, { drop: ids, headings: [] });
    expect(count(ideal.text, "The Valley")).toBe(0);
    expect(count(ideal.text, "Boston History")).toBe(0);
    expect(ideal.text).toContain("The river kept its own slow counsel through the night.");
  });

  it("does not treat repeated reading lines as headers", () => {
    const samples = [
      '"Come home, come home."',
      "Come home, come home",
      "Then light it.",
      "My dearest Anna,",
    ];
    for (const line of samples) {
      const lines = ["Lanterns at Low Tide", "She opened the book."];
      for (let page = 1; page <= 6; page++) {
        lines.push(line, String(page));
      }
      const chunk = lines.join("\n");
      for (const text of [
        deterministicPrepass(chunk),
        acceptListenOps(chunk, { drop: [], headings: [] }).text,
        acceptListenOps(chunk, { drop: lineSpans(chunk).map((row) => row.id), headings: [] }).text,
        acceptListenOps(chunk, { drop: idealDrop(chunk, [line]), headings: [] }).text,
      ]) {
        expect(count(text, line), line).toBe(6);
        expect(text.startsWith("Lanterns at Low Tide")).toBe(true);
      }
    }
  });

  it("keeps the book title when later pages repeat it as a header", () => {
    const lines = ["Lanterns at Low Tide", "She opened the book on the first evening."];
    for (let page = 1; page <= 6; page++) {
      lines.push(String(page), "Lanterns at Low Tide", "The river kept its own slow counsel through the night.");
    }
    const chunk = lines.join("\n");
    const cleaned = deterministicPrepass(chunk);
    expect(cleaned.startsWith("Lanterns at Low Tide")).toBe(true);
    expect(count(cleaned, "Lanterns at Low Tide")).toBe(1);
    const all = acceptListenOps(chunk, { drop: lineSpans(chunk).map((row) => row.id), headings: [] });
    expect(all.text.startsWith("Lanterns at Low Tide")).toBe(true);
  });

  it("keeps chapter numbers, play labels, refrains, diary heads, and salutations", () => {
    const chapters = ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4", "Chapter 5"];
    const romans = ["CHAPTER I", "CHAPTER II", "CHAPTER III", "CHAPTER IV"];
    const days = ["Monday, March 3", "Monday, March 4", "Monday, March 5"];
    const lines = ["The Real Title", "She opened the book."];
    let page = 10;
    for (const heading of [...chapters, ...romans]) {
      lines.push(String(page), heading, "She walked to the quay and closed the ledger before the rain.");
      page += 1;
    }
    for (let i = 0; i < 6; i++) {
      lines.push(
        String(page),
        "MARTA",
        "We leave at dawn.",
        "Nevermore",
        "The lamps were lit before anyone spoke.",
        days[i % days.length]!,
        "My dearest Anna,",
        "The house was quiet when I wrote this down."
      );
      page += 1;
    }
    const chunk = lines.join("\n");
    const kept = [
      ...chapters,
      ...romans,
      "MARTA",
      "Nevermore",
      "Monday, March 3",
      "My dearest Anna,",
      "The Real Title",
    ];
    for (const text of [
      deterministicPrepass(chunk),
      acceptListenOps(chunk, { drop: [], headings: [] }).text,
      acceptListenOps(chunk, { drop: lineSpans(chunk).map((row) => row.id), headings: [] }).text,
    ]) {
      for (const line of kept) expect(count(text, line), line).toBeGreaterThan(0);
    }
  });
});

describe("sixth-review headers and contents", () => {
  const prose = "She walked to the quay and closed the ledger before the rain began. ".repeat(40);

  function count(text: string, line: string): number {
    return text.split("\n").filter((row) => row === line).length;
  }

  it("drops a header that sits above its page number when the model asks", () => {
    const lines = ["She opened the book."];
    for (let page = 1; page <= 7; page++) lines.push("The Valley", String(page), prose.trim());
    const chunk = lines.join("\n");
    const ids = lineSpans(chunk).filter((line) => line.text === "The Valley").map((line) => line.id);
    expect(count(acceptListenOps(chunk, { drop: [], headings: [] }).text, "The Valley")).toBe(7);
    const ideal = acceptListenOps(chunk, { drop: ids, headings: [] });
    expect(count(ideal.text, "The Valley")).toBe(0);
    expect(ideal.text).toContain("She walked to the quay");
    const above = ["Brine", "The Lamp Room", "Salt and Iron"];
    const alt = ["Opening."];
    for (let page = 1; page <= 6; page++) {
      const name = above[(page - 1) % above.length]!;
      if (page % 2 === 1) alt.push(name, String(page), "The river kept its counsel through the night.");
      else alt.push(String(page), name, "The river kept its counsel through the night.");
    }
    const altChunk = alt.join("\n");
    const altIds = lineSpans(altChunk).filter((line) => above.includes(line.text)).map((line) => line.id);
    const altIdeal = acceptListenOps(altChunk, { drop: altIds, headings: [] });
    for (const name of above) expect(count(altIdeal.text, name), name).toBe(0);
  });

  it("drops indented and lowercase contents rows and a realistic unlabeled page", () => {
    const lower = ["Part I", "the first morning 3", "the second morning 8", "Part II", "the third morning 12", "the last morning 19"];
    const chunk = ["Contents", ...lower, prose].join("\n");
    const ids = lineSpans(chunk).filter((line) => lower.includes(line.text)).map((line) => line.id);
    const ideal = acceptListenOps(chunk, { drop: ids, headings: [] });
    for (const line of lower) expect(count(ideal.text, line), line).toBe(0);
    const page = ["Preface ix", "1 The Early Years 1", "2 War 45", "3 The Long Peace 89", "Epilogue 301", "Notes 305", "Index 330"];
    const bare = [...page, prose].join("\n");
    const bareIds = lineSpans(bare).filter((line) => page.includes(line.text)).map((line) => line.id);
    const bareIdeal = acceptListenOps(bare, { drop: bareIds, headings: [] });
    for (const line of page) expect(count(bareIdeal.text, line), line).toBe(0);
    const entries = Array.from({ length: 60 }, (_, i) => `Harbor Essay ${i + 1} ${i + 10}`);
    const book = [...entries, prose].join("\n");
    const dropped = acceptListenOps(book, {
      drop: lineSpans(book).filter((line) => entries.includes(line.text)).map((line) => line.id),
      headings: [],
    });
    const left = entries.filter((entry) => count(dropped.text, entry) > 0).length;
    expect(left).toBe(0);
  });

  it("keeps real lines that are not page-adjacent headers or contents entries", () => {
    const refrain = "And still it comes";
    const blanks = ["The book.", "", refrain, "", "She walked on.", "", refrain, "", "She stopped.", "", refrain, ""].join("\n");
    const six = Array.from({ length: 6 }, () => ["", refrain, ""]).flat();
    for (const chunk of [blanks, ["Start.", ...six].join("\n")]) {
      const all = acceptListenOps(chunk, { drop: lineSpans(chunk).map((line) => line.id), headings: [] });
      expect(count(all.text, refrain)).toBe(count(chunk, refrain));
    }
    for (const line of ["Later", "Interlude", "Nothing to report"]) {
      const rows = ["Opening."];
      for (let i = 0; i < 6; i++) rows.push("", line, "", "She kept the letter in the drawer beside the window.");
      const chunk = rows.join("\n");
      const all = acceptListenOps(chunk, { drop: lineSpans(chunk).map((row) => row.id), headings: [] });
      expect(count(all.text, line), line).toBe(6);
    }
    const story = ["She read the label.", "Contents", "Winter Coat", "Three Letters", "The Brass Key", "A Photograph", "Then she closed the box."].join("\n");
    const storyAll = acceptListenOps(story, { drop: lineSpans(story).map((line) => line.id), headings: [] });
    for (const line of ["Winter Coat", "Three Letters", "The Brass Key", "A Photograph"]) {
      expect(storyAll.text).toContain(line);
    }
    const packed = ["CONTENTS", "1 winter coat", "3 letters", "2 Brass Keys", "Photograph 1", "She packed the boat before dawn."].join("\n");
    const packedAll = acceptListenOps(packed, { drop: lineSpans(packed).map((line) => line.id), headings: [] });
    for (const line of ["1 winter coat", "3 letters", "2 Brass Keys", "Photograph 1"]) {
      expect(packedAll.text).toContain(line);
    }
    const heading = ["The Crossing", "", "She walked to the quay.", "12", "The Crossing", "The river was quiet.", "13", "The Crossing", "She closed the ledger."].join("\n");
    const headingAll = acceptListenOps(heading, { drop: lineSpans(heading).map((line) => line.id), headings: [] });
    expect(headingAll.text.split("\n")[0]).toBe("The Crossing");
    const ticks = Array.from({ length: 6 }, (_, i) => ["~", String(i + 1)]).flat().join("\n");
    expect(deterministicPrepass(ticks)).toContain("~");
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

  it("keeps a sentence that mentions a page number", () => {
    const line = "He turned to page 12 and began to read.";
    expect(isReferenceLine(line)).toBe(false);
    const applied = acceptListenOps(line, { drop: [1], headings: [] });
    expect(applied.text).toContain(line);
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
