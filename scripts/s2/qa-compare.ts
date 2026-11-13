/**
 * Audio and latency QA for two `bench-ab.mjs` runs.
 *
 *   npx tsx scripts/s2/qa-compare.ts /tmp/s2-ab/before /tmp/s2-ab/after
 *
 * Exits non-zero when any gate below fails, so this is usable in a CI step as
 * well as by hand.
 *
 * ## What it checks, and why each one exists
 *
 * - **Latency and realtime**, per workload, side by side. A speedup claim needs
 *   matched workloads, so the two manifests must agree on rows and characters.
 * - **Completeness.** Every requested row present, decodable, and not
 *   `truncated_units > 0`. A section that silently vanished is the failure that
 *   matters most (`job 1f0137a1` lost 1,705 characters this way).
 * - **Duration parity**, within ±7%. A take that got shorter for the same text
 *   is a dropped unit, not a speedup.
 * - **Speaker similarity** against the reference clip, using the repo's own
 *   Resemblyzer GE2E `speaker_encoder.onnx` (the same model the reference gate
 *   uses, so the number is comparable to it), plus first-15 s vs last-15 s
 *   inside each take to catch the intra-section drift `job 12534aaa` had.
 * - **DNSMOS P.835** (SIG / BAK / OVRL) on a sample of sections.
 * - **Word error rate** with the repo's `scripts/whisper-qa.py`
 *   (`faster-whisper` base int8), plus a repeat/omission scan.
 * - **Splice hygiene**: silence ratio and the largest sample step at each
 *   unit-pause join, which is how a click would show up.
 *
 * ## What it needs on the machine
 *
 * - `ffmpeg` / `ffprobe` on PATH (already a dependency of the worker).
 * - `python3` with `faster-whisper` for the WER pass. Without it, WER is skipped
 *   with a clear message rather than silently reported as passing.
 * - `onnxruntime-node` in `.reference-quality-ort` (`scripts/install-reference-quality.sh`)
 *   and `models/reference-quality/{dnsmos_sig_bak_ovr,speaker_encoder}.onnx`.
 *   Without them the similarity and DNSMOS gates are skipped, and that is said
 *   loudly: a run that cannot measure quality must not look like a pass.
 * - The reference clip from the manifest, at `reference.source` (or
 *   `--reference <path>`), for the similarity check.
 *
 * Nothing here calls Modal or spends GPU money.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cosineSimilarity,
  dnsmos,
  speakerEmbedding,
  warmReferenceModels,
} from "@/lib/tts/reference-quality/models";
import { REF_RATE } from "@/lib/tts/reference-quality/dsp";

// ── small helpers ──────────────────────────────────────────────────────────

type SectionRow = {
  key: string;
  /** The text this section was rendered from, recorded by `bench-ab.mjs`. */
  text?: string | null;
  file: string | null;
  bytes: number;
  deferred_read: string | null;
  duration_s?: number;
  units?: number;
  truncated_units?: number;
  error?: string;
};

type Workload = {
  name: string;
  ok: boolean;
  label?: string;
  rows?: number;
  chars?: number;
  largestRowChars?: number;
  wallMs?: number;
  audioSeconds?: number;
  realtime?: number;
  build?: string | null;
  sections?: SectionRow[];
  performance?: Record<string, unknown> | null;
  error?: string;
};

type Manifest = {
  recorded_at: string;
  batch_host: string;
  reference: { source: string; bytes: number; speech_like: boolean };
  workloads: Workload[];
};

type Take = {
  pcm: Float32Array;
  seconds: number;
};

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg.startsWith("--")) {
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), "true");
    }
  } else {
    positional.push(arg);
  }
}

if (positional.length !== 2) {
  console.error(
    "usage: npx tsx scripts/s2/qa-compare.ts <baseline-dir> <candidate-dir>\n" +
      "  flags: --reference <clip>  --wer-sections N  --dnsmos-sections N\n" +
      "         --allow-skips  (exit 0 when a gate could not run; default is to fail)"
  );
  process.exit(2);
}

const [baselineDir, candidateDir] = positional.map((dir) => resolve(dir)) as [string, string];
const WER_SECTIONS = Number(flags.get("wer-sections") || "8");
const DNSMOS_SECTIONS = Number(flags.get("dnsmos-sections") || "8");

