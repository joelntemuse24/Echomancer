import { describe, expect, it } from "vitest";
import { resolveChapters } from "@/lib/book-chapters";
import { unwrapPdfLines } from "@/lib/pdf-line-unwrap";
import { placeTopicPhrase } from "@/lib/printed-toc";
import { isChapterHeading } from "@/lib/tts/speakable-text";

function prose(sentence: string, times = 6): string {
  return Array.from({ length: times }, () => sentence).join(" ");
}

describe("chapter detection regressions", () => {
  it("does not place an outline entry on the contents page", () => {
    const text = [
      "CONTENTS",
      "3 Method",
      "4 Experiments",
      "5 Conclusion",
      prose("The introduction explains the model and the contents page ends here."),
      "3 Method",
      prose("The method section describes the router and the training objective."),
      "4 Experiments",
      prose("The experiments measure accuracy on the held out set."),
      "5 Conclusion",
      prose("The conclusion restates the result and the limits of the study."),
    ].join("\n\n");
    const contentsMethod = text.indexOf("3 Method");
    const bodyMethod = text.indexOf("3 Method", contentsMethod + 1);
    const doc = resolveChapters(text, {
      source: "pdf-outline",
      titles: [
        { title: "3 Method", level: 1, charStart: contentsMethod },
        { title: "4 Experiments", level: 1, charStart: text.indexOf("4 Experiments") },
        { title: "5 Conclusion", level: 1, charStart: text.indexOf("5 Conclusion") },
      ],
    });
    const method = doc.chapters.find((chapter) => chapter.title === "3 Method");
    const conclusion = doc.chapters.find((chapter) => chapter.title === "5 Conclusion");
    expect(method?.charStart).toBe(bodyMethod);
    expect(conclusion?.charStart).toBe(text.lastIndexOf("5 Conclusion"));
  });

  it("keeps a one-word heading that has a body, and a numbered section", () => {
    const text = [
      "1 Introduction",
      prose("Recurrent models remain the baseline for this task and the results hold.", 12),
      "5 Training",
      prose("The training run uses the full corpus and reports the loss.", 12),
      "5 White",
      "The house sat quietly.",
      "6 Results",
      prose("The results table lists the scores for each model.", 12),
      "3.1 Routing",
      prose("The router sends each token to a single expert.", 12),
      "4.1 Setup",
      prose("The setup describes the hardware and the dataset.", 12),
    ].join("\n\n");
    const doc = resolveChapters(text, { source: "heading-lines", titles: [] });
    const titles = doc.chapters.map((chapter) => chapter.title);
    expect(titles).toContain("1 Introduction");
    expect(titles).toContain("5 Training");
    expect(titles).toContain("6 Results");
    expect(titles).toContain("3.1 Routing");
    expect(titles).toContain("4.1 Setup");
    expect(titles).not.toContain("5 White");
  });

  it("keeps a chapter number that restarts in a later book", () => {
    const text = [
      "BOOK ONE",
      "CHAPTER III",
      "A short opening.",
      "CHAPTER IV",
      prose("The next chapter continues and another sentence follows it."),
      "BOOK THREE",
      "CHAPTER III",
      "A short opening.",
      "CHAPTER IV",
      prose("The next chapter continues and another sentence follows it."),
    ].join("\n\n");
    const doc = resolveChapters(text, { source: "heading-lines", titles: [] });
    const titles = doc.chapters.map((chapter) => chapter.title);
    expect(titles.filter((title) => /Chapter III/i.test(title))).toHaveLength(2);
  });

  it("keeps an explicit decimal heading from a styled source", () => {
    const text = [
      "2.1 Subscriptions",
      "Customers pay monthly.",
      "2.2 Services",
      "The catalog lists each offering.",
    ].join("\n\n");
    const doc = resolveChapters(text, {
      source: "docx-heading",
      titles: [
        { title: "2.1 Subscriptions", level: 2 },
        { title: "2.2 Services", level: 2 },
      ],
    });
    expect(doc.source).toBe("docx-heading");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "2.1 Subscriptions",
      "2.2 Services",
    ]);
  });

  it("keeps a glued chapter token and a one-word roman chapter", () => {
    expect(isChapterHeading("CHAPTERXXVII.")).toBe(true);
    const text = [
      "CHAPTERXXVII.",
      prose("Elizabeth could not but be pleased, and she answered at once."),
      "I",
      prose("One morning, when Gregor Samsa woke from troubled dreams, he found himself transformed."),
    ].join("\n\n");
    const doc = resolveChapters(text, {
      source: "epub-spine",
      titles: [
        { title: "CHAPTERXXVII.", level: 1 },
        { title: "I", level: 1 },
      ],
    });
    expect(doc.source).toBe("epub-spine");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual(["Chapterxxvii.", "I"]);
  });

  it("keeps a body Abstract the outline does not list", () => {
    const text = [
      "Abstract",
      prose("Recent work has demonstrated substantial gains on many tasks and the margin holds."),
      "1 Introduction",
      prose("The introduction explains the model and why the earlier results were incomplete."),
      "2 Method",
      prose("The method section describes the router and the training objective in detail."),
    ].join("\n\n");
    const doc = resolveChapters(text, {
      source: "pdf-outline",
      titles: [
        { title: "1 Introduction", level: 1 },
        { title: "2 Method", level: 1 },
      ],
    });
    expect(doc.source).toBe("pdf-outline");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Abstract",
      "1 Introduction",
      "2 Method",
    ]);
  });

  it("places only a verbatim topic title", () => {
    const part = "Wilson carried the bill, and the legislative session ended in the spring.";
    expect(placeTopicPhrase(part, "Wilson's Legislative Triumph", 0)).toBeNull();
    const exact = "The Significance of the Frontier settled the argument for a generation.";
    expect(placeTopicPhrase(exact, "The Significance of the Frontier", 0)).toBe(0);
  });

  it("keeps a short all-caps numbered heading that opens a section", () => {
    const text = [
      "3 BERT",
      prose("We introduce BERT and the pre-training procedure that follows it.", 8),
      "5 White",
      "The house sat quietly.",
      "6 Results",
      prose("The results table lists the scores for each model.", 8),
    ].join("\n\n");
    const doc = resolveChapters(text, { source: "heading-lines", titles: [] });
    const titles = doc.chapters.map((chapter) => chapter.title);
    expect(titles).toContain("3 Bert");
    expect(titles).toContain("6 Results");
    expect(titles).not.toContain("5 White");
    expect(isChapterHeading("3 BERT")).toBe(true);
    expect(isChapterHeading("4.2 SQuAD v1.1")).toBe(true);
    expect(isChapterHeading("A City on a Hill")).toBe(false);
    expect(isChapterHeading("0.3 F1 behind fine-tuning the entire model. This")).toBe(false);
    expect(isChapterHeading("C T1 T[sep]")).toBe(false);
  });

  it("keeps a decimal heading and an appendix line on their own line", () => {
    const paras = unwrapPdfLines([
      "The previous section ends here.",
      "4.2 SQuAD v1.1",
      "The Stanford Question Answering Dataset measures span prediction on paragraphs.",
      "We use positional embeddings.",
      "A.2 Pre-training Procedure",
      "The procedure masks tokens and then predicts them from context.",
      "A.3 Fine-tuning Procedure",
      "Fine-tuning updates every weight on the labeled task.",
      "B Detailed Experimental Setup",
      "B.1 Detailed Descriptions for the GLUE",
      "The benchmark covers several tasks and the scores are reported below in full.",
    ]);
    expect(paras).toContain("4.2 SQuAD v1.1");
    expect(paras).toContain("A.2 Pre-training Procedure");
    expect(paras).toContain("A.3 Fine-tuning Procedure");
    expect(paras).toContain("B Detailed Experimental Setup");
    expect(paras).toContain("B.1 Detailed Descriptions for the GLUE");
    const text = [...paras, prose("More results follow in the appendix tables.", 4)].join("\n\n");
    const doc = resolveChapters(text, { source: "heading-lines", titles: [] });
    const titles = doc.chapters.map((chapter) => chapter.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "4.2 SQuAD v1.1",
        "A.2 Pre-training Procedure",
        "A.3 Fine-tuning Procedure",
        "B Detailed Experimental Setup",
        "B.1 Detailed Descriptions for the GLUE",
      ])
    );
  });

  it("finds an outline title inline on the destination page and nests subsections", () => {
    const contents = [
      "CONTENTS",
      "3.1 Language Modeling, Cloze, and Completion Tasks",
      "6.2 Fairness, Bias, and Representation",
    ].join("\n\n");
    const intro = prose("The introduction explains the model before the tasks begin.", 8);
    const tasks =
      "Earlier scores are listed by aRWC+19 3.1 Language Modeling, Cloze, and Completion Tasks\n\n" +
      [
        "3.1.1 Language Modeling",
        prose("The model predicts the next token from the left context.", 6),
        "3.1.2 LAMBADA",
        prose("The passage is completed from a broader context window.", 6),
        "3.1.4 StoryCloze",
        prose("The ending is chosen from two written options.", 6),
      ].join("\n\n");
    const text = [contents, intro, tasks].join("\n\n");
    const pageStarts = [0, contents.length + 2, contents.length + 2 + intro.length + 2];
    const doc = resolveChapters(text, {
      source: "pdf-outline",
      pageStarts,
      titles: [
        {
          title: "3.1 Language Modeling, Cloze, and Completion Tasks",
          level: 2,
          pageIndex: 2,
        },
      ],
    });
    expect(doc.source).toBe("pdf-outline");
    const section = doc.chapters.find((chapter) =>
      chapter.title.startsWith("3.1 Language Modeling")
    );
    expect(section).toBeTruthy();
    expect(section!.charStart).toBeGreaterThanOrEqual(pageStarts[2]!);
    expect(text.slice(section!.charStart, section!.charStart + 12)).toBe("3.1 Language");
    const childTitles = (section!.children ?? []).map((chapter) => chapter.title);
    expect(childTitles).toEqual(
      expect.arrayContaining(["3.1.1 Language Modeling", "3.1.2 Lambada", "3.1.4 StoryCloze"])
    );
  });
});
