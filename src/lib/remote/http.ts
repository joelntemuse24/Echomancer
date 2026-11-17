/**
 * One fetch admission for Fish, Kokoro, and Modal CPU.
 *
 * A book section (or a CPU task) cannot have two of these in flight. A
 * timeout leaves the flight still_live so the retry loop cannot start a
 * second provider call. A completed HTTP response, including 429, is
 * terminal and a later attempt may proceed.
 */

import { RemoteCallRefused, runRemoteCall, type RemotePath, type RemoteProvider } from "@/lib/remote/layer";

export function remoteSectionKey(section: string | number | undefined, text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const piece = (hash >>> 0).toString(36);
  return `${section ?? "x"}:${piece}`;
}

export async function remoteFetch(opts: {
  provider: RemoteProvider;
  path?: RemotePath;
  jobId?: string;
  section: string;
  timeoutMs: number;
  estCostUsd?: number;
  url: string;
  init: RequestInit;
}): Promise<Response> {
  return runRemoteCall({
    provider: opts.provider,
    path: opts.path ?? "book",
    jobId: opts.jobId,
    sections: [opts.section],
    timeoutMs: opts.timeoutMs,
    estCostUsd: opts.estCostUsd,
    signal: opts.init.signal ?? undefined,
    execute: ({ signal }) =>
      fetch(opts.url, {
        ...opts.init,
        signal,
      }),
  });
}

export function remoteCallStillLive(err: unknown): boolean {
  if (err instanceof RemoteCallRefused) return true;
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}
