import { describe, expect, it } from "vitest";
import { bodyTextByPage, markFurniture, pageFromItems, type PdfTextItem } from "./pdf-furniture";

function item(k: number, s: string, x: number, y: number, eol = true): PdfTextItem {
  return { k, s, eol, x, y, h: 12 };
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
});
