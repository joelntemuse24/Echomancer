/**
 * Per-host ceiling for local CPU work. The provider name includes the
 * host id, so a second machine does not wait on this machine's permits
 * and two processes on this machine share one cap. Modal CPU containers
 * set `CPU_HOST_ID` to the container id and use the same table.
 *
 * `null` means this host stayed full. The caller queues the task and
 * does not publish. `"unavailable"` means the permit table failed: the
 * process still does the work, because a missing table must not drop it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism, hostname } from "node:os";
import {
  holdProviderSlot,
  type HeldProviderSlot,
} from "@/lib/tts/provider-slots";
import { currentTakehomeLease } from "@/lib/tts/takehome-lease-context";

const cpuTaskScope = new AsyncLocalStorage<true>();

export function cpuHostId(): string {
  const raw = (process.env.CPU_HOST_ID || hostname() || "local").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return (cleaned || "local").slice(0, 80);
}

export function runInsideCpuTask<T>(fn: () => Promise<T>): Promise<T> {
  return cpuTaskScope.run(true, fn);
}

/** True while a CPU task already holds this host's permit. */
export function insideCpuTask(): boolean {
  return cpuTaskScope.getStore() === true;
}

export function ffmpegCpuCap(): number {
  const override = Number(process.env.CPU_HOST_CONCURRENCY || "");
  if (Number.isFinite(override) && override >= 1) {
    return Math.min(32, Math.floor(override));
  }
  return Math.max(1, availableParallelism());
}

/** Matches the Edge section fan-out so one worker's QA can still get a permit. */
export function whisperCpuCap(): number {
  const raw = Number(process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY || "8");
  const chosen = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
  return Math.max(1, Math.min(16, chosen));
}

export function extractCpuCap(): number {
  const raw = Number(process.env.EXTRACT_NODE_CONCURRENCY || "1");
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(4, Math.floor(raw));
}

export type LocalCpuKind = "ffmpeg" | "whisper" | "extract";

export function cpuSlotProvider(kind: LocalCpuKind, host = cpuHostId()): string {
  return `cpu-host:${host}:${kind}`;
}

/**
 * One permit on this host. Does not cap any other host, and does not
 * cap a provider account (those stay on `provider_slots` under the
 * provider's own name).
 */
export async function tryCpuSlot(
  kind: LocalCpuKind,
  maxWaitMs: number
): Promise<HeldProviderSlot | "unavailable" | null> {
  const cap =
    kind === "ffmpeg" ? ffmpegCpuCap() : kind === "whisper" ? whisperCpuCap() : extractCpuCap();
  const lease = currentTakehomeLease();
  try {
    return await holdProviderSlot({
      provider: cpuSlotProvider(kind),
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
