/**
 * One log line per GPU page call, with the numbers the container already
 * measured.
 *
 * A 49-minute book reported 397 s of GPU wall, and one 20-section page took
 * 294 s for 2,581 s of audio — 8.8x, against the ~32x the same page reached
 * on staging. Nothing in the worker's log could say *where inside the call*
 * that went: the container returns `prepare_s`, `generate_s`, `codec_s`,
 * `encode_s`, `call_s`, the batch width and the per-shape counters in
 * `performance`, and the worker discarded all but `generate_s`.
 *
 * This module does not change a call. It records one line per page:
 *
 *   [S2 page] job=… page=20/20 chars=41230 wall=294.1s generate=88.2s
 *   codec=61.4s encode=141.9s perf={…} container=… snapshot_age=57s …
 *
 * and it is safe to leave on: the cost is one `JSON.stringify` of a small
 * object per page. `MODAL_S2_PAGE_LOG=0` turns it off; `=verbose` always
 * logs the whole `performance` object (the default also logs it, so the two
 * are the same today — the switch exists so the default can be narrowed
 * later without a code change).
 *
 * ## Why the wall time is measured here
 *
 * `performance.call_s` is the container's own view, starting after Modal
 * accepted the input. The interesting number is the one the book pays: from
 * just before the HTTP POST to the moment the page's takes are staged. The
 * difference between them is placement, queueing behind another render, and
 * the response body — exactly the region the 8.8x page could have gone.
 */

/** The `performance` fields worth putting on the summary line. */
const SUMMARY_FIELDS = [
  "sections",
  "audio_s",
  "prepare_s",
  "generate_s",
  "generate_and_codec_s",
  "codec_s",
  "encode_s",
  "call_s",
  "first_section_s",
  "codec_inline_s",
  "codec_tail_s",
  "sections_streamed",
  "batch_width",
  "upload_handshake_s",
  "upload_transport",
] as const;

export type PageLogMode = "off" | "summary" | "verbose";

/**
 * `MODAL_S2_PAGE_LOG`: unset means log, `0`/`off`/`false`/`no` disables,
 * anything else enables. An unreadable value logs, because a page line is
 * the only evidence a cost investigation has.
 */
export function pageLogMode(env: NodeJS.ProcessEnv = process.env): PageLogMode {
  const raw = (env.MODAL_S2_PAGE_LOG ?? "").trim().toLowerCase();
  if (!raw) return "verbose";
  if (["0", "off", "false", "no"].includes(raw)) return "off";
  if (raw === "summary") return "summary";
  return "verbose";
}

export interface PageLogInput {
  jobId?: string | null;
  /** 1-based index of this page within the call's lane. */
  page?: number | null;
  /** Rows this page planned to carry. */
  pageRows: number;
  /** Rows that came back with usable audio. */
  renderedRows?: number | null;
  /** Characters in the page's sections. */
  chars?: number | null;
  /** Sections the book still owed when this page was planned. */
  bookSections?: number | null;
  /** Wall time from just before the POST to the takes being staged, ms. */
  wallMs: number;
  containerId?: string | null;
  build?: string | null;
  boot?: string | null;
  /** Age of the snapshot this container restored, seconds. `null` if unknown. */
  snapshotAgeSeconds?: number | null;
  /** Units the container reported it had to cut at the frame cap. */
  truncatedUnits?: number | null;
  /** Which wait this call used: `restore`, `steady`, or `warm`. */
  waitKind?: string | null;
  warmBatch?: boolean | null;
  performance?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
}

function numberOrNull(value: unknown): number | null {
  // `Number(null)` is 0 and `Number("")` is 0, so both would read as a real
  // measurement. `null` must stay "unknown": a `snapshot_age=0.0s` on a
  // container that never reported one is a lie the log cannot afford.
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One log-safe token. A newline or control character inside a `performance`
 * string would split the record in two, and a truncated multi-line record is
 * worse than a mangled value: the reader sees half a page line and assumes
 * the rest was never written.
 */
function token(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/[\s\u0000-\u001f\u007f]+/g, "_").slice(0, 200);
}

/** Seconds with one decimal and an `s` suffix; `-` when unknown. */
function secs(value: unknown): string {
  const n = numberOrNull(value);
  return n == null ? "-" : `${n.toFixed(1)}s`;
}

/**
 * `performance.snapshot_age_s` is reported by the container itself and only
 * for a provable restore. The outcome's own `performance` copy is preferred
 * over a separately threaded argument so there is one source.
 */
export function snapshotAgeFrom(performance: Record<string, unknown> | null | undefined): number | null {
  if (!performance) return null;
  return numberOrNull(performance.snapshot_age_s);
}

