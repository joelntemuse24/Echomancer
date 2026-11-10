import { describe, expect, it } from "vitest";
import { playerIdFromPathname } from "./player-path";

describe("player id from the pathname", () => {
  it("reads the book id and ignores a deeper path", () => {
    expect(playerIdFromPathname("/dashboard/player/job-a")).toBe("job-a");
    expect(
      playerIdFromPathname("/dashboard/player/job%20a")
    ).toBe("job a");
    expect(playerIdFromPathname("/dashboard/player/job-a/markup")).toBe("");
    expect(playerIdFromPathname("/dashboard/queue")).toBe("");
    expect(playerIdFromPathname(null)).toBe("");
  });
});
