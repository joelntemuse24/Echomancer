/**
 * Edge and Google whole-book sections do not use the Fish account, so they
 * do not share the Fish fan-out (4, or 5 when nothing live is in flight).
 * Fish and clones stay on {@link takehomeFanoutCap}.
 */

export const EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT = 8;
export const EDGE_GOOGLE_SECTION_CONCURRENCY_MAX = 8;

export function isEdgeOrGoogleProvider(provider?: string | null): boolean {
  const id = provider?.toLowerCase() || "";
  return id === "edge" || id === "google";
}

/** Parallel sections for one Edge or Google book. Clamped to 1–8. Default 8. */
export function edgeGoogleSectionConcurrency(): number {
  const raw = Number(process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY);
  const chosen =
    Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT;
  return Math.max(
    1,
    Math.min(EDGE_GOOGLE_SECTION_CONCURRENCY_MAX, chosen)
  );
}

export function isUpstreamThrottle(message: string): boolean {
  return /\b(?:429|503)\b/.test(message) || /too many requests|rate limit/i.test(message);
}

export type InFlightGate = {
  acquire: () => Promise<void>;
  release: () => void;
  shrinkTo: (limit: number) => void;
};

/** Caps how many section requests run at once. `shrinkTo` applies to the next acquire. */
export function createInFlightGate(limit: number): InFlightGate {
  let cap = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const waiters: Array<() => void> = [];
  const pump = () => {
    while (waiters.length > 0 && active < cap) {
      active += 1;
      waiters.shift()?.();
    }
  };
  return {
    async acquire() {
      if (active < cap) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    release() {
      active = Math.max(0, active - 1);
      pump();
    },
    shrinkTo(next: number) {
      const n = Math.max(1, Math.floor(next) || 1);
      if (n < cap) cap = n;
    },
  };
}

let throttledCap: number | null = null;
let liveGate: InFlightGate | null = null;

export function bindEdgeGoogleGate(gate: InFlightGate | null): void {
  liveGate = gate;
}

/** Configured concurrency, halved after each Edge/Google 429 or 503. */
export function edgeGoogleInFlightLimit(): number {
  const configured = edgeGoogleSectionConcurrency();
  if (throttledCap == null) return configured;
  return Math.max(1, Math.min(configured, throttledCap));
}

export function noteEdgeGoogleThrottle(): number {
  const next = Math.max(1, Math.floor(edgeGoogleInFlightLimit() / 2));
  throttledCap = next;
  liveGate?.shrinkTo(next);
  return next;
}

export function resetEdgeGoogleThrottle(): void {
  throttledCap = null;
  liveGate = null;
}
