import { describe, expect, it } from "vitest";
import { playbackForResume, seededTakehomePlayback } from "./cached-playback";
import { libraryResumeLabel, snapshotForPersist } from "@/lib/player/playback-position";

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

  it("opens section 0 after the rolling file is published, while the book is still generating", () => {
    const seeded = seededTakehomePlayback(
      {
        job_kind: "takehome",
        status: "processing",
        audio_url: "/api/storage/audiobooks/job-a/full.mp3",
        updated_at: "2026-11-10T00:00:00.000Z",
        segments: [section, { index: 1, path: "later.mp3", status: "pending" }],
      },
      { forceStream: false, forceSegments: false }
    );
    expect(seeded).toEqual({
      url: "/api/storage/audiobooks/job-a/sections/0000.mp3",
      segmentIndex: 0,
    });
  });

  it("starts section 0 while the rolling file is not written yet", () => {
    const seeded = seededTakehomePlayback(
      {
        job_kind: "takehome",
        status: "processing",
        segments: [section],
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

describe("playback for a stored position", () => {
  const segments = [
    { index: 0, path: "audiobooks/job-a/sections/0000.mp3", status: "ready", durationSeconds: 100 },
    { index: 1, path: "audiobooks/job-a/sections/0001.mp3", status: "ready", durationSeconds: 80 },
    { index: 2, path: "audiobooks/job-a/sections/0002.mp3", status: "ready", durationSeconds: 40 },
  ];

  it("opens the part that holds the book clock after the rolling file is published", () => {
    const seeded = playbackForResume(
      {
        job_kind: "takehome",
        status: "processing",
        audio_url: "/api/storage/audiobooks/job-a/full.mp3",
        duration_seconds: 180,
        segments,
      },
      { positionSeconds: 120, sectionIndex: null },
      { forceStream: false, forceSegments: false }
    );
    expect(seeded).toMatchObject({
      url: "/api/storage/audiobooks/job-a/sections/0001.mp3",
      segmentIndex: 1,
      localSeconds: 20,
      restart: false,
    });
    expect(seeded?.url).not.toContain("full.mp3");
  });

  it("opens the part that holds the book clock while the book is still generating", () => {
    const seeded = playbackForResume(
      { job_kind: "takehome", status: "processing", segments },
      { positionSeconds: 120, sectionIndex: null },
      { forceStream: false, forceSegments: false }
    );
    expect(seeded).toMatchObject({
      url: "/api/storage/audiobooks/job-a/sections/0001.mp3",
      segmentIndex: 1,
      localSeconds: 20,
      restart: false,
    });
  });

  it("seeks the finished file and restarts when the stored spot is the end", () => {
    const job = {
      job_kind: "takehome",
      status: "ready",
      audio_url: "/api/storage/audiobooks/job-a/full.mp3",
      updated_at: "2026-11-10T00:00:00.000Z",
      duration_seconds: 7200,
      segments,
    };
    const mid = playbackForResume(job, { positionSeconds: 33 * 60 + 12, sectionIndex: null }, {
      forceStream: false,
      forceSegments: false,
    });
    expect(mid?.segmentIndex).toBeNull();
    expect(mid?.localSeconds).toBe(33 * 60 + 12);
    expect(mid?.url).toContain("full.mp3");
    expect(
      playbackForResume(
        { ...job, duration_seconds: 1000 },
        { positionSeconds: 995, sectionIndex: null },
        { forceStream: false, forceSegments: false }
      )?.restart
    ).toBe(true);
  });

  it("keeps a part past a hole on the same audio after the hole is measured", () => {
    const guessed = [
      { index: 0, status: "ready", path: "audiobooks/job-a/sections/0000.mp3", durationSeconds: 100 },
      { index: 1, status: "pending", path: "audiobooks/job-a/sections/0001.mp3", durationSeconds: null },
      { index: 2, status: "ready", path: "audiobooks/job-a/sections/0002.mp3", durationSeconds: 80 },
    ];
    const saved = snapshotForPersist({
      reason: "tick",
      currentTime: 20,
      readyState: 4,
      ended: false,
      pendingActive: false,
      pendingBookSeconds: null,
      restoreLanded: true,
      onSection: true,
      sectionIndex: 2,
      spans: [
        { index: 0, startSeconds: 0, durationSeconds: 100 },
        { index: 2, startSeconds: 190, durationSeconds: 80 },
      ],
      complete: false,
      durationSeconds: null,
      hasNextSection: false,
    });
    expect(saved).toEqual({ positionSeconds: 20, sectionIndex: 2 });
    const job = { job_kind: "takehome", status: "processing", segments: guessed };
    const opts = { forceStream: false, forceSegments: false };
    const before = playbackForResume(job, saved, opts);
    expect(before).toMatchObject({
      url: "/api/storage/audiobooks/job-a/sections/0002.mp3",
      segmentIndex: 2,
      localSeconds: 20,
    });
    expect(
      libraryResumeLabel({
        status: "processing",
        positionSeconds: saved?.positionSeconds,
        sectionIndex: saved?.sectionIndex,
        segments: guessed,
      })
    ).toBe("Resume at 3:30");
    const measured = [
      guessed[0]!,
      { index: 1, status: "ready", path: "audiobooks/job-a/sections/0001.mp3", durationSeconds: 40 },
      guessed[2]!,
    ];
    const after = playbackForResume(
      { job_kind: "takehome", status: "processing", segments: measured },
      saved,
      opts
    );
    expect(after).toMatchObject({
      url: before?.url,
      segmentIndex: 2,
      localSeconds: 20,
    });
    expect(
      libraryResumeLabel({
        status: "processing",
        positionSeconds: saved?.positionSeconds,
        sectionIndex: saved?.sectionIndex,
        segments: measured,
      })
    ).toBe("Resume at 2:40");
  });

  it("does not restore a failed book", () => {
    expect(
      playbackForResume(
        {
          job_kind: "takehome",
          status: "failed",
          audio_url: "/api/storage/audiobooks/job-a/full.mp3",
          duration_seconds: 1000,
        },
        { positionSeconds: 120, sectionIndex: null },
        { forceStream: false, forceSegments: false }
      )
    ).toBeNull();
  });
});
