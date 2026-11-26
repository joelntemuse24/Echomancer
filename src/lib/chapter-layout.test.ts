/**
 * Layout chapter detection, and the regression against the heading-line path.
 *
 * The fixtures stand in for the books that have no outline: lecture notes whose
 * only signal is a larger font, a Q&A transcript, a textbook with numbered
 * subsections, and a novel whose headings are the same size as the body and
 * are listed on a contents page. Ground truth is the heading list, the way an
 * EPUB nav would be after the outline is stripped.
 */

import { describe, expect, it } from "vitest";
import { chaptersFromHeadingLines, resolveChapters, type BookChapter } from "@/lib/book-chapters";
import {
  detectLayoutChapters,
  foldHeading,
  layoutFromPages,
  scoreHeadings,
  trustedOutline,
  type HeadingKey,
  type LayoutFeatures,
  type LayoutLine,
} from "@/lib/chapter-layout";
import { stampLineGeometry, type PdfPage } from "@/lib/pdf-furniture";
import {
  chapterLlmGate,
  estimateChapterLlmCost,
  parseChapterLlmDecisions,
} from "@/lib/chapter-llm";

const CLASS_TITLES = [
  "Class 1: Zero to One",
  "Class 2: Party Like It's 1999",
  "Class 3: Value Systems",
  "Class 4: Last Mover Advantage",
  "Class 5: The Mechanics of Monopoly",
  "Class 6: Thiel's Law",
  "Class 7: Follow the Money",
  "Class 8: Pitching",
  "Class 9: If You Build It",
  "Class 10: How to Sell",
  "Class 11: Secrets",
  "Class 12: War and Peace",
  "Class 13: You Are Not a Lottery Ticket",
  "Class 14: Seeing Green",
  "Class 15: Back to the Future",
  "Class 16: Founder as Victim",
  "Class 17: Deep Thought",
  "Class 18: Founder as King",
  "Class 19: Stagnation or Singularity",
];

function line(partial: LayoutLine): LayoutLine {
  return { y: 0.2, ...partial };
}

function lectureFixture(): {
  spoken: string;
  pageStarts: number[];
  layout: LayoutFeatures;
  truth: HeadingKey[];
} {
  const pages: string[] = [];
  const contents = CLASS_TITLES.map((title, index) => `${title} ........ ${index + 1}`).join("\n");
  pages.push(`${contents}\n`);
  for (const title of CLASS_TITLES) {
    pages.push(
      `${title}\n\nThe class met in the evening and talked through the argument of the day. Methods were mentioned only as an aside inside the paragraph, not as a heading of their own.\n\n`
    );
  }
  pages.push(
    `Methods\n\n${"Someone later filed the notes under a methods heading that is not a class. ".repeat(12)}\n\n`
  );
  const pageStarts: number[] = [];
  let spoken = "";
  for (const page of pages) {
    pageStarts.push(spoken.length);
    spoken += page;
  }
  const lines: LayoutLine[] = [];
  CLASS_TITLES.forEach((title, index) => {
    lines.push(
      line({
        text: `${title} ........ ${index + 1}`,
        page: 0,
        size: 11,
        y: 0.15 + index * 0.03,
      })
    );
  });
  for (let page = 1; page <= CLASS_TITLES.length; page++) {
    lines.push(line({ text: "CS183 Notes", page, size: 9, y: 0.04, first: true }));
    lines.push(line({ text: String(page), page, size: 9, y: 0.96 }));
    lines.push(
      line({
        text: CLASS_TITLES[page - 1]!,
        page,
        size: 14,
        y: 0.14,
        first: true,
        context: "The class met in the evening",
      })
    );
    lines.push(line({ text: "Figure 2 The blackboard", page, size: 11, y: 0.8 }));
  }
  lines.push(line({ text: "Methods", page: CLASS_TITLES.length + 1, size: 11, y: 0.3 }));
  lines.push(line({ text: "and then the discussion continued,", page: 2, size: 11, y: 0.5 }));
  lines.push(line({ text: "Bibliography", page: CLASS_TITLES.length + 1, size: 14, y: 0.1, first: true }));
  lines.push(line({ text: "a footnote about the slide", page: 3, size: 8, y: 0.9 }));
  return {
    spoken,
    pageStarts,
    layout: { bodySize: 11, pageCount: pages.length, lines },
    truth: CLASS_TITLES.map((title, index) => ({ title, page: index + 1, level: 1 })),
  };
}

