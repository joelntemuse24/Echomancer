import { describe, expect, it } from "vitest";
import { toSpeakableText } from "./speakable-text";

/**
 * Typical first-page extract of Vaswani et al. (Attention Is All You Need):
 * title, author/affiliation/email stack, conference header, then the Abstract.
 * Mirrors what unpdf + normalizeExtractedText emit (soft wraps already joined).
 */
export const ATTENTION_PAGE_1_FIXTURE = `
Attention Is All You Need

Ashish Vaswani∗
Google Brain
avaswani@google.com

Noam Shazeer∗
Google Brain
noam@google.com

Niki Parmar∗
Google Research
niki@google.com

Jakob Uszkoreit∗
Google Research
usz@google.com

Llion Jones∗
Google Research
llion@google.com

Aidan N. Gomez∗†
University of Toronto
aidan@cs.toronto.edu

Łukasz Kaiser∗
Google Brain
lukaszkaiser@google.com

Illia Polosukhin∗‡
illia.polosukhin@gmail.com

31st Conference on Neural Information Processing Systems (NIPS 2017), Long Beach, CA, USA.

Abstract

The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.

1 Introduction

Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation.

https://arxiv.org/abs/1706.03762
arXiv:1706.03762
doi:10.5555/3295222.3295349
ISSN 1049-5258
© 2017 Neural Information Processing Systems Foundation, Inc. All rights reserved.
`.trim();

/** Same page after PDF line-wrap join — title, authors, and emails in one block. */
export const ATTENTION_PAGE_1_GLUED = [
  "Attention Is All You Need Ashish Vaswani∗ Google Brain avaswani@google.com Noam Shazeer∗ Google Brain noam@google.com Niki Parmar∗ Google Research niki@google.com Jakob Uszkoreit∗ Google Research usz@google.com Llion Jones∗ Google Research llion@google.com Aidan N. Gomez∗† University of Toronto aidan@cs.toronto.edu Łukasz Kaiser∗ Google Brain lukaszkaiser@google.com Illia Polosukhin∗‡ illia.polosukhin@gmail.com 31st Conference on Neural Information Processing Systems (NIPS 2017), Long Beach, CA, USA.",
  "Abstract",
  "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.",
].join("\n\n");

