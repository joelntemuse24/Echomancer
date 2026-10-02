/**
 * Worker side of the clone reference gate: read the uploaded sample, score
 * it, remaster it once when that measurably helps, log the scores, and
 * report back to the clone route. Never throws for audio problems; a sample
 * we cannot decode comes back as `null` and the clone goes ahead as before.
 */

import { downloadFile, uploadFile } from "@/lib/storage";
import { decodeMonoPcm } from "@/lib/tts/section-squeak-guard";
import { REF_RATE } from "@/lib/tts/reference-quality/dsp";
import { DFN_RATE, deepFilterAvailable, deepFilterPcm } from "@/lib/tts/reference-quality/remaster";
import {
  evaluateReferenceQuality,
  keepRemaster,
  measureReference,
  type ReferenceQualityReport,
} from "@/lib/tts/reference-quality/score";

export type ReferenceCheckResult = {
  report: ReferenceQualityReport;
  /** Storage path of the cleaned sample to clone from, when one won. */
  remasteredPath: string | null;
  ms: number;
};

const SAFE_PATH = /^[\w./-]+$/;

/** Only clone samples: `clones/<uploadId>/sample.<ext>` or `clips/<user>/<id>.wav`. */
export function isSafeSamplePath(p: string): boolean {
  return SAFE_PATH.test(p) && !p.includes("..") && (p.startsWith("clones/") || p.startsWith("clips/"));
}

export type ReferenceCheckInput = {
  uploadId: string;
  samplePath: string;
  /**
   * The user chose "Continue anyway" on a failing clip: still run the
   * remaster pass when it is flagged. A first look at a failing clip skips
   * it so the warning comes back in about a second.
   */
  remasterFailing?: boolean;
};

export async function checkCloneReference(opts: ReferenceCheckInput): Promise<ReferenceCheckResult | null> {
  const started = Date.now();
  if (!isSafeSamplePath(opts.samplePath)) return null;
  let sample: Buffer;
  let pcm: Float32Array;
  try {
    sample = await downloadFile(opts.samplePath);
    pcm = await decodeMonoPcm(sample, 30_000, REF_RATE);
  } catch (err) {
    console.warn(`[reference-quality] upload=${opts.uploadId} unreadable:`, err instanceof Error ? err.message : err);
    return null;
  }

  const metrics = await measureReference(pcm);
  const report = evaluateReferenceQuality(metrics);
  let remasteredPath: string | null = null;
  let remasterMs: number | null = null;
  let remasteredSig: number | null = null;

  // Only after "Continue anyway": the first look stays at about a second.
  const wantRemaster = report.remaster && opts.remasterFailing === true;
  if (wantRemaster && (await deepFilterAvailable())) {
    const t = Date.now();
    try {
      const cleaned = await deepFilterPcm(await decodeMonoPcm(sample, 30_000, DFN_RATE));
      const after = await measureReference(await decodeMonoPcm(cleaned, 30_000, REF_RATE));
      remasteredSig = after.dnsmosSig;
      if (keepRemaster(metrics, after)) {
        const saved = await uploadFile("clone-remastered", `${opts.uploadId}.wav`, cleaned, "audio/wav");
        remasteredPath = saved.path;
      }
    } catch (err) {
      console.warn(`[reference-quality] upload=${opts.uploadId} remaster failed:`, err instanceof Error ? err.message : err);
    }
    remasterMs = Date.now() - t;
  }

  const ms = Date.now() - started;
  const m = report.metrics;
  const log = {
    uploadId: opts.uploadId,
    verdict: report.verdict,
    issues: report.issues.map((i) => i.code),
    notes: report.notes.map((n) => n.code),
    sig: m.dnsmosSig,
    bak: m.dnsmosBak,
    ovrl: m.dnsmosOvrl,
    hfDb: m.highBandDb,
    pitchStdSt: m.pitchStdSt,
    pitchMedianHz: m.pitchMedianHz,
    speakerPairMin: m.speakerPairMin,
    speechSec: m.speechSec,
    durationSec: m.durationSec,
    scoreMs: m.ms,
    remasterMs,
    remasteredSig,
    remastered: Boolean(remasteredPath),
    ms,
  };
  console.log(`[reference-quality] ${JSON.stringify(log)}`);
  void uploadFile("reference-quality", `${opts.uploadId}.json`, Buffer.from(JSON.stringify(log)), "application/json").catch(
    () => {}
  );
  return { report, remasteredPath, ms };
}
