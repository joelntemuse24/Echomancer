import { describe, expect, it } from "vitest";
import { youtubeEmbedPlayerVars } from "./embed";

describe("youtube embed", () => {
  it("asks the preview player for 720p", () => {
    expect(youtubeEmbedPlayerVars("https://echomancer.xyz").vq).toBe("hd720");
  });
});
