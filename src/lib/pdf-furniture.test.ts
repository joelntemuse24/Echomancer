import { describe, expect, it } from "vitest";
import { bodyTextByPage, compactPage, markFurniture, pageFromItems, type PdfTextItem } from "./pdf-furniture";

function item(k: number, s: string, x: number, y: number, eol = true, h = 12): PdfTextItem {
  return { k, s, eol, x, y, h };
}

function page(lines: Array<[string, number]>, height = 800) {
  const items = lines.map(([text, y], k) => item(k, text, 72, y));
  return pageFromItems(items, height);
}

describe("markFurniture", () => {
  it("drops a running head and page numbers that agree with the page, and keeps prose", () => {
    const pages = Array.from({ length: 5 }, (_, pi) =>
      page([
        ["The Harbor", 760],
        ["She walked to the quay and closed the ledger.", 400],
        [String(pi + 1), 40],
      ])
    );
    const blocks = markFurniture(pages);
    const body = bodyTextByPage(blocks).join("\n");
    expect(body).toContain("She walked to the quay");
    expect(body).not.toContain("The Harbor");
    expect(body).not.toMatch(/\b[1-5]\b/);
    const furniture = blocks.filter((block) => block.role === "furniture");
    expect(furniture.some((block) => block.label === "running_head")).toBe(true);
    expect(furniture.some((block) => block.label === "page_number")).toBe(true);
  });

  it("keeps a chapter heading that appears once, even in the top band", () => {
    const pages = [
      page([
        ["Chapter 1", 760],
        ["The lamps were lit along the quay.", 400],
      ]),
      ...Array.from({ length: 4 }, (_, pi) =>
        page([
          ["The Harbor", 760],
          ["She kept the letter.", 400],
          [String(pi + 2), 40],
        ])
      ),
    ];
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    expect(body).toContain("Chapter 1");
    expect(body).toContain("The lamps were lit");
    expect(body).not.toContain("The Harbor");
  });

  it("drops a chapter line only when it repeats at that position", () => {
    const pages = Array.from({ length: 4 }, () =>
      page([
        ["Chapter 1", 760],
        ["She walked on.", 400],
      ])
    );
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    expect(body).not.toContain("Chapter 1");
    expect(body).toContain("She walked on.");
  });

  it("keeps a one-off margin line that does not match the running head", () => {
    const pages = Array.from({ length: 4 }, (_, pi) =>
      page(
        pi === 0
          ? [
              ["Foreword", 760],
              ["The lamps were lit.", 400],
            ]
          : [
              ["The Harbor", 760],
              ["She walked on.", 400],
              [String(pi + 1), 40],
            ]
      )
    );
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    expect(body).toContain("Foreword");
    expect(body).not.toContain("The Harbor");
  });

  it("keeps a large heading and a bare Chapter even when the letters repeat", () => {
    const bodyLines = (start: number) =>
      Array.from({ length: 8 }, (_, i) => [`The lamps were lit along the quay that evening. ${i}`, start - i * 14] as [string, number]);
    const lecture = Array.from({ length: 4 }, (_, n) => {
      const items = [
        item(0, `LECTURE ${["I", "II", "III", "IV"][n]}`, 72, 760, true, 16.5),
        ...bodyLines(700).map(([text, y], i) => item(i + 1, text, 72, y, true, 11)),
      ];
      return pageFromItems(items, 800);
    });
    const letters = Array.from({ length: 4 }, (_, n) => {
      const items = [
        item(0, "The Modern Prometheus", 72, 770, true, 11),
        item(1, `Letter ${n + 1}`, 72, 740, true, 18),
        ...bodyLines(700).map(([text, y], i) => item(i + 2, text, 72, y, true, 11)),
      ];
      return pageFromItems(items, 800);
    });
    const chapters = Array.from({ length: 4 }, (_, n) => {
      const items = [
        item(0, "Chapter", 72, 760, true, 16),
        item(1, String(n + 1), 72, 740, true, 16),
        ...bodyLines(700).map(([text, y], i) => item(i + 2, text, 72, y, true, 11)),
      ];
      return pageFromItems(items, 800);
    });
    const poems = Array.from({ length: 2 }, () => {
      const title = "TO HELEN.";
      const items = [
        item(0, title, 72, 760, true, 17),
        ...bodyLines(700).map(([text, y], i) => item(i + 1, text, 72, y, true, 11)),
      ];
      return pageFromItems(items, 800);
    });
    const body = bodyTextByPage(markFurniture([...lecture, ...letters, ...chapters, ...poems])).join("\n");
    expect(body).toMatch(/LECTURE I/);
    expect(body).toMatch(/LECTURE IV/);
    expect(body).toMatch(/Letter 1/);
    expect(body).toMatch(/Letter 4/);
    expect(body).toMatch(/Chapter/);
    expect(body).toMatch(/TO HELEN/);
    expect(body).toMatch(/lamps were lit/);
  });

  it("keeps a body-size edge line that sits at normal line spacing", () => {
    const pages = Array.from({ length: 5 }, () => {
      const lines: Array<[string, number, number]> = [
        ["HAMLET.", 760, 11],
        ["To be, or not to be, that is the question.", 746, 11],
        ["Whether tis nobler in the mind to suffer.", 732, 11],
        ["The slings and arrows of outrageous fortune.", 718, 11],
        ["Or to take arms against a sea of troubles.", 704, 11],
        ["And by opposing end them. To die, to sleep.", 94, 11],
        ["Agathos.", 80, 11],
        ["And the wind blew over the moor.", 66, 11],
      ];
      return pageFromItems(
        lines.map(([text, y, h], k) => item(k, text, 72, y, true, h)),
        800
      );
    });
    const table = Array.from({ length: 3 }, () =>
      pageFromItems(
        [
          item(0, "Optimizer AdamW", 72, 760, true, 11),
          item(1, "lr 1e-4", 72, 746, true, 11),
          item(2, "weight decay 0.01", 72, 732, true, 11),
          item(3, "The training loss fell through the night.", 72, 718, true, 11),
          item(4, "Validation stayed flat on the held-out set.", 72, 704, true, 11),
        ],
        800
      )
    );
    const body = bodyTextByPage(markFurniture([...pages, ...table])).join("\n");
    expect(body).toMatch(/HAMLET/);
    expect(body).toMatch(/Agathos/);
    expect(body).toMatch(/wind blew over the moor/);
    expect(body).toMatch(/Optimizer AdamW/);
  });

  it("still drops a body-size running head that sits clear of the text", () => {
    const pages = Array.from({ length: 4 }, (_, pi) => {
      const lines: Array<[string, number]> = [
        ["The Harbor", 760],
        ["She walked to the quay and closed the ledger.", 700],
        ["The lamps were lit along the water.", 686],
        ["Night settled over the crates.", 672],
        [String(pi + 1), 40],
      ];
      return pageFromItems(
        lines.map(([text, y], k) => item(k, text, 72, y, true, 11)),
        800
      );
    });
    const body = bodyTextByPage(markFurniture(pages.map(compactPage))).join("\n");
    expect(body).toContain("She walked to the quay");
    expect(body).not.toContain("The Harbor");
    expect(body).not.toMatch(/\n1\n/);
  });

  it("drops a roman folio only when the offset repeats, and keeps a year", () => {
    const pages = [
      pageFromItems(
        [
          item(0, "MCMXIII", 72, 700, true, 18),
          item(1, "The wind crossed the harbor.", 72, 400, true, 11),
        ],
        800
      ),
      ...Array.from({ length: 4 }, (_, pi) =>
        pageFromItems(
          [
            item(0, ["i", "ii", "iii", "iv"][pi]!, 72, 760, true, 11),
            item(1, "A preface line about the lamps.", 72, 700, true, 11),
            item(2, "Another preface line follows it.", 72, 686, true, 11),
          ],
          800
        )
      ),
      pageFromItems(
        [
          item(0, "II.", 72, 760, true, 11),
          item(1, "The second section opens here.", 72, 700, true, 11),
          item(2, "It continues for another line.", 72, 686, true, 11),
        ],
        800
      ),
    ];
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    expect(body).toMatch(/MCMXIII/);
    expect(body).toMatch(/II\./);
    expect(body).not.toMatch(/\bii\b/);
    expect(body).not.toMatch(/\biii\b/);
  });

  it("drops an OCR-tall running head and a tight-gap head outside the body block", () => {
    const bodyAt = (start: number) =>
      Array.from({ length: 8 }, (_, i) => [`The lamps along the quay stayed lit that night. ${i}`, start - i * 14] as [string, number]);
    const ocr = Array.from({ length: 6 }, (_, pi) =>
      pageFromItems(
        [
          item(0, "THE WIND IN THE WILLOWS", 72, 742, true, 17.7),
          ...bodyAt(720.6).map(([text, y], i) => item(i + 1, text, 72, y, true, 10.7)),
          item(20, String(pi + 1), 72, 40, true, 10.7),
        ],
        800
      )
    );
    const tight = Array.from({ length: 6 }, () =>
      pageFromItems(
        [
          item(0, "THE SOULS OF BLACK FOLK", 72, 739, true, 15),
          ...bodyAt(720).map(([text, y], i) => item(i + 1, text, 72, y, true, 11)),
        ],
        800
      )
    );
    const smallBody = Array.from({ length: 4 }, (_, pi) =>
      pageFromItems(
        [
          item(0, "A short line of the essay.", 72, 700, true, 9),
          item(1, "Another short line follows it.", 72, 686, true, 9),
          item(2, "The third line stays in the block.", 72, 672, true, 9),
          item(3, String(300 + pi), 72, 40, true, 14),
        ],
        800
      )
    );
    const ocrBody = bodyTextByPage(markFurniture(ocr)).join("\n");
    const tightBody = bodyTextByPage(markFurniture(tight)).join("\n");
    const folioBody = bodyTextByPage(markFurniture(smallBody)).join("\n");
    expect(ocrBody).not.toMatch(/WIND IN THE WILLOWS/);
    expect(ocrBody).toMatch(/lamps along the quay/);
    expect(tightBody).not.toMatch(/SOULS OF BLACK FOLK/);
    expect(folioBody).not.toMatch(/\b300\b/);
    expect(folioBody).toMatch(/short line of the essay/);
  });

  it("drops a verse running head when stanza breaks would inflate the median gap", () => {
    const pages = Array.from({ length: 6 }, () => {
      const lines: Array<[string, number, number]> = [
        ["POEMS OF EDGAR ALLAN POE", 760, 11],
        ["Once upon a midnight dreary, while I pondered,", 700, 11],
        ["weak and weary, over many a quaint and curious", 686, 11],
        ["volume of forgotten lore.", 672, 11],
        ["While I nodded, nearly napping, suddenly there", 630, 11],
        ["came a tapping, as of some one gently rapping,", 616, 11],
        ["rapping at my chamber door.", 602, 11],
      ];
      return pageFromItems(lines.map(([text, y, h], k) => item(k, text, 72, y, true, h)), 800);
    });
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    expect(body).not.toMatch(/POEMS OF EDGAR ALLAN POE/);
    expect(body).toMatch(/midnight dreary/);
    expect(body).toMatch(/chamber door/);
  });

  it("keeps a bottom speaker and Agathos inside the body block", () => {
    const full = (last: string, lastY: number, prevY: number) =>
      pageFromItems(
        [
          item(0, "To be, or not to be, that is the question.", 72, 740, true, 11),
          item(1, "Whether tis nobler in the mind to suffer.", 72, 726, true, 11),
          item(2, "The slings and arrows of outrageous fortune.", 72, 712, true, 11),
          item(3, "Or to take arms against a sea of troubles.", 72, 698, true, 11),
          item(4, "And by opposing end them. To die, to sleep.", 72, prevY, true, 11),
          item(5, last, 72, lastY, true, 11),
        ],
        800
      );
    const pages = [
      ...Array.from({ length: 6 }, () => full("The rest is silence in the hall.", 80, 94)),
      ...Array.from({ length: 4 }, () => full("HAMLET.", 80, 108)),
      ...Array.from({ length: 3 }, () => full("Agathos.", 94, 108)),
    ];
    const notes = Array.from({ length: 5 }, () =>
      pageFromItems(
        [
          item(0, "The argument continues on the next leaf.", 72, 200, true, 11),
          item(1, "A second sentence fills the page.", 72, 186, true, 11),
          item(2, "A third sentence stays with the body.", 72, 172, true, 11),
          item(3, "See the earlier note on the folio.", 72, 40, true, 11),
        ],
        800
      )
    );
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    const noted = bodyTextByPage(markFurniture(notes)).join("\n");
    expect(body).toMatch(/HAMLET/);
    expect(body).toMatch(/Agathos/);
    expect(noted).not.toMatch(/earlier note/);
    expect(noted).toMatch(/argument continues/);
  });

  it("ignores blank pages when body tops jitter, and still drops the running head", () => {
    const content = Array.from({ length: 21 }, (_, pi) => {
      const top = 740 + (pi % 7);
      const lines: Array<[string, number]> = [["THE WIND IN THE WILLOWS", 772]];
      for (let i = 0; i < 6; i++) lines.push(["The river kept its course through the evening.", top - i * 14]);
      return pageFromItems(lines.map(([text, y], k) => item(k, text, 72, y, true, 11)), 800);
    });
    const blanks = Array.from({ length: 4 }, () => pageFromItems([], 800));
    const body = bodyTextByPage(markFurniture([...content, ...blanks])).join("\n");
    expect(body).not.toMatch(/WIND IN THE WILLOWS/);
    expect(body).toMatch(/river kept its course/);
  });

  it("drops a scan page number one line below the body when the offset agrees", () => {
    const pages = Array.from({ length: 6 }, (_, pi) => {
      const lines: Array<[string, number]> = [
        ["The river kept its course through the evening.", 200],
        ["A second line follows at the usual spacing.", 186],
        ["A third line keeps the block from collapsing.", 172],
        ["A fourth line fills out the page.", 158],
        [String(40 + pi), 144],
      ];
      return pageFromItems(lines.map(([text, y], k) => item(k, text, 72, y, true, 11)), 800);
    });
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    expect(body).toMatch(/river kept its course/);
    expect(body).not.toMatch(/\b40\b/);
    expect(body).not.toMatch(/\b45\b/);
  });

  it("drops verso and recto heads, and keeps a heading on widely spaced pages", () => {
    const alternating = Array.from({ length: 12 }, (_, pi) => {
      const head = pi % 2 === 0 ? "THE MODERN PROMETHEUS" : "VOLUME ONE";
      const lines: Array<[string, number]> = [
        [head, 760],
        ["The river kept its course through the evening.", 700],
        ["A second line follows at the usual spacing.", 686],
        ["A third line keeps the block from collapsing.", 672],
      ];
      return pageFromItems(lines.map(([text, y], k) => item(k, text, 72, y, true, 11)), 800);
    });
    const spaced = Array.from({ length: 12 }, (_, pi) => {
      const head = pi % 4 === 0 ? "The Piazza Tale" : `She walked the quay on page ${pi}.`;
      const lines: Array<[string, number]> = [
        [head, 760],
        ["The river kept its course through the evening.", 700],
        ["A second line follows at the usual spacing.", 686],
        ["A third line keeps the block from collapsing.", 672],
      ];
      return pageFromItems(lines.map(([text, y], k) => item(k, text, 72, y, true, 11)), 800);
    });
    const heads = bodyTextByPage(markFurniture(alternating)).join("\n");
    const titles = bodyTextByPage(markFurniture(spaced)).join("\n");
    expect(heads).not.toMatch(/MODERN PROMETHEUS/);
    expect(heads).not.toMatch(/VOLUME ONE/);
    expect(heads).toMatch(/river kept its course/);
    expect(titles).toMatch(/Piazza Tale/);
  });

  it("drops an OCR-garbled running head that belongs to a frequent group", () => {
    const pages = Array.from({ length: 8 }, (_, pi) => {
      const head = pi < 7 ? "THE WIND IN THE WILLOWS" : "TI1K WIND IN THE WILLOWS";
      const lines: Array<[string, number]> = [
        [head, 760],
        ["The river kept its course through the evening.", 700],
        ["A second line follows at the usual spacing.", 686],
        ["A third line keeps the block from collapsing.", 672],
      ];
      return pageFromItems(lines.map(([text, y], k) => item(k, text, 72, y, true, 11)), 800);
    });
    const body = bodyTextByPage(markFurniture(pages)).join("\n");
    expect(body).not.toMatch(/WIND IN THE WILLOWS/);
    expect(body).not.toMatch(/TI1K/);
    expect(body).toMatch(/river kept its course/);
  });

  it("keeps the extra last line of a long page when that line repeats", () => {
    const closing = "The lamps were still burning on the quay.";
    const stack = (lastY: number, last: string) => {
      const lines: Array<[string, number]> = [];
      for (let y = 220; y >= lastY + 14; y -= 14) lines.push(["The river kept its course through the evening.", y]);
      lines.push([last, lastY]);
      return pageFromItems(lines.map(([text, y], k) => item(k, text, 72, y, true, 11)), 800);
    };
    const normal = Array.from({ length: 8 }, (_, pi) => stack(80, `A fourth line fills out page ${pi}.`));
    const longer = Array.from({ length: 6 }, () => stack(66, closing));
    const body = bodyTextByPage(markFurniture([...normal, ...longer])).join("\n");
    expect(body.match(/lamps were still burning/g)?.length).toBe(6);
    expect(body).toMatch(/river kept its course/);
  });
});
