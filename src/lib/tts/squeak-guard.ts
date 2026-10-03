/**
 * Squeak guard for Fish clone sections.
 *
 * Off unless `TTS_SQUEAK_CHECK=1`. A labelled set of 20 excerpts, 10 of
 * them hits from this spectral detector (including ~1.6 kHz tones and the
 * 393/409 Hz hits), had 0 true squeaks. The notch was cutting normal speech.
 *
 * When the check is on, detection is per 10 ms frame on an 11 kHz copy: the
 * strongest spectral peak between 150 Hz and 4 kHz must sit above
 * `squeakMinHz` and stand 12 dB clear of every other peak, for 90–400 ms.
 * Repair notches that tone out of just those milliseconds.
 */

export type VoicePitchProfile = {
  medianHz: number;
  p5Hz: number;
  p95Hz: number;
  p99Hz: number;
  /** F0 spread in semitones around the median (octave errors dropped). */
  stdSemitones: number;
  voicedFrames: number;
};

export type SqueakSpan = {
  startSec: number;
  endSec: number;
  freqHz: number;
  marginDb: number;
  levelDb: number;
};

/** Analysis rate for detection and pitch. Covers the 150 Hz–4 kHz band. */
export const SQUEAK_ANALYSIS_RATE = 11_025;
const FRAME_SEC = 0.06;
const HOP_SEC = 0.01;
const FFT_SIZE = 2048;
const BAND_LO_HZ = 150;
const BAND_HI_HZ = 4000;
const PEAK_SPACING_HZ = 35;
const MIN_FRAMES = 4;
const MAX_FRAMES = 40;
const GATE_DB = -45;
/** A clear tone in a quiet tail, or a very clear tone anywhere. */
const QUIET_MARGIN_DB = 12;
const QUIET_LEVEL_DB = -8;
const LOUD_MARGIN_DB = 16;

/** Frequency a tone must exceed to be outside the speaker's own range. */
export function squeakMinHz(profile: Pick<VoicePitchProfile, "medianHz" | "p99Hz">): number {
  return Math.max(3 * profile.medianHz, 1.5 * profile.p99Hz);
}

// ---------------------------------------------------------------- DSP bits

/** Windowed-sinc low-pass + decimation to roughly `targetRate`. */
export function downsample(
  pcm: Float32Array,
  sampleRate: number,
  targetRate = SQUEAK_ANALYSIS_RATE
): { pcm: Float32Array; sampleRate: number } {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  if (factor === 1) return { pcm, sampleRate };
  const taps = 8 * factor + 1;
  const half = (taps - 1) / 2;
  const cutoff = 0.45 / factor;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i]! /= sum;
  const outLen = Math.floor(pcm.length / factor);
  const out = new Float32Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const center = o * factor;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const idx = center + k - half;
      if (idx >= 0 && idx < pcm.length) acc += pcm[idx]! * h[k]!;
    }
    out[o] = acc;
  }
  return { pcm: out, sampleRate: sampleRate / factor };
}

/** In-place radix-2 complex FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

// ------------------------------------------------------------- detection

/**
 * Squeak spans in `pcm` (any rate; analysed at ~11 kHz). `minHz` comes
 * from the reference speaker's pitch profile via {@link squeakMinHz}.
 */
