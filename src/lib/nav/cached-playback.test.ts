import { describe, expect, it } from "vitest";
import { seededTakehomePlayback } from "./cached-playback";

const section = { index: 0, path: "audiobooks/job-a/sections/0000.mp3", status: "ready" };

describe("seeded take-home playback", () => {
  it("versions a finished file from the library row", () => {
    const seeded = seededTakehomePlayback(
      {
        job_kind: "takehome",
        status: "ready",
        audio_url: "/api/storage/audiobooks/job-a/full.mp3",
        updated_at: "2026-11-10T00:00:00.000Z",
      },
      { forceStream: false, forceSegments: false }
    );
    expect(seeded?.segmentIndex).toBeNull();
    expect(seeded?.url).toContain("/api/storage/audiobooks/job-a/full.mp3");
    expect(seeded?.url).toContain("v=2026-11-10T00%3A00%3A00.000Z");
  });

  it("starts section 0 while the book is still generating", () => {
    const seeded = seededTakehomePlayback(
      {
        job_kind: "takehome",
        status: "processing",
        audio_url: "/api/storage/audiobooks/job-a/full.mp3",
        segments: [section, { index: 1, path: "later.mp3", status: "pending" }],
      },
      { forceStream: false, forceSegments: false }
    );
    expect(seeded).toEqual({
      url: "/api/storage/audiobooks/job-a/sections/0000.mp3",
      segmentIndex: 0,
    });
  });

  it("does not open a stream from the cache", () => {
    expect(
      seededTakehomePlayback(
        {
          job_kind: "stream",
          status: "processing",
          segments: [section],
        },
        { forceStream: false, forceSegments: false }
      )
    ).toBeNull();
    expect(
      seededTakehomePlayback(
        { job_kind: "takehome", status: "ready", audio_url: "/api/storage/a.mp3" },
        { forceStream: true, forceSegments: false }
      )
    ).toBeNull();
  });
});
