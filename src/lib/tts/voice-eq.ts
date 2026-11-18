/**
 * The one voice curve for section mastering.
 *
 * Podcast (stock, Kokoro/Drew/Walter/George, Fish, Paradee) and S2 clone
 * graphs both insert `voiceEqStageAf()` immediately before loudnorm, in the
 * pass those graphs already run. Nothing else copies the bands.
 *
 * `TTS_VOICE_EQ=0` (also `false` / `off`) omits the stage. Unset is on.
 * `TTS_MASTER_SKIP=1` never reaches this stage: that path is loudnorm only.
 *
 * A shelf's `f` is the transition midpoint, so a lowshelf written at 63 Hz
 * (or a highshelf at 16 kHz) only reaches about half of −4 dB there. The
 * corners below are the ones that put −4 dB at those centres. Peaking Q is
 * 1.6 so octave-spaced neighbours stay inside 1 dB of the named gain. The
 * 250 Hz band is 0 dB and is omitted. Measured on ffmpeg 6 at 44.1 kHz.
 */

export const VOICE_EQ_SAMPLE_RATE = 44_100;
/** Peaking width. About one octave, narrow enough that neighbours do not stack past 1 dB. */
export const VOICE_EQ_PEAK_Q = 1.6;

export type VoiceEqKind = "lowshelf" | "highshelf" | "peaking";

export type VoiceEqBand = {
  kind: VoiceEqKind;
  /** ffmpeg filter frequency. Shelf corners differ from the band centre. */
  frequency: number;
  gainDb: number;
  q: number;
  /** The centre the gain is aimed at. */
  centreHz: number;
};

export const VOICE_EQ_BANDS: readonly VoiceEqBand[] = [
  { kind: "lowshelf", frequency: 80, gainDb: -4, q: 1, centreHz: 63 },
  { kind: "peaking", frequency: 125, gainDb: -2, q: VOICE_EQ_PEAK_Q, centreHz: 125 },
  { kind: "peaking", frequency: 500, gainDb: 1, q: VOICE_EQ_PEAK_Q, centreHz: 500 },
  { kind: "peaking", frequency: 1000, gainDb: 2, q: VOICE_EQ_PEAK_Q, centreHz: 1000 },
  { kind: "peaking", frequency: 2000, gainDb: 3, q: VOICE_EQ_PEAK_Q, centreHz: 2000 },
  { kind: "peaking", frequency: 4000, gainDb: 1, q: VOICE_EQ_PEAK_Q, centreHz: 4000 },
  { kind: "peaking", frequency: 8000, gainDb: -3, q: VOICE_EQ_PEAK_Q, centreHz: 8000 },
  { kind: "highshelf", frequency: 11000, gainDb: -4, q: 0.707, centreHz: 16000 },
];

export function voiceEqEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TTS_VOICE_EQ?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function bandFilter(band: VoiceEqBand): string {
  const width = `f=${band.frequency}:t=q:w=${band.q}:g=${band.gainDb}`;
  if (band.kind === "peaking") return `equalizer=${width}`;
  return `${band.kind}=${width}`;
}

/** The curve alone. Empty when the flag is off. */
export function voiceEqAf(env: NodeJS.ProcessEnv = process.env): string {
  if (!voiceEqEnabled(env)) return "";
  return VOICE_EQ_BANDS.map(bandFilter).join(",");
}

/**
 * Resample, then the curve.
 *
 * Provider audio is often 24 kHz. A 16 kHz shelf does not exist below
 * that Nyquist, and the encode's `-ar` runs after `-af`. This resample
 * is inside the same graph, so the curve is applied at 44.1 kHz and the
 * encode does not add a second pass. Empty when the flag is off, which
 * leaves the surrounding chain byte-for-byte as it was.
 */
export function voiceEqStageAf(env: NodeJS.ProcessEnv = process.env): string {
  const eq = voiceEqAf(env);
  if (!eq) return "";
  return `aresample=${VOICE_EQ_SAMPLE_RATE},${eq}`;
}
