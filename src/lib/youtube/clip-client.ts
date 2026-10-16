import { CLIP_CLIENT_WAIT_MS } from "@/lib/youtube/clip-policy";
import type { CloneQualityRisk } from "@/lib/upload-client";

export type PendingClip = {
  id: string;
  ownerContext: string;
  startedAt: number;
};

export type ClipStatus = {
  ownerContext?: string;
  title?: string | null;
  source?: { videoId: string; startSec: number; endSec: number };
  status?: string;
  phase?: string | null;
  error?: string | null;
  catalogVoiceId?: string | null;
  downloadUrl?: string | null;
  risk?: CloneQualityRisk | null;
  quality?: CloneQualityRisk | null;
  uploadId?: string | null;
  requiresReview?: boolean;
};

const PENDING_KEY = "echomancer.pending-youtube-clip";

export function readPendingClip(ownerContext: string): PendingClip | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null") as PendingClip | null;
    if (!value || value.ownerContext !== ownerContext || typeof value.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) || !Number.isFinite(value.startedAt) ||
        value.startedAt > Date.now() || Date.now() - value.startedAt > CLIP_CLIENT_WAIT_MS) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function storePendingClip(value: PendingClip | null): void {
  try {
    if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Recovery is optional when browser storage is disabled.
  }
}

/** Bound both headers and body reads; cancellation also ends an in-flight request. */
export async function clipJson<T>(url: string, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = 15_000): Promise<{ response: Response; data: T }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, Math.max(1, timeoutMs));
  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
    const data = await response.json() as T;
    return { response, data };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function clipPollDelay(attempt: number): number {
  return Math.min(10_000, 1500 * 1.5 ** Math.min(attempt, 10));
}

/** Visibility changes wake the wait, so returning to a tab checks immediately. */
export function waitForClipPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    document.addEventListener("visibilitychange", finish);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
