import { describe, expect, it } from "vitest";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import {
  flattenListsAndTables,
  normalizeNumbersAndAbbreviations,
} from "@/lib/tts/normalize-speakable";
import { narrationScriptForSynthesis } from "@/lib/tts/narration-script";
import { unwrapPastedText } from "@/lib/pdf-line-unwrap";
import { htmlToArticle } from "@/lib/html-article";
import {
  findFullTextLink,
  looksLikeSourceCode,
  shouldFollowFullText,
  withoutSourceCode,
} from "@/lib/url-reading";

/**
 * The narration text for pasted and URL-imported sources.
 *
 * Every case states the exact string a provider would receive, so a change to
 * any stage — link stripping, unwrapping, list flattening, number speech —
 * shows up as a diff here rather than as a book that sounds wrong.
 */

/** Fish gets the cleaned words with no cue tags. */
function fish(raw: string, opts?: { normalizeTitles?: boolean }): string {
  return narrationScriptForSynthesis(
    toSpeakableText(raw, { normalizeTitles: opts?.normalizeTitles }),
    "fish"
  );
}

describe("scaled currency is spoken as a quantity, not cents", () => {
  it("speaks millions and billions with the magnitude first", () => {
    expect(normalizeNumbersAndAbbreviations(
      "The town's seawall was rebuilt in 2019 at a cost of $4.2 million."
    )).toBe(
      "The town's seawall was rebuilt in two thousand nineteen at a cost of four point two million dollars."
    );
    expect(normalizeNumbersAndAbbreviations(
      "It disbursed $1.8 billion nationally in fiscal 2025."
    )).toBe(
      "It disbursed one point eight billion dollars nationally in fiscal two thousand twenty-five."
    );
  });

  it("still reads a plain price as dollars and cents", () => {
    expect(normalizeNumbersAndAbbreviations("The ticket costs $4.50.")).toBe(
      "The ticket costs four dollars and fifty cents."
    );
    expect(normalizeNumbersAndAbbreviations("Subscribe for $1 a week.")).toBe(
      "Subscribe for one dollar a week."
    );
  });
});

describe("links and inline addresses leave no dangling clause", () => {
  it("turns a markdown link into its label", () => {
    const raw =
      "Further reading: [the original thread](https://thread.example.com/123).";
    expect(toSpeakableText(raw)).toBe("Further reading: the original thread.");
    // The same words for every provider: no bracket residue survives.
    expect(fish(raw)).toBe("Further reading: the original thread.");
    expect(narrationScriptForSynthesis(toSpeakableText(raw), "edge")).toBe(
      "Further reading: the original thread."
    );
    expect(narrationScriptForSynthesis(toSpeakableText(raw), "openrouter")).toBe(
      "Further reading: the original thread."
    );
  });

  it("takes the preposition with a bare URL", () => {
    expect(toSpeakableText(
      "Read the report at https://example.com/report-2026 for details."
    )).toBe("Read the report for details.");
  });

  it("takes the preposition with an email address", () => {
    expect(toSpeakableText("Write to press@example.com for comment.")).toBe(
      "Write for comment."
    );
  });

  it("keeps a bracketed aside that is real words", () => {
    expect(fish("He paused [a long moment] before answering.")).toBe(
      "He paused (a long moment) before answering."
    );
  });
});

