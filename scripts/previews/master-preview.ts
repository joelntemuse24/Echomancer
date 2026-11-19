/**
 * Master a raw preview take the way a book section is mastered.
 *
 *   npx tsx scripts/previews/master-preview.ts raw.wav public/voice-previews/<id>.mp3
 *
 * A committed preview should sound like the books the picker leads to, so it
 * goes through `masterSectionBuffer` with the podcast chain: the spectral
 * filters, the voice curve (`TTS_VOICE_EQ`, on unless set to 0), loudness to
 * the book target, and the single-gain path under 3 seconds. The output is the
 * same 44.1 kHz mono MP3 a section is stored as; do not re-encode it.
 *
 * Run it where production masters (the `echomancer-cpu` image, ffmpeg
 * n8.1.3), or with `FFMPEG_PATH` pointing at that build. ffmpeg older than
 * 6.1 is refused: its linear loudnorm misses the target on short clips.
 * Pass `--chain s2` only for an S2 clone take.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { masterSectionBuffer } from "@/lib/tts/section-master";

function exitWith(code: number): void {
  process.exitCode = code;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const chainAt = args.indexOf("--chain");
  const chain = chainAt >= 0 && args[chainAt + 1] === "s2" ? "s2" : "podcast";
  if (chainAt >= 0) args.splice(chainAt, 2);
  const [input, output] = args;
  if (!input || !output) {
    console.error("usage: master-preview.ts <raw.wav|mp3> <out.mp3> [--chain s2]");
    return exitWith(2);
  }

  const ffmpeg = process.env.FFMPEG_PATH || process.env.TTS_FFMPEG_PATH || "ffmpeg";
  const banner = execFileSync(ffmpeg, ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "";
  const version = /version n?(\d+)\.(\d+)/.exec(banner);
  if (!version || Number(version[1]) * 100 + Number(version[2]) < 601) {
    console.error(`refusing ${banner || ffmpeg}: preview mastering needs ffmpeg 6.1 or newer`);
    return exitWith(3);
  }
  console.log(banner);

  const extension = path.extname(input).slice(1).toLowerCase() || "wav";
  const mastered = await masterSectionBuffer(readFileSync(input), extension, process.env, chain);
  if (!mastered) {
    console.error("mastering returned no audio");
    return exitWith(1);
  }
  writeFileSync(output, mastered);
  console.log(`wrote ${output} (${mastered.length} bytes, chain ${chain})`);
}

void main();