const failures: string[] = [];
const skips: string[] = [];
function fail(message: string): void {
  failures.push(message);
  console.log(`  FAIL  ${message}`);
}
function pass(message: string): void {
  console.log(`  ok    ${message}`);
}
function skip(message: string): void {
  skips.push(message);
  console.log(`  SKIP  ${message}`);
}

function readManifest(dir: string): Manifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) {
    console.error(`no manifest at ${path} — run bench-ab.mjs --record ${dir} first`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Decode an MP3 to mono float samples at `rate`. */
function decodeAudio(path: string, rate: number): Take {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"],
    { maxBuffer: 1024 * 1024 * 512 }
  );
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4).slice();
  return { pcm, seconds: pcm.length / rate };
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── WER via the repo's own Whisper sidecar ─────────────────────────────────

type WhisperRow = { ok: boolean; text?: string; error?: string };

/**
 * Transcribe one file with `scripts/whisper-qa.py`.
 *
 * That script reads audio on stdin and writes one JSON object, and it decodes
 * through ffmpeg rather than PyAV — the same path the worker's section QA uses,
 * so a result here means what a result there means.
 */
function transcribe(path: string): WhisperRow {
  try {
    const out = execFileSync("python3", [join("scripts", "whisper-qa.py")], {
      input: readFileSync(path),
      maxBuffer: 1024 * 1024 * 32,
      encoding: "buffer",
    });
    return JSON.parse(out.toString("utf8")) as WhisperRow;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function wordErrorRate(reference: string, hypothesis: string): number {
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i += 1) {
    let previous = d[0]!;
    d[0] = i;
    for (let j = 1; j <= h.length; j += 1) {
      const current = Math.min(
        d[j]! + 1,
        d[j - 1]! + 1,
        previous + (r[i - 1] === h[j - 1] ? 0 : 1)
      );
      previous = d[j]!;
      d[j] = current;
    }
  }
  return d[h.length]! / Math.max(1, r.length);
}

/**
 * A repeated or missing run of `n`+ words in the hypothesis.
 *
 * This is the shape a degenerate decode takes: the model loops on a phrase, or
 * skips a clause. WER averages hide both, so they are checked separately, the
 * same way the worker's section QA does it.
 */
function longRepeatOrDrop(reference: string, hypothesis: string, n = 6): string | null {
  const r = words(reference);
  const h = words(hypothesis);
  for (let i = 0; i + n <= h.length; i += 1) {
    const span = h.slice(i, i + n).join(" ");
    const twice = h.slice(i + n, i + 2 * n).join(" ");
    if (span === twice) return `repeated run: "${span}"`;
  }
  // A dropped run: an n-word span of the reference that is absent entirely.
  for (let i = 0; i + n <= r.length; i += n) {
    const span = r.slice(i, i + n).join(" ");
    if (!h.join(" ").includes(span)) return `missing run: "${span}"`;
  }
  return null;
}

// ── splice hygiene ─────────────────────────────────────────────────────────

/** Share of 20 ms windows below the silence threshold. */
function silenceRatio(pcm: Float32Array): number {
  const win = Math.round(0.02 * REF_RATE);
  if (pcm.length < win) return 0;
  let silent = 0;
  let total = 0;
  for (let start = 0; start + win <= pcm.length; start += win) {
    let energy = 0;
    for (let i = start; i < start + win; i += 1) energy += pcm[i]! * pcm[i]!;
    const rms = Math.sqrt(energy / win);
    if (rms < 0.004) silent += 1;
    total += 1;
  }
  return total === 0 ? 0 : (silent / total) * 100;
}

/**
 * The largest sample-to-sample step, which is how a click at a join shows up.
 *
 * Compared against the take's own 99.9th-percentile step rather than an absolute
 * number: a loud consonant is a real step, and only a step far outside the take's
 * own distribution is a splice artefact.
 */
function maxStepOutlier(pcm: Float32Array): number {
  if (pcm.length < 3) return 0;
  const steps: number[] = [];
  for (let i = 1; i < pcm.length; i += 1) steps.push(Math.abs(pcm[i]! - pcm[i - 1]!));
  steps.sort((a, b) => a - b);
  const p999 = steps[Math.floor(steps.length * 0.999)] ?? 0;
  const max = steps[steps.length - 1] ?? 0;
  return p999 > 0 ? max / p999 : max;
}

// ── similarity ─────────────────────────────────────────────────────────────

/**
 * Cosine between the **mean speaker embeddings** of the clip and the take.
 *
 * This replaces a concatenate-then-`speakerPairMin` approach that could not
 * measure what it claimed:
 *
 * - `speakerPairMin` keeps `MAX_WINDOWS = 8` windows of 4 s, i.e. 32 s of speech.
 *   A 32 s reference clip fills every window on its own, so the take was never
 *   embedded at all — the score was the clip's own internal worst pair.
 * - It also returns the **minimum** cosine across all window pairs, including
 *   pairs inside the clip, which clamps the result regardless of the take.
 * - And because it takes one signal, `last 15 s` could not be compared with
 *   `first 15 s` independently, so intra-section drift was unmeasurable.
 *
 * Resemblyzer's own protocol (and the reference gate's use of it) is one mean
 * L2-normalised embedding per recording, compared by cosine. That is what this
 * does, over the **whole** take as well as its first and last 15 s.
 */
async function embedSimilarity(clip: Float32Array, take: Float32Array): Promise<number | null> {
  const [a, b] = await Promise.all([speakerEmbedding(clip), speakerEmbedding(take)]);
  if (!a || !b) return null;
  return cosineSimilarity(a, b);
}

/**
 * Audio measurements for one run's workload: the same numbers for baseline and
 * candidate, so the gates can be deltas rather than absolute floors.
 *
 * Sections are chosen deterministically (evenly spaced plus the shortest and
 * longest), so the two runs measure the same indexes and a delta means something.
 */
async function measureAudio(
  dir: string,
  workload: Workload,
  referenceClip: Float32Array | null,
  modelsReady: boolean,
  opts: { dnsmosSections: number }
): Promise<{
  similarityMean: number;
  similarityCount: number;
  driftWorst: { key: string; drift: number } | null;
  dnsmos: { sig: number; bak: number; ovrl: number; n: number };
  silenceRatio: number | null;
  spliceWorst: { key: string; ratio: number } | null;
}> {
  const empty = {
    similarityMean: 0,
    similarityCount: 0,
    driftWorst: null,
    dnsmos: { sig: 0, bak: 0, ovrl: 0, n: 0 },
    silenceRatio: null,
    spliceWorst: null,
  };
  const rows = (workload.sections ?? []).filter(
    (row) => row.file && existsSync(join(dir, workload.name, row.file))
  );
  if (!rows.length) return empty as never;

  const sample: SectionRow[] = [];
  const step = Math.max(1, Math.floor(rows.length / opts.dnsmosSections));
  for (let i = 0; i < rows.length; i += step) {
    sample.push(rows[i]!);
    if (sample.length >= opts.dnsmosSections) break;
  }
  // Always include the shortest and longest: a truncation or a padding problem
  // shows up at one of the extremes.
  const byDuration = [...rows].sort(
    (a, b) => (Number(a.duration_s) || 0) - (Number(b.duration_s) || 0)
  );
  for (const edge of [byDuration[0], byDuration[byDuration.length - 1]]) {
    if (edge && !sample.includes(edge)) sample.push(edge);
  }

  let similaritySum = 0;
  let similarityCount = 0;
  let driftWorst: { key: string; drift: number } | null = null;
  const dnsmosSum = { sig: 0, bak: 0, ovrl: 0, n: 0 };
  let silenceWorst: { key: string; ratio: number } | null = null;
  let spliceWorst: { key: string; ratio: number } | null = null;

  for (const row of sample) {
    const take = decodeAudio(join(dir, workload.name, row.file!), REF_RATE);
    if (referenceClip) {
      const similarity = await embedSimilarity(referenceClip, take.pcm);
      if (similarity != null) {
        similaritySum += similarity;
        similarityCount += 1;
      }
      // Drift inside the take: first 15 s vs last 15 s, each against the clip.
      const fifteen = Math.min(15 * REF_RATE, Math.floor(take.pcm.length / 2));
      if (fifteen > REF_RATE) {
        const head = await embedSimilarity(referenceClip, take.pcm.subarray(0, fifteen));
        const tail = await embedSimilarity(
          referenceClip,
          take.pcm.subarray(take.pcm.length - fifteen)
        );
        if (head != null && tail != null) {
          const drift = tail - head;
          if (!driftWorst || drift < driftWorst.drift) driftWorst = { key: row.key, drift };
        }
      }
    }
    if (modelsReady) {
      const scored = await dnsmos(take.pcm);
      if (scored) {
        dnsmosSum.sig += scored.sig;
        dnsmosSum.bak += scored.bak;
        dnsmosSum.ovrl += scored.ovrl;
        dnsmosSum.n += 1;
      }
    }
    const ratio = silenceRatio(take.pcm);
    if (!silenceWorst || Math.abs(ratio - 20) > Math.abs(silenceWorst.ratio - 20)) {
      silenceWorst = { key: row.key, ratio };
    }
    const outlier = maxStepOutlier(take.pcm);
    if (!spliceWorst || outlier > spliceWorst.ratio) {
      spliceWorst = { key: row.key, ratio: outlier };
    }
  }

  return {
    similarityMean: similarityCount ? similaritySum / similarityCount : 0,
    similarityCount,
    driftWorst,
    dnsmos: dnsmosSum,
    // The section furthest from a typical 20% silence share, so one badly-paced
    // take shows up rather than averaging away.
    silenceRatio: silenceWorst ? silenceWorst.ratio : null,
    spliceWorst,
  };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!hasFfmpeg()) {
    console.error("ffmpeg is required (it is already a dependency of the worker)");
    process.exit(2);
  }
  const baseline = readManifest(baselineDir);
  const candidate = readManifest(candidateDir);

  mkdirSync(join(candidateDir, "qa"), { recursive: true });

  console.log(`\nbaseline  ${baselineDir}  (${baseline.recorded_at})`);
  console.log(`candidate ${candidateDir}  (${candidate.recorded_at})\n`);

  // ── latency, per workload ────────────────────────────────────────────────
  console.log("== latency ==");
  for (const before of baseline.workloads) {
    const after = candidate.workloads.find((entry) => entry.name === before.name);
    if (!after) {
      fail(`workload ${before.name} is missing from the candidate run`);
      continue;
    }
    if (!before.ok || !after.ok) {
      fail(`workload ${before.name} did not complete in both runs`);
      continue;
    }
    if (before.rows !== after.rows || before.chars !== after.chars) {
      fail(
        `workload ${before.name} is not matched: ` +
          `${before.rows}/${before.chars} chars vs ${after.rows}/${after.chars}`
      );
      continue;
    }
    const ratio = (after.realtime ?? 0) / (before.realtime ?? 1);
    console.log(
      `  ${before.name.padStart(2)}-wide  ` +
        `${(before.realtime ?? 0).toFixed(1)}x -> ${(after.realtime ?? 0).toFixed(1)}x  ` +
        `(${(((before.wallMs ?? 0) / 1000)).toFixed(2)}s -> ` +
        `${(((after.wallMs ?? 0) / 1000)).toFixed(2)}s, ${(ratio * 100 - 100).toFixed(1)}%)`
    );
    if (ratio < 1) {
      fail(
        `workload ${before.name} is SLOWER: ${(before.realtime ?? 0).toFixed(1)}x -> ` +
          `${(after.realtime ?? 0).toFixed(1)}x`
      );
    } else {
      pass(`workload ${before.name} is ${ratio.toFixed(2)}x its baseline throughput`);
    }
  }

  // ── reference clip, for similarity ───────────────────────────────────────
  const referencePath = flags.get("reference") || baseline.reference.source;
  let referenceClip: Float32Array | null = null;
  if (baseline.reference.speech_like && existsSync(referencePath)) {
    referenceClip = decodeAudio(referencePath, REF_RATE).pcm;
  } else if (!baseline.reference.speech_like) {
    skip(
      "speaker similarity and WER are not meaningful: bench-ab.mjs ran with its " +
        "placeholder tone. Re-record both runs with --reference-audio <clip>."
    );
  } else {
    skip(`reference clip not found at ${referencePath}; similarity not measured`);
  }

  const modelsReady = await warmReferenceModels();
  if (!modelsReady) {
    skip(
      "DNSMOS / speaker models are unavailable (install onnxruntime-node with " +
        "scripts/install-reference-quality.sh and check models/reference-quality/)"
    );
  }

  // ── per-workload audio gates ─────────────────────────────────────────────
  for (const before of baseline.workloads) {
    const after = candidate.workloads.find((entry) => entry.name === before.name);
    if (!after?.ok || !before.ok) continue;
    const rows = Math.max(before.sections?.length ?? 0, after.sections?.length ?? 0);
    console.log(`\n== workload ${before.name} (${rows} sections) ==`);

    // Completeness first: nothing else matters if a section is missing.
    const afterKeys = new Set((after.sections ?? []).map((row) => row.key));
    const missing = (before.sections ?? [])
      .map((row) => row.key)
      .filter((key) => !afterKeys.has(key));
    if (missing.length) {
      fail(`sections missing from the candidate: ${missing.join(",")}`);
    } else {
      pass(`every section present (${afterKeys.size})`);
    }
    const errored = (after.sections ?? []).filter((row) => row.error);
    if (errored.length) {
      fail(
        `sections the container refused: ${errored
          .map((row) => `${row.key}:${row.error}`)
          .join(",")}`
      );
    }
    const truncated = (after.sections ?? []).filter(
      (row) => Number(row.truncated_units) > 0
    );
    if (truncated.length) {
      fail(
        `truncated_units > 0 on ${truncated.map((row) => row.key).join(",")} ` +
          "(a take hit the frame cap)"
      );
    } else {
      pass("no truncated units");
    }
    const unread = (after.sections ?? []).filter((row) => row.deferred_read);
    if (unread.length) {
      skip(
        `${unread.length} candidate section(s) were not read back from R2 ` +
          `(${unread[0]!.deferred_read}); audio gates ran on the rest`
      );
    }

    // Duration parity.
    const pairs = (after.sections ?? [])
      .map((row) => ({
        key: row.key,
        after: Number(row.duration_s) || 0,
        before: Number(
          (before.sections ?? []).find((candidateRow) => candidateRow.key === row.key)
            ?.duration_s
        ) || 0,
      }))
      .filter((pair) => pair.before > 0 && pair.after > 0);
    if (pairs.length) {
      const outOfRange = pairs.filter(
        (pair) => pair.after < pair.before * 0.93 || pair.after > pair.before * 1.07
      );
      if (outOfRange.length) {
        fail(
          `duration outside ±7% on ${outOfRange
            .map((pair) => `${pair.key}(${pair.before.toFixed(1)}->${pair.after.toFixed(1)}s)`)
            .join(",")}`
        );
      } else {
        pass(`duration within ±7% on all ${pairs.length} comparable sections`);
      }
    }

    // Audio gates need the files.
    const audioRows = (after.sections ?? []).filter(
      (row) => row.file && existsSync(join(candidateDir, after.name, row.file))
    );
    if (!audioRows.length) {
      skip(`no candidate audio on disk for workload ${after.name}`);
      continue;
    }

    // Similarity, drift, DNSMOS, silence — measured on **both** runs so the
    // gates can be deltas. An absolute floor alone would pass a candidate that
    // is measurably worse than its own baseline but still above 3.0, which is
    // exactly the regression this harness exists to catch.
    const measured = await measureAudio(candidateDir, after, referenceClip, modelsReady, {
      dnsmosSections: DNSMOS_SECTIONS,
    });
    const baselineMeasured = await measureAudio(
      baselineDir,
      before,
      referenceClip,
      modelsReady,
      { dnsmosSections: DNSMOS_SECTIONS }
    );

    // ── speaker similarity: delta first, floor second ────────────────────
    if (measured.similarityCount) {
      const mean = measured.similarityMean;
      if (baselineMeasured.similarityCount) {
        const delta = mean - baselineMeasured.similarityMean;
        // The plan's gate is `>= baseline_sim - 0.01`.
        if (delta < -0.01) {
          fail(
            `speaker similarity fell ${delta.toFixed(3)} against the baseline ` +
              `(${baselineMeasured.similarityMean.toFixed(3)} -> ${mean.toFixed(3)}); ` +
              "the plan allows at most -0.01"
          );
        } else {
          pass(
            `speaker similarity ${mean.toFixed(3)} (baseline ` +
              `${baselineMeasured.similarityMean.toFixed(3)}, delta ` +
              `${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`
          );
        }
      } else {
        skip("baseline produced no similarity score; only the absolute floor applies");
      }
      // Absolute floor: 0.70 is where `job 12534aaa`'s drifted section sat, so
      // 0.80 is "recognisably this voice" regardless of what the baseline did.
      if (mean < 0.8) fail(`mean speaker similarity ${mean.toFixed(3)} < 0.80 absolute floor`);
    }
    if (referenceClip && !measured.similarityCount) {
      // The model returned null, which means it could not see two speech windows
      // in the pair. Saying nothing here would let a run that measured no
      // speaker likeness report "all gates passed".
      skip(
        "speaker similarity produced no score (the model found fewer than two " +
          "speech windows); check the reference clip and the take lengths"
      );
    }

    // ── intra-section drift ──────────────────────────────────────────────
    if (measured.driftWorst) {
      const drift = measured.driftWorst.drift;
      if (drift < -0.05) {
        fail(
          `intra-section drift ${drift.toFixed(3)} on section ` +
            `${measured.driftWorst.key} (tail is measurably less like the reference)`
        );
      } else {
        pass(`worst intra-section drift ${drift.toFixed(3)}`);
      }
    }

    // ── DNSMOS: delta first, floor second ────────────────────────────────
    if (measured.dnsmos.n) {
      const n = measured.dnsmos.n;
      const sig = measured.dnsmos.sig / n;
      const bak = measured.dnsmos.bak / n;
      const ovrl = measured.dnsmos.ovrl / n;
      const label =
        `DNSMOS SIG ${sig.toFixed(2)} BAK ${bak.toFixed(2)} OVRL ${ovrl.toFixed(2)} ` +
        `over ${n} takes`;
      if (baselineMeasured.dnsmos.n) {
        const bn = baselineMeasured.dnsmos.n;
        const deltas = {
          sig: sig - baselineMeasured.dnsmos.sig / bn,
          bak: bak - baselineMeasured.dnsmos.bak / bn,
          ovrl: ovrl - baselineMeasured.dnsmos.ovrl / bn,
        };
        // The plan allows -0.05 on each of SIG, BAK, OVRL.
        const worst = Object.entries(deltas).sort((a, b) => a[1] - b[1])[0]!;
        if (worst[1] < -0.05) {
          fail(
            `${label}: ${worst[0].toUpperCase()} fell ${worst[1].toFixed(3)} ` +
              "against the baseline (the plan allows -0.05)"
          );
        } else {
          pass(`${label}; worst delta ${worst[0].toUpperCase()} ${worst[1].toFixed(3)}`);
        }
      } else {
        pass(label);
        skip("baseline produced no DNSMOS score; only the absolute floor applies");
      }
      // Absolute floor: P.835 is 1-5, and 3.0 is the usual "acceptable" line.
      if (ovrl < 3.0) fail(`DNSMOS OVRL ${ovrl.toFixed(2)} < 3.0 absolute floor`);
    }

    // ── pacing: silence ratio within ±2% of the baseline ─────────────────
    if (measured.silenceRatio != null && baselineMeasured.silenceRatio != null) {
      const delta = measured.silenceRatio - baselineMeasured.silenceRatio;
      if (Math.abs(delta) > 2) {
        fail(
          `silence ratio moved ${delta.toFixed(1)} points against the baseline ` +
            `(${baselineMeasured.silenceRatio.toFixed(1)}% -> ` +
            `${measured.silenceRatio.toFixed(1)}%; the plan allows 2)`
        );
      } else {
        pass(
          `silence ratio ${measured.silenceRatio.toFixed(1)}% ` +
            `(baseline ${baselineMeasured.silenceRatio.toFixed(1)}%)`
        );
      }
    } else if (measured.silenceRatio != null) {
      console.log(
        `  info  silence ratio ${measured.silenceRatio.toFixed(1)}% (no baseline to compare)`
      );
    }

    // ── splice clicks ────────────────────────────────────────────────────
    if (measured.spliceWorst) {
      if (measured.spliceWorst.ratio > 40) {
        fail(
          `sample step ${measured.spliceWorst.ratio.toFixed(0)}x the take's own p99.9 on ` +
            `${measured.spliceWorst.key} — a splice click`
        );
      } else {
        pass(`no splice click (worst step ${measured.spliceWorst.ratio.toFixed(0)}x p99.9)`);
      }
    }

    // ASR. Needs both the text and a working sidecar. Every section with audio
    // on disk is eligible: the text that was sent travels in the manifest, so
    // WER is measured against the narration itself, not against the other run.
    const werRows = (after.sections ?? [])
      .filter((row) => row.file && existsSync(join(candidateDir, after.name, row.file)))
      .slice(0, WER_SECTIONS);
    let werSum = 0;
    let werCount = 0;
    let repeatProblem: string | null = null;
    let sidecarError: string | null = null;
    for (const row of werRows) {
      const path = join(candidateDir, after.name, row.file!);
      const result = transcribe(path);
      if (!result.ok) {
        sidecarError = result.error ?? "unknown";
        break;
      }
      // WER is measured against the **text that was sent**, which the manifest
      // records per section. Comparing two transcripts would only prove the runs
      // agree with each other, not that either says the right words.
      const source = (row.text ?? "").trim();
      if (!source) continue;
      const wer = wordErrorRate(source, result.text ?? "");
      werSum += wer;
      werCount += 1;
      const repeat = longRepeatOrDrop(source, result.text ?? "");
      if (repeat && !repeatProblem) repeatProblem = `${row.key}: ${repeat}`;
    }
    // Baseline WER over the same section keys, so the gate is a delta. The plan
    // allows `baseline_WER + 0.5%`; the absolute 5% stays as a sanity floor.
    let baselineWerSum = 0;
    let baselineWerCount = 0;
    for (const row of werRows) {
      const beforeRow = (before.sections ?? []).find((entry) => entry.key === row.key);
      if (!beforeRow?.file || !existsSync(join(baselineDir, before.name, beforeRow.file))) {
        continue;
      }
      const source = (beforeRow.text ?? "").trim();
      if (!source) continue;
      const baselineResult = transcribe(join(baselineDir, before.name, beforeRow.file));
      if (!baselineResult.ok || !baselineResult.text) continue;
      baselineWerSum += wordErrorRate(source, baselineResult.text);
      baselineWerCount += 1;
    }

    if (sidecarError) {
      skip(
        `WER not measured: scripts/whisper-qa.py failed (${sidecarError.slice(0, 120)}). ` +
          "Install faster-whisper to enable it."
      );
    } else if (!werCount) {
      skip("WER not measured: no comparable transcripts");
    } else {
      const mean = (werSum / werCount) * 100;
      if (baselineWerCount) {
        const baselineMean = (baselineWerSum / baselineWerCount) * 100;
        const delta = mean - baselineMean;
        if (delta > 0.5) {
          fail(
            `mean WER rose ${delta.toFixed(2)} points against the baseline ` +
              `(${baselineMean.toFixed(2)}% -> ${mean.toFixed(2)}%); the plan allows +0.5`
          );
        } else {
          pass(
            `mean WER ${mean.toFixed(2)}% (baseline ${baselineMean.toFixed(2)}%, ` +
              `delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}) over ${werCount} sections`
          );
        }
      } else {
        pass(`mean WER ${mean.toFixed(2)}% over ${werCount} sections`);
        skip("baseline produced no transcript; only the absolute 5% floor applies");
      }
      if (mean >= 5) fail(`mean WER ${mean.toFixed(2)}% (>= 5% absolute floor)`);
      if (repeatProblem) fail(`repeat/omission: ${repeatProblem}`);
      else pass("no repeated or missing 6-word runs");
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    baseline: baselineDir,
    candidate: candidateDir,
    failures,
    skips,
  };
  writeFileSync(join(candidateDir, "qa", "report.json"), `${JSON.stringify(summary, null, 2)}\n`);

  console.log("");
  if (skips.length) {
    console.log(`${skips.length} check(s) SKIPPED — this run does not prove quality:`);
    for (const entry of skips) console.log(`  - ${entry}`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} gate(s) FAILED`);
    process.exit(1);
  }
  // **A skipped gate is not a passed gate.** This used to print "all gates
  // passed" and exit 0 with no R2 credentials, a placeholder reference tone, no
  // `faster-whisper`, or no `onnxruntime-node` — i.e. exactly the situations in
  // which nothing about audio quality had been measured. A caller that knows it
  // is measuring latency only can opt in with `--allow-skips`.
  if (skips.length && !flags.has("allow-skips")) {
    console.log(
      `\n${skips.length} gate(s) were skipped, so this run does not prove quality.\n` +
        "Fix the prerequisites listed above, or pass --allow-skips if you are only\n" +
        "measuring latency."
    );
    process.exit(1);
  }
  console.log(
    skips.length
      ? `all runnable gates passed (${skips.length} skipped, --allow-skips given)`
      : "all gates passed"
  );
}

main().catch((err) => {
  console.error("qa-compare failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
