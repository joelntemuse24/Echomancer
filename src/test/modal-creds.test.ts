import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("modal credentials", () => {
  it("strips live Modal auth before a test can shell out", () => {
    expect(process.env.MODAL_TOKEN_ID).toBeUndefined();
    expect(process.env.MODAL_TOKEN_SECRET).toBeUndefined();
    expect(process.env.MODAL_PROFILE).toBeUndefined();
    const config = process.env.MODAL_CONFIG_PATH;
    expect(config).toBeTruthy();
    expect(readFileSync(config!, "utf8")).toBe("");
  });
});