describe("hard-wrapped and per-line pastes rebuild paragraphs", () => {
  it("dehyphenates and joins a visually wrapped paragraph", () => {
    // The shape a copy out of a PDF viewer produces: a blank line between
    // paragraphs, but hard wraps inside each one.
    const wrapped = [
      "The government's comprehen-",
      "sive review of coastal infra-",
      "structure was published in the spring.",
      "",
      "It found that seventy-",
      "three percent of seawalls needed work.",
    ].join("\n");
    expect(toSpeakableText(unwrapPastedText(wrapped))).toBe(
      "The government's comprehensive review of coastal infrastructure was published in the spring.\n\n" +
        "It found that seventy-three percent of seawalls needed work."
    );
  });

  it("dehyphenates a paragraph with no blank line at all", () => {
    // A single block: the hyphen join is what matters, and the whole block
    // stays one paragraph — the same call the PDF path makes.
    const wrapped = [
      "The government's comprehen-",
      "sive review of coastal infra-",
      "structure was published in the spring.",
      "It found that seventy-",
      "three percent of seawalls needed work.",
    ].join("\n");
    expect(toSpeakableText(unwrapPastedText(wrapped))).toBe(
      "The government's comprehensive review of coastal infrastructure was published in the spring. " +
        "It found that seventy-three percent of seawalls needed work."
    );
  });

  it("keeps a sentence-per-line paste as one paragraph", () => {
    const perLine = [
      "Rockport, Maine — The town's seawall was rebuilt in 2019.",
      "Officials say it may not survive another decade.",
      "\"We're planning for 3 feet of sea-level rise.\"",
      "That's the number that keeps me up at night.",
    ].join("\n");
    expect(toSpeakableText(unwrapPastedText(perLine))).toBe(
      "Rockport, Maine — The town's seawall was rebuilt in 2019. " +
        "Officials say it may not survive another decade. " +
        "\"We're planning for 3 feet of sea-level rise.\" " +
        "That's the number that keeps me up at night."
    );
  });

  it("keeps blank-line paragraphs apart", () => {
    const text = "First paragraph here, with words in it.\n\nSecond paragraph here, also with words.";
    expect(unwrapPastedText(text)).toBe(
      "First paragraph here, with words in it.\n\nSecond paragraph here, also with words."
    );
  });
});

describe("lists and tables become speakable lines", () => {
  it("drops bullet characters and gives each item its own paragraph", () => {
    expect(toSpeakableText("Prep list:\n- bottled water\n- batteries\n- a radio")).toBe(
      "Prep list:\n\nbottled water\n\nbatteries\n\na radio"
    );
  });

  it("keeps list numerals so they are spoken as ordinals", () => {
    expect(toSpeakableText("Steps:\n1. Fill the bath\n2. Turn off the mains")).toBe(
      "Steps:\n\n1. Fill the bath\n\n2. Turn off the mains"
    );
  });

  it("strips table pipes and the alignment row", () => {
    expect(flattenListsAndTables("| Region | Loss |\n|---|---|\n| North | $4.2m |")).toBe(
      "Region, Loss\n\nNorth, $4.2m"
    );
  });

  it("does not mistake a prose em dash for a bullet", () => {
    expect(flattenListsAndTables("Rockport, Maine — The town's seawall.")).toBe(
      "Rockport, Maine — The town's seawall."
    );
  });
});

describe("symbols that must never reach the voice", () => {
  it("drops emoji", () => {
    expect(toSpeakableText("Great news 🎉 the storm passed 🌊 and we're safe ✅.")).toBe(
      "Great news the storm passed and we're safe."
    );
  });

  it("decodes a raw entity left in pasted text", () => {
    expect(toSpeakableText("Rock &amp; Roll was born in the U.S.A.")).toBe(
      "Rock & Roll was born in the U.S.A."
    );
  });

  it("removes editorial insertions instead of speaking them", () => {
    expect(toSpeakableText("The report said [sic] the bridge was safe.")).toBe(
      "The report said the bridge was safe."
    );
    expect(toSpeakableText("The [emphasis] real words stay.")).toBe(
      "The real words stay."
    );
  });
});

