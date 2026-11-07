/**
 * Shared ceiling for the heavy local CPU work that already runs on the
 * take-home box. This is not a separate CPU service and it does not raise
 * how many books a worker will run. The caps match today's local limits:
 * one ffmpeg per CPU, and local Whisper up to the Edge section fan-out.
 * A second process waits for a free permit instead of stacking another
 * ffmpeg or Whisper beside them. Extract children stay on their own
 * process-local pool; moving those off this box is a later change.
 */

import { availableParallelism } from "node:os";
import {
  holdProviderSlot,
  type HeldProviderSlot,
} from "@/lib/tts/provider-slots";
import { currentTakehomeLease } from "@/lib/tts/takehome-lease-context";

export function ffmpegCpuCap(): number {
  return Math.max(1, availableParallelism());
}

/** Matches the Edge section fan-out so one worker's QA still all get a permit. */
export function whisperCpuCap(): number {
  const raw = Number(process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY || "8");
  const chosen = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
  return Math.max(1, Math.min(16, chosen));
}

/**
 * `null` means the shared cap stayed full for the whole wait: the caller
 * stores the take unmastered, or skips QA, and does not speak the section
 * again. `"unavailable"` means the permit table itself failed: one process
 * keeps doing the work, because a missing table must not drop mastering.
 */
export async function tryCpuSlot(
  kind: "ffmpeg" | "whisper",
  maxWaitMs: number
): Promise<HeldProviderSlot | "unavailable" | null> {
  const cap = kind === "ffmpeg" ? ffmpegCpuCap() : whisperCpuCap();
  const lease = currentTakehomeLease();
  try {
    return await holdProviderSlot({
      provider: `cpu-${kind}`,
      cap,
      ownerToken: lease?.token ?? `cpu_${crypto.randomUUID()}`,
      jobId: lease?.jobId ?? null,
      ttlSeconds: 90,
      maxWaitMs,
    });
  } catch (err) {
    console.warn(
      `[cpu] ${kind} permit unavailable:`,
      err instanceof Error ? err.message : err
    );
    return "unavailable";
  }
}
