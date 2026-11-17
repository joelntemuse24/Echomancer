import { describe, expect, it } from "vitest";
import { libraryStatus, NAV, playerStatusLine, VOICE_PATH, voiceEngineStarting, WAIT } from "./ux-copy";

describe("voiceEngineStarting", () => {
  it("is the clone book before the first section", () => {
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "processing",
        progress: 0,
      } as never)
    ).toBe(true);
  });

  it("is not extract, a stock voice, or a book that already has audio", () => {
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "waiting",
        waiting_for_text: true,
      })
    ).toBe(false);
    expect(
      voiceEngineStarting({
        catalog_voice_id: "standard",
        status: "processing",
      })
    ).toBe(false);
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "processing",
        first_section_at: 1,
      })
    ).toBe(false);
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "queued",
        segments: [{ path: "audiobooks/j/sections/0000.mp3", status: "ready" }],
      })
    ).toBe(false);
  });
});

describe("playerStatusLine", () => {
  it("uses the clone engine line on the main player and in focus", () => {
    const job = { catalog_voice_id: "clone:abc", status: "processing" };
    const line = playerStatusLine(job, "0 of 24 · 0% · Estimating…");
    expect(line).toBe(WAIT.startingEngine[0]);
    expect(line).toBe("Starting the clone voice…");
  });

  it("uses the narration line once the clone has a section, and for a stopped book", () => {
    expect(
      playerStatusLine(
        { catalog_voice_id: "clone:abc", status: "processing", first_section_at: 1 },
        "1 of 20 · 5% · under a minute left"
      )
    ).toBe("1 of 20 · 5% · under a minute left");
    expect(
      playerStatusLine({ catalog_voice_id: "drew", status: "cancelled" }, "Stopped")
    ).toBe("Stopped");
  });
});

describe("voice and new-book labels", () => {
  it("marks a clone and names the header plus", () => {
    expect(VOICE_PATH.cloneMark).toBe("Your clone");
    expect(NAV.newBook).toBe("New book");
  });
});

describe("libraryStatus", () => {
  it("says Stopped for a book the listener stopped", () => {
    expect(libraryStatus({ status: "cancelled" })).toEqual({
      id: "cancelled",
      label: "Stopped",
    });
    expect(libraryStatus({ status: "failed" }).label).toBe("Failed");
  });
});