/** The `key=value` pairs a summary line carries, in a stable order. */
function summaryPairs(perf: Record<string, unknown> | null): string[] {
  if (!perf) return ["perf=absent"];
  const out: string[] = [];
  for (const field of SUMMARY_FIELDS) {
    const value = perf[field];
    if (value === undefined || value === null) continue;
    const numeric = numberOrNull(value);
    out.push(`${field}=${numeric == null ? token(value) : `${numeric}`}`);
  }
  // Counters the container adds only on some engines: keep them if present.
  for (const field of ["frames", "frames_per_s", "generated_realtime_x"]) {
    const value = perf[field];
    if (value === undefined || value === null) continue;
    out.push(`${field}=${token(value)}`);
  }
  return out.length > 0 ? out : ["perf=empty"];
}

/**
 * `performance` as JSON on one line.
 *
 * A circular value is the caller's bug, not this logger's, and a page that
 * rendered must not be lost to it. Serialising the known summary fields
 * already happened, so the fallback keeps those and says why the rest is
 * missing instead of throwing.
 */
function performanceJson(perf: Record<string, unknown> | null): string {
  if (!perf) return "null";
  try {
    return JSON.stringify(perf) ?? "null";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

/**
 * The line. Always one line: `performance` is JSON, so any newline inside a
 * string value is escaped rather than splitting the record in two, and every
 * scalar is passed through {@link token} for the same reason.
 */
export function formatPageLog(input: PageLogInput): string {
  const perf = input.performance ?? null;
  const rows =
    input.renderedRows == null
      ? `${input.pageRows}`
      : `${input.renderedRows}/${input.pageRows}`;
  const parts = [
    "[S2 page]",
    `job=${input.jobId || "-"}`,
    input.page != null ? `page=${input.page}` : `rows=${rows}`,
    input.page != null ? `rows=${rows}` : "",
    input.bookSections != null ? `book=${input.bookSections}` : "",
    input.chars != null ? `chars=${Math.round(input.chars)}` : "",
    `wall=${(Math.max(0, input.wallMs) / 1000).toFixed(1)}s`,
    `call=${secs(perf?.call_s)}`,
    `generate=${secs(perf?.generate_s)}`,
    `codec=${secs(perf?.codec_s)}`,
    `encode=${secs(perf?.encode_s)}`,
    `audio=${secs(perf?.audio_s)}`,
    `width=${token(perf?.batch_width ?? "-")}`,
    `container=${token(input.containerId || "-")}`,
    `build=${token(input.build || "-")}`,
    `boot=${token(input.boot || "-")}`,
    `snapshot_age=${secs(input.snapshotAgeSeconds ?? snapshotAgeFrom(perf))}`,
    `truncated=${input.truncatedUnits ?? numberOrNull(perf?.truncated_units) ?? 0}`,
    input.waitKind ? `wait=${token(input.waitKind)}` : "",
    input.warmBatch == null ? "" : `warm=${input.warmBatch ? 1 : 0}`,
  ].filter(Boolean);
  const mode = pageLogMode(input.env);
  if (mode === "off") return "";
  if (mode === "summary") return parts.join(" ");
  return `${parts.join(" ")} ${summaryPairs(perf).join(" ")} perf=${performanceJson(perf)}`;
}

/**
 * Emit the line, or nothing. Never throws: a logger must not be able to fail
 * a page that already rendered.
 */
export function logPageCall(
  input: PageLogInput,
  log: (message: string) => void = (message) => console.log(message)
): void {
  try {
    const line = formatPageLog(input);
    if (line) log(line);
  } catch {
    // A broken `performance` value is not worth a failed section.
  }
}

/**
 * One-shot, per-process cost summary for a whole dispatch.
 *
 * `generate_s` is summed from the pages. `gpu_wall_s` is the dispatch's own
 * wall, so the difference is placement, staging and mastering overlap — the
 * number the 93 s CPU tail and the 397 s GPU wall were talking about.
 */
export interface DispatchSummaryInput {
  jobId?: string | null;
  pages: number;
  rows: number;
  staged: number;
  generateSeconds: number;
  wallMs: number;
  truncatedUnits: number;
  containers: string[];
  env?: NodeJS.ProcessEnv;
}

export function formatDispatchSummary(input: DispatchSummaryInput): string {
  if (pageLogMode(input.env) === "off") return "";
  const wall = Math.max(0, input.wallMs) / 1000;
  const gen = Math.max(0, input.generateSeconds);
  const ratio = gen > 0 ? wall / gen : null;
  return [
    "[S2 dispatch]",
    `job=${input.jobId || "-"}`,
    `pages=${input.pages}`,
    `rows=${input.staged}/${input.rows}`,
    `gpu_wall=${wall.toFixed(1)}s`,
    `generate=${gen.toFixed(1)}s`,
    `wall_over_generate=${ratio == null ? "-" : ratio.toFixed(2)}`,
    `truncated=${input.truncatedUnits}`,
    `containers=${input.containers.join(",") || "-"}`,
  ].join(" ");
}

export function logDispatchSummary(
  input: DispatchSummaryInput,
  log: (message: string) => void = (message) => console.log(message)
): void {
  try {
    const line = formatDispatchSummary(input);
    if (line) log(line);
  } catch {
    // Same rule as `logPageCall`.
  }
}
