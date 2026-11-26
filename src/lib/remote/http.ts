/**
 * One fetch admission for Fish, Kokoro, and Modal CPU.
 *
 * A completed HTTP response, including 429, is retryable. A 404 or 5xx is a
 * failure, and a workspace refusal throws. An abort
 * of these HTTP calls is also retryable: the section budget is the clock,
 * and this wrapper does not add another one. still_live is reserved for a
 * Modal spawn whose function-call id may still be running.
 */

import {
  modalPlatformRefusal,
  modalWorkspaceDisabledActive,
  ModalWorkspaceDisabledError,
  redactModalAccount,
} from "@/lib/modal/workspace-disabled";
import { RemoteCallRefused, runRemoteCall, type RemotePath, type RemoteProvider, type RemoteSettlement } from "@/lib/remote/layer";

export function remoteSectionKey(section: string | number | undefined, text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const piece = (hash >>> 0).toString(36);
  return `${section ?? "x"}:${piece}`;
}

function settleHttpResponse(status: number, body: string): RemoteSettlement | null {
  if (status !== 404 && status < 500) return null;
  const refused = modalPlatformRefusal(status, body);
  if (refused) {
    console.warn(
      `[remote] workspace disabled http=${status} ${redactModalAccount(body).slice(0, 160)}`
    );
    return { outcome: "failure", release: true, error: refused };
  }
  const platform = status === 404 || /modal-http/i.test(body);
  return { outcome: "failure", release: platform };
}

export async function remoteFetch(opts: {
  provider: RemoteProvider;
  path?: RemotePath;
  jobId?: string;
  section: string;
  estCostUsd?: number;
  estMs?: number;
  url: string;
  init: RequestInit;
}): Promise<Response> {
  if (
    (opts.provider === "kokoro" || opts.provider === "modal-cpu") &&
    modalWorkspaceDisabledActive()
  ) {
    throw new ModalWorkspaceDisabledError();
  }
  return runRemoteCall({
    provider: opts.provider,
    path: opts.path ?? "book",
    jobId: opts.jobId,
    sections: [opts.section],
    estCostUsd: opts.estCostUsd,
    estMs: opts.estMs,
    signal: opts.init.signal ?? undefined,
    abortSettlesAs: "failure",
    settle: async (response) => {
      if (response.ok || (response.status !== 404 && response.status < 500)) return null;
      const body = await response.clone().text().catch(() => "");
      return settleHttpResponse(response.status, body);
    },
    execute: async ({ signal, setCallId }) => {
      const response = await fetch(opts.url, {
        ...opts.init,
        signal,
      });
      const callId =
        response.headers.get("x-modal-function-call-id") ||
        response.headers.get("modal-function-call-id");
      if (callId) setCallId(callId);
      return response;
    },
  });
}

/** budget and cancelled never reached a container. in_flight may still be running. */
export function remoteCallRefusal(
  err: unknown
): "cancelled" | "budget" | "in_flight" | null {
  return err instanceof RemoteCallRefused ? err.code : null;
}

export function remoteCallStillLive(err: unknown): boolean {
  return remoteCallRefusal(err) === "in_flight";
}
