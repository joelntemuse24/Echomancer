import { describe, expect, it } from "vitest";
import { userFriendlyError } from "./errors-ui";
import { CLONE_SAMPLE_QUALITY_COPY } from "./tts/clone-sample-quality";

describe("userFriendlyError", () => {
  it("hides a leftover Google TTS config error behind the generic outage", () => {
    expect(
      userFriendlyError(
        "GOOGLE_TTS_API_KEY or GOOGLE_TTS_ACCESS_TOKEN is not configured"
      )
    ).toMatch(/unavailable/i);
  });

  it("hides the mammoth Word-file error behind a document message", () => {
    const friendly = "Couldn't read this Word file. Try PDF or paste.";
    expect(userFriendlyError("Could not find file in options")).toBe(friendly);
    expect(userFriendlyError("Error: Could not find file in options")).toBe(
      friendly
    );
    expect(friendly).not.toMatch(/could not find file in options/i);
  });

  it("passes clone quality fail copy through without rewriting or truncating", () => {
    const raw = `${CLONE_SAMPLE_QUALITY_COPY.failHeadline} ${CLONE_SAMPLE_QUALITY_COPY.failPrimary}`;
    expect(userFriendlyError(raw)).toBe(raw);
    const legacy =
      "This sample isn't good enough to clone well. Please re-record a fresh sample (don't try to 'fix' this one with cleaners). Record in a quieter room.";
    expect(legacy.length).toBeGreaterThan(120);
    expect(userFriendlyError(legacy)).toBe(legacy);
  });
});
