/**
 * Find the Modal function-call id while the HTTP body is still outstanding.
 *
 * The web endpoint does not send `x-modal-function-call-id` until the
 * response headers, and a restore-budget abort throws before those headers.
 * The request carries `echo_call_tag`. A listing that contains that tag, or
 * the job id when this book has exactly one open call, is stored on the
 * flight before the wait ends. A failed listing leaves the id unset and
 * does not clear `still_live`.
 */

import { spawn } from "node:child_process";
import {
  matchListedCall,
  noteFlightTag,
  remoteFlights,
  setFlightCallId,
  type ListedCall,
} from "@/lib/remote/layer";

export type S2CallQuery = { tag: string; jobId?: string; flightKey: string };

let lister: ((query: S2CallQuery) => Promise<ListedCall[]>) | null = null;

export function setS2CallListerForTests(
  fn: ((query: S2CallQuery) => Promise<ListedCall[]>) | null
): void {
  lister = fn;
}

export function s2CallTag(jobId: string, sections: string[]): string {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `echo:${jobId}:${sections.join(".")}:${nonce}`;
}

async function defaultList(): Promise<ListedCall[]> {
  if (process.env.VITEST || !process.env.MODAL_TOKEN_ID) return [];
  const child = spawn(
    "python3",
    ["scripts/s2/drain-stuck-calls.py", "--list-json", "--profile", "ntemusejoel"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    out += String(chunk);
  });
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0) return [];
  try {
    const parsed = JSON.parse(out) as ListedCall[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function pollOnce(query: S2CallQuery): Promise<string | null> {
  try {
    const rows = lister ? await lister(query) : await defaultList();
    const claimed = new Set(
      remoteFlights()
        .map((flight) => flight.callId)
        .filter((id): id is string => Boolean(id))
    );
    return matchListedCall(rows, { tag: query.tag, jobId: query.jobId, claimed });
  } catch {
    return null;
  }
}

/**
 * Poll until the call id is known, the caller stops the watch, or (in
 * tests) the single listing returns. The id is written onto the flight
 * as soon as it matches, which is before `fetch` resolves.
 */
export function startS2CallWatch(query: S2CallQuery): {
  done: Promise<string | null>;
  stop: () => void;
} {
  if (query.flightKey && query.tag) noteFlightTag(query.flightKey, query.tag);
  let resolve: (id: string | null) => void = () => {};
  const done = new Promise<string | null>((res) => {
    resolve = res;
  });
  let settled = false;
  let found: string | null = null;
  const finish = (id: string | null) => {
    if (settled) return;
    settled = true;
    const value = id ?? found;
    if (value) setFlightCallId(query.flightKey, value);
    resolve(value);
  };
  let inflight = pollOnce(query);
  const take = (id: string | null) => {
    if (!id) return;
    found = id;
    finish(id);
  };
  void inflight.then(take);
  if (process.env.VITEST) {
    void inflight.then((id) => finish(id));
    return {
      done,
      stop: () => {
        void inflight.then((id) => finish(id));
      },
    };
  }
  const timer = setInterval(() => {
    if (settled) return;
    inflight = pollOnce(query);
    void inflight.then(take);
  }, 2_000);
  return {
    done,
    stop: () => {
      clearInterval(timer);
      void inflight.then((id) => finish(id ?? found));
    },
  };
}
