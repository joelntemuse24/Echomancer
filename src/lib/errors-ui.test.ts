import { describe, expect, it } from "vitest";
import { userFriendlyError } from "./errors-ui";
import { CLONE_SAMPLE_QUALITY_COPY } from "./tts/clone-sample-quality";

describe("userFriendlyError", () => {
  it("tells the user Randolph needs a Google TTS key instead of a generic outage", () => {
    expect(
      userFriendlyError(
        "GOOGLE_TTS_API_KEY or GOOGLE_TTS_ACCESS_TOKEN is not configured"
      )
    ).toMatch(/Randolph needs Google Cloud TTS/i);
  });

  it("passes clone quality fail copy through without rewriting or truncating", () => {
    const raw = `${CLONE_SAMPLE_QUALITY_COPY.failHeadline} ${CLONE_SAMPLE_QUALITY_COPY.failPrimary}`;
    expect(userFriendlyError(raw)).toBe(raw);
    expect(raw.length).toBeGreaterThan(120);
  });
});