function qaFixture(): { spoken: string; layout: LayoutFeatures } {
  const questions = Array.from({ length: 40 }, (_, index) => {
    return `What did the speaker mean by point ${index + 1}?\n\nThey answered at length and the answer ran on until the thought was finished for the recording.\n\n`;
  });
  const spoken = `${questions.join("")}Methods\n\nThe transcript was filed under methods by mistake.\n\n${"The rest of the hour was questions and answers with no chapter titles at all. ".repeat(80)}`;
  const lines: LayoutLine[] = questions.map((_, index) =>
    line({
      text: `What did the speaker mean by point ${index + 1}?`,
      page: index,
      size: 11,
      y: 0.2,
      first: true,
    })
  );
  lines.push(line({ text: "Methods", page: 40, size: 11, y: 0.3 }));
  return { spoken, layout: { bodySize: 11, pageCount: 42, lines } };
}

function textbookFixture(): {
  spoken: string;
  pageStarts: number[];
  layout: LayoutFeatures;
  truth: HeadingKey[];
} {
  const rows = [
    { title: "1 The Coast", level: 1, size: 14 },
    { title: "1.1 Harbors", level: 2, size: 12 },
    { title: "1.2 Tides", level: 2, size: 12 },
    { title: "2 The Inland", level: 1, size: 14 },
    { title: "2.1 Rivers", level: 2, size: 12 },
    { title: "3 Gamma", level: 1, size: 11 },
    { title: "4 The Road", level: 1, size: 14 },
  ];
  // 3 Gamma is the gap: body size, not at the top of the page. 1, 2, and 4
  // are found first; the missing 3 has to be recovered.
  const pageStarts: number[] = [];
  let spoken = "";
  const lines: LayoutLine[] = [];
  rows.forEach((row, index) => {
    pageStarts.push(spoken.length);
    spoken += `${row.title}\n\n${"The section explains the point in ordinary sentences. ".repeat(12)}\n\n`;
    lines.push(
      line({
        text: row.title,
        page: index,
        size: row.size,
        y: row.title === "3 Gamma" ? 0.45 : 0.12,
        first: row.title !== "3 Gamma",
      })
    );
  });
  return {
    spoken,
    pageStarts,
    layout: { bodySize: 11, pageCount: rows.length, lines },
    truth: rows.map((row, index) => ({ title: row.title, page: index, level: row.level })),
  };
}

function sameSizeContentsFixture(): {
  spoken: string;
  pageStarts: number[];
  layout: LayoutFeatures;
  truth: HeadingKey[];
} {
  const titles = ["The Harbor", "The Inland Sea", "The City Gate", "The Open Road"];
  const contents = titles.map((title, index) => `${title} ........ ${index + 1}`).join("\n");
  const pageStarts: number[] = [0];
  let spoken = `${contents}\n\n`;
  const lines: LayoutLine[] = titles.map((title, index) =>
    line({ text: `${title} ........ ${index + 1}`, page: 0, size: 11, y: 0.2 + index * 0.05 })
  );
  titles.forEach((title, index) => {
    pageStarts.push(spoken.length);
    spoken += `${title}\n\n${"The chapter is set in the same type as the paragraphs around it. ".repeat(10)}\n\n`;
    lines.push(line({ text: title, page: index + 1, size: 11, y: 0.12, first: true }));
  });
  return {
    spoken,
    pageStarts,
    layout: { bodySize: 11, pageCount: titles.length + 1, lines },
    truth: titles.map((title, index) => ({ title, page: index + 1, level: 1 })),
  };
}

function novelSpoken(): string {
  return Array.from({ length: 8 }, (_, index) => {
    return `Chapter ${index + 1}\n\n${"The harbor was quiet and the boats stayed in. ".repeat(20)}\n\n`;
  }).join("");
}

