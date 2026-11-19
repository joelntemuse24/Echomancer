/**
 * Speaker likeness of rendered takes against reference recordings.
 *
 * Uses the same Resemblyzer ONNX encoder as the clone reference gate
 * (`speakerEmbedding` in `src/lib/tts/reference-quality/models.ts`).
 * A clip under about four seconds of audio returns null from that
 * function; the passages this scores are longer than that.
 *
 *   REFERENCE_QUALITY_ORT_DIR=... REFERENCE_QUALITY_MODEL_DIR=... \
 *     npx tsx scripts/sowell/score_likeness.ts ref.wav take.wav [take.wav...]
 *
 * Prints one JSON object: `{ "reference": "...", "takes": [{ "path", "cosine" }] }`.
 */
import { spawnSync } from "node:child_process";
import { cosineSimilarity, speakerEmbedding } from "@/lib/tts/reference-quality/models";

function decode16k(path: string): Float32Array {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 64_000_000 }
  );
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg decode failed for ${path}: ${result.stderr?.toString() ?? ""}`
    );
  }
  const buf = Buffer.from(result.stdout);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

async function embed(path: string) {
  const pcm = decode16k(path);
  const vector = await speakerEmbedding(pcm);
  if (!vector) {
    throw new Error(
      `no speaker embedding for ${path} (${pcm.length} samples at 16 kHz)`
    );
  }
  return vector;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length < 2) {
    throw new Error("usage: score_likeness.ts <reference.wav> <take.wav>...");
  }
  const reference = await embed(paths[0]!);
  const takes = [];
  for (const path of paths.slice(1)) {
    const vector = await embed(path);
    takes.push({ path, cosine: cosineSimilarity(reference, vector) });
  }
  process.stdout.write(
    JSON.stringify({ reference: paths[0], takes }) + "\n"
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
