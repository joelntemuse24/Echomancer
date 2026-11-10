"use client";

import { useEffect, useState } from "react";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { resetScreenCache } from "@/lib/nav/screen-cache";

/** Identity plus the operator flag and a session key from `GET /api/viewer`. */
export type ViewerSnapshot = ViewerIdentity & { markup: boolean; key: string };

const VIEWER_FRESH_MS = 60_000;
const CHANNEL = "ec-auth";

let cached: ViewerSnapshot | null = null;
let cachedAt = 0;
let seenKey: string | null = null;
let inflight: Promise<ViewerSnapshot> | null = null;
let announced = false;
let watching = false;
let requestSeq = 0;
const subscribers = new Set<() => void>();

function emit() {
  for (const subscriber of subscribers) subscriber();
}

export function peekViewerIdentity(): ViewerSnapshot | null {
  if (typeof window === "undefined" && process.env.VITEST !== "true") return null;
  return cached;
}

function publishAuthChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: "check" });
    channel.close();
  } catch {
    // A browser without the channel still revalidates on focus.
  }
}

function adopt(data: ViewerSnapshot): ViewerSnapshot {
  if (seenKey != null && seenKey !== data.key) resetScreenCache();
  seenKey = data.key;
  cached = data;
  cachedAt = Date.now();
  if (!announced) {
    announced = true;
    publishAuthChange();
  }
  return data;
}

/**
 * One in-flight read for the header. A warm tab keeps it for a minute.
 * Focus, a visible tab, and a message from another tab ask again. A 503
 * is not stored, so a blip cannot paint Sign in over a signed-in session.
 */
export function loadViewerIdentity(opts?: { force?: boolean }): Promise<ViewerSnapshot> {
  if (cached && !opts?.force && Date.now() - cachedAt < VIEWER_FRESH_MS) {
    return Promise.resolve(cached);
  }
  if (!opts?.force && inflight) return inflight;
  const mine = ++requestSeq;
  const request = fetch("/api/viewer", { headers: { accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as ViewerSnapshot;
      // A slower response from before sign-out must not paint that person again.
      if (mine !== requestSeq) return peekViewerIdentity() ?? data;
      return adopt(data);
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/** Ask other tabs to re-read the session. They do not announce again. */
export function publishAuthChangeFromHere(): void {
  publishAuthChange();
}

function dropViewerSnapshot(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}

function ensureWatchers(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const revalidate = () => {
    void loadViewerIdentity({ force: true }).then(() => emit());
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") revalidate();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", revalidate);
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => {
      dropViewerSnapshot();
      emit();
      revalidate();
    };
  } catch {
    // Same as a missing channel on publish.
  }
}

function useViewerSnapshot(): ViewerSnapshot | null {
  const [snapshot, setSnapshot] = useState<ViewerSnapshot | null>(() =>
    peekViewerIdentity()
  );
  useEffect(() => {
    ensureWatchers();
    const pull = () => setSnapshot(peekViewerIdentity());
    subscribers.add(pull);
    void loadViewerIdentity()
      .then(() => {
        if (subscribers.has(pull)) pull();
      })
      .catch(() => {});
    return () => {
      subscribers.delete(pull);
    };
  }, []);
  useEffect(() => {
    if (!snapshot || typeof document === "undefined") return;
    document.documentElement.dataset.auth = snapshot.signedIn ? "in" : "out";
  }, [snapshot]);
  return snapshot;
}

export function useViewerIdentity(): ViewerIdentity | null {
  return useViewerSnapshot();
}

/** True only when this session may see the Voice text link. */
export function useMarkupOperator(): boolean {
  return useViewerSnapshot()?.markup ?? false;
}

export function resetViewerIdentityCache(): void {
  cached = null;
  cachedAt = 0;
  seenKey = null;
  inflight = null;
  announced = false;
  watching = false;
  requestSeq = 0;
  subscribers.clear();
}
