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

  it("keeps extract-not-ready copy calm instead of asking for a re-upload", () => {
    expect(
      userFriendlyError("The text is still being prepared. Try again in a moment.")
    ).toMatch(/still being prepared/i);
  });

  it("hides the mammoth Word-file error behind a document message", () => {
    const friendly = "Couldn't read this Word document. Try PDF or paste the text.";
    expect(userFriendlyError("Could not find file in options")).toBe(friendly);
    expect(userFriendlyError("Error: Could not find file in options")).toBe(
      friendly
    );
    expect(friendly).not.toMatch(/could not find file in options/i);
  });

  it("does not leak Live Stream / Live Listen wording", () => {
    expect(userFriendlyError("Live stream failed")).toBe(
      "Couldn't play that just now. Please try again."
    );
    expect(userFriendlyError("Live listen timed out")).not.toMatch(
      /Live Stream|Live Listen/i
    );
  });

  it("passes clone quality fail copy through without rewriting or truncating", () => {
    const raw = `${CLONE_SAMPLE_QUALITY_COPY.failHeadline} ${CLONE_SAMPLE_QUALITY_COPY.failPrimary}`;
    expect(userFriendlyError(raw)).toBe(raw);
    expect(raw.length).toBeGreaterThan(120);
  });
});
