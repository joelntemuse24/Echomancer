/**
 * One Sowell HTTP call, as numbers. No text, URL, or token.
 *
 * `headerMs` is from send until response headers. That includes placement,
 * container start, model init, and inference, because the body is one WAV.
 * `bodyMs` is the download after headers. Server headers, when the image
 * sends them, split init and inference out of `headerMs`.
 */

export interface SowellRequestTiming {
  jobId?: string;
  section?: number;
  attempt: number;
  chars: number;
  status: number;
  headerMs: number;
  bodyMs: number;
  bytes: number;
  inferMs?: number;
  loadMs?: number;
  firstAudioMs?: number;
  audioMs?: number;
  /** 1 when this call loaded the model. 0 when the container was already warm. */
  init?: number;
}

function intHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

export function readSowellTimingHeaders(headers: Headers): Pick<
  SowellRequestTiming,
  "inferMs" | "loadMs" | "firstAudioMs" | "audioMs" | "init"
> {
  return {
    inferMs: intHeader(headers, "x-sowell-infer-ms"),
    loadMs: intHeader(headers, "x-sowell-load-ms"),
    firstAudioMs: intHeader(headers, "x-sowell-first-audio-ms"),
    audioMs: intHeader(headers, "x-sowell-audio-ms"),
    init: intHeader(headers, "x-sowell-init"),
  };
}

/** Log line. Drops anything that is not a number or a short id. */
export function formatSowellRequestLog(timing: SowellRequestTiming): string {
  const jobId = (timing.jobId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const line: Record<string, number | string> = {
    event: "sowell_request",
    attempt: timing.attempt,
    chars: timing.chars,
    status: timing.status,
    headerMs: Math.round(timing.headerMs),
    bodyMs: Math.round(timing.bodyMs),
    bytes: timing.bytes,
  };
  if (jobId) line.jobId = jobId;
  if (timing.section != null && Number.isFinite(timing.section)) {
    line.section = Math.floor(timing.section);
  }
  for (const key of ["inferMs", "loadMs", "firstAudioMs", "audioMs", "init"] as const) {
    const value = timing[key];
    if (value != null && Number.isFinite(value)) line[key] = Math.round(value);
  }
  return JSON.stringify(line);
}
