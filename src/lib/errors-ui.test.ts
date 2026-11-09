import { describe, expect, it } from "vitest";
import {
  customerBookStatus,
  incompleteAudiobookMessage,
  userFriendlyError,
} from "./errors-ui";
import { MODAL_WORKSPACE_DISABLED_MESSAGE } from "./modal/workspace-disabled";
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

  it("states one section count and hides infra wording", () => {
    // Job 4f8df6f0 stored both the hole and the remainder. The library
    // shows one count. A ready badge does not also say the book failed.
    const error =
      "1 of 19 sections could not be narrated. Only 18 sections of this book exist, so it is not a complete audiobook. Retry to generate the rest.";
    const warning =
      "1 section could not be narrated; the rest of the book is ready.";
    const shown = userFriendlyError(error);
    expect(error.length).toBeGreaterThan(120);
    expect(shown).toBe(incompleteAudiobookMessage(18, 19));
    expect(shown).not.toMatch(/1 of 19/);
    expect(shown).not.toMatch(/Only 18/);
    expect(shown).not.toMatch(/\bModal\b/);
    expect(shown).not.toMatch(/Section\s+0:/i);
    expect(shown).not.toMatch(/too fast/i);
    expect(userFriendlyError("Section 0: Modal clone already retried")).toBe(
      "This voice couldn't finish the book. Try again."
    );
    expect(userFriendlyError("Modal clone already retried")).not.toMatch(
      /\bModal\b|Section\s+\d+:/i
    );
    expect(customerBookStatus(warning, "ready")).toBeNull();
    expect(customerBookStatus(error, "failed")).toBe(shown);
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

  it("shows the workspace-disabled stop instead of a generic failure", () => {
    expect(MODAL_WORKSPACE_DISABLED_MESSAGE.length).toBeGreaterThan(120);
    expect(userFriendlyError(MODAL_WORKSPACE_DISABLED_MESSAGE)).toBe(
      MODAL_WORKSPACE_DISABLED_MESSAGE
    );
    expect(userFriendlyError(MODAL_WORKSPACE_DISABLED_MESSAGE)).not.toMatch(/payment/i);
    expect(userFriendlyError(MODAL_WORKSPACE_DISABLED_MESSAGE)).not.toMatch(/\$/);
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
