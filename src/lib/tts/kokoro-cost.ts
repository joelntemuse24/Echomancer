/**
 * Per-book cost model for the Kokoro CPU fleet and the Modal CPU app.
 *
 * Rates are Modal's published CPU prices named by the cost audit
 * ($0.04716 / physical core-hour, $0.007992 / GiB-hour). Nothing here is an
 * invoice. Container shape is the code: Kokoro is 2 cores and 6 GiB,
 * `echomancer-cpu` is 2 cores and 4 GiB.
 *
 * Wall time for equal section lengths is one parallel boot plus
 * `ceil(sections / lanes)` section-times. `lanesForSameWaves` keeps that
 * wave count, so the model wall does not change when the lane count drops.
 * A container that finishes a wave early is billed through its own last
 * section, then the idle window — not through the slowest lane.
 */

import { lanesForSameWaves } from "@/lib/tts/kokoro-pool";

/** Published Modal CPU price. Not read from an account. */
export const MODAL_CORE_USD_PER_HOUR = 0.04716;
export const MODAL_GIB_USD_PER_HOUR = 0.007992;

export const KOKORO_CONTAINER = { cores: 2, gib: 6 } as const;
export const CPU_APP_CONTAINER = { cores: 2, gib: 4 } as const;

/** Production Drew harbor measurement, audio seconds / wall seconds. */
export const DREW_RTF_MEASURED = { low: 2.06, high: 2.41 } as const;

export function containerUsdPerSecond(cores: number, gib: number): number {
  return (cores * MODAL_CORE_USD_PER_HOUR + gib * MODAL_GIB_USD_PER_HOUR) / 3600;
}

export function kokoroUsdPerSecond(): number {
  return containerUsdPerSecond(KOKORO_CONTAINER.cores, KOKORO_CONTAINER.gib);
}

export function cpuAppUsdPerSecond(): number {
  return containerUsdPerSecond(CPU_APP_CONTAINER.cores, CPU_APP_CONTAINER.gib);
}

export interface KokoroSpeechModel {
  /** Sections in the book. One section is one container call. */
  sections: number;
  lanes: number;
  /** Uniform audio length of one section, seconds. */
  sectionAudioSec: number;
  /** Audio / wall on a container whose model is already loaded. */
  rtf: number;
  /** Cold model load, billed on every container, parallel across lanes. */
  bootSec: number;
  /** `scaledown_window` after that container's last section. */
  idleSec: number;
}

export interface SpeechBill {
  waves: number;
  /** Slowest lane: boot plus one section-time per wave. */
  wallSec: number;
  /** Sum of each lane's boot + its own sections + its idle tail. */
  containerSec: number;
  usd: number;
}

export function modelKokoroSpeech(input: KokoroSpeechModel): SpeechBill {
  const sections = Math.max(0, Math.floor(input.sections));
  const lanes = Math.max(1, Math.floor(input.lanes));
  const rtf = input.rtf > 0 ? input.rtf : DREW_RTF_MEASURED.low;
  const sectionWall = input.sectionAudioSec > 0 ? input.sectionAudioSec / rtf : 0;
  const waves = sections < 1 ? 0 : Math.ceil(sections / lanes);
  const remainder = sections % lanes;
  let containerSec = 0;
  for (let lane = 0; lane < lanes; lane++) {
    const count =
      sections < 1 ? 0 : remainder === 0 ? waves : lane < remainder ? waves : waves - 1;
    if (count < 1) continue;
    containerSec += input.bootSec + count * sectionWall + input.idleSec;
  }
  return {
    waves,
    wallSec: input.bootSec + waves * sectionWall,
    containerSec,
    usd: containerSec * kokoroUsdPerSecond(),
  };
}

/**
 * Idle tails on `echomancer-cpu`. One tail per container that was used,
 * not per task: a warm container masters many sections and then idles once.
 *
 * The short-book audit's ~$0.05 of scaledown is about five of these tails
 * at 300s (extract, a few masters, concat). Whisper is not in this bill:
 * the inline check runs on the take-home VM, and Kokoro / S2 no longer
 * enqueue a whisper task.
 */
export function modelCpuIdleTails(containers: number, idleSec: number): {
  containerSec: number;
  usd: number;
} {
  const n = Math.max(0, Math.floor(containers));
  const containerSec = n * Math.max(0, idleSec);
  return { containerSec, usd: containerSec * cpuAppUsdPerSecond() };
}

/** Lane count before and after `lanesForSameWaves`, for one book alone on the fleet. */
export function kokoroLanePlan(sections: number, fleet = 16): { before: number; after: number } {
  const count = Math.max(0, Math.floor(sections));
  const before = Math.max(1, Math.min(fleet, count || 1));
  return { before, after: lanesForSameWaves(count, before) };
}
