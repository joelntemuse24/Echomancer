"use client";

import { useMemo, useSyncExternalStore } from "react";

/**
 * The query string, without wrapping a whole page in `useSearchParams`.
 *
 * That hook suspends up to the nearest boundary. Voices and the player
 * used to put the boundary around the screen, so the click's first paint
 * was a spinner.
 *
 * The server render and hydration see an empty string, which matches the
 * HTML. On a client navigation Next updates the URL in an insertion effect
 * after the new page has rendered, so the first render can still see the
 * previous page's query. The history wrapper notifies after that effect,
 * on a microtask, and does not schedule an update from inside it.
 * `replaceState` (the clone tab) and back/forward are included because
 * `popstate` alone does not fire for `replaceState`.
 *
 * The wrapper is installed once per document.
 */

const listeners = new Set<() => void>();
let patched = false;
let restoreHistory: (() => void) | null = null;
let emitScheduled = false;

function emitSearch() {
  if (emitScheduled) return;
  emitScheduled = true;
  queueMicrotask(() => {
    emitScheduled = false;
    for (const listener of listeners) listener();
  });
}

function patchHistory(): void {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const wrappedPush = (...args: Parameters<History["pushState"]>) => {
    push(...args);
    emitSearch();
  };
  const wrappedReplace = (...args: Parameters<History["replaceState"]>) => {
    replace(...args);
    emitSearch();
  };
  history.pushState = wrappedPush;
  history.replaceState = wrappedReplace;
  window.addEventListener("popstate", emitSearch);
  restoreHistory = () => {
    if (history.pushState === wrappedPush) history.pushState = push;
    if (history.replaceState === wrappedReplace) history.replaceState = replace;
    window.removeEventListener("popstate", emitSearch);
    patched = false;
    restoreHistory = null;
  };
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

/** Test hook. Restores the document's history methods. */
export function resetClientSearchForTests(): void {
  listeners.clear();
  emitScheduled = false;
  restoreHistory?.();
  patched = false;
}

export function useClientSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribeClientSearch,
    readClientSearch,
    () => ""
  );
  return useMemo(() => new URLSearchParams(search), [search]);
}
