import { describe, expect, it } from "vitest";
import { detailFailureIsFinal } from "./detail-failure";

describe("player detail failure", () => {
  it("clears a seeded row on 401, 403, and 404", () => {
    expect(detailFailureIsFinal(401)).toBe(true);
    expect(detailFailureIsFinal(403)).toBe(true);
    expect(detailFailureIsFinal(404)).toBe(true);
    expect(detailFailureIsFinal(500)).toBe(false);
    expect(detailFailureIsFinal(503)).toBe(false);
    expect(detailFailureIsFinal(null)).toBe(false);
  });
});
