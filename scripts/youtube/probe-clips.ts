/**
 * Time a section download + master for a handful of videos.
 *
 *   npx tsx scripts/youtube/probe-clips.ts
 *
 * Prints one JSON line per video: pass/fail and milliseconds per step.
 * Does not call Fish. A music bed should fail the speech gate on purpose.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadYoutubeSection } from "../../src/lib/youtube/fetch-audio";
import { masterYoutubeClip } from "../../src/lib/youtube/master-clip";

type Probe = {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
};

const probes: Probe[] = [
  { id: process.env.YOUTUBE_CC_VIDEO_ID || "q0VzUigrb_g", label: "cc-speech", startSec: 30, endSec: 60 },
  { id: process.env.YOUTUBE_LECTURE_ID || "7eUfAb8de8c", label: "long-lecture", startSec: 120, endSec: 150 },
  { id: process.env.YOUTUBE_MUSIC_ID || "aqz-KE-bpKQ", label: "background-music", startSec: 40, endSec: 70 },
  { id: process.env.YOUTUBE_PROBE_4 || "jNQXAC9IVRw", label: "short-talk", startSec: 0, endSec: 18 },
  { id: process.env.YOUTUBE_PROBE_5 || "YHAY9UY9MgE", label: "second-lecture", startSec: 200, endSec: 230 },
];

async function one(probe: Probe) {
  const dir = await mkdtemp(path.join(tmpdir(), "yt-probe-"));
  const started = Date.now();
  try {
    const fetchStarted = Date.now();
    const fetched = await downloadYoutubeSection({
      videoId: probe.id,
      startSec: probe.startSec,
      endSec: probe.endSec,
      workDir: dir,
    });
    const fetchMs = Date.now() - fetchStarted;
    const masterStarted = Date.now();
    const mastered = await masterYoutubeClip(fetched.filePath);
    const masterMs = Date.now() - masterStarted;
    return {
      label: probe.label,
      videoId: probe.id,
      pass: mastered.ok,
      strategy: fetched.strategy,
      fetchMs,
      masterMs,
      totalMs: Date.now() - started,
      speechSec: mastered.ok ? mastered.clip.speechSec : undefined,
      separated: mastered.ok ? mastered.clip.separated : undefined,
      denoise: mastered.ok ? mastered.clip.denoise : undefined,
      message: mastered.ok ? undefined : mastered.message,
      code: mastered.ok ? undefined : mastered.code,
    };
  } catch (err) {
    return {
      label: probe.label,
      videoId: probe.id,
      pass: false,
      fetchMs: Date.now() - started,
      totalMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const results = [];
  for (const probe of probes) {
    const result = await one(probe);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  console.log(
    JSON.stringify({
      videos: results.length,
      fetchOk: results.filter((row) => Boolean(row.strategy)).length,
      masteredOk: results.filter((row) => row.pass).length,
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
