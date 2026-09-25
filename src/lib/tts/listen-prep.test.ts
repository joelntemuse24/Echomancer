import { describe, expect, it } from "vitest";
import {
  LISTEN_PREP_MAX_DROP_SHARE,
  acceptListenOps,
  applyListenOps,
  lineSpans,
  prepareForListening,
  splitListenChunks,
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

describe("prepareForListening", () => {
  it("leaves a chunk unchanged when the reply is not json", async () => {
    const next = await prepareForListening(FIXTURE, {
      apiKey: "test",
      fetch: async () => new Response("nope", { status: 200 }),
    });
    expect(next.text).toBe(FIXTURE);
    expect(next.failOpenChunks).toBe(1);
    expect(next.droppedLines).toBe(0);
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

  it("splits a long book into chunks instead of a front sample", () => {
    const book = `${"She walked to the quay.\n".repeat(2000)}END_OF_BOOK`;
    const chunks = splitListenChunks(book);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(book);
    expect(chunks[chunks.length - 1]).toContain("END_OF_BOOK");
  });
});
