/**
 * A small local classifier for borderline heading lines in plain text.
 *
 * The heading regexes are confident at the extremes: "CHAPTER IV" is a heading,
 * "He was pacing the room swiftly" is prose. In between sits a line like
 * "Loomings" or "The Counterpane" — short and title-shaped, but not a heading
 * *shape* to a regex.
 *
 * So those lines, and only those, go to a zero-shot NLI model run in-process on
 * the CPU:
 *
 *   MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33
 *   MIT licence, 8 MB int8 ONNX, about 15 ms per line on one core.
 *
 * `Xenova/nli-deberta-v3-xsmall` is what the plan named, but its model card
 * carries no licence field even though the base
 * `microsoft/deberta-v3-xsmall` is MIT. This one states MIT outright.
 *
 * The task is "is this a complete sentence?", not "is this a heading?".
 * Measured on real book lines the heading framing scores a bare title and a
 * sentence of prose almost identically; the sentence framing separates them.
 * `docs/chapter-corpus-results.md` has the numbers.
 *
 * Off unless `CHAPTER_CLASSIFIER=1`, and it never fails a book: a missing
 * model, a slow download, or a bad score leaves the regex answer alone.
 */

import { paragraphSpans } from "@/lib/paragraph-spans";

export const CLASSIFIER_MODEL =
  "MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33";

/**
 * The two labels. A zero-shot pipeline, not a bare entailment call: with the
 * `This text is {}.` template the model separates a printed title from a
 * sentence of prose at AUC 0.87 on the calibration set, where the "is this a
 * sentence?" entailment framing measured 0.74 and the reversed title framing
 * measured 0.31 (see `docs/chapter-corpus-results.md`).
 */
export const HEADING_LABEL = "a chapter or section heading";
export const PROSE_LABEL = "a sentence of prose";
export const CLASSIFIER_LABELS = [HEADING_LABEL, PROSE_LABEL];
export const HYPOTHESIS_TEMPLATE = "This text is {}.";

/** A line has to be short to be a heading at all. */
export const MAX_CANDIDATE_CHARS = 90;

/**
 * Both defaults come from the calibration run in
 * `docs/chapter-corpus-results.md`. The model separates the two classes at
 * about AUC 0.87, which is enough to catch a running sentence that begins with
 * a label word ("chapter of sounds. Yet, for all his hardy sobriety…" scores
 * 0.95) but not enough to be trusted with a fine margin — so the veto bar is
 * low and the promotion bar is high. A sentence mistaken for a chapter is worse
 * than a chapter left out.
 */
export const DEFAULT_VETO_BELOW = 0.22;
/** Promotion is opt-in: see `classifierPromoteEnabled`. */
export const DEFAULT_PROMOTE_ABOVE = 0.72;

/**
 * Promotion (adding a line the regex rejected) is **off by default**.
 *
 * Measured on the corpus it is destructive: War and Peace has 805 borderline
 * lines and the model promotes 379 of them, because a line that is a book
 * heading and a line that is a book's short sentence look alike to a 70M-
 * parameter NLI model. A veto only ever removes a marker that the shape rules
 * already accepted, which is the failure the corpus actually shows.
 */
export const MAX_CANDIDATES = 200;

export function classifierPromoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CHAPTER_CLASSIFIER_PROMOTE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Per-line wall clock. A slow line is skipped, never queued behind. */
export const DEFAULT_LINE_TIMEOUT_MS = 400;
/** Whole-book wall clock for the classifier. */
export const DEFAULT_BUDGET_MS = 20_000;

