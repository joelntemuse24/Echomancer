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
    const poems = Array.from({ length: 3 }, () => {
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
});
