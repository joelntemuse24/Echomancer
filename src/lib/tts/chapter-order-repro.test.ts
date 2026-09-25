import { describe, expect, it } from "vitest";
import { chaptersFromHeadingLines } from "@/lib/book-chapters";
import { playbackChaptersFromSections } from "@/lib/player/playback-chapters";
import { deterministicPrepass } from "./listen-prep";
import { packSpeakableSections } from "./split-text";
import { toSpeakableText } from "./speakable-text";

function playerChapters(raw: string): string[] {
  const spoken = toSpeakableText(deterministicPrepass(raw));
  return playbackChaptersFromSections(packSpeakableSections(spoken, 4000)).map(
    (chapter) => chapter.title
  );
}

function packedText(raw: string): string {
  const spoken = toSpeakableText(deterministicPrepass(raw));
  return packSpeakableSections(spoken, 4000)
    .map((section) => section.text)
    .join("\n\n");
}

const prose = (sentence: string) =>
  `${sentence} The harbour stayed quiet and the crew kept the watch through the night, and the lamps along the quay burned until the tide turned and the boats swung back against their lines before morning at dawn.`;

const page = (sentence: string) => prose(sentence).repeat(8);

describe("chapter detection regressions", () => {
  it("lets a later chapter with a body replace a contents entry of the same number", () => {
    const text = [
      "Contents",
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);
    const spoken = toSpeakableText(deterministicPrepass(text));
    const packed = packSpeakableSections(spoken, 4000);
    const pier = packed.find((section) => section.text.includes("The pier was empty"));
    const storm = packed.find((section) => section.text.includes("The storm held the crew"));
    const back = packed.find((section) => section.text.includes("The return brought the boat"));
    expect(pier?.chapterTitle).toBe("Chapter 1: The Pier");
    expect(storm?.chapterTitle).toBe("Chapter 2: The Storm");
    expect(back?.chapterTitle).toBe("Chapter 3: The Return");
    expect(pier!.text.indexOf("The pier was empty")).toBeGreaterThan(
      pier!.text.lastIndexOf("Chapter 1: The Pier")
    );
  });

  it("restarts numbering on Book and Volume", () => {
    const books = [
      "BOOK I",
      "CHAPTER I",
      prose("The first book opens on the pier."),
      "CHAPTER II",
      prose("The first book continues through the storm."),
      "BOOK II",
      "CHAPTER I",
      prose("The second book opens on the return."),
      "CHAPTER II",
      prose("The second book closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(books)).toEqual([
      "Book I",
      "Chapter I",
      "Chapter Ii",
      "Book Ii",
      "Chapter I",
      "Chapter Ii",
    ]);

    const volumes = [
      "Volume One",
      "Chapter One",
      prose("Volume one begins with the pier."),
      "Chapter Two",
      prose("Volume one continues with the storm."),
      "Volume Two",
      "Chapter One",
      prose("Volume two begins with the return."),
      "Chapter Two",
      prose("Volume two closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(volumes)).toEqual([
      "Volume One",
      "Chapter One",
      "Chapter Two",
      "Volume Two",
      "Chapter One",
      "Chapter Two",
    ]);

    const bookWords = [
      "Book One",
      "Chapter 1",
      prose("Book one begins with the pier."),
      "Chapter 2",
      prose("Book one continues with the storm."),
      "Book Two",
      "Chapter 1",
      prose("Book two begins with the return."),
      "Chapter 2",
      prose("Book two closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(bookWords)).toEqual([
      "Book One",
      "Chapter 1",
      "Chapter 2",
      "Book Two",
      "Chapter 1",
      "Chapter 2",
    ]);
  });

  it("restarts numbering when a story title is followed by Chapter One", () => {
    const text = [
      "The Lighthouse Keeper",
      "Chapter One",
      page("The keeper lit the lamp above the pier."),
      "Chapter Two",
      page("The keeper watched the storm from the gallery."),
      "Salt and Iron",
      "Chapter One",
      prose("The second story opens in the foundry."),
      "Chapter Two",
      prose("The second story ends on the road home."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter One",
      "Chapter Two",
    ]);

    const caps = [
      "THE LIGHTHOUSE KEEPER",
      "CHAPTER ONE",
      page("The keeper lit the lamp above the pier."),
      "CHAPTER TWO",
      page("The keeper watched the storm from the gallery."),
      "SALT AND IRON",
      "CHAPTER ONE",
      prose("The second story opens in the foundry."),
      "CHAPTER TWO",
      prose("The second story ends on the road home."),
    ].join("\n\n");
    expect(playerChapters(caps)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter One",
      "Chapter Two",
    ]);
  });

  it("keeps titles that contain Mr. Mrs. Dr. and St.", () => {
    const text = [
      "Chapter 6. Mr. Darcy Proposes",
      prose("Mr. Darcy spoke at the pier."),
      "Chapter 7: Dr. Jekyll Returns",
      prose("Dr. Jekyll came back with the storm."),
      "Chapter 10: St. Ives",
      prose("St. Ives held the harbour at the end."),
      "CHAPTER XII. MR. COLLINS",
      prose("Mr. Collins arrived after the return."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter 6. Mr. Darcy Proposes",
      "Chapter 7: Dr. Jekyll Returns",
      "Chapter 10: St. Ives",
      "Chapter Xii. Mr. Collins",
    ]);
  });

  it("rejects intro summaries and an over-long chapter sentence", () => {
    const summary = [
      "Chapter 2, “The Storm,” describes how the crew stays together.",
      "Chapter 3, “The Return,” shows the harbour in the end.",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(playerChapters(summary)).toEqual([
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);

    const long =
      "Chapter 2: The Storm Tells How The Crew Held Together Through The Night At Sea Now.";
    expect(long.length).toBe(83);
    const titled = [
      long,
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
    ].join("\n\n");
    expect(playerChapters(titled)).toEqual(["Chapter 1: The Pier", "Chapter 2: The Storm"]);
    expect(packedText(titled)).toContain(long);
  });

  it("reads sixty through hundred and leaves an unparsable chapter line unnumbered", () => {
    const text = [
      "Chapter the Last",
      prose("A closing note sits before the numbered chapters."),
      "Chapter Fifty-Nine",
      prose("Fifty-nine opens on the pier."),
      "Chapter Sixty",
      prose("Sixty holds the crew in the storm."),
      "Chapter Sixty-One",
      prose("Sixty-one brings the boat home."),
      "Chapter Hundred",
      prose("A hundred closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter the Last",
      "Chapter Fifty-Nine",
      "Chapter Sixty",
      "Chapter Sixty-One",
      "Chapter Hundred",
    ]);
  });

  it("treats a lowercase continuation as a broken sentence and still accepts the next number", () => {
    const forward = [
      "Chapter 8",
      "of this book returns to the emperor after the duel.",
      "Chapter 1",
      prose("The escalation starts on the pier."),
      "Chapter 2",
      prose("Clausewitz and the argument continue."),
      "Chapter 3",
      prose("The duel is the subject of this chapter."),
      "Chapter 8",
      prose("The pope and the emperor close the book."),
    ].join("\n\n");
    expect(playerChapters(forward)).toEqual([
      "Chapter 8",
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 8",
    ]);

    const stray = [
      "Chapter 1",
      prose("The first chapter opens on the pier."),
      "Chapter 12",
      "is where the diagram appears in the margin of the page.",
      "Chapter 2",
      prose("The second chapter holds the storm."),
      "Chapter 3",
      prose("The third chapter brings the return."),
    ].join("\n\n");
    expect(playerChapters(stray)).toEqual([
      "Chapter 1",
      "Chapter 12",
      "Chapter 2",
      "Chapter 3",
    ]);

    const outlier = [
      "Chapter 1",
      prose("The first chapter opens on the pier."),
      "Chapter 12",
      "The diagram sits in a later appendix of this book.",
      "Chapter 2",
      prose("The second chapter holds the storm."),
      "Chapter 3",
      prose("The third chapter brings the return."),
    ].join("\n\n");
    expect(playerChapters(outlier)).toEqual([
      "Chapter 1",
      "Chapter 12",
      "Chapter 2",
      "Chapter 3",
    ]);
  });

  it("keeps Battling-style openings when the file has no page numbers", () => {
    const text = [
      "Chapter 1",
      "of the opening argument returns only as a citation in the preface.",
      "Chapter 1. The Escalation to Extremes",
      prose("The escalation starts here in the first chapter."),
      "Chapter 2. Clausewitz and Hegel",
      prose("Clausewitz and Hegel continue the argument."),
      "Chapter 3. Duel and Reciprocity",
      prose("The duel is the subject of this chapter."),
      "Chapter 4: The Duel and the Sacred",
      prose("The sacred follows the duel in this chapter."),
      "Chapter 8",
      "of this book returns to the pope and the emperor.",
      "Chapter 5. Hölderlin's Sorrow",
      prose("Sorrow is the subject of this later chapter."),
      "Chapter 6. Clausewitz and Napoleon",
      prose("Napoleon enters the argument in this chapter."),
      "Chapter 7. France and Germany",
      prose("France and Germany close the middle of the book."),
      "Chapter 8. The Pope and the Emperor",
      prose("The pope and the emperor close the book."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter 1",
      "Chapter 1. The Escalation to Extremes",
      "Chapter 2. Clausewitz and Hegel",
      "Chapter 3. Duel and Reciprocity",
      "Chapter 4: The Duel and the Sacred",
      "Chapter 8",
      "Chapter 5. Hölderlin's Sorrow",
      "Chapter 6. Clausewitz and Napoleon",
      "Chapter 7. France and Germany",
      "Chapter 8. The Pope and the Emperor",
    ]);
  });

  it("drops junk headings that are not chapter titles", () => {
    const text = [
      "30 When",
      "the tide turned the boats were still along the quay.",
      "Chapter C",
      "Chapter D",
      "Chapter M",
      "Chapter 1. The Escalation to Extremes",
      prose("The escalation starts here in the first chapter."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "30 When",
      "Chapter C",
      "Chapter D",
      "Chapter M",
      "Chapter 1. The Escalation to Extremes",
    ]);
    expect(packedText(text)).toContain("30 When");
  });
});

function spokenChapters(raw: string): { player: string[]; json: string[] } {
  const spoken = toSpeakableText(deterministicPrepass(raw));
  return {
    player: playbackChaptersFromSections(packSpeakableSections(spoken, 4000)).map(
      (chapter) => chapter.title
    ),
    json: chaptersFromHeadingLines(spoken).chapters.map((chapter) => chapter.title),
  };
}

describe("chapter candidates main keeps", () => {
  it("K3 and X1 do not let a short summary seed the numbering", () => {
    const k3 = [
      "Introduction",
      "The book opens with a note about what follows.",
      "Chapter 2: The Storm Tells How The Crew Held Together Through The Night At Sea.",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(spokenChapters(k3).player).toEqual([
      "Introduction",
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);

    const x1 = [
      "Introduction",
      "The book opens with a note about what follows.",
      "Chapter 2: The Storm tells how the crew stays together.",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(spokenChapters(x1).player).toEqual([
      "Introduction",
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);
  });

  it("X1b drops comma summaries and a closing sentence before the real chapters", () => {
    const text = [
      "Introduction",
      "A short note stands in front of the book.",
      "Chapter 3, The Return, shows the harbour.",
      "Chapter 4: The Harbour closes the book.",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
      "Chapter 4: The Harbour",
      prose("The harbour was still when the boat was tied."),
    ].join("\n\n");
    const found = spokenChapters(text);
    expect(found.player).toEqual([
      "Introduction",
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
      "Chapter 4: The Harbour",
    ]);
    expect(found.json).toEqual(found.player);
  });

  it("A5b prefers the body when a contents blurb is only a little longer than a stub", () => {
    const blurb = "In which the ferry leaves the harbour before dawn breaks.";
    expect(blurb.length).toBeGreaterThan(40);
    const text = [
      "Contents",
      "Chapter 1: The Pier",
      blurb,
      "Chapter 2: The Storm",
      "In which the crew holds the line against the weather.",
      "Chapter 3: The Return",
      "In which the boat comes back to the harbour at last.",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in.").repeat(3),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water.").repeat(3),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour.").repeat(3),
    ].join("\n\n");
    const found = spokenChapters(text);
    expect(found.player).toEqual([
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);
    expect(found.json).toEqual(found.player);
    expect(packedText(text)).toContain("The pier was empty");
  });

  it("A3 keeps lowercase titles and a subtitle on the next line", () => {
    const a3a = [1, 2, 3]
      .flatMap((n) => [
        `Chapter ${n}: in which we meet the crew`,
        prose(`Chapter ${n} meets the crew on the water.`),
      ])
      .join("\n\n");
    expect(playerChapters(a3a)).toEqual([
      "Chapter 1: in which we meet the crew",
      "Chapter 2: in which we meet the crew",
      "Chapter 3: in which we meet the crew",
    ]);

    const a3b = [1, 2, 3]
      .flatMap((n) => [`Chapter ${n}. the pier`, prose(`The pier holds chapter ${n}.`)])
      .join("\n\n");
    expect(playerChapters(a3b)).toEqual([
      "Chapter 1. the pier",
      "Chapter 2. the pier",
      "Chapter 3. the pier",
    ]);

    const a3c = [1, 2, 3]
      .flatMap((n) => [
        `CHAPTER ${n}`,
        "in which we meet the crew",
        prose(`The crew meets in chapter ${n}.`),
      ])
      .join("\n\n");
    expect(playerChapters(a3c)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
  });

  it("A2c and A2f keep a real opening whose next line starts lowercase", () => {
    const a2c = [
      "Chapter One",
      "no, she said, not yet. The boat stayed at the pier until the watch changed and the lamps were lit.",
      "Chapter Two",
      prose("The storm held the crew together on the open water."),
      "Chapter Three",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(playerChapters(a2c)).toEqual(["Chapter One", "Chapter Two", "Chapter Three"]);

    const a2f = [
      "CHAPTER 1",
      "he ferry left the pier before the watch changed and the lamps were still lit along the quay.",
      "CHAPTER 2",
      prose("The storm held the crew together on the open water."),
      "CHAPTER 3",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    const found = spokenChapters(a2f);
    expect(found.json).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    expect(found.player).toEqual(found.json);
  });

  it("A9 and X3 keep a second run of chapter numbers", () => {
    const a9c = [
      "CHAPTER I",
      prose("The first book opens on the pier."),
      "CHAPTER II",
      prose("The first book continues through the storm."),
      "BOOK THE SECOND",
      "THREAD",
      "CHAPTER I",
      prose("The second book opens on the return."),
      "CHAPTER II",
      prose("The second book closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(a9c)).toEqual([
      "Chapter I",
      "Chapter Ii",
      "Book The Second",
      "Chapter I",
      "Chapter Ii",
    ]);

    const a9d = [
      "CHAPTER I",
      prose("The first book opens on the pier."),
      "BOOK THE SECOND",
      "What the water takes, the water keeps.",
      "CHAPTER I",
      prose("The second book opens on the return."),
    ].join("\n\n");
    expect(playerChapters(a9d)).toEqual(["Chapter I", "Book The Second", "Chapter I"]);

    const x3 = [
      "Emma",
      "Chapter 1",
      page("Emma begins on the pier."),
      "Chapter 2",
      page("Emma continues through the storm."),
      "Persuasion",
      "Chapter 1",
      prose("Persuasion begins on the return."),
      "Chapter 2",
      prose("Persuasion closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(x3)).toEqual(["Chapter 1", "Chapter 2", "Chapter 1", "Chapter 2"]);

    const x3b = [
      "Emma",
      "by Jane Austen",
      "CHAPTER 1",
      page("Emma begins on the pier."),
      "CHAPTER 2",
      page("Emma continues through the storm."),
      "Persuasion",
      "by Jane Austen",
      "CHAPTER 1",
      prose("Persuasion begins on the return."),
      "CHAPTER 2",
      prose("Persuasion closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(x3b)).toEqual(["Chapter 1", "Chapter 2", "Chapter 1", "Chapter 2"]);
  });

  it("X2 reads one hundred and one hundred and one", () => {
    const text = [
      "Chapter Ninety-Nine",
      prose("Ninety-nine opens on the pier."),
      "Chapter One Hundred",
      prose("One hundred holds the crew in the storm."),
      "Chapter One Hundred and One",
      prose("One hundred and one brings the boat home."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter Ninety-Nine",
      "Chapter One Hundred",
      "Chapter One Hundred and One",
    ]);
  });

  it("X4 splits a capitalized chapter title after a sentence end", () => {
    const glued =
      "It ended there. Chapter 2 The Storm Arrives It was dark on the quay and the water kept moving under the boats while the crew waited and the lamps burned down to the wick.";
    expect(playerChapters(glued)).toContain("Chapter 2");
    const citation =
      "Preface. Chapter 3 shows that the duel continues and the sacred follows after the rain on the quay.";
    expect(playerChapters(citation)).toEqual([]);
  });

  it("A10b does not append endnote copies of a titled chapter", () => {
    const text = [
      "Chapter 1. The Escalation to Extremes",
      prose("The escalation starts here in the first chapter.").repeat(2),
      "Chapter 2. Clausewitz and Hegel",
      prose("Clausewitz and Hegel continue the argument.").repeat(2),
      "Harbour Lights",
      "CHAPTER 1. THE ESCALATION TO EXTREMES",
      "Note. The first chapter is cited again in the back matter.",
      "Harbour Lights",
      "CHAPTER 2. CLAUSEWITZ AND HEGEL",
      "Note. The second chapter is cited again in the back matter.",
    ].join("\n\n");
    expect(spokenChapters(text).player).toEqual([
      "Chapter 1. The Escalation to Extremes",
      "Chapter 2. Clausewitz and Hegel",
      "Chapter 1. The Escalation To Extremes",
      "Chapter 2. Clausewitz And Hegel",
    ]);
  });

  it("drops Battling contents entries when the body openings are longer", () => {
    const text = [
      "Battling to the End",
      "CHAPTER 1",
      "CHAPTER 2",
      "CHAPTER 3",
      "CHAPTER 1. THE ESCALATION TO EXTREMES",
      prose("The escalation starts here in the first chapter."),
      "CHAPTER 2. CLAUSEWITZ AND HEGEL",
      prose("Clausewitz and Hegel continue the argument."),
      "CHAPTER 3. DUEL AND RECIPROCITY",
      prose("The duel is the subject of this chapter."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter 1. The Escalation To Extremes",
      "Chapter 2. Clausewitz And Hegel",
      "Chapter 3. Duel And Reciprocity",
    ]);
  });
});

describe("round 3 chapter targets", () => {
  it("R2 keeps capitalized titles that mention begins, ends, shows, or stays", () => {
    const r2c = [1, 2, 3]
      .flatMap((n) => [
        `Chapter ${n}. In Which We Are Introduced to the Crew and Some Gulls, and the Stories Begin.`,
        prose(`The crew of chapter ${n} puts out from the pier.`),
      ])
      .join("\n\n");
    expect(playerChapters(r2c)).toEqual([
      "Chapter 1. In Which We Are Introduced to the Crew and Some Gulls, and the Stories Begin.",
      "Chapter 2. In Which We Are Introduced to the Crew and Some Gulls, and the Stories Begin.",
      "Chapter 3. In Which We Are Introduced to the Crew and Some Gulls, and the Stories Begin.",
    ]);

    const r2d = [
      "Chapter 1: Where the story begins",
      prose("The story begins on the pier."),
      "Chapter 2: The road ends here",
      prose("The road ends above the harbour."),
      "Chapter 3: What the tide shows",
      prose("The tide shows the mark on the wall."),
      "Chapter 4: Nobody stays",
      prose("Nobody stays once the lamp is out."),
    ].join("\n\n");
    expect(playerChapters(r2d)).toEqual([
      "Chapter 1: Where the story begins",
      "Chapter 2: The road ends here",
      "Chapter 3: What the tide shows",
      "Chapter 4: Nobody stays",
    ]);

    const r2f = [
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: What Happened to the Crew After the Storm Had Passed?",
      prose("The storm had passed and the crew was still aboard."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(playerChapters(r2f)).toEqual([
      "Chapter 1: The Pier",
      "Chapter 2: What Happened to the Crew After the Storm Had Passed?",
      "Chapter 3: The Return",
    ]);
  });

  it("R3 keeps a chapter whose next line is a capitalized title", () => {
    const around = (heading: string, next: string) =>
      [
        "Chapter 1",
        prose("The first chapter opens on the pier."),
        heading,
        next,
        prose("The chapter continues after its title."),
        "Chapter " + (heading.match(/\d+/)?.[0] === "2" ? "3" : "8"),
        prose("The last chapter closes the harbour."),
      ].join("\n\n");
    expect(playerChapters(around("Chapter 7", "Of Mice and Men"))).toEqual([
      "Chapter 1",
      "Chapter 7",
      "Chapter 8",
    ]);
    expect(
      playerChapters(
        ["Chapter 6", prose("Six."), "CHAPTER 7", "OF SHIPS AND SEALING WAX", prose("Seven."), "Chapter 8", prose("Eight.")].join("\n\n")
      )
    ).toEqual(["Chapter 6", "Chapter 7", "Chapter 8"]);
    expect(
      playerChapters(
        ["Chapter 2", prose("Two."), "Chapter 3", "Is It Over?", prose("Three."), "Chapter 4", prose("Four.")].join("\n\n")
      )
    ).toEqual(["Chapter 2", "Chapter 3", "Chapter 4"]);
    expect(
      playerChapters(
        ["Chapter 1", prose("One."), "Chapter 2", "Are We There Yet", prose("Two."), "Chapter 3", prose("Three.")].join("\n\n")
      )
    ).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    expect(
      playerChapters(
        [
          "Chapter 1",
          "Was it the wind or the sea that kept the crew awake on the water.",
          "Chapter 2",
          prose("The second chapter holds the storm."),
          "Chapter 3",
          prose("The third chapter brings the return."),
        ].join("\n\n")
      )
    ).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
  });

  it("R1 keeps a short real chapter when a later copy sits in another book or in the back matter", () => {
    const r1a = [
      "First Light",
      "Chapter 1",
      "They came at dawn.",
      "Chapter 2",
      page("The second chapter of the first novel crosses the harbour."),
      "Chapter 3",
      page("The third chapter of the first novel closes that book."),
      "Second Light",
      "Chapter 1",
      page("The second novel opens on the return."),
      "Chapter 2",
      page("The second novel ends on the road."),
    ].join("\n\n");
    expect(playerChapters(r1a)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 1", "Chapter 2"]);

    const r1b = [
      "Chapter 1",
      prose("One."),
      "Chapter 2",
      prose("Two."),
      "Chapter 3",
      prose("Three."),
      "Chapter 4",
      prose("Four."),
      "Chapter 5",
      "The calm settled over the harbour for one full paragraph and then held.",
      "Chapter 6",
      prose("Six."),
      "Appendix",
      "The appendix collects the later notes.",
      "Chapter 5: Further Notes on the Calm",
      prose("The notes go on at some length about the calm."),
    ].join("\n\n");
    expect(playerChapters(r1b)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 4",
      "Chapter 5",
      "Chapter 6",
      "Appendix",
      "Chapter 5: Further Notes on the Calm",
    ]);

    const r1c = [
      "Chapter 5: The Calm",
      "The calm settled over the harbour for one full paragraph and then held.",
      "Notes",
      "The notes follow the chapter.",
      "Chapter 5",
      prose("A note repeats the number without the title."),
    ].join("\n\n");
    expect(playerChapters(r1c)).toEqual(["Chapter 5: The Calm", "Notes", "Chapter 5"]);

    const r1e = [
      "Chapter 1",
      prose("One."),
      "Chapter 2",
      prose("Two."),
      "Chapter 3",
      "A short one.",
      "Chapter 4",
      prose("Four."),
      "Chapter 5",
      prose("Five."),
      "Bonus",
      "A later printing adds one more scene.",
      "Chapter 3",
      page("The bonus chapter repeats the number with a long body."),
    ].join("\n\n");
    expect(playerChapters(r1e)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 4",
      "Chapter 5",
      "Chapter 3",
    ]);
  });

  it("PG1 keeps one chapter when the running head repeats beside page numbers", () => {
    const chunks = [1, 2, 3, 4].flatMap((pageNo) => [
      "Chapter 1",
      String(pageNo),
      prose("The first chapter continues across the page."),
    ]);
    const text = [
      ...chunks,
      "Chapter 2",
      prose("The second chapter holds the storm."),
      "Chapter 3",
      prose("The third chapter brings the return."),
      "Chapter 4",
      prose("The fourth chapter waits at the quay."),
      "Chapter 5",
      prose("The fifth chapter closes the book."),
    ].join("\n\n");
    const found = spokenChapters(text);
    expect(found.player).toEqual([
      "Chapter 1",
      "Chapter 1",
      "Chapter 1",
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 4",
      "Chapter 5",
    ]);
    expect(found.json).toEqual(found.player);
  });

  it("drops Battling contents stubs, endnote copies, and index numbers", () => {
    const titles = [
      "Chapter 1. The Escalation to Extremes",
      "Chapter 2. Clausewitz and Hegel",
      "Chapter 3. Duel and Reciprocity",
      "Chapter 4. The Duel and the Sacred",
      "Chapter 5. Holderlin's Sorrow",
      "Chapter 6. Clausewitz and Napoleon",
      "Chapter 7. France and Germany",
      "Chapter 8. The Pope and the Emperor",
    ];
    const text = [
      "Introduction",
      "Epilogue",
      "Notes",
      "Introduction",
      ...titles.map((title) => title.replace(/:.*/, "").replace(/\..*/, "")),
      "Introduction",
      prose("The introduction sets the terms of the argument."),
      ...titles.flatMap((title) => [title, prose("The chapter argues its case in full.")]),
      "Epilogue",
      prose("The epilogue closes the argument."),
      "Notes",
      prose("The notes list the sources."),
      ...titles.flatMap((title) => [title.toUpperCase(), "A short endnote."]),
      "Index",
      "Chapter I",
      "Chapter V",
    ].join("\n\n");
    expect(spokenChapters(text).player).toEqual([
      "Introduction",
      ...titles,
      "Epilogue",
      "Notes",
    ]);
  });
});

describe("conservative chapter filter", () => {
  it("N1 keeps a short chapter in place when a later line cites the same number", () => {
    const text = [
      "Chapter 11",
      prose("Eleven opens on the pier."),
      "Chapter 12",
      "Silence.",
      "Chapter 13",
      prose("Thirteen holds the storm."),
      "Chapter 14",
      prose("Fourteen brings the return."),
      "Chapter 12",
      prose("A later note cites the twelfth chapter again."),
      "Chapter 15",
      prose("Fifteen closes the book."),
    ].join("\n\n");
    expect(spokenChapters(text).player).toEqual([
      "Chapter 11",
      "Chapter 12",
      "Chapter 13",
      "Chapter 14",
      "Chapter 12",
      "Chapter 15",
    ]);
    expect(spokenChapters(text).json).toEqual(spokenChapters(text).player);
  });

  it("N3 and N13 do not replace a short chapter with a later copy", () => {
    const n3 = [
      "Chapter 1",
      prose("One."),
      "Chapter 2",
      "A short one.",
      "Chapter 3",
      prose("Three."),
      "Chapter 2",
      prose("A later chapter repeats the number."),
    ].join("\n\n");
    expect(spokenChapters(n3).player).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 2",
    ]);

    const n13 = [
      "Chapter 4",
      "Still.",
      "Chapter 5",
      prose("Five."),
      "Chapter 6",
      prose("Six."),
      "Chapter 4",
      prose("Four is cited again after the short opening."),
    ].join("\n\n");
    expect(spokenChapters(n13).player).toEqual([
      "Chapter 4",
      "Chapter 5",
      "Chapter 6",
      "Chapter 4",
    ]);
  });

  it("N2 N5 N7b and N8 keep a second number run without a title and under a page", () => {
    const second = (lead: string[]) =>
      [
        ...lead,
        "Chapter 1",
        prose("The first run opens on the pier."),
        "Chapter 2",
        prose("The first run holds the storm."),
        "Chapter 1",
        prose("The second run opens on the return."),
        "Chapter 2",
        prose("The second run closes the harbour."),
      ].join("\n\n");
    const expected = ["Chapter 1", "Chapter 2", "Chapter 1", "Chapter 2"];
    expect(spokenChapters(second([])).player).toEqual(expected);
    expect(spokenChapters(second(["A note."])).player).toEqual(expected);
    expect(playerChapters(second(["Part Two"]))).toEqual(["Part Two", ...expected]);
    expect(spokenChapters(second(["Book Two"])).player).toEqual(["Book Two", ...expected]);
  });

  it("N6 and N6b drop contents blurbs of about 130 characters and keep the body", () => {
    const blurb =
      "A two-line note on how the ferry leaves the harbour before dawn and what the crew sees from the deck.";
    expect(blurb.length).toBeGreaterThan(80);
    expect(blurb.length).toBeLessThan(200);
    const text = [
      "Contents",
      "Chapter 1: The Pier",
      blurb,
      "Chapter 2: The Storm",
      blurb,
      "Chapter 3: The Return",
      blurb,
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    const found = spokenChapters(text);
    expect(found.player).toEqual([
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);
    expect(found.json).toEqual(found.player);
    expect(packedText(text)).toContain("The pier was empty");
  });

  it("N10 and N10b keep a chapter whose next line is a lowercase title", () => {
    const n10 = [
      "Chapter 1",
      prose("The first chapter opens on the pier."),
      "Chapter 2",
      "of kings and cabbages",
      prose("The second chapter holds the storm."),
      "Chapter 3",
      prose("The third chapter brings the return."),
    ].join("\n\n");
    expect(spokenChapters(n10).player).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);

    const n10b = [
      "Chapter 4",
      prose("Four."),
      "Chapter 5",
      "of mice and men",
      prose("Five."),
      "Chapter 6",
      prose("Six."),
    ].join("\n\n");
    expect(spokenChapters(n10b).player).toEqual(["Chapter 4", "Chapter 5", "Chapter 6"]);
  });

  it("N11 keeps chapters that follow a mid-book Notes heading", () => {
    const after = (bridge: string[]) =>
      [
        "Chapter 1",
        prose("The first part opens on the pier."),
        "Chapter 2",
        prose("The first part holds the storm."),
        "Notes",
        prose("The notes sit between the two parts."),
        ...bridge,
        "Chapter 1",
        prose("The second part opens on the return."),
        "Chapter 2",
        prose("The second part closes the harbour."),
      ].join("\n\n");
    expect(spokenChapters(after(["Part Two"])).player).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Notes",
      "Part Two",
      "Chapter 1",
      "Chapter 2",
    ]);
    expect(spokenChapters(after(["Book Two"])).player).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Notes",
      "Book Two",
      "Chapter 1",
      "Chapter 2",
    ]);
    expect(spokenChapters(after(["The Second Story"])).player).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Notes",
      "Chapter 1",
      "Chapter 2",
    ]);
  });

  it("N12 leaves an unnumbered Part sentence out of chapters.json", () => {
    const line =
      "Part of the reason she stayed was the lamp on the quay and the long watch after dark.";
    expect(line.length).toBeGreaterThan(80);
    expect(line.length).toBeLessThan(120);
    const text = ["Chapter 1", prose("The pier was empty."), line, "Chapter 2", prose("The storm held.")].join(
      "\n\n"
    );
    const found = spokenChapters(text);
    expect(found.json).toEqual(["Chapter 1", "Chapter 2"]);
    expect(found.player).toEqual(found.json);
    expect(found.json.join("\n")).not.toContain("Part of the reason");
  });

  it("keeps every real-body heading in player and chapters.json in the same order", () => {
    const books = [
      [
        "Chapter 1",
        prose("One."),
        "Chapter 2",
        prose("Two."),
      ].join("\n\n"),
      [
        "Notes",
        prose("Notes."),
        "Part Two",
        "Chapter 1",
        prose("Again."),
      ].join("\n\n"),
    ];
    for (const book of books) {
      const found = spokenChapters(book);
      const real = found.json.filter((title) => title.length <= 80);
      for (const title of real) {
        expect(found.player).toContain(title);
      }
      const playerOrder = found.player.filter((title) => real.includes(title));
      expect(playerOrder).toEqual(real);
    }
  });
});

describe("round 5 chapter restarts", () => {
  const roman = ["I", "II", "III", "IV", "V"];

  it("keeps a War and Peace style restart of Chapter I under each book", () => {
    const books = ["One", "Two", "Three", "Four"].flatMap((book) => [
      `Book ${book}: 1805`,
      ...roman.flatMap((n) => [`Chapter ${n}`, prose(`Book ${book} chapter ${n}.`)]),
    ]);
    const text = [
      ...books,
      "Epilogue",
      prose("The first epilogue closes the campaigns."),
      "Epilogue",
      prose("The second epilogue closes the book."),
    ].join("\n\n");
    const found = spokenChapters(text);
    const chapters = found.player.filter((title) => /^Chapter /.test(title));
    expect(chapters).toHaveLength(20);
    expect(found.player.filter((title) => title === "Epilogue")).toHaveLength(2);
    expect(found.player.some((title) => /^Book /.test(title))).toBe(true);
    expect(found.json.filter((title) => /^Chapter /.test(title))).toHaveLength(20);
  });

  it("F3 keeps a second run of bare chapter labels in a new book or story", () => {
    const f3a = [1, 2, 3, 4, 5].flatMap((book) => [
      `Book ${book}`,
      ...["I", "II", "III"].flatMap((n) => [`CHAPTER ${n}`, prose(`Book ${book} ${n}.`)]),
    ]);
    expect(spokenChapters(f3a.join("\n\n")).player.filter((t) => /^Chapter /.test(t))).toHaveLength(15);

    const f3b = [
      "Part One",
      "Chapter 1",
      prose("Part one opens."),
      "Chapter 2",
      prose("Part one continues."),
      "12",
      "Part Two",
      "Chapter 1",
      prose("Part two opens."),
      "Chapter 2",
      prose("Part two closes."),
    ].join("\n\n");
    const partTwo = spokenChapters(f3b);
    expect(partTwo.player.filter((t) => t === "Chapter 1")).toHaveLength(2);
    expect(partTwo.json).toEqual(partTwo.player);

    const f3d = [1, 2, 3, 4].flatMap((story) => [
      `Story ${story}`,
      "Chapter 1",
      prose(`Story ${story} opens.`),
      "Chapter 2",
      prose(`Story ${story} closes.`),
    ]);
    expect(spokenChapters(f3d.join("\n\n")).player.filter((t) => t === "Chapter 1")).toHaveLength(4);
  });

  it("F5 and N11f leave the index once a real chapter follows it", () => {
    const f5d = [
      "Contents",
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Index",
      "Chapter 1",
      prose("The first chapter opens on the pier."),
      "Chapter 2",
      prose("The second chapter holds the storm."),
      "Chapter 3",
      prose("The third chapter brings the return."),
    ].join("\n\n");
    expect(spokenChapters(f5d).player).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);

    const f5f = ["Index", "Chapter 1", prose("The only chapter."), "Chapter 2", prose("The next.")].join("\n\n");
    expect(spokenChapters(f5f).player).toEqual(["Chapter 1", "Chapter 2"]);

    const f5b = ["INDEX", "Chapter 1", prose("One."), "Chapter 2", prose("Two."), "Chapter 3", prose("Three.")].join(
      "\n\n"
    );
    const front = spokenChapters(f5b);
    expect(front.json).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    expect(front.player).toEqual(front.json);

    const note = "x".repeat(613);
    const n11f = ["Chapter 1", prose("One."), "Index", "Chapter 2", note, "Chapter 3", prose("Three.")].join("\n\n");
    expect(spokenChapters(n11f).player).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
  });

  it("F1 keeps short chapters in an earlier part and does not drop a shared title", () => {
    const poems = [
      "Part One",
      "Chapter 1",
      "A short poem.",
      "Chapter 2",
      "A short letter.",
      "Chapter 3",
      "A short song.",
      "Part Two",
      "Chapter 1",
      prose("The second part opens."),
      "Chapter 2",
      prose("The second part closes."),
    ].join("\n\n");
    expect(spokenChapters(poems).player).toEqual([
      "Part One",
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Part Two",
      "Chapter 1",
      "Chapter 2",
    ]);

    const morning = [
      "Chapter 1. Morning",
      "A short opening.",
      "Chapter 2. The Storm",
      prose("The storm."),
      "Chapter 3. Morning",
      prose("Another morning after the return."),
    ].join("\n\n");
    expect(spokenChapters(morning).player).toEqual([
      "Chapter 1. Morning",
      "Chapter 2. The Storm",
      "Chapter 3. Morning",
    ]);
  });

  it("F2 keeps a real chapter after Notes when the title matches", () => {
    const f2a = [
      "Chapter 1. The Pier",
      prose("The pier was empty."),
      "Notes",
      "Chapter 1. The Pier",
      prose("The note is itself a full chapter."),
    ].join("\n\n");
    expect(spokenChapters(f2a).player.filter((t) => t.startsWith("Chapter 1"))).toHaveLength(2);

    const f2c = [
      "Chapter 2. The Storm",
      prose("The storm held."),
      "References",
      "Chapter 2. The Storm",
      prose("The reference chapter is long enough to read."),
    ].join("\n\n");
    expect(spokenChapters(f2c).player.filter((t) => t.startsWith("Chapter 2"))).toHaveLength(2);
  });

  it("F4 keeps a first chapter whose title reads like a sentence", () => {
    const f4a = ["Chapter 1. The voyage begins", prose("The voyage leaves the pier.")].join("\n\n");
    expect(spokenChapters(f4a).player).toEqual(["Chapter 1. The voyage begins"]);

    const f4b = [
      "Chapter 1. In Which We Are Introduced to Winnie-the-Pooh and Some Bees, and the Stories Begin",
      prose("The stories begin in the wood."),
    ].join("\n\n");
    expect(spokenChapters(f4b).player[0]).toMatch(/Winnie-the-Pooh/);
  });

  it("lists chapters past 999 in both the player and chapters.json", () => {
    const text = ["Chapter 999", prose("Nine."), "Chapter 1000", prose("Thousand."), "Chapter 2000", prose("Two thousand.")].join(
      "\n\n"
    );
    const found = spokenChapters(text);
    expect(found.player).toEqual(["Chapter 999", "Chapter 1000", "Chapter 2000"]);
    expect(found.json).toEqual(found.player);
  });

  it("does not read an alphabetical index as roman chapters", () => {
    const text = [
      "Chapter 1",
      prose("The book itself."),
      "Index",
      ..."ABCDFGHILMV".split("").flatMap((letter) => [letter, "A name in the index."]),
    ].join("\n\n");
    const found = spokenChapters(text);
    expect(found.player).toEqual(["Chapter 1"]);
    expect(found.json).toEqual(["Chapter 1"]);
  });

  it("Battling keeps the introduction, eight chapters, and the epilogue", () => {
    const titles = [
      "Chapter 1. The Escalation to Extremes",
      "Chapter 2. Clausewitz and Hegel",
      "Chapter 3. Duel and Reciprocity",
      "Chapter 4. The Duel and the Sacred",
      "Chapter 5. Holderlin's Sorrow",
      "Chapter 6. Clausewitz and Napoleon",
      "Chapter 7. France and Germany",
      "Chapter 8. The Pope and the Emperor",
    ];
    const text = [
      "Introduction",
      "Epilogue",
      "Notes",
      "The translator's note explains the terms used later in the book.",
      "Introduction",
      prose("The introduction sets the terms of the argument."),
      ...titles.flatMap((title) => [title, prose("The chapter argues its case in full.")]),
      "Epilogue",
      prose("The epilogue closes the argument."),
      "Notes",
      ...titles.flatMap((title) => [title.toUpperCase(), "A short endnote."]),
      "Index",
      ..."CDILMV".split(""),
    ].join("\n\n");
    const found = spokenChapters(text);
    expect(found.player.filter((title) => title.startsWith("Chapter"))).toEqual(titles);
    expect(found.player[0]).toBe("Introduction");
    expect(found.player).toContain("Epilogue");
    expect(found.json.filter((title) => title === "Epilogue")).toEqual(["Epilogue"]);
    expect(found.json.some((title) => /^[CDILMV]$/.test(title) || /^Chapter [CDILMV]$/.test(title))).toBe(false);
  });
});
