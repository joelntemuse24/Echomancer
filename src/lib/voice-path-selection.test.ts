import { describe, expect, it } from "vitest";
import { voiceIdAfterPathChange } from "./voice-path-selection";

describe("voiceIdAfterPathChange", () => {
  it("does not replace the stock voice with the first clone", () => {
    expect(
      voiceIdAfterPathChange({
        path: "clone",
        selectedId: "sowell",
        pathIds: ["clone:vdh", "clone:other"],
      })
    ).toBe("sowell");
  });

  it("keeps a clone the listener already chose", () => {
    expect(
      voiceIdAfterPathChange({
        path: "clone",
        selectedId: "clone:other",
        pathIds: ["clone:vdh", "clone:other"],
      })
    ).toBe("clone:other");
  });

  it("does not invent a selection when nothing is selected", () => {
    expect(
      voiceIdAfterPathChange({
        path: "clone",
        selectedId: null,
        pathIds: ["clone:vdh"],
      })
    ).toBeNull();
  });

  it("moves to the first stock voice when a clone is showing and the path is standard", () => {
    expect(
      voiceIdAfterPathChange({
        path: "standard",
        selectedId: "clone:vdh",
        pathIds: ["standard", "sowell"],
      })
    ).toBe("standard");
  });
});
