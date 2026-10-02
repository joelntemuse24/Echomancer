/**
 * Plain-TypeScript DSP for the reference gate: FFT, a speech mask, the
 * phone-band check and resemblyzer-compatible mel frames. 16 kHz mono in.
 */

export const REF_RATE = 16_000;

// ------------------------------------------------------------------ FFT

type FftPlan = {
  n: number;
  /** n = small * pow2: `small`-point direct DFTs, then `pow2`-point radix-2 FFTs. */
  small: number;
  pow2: number;
  cos: Float64Array;
  sin: Float64Array;
  bitrev: Uint32Array;
  yRe: Float64Array;
  yIm: Float64Array;
  bRe: Float64Array;
  bIm: Float64Array;
};

const plans = new Map<number, FftPlan>();

function plan(n: number): FftPlan {
  let p = plans.get(n);
  if (p) return p;
  let pow2 = 1;
  while (n % (pow2 * 2) === 0) pow2 *= 2;
  const small = n / pow2;
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    cos[j] = Math.cos((2 * Math.PI * j) / n);
    sin[j] = -Math.sin((2 * Math.PI * j) / n);
  }
  const bits = Math.round(Math.log2(pow2));
  const bitrev = new Uint32Array(pow2);
  for (let i = 0; i < pow2; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    bitrev[i] = r;
  }
  p = {
    n, small, pow2, cos, sin, bitrev,
    yRe: new Float64Array(n), yIm: new Float64Array(n),
    bRe: new Float64Array(pow2), bIm: new Float64Array(pow2),
  };
  plans.set(n, p);
  return p;
}

/** In-place radix-2 FFT of length pow2, twiddles taken from the size-n table. */
function radix2(re: Float64Array, im: Float64Array, p: FftPlan): void {
  const m = p.pow2;
  for (let i = 0; i < m; i++) {
    const j = p.bitrev[i]!;
    if (j > i) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= m; len <<= 1) {
    const half = len >> 1;
    const stride = (p.n / len) | 0;
    for (let i = 0; i < m; i += len) {
      for (let k = 0; k < half; k++) {
        const c = p.cos[k * stride]!;
        const s = p.sin[k * stride]!;
        const a = i + k;
        const b = a + half;
        const vr = re[b]! * c - im[b]! * s;
        const vi = re[b]! * s + im[b]! * c;
        re[b] = re[a]! - vr; im[b] = im[a]! - vi;
        re[a] = re[a]! + vr; im[a] = im[a]! + vi;
      }
    }
  }
}

/** Power spectrum |X|^2 for bins 0..n/2 of a real frame (n = power of two times a small factor). */
export function powerSpectrum(frame: Float64Array): Float64Array {
  const n = frame.length;
  const p = plan(n);
  const { small: N1, pow2: N2 } = p;
  // Step 1: N2 direct DFTs of size N1, with the inter-stage twiddle W_n^(n2*k1).
  for (let n2 = 0; n2 < N2; n2++) {
    for (let k1 = 0; k1 < N1; k1++) {
      let accRe = 0;
      let accIm = 0;
      for (let n1 = 0; n1 < N1; n1++) {
        const idx = ((n1 * k1) % N1) * N2;
        const x = frame[N2 * n1 + n2]!;
        accRe += x * p.cos[idx]!;
        accIm += x * p.sin[idx]!;
      }
      const t = (n2 * k1) % n;
      const c = p.cos[t]!;
      const s = p.sin[t]!;
      p.yRe[k1 * N2 + n2] = accRe * c - accIm * s;
      p.yIm[k1 * N2 + n2] = accRe * s + accIm * c;
    }
  }
  // Step 2: N1 radix-2 FFTs of size N2; X[k1 + N1*k2].
  const out = new Float64Array(Math.floor(n / 2) + 1);
  for (let k1 = 0; k1 < N1; k1++) {
    for (let i = 0; i < N2; i++) {
      p.bRe[i] = p.yRe[k1 * N2 + i]!;
      p.bIm[i] = p.yIm[k1 * N2 + i]!;
    }
    radix2(p.bRe, p.bIm, p);
    for (let k2 = 0; k2 < N2; k2++) {
      const k = k1 + N1 * k2;
      if (k < out.length) out[k] = p.bRe[k2]! * p.bRe[k2]! + p.bIm[k2]! * p.bIm[k2]!;
    }
  }
  return out;
}

export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// ------------------------------------------------------------ speech mask

const MASK_FRAME = 480; // 30 ms at 16 kHz

/** Per-30 ms speech flags: energy 8 dB over the quiet floor and above -50 dBFS. */
export function speechMask(pcm: Float32Array): boolean[] {
  const n = Math.floor(pcm.length / MASK_FRAME);
  const db = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * MASK_FRAME; i < (f + 1) * MASK_FRAME; i++) e += pcm[i]! * pcm[i]!;
    db[f] = 10 * Math.log10(e / MASK_FRAME + 1e-12);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(0.15 * (sorted.length - 1))] ?? -100;
  const thresh = Math.max(floor + 8, -50);
  return Array.from(db, (v) => v > thresh);
}

