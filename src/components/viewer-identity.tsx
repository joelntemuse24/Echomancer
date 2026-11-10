"use client";

import { useEffect, useState } from "react";
import type { ViewerIdentity } from "@/lib/auth/identity";

/** Identity plus the operator-only Voice text flag from `GET /api/viewer`. */
export type ViewerSnapshot = ViewerIdentity & { markup: boolean };

let cached: ViewerSnapshot | null = null;
let inflight: Promise<ViewerSnapshot> | null = null;

export function peekViewerIdentity(): ViewerSnapshot | null {
  if (typeof window === "undefined" && process.env.VITEST !== "true") return null;
  return cached;
}

/**
 * One in-flight read for the header. A warm tab keeps the result, so moving
 * between Home and the dashboard does not ask again. A full load (sign-in,
 * sign-out) starts a new document and a new cache.
 */
export function loadViewerIdentity(): Promise<ViewerSnapshot> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/viewer", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as ViewerSnapshot;
        cached = data;
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useViewerIdentity(): ViewerIdentity | null {
  const [identity, setIdentity] = useState<ViewerIdentity | null>(() =>
    peekViewerIdentity()
  );
  useEffect(() => {
    let cancel = false;
    loadViewerIdentity()
      .then((value) => {
        if (!cancel) setIdentity(value);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, []);
  return identity;
}

/** True only when this session may see the Voice text link. */
export function useMarkupOperator(): boolean {
  const [markup, setMarkup] = useState(() => peekViewerIdentity()?.markup ?? false);
  useEffect(() => {
    let cancel = false;
    loadViewerIdentity()
      .then((value) => {
        if (!cancel) setMarkup(Boolean(value.markup));
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, []);
  return markup;
}

export function resetViewerIdentityCache(): void {
  cached = null;
  inflight = null;
}
