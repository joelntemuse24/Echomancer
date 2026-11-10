"use client";

import { useSyncExternalStore } from "react";

/**
 * The query string, without `useSearchParams`.
 *
 * That hook suspends up to the nearest boundary while a page is static.
 * Voices and the player wrapped the whole screen in that boundary and
 * showed a spinner, so the click's first paint was a spinner even when
 * the data was already here.
 *
 * On the server and during hydration the string is empty, which matches
 * the HTML. A client navigation reads `location.search` on the first
 * render. `replaceState` (the clone tab) and back/forward notify
 * subscribers, because `popstate` alone does not fire for those.
 */

const listeners = new Set<() => void>();
let patched = false;

function emitSearch() {
  for (const listener of listeners) listener();
}

function patchHistory(): void {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>) => {
    push(...args);
    emitSearch();
  };
  history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    replace(...args);
    emitSearch();
  };
  window.addEventListener("popstate", emitSearch);
}

export function subscribeClientSearch(listener: () => void): () => void {
  patchHistory();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readClientSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/** Test hook. The history patch is process-wide; the next subscribe rebinds it. */
export function resetClientSearchForTests(): void {
  listeners.clear();
  patched = false;
}

export function useClientSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribeClientSearch,
    readClientSearch,
    () => ""
  );
  return new URLSearchParams(search);
}
