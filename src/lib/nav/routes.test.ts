import { describe, expect, it } from "vitest";
import { CREATE_HREF, DASHBOARD_NAV, LIBRARY_HREF, PREFETCH_SCREEN, VOICES_HREF } from "./routes";

describe("app nav routes", () => {
  it("sends new audiobook to home and keeps that route out of the interior nav", () => {
    expect(CREATE_HREF).toBe("/");
    expect(DASHBOARD_NAV.map((item) => item.href)).toEqual([VOICES_HREF, LIBRARY_HREF]);
    expect(DASHBOARD_NAV.some((item) => item.href === CREATE_HREF)).toBe(false);
    expect(PREFETCH_SCREEN).toBe(true);
  });
});
