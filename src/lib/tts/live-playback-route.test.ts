import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { extendLiveJoin } from "@/lib/tts/live-join";
import { removeJobScratch } from "@/lib/tts/job-scratch";
import { spawnFfmpeg } from "@/lib/tts/stream-finalize";
import type { JobSegment } from "@/lib/tts/types";
import {
  UPLOAD_ID_A,
  USER_A,
  buildRequest,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";

const JOB = "e3ebe236-185d-48ef-9fca-6146aa81d434";
const OTHER = "bbbbbbbb-185d-48ef-9fca-6146aa81d434";

async function sine(file: string): Promise<void> {
  await spawnFfmpeg(
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=6",
      "-ac",
      "1",
      "-ar",
      "44100",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-write_xing",
      "0",
      "-id3v2_version",
      "0",
      "-write_id3v1",
      "0",
      file,
    ],
    20_000
  );
}

beforeEach(async () => {
  await resetDatabase();
});

describe("live playback through the storage route", () => {
  it("serves the playlist and segment the worker join writes, and a section when the playlist is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "live-route-"));
    try {
      const file = path.join(root, "section.mp3");
      await sine(file);
      const bytes = await readFile(file);
      const { uploadFile } = await import("@/lib/storage");
      await uploadFile(`audiobooks/${JOB}/sections`, "0000.mp3", bytes, "audio/mpeg");
      const segment: JobSegment = {
        index: 0,
        path: `audiobooks/${JOB}/sections/0000.mp3`,
        status: "ready",
        mastered: true,
      };
      const joined = await extendLiveJoin({
        jobId: JOB,
        segments: [segment],
        joinKinds: ["chapter"],
        crossfadeMs: 120,
      });
      expect(joined?.path).toBe(`audiobooks/${JOB}/full.mp3`);

      const pdfPath = await seedUpload({
        id: UPLOAD_ID_A,
        userId: USER_A,
        text: "Chapter one. The harbor was quiet.",
      });
      await seedJob({
        id: JOB,
        userId: USER_A,
        pdfStoragePath: pdfPath,
        status: "processing",
        audioStoragePath: joined?.path ?? null,
      });
      const { GET } = await import("@/app/api/storage/[[...path]]/route");

      const playlist = await GET(
        await buildRequest(`/api/storage/audiobooks/${JOB}/live.m3u8`, { userId: USER_A }),
        routeParams({ path: ["audiobooks", JOB, "live.m3u8"] })
      );
      expect(playlist.status).toBe(200);
      expect(playlist.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
      const body = await playlist.text();
      expect(body).toContain("#EXTM3U");
      expect(body).toContain("live/0000.mp3");

      const live = await GET(
        await buildRequest(`/api/storage/audiobooks/${JOB}/live/0000.mp3`, { userId: USER_A }),
        routeParams({ path: ["audiobooks", JOB, "live", "0000.mp3"] })
      );
      expect(live.status).toBe(200);
      expect(live.headers.get("content-type")).toBe("audio/mpeg");
      expect(Buffer.from(await live.arrayBuffer()).length).toBeGreaterThan(100);

      await uploadFile(`audiobooks/${OTHER}/sections`, "0000.mp3", bytes, "audio/mpeg");
      await seedJob({
        id: OTHER,
        userId: USER_A,
        pdfStoragePath: pdfPath,
        status: "processing",
      });
      const missing = await GET(
        await buildRequest(`/api/storage/audiobooks/${OTHER}/live.m3u8`, { userId: USER_A }),
        routeParams({ path: ["audiobooks", OTHER, "live.m3u8"] })
      );
      expect(missing.status).toBe(404);
      const section = await GET(
        await buildRequest(`/api/storage/audiobooks/${OTHER}/sections/0000.mp3`, {
          userId: USER_A,
        }),
        routeParams({ path: ["audiobooks", OTHER, "sections", "0000.mp3"] })
      );
      expect(section.status).toBe(200);
      expect(Buffer.from(await section.arrayBuffer())).toEqual(bytes);
    } finally {
      await removeJobScratch(JOB).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