export function classifierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CHAPTER_CLASSIFIER?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function ratio(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

export function classifierThresholds(env: NodeJS.ProcessEnv = process.env): {
  vetoBelow: number;
  promoteAbove: number;
} {
  return {
    vetoBelow: ratio(env.CHAPTER_CLASSIFIER_VETO_BELOW, DEFAULT_VETO_BELOW),
    promoteAbove: ratio(env.CHAPTER_CLASSIFIER_PROMOTE_ABOVE, DEFAULT_PROMOTE_ABOVE),
  };
}

export type Classify = (text: string) => Promise<number>;

/**
 * The lines worth asking about: short, title-shaped, sitting between blank
 * lines. A line that is already unmistakably a heading or unmistakably prose is
 * never sent to the model, which keeps the cost proportional to the handful of
 * ambiguous lines in a book rather than its paragraph count.
 */
export function isBorderlineLine(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > MAX_CANDIDATE_CHARS) return false;
  if (/[.!?]["”’]?$/.test(t)) return false;
  const words = t.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  if (/^[a-z]/.test(t)) return false;
  if (!/\p{L}/u.test(t)) return false;
  return true;
}

type Pipeline = (
  text: string,
  labels: string[],
  options: { hypothesis_template: string }
) => Promise<{ labels: string[]; scores: number[] }>;

type Scorer = { headingScore: (text: string) => Promise<number> };

let scorerPromise: Promise<Scorer | null> | null = null;

/**
 * Load the model once per process. A failure is remembered as "unavailable" so
 * a book with fifty ambiguous lines does not retry the download fifty times.
 */
async function loadScorer(): Promise<Scorer | null> {
  if (scorerPromise) return scorerPromise;
  scorerPromise = (async () => {
    try {
      const { env, pipeline } = await import("@huggingface/transformers");
      // Default cache under the worker's scratch dir, so a redeploy reuses it.
      env.cacheDir =
        env.cacheDir || `${process.env.ECHOMANCER_SCRATCH_DIR || "/tmp"}/hf-cache`;
      const classify = (await pipeline("zero-shot-classification", CLASSIFIER_MODEL, {
        dtype: "q8",
      })) as unknown as Pipeline;
      return {
        headingScore: async (text: string) => {
          const out = await classify(text, CLASSIFIER_LABELS, {
            hypothesis_template: HYPOTHESIS_TEMPLATE,
          });
          const at = out.labels.indexOf(HEADING_LABEL);
          return at >= 0 ? out.scores[at]! : 0;
        },
      };
    } catch (err) {
      console.warn(
        `[chapters] classifier unavailable, using regex only: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  })();
  return scorerPromise;
}

/** Test hook: replace the model with a stub that returns a heading score. */
export function setScorerForTests(fn: ((text: string) => Promise<number>) | null): void {
  scorerPromise = fn ? Promise.resolve({ headingScore: fn }) : null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      // Never hold the process open for a skipped line.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    }),
  ]);
}

export type ClassifierStats = {
  /** Lines the gate selected. */
  candidates: number;
  /** Lines the model actually scored. */
  scored: number;
  /** Lines whose score changed the regex answer. */
  changed: number;
  /** Of those, lines the model added that the regex had rejected. */
  promoted: number;
  /** Milliseconds spent in the model. */
  ms: number;
};

/**
 * Re-label the borderline lines of a heading-line outline.
 *
 * Two directions, asymmetric on purpose:
 *
 * - A line the regex accepted is **vetoed** when its heading score falls below
 *   `vetoBelow`. That is the "part of the foot-board of the bed" failure.
 * - A line the regex rejected is **promoted** only above `promoteAbove`, and
 *   only when it is in `candidates`. That is the "Loomings" case.
 *
 * A veto costs a missing chapter; a promotion costs a sentence spoken as a
 * chapter title. The second is worse, so the promotion bar is higher.
 */
export async function refineHeadingIndexes(
  spoken: string,
  accepted: number[],
  opts?: {
    classify?: Classify;
    vetoBelow?: number;
    promoteAbove?: number;
    lineTimeoutMs?: number;
    budgetMs?: number;
    /** Paragraph indexes eligible for promotion. Defaults to none. */
    candidates?: number[];
    /** Score more than `MAX_CANDIDATES` lines. Off for a whole-book run. */
    unlimited?: boolean;
  }
): Promise<{
  indexes: number[];
  stats: ClassifierStats;
  skipped: string | null;
}> {
  const stats: ClassifierStats = {
    candidates: 0,
    scored: 0,
    changed: 0,
    promoted: 0,
    ms: 0,
  };
  const spans = paragraphSpans(spoken);
  const keep = new Set(accepted);
  const pool = [...new Set([...accepted, ...(opts?.candidates ?? [])])]
    .filter((index) => isBorderlineLine(spans[index]?.text ?? ""))
    .sort((a, b) => a - b)
    .slice(0, opts?.unlimited ? Number.POSITIVE_INFINITY : MAX_CANDIDATES);
  stats.candidates = pool.length;
  if (pool.length === 0) return { indexes: accepted, stats, skipped: null };

  let classify = opts?.classify;
  if (!classify) {
    const scorer = await loadScorer();
    if (!scorer) return { indexes: accepted, stats, skipped: "model unavailable" };
    classify = scorer.headingScore;
  }

  const defaults = classifierThresholds();
  const vetoBelow = opts?.vetoBelow ?? defaults.vetoBelow;
  const promoteAbove = opts?.promoteAbove ?? defaults.promoteAbove;
  const lineTimeout = opts?.lineTimeoutMs ?? DEFAULT_LINE_TIMEOUT_MS;
  const deadline = Date.now() + (opts?.budgetMs ?? DEFAULT_BUDGET_MS);
  let timedOut = false;

  for (const index of pool) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const started = Date.now();
    let score: number | null = null;
    try {
      score = await withTimeout(
        classify(spans[index]!.text.replace(/\s+/g, " ").trim()),
        lineTimeout
      );
    } catch {
      // A model error is that line's answer being unavailable, not a failed
      // book: the regex answer stands.
      score = null;
    }
    stats.ms += Date.now() - started;
    if (score == null) continue;
    stats.scored += 1;
    const wasAccepted = keep.has(index);
    if (wasAccepted && score < vetoBelow) {
      keep.delete(index);
      stats.changed += 1;
    } else if (!wasAccepted && score >= promoteAbove) {
      keep.add(index);
      stats.changed += 1;
      stats.promoted += 1;
    }
  }

  return {
    indexes: [...keep].sort((a, b) => a - b),
    stats,
    skipped: timedOut ? "budget exhausted" : null,
  };
}

/** Score one line as a heading. Null when the model is unavailable. */
export async function scoreHeadingLine(
  text: string,
  opts?: { classify?: Classify }
): Promise<number | null> {
  if (opts?.classify) return opts.classify(text);
  const scorer = await loadScorer();
  if (!scorer) return null;
  return scorer.headingScore(text);
}
