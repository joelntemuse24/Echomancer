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

  it("shows a missing-section failure instead of a rate-limit warning", () => {
    // Job 4f8df6f0, status failed, one section missing. The player renders
    // error_message through this function. Both sentences contain "rate"
    // inside "narrated" / "generate", which is not a 429.
    const error =
      "1 of 19 sections could not be narrated. Only 18 sections of this book exist, so it is not a complete audiobook. Retry to generate the rest.";
    const warning =
      "1 section could not be narrated; the rest of the book is ready.";
    expect(error.length).toBeGreaterThan(120);
    expect(userFriendlyError(error)).toBe(error);
    expect(userFriendlyError(warning)).toBe(warning);
    expect(userFriendlyError(error)).not.toMatch(/too fast/i);
    expect(userFriendlyError("Retry to generate the rest.")).toBe(
      "Retry to generate the rest."
    );
  });

  it("still maps a real rate limit or 429 to the wait message", () => {
    expect(userFriendlyError("Too many requests. Wait a minute.")).toBe(
      "Too fast. Wait a minute."
    );
    expect(userFriendlyError("HTTP 429 from the container")).toBe(
      "Too fast. Wait a minute."
    );
    expect(userFriendlyError("rate limit exceeded")).toBe(
      "Too fast. Wait a minute."
    );
    expect(userFriendlyError("upstream RATE_LIMIT")).toBe(
      "Too fast. Wait a minute."
    );
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