export function speechSeconds(mask: boolean[]): number {
  return (mask.filter(Boolean).length * MASK_FRAME) / REF_RATE;
}

/**
 * Speech energy in 4-8 kHz relative to 0.3-4 kHz, in dB. Normal speech sits
 * between -12 and -30; a phone-band recording has nothing up there (~-85).
 */
export function highBandDb(pcm: Float32Array, mask: boolean[]): number {
  const N = 512;
  const win = hannPeriodic(N);
  const bin = REF_RATE / N;
  let lo = 0;
  let hi = 0;
  const frame = new Float64Array(N);
  // Every other speech frame is plenty for a band ratio.
  for (let f = 0; f < mask.length; f += 2) {
    if (!mask[f]) continue;
    const start = f * MASK_FRAME;
    if (start + N > pcm.length) break;
    for (let i = 0; i < N; i++) frame[i] = pcm[start + i]! * win[i]!;
    const p = powerSpectrum(frame);
    for (let k = 0; k < p.length; k++) {
      const hz = k * bin;
      if (hz >= 300 && hz < 4000) lo += p[k]!;
      else if (hz >= 4000 && hz < 7800) hi += p[k]!;
    }
  }
  if (lo <= 0) return 0;
  return 10 * Math.log10(hi / lo + 1e-12);
}

// ------------------------------------------------------ resemblyzer mels

const MEL_NFFT = 400;
const MEL_HOP = 160;
const MEL_BANDS = 40;

function hzToMel(f: number): number {
  const fSp = 200 / 3;
  const logStep = Math.log(6.4) / 27;
  return f < 1000 ? f / fSp : 15 + Math.log(f / 1000) / logStep;
}

function melToHz(m: number): number {
  const fSp = 200 / 3;
  const logStep = Math.log(6.4) / 27;
  return m < 15 ? m * fSp : 1000 * Math.exp(logStep * (m - 15));
}

let melBankCache: Float64Array[] | null = null;

/** librosa.filters.mel(sr=16000, n_fft=400, n_mels=40), Slaney scale and norm. */
export function melFilterBank(): Float64Array[] {
  if (melBankCache) return melBankCache;
  const nBins = MEL_NFFT / 2 + 1;
  const top = hzToMel(REF_RATE / 2);
  const melF = Array.from({ length: MEL_BANDS + 2 }, (_, i) => melToHz((top * i) / (MEL_BANDS + 1)));
  const bank: Float64Array[] = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const w = new Float64Array(nBins);
    const enorm = 2 / (melF[b + 2]! - melF[b]!);
    for (let k = 0; k < nBins; k++) {
      const hz = (k * REF_RATE) / MEL_NFFT;
      const lower = (hz - melF[b]!) / (melF[b + 1]! - melF[b]!);
      const upper = (melF[b + 2]! - hz) / (melF[b + 2]! - melF[b + 1]!);
      w[k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
    bank.push(w);
  }
  melBankCache = bank;
  return bank;
}

/**
 * Mel power frames exactly as resemblyzer feeds its encoder
 * (librosa.feature.melspectrogram, n_fft 400, hop 160, centred, zero pad).
 */
export function melFrames(pcm: Float32Array): Float32Array[] {
  const pad = MEL_NFFT / 2;
  const padded = new Float32Array(pcm.length + 2 * pad);
  padded.set(pcm, pad);
  const nFrames = 1 + Math.floor(pcm.length / MEL_HOP);
  const win = hannPeriodic(MEL_NFFT);
  const bank = melFilterBank();
  const frame = new Float64Array(MEL_NFFT);
  const out: Float32Array[] = [];
  for (let f = 0; f < nFrames; f++) {
    const start = f * MEL_HOP;
    for (let i = 0; i < MEL_NFFT; i++) frame[i] = (padded[start + i] ?? 0) * win[i]!;
    const p = powerSpectrum(frame);
    const mel = new Float32Array(MEL_BANDS);
    for (let b = 0; b < MEL_BANDS; b++) {
      const w = bank[b]!;
      let s = 0;
      for (let k = 0; k < p.length; k++) s += w[k]! * p[k]!;
      mel[b] = s;
    }
    out.push(mel);
  }
  return out;
}

/** resemblyzer.normalize_volume(wav, -30 dBFS, increase_only=True). */
export function normalizeVolumeUp(pcm: Float32Array, targetDbfs = -30): Float32Array {
  let e = 0;
  for (let i = 0; i < pcm.length; i++) e += pcm[i]! * pcm[i]!;
  const dbfs = 10 * Math.log10(e / Math.max(1, pcm.length) + 1e-12);
  const change = targetDbfs - dbfs;
  if (change <= 0) return pcm;
  const g = Math.pow(10, change / 20);
  return Float32Array.from(pcm, (v) => v * g);
}

/** Only the speech frames, joined. */
export function keepSpeech(pcm: Float32Array, mask: boolean[]): Float32Array {
  const parts: number[] = [];
  for (let f = 0; f < mask.length; f++) {
    if (!mask[f]) continue;
    for (let i = f * MASK_FRAME; i < (f + 1) * MASK_FRAME && i < pcm.length; i++) parts.push(pcm[i]!);
  }
  return Float32Array.from(parts);
}
