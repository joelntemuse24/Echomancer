import { describe, expect, it } from "vitest";
import {
  applyListenPrep,
  coerceListenPrepPlan,
  listenPrepFront,
  prepareForListening,
} from "./listen-prep";

const FRONT = [
  "The Harbor",
  "",
  "Copyright © 2014 Example Press. All rights reserved.",
  "",
  "ISBN 978-0-000-00000-0",
  "",
  "Foreword",
  "",
  "A short note from the editor, kept for the listener.",
  "",
  "Introduction The harbor was quiet after the rain.",
  "",
  "Chapter One",
  "",
  "She closed the ledger.",
].join("\n");

describe("applyListenPrep", () => {
  it("drops copyright lines, keeps a foreword, and speaks Introduction alone", () => {
    const next = applyListenPrep(FRONT, {
      drop: ["Copyright © 2014 Example Press. All rights reserved.", "ISBN 978-0-000-00000-0"],
      headings: ["Introduction"],
    });
    expect(next).not.toMatch(/Copyright/);
    expect(next).not.toMatch(/ISBN/);
    expect(next).toMatch(/Foreword/);
    expect(next).toMatch(/A short note from the editor/);
    expect(next).toMatch(/Introduction\n\nThe harbor was quiet/);
    expect(next).toMatch(/Chapter One/);
    expect(next).toMatch(/She closed the ledger/);
  });

  it("does not drop a phrase the front does not contain", () => {
    const plan = coerceListenPrepPlan(
      { drop: ["This sentence was invented"], headings: [] },
      FRONT
    );
    expect(plan.drop).toEqual([]);
  });

  it("cuts the model input at the first chapter", () => {
    const front = listenPrepFront(`${FRONT}\n\n${"Later prose. ".repeat(800)}`);
    expect(front).toMatch(/Chapter One/);
    expect(front).not.toMatch(/Later prose/);
  });
});

describe("prepareForListening", () => {
  it("returns the original text when the call fails", async () => {
    const next = await prepareForListening(FRONT, {
      title: "The Harbor",
      apiKey: "test",
      fetch: async () => new Response("no", { status: 500 }),
    });
    expect(next).toBe(FRONT);
  });
});
