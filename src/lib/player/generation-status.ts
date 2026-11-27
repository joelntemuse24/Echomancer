import { etaLabelSuffix } from "@/lib/tts/eta";
import { narrationProgressPercent } from "@/lib/tts/narration-progress";

const OPEN = new Set(["queued", "processing", "waiting"]);

export type GenerationPhase =
  | "running"
  | "finishing"
  | "stopped"
  | "failed"
  | "ready"
  | "idle";

export interface GenerationInput {
  status: string;
  currentSection?: number | null;
  totalSections?: number | null;
  segments?: Array<{
    index?: number | null;
    status?: string | null;
    path?: string | null;
  }> | null;
  etaLabel?: string | null;
  etaState?: string | null;
  waitingForText?: boolean | null;
  /** Accepted so Kokoro, Fish, and S2 share this view. The math does not branch on it. */
  provider?: string | null;
}

export interface GenerationView {
  phase: GenerationPhase;
  /** Player status line. Null for a ready or failed book, which has its own copy. */
  line: string | null;
  showStop: boolean;
  /** Ready sections over the outline. Null while the outline is unknown. */
  percent: number | null;
  /** Bar width. Finishing uses the real ratio, which is 100 once every section is stored. */
  meter: number;
  meterLabel: string;
}

/**
 * Ready sections from index 0 until the first hole. Later ready sections
 * are not playable yet, so the header counts the same span the time bar does.
 */
function readySections(
  segments: GenerationInput["segments"]
): number | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const byIndex = new Map<number, { status?: string | null; path?: string | null }>();
  segments.forEach((segment, position) => {
    const index =
      typeof segment.index === "number" && Number.isInteger(segment.index) && segment.index >= 0
        ? segment.index
        : position;
    byIndex.set(index, segment);
  });
  let count = 0;
  for (let index = 0; ; index++) {
    const row = byIndex.get(index);
    if (!row || row.status !== "ready" || !row.path) break;
    count += 1;
  }
  return count;
}

function etaBit(input: GenerationInput): string {
  if (input.waitingForText) return "Estimating…";
  if (!input.etaLabel) return "Estimating…";
  return etaLabelSuffix(input.etaLabel, input.etaState) || "Estimating…";
}

/**
 * One view of a generating book for the player (main and focus) and the library.
 *
 * Percent is the contiguous ready prefix over the stored outline — the
 * same span the time bar can play. A later ready section behind a hole
 * does not move the count. When every section is stored and the job is
 * still open, the line says the book is finishing — it does not print 99%
 * because audio exists. Stop is shown only while the job is still open.
 */
export function generationStatus(input: GenerationInput): GenerationView {
  const status = input.status;
  if (status === "cancelled") {
    return {
      phase: "stopped",
      line: "Stopped",
      showStop: false,
      percent: null,
      meter: 0,
      meterLabel: "Stopped",
    };
  }
  if (status === "failed") {
    return {
      phase: "failed",
      line: null,
      showStop: false,
      percent: null,
      meter: 0,
      meterLabel: "",
    };
  }
  if (status === "ready") {
    return {
      phase: "ready",
      line: null,
      showStop: false,
      percent: 100,
      meter: 100,
      meterLabel: "100%",
    };
  }
  if (!OPEN.has(status)) {
    return {
      phase: "idle",
      line: null,
      showStop: false,
      percent: null,
      meter: 0,
      meterLabel: "",
    };
  }

  const total = Math.max(0, Math.floor(input.totalSections ?? 0));
  const fromSegments = readySections(input.segments);
  const done =
    fromSegments != null
      ? fromSegments
      : Math.max(0, Math.floor(input.currentSection ?? 0));
  const eta = etaBit(input);

  if (input.waitingForText || !(total > 0)) {
    return {
      phase: "running",
      line: "Estimating…",
      showStop: true,
      percent: null,
      meter: 0,
      meterLabel: "Estimating…",
    };
  }

  if (done >= total) {
    const tail = eta && eta !== "Estimating…" ? ` · ${eta}` : "";
    return {
      phase: "finishing",
      line: `Finishing…${tail}`,
      showStop: true,
      percent: 100,
      meter: 100,
      meterLabel: "Finishing…",
    };
  }

  const percent = narrationProgressPercent(done, total);
  const tail = eta ? ` · ${eta}` : "";
  return {
    phase: "running",
    line: `${done} of ${total} · ${percent}%${tail}`,
    showStop: true,
    percent,
    meter: percent,
    meterLabel: `${percent}%`,
  };
}

/**
 * A poll that left before Stop landed must not paint a generating book over
 * a job this page already knows is finished.
 */
export function acceptJobPoll(
  prevStatus: string | null | undefined,
  nextStatus: string
): boolean {
  if (!prevStatus) return true;
  const terminal =
    prevStatus === "ready" || prevStatus === "failed" || prevStatus === "cancelled";
  return !(terminal && OPEN.has(nextStatus));
}

/** The row Stop writes. The stored status stays `cancelled`; the player says Stopped. */
export function jobAfterUserStop<T extends { status: string; error_message?: string | null }>(
  job: T
): T {
  return { ...job, status: "cancelled", error_message: "Cancelled by user" } as T;
}

/**
 * Stop must update the poll ref in the same turn as the state write.
 * The ref is what an in-flight poll reads; the render effect is too late.
 */
export function commitUserStop<T extends { status: string; error_message?: string | null }>(
  holder: { current: T | null },
  job: T
): T {
  const next = jobAfterUserStop(job);
  holder.current = next;
  return next;
}