function flatten(nodes: BookChapter[], pageStarts?: number[]): HeadingKey[] {
  const out: HeadingKey[] = [];
  const walk = (list: BookChapter[]) => {
    for (const node of list) {
      let page: number | undefined;
      if (pageStarts) {
        page = 0;
        for (let i = 0; i < pageStarts.length; i++) {
          if (pageStarts[i]! <= node.charStart) page = i;
        }
      }
      out.push({ title: node.title, level: node.level, ...(page != null ? { page } : {}) });
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function titlesOf(spoken: string, layout?: LayoutFeatures, pageStarts?: number[]): HeadingKey[] {
  const doc = resolveChapters(spoken, {
    source: "heading-lines",
    titles: [],
    ...(pageStarts ? { pageStarts } : {}),
    ...(layout ? { layout } : {}),
  });
  if (doc.source === "sections") return [];
  return flatten(doc.chapters, pageStarts);
}

describe("layout chapter detection", () => {
  it("finds lecture titles from font size and ignores a lone Methods line", () => {
    const fixture = lectureFixture();
    const before = chaptersFromHeadingLines(fixture.spoken);
    expect(before.chapters.map((chapter) => chapter.title)).toEqual(["Methods"]);
    const after = titlesOf(fixture.spoken, fixture.layout, fixture.pageStarts);
    expect(after.map((row) => row.title)).toEqual(CLASS_TITLES);
    expect(after.some((row) => row.title === "Methods")).toBe(false);
    expect(after.some((row) => row.title === "Bibliography")).toBe(false);
    expect(after.some((row) => /figure/i.test(row.title))).toBe(false);
    const doc = resolveChapters(fixture.spoken, {
      source: "heading-lines",
      titles: [],
      pageStarts: fixture.pageStarts,
      layout: fixture.layout,
    });
    expect(doc.chapters[0]?.charStart).toBeGreaterThanOrEqual(0);
    expect(fixture.spoken.slice(doc.chapters[0]!.charStart, doc.chapters[0]!.charStart + 8)).toBe(
      "Class 1:"
    );
  });

  it("does not name a Q&A transcript after its one regex hit", () => {
    const fixture = qaFixture();
    expect(fixture.spoken.length).toBeGreaterThan(8000);
    const before = chaptersFromHeadingLines(fixture.spoken);
    expect(before.chapters.map((chapter) => chapter.title)).toEqual(["Methods"]);
    const doc = resolveChapters(fixture.spoken, {
      source: "heading-lines",
      titles: [],
      layout: fixture.layout,
    });
    expect(doc.source).toBe("sections");
    expect(doc.chapters.every((chapter) => /^Part \d+$/.test(chapter.title))).toBe(true);
  });

  it("nests numbered subsections and recovers a missing number", () => {
    const fixture = textbookFixture();
    const after = titlesOf(fixture.spoken, fixture.layout, fixture.pageStarts);
    expect(after.map((row) => row.title)).toEqual(fixture.truth.map((row) => row.title));
    const coast = after.find((row) => row.title === "1 The Coast");
    const harbors = after.find((row) => row.title === "1.1 Harbors");
    expect(coast?.level).toBe(1);
    expect(harbors?.level).toBe(2);
    expect(after.some((row) => row.title === "3 Gamma")).toBe(true);
  });

  it("uses a contents page when the headings are the same size as the body", () => {
    const fixture = sameSizeContentsFixture();
    const before = chaptersFromHeadingLines(fixture.spoken);
    expect(before.chapters).toHaveLength(0);
    const after = titlesOf(fixture.spoken, fixture.layout, fixture.pageStarts);
    expect(after.map((row) => row.title)).toEqual(fixture.truth.map((row) => row.title));
  });

  it("keeps a validated outline and rejects one that never leaves page 1", () => {
    const text = CLASS_TITLES.map(
      (title) => `${title}\n\n${"Words of the class. ".repeat(20)}\n\n`
    ).join("");
    expect(
      trustedOutline(
        {
          source: "pdf-outline",
          titles: CLASS_TITLES.map((title) => ({ title, level: 1, pageIndex: 0 })),
        },
        text.length
      )
    ).toBe(false);
    const good = resolveChapters(text, {
      source: "pdf-outline",
      titles: [
        { title: "Class 1: Zero to One", level: 1, pageIndex: 0 },
        { title: "Class 2: Party Like It's 1999", level: 1, pageIndex: 2 },
        { title: "Class 3: Value Systems", level: 1, pageIndex: 4 },
      ],
      pageStarts: [0, 200, 400, 600, 800, 1000],
      layout: lectureFixture().layout,
    });
    expect(good.source).toBe("pdf-outline");
    expect(good.chapters.map((chapter) => chapter.title)).toEqual([
      "Class 1: Zero to One",
      "Class 2: Party Like It's 1999",
      "Class 3: Value Systems",
    ]);
  });

  it("does not let layout replace a run of Chapter labels", () => {
    const spoken = novelSpoken();
    const before = titlesOf(spoken);
    expect(before.map((row) => row.title)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Chapter ${index + 1}`)
    );
    const lines: LayoutLine[] = [
      line({ text: "Notes", page: 0, size: 18, y: 0.1, first: true }),
      line({ text: "More notes", page: 1, size: 18, y: 0.1, first: true }),
    ];
    const after = titlesOf(spoken, { bodySize: 11, pageCount: 8, lines });
    expect(after.map((row) => row.title)).toEqual(before.map((row) => row.title));
  });

  it("keeps novel chapters when the layout lines are the chapter labels", () => {
    const spoken = novelSpoken();
    const lines: LayoutLine[] = Array.from({ length: 8 }, (_, index) =>
      line({ text: `Chapter ${index + 1}`, page: index, size: 11, y: 0.1, first: true })
    );
    const after = titlesOf(spoken, { bodySize: 11, pageCount: 8, lines });
    expect(after.map((row) => foldHeading(row.title))).toEqual(
      lines.map((row) => foldHeading(row.text))
    );
  });
});

describe("chapter metrics do not regress", () => {
  const cases = [
    {
      name: "lecture notes",
      run: () => {
        const fixture = lectureFixture();
        return {
          before: scoreHeadings(
            flatten(chaptersFromHeadingLines(fixture.spoken).chapters, fixture.pageStarts),
            fixture.truth,
            fixture.layout.pageCount
          ),
          after: scoreHeadings(
            titlesOf(fixture.spoken, fixture.layout, fixture.pageStarts),
            fixture.truth,
            fixture.layout.pageCount
          ),
        };
      },
    },
    {
      name: "q&a transcript",
      run: () => {
        const fixture = qaFixture();
        const truth: HeadingKey[] = [];
        return {
          before: scoreHeadings(
            flatten(chaptersFromHeadingLines(fixture.spoken).chapters),
            truth,
            fixture.layout.pageCount
          ),
          after: scoreHeadings(titlesOf(fixture.spoken, fixture.layout), truth, fixture.layout.pageCount),
        };
      },
    },
    {
      name: "textbook",
      run: () => {
        const fixture = textbookFixture();
        return {
          before: scoreHeadings(
            flatten(chaptersFromHeadingLines(fixture.spoken).chapters, fixture.pageStarts),
            fixture.truth,
            fixture.layout.pageCount
          ),
          after: scoreHeadings(
            titlesOf(fixture.spoken, fixture.layout, fixture.pageStarts),
            fixture.truth,
            fixture.layout.pageCount
          ),
        };
      },
    },
    {
      name: "same-size contents",
      run: () => {
        const fixture = sameSizeContentsFixture();
        return {
          before: scoreHeadings(
            flatten(chaptersFromHeadingLines(fixture.spoken).chapters, fixture.pageStarts),
            fixture.truth,
            fixture.layout.pageCount
          ),
          after: scoreHeadings(
            titlesOf(fixture.spoken, fixture.layout, fixture.pageStarts),
            fixture.truth,
            fixture.layout.pageCount
          ),
        };
      },
    },
    {
      name: "novel heading lines",
      run: () => {
        const spoken = novelSpoken();
        const truth = Array.from({ length: 8 }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          level: 1,
        }));
        return {
          before: scoreHeadings(flatten(chaptersFromHeadingLines(spoken).chapters), truth, 8),
          after: scoreHeadings(titlesOf(spoken), truth, 8),
        };
      },
    },
  ];

  it("does not lower F1 on any fixture", () => {
    const table = cases.map((entry) => {
      const scored = entry.run();
      return { name: entry.name, ...scored };
    });
    for (const row of table) {
      expect(row.after.f1).toBeGreaterThanOrEqual(row.before.f1 - 1e-9);
      expect(row.after.falsePer100Pages).toBeLessThanOrEqual(row.before.falsePer100Pages + 1e-9);
    }
    expect(table.find((row) => row.name === "lecture notes")?.after.f1).toBe(1);
  });
});

describe("layout line capture", () => {
  it("records bold from the font name and the character-weighted body size", () => {
    const page: PdfPage = {
      height: 800,
      width: 600,
      items: [],
      lines: [
        {
          y: 740,
          h: 14,
          items: [{ k: 0, s: "Class 1", eol: true, x: 70, y: 740, h: 14, font: "Times-Bold" }],
          text: "Class 1",
        },
        {
          y: 700,
          h: 11,
          items: [
            {
              k: 1,
              s: "The body of the page is long enough to set the mode.",
              eol: true,
              x: 72,
              y: 700,
              h: 11,
              font: "Times-Roman",
            },
          ],
          text: "The body of the page is long enough to set the mode.",
        },
      ],
    };
    stampLineGeometry(page, 600);
    expect(page.lines[0]?.bold).toBe(true);
    expect(page.lines[1]?.bold).toBe(false);
    const features = layoutFromPages([page]);
    expect(features.bodySize).toBe(11);
    expect(features.lines.some((row) => row.text === "Class 1" && row.bold)).toBe(true);
  });
});

describe("chapter llm verifier", () => {
  it("rejects unknown ids and titles are not required", () => {
    const allowed = new Set(["p1-0", "p2-1"]);
    expect(parseChapterLlmDecisions("not json", allowed)).toBeNull();
    expect(
      parseChapterLlmDecisions(
        JSON.stringify({ decisions: [{ id: "nope", label: "heading" }] }),
        allowed
      )
    ).toBeNull();
    const parsed = parseChapterLlmDecisions(
      JSON.stringify({
        decisions: [
          { id: "p1-0", label: "not_heading", title: "Invented" },
          { id: "p2-1", label: "heading", level: 2 },
        ],
      }),
      allowed
    );
    expect(parsed?.map((row) => row.label)).toEqual(["not_heading", "heading"]);
    expect(parsed?.[1]?.level).toBe(2);
    expect(JSON.stringify(parsed)).not.toContain("Invented");
  });

  it("keeps the deterministic outline when the reply drops high-confidence lines", () => {
    const high = [
      { id: "a", text: "One", page: 0, score: 8, high: true, features: "", context: "" },
      { id: "b", text: "Two", page: 1, score: 8, high: true, features: "", context: "" },
      { id: "c", text: "Three", page: 2, score: 8, high: true, features: "", context: "" },
      { id: "d", text: "Four", page: 3, score: 8, high: true, features: "", context: "" },
      { id: "e", text: "Five", page: 4, score: 8, high: true, features: "", context: "" },
    ];
    const decisions = high.slice(0, 2).map((row) => ({ id: row.id, label: "not_heading" as const }));
    expect(
      chapterLlmGate({ high, decisions, deterministicCount: 5, nextCount: 3 })
    ).toBe(false);
    expect(
      chapterLlmGate({
        high,
        decisions: [{ id: "a", label: "unsure" }],
        deterministicCount: 5,
        nextCount: 5,
      })
    ).toBe(true);
    expect(
      chapterLlmGate({ high: [], decisions: [], deterministicCount: 10, nextCount: 2 })
    ).toBe(false);
  });

  it("estimates well under two cents for a book of mid-score lines", () => {
    const cost = estimateChapterLlmCost(40);
    expect(cost.usd).toBeLessThan(0.02);
    expect(cost.inputTokens).toBeLessThan(4000);
  });

  it("returns null from a detector that was not given lines", () => {
    expect(detectLayoutChapters("Hello.", undefined)).toBeNull();
  });
});
