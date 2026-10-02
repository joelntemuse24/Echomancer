/**
 * ONNX models for the reference gate, run with onnxruntime-node on the
 * worker only. The runtime is not a package.json dependency (it is ~300 MB
 * with every platform's binaries, and Vercel must never bundle it); the worker
 * installs it once with scripts/install-reference-quality.sh into
 * `<app>/.reference-quality-ort` (or REFERENCE_QUALITY_ORT_DIR). Without it
 * these return null and the gate falls back to the plain-DSP checks.
 *
 *  - DNSMOS P.835 (Microsoft DNS Challenge, MIT): SIG / BAK / OVRL.
 *  - Resemblyzer GE2E speaker encoder (Apache-2.0), exported to ONNX.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { REF_RATE, keepSpeech, melFrames, normalizeVolumeUp } from "@/lib/tts/reference-quality/dsp";

type OrtTensor = { data: Float32Array; dims: readonly number[] };
type OrtSession = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
};
type OrtModule = {
  InferenceSession: { create(file: string, opts?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => OrtTensor;
};

let ortCache: OrtModule | null | undefined;

export function loadOrt(env: NodeJS.ProcessEnv = process.env): OrtModule | null {
  if (ortCache !== undefined) return ortCache;
  const dir = env.REFERENCE_QUALITY_ORT_DIR?.trim() || path.join(process.cwd(), ".reference-quality-ort");
  try {
    const req = createRequire(path.join(dir, "package.json"));
    ortCache = req("onnxruntime-node") as OrtModule;
  } catch {
    ortCache = null;
  }
  return ortCache;
}

export function modelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.REFERENCE_QUALITY_MODEL_DIR?.trim() || path.join(process.cwd(), "models", "reference-quality");
}

const sessions = new Map<string, Promise<OrtSession | null>>();

function session(file: string): Promise<OrtSession | null> {
  const ort = loadOrt();
  if (!ort) return Promise.resolve(null);
  const full = path.join(modelDir(), file);
  let s = sessions.get(full);
  if (!s) {
    s = ort.InferenceSession.create(full, { intraOpNumThreads: 3, interOpNumThreads: 1, enableCpuMemArena: false }).catch((err) => {
      console.warn("[reference-quality] model load failed:", file, err instanceof Error ? err.message : err);
      sessions.delete(full);
      return null;
    });
    sessions.set(full, s);
  }
  return s;
}

const DNSMOS_LEN = Math.round(9.01 * REF_RATE);
const DNSMOS_HOP = DNSMOS_LEN;
/**
 * Two 9 s windows (the first 18 s). On the 6-vCPU worker three windows took
 * 0.64 s and two 0.41 s; echo refs still read SIG 1.2-1.4 against 2.4+.
 */
const DNSMOS_MAX_WINDOWS = 2;

const poly = (c: [number, number, number], x: number) => c[0] * x * x + c[1] * x + c[2];

export type Dnsmos = { sig: number; bak: number; ovrl: number };

/** DNSMOS P.835 on 16 kHz mono, averaged over 9 s windows (polyfit as in dnsmos_local.py). */
export async function dnsmos(pcm: Float32Array): Promise<Dnsmos | null> {
  const s = await session("dnsmos_sig_bak_ovr.onnx");
  const ort = loadOrt();
  if (!s || !ort || pcm.length < REF_RATE) return null;
  let audio = pcm;
  while (audio.length < DNSMOS_LEN) {
    const next = new Float32Array(audio.length + pcm.length);
    next.set(audio);
    next.set(pcm, audio.length);
    audio = next;
  }
  const n = Math.min(DNSMOS_MAX_WINDOWS, Math.max(1, Math.floor((audio.length - DNSMOS_LEN) / DNSMOS_HOP) + 1));
  const batch = new Float32Array(n * DNSMOS_LEN);
  for (let k = 0; k < n; k++) batch.set(audio.subarray(k * DNSMOS_HOP, k * DNSMOS_HOP + DNSMOS_LEN), k * DNSMOS_LEN);
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor("float32", batch, [n, DNSMOS_LEN]) });
  const d = out[s.outputNames[0]!]!.data;
  let sig = 0;
  let bak = 0;
  let ovrl = 0;
  for (let k = 0; k < n; k++) {
    sig += poly([-0.08397278, 1.22083953, 0.0052439], d[k * 3]!);
    bak += poly([-0.13166888, 1.60915514, -0.39604546], d[k * 3 + 1]!);
    ovrl += poly([-0.06766283, 1.11546468, 0.04602535], d[k * 3 + 2]!);
  }
  return { sig: sig / n, bak: bak / n, ovrl: ovrl / n };
}

const WINDOW_FRAMES = 400; // 4 s
const MAX_WINDOWS = 8;
const PARTIAL_FRAMES = 160;
const PARTIAL_STEP = 77;

/**
 * Lowest speaker likeness between any two 4 s windows of speech (cosine of
 * resemblyzer embeddings). One speaker stays high; two speakers drop.
 * Null when there are fewer than two windows or no model.
 */
export async function speakerPairMin(pcm: Float32Array, mask: boolean[]): Promise<number | null> {
  const s = await session("speaker_encoder.onnx");
  const ort = loadOrt();
  if (!s || !ort) return null;
  const speech = keepSpeech(pcm, mask);
  const frames = melFrames(
    normalizeVolumeUp(speech.subarray(0, Math.min(speech.length, (MAX_WINDOWS * WINDOW_FRAMES + 1) * 160)))
  );
  const windows = Math.min(MAX_WINDOWS, Math.floor(frames.length / WINDOW_FRAMES));
  if (windows < 2) return null;
  const starts: number[] = [];
  for (let st = 0; st + PARTIAL_FRAMES <= WINDOW_FRAMES; st += PARTIAL_STEP) starts.push(st);
  const per = starts.length;
  const input = new Float32Array(windows * per * PARTIAL_FRAMES * 40);
  let o = 0;
  for (let w = 0; w < windows; w++) {
    for (const st of starts) {
      for (let f = 0; f < PARTIAL_FRAMES; f++) {
        input.set(frames[w * WINDOW_FRAMES + st + f]!, o);
        o += 40;
      }
    }
  }
  const out = await s.run({ [s.inputNames[0]!]: new ort.Tensor("float32", input, [windows * per, PARTIAL_FRAMES, 40]) });
  const e = out[s.outputNames[0]!]!.data;
  const dim = 256;
  const embeds: Float64Array[] = [];
  for (let w = 0; w < windows; w++) {
    const v = new Float64Array(dim);
    for (let p = 0; p < per; p++) for (let i = 0; i < dim; i++) v[i]! += e[(w * per + p) * dim + i]!;
    const norm = Math.hypot(...v) || 1;
    for (let i = 0; i < dim; i++) v[i]! /= norm;
    embeds.push(v);
  }
  let min = 1;
  for (let a = 0; a < embeds.length; a++) {
    for (let b = a + 1; b < embeds.length; b++) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += embeds[a]![i]! * embeds[b]![i]!;
      min = Math.min(min, dot);
    }
  }
  return min;
}

/** Load both models ahead of the first score (the worker calls this at boot). */
export async function warmReferenceModels(): Promise<boolean> {
  const [a, b] = await Promise.all([session("dnsmos_sig_bak_ovr.onnx"), session("speaker_encoder.onnx")]);
  return Boolean(a && b);
}