export function detectSqueaks(
  pcm: Float32Array,
  sampleRate: number,
  minHz: number
): SqueakSpan[] {
  const { pcm: x, sampleRate: sr } = downsample(pcm, sampleRate);
  const L = Math.round(FRAME_SEC * sr);
  const hop = Math.round(HOP_SEC * sr);
  if (x.length < L) return [];
  const frames = Math.floor((x.length - L) / hop) + 1;
  const rms = new Float64Array(frames);
  for (let k = 0; k < frames; k++) {
    let s = 0;
    const o = k * hop;
    for (let i = 0; i < L; i++) s += x[o + i]! * x[o + i]!;
    rms[k] = Math.sqrt(s / L);
  }
  const ref = percentile(Array.from(rms).sort((a, b) => a - b), 90) || 1e-9;
  const win = new Float64Array(L);
  for (let i = 0; i < L; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1));
  const binHz = sr / FFT_SIZE;
  const lo = Math.ceil(BAND_LO_HZ / binHz);
  const hi = Math.min(FFT_SIZE / 2 - 1, Math.floor(BAND_HI_HZ / binHz));
  const spacing = Math.max(1, Math.round(PEAK_SPACING_HZ / binHz));
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const db = new Float64Array(hi + 2);

  type Hit = { freq: number; margin: number; level: number } | null;
  const hits: Hit[] = new Array(frames).fill(null);
  for (let k = 0; k < frames; k++) {
    const level = 20 * Math.log10(rms[k]! / ref + 1e-12);
    if (level < GATE_DB) continue;
    re.fill(0);
    im.fill(0);
    const o = k * hop;
    for (let i = 0; i < L; i++) re[i] = x[o + i]! * win[i]!;
    fft(re, im);
    for (let b = lo - 1; b <= hi + 1; b++) {
      db[b] = 10 * Math.log10(re[b]! * re[b]! + im[b]! * im[b]! + 1e-18);
    }
    let top = -1;
    for (let b = lo; b <= hi; b++) {
      if (db[b]! >= db[b - 1]! && db[b]! >= db[b + 1]! && (top < 0 || db[b]! > db[top]!)) top = b;
    }
    if (top < 0 || top * binHz < minHz) continue;
    let second = -Infinity;
    for (let b = lo; b <= hi; b++) {
      if (Math.abs(b - top) < spacing) continue;
      if (db[b]! >= db[b - 1]! && db[b]! >= db[b + 1]! && db[b]! > second) second = db[b]!;
    }
    const margin = db[top]! - second;
    if ((margin >= QUIET_MARGIN_DB && level <= QUIET_LEVEL_DB) || margin >= LOUD_MARGIN_DB) {
      hits[k] = { freq: top * binHz, margin, level };
    }
  }

  const spans: SqueakSpan[] = [];
  for (let k = 0; k < frames; ) {
    if (!hits[k]) {
      k++;
      continue;
    }
    let j = k;
    while (j + 1 < frames && hits[j + 1]) j++;
    const n = j - k + 1;
    if (n >= MIN_FRAMES && n <= MAX_FRAMES) {
      const run = hits.slice(k, j + 1) as NonNullable<Hit>[];
      const freqs = run.map((h) => h.freq).sort((a, b) => a - b);
      spans.push({
        startSec: (k * hop) / sr,
        endSec: (j * hop + L) / sr,
        freqHz: freqs[Math.floor(freqs.length / 2)]!,
        marginDb: Math.max(...run.map((h) => h.margin)),
        levelDb: Math.max(...run.map((h) => h.level)),
      });
    }
    k = j + 1;
  }
  return spans;
}

/** Squeaks per minute of audio. */
export function squeakRate(spans: SqueakSpan[], durationSec: number): number {
  return durationSec > 0 ? (spans.length / durationSec) * 60 : 0;
}

// ---------------------------------------------------------------- pitch

/**
 * YIN pitch profile (50–600 Hz) of a speaker reference. Frames more than
 * ~0.8 octave from the median are treated as tracking errors for the
 * spread, but kept in the percentiles so an animated speaker's real range
 * still raises `p99Hz`.
 */