describe("toSpeakableText", () => {
  it("drops emails, URLs, and identifiers from Attention page-1 while keeping the abstract", () => {
    const spoken = toSpeakableText(ATTENTION_PAGE_1_FIXTURE);

    expect(spoken).toMatch(/Attention Is All You Need/);
    expect(spoken).toMatch(/Abstract/);
    expect(spoken).toMatch(/dominant sequence transduction/);
    expect(spoken).toMatch(/Transformer/);
    expect(spoken).toMatch(/1 Introduction/);
    expect(spoken).toMatch(/Recurrent neural networks/);

    expect(spoken).not.toMatch(/@/);
    expect(spoken).not.toMatch(/avaswani/i);
    expect(spoken).not.toMatch(/google\.com/i);
    expect(spoken).not.toMatch(/toronto\.edu/i);
    expect(spoken).not.toMatch(/gmail\.com/i);
    expect(spoken).not.toMatch(/https?:\/\//i);
    expect(spoken).not.toMatch(/arxiv/i);
    expect(spoken).not.toMatch(/doi:\s*10/i);
    expect(spoken).not.toMatch(/ISSN/i);
    expect(spoken).not.toMatch(/©/);
    expect(spoken).not.toMatch(/copyright/i);
    expect(spoken).not.toMatch(/\bpunct\b/i);
  });

  it("does not leave email fragments that TTS would spell letter-by-letter", () => {
    const spoken = toSpeakableText(ATTENTION_PAGE_1_FIXTURE);
    expect(spoken.toLowerCase()).not.toContain("google.com");
    expect(spoken).not.toMatch(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    // Domain leftovers after stripping @ (Fish spells these and says "punct" for ".")
    expect(spoken).not.toMatch(/\bgoogle\s*\.\s*com\b/i);
  });

  it("skips academic cover metadata when body prose follows", () => {
    const spoken = toSpeakableText(ATTENTION_PAGE_1_FIXTURE);
    expect(spoken).not.toMatch(/31st Conference/i);
    expect(spoken).not.toMatch(/Proceedings of/i);
    expect(spoken).not.toMatch(/Google Brain/i);
    expect(spoken).not.toMatch(/Google Research/i);
    expect(spoken).not.toMatch(/University of Toronto/i);
    expect(spoken).not.toMatch(/Ashish Vaswani/i);
    expect(spoken).not.toMatch(/Noam Shazeer/i);
  });

  it("cleans a glued title-page paragraph the same way", () => {
    const spoken = toSpeakableText(ATTENTION_PAGE_1_GLUED);
    expect(spoken).toMatch(/Attention Is All You Need/);
    expect(spoken).toMatch(/Abstract/);
    expect(spoken).toMatch(/dominant sequence transduction/);
    expect(spoken).not.toMatch(/@/);
    expect(spoken).not.toMatch(/google\.com/i);
    expect(spoken).not.toMatch(/31st Conference/i);
    expect(spoken).not.toMatch(/Google Brain/i);
    expect(spoken).not.toMatch(/Ashish Vaswani/i);
  });

  it("strips spaced emails so dots are not spoken as punct", () => {
    const spoken = toSpeakableText(
      "Hello there.\n\ncontact @ google . com\n\nThe river was wide and the night was long enough to count as prose for a narrator."
    );
    expect(spoken).not.toMatch(/@/);
    expect(spoken).not.toMatch(/google/i);
    expect(spoken).toMatch(/river was wide/);
  });

  it("drops proceedings, doi, ISSN, and copyright lines anywhere", () => {
    const spoken = toSpeakableText(
      [
        "Chapter One",
        "It was a dark and stormy night, and the rain had not let up for hours as the ship crossed the bay.",
        "Proceedings of the 31st Conference on Neural Information Processing Systems",
        "doi:10.1145/example.1234",
        "ISSN 1049-5258",
        "Copyright © 2017 ACM",
      ].join("\n\n")
    );
    expect(spoken).toMatch(/dark and stormy night/);
    expect(spoken).not.toMatch(/Proceedings of/i);
    expect(spoken).not.toMatch(/doi:/i);
    expect(spoken).not.toMatch(/ISSN/i);
    expect(spoken).not.toMatch(/Copyright/i);
  });

  it("collapses repeated whitespace and keeps real sentences", () => {
    const spoken = toSpeakableText(
      "Hello    world.\n\n\n\nNext   paragraph   here, with a proper sentence."
    );
    expect(spoken).toBe("Hello world.\n\nNext paragraph here, with a proper sentence.");
  });

  it("keeps a novel chapter including a single byline", () => {
    const spoken = toSpeakableText(
      [
        "Moby Dick",
        "Herman Melville",
        "Chapter 1. Loomings.",
        "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, I thought I would sail about a little and see the watery part of the world.",
      ].join("\n\n")
    );
    expect(spoken).toMatch(/Moby Dick/);
    expect(spoken).toMatch(/Herman Melville/);
    expect(spoken).toMatch(/Call me Ishmael/);
  });

  it("keeps the word Google in body prose that is not an email", () => {
    const spoken = toSpeakableText(
      "Abstract\n\nThe authors later joined Google to continue the work on attention, and they published further results the next year."
    );
    expect(spoken).toMatch(/joined Google/);
  });

  it("is idempotent", () => {
    const once = toSpeakableText(ATTENTION_PAGE_1_FIXTURE);
    expect(toSpeakableText(once)).toBe(once);
  });

  it("returns empty string for blank input", () => {
    expect(toSpeakableText("")).toBe("");
    expect(toSpeakableText("   \n\n  ")).toBe("");
  });
});