describe("all-caps handling keeps acronyms", () => {
  it("never title-cases an all-caps sentence or initialism run", () => {
    const raw = "NOAA AND FEMA ISSUED JOINT GUIDANCE ON TUESDAY.";
    expect(toSpeakableText(raw, { normalizeTitles: true })).toBe(raw);
    const shout = "THE STORM HAS PASSED AND EVERYONE IS SAFE.";
    expect(toSpeakableText(shout, { normalizeTitles: true })).toBe(shout);
  });

  it("still title-cases a real heading, preserving acronyms inside it", () => {
    expect(toSpeakableText("BREAKING: THE STORM HAS PASSED", { normalizeTitles: true })).toBe(
      "Breaking: The Storm Has Passed"
    );
    expect(toSpeakableText("NOAA STORM REPORT", { normalizeTitles: true })).toBe(
      "NOAA Storm Report"
    );
  });
});

describe("code-like digits and decades", () => {
  it("leaves N+1 and other designators alone", () => {
    expect(normalizeNumbersAndAbbreviations("We found the N+1 loop after two days.")).toBe(
      "We found the N+1 loop after two days."
    );
    expect(normalizeNumbersAndAbbreviations("It returned v2 and H.264 frames.")).toBe(
      "It returned v2 and H.264 frames."
    );
  });

  it("speaks decades as decades", () => {
    expect(normalizeNumbersAndAbbreviations("Attitudes shifted through the 1990s.")).toBe(
      "Attitudes shifted through the nineteen nineties."
    );
    expect(normalizeNumbersAndAbbreviations("Then came the 2000s and the 2010s.")).toBe(
      "Then came the two thousands and the twenty tens."
    );
  });

  it("keeps ordinary quantities intact", () => {
    expect(normalizeNumbersAndAbbreviations("Between 18 and 25 named storms.")).toBe(
      "Between eighteen and twenty-five named storms."
    );
    // A modern year keeps the existing two-thousand form; only 1100–1999 use
    // the paired reading. Unchanged by this work.
    expect(normalizeNumbersAndAbbreviations("It happened in 2026.")).toBe(
      "It happened in two thousand twenty-six."
    );
  });
});

describe("a short page does not follow a sitemap link", () => {
  const note = `A short field note

The dinghy was already floating by eight, and nobody had untied it.

We rowed out to the point and waited for the wind to shift. It never did.`;

  it("does not treat a short article as a catalog page", () => {
    expect(shouldFollowFullText(note)).toBe(false);
  });

  it("still follows an explicit download or catalog page", () => {
    expect(shouldFollowFullText("Download this ebook as plain text or EPUB. Public domain.")).toBe(
      true
    );
  });

  it("refuses a sitemap or robots link even when it says plain text", () => {
    const html = `<footer><a href="/sitemap.txt">plain text</a></footer>`;
    const base = new URL("https://example.com/notes/morning.html");
    expect(findFullTextLink(html, base)).toBeNull();
    const robots = `<a href="/robots.txt">robots.txt</a>`;
    expect(findFullTextLink(robots, base)).toBeNull();
  });

  it("still follows a real full-text link on the same site", () => {
    const html = `<a href="/files/book.txt.utf-8">Plain text</a>`;
    const base = new URL("https://www.gutenberg.org/ebooks/1342");
    expect(findFullTextLink(html, base)?.href).toBe(
      "https://www.gutenberg.org/files/book.txt.utf-8"
    );
  });
});

