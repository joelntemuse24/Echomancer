import { describe, expect, it } from "vitest";
import { duplicateCloneDateLabel } from "./clone-list-label";

const created = Date.UTC(2026, 10, 9) / 1000;

describe("duplicateCloneDateLabel", () => {
  it("shows the date only when two clones share a name", () => {
    const voices = [
      { id: "clone:a", displayName: "Victor Davis Hanson", createdAt: created },
      { id: "clone:b", displayName: "Victor Davis Hanson", createdAt: created + 86_400 },
      { id: "clone:c", displayName: "Sowell", createdAt: created },
    ];
    expect(duplicateCloneDateLabel(voices, voices[0]!)).toBe("Nov 9, 2026");
    expect(duplicateCloneDateLabel(voices, voices[2]!)).toBeNull();
  });
});