export function estimatePitchProfile(
  pcm: Float32Array,
  sampleRate: number,
  opts: { hopSec?: number } = {}
): VoicePitchProfile | null {
  const { pcm: x, sampleRate: sr } = downsample(pcm, sampleRate);
  const W = Math.round(0.04 * sr);
  const hop = Math.round((opts.hopSec ?? 0.02) * sr);
  const tauMin = Math.floor(sr / 600);
  const tauMax = Math.ceil(sr / 50);
  if (x.length < W + tauMax + 1) return null;
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  const gate = peak * 0.02;
  const d = new Float64Array(tauMax + 1);
  const f0s: number[] = [];
  for (let o = 0; o + W + tauMax < x.length; o += hop) {
    let e = 0;
    for (let i = 0; i < W; i++) e = Math.max(e, Math.abs(x[o + i]!));
    if (e < gate) continue;
    d[0] = 1;
    let running = 0;
    let found = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const diff = x[o + i]! - x[o + i + tau]!;
        s += diff * diff;
      }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau]! < 0.15) {
        while (tau + 1 <= tauMax && d[tau + 1]! < d[tau]!) tau++;
        found = tau;
        break;
      }
    }
    if (found < 0) continue;
    const a = d[found - 1] ?? d[found]!;
    const b = d[found]!;
    const c = d[found + 1] ?? d[found]!;
    const denom = a - 2 * b + c;
    const refined = denom !== 0 ? found + (0.5 * (a - c)) / denom : found;
    f0s.push(sr / refined);
  }
  if (f0s.length < 20) return null;
  const sorted = [...f0s].sort((p, q) => p - q);
  const median = percentile(sorted, 50);
  const core = sorted.filter((f) => f > median / 1.6 && f < median * 1.6);
  const st = core.map((f) => 12 * Math.log2(f / median));
  const mean = st.reduce((s, v) => s + v, 0) / st.length;
  const std = Math.sqrt(st.reduce((s, v) => s + (v - mean) * (v - mean), 0) / st.length);
  return {
    medianHz: median,
    p5Hz: percentile(sorted, 5),
    p95Hz: percentile(sorted, 95),
    p99Hz: percentile(sorted, 99),
    stdSemitones: std,
    voicedFrames: f0s.length,
  };
}

// ---------------------------------------------------------------- repair

function notchCoefficients(freq: number, sampleRate: number, q: number) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cos) / a0,
    b2: 1 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

const REPAIR_PAD_SEC = 0.02;
const REPAIR_FADE_SEC = 0.015;
const REPAIR_PREROLL_SEC = 0.05;
const REPAIR_Q = 2;

/**
 * Copy of `pcm` with each span's tone notched out (two cascaded notches),
 * crossfaded in and out over 15 ms. Samples outside the spans are untouched.
 */
export function repairSqueaks(
  pcm: Float32Array,
  sampleRate: number,
  spans: SqueakSpan[]
): Float32Array {
  const out = Float32Array.from(pcm);
  const fade = Math.max(1, Math.round(REPAIR_FADE_SEC * sampleRate));
  for (const span of spans) {
    const start = Math.max(0, Math.floor((span.startSec - REPAIR_PAD_SEC) * sampleRate));
    const end = Math.min(pcm.length, Math.ceil((span.endSec + REPAIR_PAD_SEC) * sampleRate));
    if (end - start < 2 * fade) continue;
    const pre = Math.max(0, start - Math.round(REPAIR_PREROLL_SEC * sampleRate));
    const c = notchCoefficients(span.freqHz, sampleRate, REPAIR_Q);
    const state = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = pre; i < end; i++) {
      // Stage 1
      const x0 = pcm[i]!;
      const y1 = c.b0 * x0 + c.b1 * state[0]! + c.b2 * state[1]! - c.a1 * state[2]! - c.a2 * state[3]!;
      state[1] = state[0]!;
      state[0] = x0;
      state[3] = state[2]!;
      state[2] = y1;
      // Stage 2
      const y2 = c.b0 * y1 + c.b1 * state[4]! + c.b2 * state[5]! - c.a1 * state[6]! - c.a2 * state[7]!;
      state[5] = state[4]!;
      state[4] = y1;
      state[7] = state[6]!;
      state[6] = y2;
      if (i < start) continue;
      let wet = 1;
      if (i - start < fade) wet = 0.5 - 0.5 * Math.cos((Math.PI * (i - start)) / fade);
      else if (end - 1 - i < fade) wet = 0.5 - 0.5 * Math.cos((Math.PI * (end - 1 - i)) / fade);
      out[i] = (1 - wet) * out[i]! + wet * y2;
    }
  }
  return out;
}