describe("URL import: chrome and link rows are not narrated", () => {
  const NESTED = `<!doctype html><html><head><title>A short field note</title></head><body>
<div id="page">
  <div class="top">
    <div class="links"><a href="/">Home</a><a href="/blog">Blog</a><a href="/about">About</a></div>
  </div>
  <div class="content">
    <h1>A short field note</h1>
    <p>The tide came in faster than anyone expected that morning.</p>
    <p>We rowed out to the point and waited for the wind to shift. It never did.</p>
  </div>
  <div class="trending">
    <h3>More from the blog</h3>
    <ul><li>Notes on rope</li><li>Notes on tides</li></ul>
  </div>
</div>
</body></html>`;

  it("drops a link-only nav row and a trending block", () => {
    const article = htmlToArticle(NESTED);
    expect(article.text).not.toContain("Home");
    expect(article.text).not.toContain("About");
    expect(article.text).not.toContain("More from the blog");
    expect(article.text).not.toContain("Notes on rope");
    expect(article.text).toContain("The tide came in faster than anyone expected");
  });

  it("keeps prose that happens to sit inside an unlabelled div", () => {
    const article = htmlToArticle(NESTED);
    expect(article.text).toContain("We rowed out to the point");
  });

  it("keeps a SQL snippet that a code heuristic would miss", () => {
    // The URL path drops whole paragraphs that read as source. SQL does not
    // match that heuristic, so it is narrated — a separate, known limitation.
    const sql = "SELECT u.id, count(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id;";
    expect(looksLikeSourceCode(sql)).toBe(false);
    expect(withoutSourceCode(`Intro sentence.\n\n${sql}`)).toContain(sql);
  });
});

describe("the pasted news article end to end", () => {
  const NEWS = `Coastal Towns Brace for Record Storm Season

By Dana Whitfield · October 3, 2026

Waves crash over a seawall in Rockport on Tuesday. (Photo by Marcus Lee/Getty Images)

Rockport, Maine — The town's seawall was rebuilt in 2019 at a cost of $4.2 million, but officials say it may not survive another decade.

Forecasters expect between 18 and 25 named storms, of which 8 to 13 are projected to become hurricanes[1].

Share this article: Facebook Twitter Email

Subscribe to The Daily Ledger for $1 a week

Read more: The storms that reshaped the coast`;

  it("drops share, subscribe, and read-more furniture", () => {
    const spoken = toSpeakableText(NEWS);
    expect(spoken).not.toContain("Share this article");
    expect(spoken).not.toContain("Facebook Twitter Email");
    expect(spoken).not.toContain("Subscribe to The Daily Ledger");
    expect(spoken).not.toContain("Read more:");
    // The article itself survives.
    expect(spoken).toContain("Rockport, Maine — The town's seawall");
  });

  it("reaches Fish with every number spoken correctly", () => {
    const spoken = toSpeakableText(NEWS);
    expect(spoken).toContain("rebuilt in 2019 at a cost of $4.2 million");
    expect(spoken).toContain("projected to become hurricanes.");
    const numbered = normalizeNumbersAndAbbreviations(spoken);
    expect(numbered).toContain("four point two million dollars");
    expect(numbered).toContain("eighteen and twenty-five named storms");
    expect(numbered).not.toContain("cents million");
  });
});

describe("URL import: caption, superscript and social handles", () => {
  const PAGE = `<!doctype html><html><head><title>Storm note</title></head><body><main><article>
<h1>Storm note</h1>
<figure><img src="/a.jpg" alt="Waves"><figcaption>Waves crash over a seawall on Tuesday. (Photo by Marcus Lee/Getty Images)</figcaption></figure>
<p>Forecasters expect 18 named storms<sup>[1]</sup> this season.</p>
<p>Write to jane.doe@example.com or @jane on Bluesky.</p>
</article></main></body></html>`;

  it("never narrates a figure caption or its photo credit", () => {
    const article = htmlToArticle(PAGE);
    expect(article.text).not.toContain("Photo by");
    expect(article.text).not.toContain("Waves crash over a seawall");
  });

  it("drops a footnote superscript instead of gluing its digit on", () => {
    const article = htmlToArticle(PAGE);
    expect(article.text).toContain("expect 18 named storms this season.");
    expect(article.text).not.toContain("[1]");
  });

  it("keeps the sentence readable when an address and a handle are listed", () => {
    const spoken = toSpeakableText(htmlToArticle(PAGE).text);
    expect(spoken).toContain("Write to on Bluesky.");
    expect(spoken).not.toContain("example.com");
    expect(spoken).not.toContain("@jane");
  });
});
