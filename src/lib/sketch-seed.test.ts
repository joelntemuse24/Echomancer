import { describe, expect, it } from "vitest";
import { sketchSeed } from "./sketch-seed";

describe("sketchSeed", () => {
  it("is stable for the same key and changes with salt", () => {
    expect(sketchSeed("landing-create")).toBe(sketchSeed("landing-create"));
    expect(sketchSeed("landing-create")).not.toBe(sketchSeed("landing-library"));
    expect(sketchSeed("nav", 1)).not.toBe(sketchSeed("nav", 2));
  });
});
